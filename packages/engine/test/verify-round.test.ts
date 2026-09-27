// 开 PR 前别家验证（src/workflows/verify.ts，#213）：在真 Temporal（测试服务端）里经测试宿主工作流跑，端口是假的。
// 走通一条（第 1 轮挡住、Lead 带证据驳回一条、第 2 轮放行），其余每条失败路径各一条故意造出失败的用例：
// 都挂起等人、不当成验过了。
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { stopSignal } from '../src/contract.ts';
import { createFakeWorld, FAKE_ROUTES, type FakeScript, type FakeWorld } from '../src/fakes.ts';
import { PortError, type RouteChoice } from '../src/ports.ts';
import type { VerifyHostInput, VerifyHostResult, VerifyHostStatus } from './fixtures/verify/host.ts';
import { freshRepo, queryUntil, useEnv, verifyHostBundle, withWorker } from './helpers.ts';

const currentEnv = useEnv();
let env: TestWorkflowEnvironment;
beforeAll(async () => {
  await verifyHostBundle();
}, 120_000);
beforeEach(() => {
  env = currentEnv();
});

const HEAD_1 = 'a'.repeat(40);
const HEAD_2 = 'b'.repeat(40);
const CRITERIA = ['照原话做完', '有一条故意造出失败的测试'];
/** 第四条路由：另一个别家（gpt 族），换模型时换得过去。 */
const GPT_ROUTE: RouteChoice = {
  routeId: 'r4',
  poolId: 'p4',
  modelId: 'm3',
  family: 'gpt',
  hostId: 'cursor-agent',
};

function hostInput(over: Partial<VerifyHostInput> = {}): VerifyHostInput {
  return {
    taskId: `task-${Math.random().toString(16).slice(2, 10)}`,
    repo: freshRepo(),
    specDir: 'specs/12-登录页加验证码',
    heads: [HEAD_1, HEAD_2],
    ...over,
  };
}

/** 写这张单的是 claude 族（假端口默认照假会话算，宿主一上来就是第 5 步，没有写码会话）。 */
const byClaude: Partial<FakeScript> = { authors: () => ['claude'] };

async function run(world: FakeWorld, input: VerifyHostInput): Promise<VerifyHostResult> {
  return withWorker(
    env,
    world,
    async (taskQueue) => {
      const handle = await env.client.workflow.start('verifyHost', {
        taskQueue,
        workflowId: `verify-${input.taskId}`,
        args: [input],
      });
      return (await handle.result()) as VerifyHostResult;
    },
    { workflowBundle: await verifyHostBundle() },
  );
}

/** 跑到挂起：交回挂起那一刻的状态，然后叫停收尾。 */
async function runUntilParked(world: FakeWorld, input: VerifyHostInput): Promise<VerifyHostStatus> {
  return withWorker(
    env,
    world,
    async (taskQueue) => {
      const handle = await env.client.workflow.start('verifyHost', {
        taskQueue,
        workflowId: `verify-${input.taskId}`,
        args: [input],
      });
      const parked = await queryUntil<VerifyHostStatus>(handle, (s) => s.parked, '挂起');
      await handle.signal(stopSignal, { by: 'founder' });
      const result = (await handle.result()) as VerifyHostResult;
      expect(result.stopped).toBe(true);
      return parked;
    },
    { workflowBundle: await verifyHostBundle() },
  );
}

const verifySessions = (world: FakeWorld) =>
  world.callsOf('startSession').filter((c) => c.input.stage === 'verify');

