// 会话端口：起会话（建树、定接着干的方式、登记开工）、看守（进度写库、按进展判停滞、交活核实、读结论文件）、
// 叫停、收孤儿。用内存库、本地 git（顶替会话用户的执行器）、假插头（不起真执行体）；每条失败路径都故意造一次。
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendProgressEvents,
  getSessionRun,
  notifications,
  progressEvents,
  quotaWindows,
  sessionRuns,
  sessionStops,
  upsertAlert,
} from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LaunchSessionInput, PortContext, SessionEnd } from '../../src/ports.ts';
import { localExec } from '../../src/real/exec.ts';
import { createSessionPorts } from '../../src/real/sessions.ts';
import { poolHoldKey } from '../../src/real/store-ports.ts';
import { layout } from '../../src/real/worktrees.ts';
import {
  addTask,
  type FakeRunScript,
  fakeRun,
  fakeScopeHelper,
  fakeTrees,
  git,
  mirror,
  NOW,
  untilAborted,
  world,
} from './fixtures.ts';

// 每条用例都真跑好几次 git（Windows 上一次几百毫秒），机器忙时默认的 5 秒不够。
vi.setConfig({ testTimeout: 60_000 });

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
  options: { transcriptMissing?: boolean } = {},
) {
  const fake = fakeRun(script);
  const trees = fakeTrees(join(root, 'work'), options);
  const scope = fakeScopeHelper(root);
  const ports = createSessionPorts({
    db: t.db,
    trees: trees.trees,
    exec: localExec(),
    gh: m.gh,
    tmpDir: join(root, 'tmp'),
    machine: '法国',
    claudeCommand: (user) => [`/opt/fake/${user}/reclaude`],
    helper: scope.helper,
    sudo: scope.sudo,
    gitBin: 'git',
    shBin: 'sh',
    run: fake.run,
    tickMs: 10,
    stallCheckMs: 30,
    flushMs: 5,
    spawnTimeoutMs: 5000,
    stallPolicy: { noProgressSeconds: 1 },
    log: () => {},
  });
  return { ports, fake, trees, scope };
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
    expect(trees.adopts).toEqual([{ dir: input.worktreePath, user: 'fleet-agent-dedicated' }]);
    const spec = fake.specs[0];
    expect(spec?.session).toEqual({ mode: 'new', id: started.sessionId });
    expect(spec?.cwd).toBe(input.worktreePath);
    expect(spec?.cgroup).toMatchObject({
      id: input.runId,
      user: 'fleet-agent-dedicated',
      limits: { memoryHigh: '1536M', memoryMax: '2048M', memorySwapMax: '0M' },
    });
    expect(spec?.model).toBe('claude-opus-5-5');
    expect(spec?.prompt).toContain('需求 #12');
    expect(fake.options[0]?.command).toEqual(['/opt/fake/fleet-agent-dedicated/reclaude']);
    // 树是会话用户从镜像的 bundle 建的：分支在起会话前的头上。
    expect(git(input.worktreePath as string, 'rev-parse', `${BRANCH}~1`)).toBe(m.head);

    const beat = ctx();
    const end = await ports.awaitSession(
      { taskId, runId: input.runId, sessionId: started.sessionId, stage: 'execute' },
      beat,
    );
    expect(end.outcome).toBe('done');
    expect(end.output).toMatchObject({ kind: 'delivery', summary: '做完了', testsPassed: true });
    expect(end.output?.kind === 'delivery' && end.output.head).toBe(
      git(input.worktreePath as string, 'rev-parse', 'HEAD'),
    );
    expect(end.output?.kind === 'delivery' && end.output.changedFiles?.[0]).toMatch(/^src\/login-/);
    const row = await runRow(input.runId);
    expect(row).toMatchObject({
      sessionId: started.sessionId,
      outcome: 'ok',
      runAsUser: 'fleet-agent-dedicated',
      routeOutcome: 'ok',
      costUsd: 0.5,
    });
    expect(row?.startedAt).not.toBeNull();
    const kinds = (await t.db.select().from(progressEvents)).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['tool', 'test', 'done']));
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

  it('换了会话用户、上一轮上下文还小：把树和过程记录交给新用户，--fork-session 续', async () => {
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
    expect(trees.adopts.at(-1)).toEqual({
      dir: input.worktreePath,
      user: 'fleet-agent-dedicated',
      transcript: { from: 'fleet-agent-carpool', sessionId: first.sessionId },
    });
    expect(fake.specs[1]?.session).toEqual({ mode: 'fork', from: first.sessionId, id: started.sessionId });
    expect(started.resumed).toBe(true);
    expect(started.sessionId).not.toBe(first.sessionId);
    await ports.awaitSession(
      { taskId, runId: input.runId, sessionId: started.sessionId, stage: 'execute' },
      ctx(),
    );
    // fork 出来的会话不知道累计花费从哪算起：不记这一轮的花费。
    expect((await runRow(input.runId))?.costUsd).toBeNull();
  });

  it('换了会话用户、上一轮上下文大了：开新会话，带接力任务书（已提交的不重做）', async () => {
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

  it('要 fork 但过程记录没拷过去：改成开新会话带接力任务书，不硬续', async () => {
    const { ports, fake } = setup((_, n) => commitAndDone(n === 1 ? { contextTokens: 5_000 } : {})(), {
      transcriptMissing: true,
    });
    const carpool = {
      routeId: 'carpool',
      poolId: 'claude-carpool',
      modelId: 'opus-5.5',
      family: 'claude',
      hostId: 'claude-code' as const,
    };
    const first = await runOnce(ports, launch({ route: carpool }));
    await runOnce(ports, launch({ resumeSessionId: first.sessionId }));
    expect(fake.specs[1]?.session.mode).toBe('new');
    expect(fake.specs[1]?.prompt).toContain('过程记录没找到');
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
  });

  it('没写结论文件、写的不是 JSON、说不清却没写要问的：都判交错了（wrong_output）', async () => {
    for (const text of [null, '不是 JSON', '{"clear": false}']) {
      const { ports } = setup(() => triage(text));
      const { end } = await runOnce(ports, triageLaunch());
      expect(end.outcome).toBe('failed');
      expect(end.failure?.code).toBe('wrong_output');
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
      failure: { code: 'quota_exhausted', resetsAt, machine: '法国', runAsUser: 'fleet-agent-dedicated' },
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
    expect(hold?.body).toContain('fleet-agent-dedicated');
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

  it('进程起不来：明确报 SPAWN_FAILED，库里这一行记上结局', async () => {
    const { ports } = setup(() => ({ spawnError: 'spawn /opt/fake/reclaude ENOENT' }));
    const input = launch();
    await expect(ports.startSession(input, ctx())).rejects.toMatchObject({ code: 'SPAWN_FAILED' });
    expect(await getSessionRun(t.db, input.runId)).toMatchObject({
      outcome: 'failed',
      failureCode: 'SPAWN_FAILED',
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
    ).rejects.toMatchObject({ code: 'HOST_NOT_WIRED' });
    await t.client.query("update pools set run_as_user = null where id = 'claude-solo'");
    await expect(ports.startSession(launch(), ctx())).rejects.toMatchObject({ code: 'CONFIG_MISSING' });
    await t.client.query("update pools set run_as_user = 'fleet-agent-dedicated' where id = 'claude-solo'");
    await expect(ports.startSession(launch({ taskId: randomUUID() }), ctx())).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
    expect(fake.count()).toBe(0);
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
