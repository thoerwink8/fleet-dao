// 重放夹具录制器。不是测试（文件名不带 .test）。
//
//   node packages/engine/test/replay/record.ts <场景> [场景…]
//
// 用假端口把真的工作流跑到有代表性的位置（做完、停在暂停里、挂起、在合并队列里、在等回答……），
// 把 Temporal 历史存成 test/replay/fixtures/<名字>.json，由 replay.test.ts 拿「现在的代码」重放。
//
// 规矩（windsurf-dao#1633）：夹具是过去某一版代码真走过的路。已有的夹具红了，意思是「此刻在途的任务换上新代码会变僵尸」，
// 修法是用 patched() 把改动包起来，不许重录让它变绿——所以这里只录新场景，文件已经在就拒绝覆盖。
// 录完跑一次 pnpm format（biome 管 JSON 的排版）。
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { WorkflowHandle } from '@temporalio/client';
import { historyToJSON } from '@temporalio/common/lib/proto-utils.js';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import {
  pauseSignal,
  type RequirementStatus,
  requirementWorkflowId,
  type SubtaskStatus,
  subtaskWorkflowId,
  WORKFLOW_TYPES,
} from '../../src/contract.ts';
import type { SubtaskSpec } from '../../src/decisions/plan.ts';
import { createFakeWorld, type FakeScript, type FakeWorld } from '../../src/fakes.ts';
import {
  createEnv,
  engineBundle,
  queryUntil,
  REPO,
  requirementInput,
  spec,
  subtaskInput,
  waitUntil,
  withWorker,
} from '../support.ts';

const OUT = fileURLToPath(new URL('./fixtures/', import.meta.url));
const repo = { ...REPO, id: 'repo-fixture', name: 'fixture' };

interface Run {
  env: TestWorkflowEnvironment;
  world: FakeWorld;
  queue: string;
}
/** 返回「夹具名 → 工作流」：跑到想要的位置就返回，那一刻的历史就是夹具。 */
type Scenario = { script?: Partial<FakeScript>; run(run: Run): Promise<Record<string, WorkflowHandle>> };

const startSubtask = ({ env, queue }: Run, key: string, over: Partial<SubtaskSpec> = {}) => {
  const input = subtaskInput(spec(key, over), {
    repo,
    taskId: 'task-fixture',
    subtaskId: '00000000-0000-4000-8000-000000000001',
  });
  return env.client.workflow.start(WORKFLOW_TYPES.subtask, {
    taskQueue: queue,
    workflowId: subtaskWorkflowId(input.subtaskId),
    args: [input],
  });
};

const startRequirement = ({ env, queue }: Run) => {
  const input = requirementInput({ repo, taskId: 'task-fixture' });
  return env.client.workflow.start(WORKFLOW_TYPES.requirement, {
    taskQueue: queue,
    workflowId: requirementWorkflowId(repo, input.issueNumber),
    args: [input],
  });
};

const mergeQueue = ({ env }: Run) => env.client.workflow.getHandle(`mq:${repo.owner}/${repo.name}`);

