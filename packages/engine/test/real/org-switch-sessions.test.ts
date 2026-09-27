// 拼车用完、切号那一刻手上的活原地接着干（#59）全程：真库（PGlite）、真会话端口（假插头、本地 git）、真选路、真切号那一步，
// 假 reclaude（org list 的替身）、假帮手（切号的替身）。工作流那一步（失败分流、续同一个会话）照 kit.ts 的走法手动走：
// 手上两个拼车会话，一个被拒（额度用满）、一个还在跑 → 这一轮探针之前切到独享、在跑的那个先停下 → 两个都在独享上
// fork 续上、跑完 → 到拼车恢复时刻、手上两个独享会话在跑 → 停下、切回拼车 → 两个都在拼车上 fork 续上、跑完。
// 操作记录里切号两条（写明停了哪几个）、续会话三条（切号停下的才记，被拒的由失败分流续）。
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendProgressEvents, auditLog } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import type { OrgKind } from '@fleet-dao/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type NextAction, nextAction } from '../../src/decisions/failure.ts';
import { DEFAULT_LIMITS } from '../../src/limits.ts';
import type { LaunchSessionInput, PortContext, RouteChoice, SessionEnd } from '../../src/ports.ts';
import { localExec } from '../../src/real/exec.ts';
import { orgSwitchRound } from '../../src/real/org-switch.ts';
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
  await t.client.query("update pools set org_kind = 'solo' where id = 'claude-solo'");
  root = mkdtempSync(join(tmpdir(), 'fleet-org-switch-sessions-'));
  m = mirror(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const H = 60 * MIN;
const ctx = (): PortContext => ({
  signal: new AbortController().signal,
  heartbeat() {},
  attempt: 1,
  lastHeartbeat: undefined,
});

/** 一直跑到被停下（上下文还小，换了池能 fork 续上）。 */
const runsOn: FakeRunScript = { act: async ({ signal }) => untilAborted(signal), lastContextTokens: 5_000 };
/** 拼车当场用满：会话流里收到被拒的额度读数，终帧报用满（和真插头一样：读数顺手记到池上）。 */
const rejectedAt = (resetsAt: string): FakeRunScript => ({
  result: { isError: true, terminalReason: 'api_error', text: 'usage limit reached' },
  exitCode: 1,
  lastContextTokens: 5_000,
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
});

function harness() {
  const rig = orgListRig();
  let clock = NOW.getTime();
  const now = () => new Date(clock);
  const org = rig.reader({ ttlMs: 30_000, now });
  // 按 runId 点名的剧本；没点名的：新开的会话一直跑，fork 续上的提交一个文件、交活
  const plans = new Map<string, FakeRunScript>();
  const fake = fakeRun(
    (spec) =>
      plans.get(spec.runId) ??
      (spec.session.mode === 'new'
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
          }),
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
    log: () => {},
  });
  const store = createStorePorts({ db: t.db, now, draw: () => 0.5, log: () => {}, sessionOrg: org });
  const switches: OrgKind[] = [];
  const round = orgSwitchRound({
    db: t.db,
    org,
    user: 'fleet-agent-carpool',
    switchOrg: async (to) => {
      switches.push(to);
      rig.answer(to);
      return { ok: true, changed: true };
    },
    sessions: sessions.orgSwitch,
    machine: '法国',
    now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    graceMs: 0,
    drainTimeoutMs: 30_000,
    pollMs: 20,
    log: () => {},
  });
  return {
    rig,
    fake,
    plans,
    sessions,
    store,
    round,
    switches,
    now,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

type Harness = ReturnType<typeof harness>;

/** 一张单的一次会话要的东西（和 sessions.test.ts 的 launch 一样的形状）。 */
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

/** 选路（和工作流一样经 pickRoute）；stick = 续同一个会话时的那条路由。 */
async function pick(h: Harness, taskId: string, stickRouteId?: string) {
  return h.store.pickRoute(
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
}

async function picked(h: Harness, taskId: string): Promise<RouteChoice> {
  const r = await pick(h, taskId);
  if (!r.ok) throw new Error(`选路没派出去：${r.detail}`);
  return r.route;
}

type Run = { input: LaunchSessionInput; sessionId: string; ended: Promise<SessionEnd> };

/** 起一个会话、开始看守（不等它收场）。 */
async function start(h: Harness, input: LaunchSessionInput, plan?: FakeRunScript): Promise<Run> {
  if (plan) h.plans.set(input.runId, plan);
  const started = await h.sessions.startSession(input, ctx());
  const ended = h.sessions.awaitSession(
    { taskId: input.taskId, runId: input.runId, sessionId: started.sessionId, stage: 'execute' },
    ctx(),
  );
  return { input, sessionId: started.sessionId, ended };
}

/** 工作流对一次失败的判断（kit.ts 的 failureContext + decide 本地活动里的 nextAction）。 */
function judge(h: Harness, run: Run, end: SessionEnd): NextAction {
  const r = run.input.route;
  const f = end.failure;
  return nextAction({
    failure: {
      source: 'session:execute',
      code: f?.code ?? 'SESSION_FAILED',
      message: f?.message ?? '',
      retryable: f?.retryable ?? null,
    },
    limits: DEFAULT_LIMITS,
    routeBound: true,
    context: {
      stage: 'execute',
      route: {
        routeId: r.routeId,
        poolId: r.poolId,
        modelId: r.modelId,
        hostId: r.hostId,
        ...(r.orgKind ? { orgKind: r.orgKind } : {}),
      },
      ...(f?.resetsAt ? { resetsAt: f.resetsAt } : {}),
      now: h.now().toISOString(),
    },
  });
}

/**
 * 判出「马上续同一个会话」之后工作流做的：选路带上原来那条路由（stick），派到的池起会话、接着原会话号。
 * 交回续上的那一轮。
 */
async function carryOn(h: Harness, run: Run, end: SessionEnd, to: string) {
  const next = judge(h, run, end);
  expect(next).toMatchObject({ action: 'retry', delaySeconds: 0, resumeSame: true });
  const r = await pick(h, run.input.taskId, run.input.route.routeId);
  if (!r.ok) throw new Error(`续会话没派出去：${r.detail}`);
  expect(r.route.poolId).toBe(to);
  const input = { ...run.input, runId: randomUUID(), route: r.route, resumeSessionId: end.sessionId };
  const resumed = await start(h, input);
  return { next, resumed, end: await resumed.ended };
}

describe('拼车用完、切号那一刻手上的活原地接着干（#59）', () => {
  it('一个被拒、一个在跑 → 切独享（在跑的先停下）→ 两个都 fork 续上跑完 → 到恢复时刻停下在跑的两个、切回拼车 → 两个都 fork 续上跑完', async () => {
    const h = harness();
    h.rig.answer('carpool');
    const a = await newTask();
    const b = await newTask();

    // 挂着拼车：两张单都派到拼车；a 当场被拒（2 小时后清零），b 还在跑
    const resets = new Date(NOW.getTime() + 2 * H).toISOString();
    const aRoute = await picked(h, a.taskId);
    const bRoute = await picked(h, b.taskId);
    expect([aRoute.poolId, bRoute.poolId]).toEqual(['claude-carpool', 'claude-carpool']);
    const b1 = await start(h, b.launch(bRoute));
    const a1 = await start(h, a.launch(aRoute), rejectedAt(resets));
    const a1End = await a1.ended;
    expect(a1End).toMatchObject({
      outcome: 'failed',
      failure: { code: 'quota_exhausted', resetsAt: resets },
    });

    // 被拒的那个：不原地睡到清零，马上回去选路；还没切号，续同一个会话等这条路由（按清零时刻隔一会儿再看）
    const aNext = judge(h, a1, a1End);
    expect(aNext).toMatchObject({
      action: 'retry',
      rule: 'QT1',
      delaySeconds: 0,
      wait: 'quota',
      resumeSame: true,
    });
    const waiting = await pick(h, a.taskId, a1.input.route.routeId);
    expect(waiting).toMatchObject({ ok: false, waitFor: 'quota' });
    expect(!waiting.ok && waiting.detail).toContain('续同一个会话，等这条路由');

    // 这一轮探针之前：拼车用满（被拒的读数记在拼车池上），切独享；手上还在跑的 b 先停下
    expect(await h.round.before()).toBe('solo');
    expect(h.switches).toEqual(['solo']);

    // 两个都在独享上 fork 续上、跑完：a 按失败分流续（QT1），b 交回切号（OS1）
    const b1End = await b1.ended;
    expect(b1End).toMatchObject({ outcome: 'failed', failure: { code: 'org_switch', retryable: true } });
    const a2 = await carryOn(h, a1, a1End, 'claude-solo');
    const b2 = await carryOn(h, b1, b1End, 'claude-solo');
    expect(b2.next).toMatchObject({ rule: 'OS1', counter: null });
    expect([a2.end.outcome, b2.end.outcome]).toEqual(['done', 'done']);
    const forks = h.fake.specs.filter((s) => s.session.mode === 'fork');
    expect(forks.map((s) => s.session)).toEqual([
      { mode: 'fork', from: a1.sessionId, id: a2.resumed.sessionId },
      { mode: 'fork', from: b1.sessionId, id: b2.resumed.sessionId },
    ]);
    // 续上的提示词里写着上一次为什么停
    expect(forks[1]?.prompt).toContain('切号：会话用户从拼车组织切到独享组织');

    // 到拼车恢复时刻：两张单的下一步又在独享上跑着（新开的会话）
    h.advance(2 * H + MIN);
    const a3 = await start(h, a.launch(await picked(h, a.taskId)));
    const b3 = await start(h, b.launch(await picked(h, b.taskId)));
    expect([a3.input.route.poolId, b3.input.route.poolId]).toEqual(['claude-solo', 'claude-solo']);
    expect(await h.round.before()).toBe('carpool');
    expect(h.switches).toEqual(['solo', 'carpool']);
    for (const run of [a3, b3]) {
      const carried = await carryOn(h, run, await run.ended, 'claude-carpool');
      expect(carried.next).toMatchObject({ rule: 'OS1' });
      expect(carried.end.outcome).toBe('done');
    }

    // 操作记录：切号两条（写明停了哪几个），切号停下后续上的三条（都是 fork）
    const rows = (await t.db.select().from(auditLog)).sort((x, y) => x.id - y.id);
    const switched = rows.filter((r) => r.action === 'session-org.switch');
    const after = (i: number) => switched[i]?.after as { org: string; stopped: string[] } | undefined;
    expect(switched.map((r, i) => [r.ok, r.before, after(i)?.org])).toEqual([
      [true, { org: 'carpool' }, 'solo'],
      [true, { org: 'solo' }, 'carpool'],
    ]);
    expect(after(0)?.stopped).toEqual([b1.input.runId]);
    expect([...(after(1)?.stopped ?? [])].sort()).toEqual([a3.input.runId, b3.input.runId].sort());
    const resumed = rows.filter((r) => r.action === 'session-org.resume');
    expect(resumed.map((r) => r.after)).toEqual([
      expect.objectContaining({ poolId: 'claude-solo', mode: 'fork' }),
      expect.objectContaining({ poolId: 'claude-carpool', mode: 'fork' }),
      expect.objectContaining({ poolId: 'claude-carpool', mode: 'fork' }),
    ]);
  });
});
