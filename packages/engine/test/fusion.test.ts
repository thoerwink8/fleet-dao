// Fusion 工作流（src/workflows/fusion.ts，#214）：在真 Temporal（测试服务端）里跑，端口是假的（src/fakes.ts）。
// 走通一条全程，再每条要紧的岔路各一条：副手打回两次 Lead 接手、验证挡两轮停下、CI 红三轮停下、要问创始人、
// 流程配置读不到或认不出（停派报红，修好点「继续」接着走）、没有别家可验、单子正文没指需求文档、单模型模式、人闸。
import { askIssueText } from '@fleet-dao/core';
import type { WorkflowHandle } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  answerSignal,
  approveSignal,
  type FusionInput,
  type FusionResult,
  type FusionStatus,
  requirementWorkflowId,
  resumeSignal,
  stopSignal,
  WORKFLOW_TYPES,
} from '../src/contract.ts';
import {
  createFakeWorld,
  FAKE_BRIEF,
  FAKE_FLOW_CONFIG,
  FAKE_ROUTES,
  type FakeScript,
  type FakeWorld,
  fakeHead,
} from '../src/fakes.ts';
import { PortError, type RouteChoice, type SessionOutput } from '../src/ports.ts';
import { fusionInput, queryUntil, useEnv, withWorker } from './helpers.ts';

const currentEnv = useEnv();
let env: TestWorkflowEnvironment;
beforeEach(() => {
  env = currentEnv();
});

const SPEC_DIR = 'specs/12-登录页加验证码';
const DOCS = {
  requirement: `${SPEC_DIR}/需求.md`,
  plan: `${SPEC_DIR}/方案.md`,
  result: `${SPEC_DIR}/结果.md`,
};
/** 第四条路由（gpt 族）：写这张单的是 claude（Lead）和 kimi（副手），开 PR 前验证只派别家，要有它才验得了。 */
const GPT_ROUTE: RouteChoice = {
  routeId: 'r4',
  poolId: 'p4',
  modelId: 'm3',
  family: 'gpt',
  hostId: 'cursor-agent',
};
const ROUTES = [...FAKE_ROUTES, GPT_ROUTE];
/** 验证挡住：第二条「怎么算做完」没做到。 */
const BLOCKING = (head: string) => ({
  head,
  results: [
    { criterion: '照原话做完', answer: 'done', evidence: 'src/login/changed.ts 加了验证码' },
    { criterion: '有一条故意造出失败的测试', answer: 'not-done', evidence: 'test/ 下没有过期验证码的用例' },
  ],
  findings: [],
});

function start(taskQueue: string, input: FusionInput): Promise<WorkflowHandle> {
  return env.client.workflow.start(WORKFLOW_TYPES.fusion, {
    taskQueue,
    workflowId: requirementWorkflowId(input.repo, input.issueNumber),
    args: [input],
  });
}

function world(script: Partial<FakeScript> = {}): FakeWorld {
  return createFakeWorld({ routes: ROUTES, ...script });
}

/** 起过的会话按先后写成「谁:哪一步」：lead:plan、side（副手）、verify。 */
function trail(w: FakeWorld): string[] {
  return w
    .callsOf('startSession')
    .map((c) =>
      c.input.brief.lead ? `lead:${c.input.brief.lead.step}` : c.input.stage === 'verify' ? 'verify' : 'side',
    );
}

async function runToEnd(w: FakeWorld, input = fusionInput()): Promise<FusionResult> {
  return withWorker(env, w, async (q) => (await (await start(q, input)).result()) as FusionResult);
}

/** 跑到挂起：交回挂起那一刻的状态，然后叫停收尾。 */
async function runUntilParked(
  w: FakeWorld,
  input = fusionInput(),
): Promise<{ parked: FusionStatus; result: FusionResult }> {
  return withWorker(env, w, async (q) => {
    const handle = await start(q, input);
    const parked = await queryUntil<FusionStatus>(handle, (s) => s.parked, '挂起');
    await handle.signal(stopSignal, { by: 'founder' });
    return { parked, result: (await handle.result()) as FusionResult };
  });
}

