// 发布前排空全程（drain.ts、drain-control.ts）：真库（PGlite）、真会话端口（假插头、本地 git）、真选路。
// 手上一个会话在跑 → 发布请求来了（发布锁占着）→ 选路回「过一会儿再选」、新会话起不来（ES1 不记账）、在跑的接着跑 →
// 到截止按切号那一套停下（engine_stop，KL3 不记账、续同一个会话）→ 手上没会话了 → 请求撤了接着派，续上的会话跑完。
// 故意造出的失败：请求认不出、锁空着（旧请求）、建树时开始排空（进程不起）。
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendProgressEvents } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextAction } from '../../src/decisions/failure.ts';
import { createEngineDrain, type EngineDrain } from '../../src/drain.ts';
import { createDrainControl, type RequestSeen } from '../../src/drain-control.ts';
import { DEFAULT_LIMITS } from '../../src/limits.ts';
import {
  type LaunchSessionInput,
  type PortContext,
  PortError,
  type RouteChoice,
  type SessionEnd,
} from '../../src/ports.ts';
import { localExec } from '../../src/real/exec.ts';
import { createSessionPorts } from '../../src/real/sessions.ts';
import { createStorePorts } from '../../src/real/store-ports.ts';
import { layout } from '../../src/real/worktrees.ts';
import {
  addTask,
  type FakeRunScript,
  fakeMirasimDeps,
  fakeRun,
  fakeScopeHelper,
  fakeTrees,
  git,
  MIN,
  mirror,
  NOW,
  orgListRig,
  untilAborted,
  world,
} from './fixtures.ts';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());