describe('开 PR 前别家验证', { timeout: 60_000 }, () => {
  it('第 1 轮挡住（一条没做到、一条安全），Lead 拿证据驳回安全那条，改好后第 2 轮放行：结论进库、写成 PR 正文', async () => {
    const world = createFakeWorld({
      ...byClaude,
      verify: (input, n) =>
        n === 1
          ? {
              head: input.brief.head,
              results: [
                { criterion: CRITERIA[0], answer: 'done', evidence: 'src/login/form.ts 加了验证码输入' },
                { criterion: CRITERIA[1], answer: 'not-done', evidence: 'test/ 下没有过期验证码的用例' },
              ],
              findings: [
                {
                  kind: 'security',
                  text: '验证码写进了日志',
                  evidence: 'src/login/code.ts 第 12 行 log.info',
                },
                { kind: 'suggestion', text: '验证码长度可以配置', evidence: 'src/login/code.ts 写死 6 位' },
              ],
            }
          : undefined,
    });
    const rebuttal = {
      target: '验证码写进了日志',
      evidence: 'src/login/code.ts 第 12 行打的是验证码的编号 codeId，不是验证码本身',
    };
    const result = await run(world, hostInput({ rebuttals: { '1': [rebuttal] }, uiWork: true }));

    expect(result.action).toBe('open-pr');
    expect(result.state.verifyRounds).toBe(1);
    expect(result.leadRefused).toEqual([]);
    expect(result.rounds.map((r) => [r.round, r.head, r.verdict.verdict, r.final.verdict])).toEqual([
      [1, HEAD_1, 'block', 'block'],
      [2, HEAD_2, 'pass', 'pass'],
    ]);
    // 只派别家：两轮都派给 kimi 族（写这张单的是 claude），选路时整族避开、按界面类的活判禁令
    expect(result.rounds.map((r) => r.route.routeId)).toEqual(['r3', 'r3']);
    const picks = world.callsOf('pickRoute').filter((c) => c.input.stage === 'verify');
    expect(picks.length).toBeGreaterThanOrEqual(2);
    for (const p of picks) expect(p.input).toMatchObject({ avoidFamilies: ['claude'], uiWork: true });
    // 每一轮都是全新会话、检出那一轮送检的头，材料里有「怎么算做完」逐条原文和出处
    const sessions = verifySessions(world);
    expect(sessions.map((s) => [s.input.resumeSessionId, s.input.brief.head])).toEqual([
      [undefined, HEAD_1],
      [undefined, HEAD_2],
    ]);
    expect(sessions[0]?.input.brief.verify).toMatchObject({
      criteria: CRITERIA,
      specPath: 'specs/12-登录页加验证码/需求.md',
      changedFiles: ['src/login/form.ts', 'src/login/code.ts'],
    });

    // 驳回记进库：同一行改写，驳回之后还挡在「没做到」那一条
    expect(world.verifications).toMatchObject([
      {
        round: 1,
        head: HEAD_1,
        routeId: 'r3',
        family: 'kimi',
        authorFamilies: ['claude'],
        criteria: CRITERIA,
        verdict: 'block',
        finalVerdict: 'block',
        rebuttals: [rebuttal],
        reasons: ['没做到：有一条故意造出失败的测试（证据：test/ 下没有过期验证码的用例）'],
        notes: ['建议：验证码长度可以配置（证据：src/login/code.ts 写死 6 位）'],
      },
      { round: 2, head: HEAD_2, verdict: 'pass', finalVerdict: 'pass', rebuttals: [], reasons: [] },
    ]);
    expect(world.count('recordVerification')).toBe(3);

    // 写成 PR 正文的几行（给 #214 用）
    expect(result.lines).toEqual({
      verified: [
        '开 PR 前别家验证第 1 轮（m2（kimi 族））：挡，逐条核了 2 条「怎么算做完」，Lead 拿证据驳回 1 条，挡在 1 条：没做到：有一条故意造出失败的测试（证据：test/ 下没有过期验证码的用例）',
        `第 1 轮 Lead 驳回「验证码写进了日志」：${rebuttal.evidence}`,
        '开 PR 前别家验证第 2 轮（m2（kimi 族））：过，逐条核了 2 条「怎么算做完」',
      ],
      owed: [],
    });
  });

  it('两轮都挡：不开第三轮，按 nextFlow 停下等人', async () => {
    const world = createFakeWorld({
      ...byClaude,
      verify: (input) => ({
        head: input.brief.head,
        results: CRITERIA.map((criterion) => ({ criterion, answer: 'not-done', evidence: '没看到' })),
        findings: [],
      }),
    });
    const result = await run(world, hostInput());
    expect(result.action).toBe('wait-human');
    expect(result.state).toMatchObject({ step: 'parked', verifyRounds: 2, why: '验证 2 轮都没过' });
    expect(verifySessions(world)).toHaveLength(2);
    expect(world.verifications.map((v) => v.finalVerdict)).toEqual(['block', 'block']);
  });

  it('【故意造出的失败】Lead 的驳回没带证据：不算数、原因交回，这一轮照样挡着、记录不动', async () => {
    const world = createFakeWorld({
      ...byClaude,
      verify: (input, n) =>
        n === 1
          ? {
              head: input.brief.head,
              results: [
                { criterion: CRITERIA[0], answer: 'done', evidence: '看过' },
                { criterion: CRITERIA[1], answer: 'not-done', evidence: '没有这条测试' },
              ],
              findings: [],
            }
          : undefined,
    });
    const result = await run(
      world,
      hostInput({ rebuttals: { '1': [{ target: CRITERIA[1] ?? '', evidence: '  ' }] } }),
    );
    expect(result.leadRefused).toEqual([`驳回「${CRITERIA[1]}」没带证据`]);
    expect(result.rounds[0]).toMatchObject({ rebuttals: [], final: { verdict: 'block' } });
    expect(world.verifications[0]).toMatchObject({ rebuttals: [], finalVerdict: 'block' });
    expect(result.action).toBe('open-pr');
  });

  it('【故意造出的失败】结论文件解析不出：作废、记一笔、挂起等人，不当成过了', async () => {
    const world = createFakeWorld({ ...byClaude, verify: () => ({ verdict: 'pass' }) });
    const parked = await runUntilParked(world, hostInput());
    expect(parked.lastProblem).toContain('验证作废：交回的认不出');
    expect(world.verifications).toMatchObject([{ verdict: 'invalid', report: { verdict: 'pass' } }]);
    expect(world.verifications[0]?.finalVerdict).toBeUndefined();
    expect(world.verifications[0]?.invalidWhy).toContain('交回的认不出');
    expect(world.alerts.map((a) => a.level)).toEqual(['stuck']);
    expect(world.alerts[0]?.title).toContain('验证作废');
  });

  it('【故意造出的失败】没写结论（会话结束了、没交结论文件）：退回重写、换别家模型，还不交就挂起，一行「过了」都不记', async () => {
    const world = createFakeWorld({
      ...byClaude,
      routes: [...FAKE_ROUTES, GPT_ROUTE],
      session: (input) =>
        input.stage === 'verify'
          ? {
              outcome: 'failed',
              failure: { code: 'wrong_output', message: '会话结束了，但没写结论 .fleet-out/verify.json' },
            }
          : undefined,
    });
    const parked = await runUntilParked(world, hostInput());
    expect(parked.lastProblem).toContain('说做完了，但没交付');
    const sessions = verifySessions(world);
    // 先退回同一个会话重写，再换一家别家的模型，始终不派给 claude
    expect(sessions[1]?.input.resumeSessionId).toBe('s1');
    expect(sessions.map((s) => s.input.route.family)).not.toContain('claude');
    expect(sessions.map((s) => s.input.route.routeId)).toContain('r4');
    expect(world.verifications).toEqual([]);
  });

  it('【故意造出的失败】审的不是送检的头：作废、挂起，写明送的和审的各是哪个', async () => {
    const world = createFakeWorld({
      ...byClaude,
      verify: () => ({
        head: 'c'.repeat(40),
        results: CRITERIA.map((criterion) => ({ criterion, answer: 'done', evidence: '看过' })),
        findings: [],
      }),
    });
    const parked = await runUntilParked(world, hostInput());
    expect(parked.lastProblem).toBe(`验证作废：审的不是送检的头：送的是 ${HEAD_1}，审的是 ${'c'.repeat(40)}`);
    expect(world.verifications).toMatchObject([{ verdict: 'invalid', head: HEAD_1 }]);
  });

  it('【故意造出的失败】选路出错派成了同一族：结论作废、挂起，不拿同族的「过了」', async () => {
    const world = createFakeWorld({
      ...byClaude,
      route: (input) =>
        input.stage === 'verify'
          ? { ok: true, route: FAKE_ROUTES[0] as RouteChoice, why: '假的：选路出了错' }
          : undefined,
    });
    const parked = await runUntilParked(world, hostInput());
    expect(parked.lastProblem).toContain('验证作废：验证模型和写这张单的是同一族（claude）');
    expect(world.verifications).toMatchObject([{ verdict: 'invalid', family: 'claude' }]);
  });

  it('【故意造出的失败】没有别家可验：写的族把能派的都占了，挂起写明，不拿同族顶、不起会话', async () => {
    const world = createFakeWorld({ authors: () => ['claude', 'kimi'] });
    const parked = await runUntilParked(world, hostInput());
    expect(parked.lastProblem).toBe('没有别家可验：写这张单的是 claude、kimi 族，验证只派别家');
    expect(world.alerts[0]?.detail).toContain('没有别家可验');
    expect(verifySessions(world)).toEqual([]);
    expect(world.verifications).toEqual([]);
  });

  it('【故意造出的失败】发给别家的材料没过卫生检查：不发、挂起报警，要人看', async () => {
    const world = createFakeWorld({
      ...byClaude,
      startSession: (input) =>
        input.stage === 'verify'
          ? new PortError(
              'MATERIAL_BLOCKED',
              '发给别家的验证材料没过卫生检查，没发给接口外壳：查出 1 处（验证提示词 第 12 行 token）',
              { retryable: false },
            )
          : undefined,
    });
    const parked = await runUntilParked(world, hostInput());
    expect(parked.lastProblem).toContain('发给别家验证的材料没过卫生检查');
    expect(world.spawned).toEqual([]);
    expect(world.verifications).toEqual([]);
  });

  it('【故意造出的失败】需求文档读不到：不验、挂起报警，要人补文档', async () => {
    const world = createFakeWorld({
      ...byClaude,
      criteria: (input) =>
        new PortError(
          'SPEC_DOC_MISSING',
          `主线上没有 ${input.specDir}/需求.md：开 PR 前验证要照它的「怎么算做完」逐条核，读不到就不验（需求文档还没进主线？）`,
          { retryable: false },
        ),
    });
    const parked = await runUntilParked(world, hostInput());
    expect(parked.lastProblem).toContain('开 PR 前验证缺材料');
    expect(world.count('pickRoute')).toBe(0);
    expect(world.verifications).toEqual([]);
  });

  it('【故意造出的失败】查不到写这张单的是哪一族：不验、挂起报警，不当成谁都能验', async () => {
    const world = createFakeWorld();
    const parked = await runUntilParked(world, hostInput());
    expect(parked.lastProblem).toContain('开 PR 前验证缺材料');
    expect(world.callsOf('authorFamilies')[0]?.ok).toBe(false);
    expect(world.count('pickRoute')).toBe(0);
  });
});
