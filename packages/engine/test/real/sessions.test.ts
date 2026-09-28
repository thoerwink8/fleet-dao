// 会话端口：起会话（建树、定接着干的方式、登记开工）、看守（进度写库、按进展判停滞、交活核实、读结论文件）、
// 叫停、收孤儿。用内存库、本地 git（顶替会话用户的执行器）、假插头（不起真执行体）；每条失败路径都故意造一次。
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCursorAgent, scopePrefix } from '@fleet-dao/adapters';
import {
  appendProgressEvents,
  auditLog,
  getSessionRun,
  latestRunOfSession,
  notifications,
  progressEvents,
  quotaWindows,
  sessionRuns,
  sessionStops,
  upsertAlert,
} from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { assertPublishable } from '@fleet-dao/github';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JevAskContext, JevPort, JevQuestion, JevReply } from '../../src/failure/jev.ts';
import type { LaunchSessionInput, LeadStep, PortContext, SessionEnd } from '../../src/ports.ts';
import { localExec } from '../../src/real/exec.ts';
import { CURSOR_KEY_BAD, CURSOR_KEY_EXIT, CURSOR_MISSING, GROK_MISSING } from '../../src/real/hosts.ts';
import { createSessionPorts, type SessionPortsDeps, screenForOtherVendor } from '../../src/real/sessions.ts';
import { poolHoldKey } from '../../src/real/store-ports.ts';
import { layout } from '../../src/real/worktrees.ts';
import {
  addCursorRoute,
  addGrokRoute,
  addTask,
  CURSOR_KEY_REJECTED,
  CURSOR_NO_LOGIN,
  CURSOR_SESSION,
  CURSOR_TRUST_REQUIRED,
  type CursorKeyRig,
  cursorKeyRig,
  dumpDb,
  type FakeCursorScript,
  type FakeGrokScript,
  type FakeRunScript,
  fakeCursorRun,
  fakeGrokRun,
  fakeMirasimDeps,
  fakeRun,
  fakeScopeHelper,
  fakeTrees,
  GROK_NO_STDIN,
  GROK_NOT_SIGNED_IN,
  GROK_TOKEN_EXPIRED,
  GROK_UNKNOWN_MODEL,
  git,
  grokAnswered,
  grokRefused,
  mirror,
  NOW,
  untilAborted,
  world,
} from './fixtures.ts';

// 每条用例（和每条用例前建的镜像）都真跑好几次 git（Windows 上一次几百毫秒），机器忙时默认的 5 秒、10 秒不够。
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());

let root: string;
let m: ReturnType<typeof mirror>;
let taskId: string;
let repo: { owner: string; name: string };
beforeEach(async () => {
  await resetTestDb(t);
  await world(t.db);
  const added = await addTask(t.db);
  taskId = added.task.id;
  repo = { owner: added.repo.owner, name: added.repo.name };
  root = mkdtempSync(join(tmpdir(), 'fleet-sessions-'));
  m = mirror(root);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const k of ['FAKE_SCOPE_LOG', 'FAKE_SCOPE_LIST', 'FAKE_SCOPE_LIST_EXIT', 'FAKE_SCOPE_STOP_EXIT']) {
    delete process.env[k];
  }
});

const BRANCH = 'fleet/12-login';

function ctx(): PortContext & { beats: number } {
  const c = { beats: 0 } as PortContext & { beats: number };
  return Object.assign(c, {
    signal: new AbortController().signal,
    heartbeat() {
      c.beats += 1;
    },
    attempt: 1,
    lastHeartbeat: undefined,
  });
}

function setup(
  script: (spec: Parameters<ReturnType<typeof fakeRun>['run']>[0], n: number) => FakeRunScript,
  options: {
    spawnTimeoutMs?: number;
    gh?: typeof m.gh;
    jev?: JevPort;
    jevTimeoutMs?: number;
    stallJevEveryMs?: number;
    /** cursor-agent 路由起的会话走这个剧本（假插头照真跑夹具回放）；不给就是不该起 cursor。 */
    cursor?: (spec: Parameters<ReturnType<typeof fakeCursorRun>['run']>[0], n: number) => FakeCursorScript;
    /** 发给别家（开 PR 前验证）的材料怎么过卫生检查；不给就是没配检查。 */
    screen?: SessionPortsDeps['screen'];
    /** 端口的日志（删不掉临时目录这类只记日志的）；不给就不记。 */
    log?: SessionPortsDeps['log'];
    /** cursor 的会话用真插头、真起法（经假帮手真起进程，fixtures 的 cursorKeyRig），不用假插头。 */
    realCursor?: CursorKeyRig;
    /** grok 路由起的会话走这个剧本（假插头照真跑夹具回放）；不给就是不该起 grok。 */
    grok?: (spec: Parameters<ReturnType<typeof fakeGrokRun>['run']>[0], n: number) => FakeGrokScript;
  } = {},
) {
  const fake = fakeRun(script);
  const cursor = fakeCursorRun(
    options.cursor ??
      (() => {
        throw new Error('这条用例不该起 cursor-agent');
      }),
  );
  const grok = fakeGrokRun(
    options.grok ??
      (() => {
        throw new Error('这条用例不该起 grok');
      }),
  );
  const trees = fakeTrees(join(root, 'work'));
  const scope = fakeScopeHelper(root);
  const rig = options.realCursor;
  const logs: string[] = [];
  const ports = createSessionPorts({
    db: t.db,
    trees: trees.trees,
    exec: localExec(),
    gh: options.gh ?? m.gh,
    tmpDir: join(root, 'tmp'),
    machine: '法国',
    claudeCommand: (user) => [`/opt/fake/${user}/reclaude`],
    cursorCommand: rig ? rig.command : (user) => [`/opt/fake/${user}/cursor-agent`],
    grokCommand: (user) => [`/opt/fake/${user}/grok`],
    ...fakeMirasimDeps(),
    helper: rig ? rig.helper : scope.helper,
    sudo: rig ? rig.sudo : scope.sudo,
    gitBin: 'git',
    shBin: 'sh',
    run: { 'claude-code': fake.run, 'cursor-agent': rig ? runCursorAgent : cursor.run, grok: grok.run },
    tickMs: 10,
    stallCheckMs: 30,
    flushMs: 5,
    spawnTimeoutMs: options.spawnTimeoutMs ?? 5000,
    stallPolicy: { noProgressSeconds: 1 },
    ...(options.jev ? { jev: options.jev } : {}),
    ...(options.jevTimeoutMs === undefined ? {} : { jevTimeoutMs: options.jevTimeoutMs }),
    ...(options.stallJevEveryMs === undefined ? {} : { stallJevEveryMs: options.stallJevEveryMs }),
    // 派给别家（cursor、grok）的整份提示词都要先过卫生检查：起它们的用例没给检查就放一个都放行的（查出来拦下的另有用例）
    ...(options.screen
      ? { screen: options.screen }
      : options.cursor || options.grok || rig
        ? { screen: () => {} }
        : {}),
    log: (message, fields) => {
      if (rig) logs.push(JSON.stringify([message, fields]));
      options.log?.(message, fields);
    },
  });
  return { ports, fake, cursor, grok, trees, scope, logs };
}

function launch(over: Partial<LaunchSessionInput> = {}): LaunchSessionInput {
  return {
    taskId,
    subtaskKey: 'login',
    runId: randomUUID(),
    stage: 'execute',
    route: {
      routeId: 'solo',
      poolId: 'claude-solo',
      modelId: 'opus-5.5',
      family: 'claude',
      hostId: 'claude-code',
    },
    whyRoute: '测试',
    queuedAt: NOW.toISOString(),
    brief: {
      title: '登录页加验证码',
      request: '加一个手机验证码',
      acceptance: ['能收到验证码'],
      touches: ['src'],
      feedback: [],
      answers: [],
      branch: BRANCH,
    },
    worktreePath: layout(join(root, 'work')).treeFor(repo, BRANCH),
    baseHead: m.head,
    stallSeconds: 360,
    sessionMinutes: 90,
    resources: { memoryHighMb: 1536, memoryMaxMb: 2048, swapMaxMb: 0 },
    launch: { fleetApi: 'http://127.0.0.1:8788', fleetToken: 'tok', pathPrepend: ['/opt/fleet/cli/bin'] },
    ...over,
  };
}

/** 会话干完活：提交一个文件、跑一次测试（插头报 test 事件）、fleet done（后端写 done 进度）。 */
const commitAndDone =
  (
    options: {
      dirty?: boolean;
      noCommit?: boolean;
      noDone?: boolean;
      cost?: number;
      contextTokens?: number;
    } = {},
  ) =>
  (): FakeRunScript => ({
    ...(options.cost === undefined ? {} : { result: { sessionCostUsd: options.cost } }),
    ...(options.contextTokens === undefined ? {} : { lastContextTokens: options.contextTokens }),
    act: async ({ spec, emit }) => {
      if (!options.noCommit) {
        mkdirSync(join(spec.cwd, 'src'), { recursive: true });
        writeFileSync(
          join(spec.cwd, 'src', `login-${randomUUID().slice(0, 4)}.ts`),
          'export const code = 1;\n',
        );
        // 只加这一个目录：Windows 上引擎这边的 git 检出时会换行尾，git add . 会把别的文件也带上。
        git(spec.cwd, 'add', '--', 'src');
        git(spec.cwd, 'commit', '-q', '-m', 'feat: 登录页加验证码');
      }
      if (options.dirty) writeFileSync(join(spec.cwd, 'README.md'), '# 改了没提交\n');
      emit('tool', { phase: 'start', toolUseId: 'u1', name: 'Bash', action: 'run', summary: 'pnpm check' });
      emit('test', { command: 'pnpm check', passed: true });
      emit('tool', {
        phase: 'end',
        toolUseId: 'u1',
        name: 'Bash',
        action: 'run',
        summary: 'pnpm check',
        ok: true,
      });
      if (!options.noDone) {
        await appendProgressEvents(t.db, spec.runId, [
          { at: new Date(), kind: 'done', payload: { summary: '做完了', testsPassed: true } },
        ]);
      }
    },
  });