let root: string;
let m: ReturnType<typeof mirror>;
beforeEach(async () => {
  await resetTestDb(t);
  await world(t.db);
  root = mkdtempSync(join(tmpdir(), 'fleet-drain-sessions-'));
  m = mirror(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const SHA = 'a'.repeat(40);
const ctx = (): PortContext => ({
  signal: new AbortController().signal,
  heartbeat() {},
  attempt: 1,
  lastHeartbeat: undefined,
});

const runsOn: FakeRunScript = { act: async ({ signal }) => untilAborted(signal), lastContextTokens: 5_000 };

function harness(drainOverride?: (d: EngineDrain) => EngineDrain) {
  const rig = orgListRig();
  rig.answer('carpool');
  let clock = NOW.getTime();
  const now = () => new Date(clock);
  const org = rig.reader({ ttlMs: 30_000, now });
  const base = createEngineDrain();
  const drain = drainOverride ? drainOverride(base) : base;
  const fake = fakeRun((spec) =>
    spec.session.mode === 'new'
      ? runsOn
      : {
          act: async ({ spec: s }) => {
            mkdirSync(join(s.cwd, 'src'), { recursive: true });
            writeFileSync(join(s.cwd, 'src', `x-${randomUUID().slice(0, 4)}.ts`), 'export const x = 1;\n');
            git(s.cwd, 'add', '--', 'src');
            git(s.cwd, 'commit', '-q', '-m', 'feat: 接着干完');
            await appendProgressEvents(t.db, s.runId, [
              { at: new Date(), kind: 'done', payload: { summary: '做完了', testsPassed: true } },
            ]);
          },
        },
  );
  const scope = fakeScopeHelper(root);
  const sessions = createSessionPorts({
    db: t.db,
    trees: fakeTrees(join(root, 'work')).trees,
    exec: localExec(),
    gh: m.gh,
    tmpDir: join(root, 'tmp'),
    machine: '法国',
    claudeCommand: (user) => [`/opt/fake/${user}/reclaude`],
    cursorCommand: (user) => [`/opt/fake/${user}/cursor-agent`],
    grokCommand: (user) => [`/opt/fake/${user}/grok`],
    ...fakeMirasimDeps(),
    helper: scope.helper,
    sudo: scope.sudo,
    gitBin: 'git',
    shBin: 'sh',
    run: { 'claude-code': fake.run },
    tickMs: 10,
    stallCheckMs: 60_000,
    flushMs: 5,
    spawnTimeoutMs: 5000,
    drain,
    // 证据读不到的假：这里的会话都不是被信号杀的，用不上
    killEvidence: {
      readText: async () => {
        throw new Error('测试里没有 cgroup');
      },
      releaseLockBusy: async () => undefined,
      cgroupRoot: '/nope',
      slicePath: 'fleet.slice/fleet-agents.slice',
      releasesDir: '/nope',
    },
    log: () => {},
  });
  const store = createStorePorts({ db: t.db, now, draw: () => 0.5, log: () => {}, sessionOrg: org, drain });
  let request: RequestSeen = { kind: 'none' };
  let lock: boolean | undefined = true;
  const logs: string[] = [];
  const events: string[] = [];
  const control = createDrainControl({
    drain,
    readRequest: async () => request,
    releaseLockBusy: async () => lock,
    ownSha: 'b'.repeat(40),
    stopSessions: (why) => sessions.drainStop(why),
    notify: async (e) => {
      events.push(e.kind);
    },
    log: (message) => logs.push(message),
    now: () => clock,
  });
  return {
    drain,
    base,
    sessions,
    store,
    control,
    logs,
    events,
    now,
    setRequest: (r: RequestSeen) => {
      request = r;
    },
    setLock: (l: boolean | undefined) => {
      lock = l;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
type Harness = ReturnType<typeof harness>;

async function newTask() {
  const { task, repo } = await addTask(t.db);
  const branch = `fleet/${task.issueNumber}-${randomUUID().slice(0, 6)}`;
  return {
    taskId: task.id,
    launch(route: RouteChoice): LaunchSessionInput {
      return {
        taskId: task.id,
        subtaskKey: 'login',
        runId: randomUUID(),
        stage: 'execute',
        route,
        whyRoute: '测试',
        queuedAt: NOW.toISOString(),
        brief: {
          title: '登录页加验证码',
          request: '加一个手机验证码',
          acceptance: ['能收到验证码'],
          touches: ['src'],
          feedback: [],
          answers: [],
          branch,
        },
        worktreePath: layout(join(root, 'work')).treeFor({ owner: repo.owner, name: repo.name }, branch),
        baseHead: m.head,
        stallSeconds: 360,
        sessionMinutes: 90,
        resources: { memoryHighMb: 1536, memoryMaxMb: 2048, swapMaxMb: 0 },
        launch: { fleetApi: 'http://127.0.0.1:8788', fleetToken: 'tok', pathPrepend: ['/opt/fleet/cli/bin'] },
      };
    },
  };
}

const pick = (h: Harness, taskId: string, stickRouteId?: string) =>
  h.store.pickRoute(
    {
      taskId,
      stage: 'execute',
      avoidRouteIds: [],
      avoidPoolIds: [],
      avoidModelIds: [],
      ...(stickRouteId ? { stickRouteId } : {}),
    },
    ctx(),
  );

async function picked(h: Harness, taskId: string): Promise<RouteChoice> {
  const r = await pick(h, taskId);
  if (!r.ok) throw new Error(`选路没派出去：${r.detail}`);
  return r.route;
}

async function start(h: Harness, input: LaunchSessionInput) {
  const started = await h.sessions.startSession(input, ctx());
  const ended = h.sessions.awaitSession(
    { taskId: input.taskId, runId: input.runId, sessionId: started.sessionId, stage: 'execute' },
    ctx(),
  );
  return { input, sessionId: started.sessionId, ended };
}

function judge(
  h: Harness,
  route: RouteChoice,
  f: { code: string; message: string; retryable?: boolean | null },
) {
  return nextAction({
    failure: { source: 'session:execute', code: f.code, message: f.message, retryable: f.retryable ?? null },
    limits: DEFAULT_LIMITS,
    routeBound: true,
    context: {
      stage: 'execute',
      route: { routeId: route.routeId, poolId: route.poolId, modelId: route.modelId, hostId: route.hostId },
      now: h.now().toISOString(),
    },
  });
}

const request = (untilMs: number): RequestSeen => ({
  kind: 'ok',
  request: {
    sha: SHA,
    requestedAt: NOW.toISOString(),
    until: new Date(untilMs).toISOString(),
    by: 'auto',
  },
});

describe('发布前排空：不起新会话、在跑的接着跑、到截止停下按编号续上', () => {
  it('请求来了 → 选路等、新会话起不来 → 到截止停下在跑的（engine_stop）→ 请求撤了 → 续上跑完', async () => {
    const h = harness();
    const a = await newTask();
    const b = await newTask();
    const aRoute = await picked(h, a.taskId);
    const a1 = await start(h, a.launch(aRoute));
    expect(h.drain.inFlight().map((s) => [s.runId, s.phase])).toEqual([[a1.input.runId, 'running']]);

    // 发布请求：截止 10 分钟后；发布锁占着
    h.setRequest(request(NOW.getTime() + 10 * MIN));
    await h.control.tick();
    expect(h.drain.stopping()).toMatchObject({ source: 'release', sha: SHA });
    expect(h.events).toEqual(['start']);

    // 选路：过一会儿再选（写明在为发布排空）
    const waiting = await pick(h, b.taskId);
    expect(waiting).toMatchObject({ ok: false, waitFor: 'slot', retryAfterSeconds: 30 });
    expect(!waiting.ok && waiting.detail).toContain('要发新版本');
    // 选路之前就拿到路由的：起会话被拒，失败分流 ES1 不记账、马上回去选路
    const bRoute = aRoute;
    const refused = await h.sessions.startSession(b.launch(bRoute), ctx()).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(PortError);
    expect((refused as PortError).code).toBe('ENGINE_STOPPING');
    const bNext = judge(h, bRoute, {
      code: 'ENGINE_STOPPING',
      message: (refused as Error).message,
      retryable: false,
    });
    expect(bNext).toMatchObject({ action: 'retry', rule: 'ES1', counter: null, delaySeconds: 0 });
    expect(h.drain.inFlight().map((s) => s.runId)).toEqual([a1.input.runId]);

    // 截止之前：在跑的不动
    h.advance(9 * MIN);
    await h.control.tick();
    expect(h.drain.inFlight()).toHaveLength(1);

    // 到截止：按切号那一套停下，交回 engine_stop；KL3 不记账、续同一个会话
    h.advance(MIN);
    await h.control.tick();
    const a1End: SessionEnd = await a1.ended;
    expect(a1End).toMatchObject({ outcome: 'failed', failure: { code: 'engine_stop', retryable: true } });
    const aNext = judge(h, aRoute, {
      code: a1End.failure?.code ?? '',
      message: a1End.failure?.message ?? '',
      retryable: true,
    });
    expect(aNext).toMatchObject({
      action: 'retry',
      rule: 'KL3',
      counter: null,
      delaySeconds: 0,
      resumeSame: true,
    });
    expect(h.drain.inFlight()).toEqual([]);
    expect(h.logs.join('\n')).toContain(a1.input.runId);

    // 发布没成、请求撤了：马上接着派，续同一个会话跑完
    h.setRequest({ kind: 'none' });
    await h.control.tick();
    expect(h.drain.stopping()).toBeNull();
    expect(h.events).toEqual(['start', 'lift']);
    const r = await pick(h, a.taskId, aRoute.routeId);
    if (!r.ok) throw new Error(r.detail);
    const a2 = await start(h, {
      ...a1.input,
      runId: randomUUID(),
      route: r.route,
      resumeSessionId: a1End.sessionId,
    });
    expect((await a2.ended).outcome).toBe('done');
  });

  it('建树的那几分钟里开始排空：进程不起（ENGINE_STOPPING），不登记在跑', async () => {
    // 过闸那一刻还没在排空，之后（建树时）就在排空了
    let calls = 0;
    const h = harness((d) => ({
      ...d,
      stopping: () =>
        ++calls === 1
          ? null
          : (d.stopping() ?? {
              source: 'release',
              since: NOW.toISOString(),
              until: NOW.toISOString(),
              why: '发布 aaaaaaaaaaaa（auto）',
            }),
    }));
    const a = await newTask();
    const route = await picked(h, a.taskId);
    calls = 0;
    const refused = await h.sessions.startSession(a.launch(route), ctx()).catch((e: unknown) => e);
    expect((refused as PortError).code).toBe('ENGINE_STOPPING');
    expect((refused as Error).message).toContain('进程没起');
    expect(h.drain.inFlight()).toEqual([]);
  });

  it('发布锁空着的旧请求不认、认不出的请求在锁也空着时不认：照常派，日志写明为什么', async () => {
    const h = harness();
    const a = await newTask();
    h.setRequest(request(NOW.getTime() + 10 * MIN));
    h.setLock(false);
    await h.control.tick();
    expect(h.drain.stopping()).toBeNull();
    expect(h.logs.at(-1)).toContain('发布锁空着');
    h.setRequest({ kind: 'bad', why: '/srv/x 认不出：不是 JSON' });
    await h.control.tick();
    expect(h.drain.stopping()).toBeNull();
    expect(h.logs.at(-1)).toContain('认不出');
    expect((await pick(h, a.taskId)).ok).toBe(true);
  });
});
