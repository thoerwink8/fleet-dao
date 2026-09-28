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
    // 开 PR 前验证还在前头：避开 Lead 那一族挪进「给验证留一家」的 spare（先避开），留不下就交派不出（Lead 自己干）
    expect(sidePick?.input).toMatchObject({
      models: ['m2', 'm1'],
      keepVerifier: { models: ['m3', 'm2'], uiWork: false, spare: ['claude'], otherwise: 'none' },
    });
    expect(sidePick?.input.avoidFamilies).toBeUndefined();
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

  describe('#253 先审后合：请第二意见、写回合并闸认的状态', () => {
    const HITS = [
      { file: 'packages/api/src/auth.ts', rule: 'packages/api/src/auth.ts', kind: '碰安全' as const },
    ];

    it('碰安全的 PR：请第二意见 → 必须改 → 修一轮 → 再审通过 → 照常合并；merge-gate 单独报红不当 CI 没过', async () => {
      const w = world({
        highRisk: () => HITS,
        review: (_input, n) =>
          n === 1
            ? {
                verdict: 'changes',
                findings: [
                  { severity: 'blocking', text: '登录态没校验签名', file: 'packages/api/src/auth.ts' },
                ],
              }
            : { verdict: 'pass', findings: [] },
        // 头一次等 CI：合并闸只报「等第二意见」（碰了高风险路径、这个头还没贴过状态），别的检查都还没绿
        ci: (_input, n) => (n === 1 ? { state: 'red', failedChecks: ['merge-gate'] } : undefined),
      });
      const result = await runToEnd(w);
      expect(result.state).toBe('done');

      // 请了两轮：第一轮必须改，改完再请一轮，这次通过——每轮都贴了状态（合并闸认的 second-opinion）
      const posts = w.callsOf('postSecondOpinion');
      expect(posts.map((c) => [c.input.round, c.input.verdict])).toEqual([
        [1, 'changes'],
        [2, 'pass'],
      ]);
      expect(posts[0]?.input.hits).toEqual(HITS);
      expect(posts[0]?.input.findings).toEqual([
        { severity: 'blocking', text: '登录态没校验签名', file: 'packages/api/src/auth.ts' },
      ]);

      // 「必须改」的条目进了修一轮的反馈（和 CI 红同一本账：fix-brief），不是被当成「CI 没过」
      const briefs = w.callsOf('startSession').filter((c) => c.input.brief.lead?.step === 'fix-brief');
      expect(briefs).toHaveLength(1);
      expect(briefs[0]?.input.brief.feedback).toEqual([
        {
          kind: 'review',
          summary: '第二意见第 1 轮：必须改',
          items: ['packages/api/src/auth.ts：登录态没校验签名'],
        },
      ]);
      // merge-gate 单独报红那一次没有被当成「CI 没过」喂给 Lead：没有一条 kind:'ci' 的反馈提过它
      const ciFeedback = w
        .callsOf('startSession')
        .flatMap((c) => c.input.brief.feedback)
        .filter((f) => f.kind === 'ci');
      expect(ciFeedback).toHaveLength(0);
    });

    it('不碰高风险路径：一次都不请第二意见', async () => {
      const w = world({ highRisk: () => [] });
      const result = await runToEnd(w);
      expect(result.state).toBe('done');
      expect(w.count('checkHighRisk')).toBeGreaterThan(0);
      expect(w.count('postSecondOpinion')).toBe(0);
    });

    it('连着两轮都必须改：停下等人，不再拖第三轮', async () => {
      const w = world({
        highRisk: () => HITS,
        review: () => ({
          verdict: 'changes',
          findings: [{ severity: 'blocking', text: '还是没改好', file: 'packages/api/src/auth.ts' }],
        }),
        ci: () => ({ state: 'red', failedChecks: ['merge-gate'] }),
      });
      const { parked, result } = await runUntilParked(w);
      expect(parked.lastProblem).toContain('第二意见连着 2 轮都要改');
      expect(w.callsOf('postSecondOpinion').map((c) => c.input.verdict)).toEqual(['changes', 'changes']);
      expect(result).toMatchObject({ state: 'stopped' });
    });

    it('【故意造出的失败】高风险路径清单读不到：查不出碰没碰，停下等人', async () => {
      const w = world({
        highRisk: () => new PortError('RISK_PATHS_MISSING', '主线上读不到清单', { retryable: false }),
      });
      const { parked } = await runUntilParked(w);
      expect(parked.lastProblem).toContain('主线上读不到清单');
    });

    it('【故意造出的失败】贴第二意见状态没权限：停下等人，不当「贴上了」', async () => {
      const w = world({
        highRisk: () => HITS,
        review: () => ({ verdict: 'pass', findings: [] }),
        postSecondOpinion: () =>
          new PortError('FORBIDDEN', '「引擎」机器人没有 statuses 写权限', { retryable: false }),
      });
      const { parked } = await runUntilParked(w);
      expect(parked.lastProblem).toContain('没有 statuses 写权限');
    });

    it('【故意造出的失败】写这张单的是 Grok、review 排法第一个也是 grok：整族避开，不许挑到自己审自己', async () => {
      // 帅位 2026-09-27 夜挑错：光靠「路由配置里 review 阶段本就配的是别的厂商」不够——排法里可能同时有
      // grok-4.7、deepseek-flash、opus-5.5，写这张单的要是 grok（今晚 #276、#307 都是）就可能挑到 grok 自己审自己。
      // 用「Lead 是 grok」这个真实过的场景（和上面「副手派不出、Lead 是 Grok」同一族路由）：副手避开同族派不出、
      // Lead 自己写完整张单，authorFamilies 照实起过的会话算出来就是 ['grok']；第二意见按这套避开，不能拿它顶。
      const grokLead: RouteChoice = {
        routeId: 'g1',
        poolId: 'pg',
        modelId: 'm1',
        family: 'grok',
        hostId: 'grok',
      };
      const deepseekReview: RouteChoice = {
        routeId: 'g2',
        poolId: 'pg2',
        modelId: 'deepseek-flash',
        family: 'deepseek',
        hostId: 'cursor-agent',
      };
      const opusReview: RouteChoice = {
        routeId: 'g3',
        poolId: 'pg3',
        modelId: 'opus-5.5',
        family: 'claude',
        hostId: 'claude-code',
      };
      // 排法第一个是 grok：不避开的话会挑到它自己
      const w = createFakeWorld({
        routes: [grokLead, deepseekReview, opusReview, GPT_ROUTE],
        highRisk: () => HITS,
        review: () => ({ verdict: 'pass', findings: [] }),
      });
      const result = await runToEnd(w);
      expect(result.state).toBe('done');

      const reviewPick = w.callsOf('pickRoute').find((c) => c.input.stage === 'review');
      expect(reviewPick?.input.avoidFamilies).toEqual(['grok']);
      const reviewSession = w.callsOf('startSession').find((c) => c.input.stage === 'review');
      expect(reviewSession?.input.route.family).toBe('deepseek');
      expect(reviewSession?.input.route.family).not.toBe('grok');
      const post = w.callsOf('postSecondOpinion')[0];
      expect(post?.input.model).toBe('deepseek-flash');
    });
  });

  describe('合并那一步头变了（合并队列自己把主线并进来）、合并闸只缺 second-opinion：不当「测试没过」退回', () => {
    // 碰安全的路径：开 PR 前那一轮第二意见已经通过（缓存下 soApprovedHead/Patch-id），推上去的头是 fakeHead(3)。
    const HITS = [
      { file: 'packages/api/src/auth.ts', rule: 'packages/api/src/auth.ts', kind: '碰安全' as const },
    ];
    const MERGED_HEAD = 'f'.repeat(40);
    // 合并队列自己的「同步主线」把分支头从 fakeHead(3) 换成 MERGED_HEAD——不管这一步被调几次，同一个头总回同一个
    // 结果（并且已经并好了、不用再并）：merge-queue 自己的第一次同步、我们 followBranchHead 顺手再核一次，都对得上。
    const syncedAfterPr = (input: { head: string }) =>
      input.head === fakeHead(3) ? { head: MERGED_HEAD } : undefined;

    it('(a) 只缺 second-opinion → 请第二意见、不记一次返工（不进 mergeReturns，也不派 Lead 改代码）', async () => {
      const w = world({
        highRisk: () => HITS,
        review: () => ({ verdict: 'pass', findings: [] }),
        sync: syncedAfterPr,
        // 合并队列第一次在新头上重跑测试：合并闸红，但结构化地只缺 second-opinion；第二次（第二意见请到手之后）绿
        tests: (input, n) =>
          input.head === MERGED_HEAD && n === 1 ? { passed: false, secondOpinionWait: 'missing' } : undefined,
      });
      const result = await runToEnd(w);
      expect(result.state).toBe('done');
      expect(result.mergeCommit).toBeTruthy();

      // 两轮第二意见都通过：开 PR 前那一轮（PR 送检的头）、合并那一步换头后又请的一轮（新头）——都是真审，不是沿用
      const posts = w.callsOf('postSecondOpinion');
      expect(posts.map((c) => [c.input.head, c.input.verdict, c.input.reused])).toEqual([
        [fakeHead(2), 'pass', undefined],
        [MERGED_HEAD, 'pass', undefined],
      ]);
      const reviews = w.callsOf('startSession').filter((c) => c.input.stage === 'review');
      expect(reviews).toHaveLength(2);

      // 没有因为这次「合并闸红」派 Lead 写修复简报、副手改代码——这不是真测试红
      const fixBriefs = w.callsOf('startSession').filter((c) => c.input.brief.lead?.step === 'fix-brief');
      expect(fixBriefs).toHaveLength(0);
      expect(w.count('mergePr')).toBe(1);
    });

    it('(b) 新头相对主线的 patch-id 和上一轮通过时一样：沿用，不再拉一次审查会话', async () => {
      const w = world({
        highRisk: () => HITS,
        review: () => ({ verdict: 'pass', findings: [] }),
        sync: syncedAfterPr,
        tests: (input, n) =>
          input.head === MERGED_HEAD && n === 1 ? { passed: false, secondOpinionWait: 'missing' } : undefined,
        // 不管算的是哪个头，patch-id 都回同一个值：模拟「这段时间只并了主线，PR 自己的改动没变」
        patchId: () => 'a'.repeat(40),
      });
      const result = await runToEnd(w);
      expect(result.state).toBe('done');
      expect(result.mergeCommit).toBeTruthy();

      // 只有开 PR 前那一轮是真审：合并那一步沿用，没有再起第二次审查会话
      const reviews = w.callsOf('startSession').filter((c) => c.input.stage === 'review');
      expect(reviews).toHaveLength(1);
      const posts = w.callsOf('postSecondOpinion');
      expect(posts.map((c) => [c.input.head, c.input.verdict, c.input.reused])).toEqual([
        [fakeHead(2), 'pass', undefined],
        [MERGED_HEAD, 'pass', { fromHead: fakeHead(2), round: 1 }],
      ]);
      const fixBriefs = w.callsOf('startSession').filter((c) => c.input.brief.lead?.step === 'fix-brief');
      expect(fixBriefs).toHaveLength(0);
    });

    it('(c)【故意造出的失败】patch-id 算不出来（git 报错）：不许当成一样，照常请一轮真的第二意见', async () => {
      const w = world({
        highRisk: () => HITS,
        review: () => ({ verdict: 'pass', findings: [] }),
        sync: syncedAfterPr,
        tests: (input, n) =>
          input.head === MERGED_HEAD && n === 1 ? { passed: false, secondOpinionWait: 'missing' } : undefined,
        patchId: () => new PortError('GIT_FAILED', '算不出来（假的）', { retryable: false }),
      });
      const result = await runToEnd(w);
      expect(result.state).toBe('done');

      // patch-id 没查成，没法比：没有沿用，照样起了第二次审查会话
      const reviews = w.callsOf('startSession').filter((c) => c.input.stage === 'review');
      expect(reviews).toHaveLength(2);
      const posts = w.callsOf('postSecondOpinion');
      expect(posts.every((c) => c.input.reused === undefined)).toBe(true);
    });

    it('(d) 合并前重跑真的红了（不是缺 second-opinion）：照旧算一次返工，退回让 Lead 改代码', async () => {
      const w = world({
        highRisk: () => HITS,
        review: () => ({ verdict: 'pass', findings: [] }),
        // 没有 secondOpinionWait：这是真测试红，不管改完重推了几次、头变成什么，合并前重跑一直红到退回次数用完
        tests: () => ({ passed: false, summary: '真的红了：test (engine) 挂了' }),
      });
      const { parked, result } = await runUntilParked(w);
      // 退回次数到了才停下等人（afterMergeReturn 的 escalate）：人看过之后重新计，停下那一刻 rounds.mergeReturn
      // 已经清零，认那一刻的话（lastProblem 里的「退回 N 次」）不认这个计数。
      expect(parked.lastProblem).toContain('合并队列已经退回');
      expect(w.count('mergePr')).toBe(0);
      expect(result).toMatchObject({ state: 'stopped', mergeCommit: null });
      // 确实走了「退回让 Lead 改代码」那条老路（merge-return 的反馈进了修复简报）
      const briefs = w.callsOf('startSession').filter((c) => c.input.brief.lead?.step === 'fix-brief');
      expect(briefs.length).toBeGreaterThan(0);
      expect(briefs.some((b) => b.input.brief.feedback.some((f) => f.kind === 'merge-return'))).toBe(true);
    });
  });

  it('(e) 等 CI 查到 PR 已经在外面合并了（GitHub 自动合并先合了）：当合并成功走收尾，不算没查成', async () => {
    const w = world({ ci: () => ({ state: 'merged', mergeCommit: 'mc-external-1' }) });
    const result = await runToEnd(w);
    expect(result).toMatchObject({ state: 'done', mergeCommit: 'mc-external-1' });
    // 没有走引擎自己的合并队列合并、也没有走最终审查（PR 已经在外面合了，不用再改、再合一次）
    expect(w.count('mergePr')).toBe(0);
    const finalReviews = w.callsOf('startSession').filter((c) => c.input.brief.lead?.step === 'review');
    expect(finalReviews).toHaveLength(0);
    expect(w.alerts.some((a) => a.title.includes('没查成'))).toBe(false);
  });

  it('(f)【故意造出的失败】PR 被关但没合并（不是合并关的）：仍按现在的判法，连着 3 次没查成停下等人', async () => {
    const w = world({ ci: () => ({ state: 'unknown', detail: 'PR #100 已经关掉了' }) });
    const { parked, result } = await withWorker(env, w, async (q) => {
      const handle = await start(q, fusionInput());
      // 每次没查成都要经「再查一次」那一步的 2 分钟重试等待，连着 3 次要跳够 4 分钟虚拟时间，直接跳 10 分钟；
      // 查询不像 handle.result() 那样自己跳时间，要自己叫 env.sleep（同一个坑，见上面「CI 一直报和主线冲突」那条）。
      await env.sleep('10 minutes');
      const parkedStatus = await queryUntil<FusionStatus>(handle, (s) => s.parked, '挂起');
      await handle.signal(stopSignal, { by: 'founder' });
      return { parked: parkedStatus, result: (await handle.result()) as FusionResult };
    });
    expect(parked.lastProblem).toContain('CI 连着 3 次没查成');
    expect(result).toMatchObject({ state: 'stopped', mergeCommit: null });
  });

  it('CI 报和主线冲突：自动并主线并上了，接着在新头上查 CI，不算「没查成」的次数、照常走完', async () => {
    const w = world({
      ci: (_input, n) => (n === 1 ? { state: 'conflict', detail: '和主线冲突，CI 没起' } : undefined),
    });
    const result = await runToEnd(w);
    expect(result.state).toBe('done');
    // 5 次：任务边界（执行、验证、开 PR 前）各并一次 + 第 6 步 CI 冲突自己并一次 + 合并队列合并前照旧再并一次
    expect(w.count('syncMainline')).toBe(5);
    expect(w.count('waitCi')).toBe(2);
    // 没走「没查成停下」那条账：没发过要人看的卡
    expect(w.alerts.some((a) => a.title.includes('没查成'))).toBe(false);
  });

  it('自动并主线遇到真冲突（并不上）：派会话照冲突的文件解开，改完推上去、CI 绿 → 照常走完', async () => {
    // 任务边界（执行、验证、开 PR 前）那几次并主线都还没开 PR（input.prNumber undefined），让它们照常并上，
    // 不干扰；开 PR 之后头一次并主线是第 6 步 CI 冲突触发的那次，让它报真冲突；合并队列合并前那次要能正常并上。
    let afterOpen = 0;
    const w = world({
      ci: (_input, n) => (n === 1 ? { state: 'conflict', detail: '和主线冲突，CI 没起' } : undefined),
      sync: (input) => {
        if (input.prNumber === undefined) return undefined;
        afterOpen += 1;
        return afterOpen === 1
          ? { state: 'conflict', conflictFiles: ['packages/api/test/harness.ts'] }
          : undefined;
      },
    });
    const result = await runToEnd(w);
    expect(result.state).toBe('done');
    const fixBrief = w.callsOf('startSession').find((c) => c.input.brief.lead?.step === 'fix-brief');
    expect(fixBrief?.input.brief.feedback[0]).toMatchObject({
      kind: 'conflict',
      items: ['packages/api/test/harness.ts'],
    });
  });

  it('CI 一直报和主线冲突：自动并主线连着试满上限还是冲突，停下等人、原因写清（不算「没查成」）', async () => {
    const w = world({ ci: () => ({ state: 'conflict', detail: '和主线冲突，CI 没起' }) });
    const { parked, result } = await withWorker(env, w, async (q) => {
      const handle = await start(q, fusionInput());
      // 每次冲突都要经「再查一次」那一步的 2 分钟重试等待；连着 3 次并主线要跳够 6 分钟虚拟时间，直接跳 10 分钟。
      // 查询（handle.query）不像 handle.result() 那样自己跳时间，要自己叫 env.sleep（09-27 撞过，看 merge-queue.test.ts）。
      await env.sleep('10 minutes');
      const parkedStatus = await queryUntil<FusionStatus>(handle, (s) => s.parked, '挂起');
      await handle.signal(stopSignal, { by: 'founder' });
      return { parked: parkedStatus, result: (await handle.result()) as FusionResult };
    });
    expect(parked.lastProblem).toContain('自动并主线已经试了 3 次还是冲突');
    // 6 次：任务边界（执行、验证、开 PR 前）各并一次干净的 + CI 冲突触发的并主线循环 3 次（触到上限才停）
    expect(w.count('syncMainline')).toBe(6);
    expect(w.count('waitCi')).toBe(4);
    expect(result.state).toBe('stopped');
  });

  it('【故意造出的失败】PR 的头被改写了（新头不含老头）：立刻停下等人，不当成没查成、不试着并主线', async () => {
    const w = world({ ci: () => ({ state: 'diverged', detail: '像是被强推改写了' }) });
    const { parked, result } = await runUntilParked(w);
    expect(parked.lastProblem).toContain('像是被强推改写了');
    expect(w.count('waitCi')).toBe(1);
    // 3 次：任务边界（执行、验证、开 PR 前）各并了一次，都是干净的；头被改写了这条不试着走并主线那条路
    expect(w.count('syncMainline')).toBe(3);
    expect(result.state).toBe('stopped');
  });

  it('任务边界并主线：没有会话在跑的时候点一次，在派新会话之前——不是会话跑着的时候插进去并', async () => {
    const w = world();
    await runToEnd(w);
    // 第 2 步规划（Lead 写方案）前头没有工作树可并，没有边界；第 4 步真正派副手之前才第一次点 syncMainline
    // （execute 这个边界），点在副手那次 startSession 之前，不是夹在两次会话调用中间。
    const firstSync = w.calls.findIndex((c) => c.port === 'syncMainline');
    const execSession = w
      .callsOf('startSession')
      .find((c) => c.input.stage === 'execute' && !c.input.brief.lead);
    const execSessionIdx = execSession ? w.calls.indexOf(execSession) : -1;
    expect(firstSync).toBeGreaterThanOrEqual(0);
    expect(execSessionIdx).toBeGreaterThanOrEqual(0);
    expect(firstSync).toBeLessThan(execSessionIdx);
  });

  it('【故意造出的失败】任务边界并主线遇到冲突（并不上）：最佳努力，不挡这一步，照常派会话、照常走完', async () => {
    const w = world({
      // 还没开 PR（prNumber undefined）的任务边界都报冲突：执行、验证、开 PR 前三次都并不上
      sync: (input) =>
        input.prNumber === undefined ? { state: 'conflict', conflictFiles: ['a.ts'] } : undefined,
    });
    const result = await runToEnd(w);
    expect(result.state).toBe('done');
    // 三次任务边界都报了冲突，都不是拦下这一步的理由：没有因为「冲突」多退回一轮给副手
    expect(
      w.callsOf('startSession').filter((c) => c.input.brief.feedback.some((f) => f.kind === 'conflict')),
    ).toHaveLength(0);
  });

  it('【故意造出的失败】任务边界并主线读不到 GitHub（活动一直失败、不是内容冲突）：不吞、挂起报警等人，不是静默卡住', async () => {
    const w = world({ failFirst: { syncMainline: 999 } });
    const { parked, result } = await runUntilParked(w, fusionInput({ limits: { retryAttempts: 0 } }));
    expect(w.count('raiseAlert')).toBeGreaterThan(0);
    expect(parked.lastProblem).toBeTruthy();
    // 卡在了执行这一步真正派副手之前：只有第 2 步 Lead 写方案那一个会话起过，副手一次都没起
    expect(
      w.callsOf('startSession').filter((c) => c.input.stage === 'execute' && !c.input.brief.lead),
    ).toEqual([]);
    expect(result.state).toBe('stopped');
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

  it('【故意造出的失败】副手派不出、Lead 是 Grok：Lead 自己写，PR 正文写「Lead 单干」，不说成 Claude 单干', async () => {
    // Lead 的模型（m1）这里是 grok 族：副手按 m2、m1 找，m2 没有路由、m1 和 Lead 同族要避开，一条都派不出
    const grokLead: RouteChoice = {
      routeId: 'g1',
      poolId: 'pg',
      modelId: 'm1',
      family: 'grok',
      hostId: 'grok',
    };
    const w = createFakeWorld({ routes: [grokLead, GPT_ROUTE] });
    const result = await runToEnd(w);
    expect(result.state).toBe('done');
    expect(trail(w)).toEqual(['lead:plan', 'lead:takeover', 'verify', 'lead:review']);
    const verified = w.callsOf('openPr')[0]?.input.body.verified.join('\n') ?? '';
    expect(verified).toContain('这一块由 Lead 自己写：副手派不出（');
    expect(verified).toContain('Lead 单干（0003 第 7 条）');
    expect(verified).not.toContain('Claude');
  });

  it('给开 PR 前验证留一家（#293）：界面单规划完、开 PR 之前选副手、Lead 续用都带上验证的模型顺序和界面类；规划本身、验证本身、开了 PR 之后不带', async () => {
    const plan: SessionOutput = {
      kind: 'lead-plan',
      head: fakeHead(90),
      changedFiles: [DOCS.plan],
      summary: '登录页加验证码输入框',
      brief: { ...FAKE_BRIEF, files: ['web/login/'] },
      small: true,
      highRisk: false,
      holds: [],
    };
    const w = world({
      lead: (step) => (step === 'plan' ? plan : undefined),
      ci: (_input, n) => (n === 1 ? { state: 'red', failedChecks: ['test (web)'] } : undefined),
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
    const picks = w.callsOf('pickRoute').map((c) => c.input);
    const keep = { models: ['m3', 'm2'], uiWork: true };
    // Lead（规划阶段续同一个会话）：规划时界面与否还不知道不带；验收时带、留不下照常选（非派不可）；开了 PR 之后不带
    expect(picks.filter((p) => p.stage === 'plan').map((p) => p.keepVerifier)).toEqual([
      undefined,
      { ...keep, otherwise: 'any' },
      undefined,
      undefined,
      undefined,
    ]);
    // 副手（界面类在 UI 阶段派）：开 PR 之前 Lead 那一族先避开、留不下交派不出；开了 PR 之后照旧整族避开
    const sides = picks.filter((p) => p.stage === 'ui');
    expect(sides.map((p) => [p.keepVerifier, p.avoidFamilies])).toEqual([
      [{ ...keep, spare: ['claude'], otherwise: 'none' }, undefined],
      [undefined, ['claude']],
    ]);
    // 验证本身：只派别家、按界面类判，不带
    const verifyPick = picks.find((p) => p.stage === 'verify');
    expect(verifyPick).toMatchObject({ avoidFamilies: ['claude', 'kimi'], uiWork: true });
    expect(verifyPick?.keepVerifier).toBeUndefined();
  });

  it('单模型模式高风险的单（要验）：Lead 自己写那一步带上给验证留一家；不高风险的不验，不带', async () => {
    const plan: SessionOutput = {
      kind: 'lead-plan',
      head: fakeHead(90),
      changedFiles: [DOCS.plan],
      summary: '改登录鉴权',
      brief: FAKE_BRIEF,
      small: true,
      highRisk: true,
      holds: [],
    };
    const w = createFakeWorld({
      routes: ROUTES,
      lead: (step) => (step === 'plan' ? plan : undefined),
    });
    const result = await runToEnd(w, fusionInput({ mode: 'single' }));
    expect(result.state).toBe('done');
    expect(trail(w)).toEqual(['lead:plan', 'lead:takeover', 'verify', 'lead:review']);
    const takeover = w.callsOf('pickRoute').find((c) => c.input.stage === 'execute');
    expect(takeover?.input.keepVerifier).toEqual({ models: ['m3', 'm2'], uiWork: false, otherwise: 'any' });
  });

  it('单模型模式：Lead 自己写、不派副手，不高风险就不验证，照样最终审查写结果', async () => {
    const w = createFakeWorld({ routes: [...FAKE_ROUTES] });
    const result = await runToEnd(w, fusionInput({ mode: 'single' }));
    expect(result.state).toBe('done');
    expect(trail(w)).toEqual(['lead:plan', 'lead:takeover', 'lead:review']);
    expect(w.verifications).toEqual([]);
    // 这张单不验：选路不用给验证留一家
    expect(w.callsOf('pickRoute').map((c) => c.input.keepVerifier)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
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