async function runOnce(
  ports: ReturnType<typeof setup>['ports'],
  input: LaunchSessionInput,
): Promise<{ sessionId: string; end: SessionEnd }> {
  const started = await ports.startSession(input, ctx());
  const end = await ports.awaitSession(
    { taskId, runId: input.runId, sessionId: started.sessionId, stage: input.stage },
    ctx(),
  );
  return { sessionId: started.sessionId, end };
}

const runRow = async (id: string) => (await t.db.select().from(sessionRuns)).find((r) => r.id === id);

describe('写码会话', () => {
  it('从镜像建树、起新会话、交活（fleet done + 新提交）；进度写进库，开工和结局都记下', async () => {
    const { ports, fake, trees } = setup(commitAndDone());
    const input = launch();
    const started = await ports.startSession(input, ctx());
    expect(started).toMatchObject({ resumed: false, handle: { pid: 4242 } });
    // 树交给会话用户；会话自己的临时目录（它的 TMPDIR）在工作树根下的 _tmp/<runId>，不在工作树里，也归它
    const tmp = layout(join(root, 'work')).tmpFor(input.runId);
    expect(trees.adopts).toEqual([
      { dir: input.worktreePath, user: 'fleet-agent-carpool' },
      { dir: tmp, user: 'fleet-agent-carpool' },
    ]);
    const spec = fake.specs[0];
    expect(spec?.env.tmpDir).toBe(tmp);
    expect(existsSync(tmp)).toBe(true);
    expect(spec?.session).toEqual({ mode: 'new', id: started.sessionId });
    expect(spec?.cwd).toBe(input.worktreePath);
    expect(spec?.cgroup).toMatchObject({
      id: input.runId,
      user: 'fleet-agent-carpool',
      // 交换区上限 0 写「0」：帮手脚本和插头都不认「0M」（2026-09-26 法国第一次真起会话就卡在这）
      limits: { memoryHigh: '1536M', memoryMax: '2048M', memorySwapMax: '0' },
    });
    expect(spec?.model).toBe('claude-opus-5-5');
    expect(spec?.prompt).toContain('需求 #12');
    // 测试命令来自仓的流程配置副本：交代给会话、插头按它认「跑了测试」，也记进会话那一行（交活核对认这一条）
    expect(spec?.prompt).toContain('交活只认会话里原样跑的 `pnpm check`');
    expect(spec?.testCommands).toEqual(['pnpm check']);
    expect((await runRow(input.runId))?.testCommand).toBe('pnpm check');
    expect(fake.options[0]?.command).toEqual(['/opt/fake/fleet-agent-carpool/reclaude']);
    // 树是会话用户从镜像的 bundle 建的：分支在起会话前的头上；主线钉成 origin/main（pnpm test:changed 和它比）。
    expect(git(input.worktreePath as string, 'rev-parse', `${BRANCH}~1`)).toBe(m.head);
    expect(git(input.worktreePath as string, 'rev-parse', 'refs/remotes/origin/main')).toBe(m.head);

    const beat = ctx();
    const end = await ports.awaitSession(
      { taskId, runId: input.runId, sessionId: started.sessionId, stage: 'execute' },
      beat,
    );
    expect(end.outcome).toBe('done');
    // 看守交回之前，会话的临时目录已经删了
    expect(existsSync(tmp)).toBe(false);
    expect(end.output).toMatchObject({ kind: 'delivery', summary: '做完了', testsPassed: true });
    expect(end.output?.kind === 'delivery' && end.output.head).toBe(
      git(input.worktreePath as string, 'rev-parse', 'HEAD'),
    );
    expect(end.output?.kind === 'delivery' && end.output.changedFiles?.[0]).toMatch(/^src\/login-/);
    const row = await runRow(input.runId);
    expect(row).toMatchObject({
      sessionId: started.sessionId,
      outcome: 'ok',
      runAsUser: 'fleet-agent-carpool',
      routeOutcome: 'ok',
      costUsd: 0.5,
    });
    expect(row?.startedAt).not.toBeNull();
    const kinds = (await t.db.select().from(progressEvents)).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['tool', 'test', 'done']));
  });

  it('token 照终帧记进库，缓存读写单列（折额度当量要用，#216）', async () => {
    const { ports } = setup(() => ({
      ...commitAndDone()(),
      result: {
        usage: {
          inputTokens: 12,
          outputTokens: 340,
          cacheReadInputTokens: 51_200,
          cacheCreationInputTokens: 2_048,
        },
      },
    }));
    const input = launch();
    const { end } = await runOnce(ports, input);
    expect(end.usage).toEqual({
      inputTokens: 12,
      outputTokens: 340,
      cacheReadTokens: 51_200,
      cacheWriteTokens: 2_048,
    });
    expect(await runRow(input.runId)).toMatchObject({
      inputTokens: 12,
      outputTokens: 340,
      cacheReadTokens: 51_200,
      cacheWriteTokens: 2_048,
    });
  });

  it('终帧没报缓存读写（假插头默认只报输入输出）：库里留空，就是没读到，不记成 0', async () => {
    const { ports } = setup(commitAndDone());
    const input = launch();
    const { end } = await runOnce(ports, input);
    expect(end.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
    expect(await runRow(input.runId)).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    });
  });

  it('同一个 runId 起第二次：回同一个，不起第二个进程；叫停过的 runId 不再起', async () => {
    const { ports, fake } = setup(() => ({ act: async ({ signal }) => untilAborted(signal) }));
    const input = launch();
    const first = await ports.startSession(input, ctx());
    const again = await ports.startSession(input, ctx());
    expect(again.sessionId).toBe(first.sessionId);
    expect(fake.count()).toBe(1);
    await ports.stopSession({ taskId, runId: input.runId, mode: 'kill', reason: '叫停' }, ctx());
    const end = await ports.awaitSession(
      { taskId, runId: input.runId, sessionId: first.sessionId, stage: 'execute' },
      ctx(),
    );
    expect(end.outcome).toBe('stopped');
    expect((await t.db.select().from(sessionStops)).map((s) => s.runId)).toEqual([input.runId]);

    const stopped = launch();
    await ports.stopSession({ taskId, runId: stopped.runId, mode: 'kill', reason: '起之前就叫停' }, ctx());
    await expect(ports.startSession(stopped, ctx())).rejects.toMatchObject({ code: 'SESSION_STOPPED' });
    expect(fake.count()).toBe(1);
  });

  it('建树取包半截失败（仓建了、包是坏的）后同一个 runId 重试：照常取包、检出分支，不在空仓里起会话', async () => {
    let bundles = 0;
    const gh = {
      ...m.gh,
      async bundleCommits(input: Parameters<typeof m.gh.bundleCommits>[0]) {
        const made = await m.gh.bundleCommits(input);
        bundles += 1;
        if (bundles === 1) writeFileSync(made.path, '这不是 bundle\n');
        return made;
      },
    };
    const { ports, fake } = setup(commitAndDone(), { gh });
    const input = launch();
    const dir = input.worktreePath as string;
    await expect(ports.startSession(input, ctx())).rejects.toMatchObject({
      code: 'GIT_FAILED',
      retryable: true,
    });
    expect(fake.count()).toBe(0);
    // 留下的是个空仓：.git 在，HEAD 解析不出来
    expect(git(dir, 'rev-parse', '--git-dir')).toBe('.git');
    expect(() => git(dir, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}')).toThrow();
    // 活动重试：同一个 runId 再来
    const started = await ports.startSession(input, ctx());
    expect(fake.count()).toBe(1);
    expect(bundles).toBe(2);
    const end = await ports.awaitSession(
      { taskId, runId: input.runId, sessionId: started.sessionId, stage: 'execute' },
      ctx(),
    );
    expect(end.outcome).toBe('done');
    // 会话是在检出好的分支上干的：分支在起会话前的头（baseHead）上，会话的提交接在它后面
    expect(git(dir, 'symbolic-ref', '--short', 'HEAD')).toBe(BRANCH);
    expect(git(dir, 'rev-parse', `${BRANCH}~1`)).toBe(m.head);
  });

  it('没用 fleet done 交活、有没提交的已跟踪改动、没有新提交：都判没交付，不当成做完', async () => {
    for (const [options, words] of [
      [{ noDone: true }, '没用 fleet done'],
      [{ dirty: true }, '没提交的已跟踪改动'],
      [{ noCommit: true }, '没有新提交'],
    ] as const) {
      const { ports } = setup(commitAndDone(options));
      const { end } = await runOnce(
        ports,
        launch({ worktreePath: layout(join(root, `w-${randomUUID()}`)).treeFor(repo, BRANCH) }),
      );
      expect(end.outcome).toBe('failed');
      expect(end.failure?.code).toBe('not_delivered');
      expect(end.failure?.message).toContain(words);
    }
  });

  // #293：会话在树里并过主线，交活的改动清单要扣掉并进来的主线（user-git.ts 的 ownSpan）。原来按 git diff base HEAD 算，
  // 主线上别人改的页面代码也算成这张单改的，开 PR 前验证按界面类派、没人可派。
  describe('会话并了主线（#293）', () => {
    const UI = 'deploy/web/health/health.js';
    /** 主线上别人又改了页面代码。 */
    function mainlineChangesUi(): string {
      mkdirSync(join(m.dir, 'deploy', 'web', 'health'), { recursive: true });
      writeFileSync(join(m.dir, UI), 'export const h = 2;\n');
      git(m.dir, 'add', '--', UI);
      git(m.dir, 'commit', '-q', '-m', 'main: 健康页');
      return git(m.dir, 'rev-parse', 'HEAD');
    }
    /**
     * 会话在树里并主线：新主线由引擎推之前取进树里、钉成 origin/main（github-ports 的 pushBranch，这里照做一遍），会话照着
     * git merge 它；own 为真再提交一个自己改的文件。都跑了测试、fleet done。
     */
    const mergesMainline =
      (options: { own?: boolean } = {}) =>
      (): FakeRunScript => ({
        act: async ({ spec, emit }) => {
          git(spec.cwd, 'fetch', '-q', m.dir, '+refs/heads/main:refs/remotes/origin/main');
          git(spec.cwd, 'merge', '--no-ff', '--no-edit', '-q', 'origin/main');
          if (options.own) {
            mkdirSync(join(spec.cwd, 'src'), { recursive: true });
            writeFileSync(join(spec.cwd, 'src', 'login-own.ts'), 'export const code = 1;\n');
            git(spec.cwd, 'add', '--', 'src');
            git(spec.cwd, 'commit', '-q', '-m', 'feat: 登录页加验证码');
          }
          emit('tool', {
            phase: 'start',
            toolUseId: 'u1',
            name: 'Bash',
            action: 'run',
            summary: 'pnpm check',
          });
          emit('test', { command: 'pnpm check', passed: true });
          emit('tool', {
            phase: 'end',
            toolUseId: 'u1',
            name: 'Bash',
            action: 'run',
            summary: 'pnpm check',
            ok: true,
          });
          await appendProgressEvents(t.db, spec.runId, [
            { at: new Date(), kind: 'done', payload: { summary: '做完了', testsPassed: true } },
          ]);
        },
      });

    it('【故意造出的失败】并了改过页面代码的主线、又改了自己的：交回的改动只有自己改的，主线的页面代码不算', async () => {
      mainlineChangesUi();
      const { ports } = setup(mergesMainline({ own: true }));
      const input = launch();
      const { end } = await runOnce(ports, input);
      expect(end.outcome).toBe('done');
      // 原来的算法（git diff base HEAD）会是 [页面代码, 自己的]
      expect(git(input.worktreePath as string, 'diff', '--name-only', m.head, 'HEAD').split('\n')).toContain(
        UI,
      );
      expect(end.output?.kind === 'delivery' && end.output.changedFiles).toEqual(['src/login-own.ts']);
    });

    it('【故意造出的失败】只并了主线、自己没写东西：判没交付，不当成交了主线上别人的活', async () => {
      mainlineChangesUi();
      const { ports } = setup(mergesMainline());
      const { end } = await runOnce(ports, launch());
      expect(end.outcome).toBe('failed');
      expect(end.failure?.code).toBe('not_delivered');
      expect(end.failure?.message).toContain('除了并进来的主线');
    });

    it('钉主线之前建的老树接着用：起会话前把主线钉到起会话前的头，交活照常核（不因为树里没钉判不了）', async () => {
      const { ports } = setup(commitAndDone());
      const input = launch();
      const dir = input.worktreePath as string;
      await runOnce(ports, input);
      const first = git(dir, 'rev-parse', 'HEAD');
      // 老树：#218 之前建的，树里没有 origin/main
      git(dir, 'update-ref', '-d', 'refs/remotes/origin/main');
      const { end } = await runOnce(ports, launch({ baseHead: first }));
      expect(git(dir, 'rev-parse', 'refs/remotes/origin/main')).toBe(first);
      expect(end.outcome).toBe('done');
      const files = end.output?.kind === 'delivery' ? (end.output.changedFiles ?? []) : [];
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^src\/login-/);
    });
  });

  it('会话说卡住了（fleet blocked）：结局 blocked，带原因', async () => {
    const { ports } = setup(() => ({
      act: async ({ spec }) => {
        await appendProgressEvents(t.db, spec.runId, [
          { at: new Date(), kind: 'blocked', payload: { reason: '缺测试账号', needs: 'access' } },
        ]);
      },
    }));
    const { end } = await runOnce(ports, launch());
    expect(end).toMatchObject({ outcome: 'blocked', blocked: { reason: '缺测试账号', needs: 'access' } });
  });
});

