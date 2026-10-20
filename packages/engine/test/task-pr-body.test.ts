// PR 说明的「做了什么」取动手会话最后一条回复（#2723）：开 PR 时写进去，第 2 轮起推上去后更新这一段；回复太长截断。
// 真 Temporal 测试服务端 + 假端口 + 脚本化的任务活动。

import { randomUUID } from 'node:crypto';
import { renderPrBody } from '@fleet-dao/github';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import type { WorkflowHandle } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { WORKFLOW_TYPES } from '../src/contract.ts';
import { createFakeWorld } from '../src/fakes.ts';
import type { TaskRun, TaskWorkflowInput } from '../src/task-contract.ts';
import {
  answerForPrDid,
  DELIVERY_ITEM_MAX,
  DELIVERY_OWED_MAX,
  deliveryClaimPrFields,
  PR_DID_ANSWER_LINES,
  PR_DID_ANSWER_MAX,
  parseDeliveryClaim,
  sessionDidLines,
  shotsPrLines,
  stripDeliveryClaim,
  taskPrDid,
} from '../src/workflows/task-support.ts';
import { freshRepo, useEnv, withWorker } from './helpers.ts';
import { scripted } from './task-script.ts';

const currentEnv = useEnv();
let env: TestWorkflowEnvironment;
beforeEach(() => {
  env = currentEnv();
});

function input(over: Partial<TaskWorkflowInput> = {}): TaskWorkflowInput {
  return {
    schemaVersion: 1,
    taskId: randomUUID(),
    repo: freshRepo(),
    issueNumber: 12,
    title: '给驾驶舱加状态',
    ...over,
  };
}

async function start(q: string, i: TaskWorkflowInput): Promise<WorkflowHandle> {
  return env.client.workflow.start(WORKFLOW_TYPES.task, {
    taskQueue: q,
    workflowId: taskWorkflowId(i.repo, i.issueNumber, 1),
    args: [i],
  });
}

describe('会话最后一条回复进 PR 说明（#2723）', () => {
  it('回复按行进「做了什么」：列表记号去掉、空行不要；多出的行并进最后一条，不丢', () => {
    const lines = Array.from({ length: PR_DID_ANSWER_LINES + 3 }, (_v, i) => `- 第 ${i + 1} 条`);
    const did = sessionDidLines(`\n${lines.join('\n\n')}\n`);
    expect(did).toHaveLength(PR_DID_ANSWER_LINES);
    expect(did[0]).toBe('第 1 条');
    expect(did.at(-1)).toContain(`第 ${PR_DID_ANSWER_LINES + 3} 条`);
    expect(sessionDidLines('   ')).toEqual([]);
    expect(sessionDidLines(undefined)).toEqual([]);
  });

  it('【故意造出的失败】回复长得离谱：截断并写明后面还有多少字', () => {
    const did = sessionDidLines(`做了 ${'x'.repeat(PR_DID_ANSWER_MAX * 5)}`);
    expect(did.join('').length).toBeLessThan(PR_DID_ANSWER_MAX + 100);
    expect(did.join('')).toMatch(/还有 \d+ 个字，已截断/);
  });

  it('taskPrDid 带上回复：原来两句在前，回复跟在后面；没有回复照旧两句', () => {
    expect(taskPrDid(12, 1, 2, '验收条 1：做到了\n欠：无')).toEqual([
      '按 #12 的要求动手（第 1 轮）',
      '改了 2 个文件',
      '验收条 1：做到了',
      '欠：无',
    ]);
    expect(taskPrDid(12, 1, 2)).toEqual(['按 #12 的要求动手（第 1 轮）', '改了 2 个文件']);
  });
});

