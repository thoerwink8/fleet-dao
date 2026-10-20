// 重放夹具录制器。不是测试（文件名不带 .test）。
//
//   node packages/engine/test/replay/record.ts <场景> [场景…]
//
// 用假端口把真的工作流跑到有代表性的位置（做完、停下等人、在等合并……），
// 把 Temporal 历史存成 test/replay/fixtures/<名字>.json，由 replay.test.ts 拿「现在的代码」重放。
//
// 规矩（windsurf-dao#1633）：夹具是过去某一版代码真走过的路。已有的夹具红了，意思是「此刻在途的任务换上新代码会变僵尸」，
// 修法是用 patched() 把改动包起来，不许重录让它变绿——所以这里只录新场景，文件已经在就拒绝覆盖。
// 录完跑一次 pnpm format（biome 管 JSON 的排版）。
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import type { WorkflowHandle } from '@temporalio/client';
import { historyToJSON } from '@temporalio/common/lib/proto-utils.js';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import type { EngineJobs, EngineTasks } from '../../src/activities.ts';
import { WORKFLOW_TYPES } from '../../src/contract.ts';
import { createFakeWorld, type FakeScript, type FakeWorld, fakeHead } from '../../src/fakes.ts';
import {
  type TaskStatus,
  type TaskWorkflowInput,
  taskPauseSignal,
  taskRepinSignal,
  taskStatusQuery,
} from '../../src/task-contract.ts';
import { createEnv, engineBundle, REPO, waitUntil, withWorker } from '../support.ts';
import { goodBrief, OK_SEGMENT, scripted } from '../task-script.ts';

const OUT = fileURLToPath(new URL('./fixtures/', import.meta.url));
const repo = { ...REPO, id: 'repo-fixture', name: 'fixture' };

interface Run {
  env: TestWorkflowEnvironment;
  world: FakeWorld;
  queue: string;
}
/** 返回「夹具名 → 工作流」：跑到想要的位置就返回，那一刻的历史就是夹具。 */
type Scenario = {
  script?: Partial<FakeScript>;
  /** 任务工作流要的活动（脚本化的）；不给就是没装。 */
  tasks?: EngineTasks;
  /** 定时任务要的东西（脚本化的）；不给就是没装。 */
  jobs?: EngineJobs;
  run(run: Run): Promise<Record<string, WorkflowHandle>>;
};

/** 任务工作流（#632 S2-4）：驾驶舱后端按这张单起的那一个。 */
const startTask = ({ env, queue }: Run) => {
  const input: TaskWorkflowInput = {
    schemaVersion: 1,
    taskId: 'task-fixture',
    repo,
    issueNumber: 12,
    title: '给驾驶舱加状态',
  };
  return env.client.workflow.start(WORKFLOW_TYPES.task, {
    taskQueue: queue,
    workflowId: taskWorkflowId(repo, input.issueNumber),
    args: [input],
  });
};

const taskStatusUntil = (handle: WorkflowHandle, check: (s: TaskStatus) => boolean, what: string) =>
  waitUntil(async () => check(await handle.query(taskStatusQuery)), what);