describe('会话断了接着干', () => {
  it('同一个会话用户：--resume 续上；这一轮的花费按上一轮的累计求差', async () => {
    const { ports, fake } = setup((_, n) => commitAndDone({ cost: n === 1 ? 0.5 : 0.8 })());
    const first = await runOnce(ports, launch());
    const input = launch({
      resumeSessionId: first.sessionId,
      baseHead: first.end.output?.kind === 'delivery' ? first.end.output.head : m.head,
    });
    const second = await runOnce(ports, input);
    expect(fake.specs[1]?.session).toEqual({ mode: 'resume', id: first.sessionId });
    expect(second.sessionId).toBe(first.sessionId);
    expect(fake.specs[1]?.prompt.startsWith('接着干')).toBe(true);
    expect((await runRow(input.runId))?.costUsd).toBeCloseTo(0.3);
  });

  it('续会话按上一轮的上下文多等第一帧；上一个会话没提交就断了：续上的提示词写明先读 git diff 接着做', async () => {
    // 第一轮：上下文 20 万 token，改了 README 没提交、没交活就断了（发布停机、被杀这一类）
    const { ports, fake } = setup((_, n) =>
      n === 1
        ? commitAndDone({ noCommit: true, noDone: true, dirty: true, contextTokens: 200_000 })()
        : commitAndDone()(),
    );
    const first = await runOnce(ports, launch());
    expect(first.end.outcome).toBe('failed');
    expect(fake.specs[0]?.limits?.startupMs).toBeUndefined();
    expect(fake.specs[0]?.prompt).not.toContain('没提交的改动');
    await runOnce(ports, launch({ resumeSessionId: first.sessionId }));
    // 20 万 token ÷ 每分钟 4 万 = 多等 5 分钟
    expect(fake.specs[1]?.limits?.startupMs).toBe(180_000 + 5 * 60_000);
    expect(fake.specs[1]?.prompt).toContain('工作树里有上一个会话没提交的改动（1 个文件');
    expect(fake.specs[1]?.prompt).toContain('README.md');
  });

  it('换了账号池（切号后原会话绑在旧组织上）、上一轮上下文还小：同一个会话用户 --fork-session 续，不改属主、不拷记录', async () => {
    const { ports, fake, trees } = setup((_, n) => commitAndDone(n === 1 ? { contextTokens: 5_000 } : {})());
    const carpool = {
      routeId: 'carpool',
      poolId: 'claude-carpool',
      modelId: 'opus-5.5',
      family: 'claude',
      hostId: 'claude-code' as const,
    };
    const first = await runOnce(ports, launch({ route: carpool }));
    const input = launch({ resumeSessionId: first.sessionId });
    const started = await ports.startSession(input, ctx());
    // 树第一次起会话时交给了会话用户，之后还是它：不再改属主（每个会话自己的临时目录另算）
    expect(trees.treeAdopts()).toEqual([{ dir: input.worktreePath, user: 'fleet-agent-carpool' }]);
    expect(fake.specs[1]?.session).toEqual({ mode: 'fork', from: first.sessionId, id: started.sessionId });
    expect(fake.specs[1]?.cgroup?.user).toBe('fleet-agent-carpool');
    expect(started.resumed).toBe(true);
    expect(started.sessionId).not.toBe(first.sessionId);
    await ports.awaitSession(
      { taskId, runId: input.runId, sessionId: started.sessionId, stage: 'execute' },
      ctx(),
    );
    // fork 出来的会话不知道累计花费从哪算起：不记这一轮的花费。
    expect((await runRow(input.runId))?.costUsd).toBeNull();
  });

  it('换了账号池、上一轮上下文大了：开新会话，带接力任务书（已提交的不重做）', async () => {
    const { ports, fake } = setup((_, n) => commitAndDone(n === 1 ? { contextTokens: 200_000 } : {})());
    const carpool = {
      routeId: 'carpool',
      poolId: 'claude-carpool',
      modelId: 'opus-5.5',
      family: 'claude',
      hostId: 'claude-code' as const,
    };
    const first = await runOnce(ports, launch({ route: carpool }));
    await runOnce(ports, launch({ resumeSessionId: first.sessionId }));
    const spec = fake.specs[1];
    expect(spec?.session.mode).toBe('new');
    expect(spec?.prompt).toContain('接力');
    expect(spec?.prompt).toContain('feat: 登录页加验证码');
    expect(spec?.prompt).toContain('大了不 fork');
  });

  it('上一轮跑在已停用的会话用户下（过程记录在已删的家目录里）：同一个池也不硬续，开新会话带接力任务书', async () => {
    const { ports, fake } = setup((_, n) => commitAndDone(n === 1 ? { contextTokens: 5_000 } : {})());
    const first = await runOnce(ports, launch());
    await t.client.query(
      `update session_runs set run_as_user = 'fleet-agent-dedicated' where session_id = $1`,
      [first.sessionId],
    );
    await runOnce(ports, launch({ resumeSessionId: first.sessionId }));
    expect(fake.specs[1]?.session.mode).toBe('new');
    expect(fake.specs[1]?.prompt).toContain('接力');
    expect(fake.specs[1]?.prompt).toContain('不是现在的会话用户');
  });
});