describe('开 PR、第 2 轮更新 PR 说明（#2723）', { timeout: 60_000 }, () => {
  it('第 1 轮开 PR 写第 1 轮会话的回复；CI 红返工，第 2 轮推上去后把说明换成第 2 轮的回复', async () => {
    const world = createFakeWorld({
      ci: (_i, n) =>
        n === 1 ? { state: 'red', failedChecks: ['test (engine)'], digest: 'FAIL x' } : undefined,
    });
    const { tasks } = scripted({
      segment: async (_i, n) => ({
        ok: true,
        runId: `run-${n}`,
        answer: n === 1 ? '验收条 1：页面上有「验收中」\n欠：无' : '修了 CI：x.test.ts 少的一行补上了',
      }),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 2 });
    const opened = world.callsOf('openPr')[0]?.input.body.did ?? [];
    expect(opened).toContain('验收条 1：页面上有「验收中」');
    expect(opened).toContain('欠：无');
    const updates = world.callsOf('updatePrBody');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.input.prNumber).toBe(run.prNumber);
    expect(updates[0]?.input.body.requirement).toBe(12);
    expect(updates[0]?.input.body.did).toContain('按 #12 的要求动手（第 2 轮）');
    expect(updates[0]?.input.body.did).toContain('修了 CI：x.test.ts 少的一行补上了');
    expect(updates[0]?.input.body.did).not.toContain('欠：无');
  });

  it('【故意造出的失败】更新说明没写成：不挡原流程，照旧等 CI、合并', async () => {
    const world = createFakeWorld({
      ci: (_i, n) =>
        n === 1 ? { state: 'red', failedChecks: ['test (engine)'], digest: 'FAIL x' } : undefined,
      failFirst: { updatePrBody: 99 },
    });
    const { tasks } = scripted();
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 2 });
    expect(world.count('updatePrBody')).toBeGreaterThan(0);
    expect(world.alerts).toEqual([]);
  });
});

const claimBlock = (json: string) => `\n\`\`\`fleet-delivery\n${json}\n\`\`\`\n`;
const SLICE_ANSWER = `验收条 1：只做了诊断，Refs #3396，关不了它\n欠：原两项超时未定因${claimBlock(
  '{"scope":"slice","owed":["原两项超时未定因（见 #3396）","@someone 看一下 <!-- x -->"]}',
)}`;
const FULL_ANSWER = `验收条 1：做到了\n欠：无${claimBlock('{"scope":"full","owed":[]}')}`;