const SCENARIOS: Record<string, Scenario> = {
  // 最顺的一条：写码、推分支开 PR、CI 和第二意见都过、合并队列合上、收树。
  'subtask-merged': {
    async run(r) {
      const handle = await startSubtask(r, 'a');
      await handle.result();
      return { 'subtask-merged': handle, 'merge-queue-idle': mergeQueue(r) };
    },
  },
  // 返工一轮：CI 红、第二意见要改，意见回主会话（续同一个会话）改完再验，合上。
  'subtask-reworked': {
    script: {
      ci: (_input, n) =>
        n === 1 ? { state: 'red', failedChecks: ['test'], digest: '登录测试挂了' } : undefined,
      review: (_input, n) =>
        n === 1
          ? { verdict: 'changes', findings: [{ severity: 'blocking', text: '验证码没设过期时间' }] }
          : undefined,
    },
    async run(r) {
      const handle = await startSubtask(r, 'a');
      await handle.result();
      return { 'subtask-reworked': handle };
    },
  },
  // 合并队列在最新主线上测红了、退回：回主会话修完重新排队，合上。队列这边也录一份。
  'subtask-merge-returned': {
    script: { tests: (_input, n) => (n === 1 ? { passed: false, summary: '登录测试挂了' } : undefined) },
    async run(r) {
      const handle = await startSubtask(r, 'a');
      await handle.result();
      return { 'subtask-merge-returned': handle, 'merge-queue-returned': mergeQueue(r) };
    },
  },
  // 人闸：验证过了，停在等人批准（卡片已发）。
  'subtask-awaiting-approval': {
    async run(r) {
      const handle = await startSubtask(r, 'a', { holds: ['release'] });
      await queryUntil<SubtaskStatus>(
        handle,
        (s) => s.approval?.state === 'pending' && r.world.approvals.length === 1,
        '在等批准',
      );
      return { 'subtask-awaiting-approval': handle };
    },
  },
  // #1633 的原形：停在暂停里、等「继续」信号。工人换代码时重放的正是这种工作流。
  'subtask-paused': {
    script: { session: (input, n) => (input.stage === 'execute' && n === 1 ? { hold: true } : {}) },
    async run(r) {
      const handle = await startSubtask(r, 'a');
      await waitUntil(() => r.world.held().length === 1, '写码会话挂着');
      await handle.signal(pauseSignal, { by: 'recorder' });
      await queryUntil<SubtaskStatus>(handle, (s) => s.waiting?.kind === 'human', '暂停后在等人');
      return { 'subtask-paused': handle };
    },
  },
  // 兜底梯走到底：挂起并报警，等人。
  'subtask-parked': {
    script: {
      session: (input) =>
        input.stage === 'execute'
          ? { outcome: 'failed', failure: { code: 'PERMISSION_DENIED', message: '没权限', retryable: false } }
          : {},
    },
    async run(r) {
      const handle = await startSubtask(r, 'a');
      await queryUntil<SubtaskStatus>(handle, (s) => s.parked, '挂起');
      return { 'subtask-parked': handle };
    },
  },
  // 在合并队列里等结果；队列正在新头上跑测试。
  'subtask-in-merge-queue': {
    script: { delayMs: { runTests: 3_000 } },
    async run(r) {
      const handle = await startSubtask(r, 'a');
      await queryUntil<SubtaskStatus>(handle, (s) => s.state === 'in_merge_queue', '排进合并队列');
      await waitUntil(() => r.world.count('runTests') === 1, '队列在跑测试');
      return { 'subtask-in-merge-queue': handle, 'merge-queue-busy': mergeQueue(r) };
    },
  },
  // 需求走完：分诊 → 需求文档 → 方案 → 两个有依赖的子任务 → 结果文档 → 关单。
  'requirement-done': {
    script: {
      plan: [
        { key: 'api', title: '后端接口', touches: ['src/api'] },
        { key: 'page', title: '页面', touches: ['src/page'], dependsOn: ['api'] },
      ],
    },
    async run(r) {
      const handle = await startRequirement(r);
      await handle.result();
      const status = (await handle.query('status')) as RequirementStatus;
      const child = (key: string) =>
        r.env.client.workflow.getHandle(status.subtasks.find((s) => s.key === key)?.workflowId ?? '');
      return {
        'requirement-done': handle,
        'requirement-done-api': child('api'),
        'requirement-done-page': child('page'),
      };
    },
  },
  // 看不懂，在任务里追问，等回答。
  'requirement-asking': {
    script: { triage: () => ({ clear: false, question: '验证码发短信还是邮件？' }) },
    async run(r) {
      const handle = await startRequirement(r);
      await queryUntil<RequirementStatus>(handle, (s) => s.waiting?.askId !== undefined, '在等回答');
      return { 'requirement-asking': handle };
    },
  },
  // 子任务在写码（会话挂着），需求在调度循环里等。
  'requirement-running': {
    script: { session: (input) => (input.stage === 'execute' ? { hold: true } : {}) },
    async run(r) {
      const handle = await startRequirement(r);
      await waitUntil(() => r.world.held().length === 1, '写码会话挂着');
      const status = await queryUntil<RequirementStatus>(
        handle,
        (s) => s.subtasks[0]?.state === 'running',
        '子任务在写码',
      );
      const child = r.env.client.workflow.getHandle(status.subtasks[0]?.workflowId ?? '');
      return { 'requirement-running': handle, 'requirement-running-main': child };
    },
  },
};

/** 机器上的事实不进仓：工人身份（pid@主机名）、失败的调用栈（本机路径）。重放不看它们。 */
function scrub(value: unknown, key = ''): unknown {
  if (key === 'identity') return 'recorder';
  if (key === 'stackTrace') return '';
  if (typeof value === 'string') return value.split(hostname()).join('recorder-host');
  if (Array.isArray(value)) return value.map((v) => scrub(v));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, k)]));
  }
  return value;
}

const names = process.argv.slice(2);
const unknown = names.filter((n) => !SCENARIOS[n]);
if (names.length === 0 || unknown.length > 0) {
  console.error(
    `${names.length ? `没有这个场景：${unknown.join('、')}` : '要点名录哪几个场景'}（有：${Object.keys(SCENARIOS).join('、')}）`,
  );
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
await engineBundle();
for (const name of names) {
  const scenario = SCENARIOS[name];
  if (!scenario) continue;
  const env = await createEnv();
  try {
    const world = createFakeWorld(scenario.script ?? {});
    const captured = await withWorker(env, world, async (queue) => {
      const handles = await scenario.run({ env, world, queue });
      const out: Record<string, { workflowId: string; json: string }> = {};
      for (const [fixture, handle] of Object.entries(handles)) {
        out[fixture] = { workflowId: handle.workflowId, json: historyToJSON(await handle.fetchHistory()) };
      }
      return out;
    });
    for (const [fixture, { workflowId, json }] of Object.entries(captured)) {
      const file = `${OUT}${fixture}.json`;
      if (existsSync(file)) {
        console.error(
          `${fixture}.json 已经在了：已有夹具不许重录（红了用 patched()）。真要换，先手动删掉并在 PR 里写明为什么。`,
        );
        process.exitCode = 1;
        continue;
      }
      // 工作流编号不在历史里，但工作流代码用它（子任务编号、合并条目编号）：重放时要按原编号，一起存下。
      const history = scrub(JSON.parse(json)) as { events: unknown[] };
      writeFileSync(file, `${JSON.stringify({ workflowId, history }, null, 2)}\n`);
      console.log(`录好 ${fixture}：${history.events.length} 个事件`);
    }
  } finally {
    await env.teardown().catch(() => undefined);
  }
}