describe('切号那一刻在跑的会话（#59）', () => {
  const CARPOOL = {
    routeId: 'carpool',
    poolId: 'claude-carpool',
    modelId: 'opus-5.5',
    family: 'claude',
    hostId: 'claude-code' as const,
  };
  const WHY = '切号：会话用户从拼车组织切到独享组织，先停下，切完接着干';

  it('停下跑在这些池上、进程起来了的会话：交回 org_switch（可重试，不算路由的失败）；别的池上的不碰；已经在停的不重复叫停', async () => {
    const { ports } = setup(() => ({
      act: async ({ signal }) => untilAborted(signal),
      lastContextTokens: 5_000,
    }));
    const onCarpool = launch({ route: CARPOOL });
    const onSolo = launch({ subtaskKey: 'other', brief: { ...launch().brief, branch: 'fleet/12-other' } });
    const a = await ports.startSession(onCarpool, ctx());
    const b = await ports.startSession(onSolo, ctx());
    const carpool = new Set(['claude-carpool']);
    expect(ports.orgSwitch.live(carpool)).toEqual([onCarpool.runId]);
    expect(ports.orgSwitch.stop(carpool, WHY)).toEqual([onCarpool.runId]);
    expect(ports.orgSwitch.stop(carpool, WHY)).toEqual([]);
    const end = await ports.awaitSession(
      { taskId, runId: onCarpool.runId, sessionId: a.sessionId, stage: 'execute' },
      ctx(),
    );
    expect(end).toMatchObject({
      outcome: 'failed',
      sessionId: a.sessionId,
      failure: { code: 'org_switch', message: WHY, retryable: true, machine: '法国' },
    });
    // 收场了：不在手上了
    expect(ports.orgSwitch.live(carpool)).toEqual([]);
    expect(await runRow(onCarpool.runId)).toMatchObject({
      outcome: 'failed',
      failureCode: 'org_switch',
      routeOutcome: 'neutral',
      contextTokens: 5_000,
    });
    // 切号不记叫停（叫停记录会让同一个 runId 起不来）：续的是新的 runId
    expect((await t.db.select().from(sessionStops)).map((s) => s.runId)).toEqual([]);
    // 独享池上的那个照跑
    expect(ports.orgSwitch.live(new Set(['claude-solo']))).toEqual([onSolo.runId]);
    await ports.stopSession({ taskId, runId: onSolo.runId, mode: 'kill', reason: '收尾' }, ctx());
    await ports.awaitSession(
      { taskId, runId: onSolo.runId, sessionId: b.sessionId, stage: 'execute' },
      ctx(),
    );
  });

  it('切号停下的会话接着干：换了池 fork 续上，提示词里写着上一次为什么停；怎么续的进操作记录', async () => {
    const { ports, fake } = setup((_, n) =>
      n === 1
        ? { act: async ({ signal }) => untilAborted(signal), lastContextTokens: 5_000 }
        : commitAndDone()(),
    );
    const first = launch({ route: CARPOOL });
    const a = await ports.startSession(first, ctx());
    ports.orgSwitch.stop(new Set(['claude-carpool']), WHY);
    await ports.awaitSession({ taskId, runId: first.runId, sessionId: a.sessionId, stage: 'execute' }, ctx());
    const next = launch({ resumeSessionId: a.sessionId });
    const again = await runOnce(ports, next);
    expect(fake.specs[1]?.session).toEqual({ mode: 'fork', from: a.sessionId, id: again.sessionId });
    expect(fake.specs[1]?.prompt).toContain(WHY);
    expect(again.end.outcome).toBe('done');
    const audits = (await t.db.select().from(auditLog)).filter((r) => r.action === 'session-org.resume');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorKind: 'engine',
      target: `session-run:${next.runId}`,
      before: { runId: first.runId, routeId: 'carpool' },
      after: { routeId: 'solo', poolId: 'claude-solo', mode: 'fork' },
      ok: true,
    });
    expect(audits[0]?.reason).toContain('fork 续上');
  });

  it('不是切号停下的会话接着干：不记这一条', async () => {
    const { ports } = setup(() => commitAndDone()());
    const first = await runOnce(ports, launch());
    await runOnce(ports, launch({ resumeSessionId: first.sessionId }));
    expect((await t.db.select().from(auditLog)).filter((r) => r.action === 'session-org.resume')).toEqual([]);
  });
});

describe('分诊、需求文档、方案、审查：读结论文件', () => {
  const triage = (text: string | null): FakeRunScript => ({
    act: ({ spec }) => {
      if (text === null) return;
      mkdirSync(join(spec.cwd, '.fleet-out'), { recursive: true });
      writeFileSync(join(spec.cwd, '.fleet-out', 'triage.json'), text);
    },
  });
  const triageLaunch = () => {
    // 分诊是需求自己的会话：没有子任务、没有工作树、没有起会话前的头。
    const { subtaskKey: _k, worktreePath: _w, baseHead: _b, ...rest } = launch({ stage: 'triage' });
    return rest;
  };

  it('检出副本从主线建；写对了就交回分诊结论', async () => {
    const { ports, fake } = setup(() =>
      triage('{"clear": true, "summary": "理解为：加验证码", "size": "S"}'),
    );
    const { end } = await runOnce(ports, triageLaunch());
    expect(end).toMatchObject({
      outcome: 'done',
      output: { kind: 'triage', verdict: { clear: true, size: 'S' } },
    });
    const dir = fake.specs[0]?.cwd as string;
    expect(dir).toBe(layout(join(root, 'work')).scratchFor(repo, 12, 'triage'));
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(m.head);
    expect(git(dir, 'rev-parse', 'refs/remotes/origin/main')).toBe(m.head);
  });

  it('审查：检出 PR 的头；主线另取进来钉成 origin/main，git diff origin/main...HEAD 只列 PR 自己的改动', async () => {
    // PR 从主线分出去多一个提交；之后主线又进了一个提交（不在 PR 的历史里，得另取进树）
    git(m.dir, 'checkout', '-q', '-b', 'pr');
    writeFileSync(join(m.dir, 'pr.ts'), 'export const pr = 1;\n');
    git(m.dir, 'add', '.');
    git(m.dir, 'commit', '-q', '-m', 'pr');
    const prHead = git(m.dir, 'rev-parse', 'HEAD');
    git(m.dir, 'checkout', '-q', 'main');
    writeFileSync(join(m.dir, 'later.ts'), 'export const later = 1;\n');
    git(m.dir, 'add', '.');
    git(m.dir, 'commit', '-q', '-m', 'main moved');
    const mainHead = git(m.dir, 'rev-parse', 'HEAD');
    const { ports, fake } = setup(() => ({
      act: ({ spec }) => {
        mkdirSync(join(spec.cwd, '.fleet-out'), { recursive: true });
        writeFileSync(join(spec.cwd, '.fleet-out', 'review.json'), '{"verdict": "pass", "findings": []}');
      },
    }));
    const base = launch({ stage: 'review' });
    const { worktreePath: _w, baseHead: _b, ...rest } = base;
    const { end } = await runOnce(ports, { ...rest, brief: { ...base.brief, prNumber: 101, head: prHead } });
    expect(end).toMatchObject({
      outcome: 'done',
      output: { kind: 'review', review: { verdict: 'pass', head: prHead } },
    });
    const dir = fake.specs[0]?.cwd as string;
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(prHead);
    expect(git(dir, 'rev-parse', 'refs/remotes/origin/main')).toBe(mainHead);
    expect(git(dir, 'diff', '--name-only', 'origin/main...HEAD')).toBe('pr.ts');
  });

  it('没写结论文件、写的不是 JSON、说不清却没写要问的：都判交错了（wrong_output）', async () => {
    for (const text of [null, '不是 JSON', '{"clear": false}']) {
      const { ports } = setup(() => triage(text));
      const { end } = await runOnce(ports, triageLaunch());
      expect(end.outcome).toBe('failed');
      expect(end.failure?.code).toBe('wrong_output');
    }
  });

  it('需求文档：「对应计划：」那一行对得上检出副本里的 plan.md 才收；没有这一行、对不上都判交错了（开 PR 要照它填）', async () => {
    const doc = (text: string, plan?: string): FakeRunScript => ({
      act: ({ spec }) => {
        mkdirSync(join(spec.cwd, '.fleet-out'), { recursive: true });
        writeFileSync(join(spec.cwd, '.fleet-out', 'doc.md'), text);
        if (plan !== undefined) {
          mkdirSync(join(spec.cwd, 'docs'), { recursive: true });
          writeFileSync(join(spec.cwd, 'docs', 'plan.md'), plan);
        }
      },
    });
    const specLaunch = () => {
      const { subtaskKey: _k, worktreePath: _w, baseHead: _b, ...rest } = launch({ stage: 'spec' });
      return rest;
    };
    const plan = '# 计划\n\n### P1 核心闭环\n\n- 工作流：需求、子任务。\n';
    const good = '# 登录页加验证码\n\n对应计划：plan.md P1「工作流」\n\n要验证码';
    const ok = setup(() => doc(good, plan));
    expect((await runOnce(ok.ports, specLaunch())).end).toMatchObject({
      outcome: 'done',
      output: { kind: 'doc', markdown: good },
    });
    for (const [text, withPlan, why] of [
      ['# 登录页加验证码\n\n要验证码', plan, '没有「对应计划：」那一行'],
      ['# 登录页加验证码\n\n对应计划：plan.md P1「没有这一条」\n', plan, '找不到'],
      // 仓里没有 plan.md：不许瞎凑一条
      [good, undefined, '仓里没有'],
    ] as const) {
      const bad = setup(() => doc(text, withPlan));
      const { end } = await runOnce(bad.ports, specLaunch());
      expect(end.outcome).toBe('failed');
      expect(end.failure).toMatchObject({ code: 'wrong_output', message: expect.stringContaining(why) });
    }
  });
});

