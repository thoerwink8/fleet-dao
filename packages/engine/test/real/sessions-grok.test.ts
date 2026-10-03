// 会话端口（grok：会话端口按执行方式分派（#266））。夹具在 sessions-rig.ts；原来一个文件，拆开是为了让 CI 的 engine 分片能按文件均分。
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

import { join } from 'node:path';

import { appendProgressEvents, getSessionRun, notifications, progressEvents } from '@fleet-dao/db';

import { assertPublishable } from '@fleet-dao/github';
import { beforeEach, describe, expect, it } from 'vitest';

import type { LaunchSessionInput } from '../../src/ports.ts';

import { GROK_MISSING } from '../../src/real/hosts.ts';

import { poolHoldKey } from '../../src/real/store-ports.ts';

import {
  addGrokRoute,
  type FakeGrokScript,
  GROK_NO_STDIN,
  GROK_NOT_SIGNED_IN,
  GROK_TOKEN_EXPIRED,
  GROK_UNKNOWN_MODEL,
  git,
  grokAnswered,
  grokRefused,
} from './fixtures.ts';

import { commitAndDone, ctx, launch, m, runOnce, runRow, setup, t, taskId } from './sessions-rig.ts';

describe('grok：会话端口按执行方式分派（法国真跑夹具驱动，#266）', () => {
  let grokRoute: LaunchSessionInput['route'];
  beforeEach(async () => {
    const { routeId, poolId } = await addGrokRoute(t.db);
    grokRoute = { routeId, poolId, modelId: 'grok-4.7', family: 'grok', hostId: 'grok' };
  });
  const grokLaunch = (over: Partial<LaunchSessionInput> = {}) => launch({ route: grokRoute, ...over });
  const holdOf = async (poolId: string) =>
    (await t.db.select().from(notifications)).find((n) => n.dedupeKey === poolHoldKey(poolId));
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  /** 会话在树里干完活：提交一个文件、fleet done（后端写 done 进度）；过程记录回放真跑的那一份。 */
  const grokDelivers =
    (options: { noDone?: boolean; replay?: string; keepSessionId?: boolean } = {}) =>
    (): FakeGrokScript => ({
      replay: options.replay ?? 'grok-edit-commit',
      ...(options.keepSessionId ? { keepSessionId: true } : {}),
      act: async ({ spec }) => {
        mkdirSync(join(spec.cwd, 'src'), { recursive: true });
        writeFileSync(join(spec.cwd, 'src', `g-${randomUUID().slice(0, 4)}.ts`), 'export const g = 1;\n');
        git(spec.cwd, 'add', '--', 'src');
        git(spec.cwd, 'commit', '-q', '-m', 'grok: 追加一行');
        if (!options.noDone) {
          await appendProgressEvents(t.db, spec.runId, [
            { at: new Date(), kind: 'done', payload: { summary: '做完了', testsPassed: true } },
          ]);
        }
      },
    });

  describe('写码会话', () => {
    it('池不绑会话用户也以唯一的会话用户起；开新会话带我们起的号（-s）、放开命令；交活、进度、token、实际模型照终帧记', async () => {
      const { ports, grok, fake } = setup(() => ({}), { grok: grokDelivers() });
      const input = grokLaunch();
      const started = await ports.startSession(input, ctx());
      expect(started).toMatchObject({ resumed: false, handle: { pid: 4545 } });
      expect(started.sessionId).toMatch(UUID_RE);
      expect(await getSessionRun(t.db, input.runId)).toMatchObject({
        sessionId: started.sessionId,
        runAsUser: 'fleet-agent-carpool',
      });
      const spec = grok.specs[0];
      expect(spec).toMatchObject({
        session: { mode: 'new', id: started.sessionId },
        alwaysApprove: true,
        model: 'grok-4.7',
        cwd: input.worktreePath,
        cgroup: { id: input.runId, user: 'fleet-agent-carpool' },
      });
      // 登录态在会话用户家里，不往会话环境里塞钥匙
      expect(spec?.env.extra).toBeUndefined();
      expect(grok.options[0]?.command).toEqual(['/opt/fake/fleet-agent-carpool/grok']);
      expect(fake.count()).toBe(0);

      const end = await ports.awaitSession(
        { taskId, runId: input.runId, sessionId: started.sessionId, stage: 'execute' },
        ctx(),
      );
      expect(end).toMatchObject({
        outcome: 'done',
        sessionId: started.sessionId,
        output: { kind: 'delivery', summary: '做完了', testsPassed: true },
      });
      expect(end.usage).toEqual({
        inputTokens: 42438,
        outputTokens: 955,
        cacheReadTokens: 68992,
        cacheWriteTokens: 0,
      });
      expect(end.sessionCostUsd).toBeUndefined();
      expect(await runRow(input.runId)).toMatchObject({
        sessionId: started.sessionId,
        outcome: 'ok',
        routeOutcome: 'ok',
        actualModel: 'grok-4.7-build',
        inputTokens: 42438,
        outputTokens: 955,
        cacheReadTokens: 68992,
        cacheWriteTokens: 0,
        costUsd: null,
        sessionCostUsd: null,
        contextTokens: null,
      });
      const kinds = (await t.db.select().from(progressEvents))
        .filter((e) => e.runId === input.runId)
        .map((e) => e.kind);
      expect(kinds).toEqual(expect.arrayContaining(['say', 'tool', 'file', 'done']));
    });

    it('交付核对：没用 fleet done，判没交付，不当成做完', async () => {
      const { ports } = setup(() => ({}), { grok: grokDelivers({ noDone: true }) });
      const { end } = await runOnce(ports, grokLaunch());
      expect(end.outcome).toBe('failed');
      expect(end.failure?.code).toBe('not_delivered');
      expect(end.failure?.message).toContain('没用 fleet done');
    });
  });

  it('开 PR 前验证（碰界面的单派给 Grok）：检出送检的头，整份提示词先过卫生检查，读结论文件交回；验证会话一样放开命令', async () => {
    const CRITERIA = ['过期的验证码登录不了'];
    const report = {
      head: m.head,
      results: [{ criterion: CRITERIA[0], answer: 'done', evidence: '看过 a.ts' }],
      findings: [],
    };
    const screened: string[] = [];
    const { ports, grok } = setup(() => ({}), {
      grok: () => ({
        replay: 'grok-read',
        act: ({ spec }) => {
          mkdirSync(join(spec.cwd, '.fleet-out'), { recursive: true });
          writeFileSync(join(spec.cwd, '.fleet-out', 'verify.json'), JSON.stringify(report));
        },
      }),
      screen: (_repo, what) => {
        screened.push(what);
      },
    });
    const base = grokLaunch({ stage: 'verify' });
    const { worktreePath: _w, baseHead: _b, ...rest } = base;
    const { end } = await runOnce(ports, {
      ...rest,
      brief: {
        ...base.brief,
        head: m.head,
        verify: {
          criteria: CRITERIA,
          specPath: 'specs/12-login/需求.md',
          planSummary: '登录表单加验证码',
          changedFiles: ['a.ts'],
        },
      },
    });
    expect(end).toMatchObject({ outcome: 'done', output: { kind: 'verify', report } });
    expect(screened).toEqual(['发给别家的验证材料']);
    expect(grok.specs[0]).toMatchObject({ alwaysApprove: true, model: 'grok-4.7' });
    expect(git(grok.specs[0]?.cwd as string, 'rev-parse', 'HEAD')).toBe(m.head);
  });

  it('派给 Grok 的副手：整份提示词先过卫生检查，查出真密钥不发、不起会话', async () => {
    const leak = ['ghp', 'yU1zL5aC3Kp9mQ2xR7bN4wT8Zt4wQ9mB'].join('_');
    const { ports, grok } = setup(() => ({}), {
      grok: grokDelivers(),
      screen: (repo, what, texts) => assertPublishable(repo, what, texts, repo),
    });
    const input = grokLaunch();
    const error = await ports
      .startSession({ ...input, brief: { ...input.brief, request: `别把 ${leak} 写进日志` } }, ctx())
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'MATERIAL_BLOCKED', retryable: false });
    expect(String((error as Error).message)).toContain('没发给Grok 命令行');
    expect(String((error as Error).message)).not.toContain(leak);
    expect(grok.specs).toEqual([]);
  });

  describe('会话断了接着干：grok 没有我们用得上的 fork，同池、同会话用户、同一个目录才 -r', () => {
    it('同池、同会话用户、同一个目录：-r 续上原来那个号；这一轮的 token 只算这一轮', async () => {
      const { ports, grok } = setup(() => ({}), {
        grok: (_, n) => (n === 1 ? grokDelivers()() : grokDelivers({ replay: 'grok-resume' })()),
      });
      const first = await runOnce(ports, grokLaunch());
      expect(first.end.sessionId).toMatch(UUID_RE);
      const input = grokLaunch({
        resumeSessionId: first.end.sessionId,
        baseHead: first.end.output?.kind === 'delivery' ? first.end.output.head : m.head,
      });
      const started = await ports.startSession(input, ctx());
      expect(started).toMatchObject({ sessionId: first.end.sessionId, resumed: true });
      expect(grok.specs[1]?.session).toEqual({ mode: 'resume', id: first.end.sessionId });
      expect(grok.specs[1]?.prompt.startsWith('接着干')).toBe(true);
      const end = await ports.awaitSession(
        { taskId, runId: input.runId, sessionId: started.sessionId, stage: 'execute' },
        ctx(),
      );
      expect(end).toMatchObject({ outcome: 'done', sessionId: first.end.sessionId });
      expect(end.usage).toEqual({
        inputTokens: 69,
        outputTokens: 44,
        cacheReadTokens: 28288,
        cacheWriteTokens: 0,
      });
    });

    it('续会话回来的不是原来那个号：判续会话没续上', async () => {
      const { ports } = setup(() => ({}), {
        grok: (_, n) =>
          n === 1 ? grokDelivers()() : grokDelivers({ replay: 'grok-resume', keepSessionId: true })(),
      });
      const first = await runOnce(ports, grokLaunch());
      const { end } = await runOnce(
        ports,
        grokLaunch({
          resumeSessionId: first.end.sessionId,
          baseHead: first.end.output?.kind === 'delivery' ? first.end.output.head : m.head,
        }),
      );
      expect(end.outcome).toBe('failed');
      expect(end.failure?.code).toBe('session_mismatch');
    });

    it('换了账号池：grok 不 fork，开新会话带接力任务书（已提交的不重做）', async () => {
      const other = await addGrokRoute(t.db, { poolId: 'grok-b' });
      const { ports, grok } = setup(() => ({}), { grok: () => grokDelivers()() });
      const a = await runOnce(ports, grokLaunch());
      await runOnce(
        ports,
        launch({
          route: { ...other, modelId: 'grok-4.7', family: 'grok', hostId: 'grok' },
          resumeSessionId: a.end.sessionId,
        }),
      );
      expect(grok.specs[1]?.session.mode).toBe('new');
      expect(grok.specs[1]?.session.id).not.toBe(a.end.sessionId);
      expect(grok.specs[1]?.prompt).toContain('换了账号池（grok → grok-b）');
      expect(grok.specs[1]?.prompt).toContain('不能 fork');
      expect(grok.specs[1]?.prompt).toContain('grok: 追加一行');
    });

    it('换了执行方式（Claude 的会话号拿到 grok 上续）：续不上，开新会话带接力任务书', async () => {
      const { ports, grok } = setup(commitAndDone(), { grok: () => grokDelivers()() });
      const a = await runOnce(ports, launch());
      await runOnce(ports, grokLaunch({ resumeSessionId: a.sessionId }));
      expect(grok.specs[0]?.session.mode).toBe('new');
      expect(grok.specs[0]?.prompt).toContain('换了执行方式');
    });
  });

  describe('失败分流', () => {
    it('没登录：会话没开成，交回空串（下次开新会话，不拿没建成的号去 -r）；失败信息带原话、只一份；整池暂停写清在哪台机器以谁跑 grok login --device-code；不算路由的账；登录后跑通撤掉', async () => {
      const { ports, grok } = setup(() => ({}), {
        grok: (_, n) => (n === 1 ? grokRefused(GROK_NOT_SIGNED_IN) : grokDelivers()()),
      });
      const input = grokLaunch();
      const { end } = await runOnce(ports, input);
      expect(end.outcome).toBe('failed');
      expect(end.failure?.code).toBe('no_result');
      expect(end.failure?.message).toContain('Error: Not signed in.');
      expect(end.failure?.message.split('Not signed in').length).toBe(2);
      expect(end.sessionId).toBe('');
      expect(await runRow(input.runId)).toMatchObject({ routeOutcome: 'neutral' });
      const hold = await holdOf('grok');
      expect(hold).toMatchObject({ level: 'decision', resolvedAt: null });
      expect(hold?.title).toContain('Grok 登录失效');
      expect(hold?.body).toContain('在「法国」上以会话用户 fleet-agent-carpool 跑 grok login --device-code');
      expect(hold?.body).toContain('docs/ops.md 第五节「会话用户的 grok」');

      // 登录好了：工作流手里没有号（交回的是空串），开新会话、带新号，不 -r
      await runOnce(ports, grokLaunch());
      expect(grok.specs[1]?.session.mode).toBe('new');
      expect(grok.specs[1]?.session.id).not.toBe(grok.specs[0]?.session.id);
      expect((await holdOf('grok'))?.resolvedAt).not.toBeNull();
    });

    it('登录过期、续不上（Token expired）：照登录失效整池暂停，写清重新登录；不算路由的账', async () => {
      const { ports } = setup(() => ({}), { grok: () => grokRefused(GROK_TOKEN_EXPIRED) });
      const input = grokLaunch();
      const { end } = await runOnce(ports, input);
      expect(end).toMatchObject({ outcome: 'failed', failure: { code: 'no_result' } });
      expect(end.failure?.message).toContain('Token expired');
      expect(await runRow(input.runId)).toMatchObject({ routeOutcome: 'neutral' });
      expect((await holdOf('grok'))?.title).toContain('Grok 登录失效');
    });

    it('会话用户家里没装 grok（起法那段 sh 退出 127）：认成执行方式或路由配置不对，算路由的账；不整池暂停', async () => {
      const { ports } = setup(() => ({}), {
        grok: () => ({
          stderr: `${GROK_MISSING}：/home/fleet-agent-carpool/.grok/bin/grok 不在或不能跑（会话用户家里没装 grok 命令行，docs/ops.md 第五节「会话用户的 grok」）\n`,
          exitCode: 127,
        }),
      });
      const input = grokLaunch();
      const { end } = await runOnce(ports, input);
      expect(end).toMatchObject({ outcome: 'failed', sessionId: '' });
      expect(end.failure?.message).toContain('没装 grok 命令行');
      expect(await runRow(input.runId)).toMatchObject({ routeOutcome: 'fail' });
      expect(await holdOf('grok')).toBeUndefined();
    });

    it('路由上写的型号 grok 不认：认成模型不存在或已下架，算路由的账；不整池暂停', async () => {
      const { ports } = setup(() => ({}), { grok: () => grokRefused(GROK_UNKNOWN_MODEL) });
      const input = grokLaunch();
      const { end } = await runOnce(ports, input);
      expect(end.failure?.message).toContain('unknown model id');
      expect(await runRow(input.runId)).toMatchObject({ routeOutcome: 'fail' });
      expect(await holdOf('grok')).toBeUndefined();
    });

    it('回话的是别的一代（点名 grok-4.7、回 grok-4.6-build）：判模型不符，实际模型照记，算路由的账', async () => {
      const { ports } = setup(() => ({}), {
        grok: () => ({ frames: grokAnswered('好了', 'grok-4.6-build') }),
      });
      const input = grokLaunch({ stage: 'triage' });
      const { worktreePath: _w, baseHead: _b, subtaskKey: _k, ...rest } = input;
      const { end } = await runOnce(ports, rest);
      expect(end).toMatchObject({ outcome: 'failed', failure: { code: 'model_mismatch' } });
      expect(end.failure?.message).toContain('点名 grok-4.7，实际 grok-4.6-build');
      expect(await runRow(input.runId)).toMatchObject({
        routeOutcome: 'fail',
        actualModel: 'grok-4.6-build',
      });
    });

    it('stdin 不是真管道（读 /dev/stdin 报 ENXIO）：认成执行方式或路由配置不对，不当成没登录、不整池暂停', async () => {
      const { ports } = setup(() => ({}), {
        grok: () => ({ stderr: `${GROK_NO_STDIN}\n`, exitCode: 1 }),
      });
      const input = grokLaunch();
      const { end } = await runOnce(ports, input);
      expect(end.failure?.message).toContain('No such device or address (os error 6)');
      expect(await runRow(input.runId)).toMatchObject({ routeOutcome: 'fail' });
      expect(await holdOf('grok')).toBeUndefined();
    });
  });
});
