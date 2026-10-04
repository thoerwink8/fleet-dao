// 会话端口（cursor-agent：会话端口按执行方式分派）。夹具在 sessions-rig.ts；原来一个文件，拆开是为了让 CI 的 engine 分片能按文件均分。
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';

import { join } from 'node:path';
import {
  appendProgressEvents,
  getSessionRun,
  latestRunOfSession,
  notifications,
  progressEvents,
} from '@fleet-dao/db';

import { beforeEach, describe, expect, it } from 'vitest';

import type { LaunchSessionInput, SessionEnd } from '../../src/ports.ts';

import { CURSOR_KEY_BAD, CURSOR_KEY_EXIT, CURSOR_MISSING } from '../../src/real/hosts.ts';

import { poolHoldKey } from '../../src/real/store-ports.ts';
import { layout } from '../../src/real/worktrees.ts';
import {
  addCursorRoute,
  CURSOR_KEY_REJECTED,
  CURSOR_NO_LOGIN,
  CURSOR_SESSION,
  CURSOR_TRUST_REQUIRED,
  type CursorKeyRig,
  cursorKeyRig,
  dumpDb,
  type FakeCursorScript,
  git,
} from './fixtures.ts';

import {
  BRANCH,
  commitAndDone,
  ctx,
  launch,
  m,
  repo,
  root,
  runOnce,
  runRow,
  setup,
  t,
  taskId,
} from './sessions-rig.ts';