describe('开 PR 前验证：检出送检的头，发出去的材料先过卫生检查，读结论文件', () => {
  const CRITERIA = ['过期的验证码登录不了', '有一条故意造出失败的测试'];
  /** 装成真密钥的值（运行时拼，源码里不出现整段，全仓卫生检查不会拦这个文件自己）。 */
  const LEAK = ['ghp', 'q7Rz2LmX9vKp4TnB8wYc1HdF6jGs3NaEw5Yu'].join('_');
  const verifyLaunch = (head: string, criteria: string[] = CRITERIA): LaunchSessionInput => {
    const base = launch({ stage: 'verify' });
    const { worktreePath: _w, baseHead: _b, ...rest } = base;
    return {
      ...rest,
      brief: {
        ...base.brief,
        head,
        verify: {
          criteria,
          specPath: 'specs/12-login/需求.md',
          planSummary: '登录表单加验证码输入，后端校验五分钟过期',
          changedFiles: ['a.ts'],
        },
      },
    };
  };
  const writes = (text: string | null): FakeRunScript => ({
    act: ({ spec }) => {
      if (text === null) return;
      mkdirSync(join(spec.cwd, '.fleet-out'), { recursive: true });
      writeFileSync(join(spec.cwd, '.fleet-out', 'verify.json'), text);
    },
  });
  const report = (head: string) => ({
    head,
    results: CRITERIA.map((criterion) => ({ criterion, answer: 'done', evidence: '看过 a.ts' })),
    findings: [],
  });
  const checked = (what: string, texts: { path: string; text: string }[]) => assertPublishable(what, texts);
  const caught = (fn: () => void): unknown => {
    try {
      fn();
    } catch (error) {
      return error;
    }
    return undefined;
  };

  it('检出送检的头；这次真要发的整份提示词先过卫生检查；写对了交回结论', async () => {
    const screened: { what: string; texts: { path: string; text: string }[] }[] = [];
    const { ports, fake } = setup(() => writes(JSON.stringify(report(m.head))), {
      screen: (what, texts) => {
        screened.push({ what, texts });
        checked(what, texts);
      },
    });
    const { end } = await runOnce(ports, verifyLaunch(m.head));
    expect(end).toMatchObject({ outcome: 'done', output: { kind: 'verify', report: report(m.head) } });
    const sent = fake.specs[0];
    expect(screened).toEqual([
      { what: '发给别家的验证材料', texts: [{ path: '验证提示词', text: sent?.prompt }] },
    ]);
    expect(sent?.prompt).toContain('1. 过期的验证码登录不了');
    expect(sent?.prompt).toContain('specs/12-login/需求.md');
    expect(git(sent?.cwd as string, 'rev-parse', 'HEAD')).toBe(m.head);
  });

  it('【故意造出的失败】材料里有真密钥：不发、不起会话，报 MATERIAL_BLOCKED，报错里只有位置和规则、没有那个值', async () => {
    const { ports, fake } = setup(() => writes(JSON.stringify(report(m.head))), { screen: checked });
    const input = verifyLaunch(m.head, [`别把 ${LEAK} 写进日志`]);
    const error = await ports.startSession(input, ctx()).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'MATERIAL_BLOCKED', retryable: false });
    const message = String((error as Error).message);
    expect(message).toContain('没过卫生检查，没发给Claude Code：查出 1 处（验证提示词 第');
    expect(message).toContain('token');
    expect(message).not.toContain(LEAK);
    expect(fake.specs).toEqual([]);
    expect((await runRow(input.runId))?.startedAt).toBeNull();
  });

  it('【故意造出的失败】会话端口没配卫生检查：发不出去（HYGIENE_UNSCANNED），不当成查过了', async () => {
    const { ports, fake } = setup(() => writes(JSON.stringify(report(m.head))));
    const error = await ports.startSession(verifyLaunch(m.head), ctx()).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'HYGIENE_UNSCANNED', retryable: false });
    expect(fake.specs).toEqual([]);
  });

  it('【故意造出的失败】检查自己出错：原样报 HYGIENE_UNSCANNED、算没扫成，不发', () => {
    const broken = caught(() =>
      screenForOtherVendor(
        () => {
          throw new Error('扫描器坏了');
        },
        '提示词',
        'Cursor Agent',
      ),
    );
    expect(broken).toMatchObject({ code: 'HYGIENE_UNSCANNED', retryable: false });
    expect(String((broken as Error).message)).toContain('没扫成，不发给Cursor Agent');
  });

  it('#246：结论文件里 criterion 只差反引号 → 会话端口认得（挡这一道的是 core 的 checkReport），交回的是清单原文', async () => {
    const ticked = [
      '`packages/engine/src/jobs/alert-sweep.ts` 加一条规则：读不了记这一轮没查全，不撤。',
      ...CRITERIA,
    ];
    const answer = (criterion: string) => ({ criterion, answer: 'done', evidence: '看过 a.ts' });
    const written = { head: m.head, results: ticked.map((c) => answer(c.replaceAll('`', ''))), findings: [] };
    const { ports } = setup(() => writes(JSON.stringify(written)), { screen: checked });
    const { end } = await runOnce(ports, verifyLaunch(m.head, ticked));
    expect(end).toMatchObject({
      outcome: 'done',
      output: { kind: 'verify', report: { head: m.head, results: ticked.map(answer), findings: [] } },
    });
  });

  it('【故意造出的失败】没写结论、写的不是 JSON、审的不是送检的头、漏答一条、答了清单外的（字不一样，不只差格式）：都判交错了（wrong_output），写明哪里不对', async () => {
    const other = 'f'.repeat(40);
    const good = report(m.head);
    for (const [text, why] of [
      [null, '没写结论 .fleet-out/verify.json'],
      ['不是 JSON', '不是合法的 JSON'],
      [JSON.stringify(report(other)), `审的不是送检的头：送的是 ${m.head}，审的是 ${other}`],
      [JSON.stringify({ ...good, results: good.results.slice(0, 1) }), '没答：「有一条故意造出失败的测试」'],
      [
        JSON.stringify({
          ...good,
          results: [
            ...good.results.slice(0, 1),
            { criterion: '有两条故意造出失败的测试', answer: 'done', evidence: '看过 a.ts' },
          ],
        }),
        '答了清单外的一条：「有两条故意造出失败的测试」',
      ],
    ] as const) {
      const { ports } = setup(() => writes(text), { screen: checked });
      const { end } = await runOnce(ports, verifyLaunch(m.head));
      expect(end.outcome).toBe('failed');
      expect(end.failure).toMatchObject({ code: 'wrong_output', message: expect.stringContaining(why) });
    }
  });
});