describe('Fusion 工作流', { timeout: 60_000 }, () => {
  it('走通全程：Lead 写方案 → 副手干、Lead 验收 → 别家验证 → 开 PR、CI 绿 → Lead 最终审查 → 合并 → 关单', async () => {
    // 关单评论发出去、回话丢了：重试发的是同一份正文（正文经 decide 定一次）
    const w = world({ failAfter: { closeIssue: 1 } });
    const input = fusionInput();
    const result = await runToEnd(w, input);

    expect(result).toMatchObject({ state: 'done', prNumber: 100, mergeCommit: 'mc-100-1', problem: null });
    // 需求、方案、结果三份都随 PR 进仓：引擎一次都没直写主线
    expect(result.docs).toEqual(DOCS);
    expect(w.count('writeSpecDoc')).toBe(0);

    // 一步一步来：Lead 规划 → 副手干 → Lead 验收 → 别家验证 → Lead 最终审查
    expect(trail(w)).toEqual(['lead:plan', 'side', 'lead:accept', 'verify', 'lead:review']);
    const sessions = w.callsOf('startSession');
    const leads = sessions.filter((c) => c.input.brief.lead);
    // Lead 一张单一个会话：同一条路由续用（同池 --resume），都在同一棵工作树上
    expect(leads.map((c) => [c.input.route.routeId, c.input.resumeSessionId ?? null])).toEqual([
      ['r1', null],
      ['r1', 's1'],
      ['r1', 's1'],
    ]);
    const tree = `/fake/worktrees/${input.taskId}/main`;
    expect(sessions.filter((c) => c.input.stage !== 'verify').map((c) => c.input.worktreePath)).toEqual(
      Array(4).fill(tree),
    );
    // Lead 读单子正文指的需求文档（不按标题拼），方案写进同一个目录
    expect(leads[0]?.input.brief).toMatchObject({ specDir: SPEC_DIR, lead: { step: 'plan', docs: DOCS } });

    // 副手：照 Lead 的任务简报干，按流程配置的副手模型派别家（避开 Lead 那一族）
    const side = sessions.find((c) => !c.input.brief.lead && c.input.stage === 'execute');
    expect(side?.input.route.routeId).toBe('r3');
    expect(side?.input.brief.task).toEqual(FAKE_BRIEF);
    const sidePick = w.callsOf('pickRoute').find((c) => c.input.stage === 'execute');
    expect(sidePick?.input).toMatchObject({ models: ['m2', 'm1'], avoidFamilies: ['claude'] });
    // Lead 验收时副手已经不在跑
    const sideWatch = w.callsOf('awaitSession').find((c) => c.input.runId === side?.input.runId && c.ok);
    const accept = leads.find((c) => c.input.brief.lead?.step === 'accept');
    expect(sideWatch?.end).not.toBeNull();
    expect(sideWatch?.end ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(accept?.at ?? 0);
    // 从上一次推上去的头（方案那一次）看起：副手这一块的全部改动
    expect(accept?.input.brief.lead?.delivery).toMatchObject({
      head: fakeHead(2),
      base: fakeHead(1),
      testsPassed: true,
    });

    // 别家验证：按流程配置的验证模型、整族避开写过这张单的（claude、kimi），派给 gpt
    const verifyPick = w.callsOf('pickRoute').find((c) => c.input.stage === 'verify');
    expect(verifyPick?.input).toMatchObject({ models: ['m3', 'm2'], avoidFamilies: ['claude', 'kimi'] });
    expect(w.verifications.map((v) => [v.round, v.head, v.routeId, v.finalVerdict])).toEqual([
      [1, fakeHead(2), 'r4', 'pass'],
    ]);

    // 推了三次：方案、副手的改动、结果.md；都在这张单自己的分支上
    const pushes = w.callsOf('pushBranch');
    expect(pushes.map((c) => c.input.head)).toEqual([fakeHead(1), fakeHead(2), fakeHead(3)]);
    expect(new Set(pushes.map((c) => c.input.branch)).size).toBe(1);
    expect(pushes[0]?.input.branch).toMatch(/^fleet\/12-f[0-9a-f]{8}$/);

    // PR 正文：方案摘要、验证结论
    const pr = w.callsOf('openPr');
    expect(pr).toHaveLength(1);
    const body = pr[0]?.input.body;
    expect(body?.did[0]).toBe('方案：登录表单加验证码输入，后端校验五分钟过期');
    expect(body?.verified.join('\n')).toContain('开 PR 前');
    expect(body).toMatchObject({ requirement: 12, specs: SPEC_DIR });
    // 假的推分支没交净改动（老版端口、在途任务重放的历史里就是这样）：照会话交的累计
    expect(body?.changedFiles).toEqual([DOCS.plan, 'src/login/changed.ts']);
    expect(w.callsOf('waitCi').map((c) => c.input.head)).toEqual([fakeHead(2)]);

    // 关单评论：改了什么、用时、各模型额度；发了两次（第一次回话丢了），两次一字不差
    const closes = w.callsOf('closeIssue');
    expect(closes).toHaveLength(2);
    expect(closes[1]?.input.comment).toBe(closes[0]?.input.comment);
    const comment = closes[0]?.input.comment ?? '';
    expect(comment).toContain('做完了：PR #100 已合并');
    expect(comment).toContain('- 登录页加了验证码');
    expect(comment).toContain('**各模型额度**');
    for (const model of ['m1', 'm2', 'm3']) expect(comment).toContain(`- ${model}：`);
    expect(comment).toContain('读自仓里的 .fleet/flow.json');

    // 任务上记这一轮用的流程配置读自哪（tasks.flow_source）：每一次快照都带着，读自仓里的
    expect(w.states.length).toBeGreaterThan(0);
    expect(new Set(w.states.map((s) => s.flowSource))).toEqual(new Set(['project']));
    expect(w.states.at(-1)).toMatchObject({ state: 'done', specDir: SPEC_DIR, docs: DOCS });
  });

  it('副手打回两次还没做好：第三次 Lead 接手自己写，后面照常验证、开 PR；全组织默认的配置在 PR 里写明', async () => {
    const w = world({
      lead: (step) =>
        step === 'accept'
          ? { kind: 'lead-verdict', verdict: 'reject', why: '验证码没做五分钟过期' }
          : undefined,
      // 仓里没有 .fleet/flow.json：用全组织默认
      flow: () => ({
        replica: {
          syncedAt: new Date().toISOString(),
          error: null,
          unread: null,
          testCommand: 'pnpm test:changed',
        },
        source: 'org_default',
        config: FAKE_FLOW_CONFIG,
      }),
    });
    const input = fusionInput();
    const { result, status } = await withWorker(env, w, async (q) => {
      const handle = await start(q, input);
      const done = (await handle.result()) as FusionResult;
      return { result: done, status: (await handle.query('status')) as FusionStatus };
    });
    expect(result.state).toBe('done');
    expect(trail(w)).toEqual([
      'lead:plan',
      'side',
      'lead:accept',
      'side',
      'lead:accept',
      'side',
      'lead:accept',
      'lead:takeover',
      'verify',
      'lead:review',
    ]);
    const sides = w.callsOf('startSession').filter((c) => !c.input.brief.lead && c.input.stage === 'execute');
    // 副手续同一个会话，带着 Lead 打回的理由
    expect(sides.map((c) => c.input.resumeSessionId ?? null)).toEqual([null, 's2', 's2']);
    expect(sides[1]?.input.brief.feedback[0]?.items.join('\n')).toContain('Lead 打回：验证码没做五分钟过期');
    // Lead 接手：续 Lead 自己的会话，带着第三次打回的理由
    const takeover = w.callsOf('startSession').find((c) => c.input.brief.lead?.step === 'takeover');
    expect(takeover?.input).toMatchObject({ resumeSessionId: 's1', stage: 'execute' });
    expect(takeover?.input.brief.feedback[0]?.summary).toContain('Lead 自己接手');
    expect(status.rounds.reworks).toBe(2);

    const body = w.callsOf('openPr')[0]?.input.body;
    expect(body?.verified.join('\n')).toContain('这一块由 Lead 自己写');
    expect(body?.owed?.join('\n')).toContain('没有 .fleet/flow.json');
    expect(status.flowSource).toBe('org_default');
    expect(w.callsOf('closeIssue')[0]?.input.comment).toContain('用的全组织默认');
    // 任务上记下「用的全组织默认」（驾驶舱照它标出来）：从第一次快照起就有
    expect(w.states[0]?.flowSource).toBe('org_default');
    expect(w.states.every((s) => s.flowSource === 'org_default')).toBe(true);
  });

  it('#246：副手第 1 轮碰了简报外的文件、Lead 看过收下 → 这一块直接收下推上去，不返工；状态、PR 正文、关单评论记下来', async () => {
    // #246 第 1 轮：副手顺手改了 docs/ops.md 和一个测试，Lead 判收下，却被「简报外一律不收」打回；改动累计着看，
    // 第 2 轮撤了也照样算简报外，这一块注定白转两轮、第 3 轮 Lead 接手
    const outside = ['docs/ops.md', 'packages/engine/test/hourly-reconcile.test.ts'];
    const why = 'ops.md 跟着改了说明，那条测试补的是同一条规则，该改';
    const w = world({
      session: (input) =>
        !input.brief.lead && input.stage === 'execute'
          ? {
              output: {
                kind: 'delivery',
                head: fakeHead(50),
                summary: '做完：登录页加验证码',
                testsPassed: true,
                changedFiles: ['src/login/changed.ts', ...outside],
              },
            }
          : undefined,
      lead: (step) => (step === 'accept' ? { kind: 'lead-verdict', verdict: 'accept', why } : undefined),
    });
    const { result, status } = await withWorker(env, w, async (q) => {
      const handle = await start(q, fusionInput());
      const done = (await handle.result()) as FusionResult;
      return { result: done, status: (await handle.query('status')) as FusionStatus };
    });
    expect(result.state).toBe('done');
    expect(trail(w)).toEqual(['lead:plan', 'side', 'lead:accept', 'verify', 'lead:review']);
    expect(status.rounds.reworks).toBe(0);
    expect(w.callsOf('pushBranch').map((c) => c.input.head)).toContain(fakeHead(50));

    const line = '简报外改了：docs/ops.md、packages/engine/test/hourly-reconcile.test.ts（主导收下）';
    // 状态里写一句（带 Lead 的理由），随快照进库
    expect(w.states.map((s) => s.lastProblem)).toContain(`${line.slice(0, -1)}：${why}）`);
    expect(w.callsOf('openPr')[0]?.input.body.verified).toContain(line);
    expect(w.callsOf('closeIssue')[0]?.input.comment).toContain(`- ${line}`);
  });

  it('【故意造出的失败】#293：副手并过主线、主线上别人改了页面代码——开 PR 前验证照推上去的头相对主线的净改动判，不按界面派；给验证方的清单、PR 正文也不带主线的页面代码', async () => {
    // 法国 #293：会话交回的改动清单把并进来的主线也算成这张单改的（老版端口，在途任务的历史里就是这样），里面有主线上
    // 别人改的页面代码（uiPaths 下的），验证就按界面类派：写它的两族之外只剩 GPT、GPT 不做界面，没人可派，干等 47 分钟
    const mainlineUi = 'web/health/health.js';
    const w = world({
      session: (input) =>
        !input.brief.lead && input.stage === 'execute'
          ? {
              output: {
                kind: 'delivery',
                head: fakeHead(70),
                summary: '做完：登录页加验证码',
                testsPassed: true,
                changedFiles: ['src/login/changed.ts', mainlineUi],
              },
            }
          : undefined,
      // 推之前并了最新主线，推上去的头相对主线的净改动只有这张单改的
      pushed: (input) => (input.head === fakeHead(1) ? [DOCS.plan] : [DOCS.plan, 'src/login/changed.ts']),
    });
    const result = await runToEnd(w);
    expect(result.state).toBe('done');
    expect(trail(w)).toEqual(['lead:plan', 'side', 'lead:accept', 'verify', 'lead:review']);
    const verifyPick = w.callsOf('pickRoute').find((c) => c.input.stage === 'verify');
    expect(verifyPick?.input.uiWork).toBeUndefined();
    const verify = w.callsOf('startSession').find((c) => c.input.stage === 'verify');
    expect(verify?.input.brief.verify?.changedFiles).toEqual([DOCS.plan, 'src/login/changed.ts']);
    expect(w.callsOf('openPr')[0]?.input.body.changedFiles).toEqual([DOCS.plan, 'src/login/changed.ts']);
  });

  it('开了 PR 之后修的一轮碰了简报外的文件、Lead 收下 → 推上去接着走；PR 正文开出去不改，关单评论补记', async () => {
    const w = world({
      ci: (_input, n) => (n === 1 ? { state: 'red', failedChecks: ['test (engine)'] } : undefined),
      session: (input) =>
        !input.brief.lead && input.stage === 'execute' && input.brief.task?.goal === '照返工意见修好'
          ? {
              output: {
                kind: 'delivery',
                head: fakeHead(60),
                summary: '修好了',
                testsPassed: true,
                changedFiles: ['src/login/changed.ts', 'docs/ops.md'],
              },
            }
          : undefined,
    });
    const result = await runToEnd(w);
    expect(result.state).toBe('done');
    expect(trail(w)).toEqual([
      'lead:plan',
      'side',
      'lead:accept',
      'verify',
      'lead:fix-brief',
      'side',
      'lead:accept',
      'lead:review',
    ]);
    expect(w.callsOf('pushBranch').map((c) => c.input.head)).toContain(fakeHead(60));
    expect(w.callsOf('openPr')[0]?.input.body.verified.join('\n')).not.toContain('简报外');
    expect(w.callsOf('closeIssue')[0]?.input.comment).toContain('- 简报外改了：docs/ops.md（主导收下）');
  });

  it('验证挡了两轮（Lead 没驳回）：回去改一轮还没过，停下等人，不开 PR', async () => {
    const w = world({ verify: (input) => BLOCKING(input.brief.head ?? '') });
    const { parked, result } = await runUntilParked(w);

    expect(parked.lastProblem).toContain('验证 2 轮都没过');
    expect(trail(w)).toEqual([
      'lead:plan',
      'side',
      'lead:accept',
      'verify',
      'lead:rebut',
      'side',
      'lead:accept',
      'verify',
      'lead:rebut',
    ]);
    // Lead 看过挡住的原文（驳回的材料），副手第二次带着验证的意见改
    const rebut = w.callsOf('startSession').find((c) => c.input.brief.lead?.step === 'rebut');
    expect(rebut?.input.brief.lead?.blocking).toEqual([
      { target: '有一条故意造出失败的测试', kind: 'not-done', evidence: 'test/ 下没有过期验证码的用例' },
    ]);
    const sides = w.callsOf('startSession').filter((c) => !c.input.brief.lead && c.input.stage === 'execute');
    expect(sides[1]?.input.brief.feedback[0]?.summary).toContain('别家验证第 1 轮挡住了');
    expect(w.verifications.map((v) => v.finalVerdict)).toEqual(['block', 'block']);
    expect(w.count('openPr')).toBe(0);
    expect(w.alerts.some((a) => a.level === 'stuck' && a.title.includes('验证 2 轮都没过'))).toBe(true);
    // 叫停收尾：没合并的工作树先存档
    expect(result.state).toBe('stopped');
    expect(w.callsOf('removeWorktree')[0]?.input.archive).toBe(true);
  });

  it('CI 红了三轮都没修好：Lead 每轮写修复简报、副手改，第四次还红就停下等人', async () => {
    const w = world({ ci: () => ({ state: 'red', failedChecks: ['test (engine)'] }) });
    const { parked, result } = await runUntilParked(w);

    expect(parked.lastProblem).toContain('CI 修了 3 轮还是红的');
    expect(parked.rounds.fix).toBe(3);
    expect(w.count('waitCi')).toBe(4);
    const briefs = w.callsOf('startSession').filter((c) => c.input.brief.lead?.step === 'fix-brief');
    expect(briefs).toHaveLength(3);
    expect(briefs[0]?.input.brief.feedback[0]).toMatchObject({ kind: 'ci', items: ['test (engine)'] });
    // 修复是副手照 Lead 的修复简报改的
    const fixes = w
      .callsOf('startSession')
      .filter((c) => !c.input.brief.lead && c.input.stage === 'execute')
      .slice(1);
    expect(fixes).toHaveLength(3);
    for (const f of fixes) expect(f.input.brief.task?.goal).toBe('照返工意见修好');
    expect(w.count('openPr')).toBe(1);
    expect(w.count('mergePr')).toBe(0);
    expect(result).toMatchObject({ state: 'stopped', prNumber: 100, mergeCommit: null });
  });

  it('Lead 写方案时 fleet blocked --needs human（要人拍）：不停下等，退回让它带推荐用 fleet ask 问，续同一个会话接着写', async () => {
    const w = world({
      session: (input) =>
        input.brief.lead?.step === 'plan' && !input.resumeSessionId
          ? { outcome: 'blocked', blocked: { reason: '验证码几位？要创始人定', needs: 'human' } }
          : undefined,
    });
    const result = await runToEnd(w);
    expect(result.state).toBe('done');
    // 一张卡都没发、一次都没停下等人
    expect(w.asks).toEqual([]);
    const plans = w.callsOf('startSession').filter((c) => c.input.brief.lead?.step === 'plan');
    expect(plans).toHaveLength(2);
    expect(plans[1]?.input.resumeSessionId).toBe('s1');
    const reask = plans[1]?.input.brief.feedback.find((f) => f.kind === 'ask');
    expect(reask?.summary).toContain('fleet blocked --needs human');
    expect(reask?.items.join('\n')).toContain('验证码几位？要创始人定');
    expect(reask?.items.join('\n')).toContain('fleet ask "<问题>" -o <甲> -o <乙> -r <推荐的>');
  });

  it(`【失败】退回 ${2} 次还说要人：才停下等人（老样子发卡等回答），回答到了续同一个会话`, async () => {
    const w = world({
      session: (input) =>
        input.brief.lead?.step === 'plan' && !input.brief.answers.length
          ? { outcome: 'blocked', blocked: { reason: '验证码几位？', needs: 'info' } }
          : undefined,
    });
    const result = await withWorker(env, w, async (q) => {
      const handle = await start(q, fusionInput());
      const asking = await queryUntil<FusionStatus>(handle, (s) => Boolean(s.waiting?.askId), '在等回答');
      expect(asking.waiting?.detail).toContain('验证码几位？');
      await handle.signal(answerSignal, {
        by: 'founder',
        askId: asking.waiting?.askId ?? '',
        answer: '6 位',
      });
      return (await handle.result()) as FusionResult;
    });
    expect(result.state).toBe('done');
    const plans = w.callsOf('startSession').filter((c) => c.input.brief.lead?.step === 'plan');
    // 第一次说卡住 + 退回两次还说卡住 → 第四次是答了之后续的
    expect(plans).toHaveLength(4);
    expect(plans.slice(1, 3).map((p) => p.input.brief.feedback.some((f) => f.kind === 'ask'))).toEqual([
      true,
      true,
    ]);
    expect(w.asks).toHaveLength(1);
    expect(plans[3]?.input.brief.answers).toEqual([{ question: '验证码几位？', answer: '6 位' }]);
  });

  it('要的是只有他本人才有的东西（--needs access）：不退回，照旧停下等人', async () => {
    const w = world({
      session: (input) =>
        input.brief.lead?.step === 'plan' && !input.brief.answers.length
          ? { outcome: 'blocked', blocked: { reason: '要短信服务的账号', needs: 'access' } }
          : undefined,
    });
    const result = await withWorker(env, w, async (q) => {
      const handle = await start(q, fusionInput());
      const asking = await queryUntil<FusionStatus>(handle, (s) => Boolean(s.waiting?.askId), '在等人');
      await handle.signal(answerSignal, {
        by: 'founder',
        askId: asking.waiting?.askId ?? '',
        answer: '给了',
      });
      return (await handle.result()) as FusionResult;
    });
    expect(result.state).toBe('done');
    const plans = w.callsOf('startSession').filter((c) => c.input.brief.lead?.step === 'plan');
    expect(plans).toHaveLength(2);
    expect(plans[1]?.input.brief.feedback.some((f) => f.kind === 'ask')).toBe(false);
    expect(w.asks.map((a) => a.question)).toEqual(['要短信服务的账号']);
  });

  it('他晚到、改选了别的回答（还没开 PR）：存档点交给 Lead，本来的活收下后回第 4 步照改，改完推上去记照改了，再验证、开 PR', async () => {
    let w: FakeWorld | undefined;
    w = world({
      // 副手干本来的活时，他在卡片上改选了「4 位」（按推荐先做的是「6 位」）
      session: (input) => {
        if (!input.brief.lead && input.stage === 'execute' && w) {
          const row = w.askRows[0];
          if (row && row.answer === undefined) row.answer = '4 位';
        }
        return undefined;
      },
    });
    const input = fusionInput();
    w.askRows.push({
      id: 'ask-1',
      taskId: input.taskId,
      question: '验证码几位？',
      options: ['6 位', '4 位'],
      scope: 'task',
      recommended: '6 位',
      applied: false,
    });
    const result = await runToEnd(w, input);
    expect(result.state).toBe('done');
    expect(trail(w)).toEqual([
      'lead:plan',
      'side',
      'lead:accept',
      'lead:fix-brief',
      'side',
      'lead:accept',
      'verify',
      'lead:review',
    ]);
    // Lead 写照改的简报时看到了他改选的原话
    const brief = w.callsOf('startSession').find((c) => c.input.brief.lead?.step === 'fix-brief');
    const told = brief?.input.brief.feedback.find((f) => f.kind === 'answer');
    expect(told?.items).toEqual([
      '问「验证码几位？」：按推荐先做的是「6 位」，创始人改选了「4 位」，照「4 位」改',
    ]);
    // 改完推上去才记照改了；推了四次：方案、本来的活、照改的、结果
    expect(w.callsOf('markAsksApplied').map((c) => c.input.askIds)).toEqual([['ask-1']]);
    expect(w.askRows[0]?.applied).toBe(true);
    expect(w.count('pushBranch')).toBe(4);
    // 验证是改完之后验的（验的是照改后推上去的头）
    const pushes = w.callsOf('pushBranch').map((c) => c.input.head);
    expect(w.verifications.map((v) => v.head)).toEqual([pushes[2]]);
    // PR 正文「按推荐先做了」一栏写明他改选了、已照改；关单评论记数
    expect(w.callsOf('openPr')[0]?.input.body.assumed).toEqual([
      '验证码几位？ → 先按推荐做了「6 位」，创始人改选了「4 位」，已照改',
    ]);
    expect(w.callsOf('closeIssue')[0]?.input.comment).toContain(
      '**问创始人**：按推荐先做了 1 条，事后被改了 1 条（他确认了 0 条）',
    );
  });

  it('他在 Lead 写方案时就改选了：不跳过这之间的步骤（方案评审照走），本来的活照原方案做完收下，再回第 4 步照改', async () => {
    // 不是小单：规划完要走方案评审（第 3 步）
    const plan: SessionOutput = {
      kind: 'lead-plan',
      head: fakeHead(90),
      changedFiles: [DOCS.plan],
      summary: '登录表单加验证码输入，后端校验五分钟过期',
      brief: FAKE_BRIEF,
      small: false,
      highRisk: false,
      holds: [],
    };
    let w: FakeWorld | undefined;
    w = world({
      lead: (step) => (step === 'plan' ? plan : undefined),
      session: (input) => {
        if (input.brief.lead?.step === 'plan' && w) {
          const row = w.askRows[0];
          if (row && row.answer === undefined) row.answer = '4 位';
        }
        return undefined;
      },
    });
    const input = fusionInput();
    w.askRows.push({
      id: 'ask-1',
      taskId: input.taskId,
      question: '验证码几位？',
      options: ['6 位', '4 位'],
      scope: 'task',
      recommended: '6 位',
      applied: false,
    });
    const result = await runToEnd(w, input);
    expect(result.state).toBe('done');
    expect(trail(w)).toEqual([
      'lead:plan',
      'side',
      'lead:accept',
      'lead:fix-brief',
      'side',
      'lead:accept',
      'verify',
      'lead:review',
    ]);
    // 方案评审那一步照走了（引擎还没接，照跳过、PR 里写明），没被改道绕过去
    expect(w.callsOf('openPr')[0]?.input.body.owed).toContain(
      '方案评审（0003 第 5 条第 3 步）引擎还没接，这次跳过（#249）',
    );
    expect(w.askRows[0]?.applied).toBe(true);
  });

  it('他晚到、改选了别的回答（PR 已经开了）：存档点交给 Lead 算开了 PR 之后修一轮，修完推上去记照改了、再过 CI', async () => {
    let w: FakeWorld | undefined;
    w = world({
      // 开了 PR、等 CI 时他改选了
      ci: (_input, n) => {
        const row = w?.askRows[0];
        if (n === 1 && row) row.answer = '4 位';
        return undefined;
      },
    });
    const input = fusionInput();
    w.askRows.push({
      id: 'ask-1',
      taskId: input.taskId,
      question: '验证码几位？',
      options: ['6 位', '4 位'],
      scope: 'task',
      recommended: '6 位',
      applied: false,
    });
    const { result, status } = await withWorker(env, w, async (q) => {
      const handle = await start(q, input);
      const done = (await handle.result()) as FusionResult;
      return { result: done, status: (await handle.query('status')) as FusionStatus };
    });
    expect(result.state).toBe('done');
    expect(trail(w)).toEqual([
      'lead:plan',
      'side',
      'lead:accept',
      'verify',
      'lead:fix-brief',
      'side',
      'lead:accept',
      'lead:review',
    ]);
    expect(status.rounds.fix).toBe(1);
    expect(w.count('openPr')).toBe(1);
    expect(w.count('waitCi')).toBe(2);
    expect(w.askRows[0]?.applied).toBe(true);
    // 开 PR 那一刻他还没回：「按推荐先做了」写的是那一刻的样子
    expect(w.callsOf('openPr')[0]?.input.body.assumed).toEqual([
      '验证码几位？ → 先按推荐做了「6 位」，创始人还没回',
    ]);
  });

  it('超出这张单范围的：这张单绕开它接着做到合并（不停下等），PR 正文写明另开单等他拍', async () => {
    const w = world();
    const input = fusionInput();
    w.askRows.push({
      id: 'ask-out',
      taskId: input.taskId,
      question: '要不要顺手改注册页？',
      options: ['不改', '改'],
      scope: 'outside',
      recommended: '不改',
      applied: false,
    });
    const result = await runToEnd(w, input);
    expect(result.state).toBe('done');
    expect(trail(w)).toEqual(['lead:plan', 'side', 'lead:accept', 'verify', 'lead:review']);
    expect(w.asks).toEqual([]);
    expect(w.callsOf('openPr')[0]?.input.body.assumed).toEqual([
      '要不要顺手改注册页？ → 超出这张单的范围，绕开了，另开一张单等创始人拍（对账时开）',
    ]);
    expect(w.callsOf('closeIssue')[0]?.input.comment).toContain('超出范围另开单 1 条');
  });

  it('【失败】这张单问过创始人的读不到（库没查成）：不当成一条都没问过往下走，挂起报警', async () => {
    const w = world({
      taskAsks: () => new PortError('TASK_NOT_FOUND', '库里没有这张单', { retryable: false }),
    });
    const { parked } = await runUntilParked(w);
    expect(parked.lastProblem).toBeTruthy();
    expect(w.count('openPr')).toBe(0);
    expect(w.alerts.some((a) => a.level === 'stuck')).toBe(true);
    // 规划做完、执行之前的第一个存档点就读，读不到就停在那里
    expect(trail(w)).toEqual(['lead:plan']);
  });

  it('流程配置读不到、认不出：这张单停派报红，一个会话都不起；修好点「继续」接着走', async () => {
    const fresh = { syncedAt: new Date().toISOString(), error: null, unread: null, testCommand: null };
    const w = world({
      flow: (_input, n) =>
        n === 1
          ? {
              replica: { syncedAt: null, error: null, unread: 'GitHub 接口 502', testCommand: null },
              source: null,
              config: null,
            }
          : n === 2
            ? { replica: fresh, source: 'project', config: { formatVersion: 1, profiles: {} } }
            : undefined,
    });
    const input = fusionInput();
    const { first, second, result } = await withWorker(env, w, async (q) => {
      const handle = await start(q, input);
      const one = await queryUntil<FusionStatus>(handle, (s) => s.parked, '第一次停派');
      expect(w.count('startSession')).toBe(0);
      expect(w.count('createWorktree')).toBe(0);
      await handle.signal(resumeSignal, { by: 'founder' });
      const two = await queryUntil<FusionStatus>(
        handle,
        (s) => s.parked && w.count('flowConfig') === 2,
        '第二次停派',
      );
      expect(w.count('startSession')).toBe(0);
      await handle.signal(resumeSignal, { by: 'founder' });
      return { first: one, second: two, result: (await handle.result()) as FusionResult };
    });
    expect(first.lastProblem).toContain('流程配置不能用，这张单停派');
    expect(second.lastProblem).toContain('流程配置不能用，这张单停派');
    expect(first.lastProblem).not.toBe(second.lastProblem);
    const red = w.alerts.filter((a) => a.level === 'stuck' && a.title.startsWith('流程配置不能用'));
    expect(red).toHaveLength(2);
    expect(result.state).toBe('done');
    expect(w.count('flowConfig')).toBe(3);
  });

  it('没有别家可验（写过这张单的两族之外没有能派的路由）：停下等人，不拿同族顶、不开 PR', async () => {
    const w = createFakeWorld({ routes: [...FAKE_ROUTES] });
    const { parked } = await runUntilParked(w);
    expect(parked.lastProblem).toContain('没有别家可验');
    expect(trail(w)).toEqual(['lead:plan', 'side', 'lead:accept']);
    expect(w.count('openPr')).toBe(0);
  });

  it('单子正文没指需求文档：停下等人、不建工作树；正文补上后点「继续」，按库里最新的正文认', async () => {
    const input = fusionInput({ rawRequest: '给登录页加手机验证码' });
    const w = world({
      request: () => ({
        title: input.title,
        rawRequest: `给登录页加手机验证码\n\n文档：\`${DOCS.requirement}\``,
      }),
    });
    const result = await withWorker(env, w, async (q) => {
      const handle = await start(q, input);
      const parked = await queryUntil<FusionStatus>(handle, (s) => s.parked, '停下等人');
      expect(parked.lastProblem).toContain('认不出需求文档');
      expect(w.count('createWorktree')).toBe(0);
      await handle.signal(resumeSignal, { by: 'founder' });
      return (await handle.result()) as FusionResult;
    });
    expect(result.state).toBe('done');
    expect(w.count('taskRequest')).toBe(1);
    expect(result.docs.requirement).toBe(DOCS.requirement);
    // 停在收单时库里也看得见（状态、为什么停、用的哪份配置）；认出需求文档之前不写目录和文档，不冲掉库里上一轮的
    const stuck = w.states.find((s) => s.doing.includes('认不出需求文档'));
    expect(stuck).toMatchObject({ state: 'triaging', phase: 'fusion:parked', flowSource: 'project' });
    expect(stuck?.doing).toMatch(/^停下等人：认不出需求文档/);
    expect(stuck && 'specDir' in stuck).toBe(false);
    expect(stuck && 'docs' in stuck).toBe(false);
    // 认不出需求文档的时候 issue 上的进度段不动（进度段里要写文档路径）
    const firstProgress = w.callsOf('updateIssueProgress')[0];
    expect(firstProgress?.input.progress.docs.requirement).toBe(DOCS.requirement);
  });

  describe('正文写全了需求、没有需求文档的单（#295：引擎对账开的后续单、巡检单）', () => {
    const title = '#11 的后续：验证码几位？改成「4 位」';
    const body = [
      '创始人在 #11（登录页加验证码）的提问里改选了「4 位」。',
      '',
      '## 怎么算做完',
      '',
      '- #11 里按推荐先做的「6 位」改成「4 位」，测试跟着改',
      '- CI 绿，合进主线',
      '',
      '<!-- fleet:issue:abc123 -->',
    ].join('\n');
    const dir = 'specs/12-11的后续验证码几位改成4位';
    const bodyInput = () => fusionInput({ title, rawRequest: body });

    it('照收、不停下：Lead 把照正文写的需求文档和方案一起提交，开 PR 前验证照正文核，「对应计划」照单子挂的版本', async () => {
      const input = bodyInput();
      const w = world({ request: () => ({ title, rawRequest: body }) });
      const result = await runToEnd(w, input);
      expect(result.state).toBe('done');
      expect(result.docs).toEqual({
        requirement: `${dir}/需求.md`,
        plan: `${dir}/方案.md`,
        result: `${dir}/结果.md`,
      });
      expect(trail(w)).toEqual(['lead:plan', 'side', 'lead:accept', 'verify', 'lead:review']);
      // Lead 写方案时拿到照正文写好的需求文档（去掉了引擎开单的标记），交代它原样提交
      const plan = w.callsOf('startSession').find((c) => c.input.brief.lead?.step === 'plan');
      expect(plan?.input.brief.lead?.requirementText).toBe(
        `# ${title}（#12）\n\n${body.replace('\n\n<!-- fleet:issue:abc123 -->', '')}\n`,
      );
      // 验证照单子正文逐条核，不读主线上的需求文档（还没进主线）
      expect(w.count('readCriteria')).toBe(0);
      expect(w.verifications[0]?.criteria).toEqual([
        '#11 里按推荐先做的「6 位」改成「4 位」，测试跟着改',
        'CI 绿，合进主线',
      ]);
      // 开 PR：需求文档随这个 PR 进主线，「对应计划」照单子挂的版本写
      expect(w.callsOf('openPr')[0]?.input.body).toMatchObject({ specs: dir, planFromIssue: true });
      expect(w.callsOf('openPr')[0]?.input.body.changedFiles).toContain(`${dir}/需求.md`);
    });

    it('对账真开出来的后续单、超出范围的单（core 的 askIssueText 写的正文）照收，做到合并', async () => {
      for (const kind of ['follow-up', 'outside'] as const) {
        const text = askIssueText({
          kind,
          ask: {
            id: 'ask-1',
            question: '验证码几位？',
            options: ['6 位', '4 位'],
            scope: kind === 'outside' ? 'outside' : 'task',
            recommended: '6 位',
            answer: '4 位',
            applied: false,
          },
          original: { issueNumber: 11, title: '登录页加验证码' },
          placement: { labels: ['需求'], milestone: null },
        });
        const w = world({ request: () => ({ title: text.title, rawRequest: text.body }) });
        const result = await runToEnd(w, fusionInput({ title: text.title, rawRequest: text.body }));
        expect(result.state).toBe('done');
        expect(w.verifications[0]?.criteria).toHaveLength(2);
      }
    });

    it('【失败】Lead 只提交了方案、没提交需求文档：方案不收，退回写明要提交哪份；几次都不交就停下等人，不推', async () => {
      const w = world({
        request: () => ({ title, rawRequest: body }),
        lead: (step) =>
          step === 'plan'
            ? {
                kind: 'lead-plan',
                head: fakeHead(91),
                changedFiles: [`${dir}/方案.md`],
                summary: '改成 4 位',
                brief: FAKE_BRIEF,
                small: true,
                highRisk: false,
                holds: [],
              }
            : undefined,
      });
      const { parked, result } = await runUntilParked(w, bodyInput());
      expect(parked.lastProblem).toBe('方案几次都不合格');
      const alert = w.callsOf('raiseAlert').find((c) => c.input.title === '方案几次都不合格');
      expect(alert?.input.detail).toContain('需求文档没提交');
      expect(result.state).toBe('stopped');
      expect(w.count('pushBranch')).toBe(0);
      const retry = w.callsOf('startSession').filter((c) => c.input.brief.lead?.step === 'plan')[1];
      expect(retry?.input.brief.feedback[0]?.items.join('\n')).toContain(`${dir}/需求.md`);
    });

    it('【失败】开 PR 前单子正文里的「怎么算做完」被删了：不验、也不当成验过了，停下等人补', async () => {
      const w = world({ request: () => ({ title, rawRequest: '改成 4 位就行' }) });
      const { parked } = await runUntilParked(w, bodyInput());
      expect(parked.lastProblem).toContain('开 PR 前验证没法逐条核');
      expect(parked.lastProblem).toContain('没有「## 怎么算做完」一节');
      expect(trail(w)).toEqual(['lead:plan', 'side', 'lead:accept']);
      expect(w.count('readCriteria')).toBe(0);
      expect(w.count('openPr')).toBe(0);
    });
  });

  it('【失败】流程配置不能用、停派时叫停：库里的任务记成叫停（不留在排队），没有配置就不记读自哪', async () => {
    const w = world({
      flow: () => ({
        replica: {
          syncedAt: new Date().toISOString(),
          error: '项目配置 .fleet/flow.json：不是 JSON（提交 0123456）',
          unread: null,
          testCommand: null,
        },
        source: 'project',
        config: FAKE_FLOW_CONFIG,
      }),
    });
    const { parked, result } = await runUntilParked(w);
    expect(parked.lastProblem).toContain('流程配置不能用，这张单停派');
    expect(result.state).toBe('stopped');
    expect(w.count('startSession')).toBe(0);
    const last = w.states.at(-1);
    expect(last).toMatchObject({ state: 'stopped', doing: '已叫停' });
    expect(last && 'flowSource' in last).toBe(false);
    expect(last && 'specDir' in last).toBe(false);
  });

  it('单模型模式：Lead 自己写、不派副手，不高风险就不验证，照样最终审查写结果', async () => {
    const w = createFakeWorld({ routes: [...FAKE_ROUTES] });
    const result = await runToEnd(w, fusionInput({ mode: 'single' }));
    expect(result.state).toBe('done');
    expect(trail(w)).toEqual(['lead:plan', 'lead:takeover', 'lead:review']);
    expect(w.verifications).toEqual([]);
    const body = w.callsOf('openPr')[0]?.input.body;
    expect(body?.verified.join('\n')).toContain('单模型模式只对高风险的开，这次没验');
    expect(result.docs).toEqual(DOCS);
    expect(w.callsOf('closeIssue')[0]?.input.comment).toContain('单模型模式');
  });

  it('方案里写了人闸：合并前发卡等人批，批了才进合并队列', async () => {
    const plan: SessionOutput = {
      kind: 'lead-plan',
      head: fakeHead(90),
      changedFiles: [DOCS.plan],
      summary: '接短信服务商发验证码',
      brief: FAKE_BRIEF,
      small: true,
      highRisk: false,
      holds: ['spend'],
    };
    const w = world({ lead: (step) => (step === 'plan' ? plan : undefined) });
    const result = await withWorker(env, w, async (q) => {
      const handle = await start(q, fusionInput());
      const waiting = await queryUntil<FusionStatus>(handle, (s) => Boolean(s.waiting?.approvalId), '等人批');
      expect(w.count('mergePr')).toBe(0);
      await handle.signal(approveSignal, { by: 'founder', approvalId: waiting.waiting?.approvalId ?? '' });
      return (await handle.result()) as FusionResult;
    });
    expect(result.state).toBe('done');
    expect(w.approvals).toHaveLength(1);
    expect(w.approvals[0]).toMatchObject({
      holds: ['spend'],
      prNumber: 100,
      summary: '接短信服务商发验证码',
    });
    expect(w.count('mergePr')).toBe(1);
  });
});
