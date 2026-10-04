// 三段的一次性会话碰上切号（#59）全程：真库（PGlite）、真选路、真切号那一步（orgSwitchRound 接 oneShots 登记）、真这一段
// （createRunSegment：真 git 建树、真 runs 写入、真一次性会话的收场、会话流里读到的额度真记进库），假 reclaude（org list 的
// 替身）、假帮手（切号的替身）、假插头（按工作树点名的剧本）。工作流那一步（失败分流、在原分支上重跑）照 workflows/task.ts 的
// write() 手动走：手上两段跑在拼车上，一段当场被拒（额度用满）、一段还在跑 → 这一轮探针之前切到独享、在跑的那段先停下（交回
// org_switch）→ 两段都在独享上、原分支原工作树上重跑、跑完 → 到拼车恢复时刻、独享上又有一段在跑 → 停下、切回拼车 → 在拼车上
// 重跑、跑完。故意造的失败：停不下来、切号没成、重跑又被拒。

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RateLimitReading } from '@fleet-dao/adapters';
import { auditLog, notifications, runs } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import type { OrgKind } from '@fleet-dao/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type NextAction, nextAction } from '../../src/decisions/failure.ts';
import { DEFAULT_LIMITS } from '../../src/limits.ts';
import type { PortContext, RouteChoice } from '../../src/ports.ts';
import { localExec } from '../../src/real/exec.ts';
import type { HostDriver, HostReport, HostRunHooks, HostRunSpec, WiredHost } from '../../src/real/hosts.ts';
import { oneShotSessions } from '../../src/real/one-shot-sessions.ts';
import { ORG_SWITCH_ALERT, orgSwitchRound } from '../../src/real/org-switch.ts';
import { realReservations, realRuns } from '../../src/real/runs-writer.ts';
import { createStorePorts } from '../../src/real/store-ports.ts';
import { createRunSegment } from '../../src/real/task-segment.ts';
import type { RunSegmentInput, RunSegmentResult, SegmentEvidence } from '../../src/task-contract.ts';
import { goodBrief } from '../task-script.ts';
import {
  addTask,
  fakeTrees,
  git,
  healthyCarpoolRead,
  MIN,
  mirror,
  NOW,
  orgListRig,
  world,
} from './fixtures.ts';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());