describe('cursor-agent：会话端口按执行方式分派（法国真跑夹具驱动）', () => {
  let cursorRoute: LaunchSessionInput['route'];
  beforeEach(async () => {
    const { routeId, poolId } = await addCursorRoute(t.db);
    cursorRoute = { routeId, poolId, modelId: 'cursor-auto', family: 'cursor', hostId: 'cursor-agent' };
  });
  const cursorLaunch = (over: Partial<LaunchSessionInput> = {}) => launch({ route: cursorRoute, ...over });
  const pending = (runId: string) => `cursor-pending:${runId}`;

  /** 会话在树里干完活：提交一个文件、fleet done（后端写 done 进度）；过程记录回放真跑的那一份。 */
  const cursorDelivers =
    (options: { dirty?: boolean; noCommit?: boolean; noDone?: boolean; replay?: string } = {}) =>
    (): FakeCursorScript => ({
      replay: options.replay ?? 'cursor-edit-commit',
      act: async ({ spec }) => {
        if (!options.noCommit) {
          mkdirSync(join(spec.cwd, 'src'), { recursive: true });
          writeFileSync(join(spec.cwd, 'src', `c-${randomUUID().slice(0, 4)}.ts`), 'export const c = 1;\n');
          git(spec.cwd, 'add', '--', 'src');
          git(spec.cwd, 'commit', '-q', '-m', 'cursor: 追加一行');
        }
        if (options.dirty) writeFileSync(join(spec.cwd, 'README.md'), '# 改了没提交\n');
        if (!options.noDone) {
          await appendProgressEvents(t.db, spec.runId, [
            { at: new Date(), kind: 'done', payload: { summary: '做完了', testsPassed: true } },
          ]);
        }
      },
    });
  const triageFile = (text: string | null) => (spec: { cwd: string }) => {
    if (text === null) return;
    mkdirSync(join(spec.cwd, '.fleet-out'), { recursive: true });
    writeFileSync(join(spec.cwd, '.fleet-out', 'triage.json'), text);
  };
  const triageOnly = (input: LaunchSessionInput) => {
    const { subtaskKey: _k, worktreePath: _w, baseHead: _b, ...rest } = input;
    return rest;
  };
  const holdOf = async (poolId: string) =>
    (await t.db.select().from(notifications)).find((n) => n.dedupeKey === poolHoldKey(poolId));

  describe('写码会话', () => {
    it('池不绑会话用户也以唯一的会话用户起；开工先回临时号，结束交真号；交活、进度、token 照终帧记（没有花费、没有实际模型）', async () => {
      const { ports, cursor, fake } = setup(() => ({}), { cursor: cursorDelivers() });
      const input = cursorLaunch();
      const started = await ports.startSession(input, ctx());
      // 会话号 cursor 自己在 init 帧里起，事先定不了：先回一眼看得出不是 UUID 的临时号，开工照记
      expect(started).toMatchObject({
        sessionId: pending(input.runId),
        resumed: false,
        handle: { pid: 4343 },
      });
      expect(await getSessionRun(t.db, input.runId)).toMatchObject({
        sessionId: pending(input.runId),
        runAsUser: 'fleet-agent-carpool',
      });
      const spec = cursor.specs[0];
      expect(spec).toMatchObject({
        session: { mode: 'new' },
        force: true,
        model: 'auto',
        cwd: input.worktreePath,
        cgroup: { id: input.runId, user: 'fleet-agent-carpool' },
      });
      // 登录态在会话用户家里，不往会话环境里塞钥匙
      expect(spec?.env.extra).toBeUndefined();
      expect(cursor.options[0]?.command).toEqual(['/opt/fake/fleet-agent-carpool/cursor-agent']);
      expect(fake.count()).toBe(0);

      const end = await ports.awaitSession(
        { taskId, runId: input.runId, sessionId: started.sessionId, stage: 'execute' },
        ctx(),
      );
      expect(end).toMatchObject({
        outcome: 'done',
        sessionId: CURSOR_SESSION,
        output: { kind: 'delivery', summary: '做完了', testsPassed: true },
      });
      expect(end.output?.kind === 'delivery' && end.output.head).toBe(
        git(input.worktreePath as string, 'rev-parse', 'HEAD'),
      );
      // 终帧报的这一轮的 token，缓存读写照记；cursor 不报花费
      expect(end.usage).toEqual({
        inputTokens: 12715,
        outputTokens: 178,
        cacheReadTokens: 19968,
        cacheWriteTokens: 0,
      });
      expect(end.sessionCostUsd).toBeUndefined();
      expect(await runRow(input.runId)).toMatchObject({
        sessionId: CURSOR_SESSION,
        outcome: 'ok',
        routeOutcome: 'ok',
        inputTokens: 12715,
        outputTokens: 178,
        cacheReadTokens: 19968,
        cacheWriteTokens: 0,
        costUsd: null,
        sessionCostUsd: null,
        actualModel: null,
        contextTokens: null,
      });
      // 下次拿真号续会话查得到这一轮
      expect((await latestRunOfSession(t.db, CURSOR_SESSION))?.id).toBe(input.runId);
      const kinds = (await t.db.select().from(progressEvents))
        .filter((e) => e.runId === input.runId)
        .map((e) => e.kind);
      expect(kinds).toEqual(expect.arrayContaining(['say', 'tool', 'done']));
    });

    it('交付核对：没用 fleet done、有没提交的已跟踪改动、没有新提交，都判没交付，不当成做完', async () => {
      for (const [options, words] of [
        [{ noDone: true }, '没用 fleet done'],
        [{ dirty: true }, '没提交的已跟踪改动'],
        [{ noCommit: true }, '没有新提交'],
      ] as const) {
        const { ports } = setup(() => ({}), { cursor: cursorDelivers(options) });
        const { end } = await runOnce(
          ports,
          cursorLaunch({ worktreePath: layout(join(root, `w-${randomUUID()}`)).treeFor(repo, BRANCH) }),
        );
        expect(end.outcome).toBe('failed');
        expect(end.failure?.code).toBe('not_delivered');
        expect(end.failure?.message).toContain(words);
      }
    });
  });

  describe('只读会话：读结论文件', () => {
    it('分诊：检出副本里写对了结论文件就交回；会话号、token 照这一份真跑记录', async () => {
      const { ports, cursor } = setup(() => ({}), {
        cursor: () => ({
          replay: 'cursor-read',
          act: ({ spec }) => triageFile('{"clear": true, "summary": "理解为：加验证码", "size": "S"}')(spec),
        }),
      });
      const { end } = await runOnce(ports, triageOnly(cursorLaunch({ stage: 'triage' })));
      expect(end).toMatchObject({
        outcome: 'done',
        sessionId: 'f9f76081-8060-4382-80e3-876921bf879c',
        output: { kind: 'triage', verdict: { clear: true, size: 'S' } },
      });
      expect(end.usage).toEqual({
        inputTokens: 16639,
        outputTokens: 101,
        cacheReadTokens: 16512,
        cacheWriteTokens: 0,
      });
      expect(cursor.specs[0]?.cwd).toBe(layout(join(root, 'work')).scratchFor(repo, 12, 'triage'));
    });

    it('说做完了却没写结论文件：判交错了（wrong_output）', async () => {
      const { ports } = setup(() => ({}), {
        cursor: () => ({ replay: 'cursor-read', act: ({ spec }) => triageFile(null)(spec) }),
      });
      const { end } = await runOnce(ports, triageOnly(cursorLaunch({ stage: 'triage' })));
      expect(end.outcome).toBe('failed');
      expect(end.failure?.code).toBe('wrong_output');
    });

    it('终帧里没有用量：token 一个都不记（不记成 0）', async () => {
      const { ports } = setup(() => ({}), {
        cursor: () => ({
          replay: 'cursor-read',
          replayLines: 1,
          frames: [{ type: 'result', subtype: 'success', is_error: false, result: '好了' }],
          act: ({ spec }) => triageFile('{"clear": true, "summary": "理解为：加验证码", "size": "S"}')(spec),
        }),
      });
      const input = triageOnly(cursorLaunch({ stage: 'triage' }));
      const { end } = await runOnce(ports, input);
      expect(end.outcome).toBe('done');
      expect(end.usage).toEqual({});
      expect(await runRow(input.runId)).toMatchObject({
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        costUsd: null,
      });
    });
  });

  describe('会话断了接着干：cursor 没有 fork，只有同池、同会话用户、同一个目录、真号才 --resume', () => {
    it('同池、同会话用户、同一个目录、真号：--resume 续上，回的就是原来那个号', async () => {
      const { ports, cursor } = setup(() => ({}), {
        cursor: (_, n) => (n === 1 ? cursorDelivers()() : cursorDelivers({ replay: 'cursor-resume' })()),
      });
      const first = await runOnce(ports, cursorLaunch());
      expect(first.end.sessionId).toBe(CURSOR_SESSION);
      const input = cursorLaunch({
        resumeSessionId: first.end.sessionId,
        baseHead: first.end.output?.kind === 'delivery' ? first.end.output.head : m.head,
      });
      const started = await ports.startSession(input, ctx());
      expect(started).toMatchObject({ sessionId: CURSOR_SESSION, resumed: true });
      expect(cursor.specs[1]?.session).toEqual({ mode: 'resume', id: CURSOR_SESSION });
      expect(cursor.specs[1]?.prompt.startsWith('接着干')).toBe(true);
      const end = await ports.awaitSession(
        { taskId, runId: input.runId, sessionId: started.sessionId, stage: 'execute' },
        ctx(),
      );
      expect(end).toMatchObject({ outcome: 'done', sessionId: CURSOR_SESSION });
      // 续会话那一轮的终帧只算这一轮
      expect(end.usage).toEqual({
        inputTokens: 160,
        outputTokens: 72,
        cacheReadTokens: 16384,
        cacheWriteTokens: 0,
      });
    });

    it('续会话回来的不是原来那个会话：停掉，判续会话没续上', async () => {
      const { ports } = setup(() => ({}), {
        cursor: (_, n) => (n === 1 ? cursorDelivers()() : cursorDelivers({ replay: 'cursor-read' })()),
      });
      const first = await runOnce(ports, cursorLaunch());
      const { end } = await runOnce(
        ports,
        cursorLaunch({
          resumeSessionId: first.end.sessionId,
          baseHead: first.end.output?.kind === 'delivery' ? first.end.output.head : m.head,
        }),
      );
      expect(end.outcome).toBe('failed');
      expect(end.failure?.code).toBe('session_mismatch');
    });

    /** 第一轮照 first 跑完，第二轮照 second（拿第一轮的结局定怎么续）跑，看第二轮交给插头的会话和提示词。 */
    async function relayAfter(
      first: { launch: LaunchSessionInput; cursor?: FakeCursorScript },
      second: (a: { sessionId: string; end: SessionEnd }) => LaunchSessionInput,
    ) {
      const { ports, cursor, fake } = setup(commitAndDone(), {
        cursor: (_, n) => (n === 1 && first.cursor ? first.cursor : cursorDelivers()()),
      });
      const a = await runOnce(ports, first.launch);
      await runOnce(ports, second({ sessionId: a.sessionId, end: a.end }));
      return { cursor, fake };
    }

    it('续的号是临时号（cursor 报出真号之前就断了，接不上时工作流手里只有它）：认出不是 UUID，开新会话带接力任务书', async () => {
      const lost = cursorLaunch();
      const { cursor } = await relayAfter(
        { launch: lost, cursor: { stderr: '✗ Failed to reach the Cursor API.', exitCode: 1 } },
        () => cursorLaunch({ resumeSessionId: pending(lost.runId) }),
      );
      // 库里那一轮留着临时号：照它找得到上一轮，接力任务书带上它为什么断的
      expect(cursor.specs[1]?.session).toEqual({ mode: 'new' });
      expect(cursor.specs[1]?.prompt).toContain('接力');
      expect(cursor.specs[1]?.prompt).toContain('不是执行体自己的会话号');
      expect(cursor.specs[1]?.prompt).toContain('Failed to reach the Cursor API');
    });

    it('上一轮的记录查不到：开新会话带接力任务书', async () => {
      const { cursor } = await relayAfter({ launch: cursorLaunch() }, () =>
        cursorLaunch({ resumeSessionId: randomUUID() }),
      );
      expect(cursor.specs[1]?.session).toEqual({ mode: 'new' });
      expect(cursor.specs[1]?.prompt).toContain('记录查不到');
    });

    it('换了账号池：cursor 没有 fork，开新会话带接力任务书（已提交的不重做）', async () => {
      const other = await addCursorRoute(t.db, { poolId: 'cursor-b' });
      // 起会话前的头照旧是主线的头：接力任务书列的是这之后已经提交的（上一轮的那个提交）
      const { cursor } = await relayAfter({ launch: cursorLaunch() }, ({ end }) =>
        launch({
          route: { ...other, modelId: 'cursor-auto', family: 'cursor', hostId: 'cursor-agent' },
          resumeSessionId: end.sessionId,
        }),
      );
      expect(cursor.specs[1]?.session).toEqual({ mode: 'new' });
      expect(cursor.specs[1]?.prompt).toContain('换了账号池（cursor → cursor-b）');
      expect(cursor.specs[1]?.prompt).toContain('不能 fork');
      expect(cursor.specs[1]?.prompt).toContain('cursor: 追加一行');
    });

    it('上一轮跑在已停用的会话用户下：同一个池也不硬续，开新会话带接力任务书', async () => {
      const { ports, cursor } = setup(() => ({}), { cursor: () => cursorDelivers()() });
      const first = await runOnce(ports, cursorLaunch());
      await t.client.query(
        `update session_runs set run_as_user = 'fleet-agent-dedicated' where session_id = $1`,
        [first.end.sessionId],
      );
      await runOnce(ports, cursorLaunch({ resumeSessionId: first.end.sessionId }));
      expect(cursor.specs[1]?.session).toEqual({ mode: 'new' });
      expect(cursor.specs[1]?.prompt).toContain('不是现在的会话用户');
    });

    it('换了目录（会话记录按目录存）：开新会话带接力任务书', async () => {
      const { cursor } = await relayAfter({ launch: cursorLaunch() }, ({ end }) =>
        cursorLaunch({
          resumeSessionId: end.sessionId,
          worktreePath: layout(join(root, 'elsewhere')).treeFor(repo, BRANCH),
        }),
      );
      expect(cursor.specs[1]?.session).toEqual({ mode: 'new' });
      expect(cursor.specs[1]?.prompt).toContain('换了目录续不上');
    });

    it('换了执行方式（Claude 的会话号拿到 cursor 上续）：续不上，开新会话带接力任务书', async () => {
      const { cursor } = await relayAfter({ launch: launch() }, ({ sessionId }) =>
        cursorLaunch({ resumeSessionId: sessionId }),
      );
      expect(cursor.specs[0]?.session).toEqual({ mode: 'new' });
      expect(cursor.specs[0]?.prompt).toContain('换了执行方式');
    });

    it('换了执行方式（cursor 的会话号拿到 Claude 的别的池上续）：不拿 cursor 的号去 fork，开新会话带接力任务书', async () => {
      const carpool = {
        routeId: 'carpool',
        poolId: 'claude-carpool',
        modelId: 'opus-5.5',
        family: 'claude',
        hostId: 'claude-code' as const,
      };
      const { fake } = await relayAfter({ launch: cursorLaunch() }, ({ end }) =>
        launch({ route: carpool, resumeSessionId: end.sessionId }),
      );
      expect(fake.specs[0]?.session.mode).toBe('new');
      expect(fake.specs[0]?.prompt).toContain('换了执行方式');
    });
  });

  describe('失败分流：cursor 的认证、额度、网络报错只在 stderr（退出 1、没有 JSON）', () => {
    it('登录失效：失败信息带原话；整池暂停，写清去 Cursor 后台重新生成密钥、照 ops 放进哪台机器谁家里；不算路由的账；下一次跑通撤掉', async () => {
      const { ports } = setup(() => ({}), {
        cursor: (_, n) => (n === 1 ? { stderr: CURSOR_NO_LOGIN, exitCode: 1 } : cursorDelivers()()),
      });
      const input = cursorLaunch();
      const { end } = await runOnce(ports, input);
      expect(end.outcome).toBe('failed');
      expect(end.failure?.code).toBe('no_result');
      expect(end.failure?.message).toContain("Please run 'cursor-agent login'");
      // 没报出会话号就结束了：交回空串，工作流保留上一个；库里留着开工时的临时号
      expect(end.sessionId).toBe('');
      expect(await runRow(input.runId)).toMatchObject({
        sessionId: pending(input.runId),
        routeOutcome: 'neutral',
      });
      const hold = await holdOf('cursor');
      expect(hold).toMatchObject({ level: 'decision', resolvedAt: null });
      expect(hold?.title).toContain('Cursor 登录失效');
      expect(hold?.body).toContain('法国');
      expect(hold?.body).toContain('fleet-agent-carpool');
      expect(hold?.body).toContain('cursor.com/dashboard/api');
      expect(hold?.body).toContain('docs/ops.md 第五节「会话用户的 Cursor 密钥」');

      await runOnce(ports, cursorLaunch());
      expect((await holdOf('cursor'))?.resolvedAt).not.toBeNull();
    });

    it('Cursor 拒了会话用户的 API 密钥（无效、被撤、过期）：照登录失效整池暂停，提醒写清去后台重新生成、照 ops 放进法国；不算路由的账；原话去掉终端颜色', async () => {
      const { ports } = setup(() => ({}), {
        cursor: () => ({ stderr: CURSOR_KEY_REJECTED, exitCode: 1 }),
      });
      const input = cursorLaunch();
      const { end } = await runOnce(ports, input);
      expect(end).toMatchObject({ outcome: 'failed', failure: { code: 'no_result' } });
      expect(end.failure?.message).toContain('The provided API key is invalid');
      expect(end.failure?.message).not.toContain('\u001b');
      expect(await runRow(input.runId)).toMatchObject({ routeOutcome: 'neutral' });
      const hold = await holdOf('cursor');
      expect(hold?.title).toContain('Cursor 登录失效');
      expect(hold?.body).toContain('cursor.com/dashboard/api');
      expect(hold?.body).toContain('「法国」');
    });

    it('会话用户家里的密钥文件没放好（起它的那段 sh 退出 78）：整池暂停，提醒写清哪里不对、照 ops 放好；不算路由的账', async () => {
      const bad = `${CURSOR_KEY_BAD}：不在。文件是 /home/fleet-agent-carpool/.cursor/fleet-api-key，照 docs/ops.md 第五节「会话用户的 Cursor 密钥」放好`;
      const { ports } = setup(() => ({}), {
        cursor: () => ({ stderr: bad, exitCode: CURSOR_KEY_EXIT }),
      });
      const input = cursorLaunch();
      const { end } = await runOnce(ports, input);
      expect(end).toMatchObject({ outcome: 'failed', failure: { code: 'no_result' } });
      expect(end.failure?.message).toContain(`${CURSOR_KEY_BAD}：不在。文件是 /home/fleet-agent-carpool/`);
      expect(await runRow(input.runId)).toMatchObject({ routeOutcome: 'neutral' });
      const hold = await holdOf('cursor');
      expect(hold?.title).toContain('Cursor 密钥没放好');
      expect(hold?.body).toContain('会话用户 fleet-agent-carpool 的 Cursor 密钥放好');
      // 哪里不对摘进了提醒
      expect(hold?.body).toContain(`${CURSOR_KEY_BAD}：不在`);
    });

    it('没信任过的目录（-p 打一段 Workspace Trust 提示就退出）：认成执行方式或路由配置不对，失败信息带那一句；算路由的账', async () => {
      const { ports } = setup(() => ({}), {
        cursor: () => ({ stderr: CURSOR_TRUST_REQUIRED, exitCode: 1 }),
      });
      const input = cursorLaunch();
      const { end } = await runOnce(ports, input);
      expect(end).toMatchObject({ outcome: 'failed', failure: { code: 'no_result' } });
      expect(end.failure?.message).toContain('Workspace Trust Required');
      expect(await runRow(input.runId)).toMatchObject({ routeOutcome: 'fail' });
      expect(await holdOf('cursor')).toBeUndefined();
    });

    it('额度用满（请求被拒、不扣钱）：按额度用满判，不当成执行体出错；失败信息带原话；不整池暂停等人', async () => {
      const { ports } = setup(() => ({}), {
        cursor: () => ({ stderr: "Error: You've hit your usage limit for this billing cycle.", exitCode: 1 }),
      });
      const input = cursorLaunch();
      const { end } = await runOnce(ports, input);
      expect(end.outcome).toBe('failed');
      expect(end.failure?.code).toBe('quota_exhausted');
      expect(end.failure?.message).toContain('hit your usage limit');
      expect(await runRow(input.runId)).toMatchObject({ routeOutcome: 'neutral' });
      expect(await holdOf('cursor')).toBeUndefined();
    });

    it('没有 init 帧（连不上 Cursor）：没有终帧，原因带原话；交回空串，库里的临时号照样找得到这一轮', async () => {
      const { ports } = setup(() => ({}), {
        cursor: () => ({
          stderr:
            '✗ Failed to reach the Cursor API. Check that your proxy (http://<回环>:7890/) is reachable.',
          exitCode: 1,
        }),
      });
      const input = cursorLaunch();
      const { end } = await runOnce(ports, input);
      expect(end).toMatchObject({ outcome: 'failed', sessionId: '', failure: { code: 'no_result' } });
      expect(end.failure?.message).toContain('Failed to reach the Cursor API');
      expect((await latestRunOfSession(t.db, pending(input.runId)))?.id).toBe(input.runId);
      expect(await holdOf('cursor')).toBeUndefined();
    });

    it('起来了、一帧都没有就退出（退出码 0）：没有终帧，不当成做完', async () => {
      const { ports } = setup(() => ({}), { cursor: () => ({}) });
      const { end } = await runOnce(ports, cursorLaunch());
      expect(end).toMatchObject({ outcome: 'failed', sessionId: '', failure: { code: 'no_result' } });
    });

    it('会话用户家里没装 cursor-agent（找版本目录的那段 sh 退出 127）：认成执行方式或路由配置不对，算路由的账', async () => {
      const { ports } = setup(() => ({}), {
        cursor: () => ({
          stderr: `${CURSOR_MISSING}：/home/fleet-agent-carpool/.local/share/cursor-agent/versions 下既没有 current，也没有能跑的版本目录（会话用户家里没装 cursor-agent）`,
          exitCode: 127,
        }),
      });
      const input = cursorLaunch();
      const { end } = await runOnce(ports, input);
      expect(end.outcome).toBe('failed');
      expect(end.failure?.message).toContain('没装 cursor-agent');
      expect(await runRow(input.runId)).toMatchObject({ routeOutcome: 'fail' });
      expect(await holdOf('cursor')).toBeUndefined();
    });
  });

  // 真插头（runCursorAgent）、真起法（cursorLaunchCommand：会话用户自己读密钥、现找版本目录）、经假帮手真起进程：会话真带上了
  // 那一把，库（进度事件、会话记录、提醒……）、引擎日志、帮手收到的参数和环境、cursor-agent 收到的参数、交回工作流的结局里
  // 都搜不到值。Windows 上起不了 /bin/sh，NTFS 也表示不了 600。
  describe.skipIf(process.platform === 'win32')('API 密钥真走一遍：会话带上了它，哪里都搜不到值', () => {
    let rig: CursorKeyRig;
    beforeEach(() => {
      rig = cursorKeyRig(root);
    });
    const everywhere = async (logs: string[], end: SessionEnd) =>
      [await dumpDb(t.client), rig.traces(), ...logs, JSON.stringify(end)].join('\n');

    it('放好了：cursor-agent 拿到的就是文件里那一把（对得上才说 OK），说的话进了进度；干活的会话带 --force、--trust；哪里都没有值', async () => {
      const { ports, logs } = setup(() => ({}), { realCursor: rig });
      const input = cursorLaunch();
      const { end } = await runOnce(ports, input);
      const says = (await t.db.select().from(progressEvents))
        .filter((e) => e.runId === input.runId && e.kind === 'say')
        .map((e) => (e.payload as { text?: string } | null)?.text);
      expect(says).toContain('OK');
      expect(says).not.toContain('KEY_MISMATCH');
      expect(says).not.toContain('NO_KEY');
      expect(rig.traces()).toContain('--force');
      expect(rig.traces()).toContain('--trust');
      const all = await everywhere(logs, end);
      expect(all).toContain(input.runId);
      expect(all).toContain('"action":"run"');
      expect(all).not.toContain(rig.key);
    });

    it('Cursor 拒了这一把：失败信息带原话、整池暂停写清去后台重新生成；哪里都没有值', async () => {
      rig.rejectKey();
      const { ports, logs } = setup(() => ({}), { realCursor: rig });
      const { end } = await runOnce(ports, cursorLaunch());
      expect(end.failure?.message).toContain('The provided API key is invalid');
      expect((await holdOf('cursor'))?.body).toContain('cursor.com/dashboard/api');
      expect(await everywhere(logs, end)).not.toContain(rig.key);
    });

    it('密钥文件里多了一行（两把粘在一起）：cursor-agent 不起，失败信息写清哪里不对、整池暂停；哪里都没有值', async () => {
      writeFileSync(rig.keyFile, `${rig.key}\n${rig.key}`);
      chmodSync(rig.keyFile, 0o600);
      const { ports, logs } = setup(() => ({}), { realCursor: rig });
      const { end } = await runOnce(ports, cursorLaunch());
      expect(rig.agentRan()).toBe(false);
      expect(end.failure?.message).toContain(`${CURSOR_KEY_BAD}：里面有空白、换行或控制字符`);
      expect((await holdOf('cursor'))?.title).toContain('Cursor 密钥没放好');
      expect(await everywhere(logs, end)).not.toContain(rig.key);
    });
  });
});

// grok（#266）：和 cursor 同一套端口，会话号由我们定（-s / -r），终帧回同一个号和实际模型；认证是会话用户家里的登录态。
// 没登录、登录过期、没装、型号不认、回话的不是点名那一代、stdin 不是真管道，各造一次。