describe('失败', () => {
  it('额度用满：带上游给的清零时刻交给失败分流；额度读数顺手记账', async () => {
    const resetsAt = new Date(NOW.getTime() + 3 * 3600_000).toISOString();
    const { ports } = setup(() => ({
      result: { isError: true, terminalReason: 'api_error', text: 'usage limit reached' },
      exitCode: 1,
      act: ({ rateLimit }) => {
        rateLimit({
          status: 'rejected',
          exhausted: true,
          rateLimitType: 'five_hour',
          resetsAt,
          windows: [{ name: 'five_hour', utilization: 1, resetsAt }],
          observedAt: NOW.toISOString(),
        });
      },
    }));
    const { end } = await runOnce(ports, launch());
    expect(end).toMatchObject({
      outcome: 'failed',
      failure: { code: 'quota_exhausted', resetsAt, machine: '法国', runAsUser: 'fleet-agent-carpool' },
    });
    const windows = (await t.db.select().from(quotaWindows)).filter(
      (w) => w.poolId === 'claude-solo' && w.label === 'five_hour',
    );
    expect(windows[0]?.upstreamStatus).toBe('limit_reached');
  });

  it('设备被撤销：原样交给失败分流；整池暂停（要人拍，写清哪台机器、哪个会话用户），下一次跑通就撤掉', async () => {
    const { ports } = setup((_, n) =>
      n === 1
        ? {
            result: {
              isError: true,
              terminalReason: 'api_error',
              apiErrorStatus: 401,
              text: 'device_revoked',
            },
            apiError: { code: 'device_revoked', text: '401 device_revoked' },
            exitCode: 1,
          }
        : commitAndDone()(),
    );
    const firstInput = launch();
    const first = await runOnce(ports, firstInput);
    expect(first.end.outcome).toBe('failed');
    expect(first.end.failure?.code).toBe('agent_error');
    expect(first.end.failure?.message).toContain('device_revoked');
    const hold = (await t.db.select().from(notifications)).find(
      (n) => n.dedupeKey === poolHoldKey('claude-solo'),
    );
    expect(hold).toMatchObject({ level: 'decision', resolvedAt: null });
    expect(hold?.body).toContain('法国');
    expect(hold?.body).toContain('fleet-agent-carpool');
    expect(hold?.body).toContain('reclaude login');
    // 账号池的事不算这条路由的账（不喂熔断）。
    expect((await runRow(firstInput.runId))?.routeOutcome).toBe('neutral');

    await runOnce(ports, launch({ resumeSessionId: first.sessionId }));
    const after = (await t.db.select().from(notifications)).find(
      (n) => n.dedupeKey === poolHoldKey('claude-solo'),
    );
    expect(after?.resolvedAt).not.toBeNull();
    expect(after?.resolvedBy).toBe('engine');
  });

  it('封号：同样整池暂停；已经暂停着的不重复开', async () => {
    await upsertAlert(t.db, {
      dedupeKey: 'unrelated',
      level: 'alert',
      taskId: null,
      title: 'x',
      body: '',
    });
    const { ports } = setup(() => ({
      result: { isError: true, terminalReason: 'api_error', text: 'account_banned：当前绑定账号暂不可用' },
      exitCode: 1,
    }));
    await runOnce(ports, launch());
    await runOnce(ports, launch());
    const holds = (await t.db.select().from(notifications)).filter(
      (n) => n.dedupeKey === poolHoldKey('claude-solo'),
    );
    expect(holds).toHaveLength(1);
  });

  it('按进展判停滞：同一个动作反复做、半天没推进（绕圈），停掉，结局 stalled', async () => {
    const { ports } = setup(() => ({
      act: async ({ emit, signal }) => {
        for (let i = 0; i < 4; i++) {
          emit('tool', {
            phase: 'start',
            toolUseId: `u${i}`,
            name: 'Bash',
            action: 'run',
            summary: 'pnpm test',
          });
          emit('tool', {
            phase: 'end',
            toolUseId: `u${i}`,
            name: 'Bash',
            action: 'run',
            summary: 'pnpm test',
            ok: false,
          });
        }
        await Promise.race([untilAborted(signal), new Promise((r) => setTimeout(r, 10_000))]);
      },
    }));
    const { end } = await runOnce(ports, launch());
    expect(end.outcome).toBe('stalled');
    expect(end.failure?.message).toMatch(/^L1：/);
  });

  it('接不上（工人重启过）：按记下的 scope 收掉旧会话，回 SESSION_LOST；库里这一行记上结局', async () => {
    const { ports } = setup(() => ({ act: async ({ signal }) => untilAborted(signal) }));
    const input = launch();
    const started = await ports.startSession(input, ctx());
    // 新的工人进程：看不到上一个进程起的会话。
    const { ports: restarted } = setup(() => ({}));
    const end = await restarted.awaitSession(
      {
        taskId,
        runId: input.runId,
        sessionId: started.sessionId,
        stage: 'execute',
        ...(started.handle ? { handle: started.handle } : {}),
      },
      ctx(),
    );
    expect(end).toMatchObject({ outcome: 'failed', failure: { code: 'SESSION_LOST', retryable: true } });
    expect(end.failure?.message).toContain('接不上会话');
    expect(await getSessionRun(t.db, input.runId)).toMatchObject({
      outcome: 'failed',
      failureCode: 'SESSION_LOST',
    });
    await ports.stopSession({ taskId, runId: input.runId, mode: 'kill', reason: '收尾' }, ctx());
  });

  it('进程起不来：明确报 SPAWN_FAILED（不可重试：原因原样交工作流），库里这一行记上结局', async () => {
    const { ports, fake } = setup(() => ({ spawnError: 'spawn /opt/fake/reclaude ENOENT' }));
    const input = launch();
    await expect(ports.startSession(input, ctx())).rejects.toMatchObject({
      code: 'SPAWN_FAILED',
      retryable: false,
      message: expect.stringContaining('ENOENT'),
    });
    expect(await getSessionRun(t.db, input.runId)).toMatchObject({
      outcome: 'failed',
      failureCode: 'SPAWN_FAILED',
    });
    // 同一个 runId 再起一次（活动原地重试就是这样）：库里已经记了结局，明确报已经结束过、不再起进程——
    // 所以 SPAWN_FAILED 不能标可重试，不然真原因被这一句盖掉；换新 runId 重起是工作流的事
    await expect(ports.startSession(input, ctx())).rejects.toMatchObject({
      code: 'SESSION_ENDED',
      retryable: false,
    });
    expect(fake.specs).toHaveLength(1);
  });

  it('进程起来了、库里却没这一行（开工记不上）：停掉会话、收掉 scope，明确报 SESSION_RECORD_MISSING，不当成起好了', async () => {
    const { ports, fake, scope } = setup(() => ({
      // 起来之前这一行没了（被删、库回滚……）：进程号和 scope 记不下，工人重启后就收不掉它
      beforeSpawn: async () => {
        await t.db.delete(sessionRuns);
      },
      act: async ({ signal }) => untilAborted(signal),
    }));
    const input = launch();
    const err = await ports.startSession(input, ctx()).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'SESSION_RECORD_MISSING', retryable: false });
    expect((err as Error).message).toContain('已经停掉');
    // 插头被叫停、scope 按编号收了：不留一个库里查不到的会话在跑
    expect(fake.options[0]?.signal?.aborted).toBe(true);
    expect(scope.calls().some((c) => c.action === 'stop' && c.args.includes(input.runId))).toBe(true);
    expect(fake.count()).toBe(1);
  });

  it('进程起来了、开工写库时库报错：一样停掉会话、收掉 scope，报 SESSION_RECORD_FAILED（可重试），不留孤儿', async () => {
    // 只拦「记开工」那一句（它改 handle）：库连不上、写超时之类
    await t.client.exec(`
      create function sessions_test_refuse() returns trigger language plpgsql as $$
      begin raise exception 'sessions_test_refuse'; end $$;
      create trigger sessions_test_refuse before update of handle on session_runs
        for each row execute function sessions_test_refuse();
    `);
    try {
      const { ports, fake, scope } = setup(() => ({ act: async ({ signal }) => untilAborted(signal) }));
      const input = launch();
      const err = await ports.startSession(input, ctx()).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'SESSION_RECORD_FAILED', retryable: true });
      expect((err as Error).message).toContain('已经停掉');
      expect(fake.options[0]?.signal?.aborted).toBe(true);
      expect(scope.calls().some((c) => c.action === 'stop' && c.args.includes(input.runId))).toBe(true);
      // 库里这一行还是没记开工的样子：重试照常从头起，不会被当成「上一个工人起过」
      expect((await getSessionRun(t.db, input.runId))?.startedAt ?? null).toBeNull();
    } finally {
      await t.client.exec(
        'drop trigger sessions_test_refuse on session_runs; drop function sessions_test_refuse();',
      );
    }
  });

  it('进程迟迟起不来：到点明确报 SPAWN_TIMEOUT（不可重试），叫停它，库里这一行记上结局', async () => {
    const { ports } = setup(() => ({ hangBeforeSpawn: true }), { spawnTimeoutMs: 200 });
    const input = launch();
    await expect(ports.startSession(input, ctx())).rejects.toMatchObject({
      code: 'SPAWN_TIMEOUT',
      retryable: false,
    });
    expect(await getSessionRun(t.db, input.runId)).toMatchObject({
      outcome: 'failed',
      failureCode: 'SPAWN_TIMEOUT',
    });
  });

  it('路由的执行方式没接上、账号池没定会话用户、任务不在：起之前明确拒', async () => {
    const { ports, fake } = setup(() => ({}));
    await expect(
      ports.startSession(
        launch({
          route: {
            routeId: 'luna',
            poolId: 'relay',
            modelId: 'gpt-5.6-luna',
            family: 'gpt',
            hostId: 'codex',
          },
        }),
        ctx(),
      ),
    ).rejects.toMatchObject({
      code: 'HOST_NOT_WIRED',
      retryable: false,
      message: expect.stringContaining('现在接了 Claude Code、Cursor Agent'),
    });
    await t.client.query("update pools set run_as_user = null, org_kind = null where id = 'claude-solo'");
    await expect(ports.startSession(launch(), ctx())).rejects.toMatchObject({ code: 'CONFIG_MISSING' });
    await t.client.query(
      "update pools set run_as_user = 'fleet-agent-carpool', org_kind = 'carpool' where id = 'claude-solo'",
    );
    await expect(ports.startSession(launch({ taskId: randomUUID() }), ctx())).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
    expect(fake.count()).toBe(0);
  });

  it('资源上限不是非负整数（小数、负数、不是数）：起之前明确拒，不悄悄取整，库里不留这一行', async () => {
    const { ports, fake } = setup(() => ({}));
    for (const resources of [
      { memoryHighMb: 1536.5, memoryMaxMb: 2048, swapMaxMb: 0 },
      { memoryHighMb: 1536, memoryMaxMb: -1, swapMaxMb: 0 },
      { memoryHighMb: 1536, memoryMaxMb: 2048, swapMaxMb: Number.NaN },
    ]) {
      const input = launch({ resources });
      await expect(ports.startSession(input, ctx()), JSON.stringify(resources)).rejects.toMatchObject({
        code: 'BAD_INPUT',
        retryable: false,
      });
      expect(await getSessionRun(t.db, input.runId)).toBeNull();
    }
    expect(fake.count()).toBe(0);
  });

  it('【失败】项目没写测试命令（流程配置副本里没有）：写码会话起之前明确拒，库里不留这一行，不拿给人看的旧值顶', async () => {
    const { ports, fake } = setup(() => ({}));
    const none = await addTask(t.db, { testCommand: null });
    for (const stage of ['execute', 'ui'] as const) {
      const input = launch({ taskId: none.task.id, stage });
      await expect(ports.startSession(input, ctx()), stage).rejects.toMatchObject({
        code: 'CONFIG_MISSING',
        retryable: false,
        message: expect.stringMatching(/停派：项目没写测试命令：.*\.fleet\/flow\.json.*testCommand/),
      });
      expect(await getSessionRun(t.db, input.runId)).toBeNull();
    }
    expect(fake.count()).toBe(0);
  });

  it.each<[string, Parameters<typeof addTask>[1], RegExp]>([
    ['从没同步过（对账还没读成过）', { flowSyncedAt: null }, /还没从仓里同步过流程配置/],
    ['认不出', { flowError: '项目配置 .fleet/flow.json：不是 JSON' }, /流程配置认不出：项目配置/],
    ['太久没同步成', { flowSyncedAt: new Date(Date.now() - 60 * 60_000) }, /\d+ 分钟没同步成/],
  ])('【失败】流程配置副本%s：什么会话都不起（停派），写明原因，库里不留这一行', async (_name, over, why) => {
    const { ports, fake } = setup(() => ({}));
    const bad = await addTask(t.db, over);
    const input = launch({ taskId: bad.task.id });
    await expect(ports.startSession(input, ctx())).rejects.toMatchObject({
      code: 'CONFIG_MISSING',
      message: expect.stringMatching(why),
    });
    expect(await getSessionRun(t.db, input.runId)).toBeNull();
    expect(fake.count()).toBe(0);
  });

  it('交给插头的上限帮手认得：交换区上限 0 写「0」，写成「0M」帮手会拒、会话起不来（法国 2026-09-26 实测）', async () => {
    const { ports, fake } = setup(commitAndDone());
    const input = launch({ resources: { memoryHighMb: 1536, memoryMaxMb: 2048, swapMaxMb: 0 } });
    const started = await ports.startSession(input, ctx());
    expect(started.handle).toMatchObject({ pid: 4242 });
    const cgroup = fake.specs[0]?.cgroup;
    expect(cgroup?.limits).toEqual({ memoryHigh: '1536M', memoryMax: '2048M', memorySwapMax: '0' });
    // 和真插头同一道校验：不抛就是帮手认得
    expect(() => scopePrefix(cgroup as NonNullable<typeof cgroup>, '/fleet-test-cwd')).not.toThrow();
    await ports.stopSession({ taskId, runId: input.runId, mode: 'kill', reason: '收尾' }, ctx());
  });
});