const SCENARIOS: Record<string, Scenario> = {
  // 任务工作流最顺的一条：读交代、动手、推分支开 PR、CI 绿、验收过、挂自动合并、合上、关单、收树。
  'task-merged': {
    tasks: scripted().tasks,
    async run(r) {
      const handle = await startTask(r);
      await handle.result();
      return { 'task-merged': handle };
    },
  },
  // 交代不全：一个会话都没起，停着等人补齐点「继续」。
  'task-parked-brief': {
    tasks: scripted({
      brief: () => ({ ok: false, problems: [{ field: '场景', why: '正文里没有「## 场景」一节' }] }),
    }).tasks,
    async run(r) {
      const handle = await startTask(r);
      await taskStatusUntil(handle, (s) => s.waiting?.kind === 'human', '交代不全，停下等人');
      return { 'task-parked-brief': handle };
    },
  },
  // 改到了标准路径：PR 开了、CI 绿了、验收过了，停在挂自动合并之前等创始人（卡片已发）。
  'task-parked-guarded': {
    tasks: scripted({ guarded: () => ({ standards: ['AGENTS.md'] }) }).tasks,
    async run(r) {
      const handle = await startTask(r);
      await taskStatusUntil(handle, (s) => s.waiting?.kind === 'human', '改标准，停下等创始人');
      return { 'task-parked-guarded': handle };
    },
  },
  // 被人暂停（#820 片 3）：读完交代、第一个检查点就停进已暂停，等「继续」。历史里带 patched('task-pause') 的标记。
  'task-paused': {
    tasks: scripted().tasks,
    async run(r) {
      const handle = await startTask(r);
      await handle.signal(taskPauseSignal, { by: 'recorder', mode: 'soft', reason: '录夹具' });
      await taskStatusUntil(handle, (s) => s.phase === 'paused', '停进已暂停');
      return { 'task-paused': handle };
    },
  },
  // 给任务页「过程」记的账（#3140）：第一轮会话跑完没提交、第 2 轮返工合上。这份历史录在 patched('run-cause-fields')、
  // patched('pr-head-files') 加进来之后的代码上：动手、验收的入参多了起因和回合号、推分支和开 PR 多了文件清单，一轮收场多了开始时刻
  // 和返工摘要——重放它证明这些多出来的字段不改步序（老夹具重放证明老历史不被新标记弄僵）。
  // 不走 CI 红：「旧夹具没有 CI 红带评审这一步」那条只许老夹具有，这份是新的。
  'task-run-cause': {
    tasks: scripted({
      delivery: (n) => ({ head: fakeHead(100 + n), commits: n === 1 ? 0 : 1, changedFiles: ['a.ts'] }),
    }).tasks,
    async run(r) {
      const handle = await startTask(r);
      await handle.result();
      return { 'task-run-cause': handle };
    },
  },
  // 旧交代没有正式合同（#3402）：最初读到的交代不带合同，第一次安全边界读回合同要按「首次接纳」走（写进度行、记修订意见），
  // 而不是被当成没变。生产里 #3199/#3200 就是栽在这一步：默认参数把显式传入的「之前没有合同」换成刚读回的合同，
  // 少了接纳那一串活动，重放对不上历史（TMPRL1100）。不走 CI 红（「旧夹具没有 CI 红带评审」那条只许老夹具有）：第一轮没提交，第 2 轮合上。
  'task-contract-first-accept': (() => {
    const live = goodBrief();
    const { contract: _contract, ...legacy } = live;
    return {
      tasks: scripted({
        brief: () => ({ ok: true, brief: legacy }),
        contractBrief: () => ({ ok: true, brief: live }),
        delivery: (n) => ({ head: fakeHead(100 + n), commits: n === 1 ? 0 : 1, changedFiles: ['a.ts'] }),
      }).tasks,
      async run(r: Run) {
        const handle = await startTask(r);
        await handle.result();
        return { 'task-contract-first-accept': handle };
      },
    };
  })(),
  // 第一轮 CI 红了、回去动手第 2 轮、再推上去合上（#1246）：这份历史录在「第 2 轮动手前并最新主线」加进来之前的代码上，
  // 重放它证明新加的并主线步骤被 patched('sync-mainline-before-implement') 守住了（第 2 轮动手前老历史里没有 syncMainline）。
  'task-reworked': {
    script: {
      ci: (_input, n) => (n === 1 ? { state: 'red', failedChecks: ['unit'] } : undefined),
    },
    tasks: scripted().tasks,
    async run(r) {
      const handle = await startTask(r);
      await handle.result();
      return { 'task-reworked': handle };
    },
  },
  // 「现在就换」模型（#1216）：动手会话在跑时收到 taskRepin，会话被取消、回选路重跑，做完。历史里带 patched('task-repin') 的标记和 taskRepin 信号。
  'task-repinned': (() => {
    const { tasks, calls } = scripted({
      segment: (_input, n, signal) =>
        n !== 1
          ? Promise.resolve(OK_SEGMENT)
          : new Promise((resolve) => {
              const stop = () =>
                resolve({
                  ok: false,
                  runId: 'r',
                  outcome: 'killed',
                  evidence: { code: 'aborted', message: '被取消', quotaExhausted: false },
                });
              if (signal.aborted) stop();
              signal.addEventListener('abort', stop);
            }),
    });
    return {
      tasks,
      async run(r: Run) {
        const handle = await startTask(r);
        await waitUntil(async () => calls.segment.length > 0, '动手会话在跑');
        await handle.signal(taskRepinSignal, { by: 'recorder', segment: 'manual', reason: '录夹具' });
        await handle.result();
        return { 'task-repinned': handle };
      },
    };
  })(),
  // 等合并时 PR 和主线冲突（#1838）：并主线并得干净、对新头重走 CI 和验收、合上。
  // 历史里带 patched('merge-wait-conflict') 的标记——这份夹具是新代码真走过「等合并遇冲突」那一支录的。
  'task-merge-conflict': {
    script: { sync: (_i, n) => (n === 1 ? { state: 'clean', head: fakeHead(700) } : undefined) },
    tasks: scripted({
      merged: (n) =>
        n === 1
          ? { state: 'conflict', detail: 'PR #100 和主线冲突' }
          : { state: 'merged', mergeCommit: 'abc1234567890' },
    }).tasks,
    async run(r) {
      const handle = await startTask(r);
      await handle.result();
      return { 'task-merge-conflict': handle };
    },
  },
  // 全程（#2826）最顺的一条：第一段动手前定模式（分到全程），一段会话交付、CI 绿、验收过、合上。历史里带 patched('flow-mode') 和 decideFlowMode。
  'task-full-merged': {
    tasks: scripted({ flow: () => ({ mode: 'full', source: 'hash', reason: null }) }).tasks,
    async run(r) {
      const handle = await startTask(r);
      await handle.result();
      return { 'task-full-merged': handle };
    },
  },
  // 全程返工（#2826）：CI 红、冷验收被拒都续同一个会话修（不算新的一轮），再合上。
  'task-full-reworked': {
    script: {
      ci: (_input, n) => (n === 1 ? { state: 'red', failedChecks: ['check'], digest: 'FAIL x' } : undefined),
    },
    tasks: scripted({
      flow: () => ({ mode: 'full', source: 'label', reason: null }),
      resume: () => ({ kind: 'resume', sessionId: 'sess-1', runId: 'run-1' }),
      // 第 1 次和 CI 同时起、CI 红了被取消；第 2 次（修完 CI 后）被拒；第 3 次过
      verify: (_i, n) =>
        n === 2 ? { pass: false, problems: ['少了状态'], round: 1 } : { pass: true, problems: [], round: 2 },
    }).tasks,
    async run(r) {
      const handle = await startTask(r);
      await handle.result();
      return { 'task-full-reworked': handle };
    },
  },
  // 冷验收会话脱开引擎跑、接回（#2848）：第一次验收（和 CI 同时起）时引擎在换版本，交回 detached；隔一会儿带 attach 再调同一次验收，
  // 接回的结论是过，合上。历史里带 patched('cold-verify-attach') 的标记。
  'task-verify-reattach': {
    tasks: scripted({
      verify: (_i, n) =>
        n === 1
          ? {
              pass: false,
              problems: [],
              round: 1,
              detached: {
                runId: 'run-verify-1',
                startedAt: '2026-10-16T08:00:00.000Z',
                family: 'gpt',
                modelId: 'gpt-model',
                routeId: 'route-gpt',
                poolId: 'pool-gpt',
                cwd: '/var/lib/fleet-work/_tmp/verify-run-verify-1',
              },
            }
          : { pass: true, problems: [], round: 1 },
    }).tasks,
    async run(r) {
      const handle = await startTask(r);
      await handle.result();
      return { 'task-verify-reattach': handle };
    },
  },
  // 自动合并挂上了，在等 GitHub 把它合进主线（一直在长轮询）。
  'task-merging': {
    tasks: scripted({ merged: () => ({ state: 'waiting', detail: '必过检查还没齐' }) }).tasks,
    async run(r) {
      const handle = await startTask(r);
      await taskStatusUntil(handle, (s) => s.phase === 'merge' && s.waiting?.kind === 'merge', '在等合并');
      return { 'task-merging': handle };
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
    const captured = await withWorker(
      env,
      world,
      async (queue) => {
        const handles = await scenario.run({ env, world, queue });
        const out: Record<string, { workflowId: string; json: string }> = {};
        for (const [fixture, handle] of Object.entries(handles)) {
          out[fixture] = { workflowId: handle.workflowId, json: historyToJSON(await handle.fetchHistory()) };
        }
        return out;
      },
      {
        ...(scenario.tasks ? { tasks: scenario.tasks } : {}),
        ...(scenario.jobs ? { jobs: scenario.jobs } : {}),
      },
    );
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