describe('交付声明进 PR 说明（#3406）：分片、欠项可核，缺了不写「无」', { timeout: 60_000 }, () => {
  it('完整交付：full 且 owed 为空，不加任何东西', () => {
    expect(parseDeliveryClaim(FULL_ANSWER)).toEqual({ kind: 'full' });
    expect(deliveryClaimPrFields({ kind: 'full' })).toEqual({});
  });

  it('诊断分片仍欠事项：标分片，欠项原样进 owed；回复里别的单号、@、HTML 注释都中和', () => {
    const claim = parseDeliveryClaim(SLICE_ANSWER);
    expect(claim).toEqual({
      kind: 'slice',
      owed: ['原两项超时未定因（见 ＃3396）', '@​someone 看一下 <!‑‑ x ‑‑>'],
    });
    const fields = deliveryClaimPrFields(claim);
    expect(fields.partial).toBe(true);
    const body = renderPrBody({ requirement: 12, did: ['x'], verified: ['y'], ...fields });
    expect(body).toContain('**需求**：Refs #12（分片、关不了它：会话声明只交了一部分）');
    expect(body).toContain('- 会话声明还欠：原两项超时未定因（见 ＃3396）');
    expect(body).not.toContain('**还欠什么**：无');
    expect(body).not.toMatch(/#3396/);
    expect(body).not.toContain('<!--');
  });

  it('【故意造出的失败】无元数据旧回复、截断、非法、多个块、自相矛盾、字段越界：一律 unknown，渲染成未核，不是「无」', () => {
    const cases: [string | null, RegExp][] = [
      [null, /没有最后一条回复/],
      ['验收条 1：做到了\n欠：无\nRefs #3396', /没有交付声明/],
      ['做了\n```fleet-delivery\n{"scope":"full","ow', /没封口/],
      [`做了${claimBlock('{"scope":"full",')}`, /不是合法 JSON/],
      [`做了${claimBlock('["full"]')}`, /不是一个 JSON 对象/],
      [
        `做了${claimBlock('{"scope":"full","owed":[]}')}${claimBlock('{"scope":"full","owed":[]}')}`,
        /不止一个/,
      ],
      [`做了${claimBlock('{"scope":"full","owed":["还差 e2e"]}')}`, /交全了却还列着欠项/],
      [`做了${claimBlock('{"scope":"slice","owed":[]}')}`, /没列欠什么/],
      [`做了${claimBlock('{"scope":"done","owed":[]}')}`, /scope 只能是/],
      [`做了${claimBlock('{"scope":"full","owed":[],"closes":3396}')}`, /认不得的字段/],
      [`${FULL_ANSWER}\n后来又改了：还欠 e2e`, /后面还有内容/],
      [`${SLICE_ANSWER}\n补一句：其实都做完了`, /后面还有内容/],
      [
        `做了${claimBlock(JSON.stringify({ scope: 'slice', owed: ['x'.repeat(DELIVERY_ITEM_MAX + 1)] }))}`,
        /owed/,
      ],
      [
        `做了${claimBlock(JSON.stringify({ scope: 'slice', owed: Array(DELIVERY_OWED_MAX + 1).fill('x') }))}`,
        /owed/,
      ],
    ];
    for (const [answer, why] of cases) {
      const claim = parseDeliveryClaim(answer);
      expect(claim.kind, String(answer)).toBe('unknown');
      if (claim.kind === 'unknown') expect(claim.why).toMatch(why);
      const fields = deliveryClaimPrFields(claim);
      expect(fields.partial).toBeUndefined();
      const body = renderPrBody({ requirement: 12, did: ['x'], verified: ['y'], ...fields });
      expect(body).toContain('交付范围未核');
      expect(body).not.toContain('**还欠什么**：无');
      expect(body).toContain('**需求**：#12');
    }
  });

  it('声明块之后只有空白算收尾；块之后追加内容不接受', () => {
    expect(parseDeliveryClaim(`${FULL_ANSWER}\n\n  \n`)).toEqual({ kind: 'full' });
    expect(parseDeliveryClaim(`${FULL_ANSWER}x`).kind).toBe('unknown');
  });

  it('【故意造出的失败】只认回复顶层末尾的声明：示例、外层围栏、引用块、缩进、HTML 注释里的都是 unknown（review 5584630520）', () => {
    const example = '```fleet-delivery\n{"scope":"full","owed":[]}\n```';
    const cases: [string, RegExp][] = [
      // 单个声明块后面接着写真实范围：不当完整交付
      [`做了\n${example}\n实际交付：仅诊断分片，仍欠两项超时定因`, /后面还有内容/],
      // 四反引号围栏里的协议示例
      [`协议长这样：\n\`\`\`\`markdown\n${example}\n\`\`\`\``, /不在回复顶层/],
      [`协议长这样：\n\`\`\`\`\n${example}\n\`\`\`\`\n欠：两项超时定因`, /不在回复顶层/],
      // 外层围栏没收口（截断）：声明在它里面，不是顶层
      [`做了\n~~~text\n${example}`, /不在回复顶层/],
      [`做了\n\`\`\`\`\n${example}\n`, /不在回复顶层/],
      [`做了\n> ${example.split('\n').join('\n> ')}`, /不在回复顶层/],
      [`做了\n\n    ${example.split('\n').join('\n    ')}`, /不在回复顶层/],
      [`做了\n  ${example.split('\n').join('\n  ')}`, /不在回复顶层/],
      [`做了\n<!-- 示例\n${example}`, /HTML 注释/],
      // 示例加末尾真声明：结构说不清，不挑一个信
      [`示例：\n\`\`\`\`\n${example}\n\`\`\`\`\n做了\n${example}`, /不止一个/],
      [`示例：\n> ${example.split('\n').join('\n> ')}\n\n做了\n${example}`, /不止一个/],
    ];
    for (const [answer, why] of cases) {
      const claim = parseDeliveryClaim(answer);
      expect(claim.kind, answer).toBe('unknown');
      if (claim.kind === 'unknown') expect(claim.why, answer).toMatch(why);
      const body = renderPrBody({
        requirement: 12,
        did: ['x'],
        verified: ['y'],
        ...deliveryClaimPrFields(claim),
      });
      expect(body).toContain('交付范围未核');
      expect(body).not.toContain('**还欠什么**：无');
    }
  });

  it('前面有收好口的别的代码块、换行是 CRLF：末尾的顶层声明照认', () => {
    const answer = `做了\n\`\`\`ts\nconst a = 1;\n\`\`\`\n~~~\n\`\`\`\n~~~\n${claimBlock('{"scope":"full","owed":[]}')}`;
    expect(parseDeliveryClaim(answer)).toEqual({ kind: 'full' });
    expect(parseDeliveryClaim(SLICE_ANSWER.replace(/\n/g, '\r\n'))).toMatchObject({ kind: 'slice' });
  });

  it('回复里别的单的引用不进「做了什么」成链接：#号、owner/仓#号、GH-号、github 链接都中和，本单号留着', () => {
    const raw = [
      '验收条 1：做到了，Refs #3396，Closes #3401',
      '见 acme/widgets#77、GH-88 和 https://github.com/acme/widgets/issues/99',
      '本单 #12 留着，#123 不是本单',
    ].join('\n');
    const did = answerForPrDid(raw, 12) ?? '';
    expect(did).not.toMatch(/(?<![\w＃])#(3396|3401|77|123)\b/);
    expect(did).not.toMatch(/GH-88/);
    expect(did).not.toMatch(/https?:\/\/github\.com/);
    expect(did).toContain('＃3396');
    expect(did).toContain('acme/widgets＃77');
    expect(did).toContain('本单 #12 留着');
    const body = renderPrBody({ requirement: 12, did: taskPrDid(12, 1, 1, did), verified: ['y'] });
    expect([...body.matchAll(/#(\d+)/g)].map((m) => m[1])).toEqual(['12', '12', '12']);
    expect(answerForPrDid(null, 12)).toBeNull();
  });

  it('声明块不占「做了什么」的行；去掉后其余回复照旧', () => {
    expect(stripDeliveryClaim(FULL_ANSWER)?.trim()).toBe('验收条 1：做到了\n欠：无');
    expect(stripDeliveryClaim(null)).toBeNull();
  });

  it('开 PR：分片回复写 Refs 标分片和欠项；已有 PR 第 2 轮换成完整交付，分片和欠项跟着撤掉；需求始终只挂这张单', async () => {
    const world = createFakeWorld({
      ci: (_i, n) =>
        n === 1 ? { state: 'red', failedChecks: ['test (engine)'], digest: 'FAIL x' } : undefined,
    });
    const { tasks } = scripted({
      segment: async (_i, n) => ({
        ok: true,
        runId: `run-${n}`,
        answer: n === 1 ? SLICE_ANSWER : FULL_ANSWER,
      }),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 2 });
    const opened = world.callsOf('openPr')[0]?.input.body;
    expect(opened).toMatchObject({ requirement: 12, partial: true });
    expect(opened?.requirementRefs).toBeUndefined();
    expect(opened?.owed).toEqual(['会话声明还欠：原两项超时未定因（见 ＃3396）', expect.any(String)]);
    expect(opened?.did.join('\n')).not.toContain('fleet-delivery');
    expect(opened?.did.join('\n')).not.toMatch(/(?<!＃)#3396/);
    expect(opened?.did.join('\n')).toContain('＃3396');
    const openedText = renderPrBody(opened ?? { did: [], verified: [] });
    expect(openedText).not.toContain('**还欠什么**：无');
    expect(openedText).toContain('**需求**：Refs #12（分片、关不了它：会话声明只交了一部分）');
    const updated = world.callsOf('updatePrBody')[0]?.input.body;
    expect(updated).toMatchObject({ requirement: 12 });
    expect(updated?.partial).toBeUndefined();
    expect(updated?.owed).toBeUndefined();
    expect(updated?.risks).toBeUndefined();
    // 关单政策不变：没有验收责任照旧关
    expect(world.count('closeIssue')).toBe(1);
  });

  it('已有 PR 更新：第 2 轮回复没有声明（老样子），已开 PR 的说明改成「交付范围未核」，不写「无」', async () => {
    const world = createFakeWorld({
      ci: (_i, n) =>
        n === 1 ? { state: 'red', failedChecks: ['test (engine)'], digest: 'FAIL x' } : undefined,
    });
    const { tasks } = scripted({
      segment: async (_i, n) => ({
        ok: true,
        runId: `run-${n}`,
        answer: n === 1 ? FULL_ANSWER : '修了 CI\n欠：无\nRefs #3396',
      }),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 2 });
    expect(world.callsOf('openPr')[0]?.input.body.risks).toBeUndefined();
    const updated = world.callsOf('updatePrBody')[0]?.input.body;
    expect(updated?.requirement).toBe(12);
    expect(updated?.partial).toBeUndefined();
    expect(updated?.risks?.[0]).toContain('交付范围未核');
    expect(updated?.did.join('\n')).not.toMatch(/(?<!＃)#3396/);
    const text = renderPrBody(updated ?? { did: [], verified: [] });
    expect(text).not.toContain('**还欠什么**：无');
    expect(text).toContain('**需求**：#12');
    // 整篇 14 行以内（github 包的 PR_BODY_MAX_LINES）
    expect(text.split('\n').length).toBeLessThanOrEqual(14);
  });
});

describe('合并收树后 PR 说明分开写代码和截图交付（#2983）', { timeout: 60_000 }, () => {
  const HEAD = 'a'.repeat(40);
  const file = {
    path: '2969/home.png',
    bytes: 10,
    sha256: 'c'.repeat(64),
    blob: 'd'.repeat(40),
    from: 'tree',
  };
  const base = { head: HEAD, branch: 'shots/2969', files: [file] };
  const render = (lines: { verified: string[]; owed: string[] }) =>
    renderPrBody({
      did: ['x'],
      verified: lines.verified,
      ...(lines.owed.length ? { owed: lines.owed } : {}),
    });

  it('已交付：进「怎么验证的」，按远端读到的写；「还欠什么」是无', () => {
    const lines = shotsPrLines(7, 'e'.repeat(40), {
      ...base,
      outcome: 'delivered',
      remoteHead: 'f'.repeat(40),
    });
    expect(lines?.verified[0]).toBe('代码：PR #7 已合并（eeeeeee），CI 和冷验收看这个 PR 的检查');
    expect(lines?.verified[1]).toContain('1 张在远端 shots/2969（fffffff）按 blob 号核对过，已交付');
    expect(lines?.owed).toEqual([]);
    expect(render(lines as { verified: string[]; owed: string[] })).toContain('**还欠什么**：无');
  });

  it('待交付（只在受限归档里）：代码一句照写，图片进「还欠什么」，不写「无」', () => {
    const lines = shotsPrLines(7, undefined, {
      ...base,
      outcome: 'archived',
      reason: '远端没有 shots/2969（404），图片没交付',
      archivedTo: '/state/archive/t/shots/x/manifest.json',
    });
    expect(lines?.verified).toEqual(['代码：PR #7 已合并，CI 和冷验收看这个 PR 的检查']);
    expect(lines?.owed[0]).toContain(
      '界面截图待交付：1 张没在远端 shots/2969 读到（远端没有 shots/2969（404）',
    );
    expect(lines?.owed[0]).toContain('/state/archive/t/shots/x/manifest.json');
    const body = render(lines as { verified: string[]; owed: string[] });
    expect(body).not.toContain('**还欠什么**：无');
    expect(body).toContain('界面截图待交付');
  });

  it('【故意造出的失败】失败（树留着）和不知道（没有核对记录）：都进「还欠什么」', () => {
    const failed = shotsPrLines(7, undefined, { ...base, outcome: 'failed', reason: '图片归档满了' });
    expect(failed?.owed[0]).toContain(
      '界面截图交付失败：1 张没交付也没存档成（图片归档满了），工作树留着没删',
    );
    const unknown = shotsPrLines(7, undefined, { ...base, files: [], outcome: 'unknown', reason: '没记录' });
    expect(unknown?.owed[0]).toContain('界面截图交没交付不知道：没记录');
    expect(shotsPrLines(7, undefined, { ...base, files: [], outcome: 'none' })).toBeNull();
  });

  it('合并后收树：截图待交付就改一次 PR 说明写进「还欠什么」；收树带着推上去的头', async () => {
    const world = createFakeWorld({
      shots: () => ({ outcome: 'archived', files: [file], reason: '远端没有 shots/12（404），图片没交付' }),
    });
    const { tasks } = scripted();
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1 });
    expect(world.callsOf('removeWorktree')[0]?.input.shots).toEqual({ issueNumber: 12, head: run.head });
    const updates = world.callsOf('updatePrBody');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.input.body.owed?.[0]).toContain('界面截图待交付');
    expect(updates[0]?.input.body.verified[0]).toContain(`代码：PR #${run.prNumber} 已合并`);
  });

  it('没有受管图片：不多改 PR 说明', async () => {
    const world = createFakeWorld();
    const { tasks } = scripted();
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged' });
    expect(world.count('updatePrBody')).toBe(0);
  });
});