describe('Fusion 的 Lead：在这张单的工作树里跑，按这一步读结论文件', () => {
  const DOCS = {
    requirement: 'specs/12-login/需求.md',
    plan: 'specs/12-login/方案.md',
    result: 'specs/12-login/结果.md',
  };
  const BRIEF = {
    goal: '加验证码',
    scope: '只改登录',
    constraints: [],
    files: ['src/login/'],
    acceptance: ['五分钟过期'],
    returnFormat: '改了什么',
  };
  const freshTree = () => layout(join(root, `w-${randomUUID().slice(0, 8)}`)).treeFor(repo, BRANCH);
  const leadLaunch = (step: LeadStep, over: Partial<LaunchSessionInput> = {}): LaunchSessionInput => {
    const base = launch({ stage: step === 'takeover' ? 'execute' : 'plan', ...over });
    return {
      ...base,
      brief: { ...base.brief, specDir: 'specs/12-login', lead: { step, mode: 'fusion', docs: DOCS } },
    };
  };
  const writeOut = (cwd: string, file: string, value: unknown) => {
    mkdirSync(join(cwd, '.fleet-out'), { recursive: true });
    writeFileSync(join(cwd, '.fleet-out', file), typeof value === 'string' ? value : JSON.stringify(value));
  };
  const commitDoc = (cwd: string, path: string) => {
    mkdirSync(join(cwd, 'specs', '12-login'), { recursive: true });
    writeFileSync(join(cwd, path), '# 写好了\n');
    git(cwd, 'add', '--', 'specs');
    git(cwd, 'commit', '-q', '-m', `docs: ${path}`);
  };

  it('写方案：在新工作树上起（检出这张单的分支）；方案提交进分支，头和改到的文件从提交里读；结论文件不会被提交', async () => {
    const { ports, fake } = setup(() => ({
      act: ({ spec }) => {
        commitDoc(spec.cwd, DOCS.plan);
        writeOut(spec.cwd, 'lead-plan.json', {
          summary: '加验证码',
          brief: BRIEF,
          small: true,
          highRisk: false,
          holds: [],
        });
      },
    }));
    const input = leadLaunch('plan');
    const { end } = await runOnce(ports, input);
    const dir = input.worktreePath as string;
    expect(end).toMatchObject({
      outcome: 'done',
      output: {
        kind: 'lead-plan',
        head: git(dir, 'rev-parse', 'HEAD'),
        changedFiles: [DOCS.plan],
        summary: '加验证码',
        brief: BRIEF,
        small: true,
        highRisk: false,
        holds: [],
      },
    });
    expect(fake.specs[0]?.cwd).toBe(dir);
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(BRANCH);
    expect(fake.specs[0]?.prompt).toContain(DOCS.requirement);
    // 结论文件在工作树里、进了这棵树自己的忽略清单：git add 带不走，看改动时也看不到
    expect(git(dir, 'check-ignore', '.fleet-out/lead-plan.json')).toBe('.fleet-out/lead-plan.json');
    expect(git(dir, 'status', '--porcelain', '--untracked-files=all', '--', '.fleet-out')).toBe('');
  });

  it('最终审查：结果.md 提交进分支，交回过了、做了什么，头和改到的文件从提交里读', async () => {
    const { ports } = setup(() => ({
      act: ({ spec }) => {
        commitDoc(spec.cwd, DOCS.result);
        writeOut(spec.cwd, 'lead-review.json', {
          verdict: 'pass',
          why: '都做到了',
          did: ['加了验证码'],
          owed: [],
        });
      },
    }));
    const input = leadLaunch('review', { worktreePath: freshTree() });
    const { end } = await runOnce(ports, input);
    expect(end).toMatchObject({
      outcome: 'done',
      output: {
        kind: 'lead-review',
        verdict: 'pass',
        did: ['加了验证码'],
        changedFiles: [DOCS.result],
        head: git(input.worktreePath as string, 'rev-parse', 'HEAD'),
      },
    });
  });

  it('【故意造出的失败】最终审查前 Lead 并了主线（主线上别人改了页面代码）再提交结果.md：改到的文件只有结果.md（#293）', async () => {
    const UI = 'deploy/web/health/health.js';
    mkdirSync(join(m.dir, 'deploy', 'web', 'health'), { recursive: true });
    writeFileSync(join(m.dir, UI), 'export const h = 2;\n');
    git(m.dir, 'add', '--', UI);
    git(m.dir, 'commit', '-q', '-m', 'main: 健康页');
    const { ports } = setup(() => ({
      act: ({ spec }) => {
        // 新主线由引擎取进树里、钉成 origin/main（推之前并主线那一步），Lead 照着 git merge
        git(spec.cwd, 'fetch', '-q', m.dir, '+refs/heads/main:refs/remotes/origin/main');
        git(spec.cwd, 'merge', '--no-ff', '--no-edit', '-q', 'origin/main');
        commitDoc(spec.cwd, DOCS.result);
        writeOut(spec.cwd, 'lead-review.json', {
          verdict: 'pass',
          why: '都做到了',
          did: ['加了验证码'],
          owed: [],
        });
      },
    }));
    const input = leadLaunch('review', { worktreePath: freshTree() });
    const { end } = await runOnce(ports, input);
    expect(git(input.worktreePath as string, 'diff', '--name-only', m.head, 'HEAD').split('\n')).toContain(
      UI,
    );
    expect(end).toMatchObject({
      outcome: 'done',
      output: { kind: 'lead-review', changedFiles: [DOCS.result] },
    });
  });

  it('【故意造出的失败】只看不改的一步提交了、没写结论文件、写方案却留着没提交的改动：都判交错了（wrong_output），写明哪里不对', async () => {
    const cases: [LeadStep, FakeRunScript, string][] = [
      [
        'accept',
        {
          act: ({ spec }) => {
            commitDoc(spec.cwd, DOCS.plan);
            writeOut(spec.cwd, 'lead-verdict.json', { verdict: 'accept', why: '看过了' });
          },
        },
        '这一步只看不改',
      ],
      ['accept', {}, '没写结论 .fleet-out/lead-verdict.json'],
      [
        'plan',
        {
          act: ({ spec }) => {
            writeFileSync(join(spec.cwd, 'README.md'), '# 改了没提交\n');
            writeOut(spec.cwd, 'lead-plan.json', {
              summary: '加验证码',
              brief: BRIEF,
              small: true,
              highRisk: false,
              holds: [],
            });
          },
        },
        '没提交的已跟踪改动',
      ],
      [
        'accept',
        { act: ({ spec }) => writeOut(spec.cwd, 'lead-verdict.json', { verdict: 'maybe', why: 'x' }) },
        'verdict 要是 accept 或 reject',
      ],
    ];
    for (const [step, script, why] of cases) {
      const { ports } = setup(() => script);
      const { end } = await runOnce(ports, leadLaunch(step, { worktreePath: freshTree() }));
      expect(end.outcome).toBe('failed');
      expect(end.failure).toMatchObject({ code: 'wrong_output', message: expect.stringContaining(why) });
    }
  });

  it('【故意造出的失败】续同一个会话时，以前同一步留下的结论文件起之前先删掉：这一轮没写就是没写，不拿上一轮的顶', async () => {
    const { ports } = setup((_spec, n) =>
      n === 1
        ? { act: ({ spec }) => writeOut(spec.cwd, 'lead-verdict.json', { verdict: 'accept', why: '看过了' }) }
        : {},
    );
    const first = leadLaunch('accept', { worktreePath: freshTree() });
    const one = await runOnce(ports, first);
    expect(one.end).toMatchObject({ outcome: 'done', output: { kind: 'lead-verdict', verdict: 'accept' } });
    const again = await runOnce(ports, { ...first, runId: randomUUID(), resumeSessionId: one.sessionId });
    expect(again.end.outcome).toBe('failed');
    expect(again.end.failure?.message).toContain('没写结论 .fleet-out/lead-verdict.json');
  });

  it('派给别家的（cursor 上的副手）：整份提示词先过卫生检查，查出真密钥不发、不起会话', async () => {
    const leak = ['ghp', 'Zt4wQ9mB2xKc7RvN1pLs8HdJ3fGy6TaEu5Vo'].join('_');
    const { routeId, poolId } = await addCursorRoute(t.db);
    const route = {
      routeId,
      poolId,
      modelId: 'cursor-auto',
      family: 'cursor',
      hostId: 'cursor-agent' as const,
    };
    const screened: string[] = [];
    const { ports, cursor } = setup(() => ({}), {
      cursor: () => ({ replay: 'cursor-edit-commit' }),
      screen: (what, texts) => {
        screened.push(what);
        assertPublishable(what, texts);
      },
    });
    const input = launch({ route, worktreePath: freshTree() });
    const error = await ports
      .startSession({ ...input, brief: { ...input.brief, request: `别把 ${leak} 写进日志` } }, ctx())
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'MATERIAL_BLOCKED', retryable: false });
    expect(String((error as Error).message)).toContain('发给别家的交代没过卫生检查，没发给Cursor Agent');
    expect(String((error as Error).message)).not.toContain(leak);
    expect(screened).toEqual(['发给别家的交代']);
    expect(cursor.specs).toEqual([]);
  });
});

describe('收孤儿', () => {
  it('列出来的在册会话逐个收掉（已经停了的不算）；列不出来明确报错，不当成一个都没有', async () => {
    const { ports, scope } = setup(() => ({}));
    process.env.FAKE_SCOPE_LIST = `${randomUUID()} active\npush-x-g1 failed\nold-1 inactive\n`;
    expect(await ports.reapOrphanSessions()).toBe(2);
    expect(scope.calls().filter((c) => c.action === 'stop')).toHaveLength(2);
    process.env.FAKE_SCOPE_LIST_EXIT = '1';
    await expect(ports.reapOrphanSessions()).rejects.toThrow('查不了上一轮留下的会话');
  });
});