let root: string;
beforeEach(async () => {
  await resetTestDb(t);
  await world(t.db);
  // 真实的样子：独享池挂在独享组织上、拼车池挂在拼车组织上
  await t.client.query("update pools set org_kind = 'solo' where id = 'claude-solo'");
  root = mkdtempSync(join(tmpdir(), 'fleet-org-switch-one-shot-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const H = 60 * MIN;
const REPO = { id: 'r1', owner: 'acme', name: 'demo', defaultBranch: 'main', testCommand: 'pnpm check' };
const TO_SOLO = '切号：会话用户从拼车组织切到独享组织';
const ctx = (): PortContext => ({
  signal: new AbortController().signal,
  heartbeat() {},
  attempt: 1,
  lastHeartbeat: undefined,
});

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 假插头跑的一次：拿到起会话的参数和钩子，交回报告。 */
type Act = (spec: HostRunSpec, hooks: HostRunHooks) => Promise<HostReport>;

const report = (over: Partial<HostReport> = {}): HostReport => ({
  hostId: 'claude-code',
  facts: { exitCode: 0, terminal: { isError: false, detail: 'done' }, quotaExhausted: false },
  usage: { inputTokens: 100, outputTokens: 20 },
  answer: '已提交',
  wallMs: 10,
  stderrTail: '',
  ...over,
});

function commit(cwd: string, file: string): void {
  writeFileSync(join(cwd, file), `export const x = '${file}';\n`);
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-q', '-m', `add ${file}`);
}

/** 提交一半，跑到被停下为止（叫停时插头被杀：报 killed、没有终帧）。 */
const runsUntilStopped =
  (file: string, entered: () => void): Act =>
  async (spec, hooks) => {
    commit(spec.cwd, file);
    entered();
    await new Promise<void>((resolve) => {
      if (hooks.signal?.aborted) return resolve();
      hooks.signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    return {
      hostId: 'claude-code',
      facts: { exitCode: null, killed: 'aborted', quotaExhausted: false },
      usage: {},
      wallMs: 10,
      stderrTail: '',
    };
  };

/** 接着干完：提交、正常收场。 */
const finishes =
  (file: string): Act =>
  async (spec) => {
    commit(spec.cwd, file);
    return report();
  };

/** 当场被拒：会话流里收到被拒的额度读数（和真插头一样交给 onRateLimit、收场前等它落定），终帧报额度用满。 */
const rejectedAt =
  (resetsAt: string): Act =>
  async (_spec, hooks) => {
    await hooks.onRateLimit?.({
      status: 'rejected',
      exhausted: true,
      rateLimitType: 'five_hour',
      resetsAt,
      windows: [{ name: 'five_hour', utilization: 1, resetsAt }],
      observedAt: NOW.toISOString(),
    } as RateLimitReading);
    return report({
      facts: {
        exitCode: 1,
        terminal: { isError: true, detail: 'usage limit reached' },
        quotaExhausted: true,
      },
      resetsAt,
      answer: '',
    });
  };

function harness(opts: { drainTimeoutMs?: number; switchFails?: () => string | undefined } = {}) {
  const rig = orgListRig();
  rig.answer('carpool');
  let clock = NOW.getTime();
  const now = () => new Date(clock);
  const org = rig.reader({ ttlMs: 30_000, now });
  const store = createStorePorts({ db: t.db, now, draw: () => 0.5, log: () => {}, sessionOrg: org });
  const oneShots = oneShotSessions();
  const switches: OrgKind[] = [];
  const round = orgSwitchRound({
    db: t.db,
    org,
    user: 'fleet-agent-carpool',
    switchOrg: async (to) => {
      switches.push(to);
      const failed = opts.switchFails?.();
      if (failed) return { ok: false, code: 'failed', exitCode: 1, now: 'carpool', detail: failed };
      rig.answer(to);
      return { ok: true, changed: true };
    },
    oneShots,
    machine: '法国',
    readApi: async () => healthyCarpoolRead(now()),
    now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    graceMs: 0,
    drainTimeoutMs: opts.drainTimeoutMs ?? 30_000,
    pollMs: 20,
    log: () => {},
  });
  const m = mirror(root);
  const ft = fakeTrees(join(root, 'work'));
  // 按工作树点名的剧本：每次起会话取下一个
  const plans = new Map<string, Act[]>();
  const specs: HostRunSpec[] = [];
  const driver = (hostId: WiredHost): HostDriver => ({
    hostId,
    userFrom: 'pool',
    canFork: false,
    newSessionId: () => ({ id: randomUUID(), known: true }),
    async run(spec, hooks) {
      specs.push(spec);
      const act = plans.get(spec.cwd)?.shift();
      if (!act) throw new Error(`这棵树没有剧本了：${spec.cwd}`);
      return act(spec, hooks);
    },
    loginFix: () => '去登录',
  });
  const runSegment = createRunSegment({
    tree: {
      gh: m.gh as never,
      trees: ft.trees,
      exec: localExec(),
      tmpDir: join(root, 'engine-tmp'),
      gitBin: 'git',
      shBin: 'sh',
    },
    spawner: {
      db: t.db,
      drivers: {
        'claude-code': driver('claude-code'),
        'cursor-agent': driver('cursor-agent'),
        grok: driver('grok'),
        mirasim: driver('mirasim'),
      } as Record<WiredHost, HostDriver>,
      trees: ft.trees,
      baseEnv: { PATH: '/usr/bin' },
      resources: { memoryHighMb: 5888, memoryMaxMb: 6144, swapMaxMb: 0 },
    },
    runs: realRuns({ db: t.db }),
    reservations: realReservations({ db: t.db }),
    runsDir: join(root, 'runs'),
    sessions: oneShots,
    heartbeatEveryMs: 5,
  });
  return {
    store,
    round,
    oneShots,
    switches,
    specs,
    now,
    advance: (ms: number) => {
      clock += ms;
    },
    /** 一张单的动手那一段：自己的分支、自己的工作树。 */
    task(name: string) {
      const branch = `fleet/12-${name}${randomUUID().slice(0, 6)}`;
      const worktreePath = ft.trees.treeFor(REPO, branch);
      // runs 开跑那一行就写 task_id（#216），外键到 tasks：这张单在库里得真有一行
      let taskId: Promise<string> | undefined;
      const ensureTask = () => {
        taskId ??= addTask(t.db).then(({ task }) => task.id);
        return taskId;
      };
      return {
        branch,
        worktreePath,
        plan: (...acts: Act[]) => plans.set(worktreePath, [...(plans.get(worktreePath) ?? []), ...acts]),
        run: async (route: RouteChoice, interrupted?: string) =>
          runSegment(
            {
              schemaVersion: 1,
              taskId: await ensureTask(),
              repo: REPO,
              issueNumber: 12,
              route,
              worktreePath,
              branch,
              baseSha: m.head,
              brief: goodBrief(),
              tier: { tier: 'medium', effort: 'high', reason: '一个目录', modules: 1 } as never,
              feedback: [],
              timeoutMinutes: 5,
              ...(interrupted ? { interrupted } : {}),
            } satisfies RunSegmentInput,
            ctx(),
          ),
      };
    },
  };
}

type Harness = ReturnType<typeof harness>;
type Task = ReturnType<Harness['task']>;

/** 选路（和工作流一样经 pickRoute）；stick = 原路重试时带上的那条路由。 */
const pick = (h: Harness, stickRouteId?: string) =>
  h.store.pickRoute(
    {
      taskId: randomUUID(),
      stage: 'execute',
      avoidRouteIds: [],
      avoidPoolIds: [],
      avoidModelIds: [],
      ...(stickRouteId ? { stickRouteId } : {}),
    },
    ctx(),
  );

async function picked(h: Harness, stickRouteId?: string): Promise<RouteChoice> {
  const r = await pick(h, stickRouteId);
  if (!r.ok) throw new Error(`选路没派出去：${r.detail}`);
  return r.route;
}

function evidence(res: RunSegmentResult): SegmentEvidence {
  if (res.ok) throw new Error('这一段跑成了，没有失败证据');
  return res.evidence;
}

/** 工作流对这一段没跑成的判断（workflows/task.ts 的 classify：本地活动里的 nextAction）。 */
function judge(h: Harness, route: RouteChoice, res: RunSegmentResult): NextAction {
  const e = evidence(res);
  return nextAction({
    // 和工作流同一个兜底：证据里缺码、缺原文的照 write() 补
    failure: {
      source: 'session:execute',
      code: e.code ?? 'failed',
      message: e.message ?? '会话没跑成',
      retryable: null,
    },
    limits: DEFAULT_LIMITS,
    routeBound: true,
    context: {
      stage: 'execute',
      route: {
        routeId: route.routeId,
        poolId: route.poolId,
        modelId: route.modelId,
        hostId: route.hostId,
        ...(route.orgKind ? { orgKind: route.orgKind } : {}),
      },
      ...(e.resetsAt ? { resetsAt: e.resetsAt } : {}),
      now: h.now().toISOString(),
    },
  });
}

/** 判出「原路再试」之后工作流做的：带着原来那条路由去选（stick），派到哪个池就在原分支上重跑这一段。 */
async function rerun(h: Harness, task: Task, prev: RouteChoice, to: string, interrupted?: string) {
  const route = await picked(h, prev.routeId);
  expect(route.poolId).toBe(to);
  return { route, res: await task.run(route, interrupted) };
}

const switchAudits = async () =>
  (await t.db.select().from(auditLog))
    .filter((a) => a.action === 'session-org.switch')
    .sort((a, b) => a.id - b.id)
    .map((a) => ({ ok: a.ok, before: a.before, after: a.after, reason: a.reason, error: a.error }));
const alertOf = async (key: string) =>
  (await t.db.select().from(notifications)).find((n) => n.dedupeKey === key);
const runRow = async (id: string | null) => (await t.db.select().from(runs)).find((r) => r.id === id);

/** 手上两段：a 在拼车上跑着（提交了一半），b 在拼车上当场被拒（2 小时后清零）。交回 a 还没收场的那一次。 */
async function carpoolBusy(h: Harness, aActs: Act[], resets: string) {
  const a = h.task('a');
  const b = h.task('b');
  const aRoute = await picked(h);
  const bRoute = await picked(h);
  expect([aRoute.poolId, bRoute.poolId]).toEqual(['claude-carpool', 'claude-carpool']);
  const aIn = deferred();
  const [first, ...rest] = aActs;
  a.plan(first ?? runsUntilStopped('a-half.ts', aIn.resolve), ...rest);
  b.plan(rejectedAt(resets), finishes('b.ts'));
  const a1 = a.run(aRoute);
  const b1 = await b.run(bRoute);
  return { a, b, aRoute, bRoute, a1, b1, aIn };
}

describe('拼车用完、切号那一刻手上的一次性会话：先停下这一段，切完在原分支上重跑（#59）', () => {
  it('一段被拒、一段在跑 → 切独享（在跑的先停下，交回 org_switch）→ 两段都在原分支上重跑、跑完 → 到恢复时刻停下独享上在跑的、切回拼车 → 重跑、跑完', async () => {
    const h = harness();
    const resets = new Date(NOW.getTime() + 2 * H).toISOString();
    const aIn = deferred();
    const { a, b, aRoute, bRoute, a1, b1 } = await carpoolBusy(
      h,
      [runsUntilStopped('a-half.ts', aIn.resolve), finishes('a-rest.ts')],
      resets,
    );
    await aIn.promise;

    // b 被拒：读数在这一段交回之前已经记到拼车池上；不原地睡到清零，马上回去选路，还没切号就等这条路由
    expect(b1).toMatchObject({ ok: false, evidence: { code: 'quota_exhausted', resetsAt: resets } });
    expect(judge(h, bRoute, b1)).toMatchObject({
      action: 'retry',
      rule: 'QT1',
      delaySeconds: 0,
      wait: 'quota',
    });
    expect(await pick(h, bRoute.routeId)).toMatchObject({ ok: false, waitFor: 'quota' });

    // 这一轮探针之前：拼车用满，切独享；手上在跑的 a 先停下（停下前的那一下还登记着）
    expect(h.oneShots.live(new Set(['claude-carpool']))).toHaveLength(1);
    expect(await h.round.before()).toBe('solo');
    expect(h.switches).toEqual(['solo']);
    const a1End = await a1;
    expect(a1End).toMatchObject({ ok: false, outcome: 'org_switch', evidence: { code: 'org_switch' } });
    expect(evidence(a1End).message).toContain(TO_SOLO);
    // 切号停下的：不算失败、不记账、马上接着干
    expect(judge(h, aRoute, a1End)).toMatchObject({
      action: 'retry',
      rule: 'OS1',
      counter: null,
      delaySeconds: 0,
    });
    expect(h.oneShots.live(new Set(['claude-carpool', 'claude-solo']))).toEqual([]);

    // 两段都在独享上、原分支原工作树上重跑：a 的提示词里写着上一次为什么停，接着它提交了的那一半干
    const a2 = await rerun(h, a, aRoute, 'claude-solo', evidence(a1End).message);
    const b2 = await rerun(h, b, bRoute, 'claude-solo');
    expect([a2.res.ok, b2.res.ok]).toEqual([true, true]);
    const aSpecs = h.specs.filter((s) => s.cwd === a.worktreePath);
    expect(aSpecs).toHaveLength(2);
    expect(aSpecs[0]?.prompt).not.toContain('上一次跑到一半被停下了');
    expect(aSpecs[1]?.prompt).toContain('## 这一段上一次跑到一半被停下了');
    expect(aSpecs[1]?.prompt).toContain(TO_SOLO);
    expect(git(a.worktreePath, 'log', '--format=%s', '-3').split('\n')).toEqual([
      'add a-rest.ts',
      'add a-half.ts',
      'second',
    ]);
    expect(git(a.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(a.branch);

    // 到拼车恢复时刻：c 这一段在独享上跑着 → 停下、切回拼车 → 在拼车上重跑、跑完
    h.advance(2 * H + MIN);
    // 恢复要连着两次「被拒之后的新读数」（隔一分钟以上，#194）：这是第一次，还不切回
    expect(await h.round.before()).toBeNull();
    h.advance(MIN);
    const c = h.task('c');
    const cIn = deferred();
    c.plan(runsUntilStopped('c-half.ts', cIn.resolve), finishes('c-rest.ts'));
    const cRoute = await picked(h);
    expect(cRoute.poolId).toBe('claude-solo');
    const c1 = c.run(cRoute);
    await cIn.promise;
    // 恢复了、手上有一段刚开跑的：进切回宽限，开跑不到 5 分钟的当场停（方案 4.5）；这时还没切，新活先不往独享派
    expect(await h.round.before()).toBeNull();
    expect(h.switches).toEqual(['solo']);
    const c1End = await c1;
    expect(c1End).toMatchObject({ ok: false, outcome: 'org_switch' });
    // 手上空了：下一轮切回拼车
    expect(await h.round.before()).toBe('carpool');
    expect(h.switches).toEqual(['solo', 'carpool']);
    expect(judge(h, cRoute, c1End)).toMatchObject({ action: 'retry', rule: 'OS1' });
    const c2 = await rerun(h, c, cRoute, 'claude-carpool', evidence(c1End).message);
    expect(c2.res.ok).toBe(true);

    // 操作记录：切号两条，写明停了哪一段（runs 的编号），切完各自接着干
    const audits = await switchAudits();
    expect(audits.map((x) => [x.ok, x.before, x.after])).toEqual([
      [true, { org: 'carpool' }, { org: 'solo', stopped: [a1End.runId] }],
      // 切回时手上已经空了（宽限开始时停下的那段记在 session-org.drain 里）：确认过的切回
      [true, { org: 'solo' }, { org: 'carpool', mode: 'confirmed' }],
    ]);
    expect(audits[0]?.reason).toContain('切之前停下了 1 个在跑的 Claude 会话，切完各自接着干');

    // runs：每一次一行、都收了（没有开着的，切号不会一直以为有会话在跑）；停下的 org_switch，被拒的 failed，重跑的 done
    expect((await t.db.select().from(runs)).filter((r) => r.endedAt === null)).toEqual([]);
    const outcomes = [];
    for (const r of [a1End, b1, a2.res, b2.res, c1End, c2.res]) {
      const row = await runRow(r.runId);
      outcomes.push([row?.outcome, row?.routeId]);
    }
    expect(outcomes).toEqual([
      ['org_switch', 'carpool'],
      ['failed', 'carpool'],
      ['done', 'solo'],
      ['done', 'solo'],
      ['org_switch', 'solo'],
      ['done', 'carpool'],
    ]);
  });
});

describe('【故意造出的失败】停不下来、切号没成、重跑又被拒：不当成切好了，停下的那段不丢', () => {
  const resets = () => new Date(NOW.getTime() + 2 * H).toISOString();

  it('停不下来（会话不理叫停）：等满时限这一轮不切，记一条没成、报警；它自己跑完了照样算 done，手上空了下一轮切过去、提醒撤掉', async () => {
    const h = harness({ drainTimeoutMs: 300 });
    const gate = deferred();
    const aIn = deferred();
    const deaf: Act = async (spec) => {
      commit(spec.cwd, 'a.ts');
      aIn.resolve();
      await gate.promise;
      return report();
    };
    const { a1 } = await carpoolBusy(h, [deaf], resets());
    await aIn.promise;
    const [aRun] = h.oneShots.live(new Set(['claude-carpool']));

    expect(await h.round.before()).toBeNull();
    expect(h.switches).toEqual([]);
    const audits = await switchAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      ok: false,
      before: { org: 'carpool' },
      after: { org: 'solo', stopped: [aRun] },
    });
    expect(audits[0]?.error).toContain('还有 1 个没收场');
    expect(await alertOf(ORG_SWITCH_ALERT)).toMatchObject({ level: 'alert', resolvedAt: null });

    // 放行：叫停之后它自己跑完了，照样是 done（不是 org_switch）
    gate.resolve();
    const a1End = await a1;
    expect(a1End.ok).toBe(true);
    expect((await runRow(a1End.runId))?.outcome).toBe('done');

    // 手上空了：下一轮切过去，提醒撤掉
    expect(await h.round.before()).toBe('solo');
    expect((await alertOf(ORG_SWITCH_ALERT))?.resolvedAt).not.toBeNull();
  });

  it('切号没成（帮手没切过去）：停下的那段不往用满的拼车上硬派、等额度；下一轮切成了，在独享上原分支重跑、跑完', async () => {
    let broken = true;
    const h = harness({ switchFails: () => (broken ? 'reclaude org use 没切过去' : undefined) });
    const aIn = deferred();
    const { a, aRoute, a1 } = await carpoolBusy(
      h,
      [runsUntilStopped('a-half.ts', aIn.resolve), finishes('a-rest.ts')],
      resets(),
    );
    await aIn.promise;

    expect(await h.round.before()).toBeNull();
    expect(h.switches).toEqual(['solo']);
    const a1End = await a1;
    expect(a1End).toMatchObject({ ok: false, outcome: 'org_switch' });
    const audits = await switchAudits();
    expect(audits).toEqual([
      expect.objectContaining({ ok: false, after: { org: 'solo', stopped: [a1End.runId] } }),
    ]);
    expect(audits[0]?.error).toContain('reclaude org use 没切过去');
    expect(audits[0]?.reason).toContain('切号没成，它们照样接着干');
    expect(await alertOf(ORG_SWITCH_ALERT)).toMatchObject({ resolvedAt: null });
    // 没切过去：原路再试不往用满的拼车上派，等额度（原分支上的东西都在）
    expect(judge(h, aRoute, a1End)).toMatchObject({ action: 'retry', rule: 'OS1' });
    expect(await pick(h, aRoute.routeId)).toMatchObject({ ok: false, waitFor: 'quota' });

    // 帮手好了：下一轮切成，在独享上重跑、跑完（帮手刚失败按 2 分钟退避，过了才再试，#194）
    broken = false;
    h.advance(3 * MIN);
    expect(await h.round.before()).toBe('solo');
    const a2 = await rerun(h, a, aRoute, 'claude-solo', evidence(a1End).message);
    expect(a2.res.ok).toBe(true);
    expect(git(a.worktreePath, 'log', '--format=%s', '-2').split('\n')).toEqual([
      'add a-rest.ts',
      'add a-half.ts',
    ]);
  });

  it('切过去重跑又被拒（独享也用满了）：按额度用满分流（QT1，不当切号），不切回用满的拼车，选路等额度', async () => {
    const h = harness();
    const soloResets = new Date(NOW.getTime() + 3 * H).toISOString();
    const aIn = deferred();
    const { aRoute, a1, a } = await carpoolBusy(
      h,
      [runsUntilStopped('a-half.ts', aIn.resolve), rejectedAt(soloResets)],
      resets(),
    );
    await aIn.promise;
    expect(await h.round.before()).toBe('solo');
    const a1End = await a1;

    const a2 = await rerun(h, a, aRoute, 'claude-solo', evidence(a1End).message);
    expect(a2.res).toMatchObject({ ok: false, evidence: { code: 'quota_exhausted', resetsAt: soloResets } });
    expect(judge(h, a2.route, a2.res)).toMatchObject({ action: 'retry', rule: 'QT1', wait: 'quota' });
    expect((await runRow(a2.res.runId))?.outcome).toBe('failed');

    // 两个池都用满：不切（切回去也是用满的），也没有人要停；选路等额度
    expect(await h.round.before()).toBeNull();
    expect(h.switches).toEqual(['solo']);
    expect(await pick(h, a2.route.routeId)).toMatchObject({ ok: false, waitFor: 'quota' });
    expect(h.oneShots.live(new Set(['claude-carpool', 'claude-solo']))).toEqual([]);
  });
});