describe('会话自己的临时目录（TMPDIR）：插头一收场就删，删不掉明说', () => {
  const tmpOf = (runId: string) => layout(join(root, 'work')).tmpFor(runId);
  type Logged = { message: string; fields: Record<string, unknown> | undefined };
  const logger = () => {
    const logs: Logged[] = [];
    return {
      logs,
      log: (message: string, fields?: Record<string, unknown>) => logs.push({ message, fields }),
    };
  };

  it('失败、被叫停收场：看守交回之前临时目录已经删了（写码会话正常交活的见「写码会话」第一条）', async () => {
    const failing = setup(() => ({ exitCode: 1, result: null }));
    const failed = launch();
    const { end } = await runOnce(failing.ports, failed);
    expect(end.outcome).toBe('failed');
    expect(failing.trees.adopts.map((a) => a.dir)).toContain(tmpOf(failed.runId));
    expect(existsSync(tmpOf(failed.runId))).toBe(false);

    const hanging = setup(() => ({ act: async ({ signal }) => untilAborted(signal) }));
    const stopped = launch();
    const started = await hanging.ports.startSession(stopped, ctx());
    expect(existsSync(tmpOf(stopped.runId))).toBe(true);
    await hanging.ports.stopSession({ taskId, runId: stopped.runId, mode: 'kill', reason: '叫停' }, ctx());
    const stoppedEnd = await hanging.ports.awaitSession(
      { taskId, runId: stopped.runId, sessionId: started.sessionId, stage: 'execute' },
      ctx(),
    );
    expect(stoppedEnd.outcome).toBe('stopped');
    expect(existsSync(tmpOf(stopped.runId))).toBe(false);
  });

  it('进程没起来、迟迟起不来：临时目录照样删，不留给下次起来再清', async () => {
    const broken = setup(() => ({ spawnError: 'spawn /opt/fake/reclaude ENOENT' }));
    const input = launch();
    await expect(broken.ports.startSession(input, ctx())).rejects.toMatchObject({ code: 'SPAWN_FAILED' });
    expect(broken.trees.adopts.map((a) => a.dir)).toContain(tmpOf(input.runId));
    await vi.waitFor(() => expect(broken.trees.removes).toContain(tmpOf(input.runId)));
    expect(existsSync(tmpOf(input.runId))).toBe(false);

    const slow = setup(() => ({ hangBeforeSpawn: true }), { spawnTimeoutMs: 200 });
    const late = launch();
    await expect(slow.ports.startSession(late, ctx())).rejects.toMatchObject({ code: 'SPAWN_TIMEOUT' });
    await vi.waitFor(() => expect(slow.trees.removes).toContain(tmpOf(late.runId)));
    expect(existsSync(tmpOf(late.runId))).toBe(false);
  });

  it('工人重启过：看守接不上时收掉旧会话、删它的临时目录；叫停不在这个进程里的会话，收掉 scope 后删', async () => {
    const { ports } = setup(() => ({ act: async ({ signal }) => untilAborted(signal) }));
    const lost = launch();
    const started = await ports.startSession(lost, ctx());
    expect(existsSync(tmpOf(lost.runId))).toBe(true);
    const restarted = setup(() => ({}));
    const end = await restarted.ports.awaitSession(
      {
        taskId,
        runId: lost.runId,
        sessionId: started.sessionId,
        stage: 'execute',
        ...(started.handle ? { handle: started.handle } : {}),
      },
      ctx(),
    );
    expect(end.failure?.code).toBe('SESSION_LOST');
    expect(restarted.trees.removes).toContain(tmpOf(lost.runId));
    expect(existsSync(tmpOf(lost.runId))).toBe(false);

    const orphan = launch();
    await ports.startSession(orphan, ctx());
    expect(existsSync(tmpOf(orphan.runId))).toBe(true);
    const other = setup(() => ({}));
    await other.ports.stopSession(
      { taskId, runId: orphan.runId, mode: 'kill', reason: '换了工人叫停' },
      ctx(),
    );
    expect(other.scope.calls().some((c) => c.action === 'stop' && c.args.includes(orphan.runId))).toBe(true);
    expect(existsSync(tmpOf(orphan.runId))).toBe(false);

    for (const input of [lost, orphan]) {
      await ports.stopSession({ taskId, runId: input.runId, mode: 'kill', reason: '收尾' }, ctx());
    }
  });

  it('【故意造出的失败】临时目录删不掉：会话的结局照常交回，日志里明说没删掉、是哪个目录，不当成删好了', async () => {
    const { logs, log } = logger();
    const { ports, trees } = setup(commitAndDone(), { log });
    const input = launch();
    trees.fail.remove.add(tmpOf(input.runId));
    const { end } = await runOnce(ports, input);
    expect(end.outcome).toBe('done');
    expect(existsSync(tmpOf(input.runId))).toBe(true);
    const said = logs.find((l) => l.message.includes('会话的临时目录没删掉'));
    expect(said?.fields).toMatchObject({
      runId: input.runId,
      dir: tmpOf(input.runId),
      error: expect.stringContaining('删不掉'),
    });
  });

  it('工人起来时清掉上一轮留下的临时目录，这个进程里在跑的不碰；【故意造出的失败】删不掉、列不出来都明说没清成，不挡工人接活', async () => {
    const { logs, log } = logger();
    const { ports, trees } = setup(() => ({ act: async ({ signal }) => untilAborted(signal) }), { log });
    const left = [randomUUID(), randomUUID()].map(tmpOf);
    for (const dir of left) {
      mkdirSync(join(dir, 'ssr'), { recursive: true });
      writeFileSync(join(dir, 'ssr', 'cache'), 'x');
    }
    const running = launch();
    await ports.startSession(running, ctx());
    expect(await ports.reapOrphanSessions()).toBe(0);
    for (const dir of left) expect(existsSync(dir)).toBe(false);
    expect(existsSync(tmpOf(running.runId))).toBe(true);
    expect(logs.map((l) => l.message)).toContain('删掉上一轮会话留下的临时目录 2 个');

    const stuck = tmpOf(randomUUID());
    mkdirSync(stuck, { recursive: true });
    trees.fail.remove.add(stuck);
    expect(await ports.reapOrphanSessions()).toBe(0);
    expect(existsSync(stuck)).toBe(true);
    const notRemoved = logs.find((l) => l.message.includes('有 1 个没删掉'));
    expect(notRemoved?.fields?.failed).toEqual([expect.stringContaining(stuck)]);

    trees.fail.list = true;
    expect(await ports.reapOrphanSessions()).toBe(0);
    const unlisted = logs.find((l) => l.message.includes('没清成：列不出来'));
    expect(unlisted?.fields?.error).toContain('列不出会话临时目录');

    await ports.stopSession({ taskId, runId: running.runId, mode: 'kill', reason: '收尾' }, ctx());
  });
});

describe('Jev（判断题）：只在看守活动里问', () => {
  /** 记下每一问的假 Jev；answer 抛错、永不返回都照原样。 */
  function fakeJev(answer: (q: JevQuestion) => JevReply | Promise<JevReply>) {
    const asked: { question: JevQuestion; ctx: JevAskContext | undefined }[] = [];
    const port: JevPort = {
      async ask(question, ctx) {
        asked.push({ question, ctx });
        return (await answer(question)) as never;
      },
    };
    return { port, asked };
  }
  /** 执行体报错收场，原文是规则表里没有的一句。 */
  const oddFailure = (): FakeRunScript => ({
    result: { isError: true, terminalReason: 'api_error', text: '上游回了一句谁也没见过的话 zq-17' },
    exitCode: 1,
  });
  const shadowSwap: JevReply = {
    asked: true,
    ok: true,
    choice: 'swapRoute',
    confidence: 0.9,
    shadow: true,
    modelVersion: 'jev-1.13.0',
  };

  it('规则认不出的失败：问一次（带上是哪次会话、哪个任务的哪一步），回答随结局交给工作流；只记不拦的不改路由的账', async () => {
    const jev = fakeJev(() => shadowSwap);
    const { ports } = setup(oddFailure, { jev: jev.port });
    const input = launch();
    const { end } = await runOnce(ports, input);
    expect(end.outcome).toBe('failed');
    expect(jev.asked).toHaveLength(1);
    expect(jev.asked[0]?.question.questionId).toBe('failure-triage');
    expect(jev.asked[0]?.question.sample).toContain('zq-17');
    expect(jev.asked[0]?.ctx).toEqual({
      subject: `run:${input.runId}`,
      about: `任务 ${taskId} 的 execute 阶段（会话失败）`,
    });
    expect(end.failure?.jev).toEqual(shadowSwap);
    // 认不出的失败照旧算这条路由的账（问没问 Jev 都一样）。
    expect((await runRow(input.runId))?.routeOutcome).toBe('fail');
  });

  it('规则认得出的失败（设备被撤销）：不问，结局里也没有 Jev 的回答', async () => {
    const jev = fakeJev(() => {
      throw new Error('不该问');
    });
    const { ports } = setup(
      () => ({
        result: { isError: true, terminalReason: 'api_error', apiErrorStatus: 401, text: 'device_revoked' },
        apiError: { code: 'device_revoked', text: '401 device_revoked' },
        exitCode: 1,
      }),
      { jev: jev.port },
    );
    const { end } = await runOnce(ports, launch());
    expect(end.outcome).toBe('failed');
    expect(jev.asked).toHaveLength(0);
    expect(end.failure?.jev).toBeUndefined();
  });

  it('Jev 卡住、抛错：当没判出来，结局照常交回（带着没判出来的原因）', async () => {
    const hanging = fakeJev(() => new Promise<JevReply>(() => {}));
    const slow = setup(oddFailure, { jev: hanging.port, jevTimeoutMs: 50 });
    const a = await runOnce(slow.ports, launch());
    expect(a.end.outcome).toBe('failed');
    expect(a.end.failure?.jev).toEqual({ asked: true, ok: false, reason: '超过 50 毫秒没回' });

    const throwing = fakeJev(() => {
      throw new Error('连不上');
    });
    const broken = setup(oddFailure, { jev: throwing.port });
    const b = await runOnce(broken.ports, launch());
    expect(b.end.failure?.jev).toEqual({ asked: true, ok: false, reason: '调用出错：连不上' });
  });

  /** 有动静、没推进、看不出在重复（拿不准）：跑两条不同的命令，然后干等。 */
  const unsureStall = (until: (signal: AbortSignal) => Promise<void>) => (): FakeRunScript => ({
    act: async ({ emit, signal }) => {
      for (const [i, summary] of ['pnpm test', 'pnpm lint'].entries()) {
        emit('tool', { phase: 'start', toolUseId: `u${i}`, name: 'Bash', action: 'run', summary });
        emit('tool', { phase: 'end', toolUseId: `u${i}`, name: 'Bash', action: 'run', summary, ok: false });
      }
      await until(signal);
    },
  });
  const waitFor = async (cond: () => boolean, signal: AbortSignal, ms = 8000) => {
    const end = Date.now() + ms;
    while (!cond() && !signal.aborted && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  };

  it('停滞拿不准：问 Jev；只记不拦的「在绕圈」不停会话，同一个会话隔一阵才再问', async () => {
    const jev = fakeJev(() => ({ asked: true, ok: true, choice: 'looping', confidence: 0.9, shadow: true }));
    const { ports } = setup(
      unsureStall(async (signal) => {
        await waitFor(() => jev.asked.length > 0, signal);
        // 问过之后再多跑几轮停滞判断（每 30 毫秒一轮）：不该停、也不该再问。
        await new Promise((r) => setTimeout(r, 300));
      }),
      { jev: jev.port },
    );
    const input = launch();
    const { end } = await runOnce(ports, input);
    expect(jev.asked).toHaveLength(1);
    expect(jev.asked[0]?.question.questionId).toBe('stall-predict');
    expect(jev.asked[0]?.ctx).toEqual({
      subject: `run:${input.runId}`,
      about: `任务 ${taskId} 的 execute 阶段（会话没推进）`,
    });
    expect(end.outcome).not.toBe('stalled');
  });

  it('停滞拿不准、Jev 在真拦且有把握判「在绕圈」：停掉会话，结局 stalled（规则 LJ）', async () => {
    const jev = fakeJev(() => ({ asked: true, ok: true, choice: 'looping', confidence: 0.9, shadow: false }));
    const { ports } = setup(
      unsureStall(async (signal) => {
        await Promise.race([untilAborted(signal), new Promise((r) => setTimeout(r, 10_000))]);
      }),
      { jev: jev.port },
    );
    const { end } = await runOnce(ports, launch());
    expect(end.outcome).toBe('stalled');
    expect(end.failure?.message).toMatch(/^LJ：/);
  });
});

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
      screen: (what) => {
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
      screen: (what, texts) => assertPublishable(what, texts),
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
