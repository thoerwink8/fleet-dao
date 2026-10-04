// 选路、报警、提问、人闸、计时、快照接真库（PGlite）：三种结果原样换成端口的；点名、续会话、被暂停的账号池、
// 没接上的执行方式各有去处；库里对不上的明确报错，不当成「没有路由」「记上了」。
import { randomUUID } from 'node:crypto';
import {
  finishRun,
  finishSessionRun,
  getSessionRun,
  markSessionRunStarted,
  notifications,
  openSessionRun,
  savePoolQuota,
  saveRouteProbe,
  sessionRuns,
  startRun,
  stepTimings,
  upsertAlert,
} from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import type { StageKind } from '@fleet-dao/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SLICE_MEMORY_HIGH_MB } from '../../src/limits.ts';
import type { PickRouteInput } from '../../src/ports.ts';
import type { UserExec } from '../../src/real/exec.ts';
import { type SessionOrgReader, sessionOrgReader } from '../../src/real/session-org.ts';
import { createStorePorts, ORG_READ_RETRY_SECONDS, poolHoldKey } from '../../src/real/store-ports.ts';
import {
  addCursorRoute,
  addGrokRoute,
  addTask,
  CARPOOL_ORG_ID,
  hangRoutes,
  MIN,
  NOW,
  type OrgListRig,
  orgListRig,
  orgListText,
  SOLO_ORG_ID,
  world,
} from './fixtures.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
});

const ctx = { signal: new AbortController().signal, heartbeat() {}, attempt: 1, lastHeartbeat: undefined };
/** 一般的选路用例：会话用户挂着拼车（夹具里两个 Claude 池都标成拼车）；读真实状态的在下面「会话用户挂的组织」里单测。 */
const onCarpool: SessionOrgReader = async () => ({ ok: true, org: 'carpool' });
const ports = (sessionOrg: SessionOrgReader = onCarpool) =>
  createStorePorts({ db: t.db, now: () => NOW, draw: () => 0.5, log: () => {}, sessionOrg });
const pick = (over: Partial<PickRouteInput> = {}, p = ports()) =>
  p.pickRoute(
    {
      taskId: randomUUID(),
      stage: 'triage',
      avoidRouteIds: [],
      avoidPoolIds: [],
      avoidModelIds: [],
      ...over,
    },
    ctx,
  );

describe('选路', () => {
  it('按路由两层的顺序派；两个 Claude 池是同一个会话用户，不再分主池、备池；派出去的带上组织类型（失败分流要）', async () => {
    await world(t.db);
    const r = await pick();
    expect(r).toMatchObject({
      ok: true,
      route: { routeId: 'solo', poolId: 'claude-solo', orgKind: 'carpool' },
    });
    const carpool = await pick({ avoidRouteIds: ['solo'] });
    expect(carpool).toMatchObject({ ok: true, route: { routeId: 'carpool', orgKind: 'carpool' } });
    // 写码这种重活照样派得出去：平时挂着的拼车池要接全部的活
    expect(await pick({ stage: 'execute', avoidRouteIds: ['solo'] })).toMatchObject({
      ok: true,
      route: { routeId: 'carpool' },
    });
  });

  it('会话用户挂着拼车组织：独享池挡着不派（写明为什么），拼车池照派；池名按组织类型分', async () => {
    await world(t.db);
    await t.client.query(`update pools set org_kind = 'solo' where id = 'claude-solo'`);
    expect(await pick({ stage: 'execute' })).toMatchObject({ ok: true, route: { routeId: 'carpool' } });
    const none = await pick({ stage: 'execute', avoidRouteIds: ['carpool'] });
    expect(none).toMatchObject({ ok: false, waitFor: 'none' });
    expect(!none.ok && none.detail).toContain(
      '会话用户现在挂的是拼车组织，Claude 订阅 · 独享要等切过去才能派',
    );
  });

  it('只派探针判在线的（#129）：探针写了离线的挡掉、写明原因；只剩它时派不出', async () => {
    await world(t.db);
    await saveRouteProbe(t.db, {
      routeId: 'solo',
      state: 'failed',
      at: NOW,
      detail: '登录失效：Not logged in · Please run /login',
    });
    const r = await pick();
    expect(r).toMatchObject({ ok: true, route: { routeId: 'carpool' } });
    expect(r.ok && r.why).toContain(
      '第 1 条 Claude 订阅 · 拼车 · Opus 5.5 · Claude Code：不在线（探活或熔断判的）',
    );
    expect(r.ok && r.why).not.toContain('在线是探针');
    const none = await pick({ avoidRouteIds: ['carpool'] });
    expect(none).toMatchObject({ ok: false, waitFor: 'none' });
    expect(!none.ok && none.detail).toContain('不在线（探活或熔断判的）');
  });

  it('在线是很久以前探的（探针可能停了）：照上一次的结论派，理由里写明是多久前的结论', async () => {
    await world(t.db);
    await saveRouteProbe(t.db, {
      routeId: 'solo',
      state: 'ok',
      at: new Date(NOW.getTime() - 120 * MIN),
      detail: '答上了：OK',
    });
    const r = await pick();
    expect(r).toMatchObject({ ok: true, route: { routeId: 'solo' } });
    expect(r.ok && r.why).toContain(
      '在线是探针 2 小时前的结论，之后它没再给新结论（探针可能停了），照上一次的结论派',
    );
    // 另一条 5 分钟前刚探过：理由里不提
    const fresh = await pick({ avoidRouteIds: ['solo'] });
    expect(fresh).toMatchObject({ ok: true, route: { routeId: 'carpool' } });
    expect(fresh.ok && fresh.why).not.toContain('在线是探针');
  });

  it('执行方式还没接上的路由不派；只剩它时派不出，理由里写明', async () => {
    await world(t.db, { order: ['luna', 'solo'] });
    expect(await pick()).toMatchObject({ ok: true, route: { routeId: 'solo' } });
    const none = await pick({ avoidRouteIds: ['solo'] });
    expect(none).toMatchObject({ ok: false, waitFor: 'none' });
    expect(!none.ok && none.detail).toContain('执行方式引擎还没接上');
  });

  it('被暂停的账号池（pool-hold:<池>）整池避开；续会话的那一单照样放过去，当试探', async () => {
    await world(t.db);
    await upsertAlert(t.db, {
      dedupeKey: poolHoldKey('claude-solo'),
      level: 'decision',
      taskId: null,
      title: '账号池 claude-solo 整池暂停',
      body: '在「法国」上以会话用户 fleet-agent-carpool 重跑 reclaude login',
    });
    expect(await pick()).toMatchObject({ ok: true, route: { routeId: 'carpool' } });
    const probe = await pick({ stickRouteId: 'solo' });
    expect(probe).toMatchObject({ ok: true, route: { routeId: 'solo' } });
    expect(probe.ok && probe.why).toContain('看修好了没有');
  });

  it('续同一个会话：暂时派不了就等它，不换到别的路由', async () => {
    await world(t.db);
    // 独享池的空位占满：三个已开工、没结束的会话。
    const { task } = await addTask(t.db);
    for (let i = 0; i < 3; i++) {
      await openSessionRun(t.db, {
        id: randomUUID(),
        taskId: task.id,
        subtaskId: null,
        stage: 'triage',
        routeId: 'solo',
        whyRoute: '占位',
        branch: null,
        queuedAt: new Date(NOW.getTime() - 10 * MIN),
        workflowId: null,
        runAsUser: 'fleet-agent-carpool',
        worktreePath: null,
      });
    }
    await t.db.update(sessionRuns).set({ startedAt: new Date(NOW.getTime() - 5 * MIN) });
    const r = await pick({ stickRouteId: 'solo' });
    expect(r).toMatchObject({ ok: false, waitFor: 'slot' });
    expect(!r.ok && r.detail).toContain('续同一个会话');
    // 不续会话就照常换到还有空位的拼车号。
    expect(await pick()).toMatchObject({ ok: true, route: { routeId: 'carpool' } });
  });

  it('三段的一次性会话（runs 里开着的行，#157）也占池的空位：两行三段 + 一行 Fusion 的会话占满上限 3，派下一个池；都满了等空位；收了一行又派得动', async () => {
    await world(t.db);
    const { task } = await addTask(t.db);
    /** 一行 Fusion 的会话 + 两行三段的一次性会话占满这条路由的池，交回动手那一行的编号。 */
    const fill = async (routeId: string) => {
      await startedRun(task.id, routeId, 'execute');
      const manual = randomUUID();
      const at = new Date(NOW.getTime() - 5 * MIN);
      await startRun(t.db, { id: manual, segment: 'manual', model: 'opus-5.5', routeId, startedAt: at });
      await startRun(t.db, { segment: 'verify', model: 'opus-5.5', routeId, startedAt: at });
      return manual;
    };
    const soloManual = await fill('solo');
    const second = await pick({ stage: 'execute' });
    expect(second).toMatchObject({ ok: true, route: { routeId: 'carpool' } });
    expect(second.ok && second.why).toContain('并发满了（3/3）');

    await fill('carpool');
    const full = await pick({ stage: 'execute' });
    expect(full).toMatchObject({ ok: false, waitFor: 'slot' });
    expect(!full.ok && full.detail).toContain('在等并发空位');

    await finishRun(t.db, { runId: soloManual, outcome: 'done' }, NOW);
    expect(await pick({ stage: 'execute' })).toMatchObject({ ok: true, route: { routeId: 'solo' } });
  });

  it('【故意造出的失败】runs 读不了（把表挪开，查它就报错，和库断在这一步一样）：选路抛错，不当成池空着派出去', async () => {
    await world(t.db);
    await t.client.exec('alter table runs rename to runs_unreadable');
    try {
      const err = await pick({ stage: 'execute' }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, '读不了 runs 却回了选路结果').not.toBeNull();
      // drizzle 外面包了一层「Failed query」，读 runs 报的那句在 cause 里
      const messages: string[] = [];
      for (let e: unknown = err; e instanceof Error; e = e.cause) messages.push(e.message);
      expect(messages.join('\n')).toContain('relation "runs" does not exist');
    } finally {
      await t.client.exec('alter table runs_unreadable rename to runs');
    }
  });

  it('点名的路由用不了（被避开）：照常选，并写明点名的为什么没用上', async () => {
    await world(t.db);
    const r = await pick({ preferRouteId: 'solo', avoidPoolIds: ['claude-solo'] });
    expect(r).toMatchObject({ ok: true, route: { routeId: 'carpool' } });
    expect(r.ok && r.why).toContain('点名的路由这次用不了');
    const unknown = await pick({ preferRouteId: 'nope' });
    expect(unknown.ok && unknown.why).toContain('不在这个用途的路由两层顺序里');
  });

  it('【故意造出的失败】用途没配模型顺序：派不出（不按编号乱挑），写明是没配、不是路由坏了', async () => {
    await world(t.db, { stages: [] });
    const r = await pick({ stage: 'plan' });
    expect(r).toMatchObject({ ok: false, waitFor: 'none' });
    expect(!r.ok && r.detail).toContain('规划阶段还没配模型顺序（路由两层「用途 → 模型」那一层是空的）');
    expect(!r.ok && r.detail).toContain('路由两层的配置缺口：用途 plan 没配模型顺序');
  });

  it('近 7 天的会话结局喂熔断：连着失败三次，这条路由熔断，派给下一条', async () => {
    await world(t.db);
    const { task } = await addTask(t.db);
    for (let i = 0; i < 3; i++) {
      const id = randomUUID();
      await openSessionRun(t.db, {
        id,
        taskId: task.id,
        subtaskId: null,
        stage: 'execute',
        routeId: 'solo',
        whyRoute: 'x',
        branch: null,
        queuedAt: new Date(NOW.getTime() - (10 - i) * MIN),
        workflowId: null,
        runAsUser: 'fleet-agent-carpool',
        worktreePath: null,
      });
      await markSessionRunStarted(t.db, {
        id,
        startedAt: new Date(NOW.getTime() - (9 - i) * MIN),
        sessionId: randomUUID(),
        handle: null,
      });
      // 最后一次失败在一分钟前：还在冷却里（第一次熔断冷却 10 分钟），不是半开。
      await finishSessionRun(t.db, {
        id,
        outcome: 'failed',
        endedAt: new Date(NOW.getTime() - (3 - i) * MIN),
        routeOutcome: 'fail',
      });
    }
    expect(await pick()).toMatchObject({ ok: true, route: { routeId: 'carpool' } });
  });

  describe('三段的一次性会话也喂熔断、战绩、半开试探（runs 里的行，#758）', () => {
    it('动手那一段在这条路由上连着失败三次、失败分流判是路由的错：熔断，派给下一条', async () => {
      await world(t.db);
      for (const minutesAgo of [3, 2, 1]) await oneShotEnded('solo', minutesAgo);
      expect(await pick({ stage: 'execute' })).toMatchObject({ ok: true, route: { routeId: 'carpool' } });
    });

    it('【故意造出的失败】切号停下、内存放不下没开跑（不算路由的错）连着三次，加一笔没下过结论的老行：不熔断，照派这一条', async () => {
      await world(t.db);
      await oneShotEnded('solo', 4, { outcome: 'org_switch', routeOutcome: 'neutral' });
      await oneShotEnded('solo', 3, { outcome: 'admission_blocked', routeOutcome: 'neutral' });
      await oneShotEnded('solo', 2, { outcome: 'org_switch', routeOutcome: 'neutral' });
      await oneShotEnded('solo', 1, { outcome: 'failed', routeOutcome: null });
      expect(await pick({ stage: 'execute' })).toMatchObject({ ok: true, route: { routeId: 'solo' } });
    });

    it('战绩算进三段的结局：动手按写码、验收按审查（SEGMENT_STAGE），各算各的用途', async () => {
      await world(t.db);
      // 10 笔里成 4 笔（低于五成，算战绩差）；每笔隔 7 小时（熔断看 6 小时内的失败率，一次只有一笔；连败最多两笔，不熔断）
      const pattern = ['fail', 'ok', 'fail', 'ok', 'fail', 'fail', 'ok', 'fail', 'fail', 'ok'] as const;
      let hoursAgo = 150;
      const poor = async (segment: 'manual' | 'verify') => {
        for (const routeOutcome of pattern) {
          await oneShotEnded('solo', hoursAgo * 60, {
            segment,
            outcome: routeOutcome === 'ok' ? 'done' : 'failed',
            routeOutcome,
          });
          hoursAgo -= 7;
        }
      };
      await poor('manual');
      const execute = await pick({ stage: 'execute' });
      expect(execute).toMatchObject({ ok: true, route: { routeId: 'carpool' } });
      expect(execute.ok && execute.why).toContain('战绩差（近期 10 次成 4 次），往后放');
      // 动手的结局不算进审查用途的战绩
      expect(await pick({ stage: 'review' })).toMatchObject({ ok: true, route: { routeId: 'solo' } });

      await poor('verify');
      const review = await pick({ stage: 'review' });
      expect(review).toMatchObject({ ok: true, route: { routeId: 'carpool' } });
      expect(review.ok && review.why).toContain('战绩差（近期 10 次成 4 次），往后放');
    });

    it('熔断半开时，这条路由上开着的三段会话就是在途的试探：只放一个', async () => {
      await world(t.db);
      // 40 分钟前连败三次熔断，冷却 10 分钟上下，现在半开
      for (const minutesAgo of [42, 41, 40]) await oneShotEnded('solo', minutesAgo);
      const trial = await pick({ stage: 'execute' });
      expect(trial).toMatchObject({ ok: true, route: { routeId: 'solo' } });
      expect(trial.ok && trial.why).toContain('熔断半开，这一单当试探');

      // 试探派出去了（三段的一次性会话开跑留下那一行）：再来一单不再放试探，派给下一条
      await startRun(t.db, {
        segment: 'manual',
        model: 'opus-5.5',
        routeId: 'solo',
        startedAt: new Date(NOW.getTime() - MIN),
      });
      expect(await pick({ stage: 'execute' })).toMatchObject({ ok: true, route: { routeId: 'carpool' } });
    });

    it('【故意造出的失败】runs 读不了：判全熔断明确报错，不当成没有三段的会话', async () => {
      await world(t.db);
      await t.client.exec('alter table runs rename to runs_unreadable');
      try {
        const err = await ports()
          .stageAllOpen('execute')
          .then(
            () => null,
            (e: unknown) => e,
          );
        expect(err, '读不了 runs 却判出了全熔断与否').not.toBeNull();
        const messages: string[] = [];
        for (let e: unknown = err; e instanceof Error; e = e.cause) messages.push(e.message);
        expect(messages.join('\n')).toContain('relation "runs" does not exist');
      } finally {
        await t.client.exec('alter table runs_unreadable rename to runs');
      }
    });
  });

  it('选路的输入认不出（这里是越界的调度策略）：抛 ROUTING_INPUT，不当成「没有路由」', async () => {
    await world(t.db);
    const bad = createStorePorts({
      db: t.db,
      now: () => NOW,
      routingPolicy: { trialRatio: 5 },
      log: () => {},
      sessionOrg: onCarpool,
    });
    await expect(
      bad.pickRoute(
        { taskId: randomUUID(), stage: 'execute', avoidRouteIds: [], avoidPoolIds: [], avoidModelIds: [] },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'ROUTING_INPUT' });
  });

  it('关掉的路由（路由两层里它在模型下的开关）不派，写明关着', async () => {
    await world(t.db);
    await t.client.query("update routing_catalog set enabled = false where route_id = 'solo'");
    const r = await pick();
    expect(r).toMatchObject({ ok: true, route: { routeId: 'carpool' } });
    expect(r.ok && r.why).toContain('这条路由在它的模型下关着（路由两层的开关）');
  });

  it('派活时按内存做准入（#219）：父节点增长过大被挡、恢复后又派得动；读不出来不闷头派', async () => {
    await world(t.db);
    // 默认本机开发（测试没接 memoryAdmission）：跳过准入，照派。这守住「本机没有 cgroup 不拦」的退路。
    expect((await pick()).ok).toBe(true);

    // 顶住：父节点现在用到高水位 - 1M，放不下一份新会话预留。
    const used = { mb: SLICE_MEMORY_HIGH_MB - 1 };
    const gated = createStorePorts({
      db: t.db,
      now: () => NOW,
      draw: () => 0.5,
      log: () => {},
      sessionOrg: onCarpool,
      memoryAdmission: {
        readText: async () => String(used.mb * 1024 * 1024),
        cgroupRoot: '/sys/fs/cgroup',
        slicePath: 'fleet.slice/fleet-agents.slice',
        sliceHighMb: SLICE_MEMORY_HIGH_MB,
        reservePerSessionMb: 2048,
      },
    });
    const blocked = await pick({}, gated);
    expect(blocked).toMatchObject({ ok: false, waitFor: 'slot' });
    expect(!blocked.ok && blocked.detail).toContain('在等内存');
    expect(!blocked.ok && blocked.detail).toContain('fleet-agents.slice');

    // 同一份依赖：父节点回落，余量放得下一份预留，第二发就派出去了——「被挡 → 恢复后又派得动」。
    used.mb = SLICE_MEMORY_HIGH_MB - 2200;
    expect(await pick({}, gated)).toMatchObject({ ok: true, route: { routeId: 'solo' } });

    // 文件在、但读不出来：明确的失败，不闷头派。这是需求.md「算不出上限要明确报错、不派」的那一格。
    const errored = createStorePorts({
      db: t.db,
      now: () => NOW,
      draw: () => 0.5,
      log: () => {},
      sessionOrg: onCarpool,
      memoryAdmission: {
        readText: async () => {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        },
        cgroupRoot: '/sys/fs/cgroup',
        slicePath: 'fleet.slice/fleet-agents.slice',
        sliceHighMb: SLICE_MEMORY_HIGH_MB,
        reservePerSessionMb: 2048,
      },
    });
    await expect(pick({}, errored)).rejects.toMatchObject({
      name: 'PortError',
      code: 'MEMORY_ADMISSION_UNREADABLE',
    });

    // 本机开发（cgroup 那一层不在）：跳过，不拦派。
    const skipped = createStorePorts({
      db: t.db,
      now: () => NOW,
      draw: () => 0.5,
      log: () => {},
      sessionOrg: onCarpool,
      memoryAdmission: {
        readText: async () => {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
        cgroupRoot: '/sys/fs/cgroup',
        slicePath: 'fleet.slice/fleet-agents.slice',
        sliceHighMb: SLICE_MEMORY_HIGH_MB,
        reservePerSessionMb: 2048,
      },
    });
    expect(await pick({}, skipped)).toMatchObject({ ok: true, route: { routeId: 'solo' } });
  });
});

describe('全熔断只读判定（stageAllOpen）：不写库、不报警', () => {
  /** 这条路由连着失败三次。最近一次距现在 lastEndedMinutesAgo 分钟：1 = 还在冷却里，40 = 冷却过了（半开）。 */
  async function tripBreaker(routeId: string, taskId: string, lastEndedMinutesAgo: number) {
    for (let i = 0; i < 3; i++) {
      const id = randomUUID();
      const ended = new Date(NOW.getTime() - (lastEndedMinutesAgo + (2 - i)) * MIN);
      await openSessionRun(t.db, {
        id,
        taskId,
        subtaskId: null,
        stage: 'execute',
        routeId,
        whyRoute: 'x',
        branch: null,
        queuedAt: new Date(ended.getTime() - 2 * MIN),
        workflowId: null,
        runAsUser: 'fleet-agent-carpool',
        worktreePath: null,
      });
      await markSessionRunStarted(t.db, {
        id,
        startedAt: new Date(ended.getTime() - MIN),
        sessionId: randomUUID(),
        handle: null,
      });
      await finishSessionRun(t.db, { id, outcome: 'failed', endedAt: ended, routeOutcome: 'fail' });
    }
  }

  it('两条都熔断：判全熔断；提醒既不新建，已有那条的 updated_at、正文、resolved_at 也不变（判一次不刷新、不重开）', async () => {
    await world(t.db);
    const { task } = await addTask(t.db);
    await tripBreaker('solo', task.id, 1);
    await tripBreaker('carpool', task.id, 1);
    const p = ports();
    expect(await p.stageAllOpen('execute')).toEqual({ allOpen: true });
    expect(await t.db.select().from(notifications)).toEqual([]);

    await upsertAlert(t.db, {
      dedupeKey: 'routing:all-open:execute',
      level: 'alert',
      taskId: null,
      title: '「execute」阶段的路由全都熔断了',
      body: '原来的正文',
    });
    const before = await t.db.select().from(notifications);
    expect(before).toHaveLength(1);
    expect(await p.stageAllOpen('execute')).toEqual({ allOpen: true });
    expect(await t.db.select().from(notifications)).toEqual(before);

    await t.client.query(
      `update notifications set resolved_at = $1::timestamptz, resolved_by = 'founder-a' where dedupe_key = 'routing:all-open:execute'`,
      [NOW.toISOString()],
    );
    const resolved = await t.db.select().from(notifications);
    expect(resolved[0]?.resolvedAt).not.toBeNull();
    expect(await p.stageAllOpen('execute')).toEqual({ allOpen: true });
    expect(await t.db.select().from(notifications)).toEqual(resolved);
  });

  it('其中一条过了冷却（半开、能放试探）：不是全熔断', async () => {
    await world(t.db);
    const { task } = await addTask(t.db);
    await tripBreaker('solo', task.id, 1);
    await tripBreaker('carpool', task.id, 40);
    const check = await ports().stageAllOpen('execute');
    expect(check.allOpen).toBe(false);
    if (!check.allOpen) {
      expect(check.detail).toContain('第 2 条');
      expect(check.detail).toContain('Claude 订阅 · 拼车');
    }
  });

  it('【故意造出的失败】库读失败：抛错，不返回 false', async () => {
    const broken = await createTestDb();
    await broken.close();
    const p = createStorePorts({
      db: broken.db,
      now: () => NOW,
      log: () => {},
      sessionOrg: onCarpool,
    });
    await expect(p.stageAllOpen('execute')).rejects.toThrow();
  });

  it('【故意造出的失败】组织还没读完：抛错，不返回 false', async () => {
    await world(t.db);
    const pending: SessionOrgReader = async () => ({ ok: false, why: '还在同步配置', pending: true });
    await expect(ports(pending).stageAllOpen('execute')).rejects.toMatchObject({
      name: 'PortError',
      code: 'ORG_UNREAD',
    });
  });
});

describe('会话用户挂的组织：选路前现读（以会话用户跑 reclaude org list，不假定挂拼车）', () => {
  let rig: OrgListRig;
  beforeEach(async () => {
    rig = orgListRig();
    await world(t.db);
    // 真实的样子：独享池挂在独享组织上、拼车池挂在拼车组织上
    await t.client.query(`update pools set org_kind = 'solo' where id = 'claude-solo'`);
  });
  const onRig = () => ports(rig.reader());
  /** 派不出的原因里不许带组织编号、邮箱（它会进库、上驾驶舱、上单子）。 */
  const clean = (text: string | false) => {
    for (const bad of [String(CARPOOL_ORG_ID), String(SOLO_ORG_ID), 'fleet-test@localhost']) {
      expect(text).not.toContain(bad);
    }
  };

  it('挂拼车：派拼车池；独享池挡着，写明挂的是拼车', async () => {
    rig.answer('carpool');
    const r = await pick({ stage: 'execute' }, onRig());
    expect(r).toMatchObject({ ok: true, route: { routeId: 'carpool', poolId: 'claude-carpool' } });
    expect(r.ok && r.why).toContain('会话用户现在挂的是拼车组织，Claude 订阅 · 独享要等切过去才能派');
  });

  it('挂独享：派独享池；拼车池挡掉，只剩它时等切号（引擎下一轮切回拼车）、不挂起；引擎不切回时派不出、写明为什么', async () => {
    rig.answer('solo');
    const p = onRig();
    expect(await pick({ stage: 'execute' }, p)).toMatchObject({
      ok: true,
      route: { routeId: 'solo', poolId: 'claude-solo' },
    });
    // 拼车没用满：引擎下一轮路由探针就切回拼车（和切号同一个判法，#335）——等得来，不是派不出
    const wait = await pick({ stage: 'execute', avoidRouteIds: ['solo'] }, p);
    expect(wait).toMatchObject({ ok: false, waitFor: 'slot' });
    expect(!wait.ok && wait.detail).toContain(
      '会话用户现在挂的是独享组织，Claude 订阅 · 拼车要等切过去才能派；引擎下一轮路由探针切过去（挂着独享；拼车没有用满的读数',
    );
    // 拼车池整池暂停着：引擎不切回——派不出，写明挂的是独享、引擎为什么不切
    await upsertAlert(t.db, {
      dedupeKey: poolHoldKey('claude-carpool'),
      level: 'decision',
      taskId: null,
      title: '账号池 claude-carpool 整池暂停：登录失效',
      body: '要重新登录',
    });
    const none = await pick({ stage: 'execute', avoidRouteIds: ['solo'] }, p);
    expect(none).toMatchObject({ ok: false, waitFor: 'none' });
    expect(!none.ok && none.detail).toContain(
      '会话用户现在挂的是独享组织，Claude 订阅 · 拼车要等切过去才能派；引擎现在不打算切过去（挂着独享；拼车池整池暂停着（等人处理），先不切回）',
    );
    // 点名要拼车池的也一样挡（换不过去，不偷偷派）
    const named = await pick({ stage: 'execute', preferRouteId: 'carpool' }, p);
    expect(named).toMatchObject({ ok: true, route: { routeId: 'solo' } });
    expect(named.ok && named.why).toContain('点名的路由这次用不了');
  });

  it('【故意造出的失败】org list 读不到（没登录、退出码不对、起不来、超时）：两个 Claude 池都不派，写明「会话用户挂的组织认不出」，不拿拼车顶', async () => {
    const p = onRig();
    for (const [answer, cause] of [
      [{ code: 1, stderr: 'Error: not logged in' }, 'reclaude 报登录失效'],
      [{ code: 3, stderr: `org ${SOLO_ORG_ID}: boom` }, '退出码 3'],
      [{ code: null, spawnError: 'spawn sudo ENOENT' }, '没起来'],
      [{ code: null, timedOut: true }, '超时被停'],
    ] as const) {
      rig.answer(answer);
      const r = await pick({ stage: 'execute' }, p);
      expect(r).toMatchObject({ ok: false, waitFor: 'none' });
      expect(!r.ok && r.detail).toContain(
        '会话用户挂的组织认不出（以会话用户 fleet-agent-carpool 跑 reclaude org list',
      );
      expect(!r.ok && r.detail).toContain(cause);
      expect(!r.ok && r.detail).toContain('Claude 订阅 · 拼车不派');
      expect(!r.ok && r.detail).toContain('Claude 订阅 · 独享不派');
      clean(!r.ok && r.detail);
    }
  });

  it('【故意造出的失败】org list 认不出（没有带 * 的行、类型认不出、一行组织都没有）：同样认不出，不派 Claude 池，原因里不带编号', async () => {
    const p = onRig();
    for (const [stdout, cause] of [
      [orgListText(null), '没有带 * 的行'],
      [orgListText('solo').replace('\tpersonal\t', '\tenterprise\t'), '类型认不出'],
      ['Syncing config…\n', '一个组织都认不出'],
    ] as const) {
      rig.answer({ stdout });
      const r = await pick({ stage: 'execute' }, p);
      expect(r).toMatchObject({ ok: false, waitFor: 'none' });
      expect(!r.ok && r.detail).toContain('会话用户挂的组织认不出（');
      expect(!r.ok && r.detail).toContain(cause);
      clean(!r.ok && r.detail);
    }
  });

  it('认不出时别的渠道照派：派到 Cursor，理由里写明 Claude 池为什么没派', async () => {
    const { routeId } = await addCursorRoute(t.db, { stages: ['execute'] });
    rig.answer({ code: 1, stderr: 'not logged in' });
    const r = await pick({ stage: 'execute' }, onRig());
    expect(r).toMatchObject({ ok: true, route: { routeId } });
    expect(r.ok && r.why).toContain(
      '会话用户挂的组织认不出（以会话用户 fleet-agent-carpool 跑 reclaude org list',
    );
  });

  it('还没读完（reclaude 首跑同步配置）：不算认不出、不挂起，过一会儿再选；读完了下一次就用上', async () => {
    let release: (() => void) | undefined;
    const slow: UserExec = async (command) => {
      await new Promise<void>((r) => {
        release = r;
      });
      return rig.exec(command);
    };
    rig.answer('solo');
    const p = createStorePorts({
      db: t.db,
      now: () => NOW,
      draw: () => 0.5,
      log: () => {},
      sessionOrg: sessionOrgReader({ exec: slow, user: 'fleet-agent-carpool', reclaude: ['/x/reclaude'] }),
      orgReadWaitMs: 5,
    });
    const r = await pick({ stage: 'execute' }, p);
    expect(r).toMatchObject({ ok: false, waitFor: 'slot', retryAfterSeconds: ORG_READ_RETRY_SECONDS });
    expect(!r.ok && r.detail).toContain('会话用户挂的组织这会儿定不下来，过一会儿再选');
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await pick({ stage: 'execute' }, p)).toMatchObject({ ok: true, route: { routeId: 'solo' } });
  });

  it('正在切号（切号那一步让选路停下）：不派、不挂起，过一会儿再选、写明正在切；切完解除，下一次现读切过去的组织', async () => {
    rig.answer('carpool');
    const org = rig.reader({ ttlMs: 60_000 });
    const p = ports(org);
    expect(await pick({ stage: 'execute' }, p)).toMatchObject({ ok: true, route: { routeId: 'carpool' } });
    const release = org.hold('正在把会话用户从拼车组织切到独享组织');
    const calls = rig.calls.length;
    const r = await pick({ stage: 'execute' }, p);
    expect(r).toMatchObject({ ok: false, waitFor: 'slot', retryAfterSeconds: ORG_READ_RETRY_SECONDS });
    expect(!r.ok && r.detail).toBe(
      '会话用户挂的组织这会儿定不下来，过一会儿再选：正在把会话用户从拼车组织切到独享组织',
    );
    // 停着的时候不读
    expect(rig.calls).toHaveLength(calls);
    rig.answer('solo');
    // 切号那一步经帮手切过了（real/org-switch.ts 在解除之前告诉读法）
    await org.engineSwitched();
    release();
    // 解除时丢掉留着的「拼车」（留 60 秒也不用它），现读出独享：引擎切的号，切完读成的就是新起点
    expect(await pick({ stage: 'execute' }, p)).toMatchObject({ ok: true, route: { routeId: 'solo' } });
    expect(rig.calls).toHaveLength(calls + 1);
  });

  it('候选里没有带组织类型的池：不读（省一次以会话用户起 scope）', async () => {
    await t.client.query(`update pools set org_kind = null, run_as_user = null where id like 'claude-%'`);
    rig.answer({ code: 1, stderr: 'not logged in' });
    expect(await pick({ stage: 'execute' }, onRig())).toMatchObject({ ok: true, route: { routeId: 'solo' } });
    expect(rig.calls).toHaveLength(0);
  });

  it('【故意造出的失败】两次读之间组织变了、没有引擎切号（#335）：选路不照新读数派、不挂起（过 30 秒再选），原因里是前后两次读数；读数回到拼车照常派', async () => {
    let clock = NOW.getTime();
    const events: string[] = [];
    const org = rig.reader({
      ttlMs: 0,
      now: () => new Date(clock),
      onEvent: (e) => void events.push(e.kind === 'settled' ? `settled:${e.how}` : e.kind),
    });
    const p = createStorePorts({
      db: t.db,
      now: () => new Date(clock),
      draw: () => 0.5,
      log: () => {},
      sessionOrg: org,
    });
    rig.answer('carpool');
    expect(await pick({ stage: 'execute' }, p)).toMatchObject({ ok: true, route: { routeId: 'carpool' } });
    clock += 2 * MIN;
    rig.answer('solo');
    const r = await pick({ stage: 'execute' }, p);
    expect(r).toMatchObject({ ok: false, waitFor: 'slot', retryAfterSeconds: ORG_READ_RETRY_SECONDS });
    expect(!r.ok && r.detail).toBe(
      '会话用户挂的组织这会儿定不下来，过一会儿再选：会话用户挂的组织和上一次读的不一样，引擎没切过号：' +
        '09-25 16:00:00 选路读到拼车，09-25 16:02:00 选路读到独享（北京时间）。等读数定下来再照它：连着 2 分钟都是独享才认，回到拼车就照常',
    );
    clean(!r.ok && r.detail);
    expect(events).toEqual(['drift']);
    clock += 30_000;
    rig.answer('carpool');
    expect(await pick({ stage: 'execute' }, p)).toMatchObject({ ok: true, route: { routeId: 'carpool' } });
    expect(events).toEqual(['drift', 'settled:back']);
  });

  it('续会话的那条只差切号（挂着独享、拼车到点才切回）：不等它，照常选到挂着的独享（换池 fork 续上，#59）', async () => {
    rig.answer('solo');
    const resets = new Date(NOW.getTime() + 2 * 60 * MIN);
    await savePoolQuota(
      t.db,
      {
        poolId: 'claude-carpool',
        readAt: NOW.toISOString(),
        complete: false,
        windows: [
          {
            poolId: 'claude-carpool',
            window: '5h',
            label: 'five_hour',
            unit: 'percent',
            utilization: 1,
            resetsAt: resets.toISOString(),
            reading: 'measured',
            readAt: NOW.toISOString(),
            source: 'test',
          },
        ],
      },
      { now: NOW },
    );
    const r = await pick({ stage: 'execute', stickRouteId: 'carpool' }, onRig());
    expect(r).toMatchObject({ ok: true, route: { routeId: 'solo', poolId: 'claude-solo' } });
    expect(r.ok && r.why).toContain('续会话的路由要等切号（');
    expect(r.ok && r.why).toContain('到点再切回');
  });

  it('【故意造出的失败】引擎切号的打算读不了（库没查成）：选路照常报错，不当成「不打算切」挂起、也不当成等得来', async () => {
    rig.answer('solo');
    const p = createStorePorts({
      db: t.db,
      now: () => NOW,
      draw: () => 0.5,
      log: () => {},
      sessionOrg: rig.reader(),
      orgPlan: async () => {
        throw new Error('sessionOrgFacts：连接断了');
      },
    });
    await expect(pick({ stage: 'execute' }, p)).rejects.toThrow('sessionOrgFacts：连接断了');
    // 候选里都是挂着的那个组织的池（没有要问打算的）：不问，照常派
    await t.client.query(`update pools set org_kind = 'solo' where id = 'claude-carpool'`);
    expect(await pick({ stage: 'execute' }, p)).toMatchObject({ ok: true, route: { routeId: 'solo' } });
  });

  it('探针在另一个组织挂着时没探的那条（库里 probe_org 是另一个组织）：它的组织挂上以后等下一轮探针，不挂起；探了没通的照样不在线', async () => {
    // 上一轮（5 分钟前）挂着拼车：独享那条写的是「不探」、记下那时挂的是拼车
    await saveRouteProbe(t.db, {
      routeId: 'solo',
      state: 'skipped',
      at: new Date(NOW.getTime() - 5 * MIN),
      detail: '会话用户现在挂的是拼车组织：这时探独享池，扣的是拼车的额度、探的也是拼车，不探',
      org: 'carpool',
    });
    await upsertAlert(t.db, {
      dedupeKey: poolHoldKey('claude-carpool'),
      level: 'decision',
      taskId: null,
      title: '账号池 claude-carpool 整池暂停：登录失效',
      body: '要重新登录',
    });
    rig.answer('solo');
    const r = await pick({ stage: 'execute' }, onRig());
    expect(r).toMatchObject({ ok: false, waitFor: 'slot' });
    expect(!r.ok && r.detail).toContain(
      '会话用户挂的是拼车组织，没探它；现在挂的是独享组织，等下一轮路由探针在独享组织下探过再派',
    );
    // 在独享下探了、没通：照样不在线，派不出（写明）
    await saveRouteProbe(t.db, {
      routeId: 'solo',
      state: 'failed',
      at: NOW,
      detail: '登录失效：Not logged in',
      org: 'solo',
    });
    const none = await pick({ stage: 'execute' }, onRig());
    expect(none).toMatchObject({ ok: false, waitFor: 'none' });
    expect(!none.ok && none.detail).toContain('不在线（探活或熔断判的）');
  });
});

/** 这个账号池的额度读成了、还宽（5 小时窗、周窗都只用了一成）。 */
async function roomyQuota(poolId: string) {
  await savePoolQuota(
    t.db,
    {
      poolId,
      readAt: new Date(NOW.getTime() - MIN).toISOString(),
      complete: true,
      windows: (['5h', '7d'] as const).map((window) => ({
        poolId,
        window,
        label: window === '5h' ? 'five_hour' : 'seven_day',
        unit: 'percent' as const,
        utilization: 0.1,
        reading: 'measured' as const,
        readAt: new Date(NOW.getTime() - MIN).toISOString(),
        source: 'test',
      })),
    },
    { now: NOW },
  );
}

/** 这条路由探了没通（探针写的结论）：在线由它定，选路当「死」挡掉。 */
const probeFailed = (routeId: string) =>
  saveRouteProbe(t.db, { routeId, state: 'failed', at: NOW, detail: '连不上：ECONNREFUSED' });

describe('路由两层选路（#574）：先按用途的模型顺序、再按模型下的路由顺序；死的跳过，不知道的排在活的后面，全死明说派不出', () => {
  /** 写码：Opus 排第一（下面 solo、carpool 两条），Grok 4.7 排第二（一条）；三条都探通了、额度都读成了还宽。 */
  async function twoModels() {
    await world(t.db, { stages: ['execute'] });
    const { routeId: grok } = await addGrokRoute(t.db, { stages: ['execute'] });
    await roomyQuota('grok');
    return { grok };
  }

  it('第一顺位死了跳到第二：模型下第一条死了先派同模型的第二条，整个模型都死了才派下一个模型', async () => {
    const { grok } = await twoModels();
    expect(await pick({ stage: 'execute' })).toMatchObject({ ok: true, route: { routeId: 'solo' } });
    await probeFailed('solo');
    const second = await pick({ stage: 'execute' });
    expect(second).toMatchObject({ ok: true, route: { routeId: 'carpool' } });
    expect(second.ok && second.why).toContain('写码阶段第 2 条');
    await probeFailed('carpool');
    const next = await pick({ stage: 'execute' });
    expect(next).toMatchObject({ ok: true, route: { routeId: grok, modelId: 'grok-4.7', family: 'grok' } });
    // 为什么跳过前两条写在理由里：都是探针判不在线
    expect(next.ok && next.why).toContain('写码阶段第 3 条');
    expect(next.ok && next.why).toContain('第 1 条 Claude 订阅 · 拼车 · Opus 5.5 · Claude Code：不在线');
  });

  it('【故意造出的失败】全死：一条都派不出、又等不来，回 waitFor none，原因逐条写明，不拿空的、默认的顶', async () => {
    const { grok } = await twoModels();
    for (const routeId of ['solo', 'carpool', grok]) await probeFailed(routeId);
    const none = await pick({ stage: 'execute' });
    expect(none).toMatchObject({ ok: false, waitFor: 'none' });
    const detail = !none.ok ? none.detail : '';
    expect(detail).toContain('写码阶段没有能派的路由');
    for (const n of [1, 2, 3])
      expect(detail).toMatch(new RegExp(`第 ${n} 条 [^；]*：不在线（探活或熔断判的）`));
    // 开关全关也一样：死在「关着」上，照样写明
    await t.client.query(
      "update routes set alive = true, probe_state = 'ok' where id in ('solo', 'carpool')",
    );
    await t.client.query("update routing_catalog set enabled = false where model_id = 'opus-5.5'");
    const off = await pick({ stage: 'execute' });
    expect(off).toMatchObject({ ok: false, waitFor: 'none' });
    expect(!off.ok && off.detail).toContain('这条路由在它的模型下关着（路由两层的开关）');
  });

  it('不知道排后面：排第一的模型额度没读成（unknown），先派读成了的第二个模型；它也死了才派额度未知的，并写明', async () => {
    const { grok } = await twoModels();
    // Opus 那两个池的额度从没读成：不挡，但排在读到了的后面
    await t.client.query("delete from quota_windows where pool_id in ('claude-solo', 'claude-carpool')");
    await t.client.query(
      "update pools set last_read_ok_at = null where id in ('claude-solo', 'claude-carpool')",
    );
    const live = await pick({ stage: 'execute' });
    expect(live).toMatchObject({ ok: true, route: { routeId: grok } });
    expect(live.ok && live.why).toContain('额度未知（没读成或读数过期），排在读到了的后面');
    await probeFailed(grok);
    const unknown = await pick({ stage: 'execute' });
    expect(unknown).toMatchObject({ ok: true, route: { routeId: 'solo' } });
    expect(unknown.ok && unknown.why).toContain('额度未知（没读成或读数过期）');
  });

  it('用途里排了模型、模型下却一条路由都没有：照实写进原因（配置缺口），不当成路由都坏了', async () => {
    await world(t.db, { stages: ['execute'] });
    await t.client.query(
      "insert into routing_purpose_models (purpose, model_id, position) values ('execute', 'kimi-k3', 5)",
    );
    for (const routeId of ['solo', 'carpool']) await probeFailed(routeId);
    const none = await pick({ stage: 'execute' });
    expect(none).toMatchObject({ ok: false, waitFor: 'none' });
    expect(!none.ok && none.detail).toContain(
      '路由两层的配置缺口：模型 kimi-k3 没有路由（routing_catalog 里一条都没有）',
    );
  });
});

describe('流程配置里这一步的模型顺序（Fusion 的 models）', () => {
  /** 写码：路由两层里 Opus 排最前（下面 solo、carpool），Cursor Auto 第 9 位，Kimi k3（钉住它的 cursor 路由）第 10 位。 */
  async function fusionWorld() {
    await world(t.db, { stages: ['execute'] });
    const auto = (await addCursorRoute(t.db, { stages: ['execute'] })).routeId;
    const kimi = (await addCursorRoute(t.db, { modelId: 'kimi-k3', upstreamModel: 'kimi-k3' })).routeId;
    await hangRoutes(t.db, ['execute'], [kimi], 10);
    // cursor 池的额度也读成了、还宽（额度未知的会排到读到了的后面，这里只看模型顺序）
    await savePoolQuota(
      t.db,
      {
        poolId: 'cursor',
        readAt: new Date(NOW.getTime() - MIN).toISOString(),
        complete: true,
        windows: (['5h', '7d'] as const).map((window) => ({
          poolId: 'cursor',
          window,
          label: window === '5h' ? 'five_hour' : 'seven_day',
          unit: 'percent' as const,
          utilization: 0.1,
          reading: 'measured' as const,
          readAt: new Date(NOW.getTime() - MIN).toISOString(),
          source: 'test',
        })),
      },
      { now: NOW },
    );
    return { auto, kimi };
  }

  it('只派配置里这几个模型的路由：先按配置的先后（压过路由两层里排在前面的），同一个模型的照路由两层的先后', async () => {
    const { auto, kimi } = await fusionWorld();
    expect(await pick({ stage: 'execute', models: ['cursor-auto', 'kimi-k3', 'opus-5.5'] })).toMatchObject({
      ok: true,
      route: { routeId: auto },
    });
    expect(await pick({ stage: 'execute', models: ['kimi-k3', 'cursor-auto'] })).toMatchObject({
      ok: true,
      route: { routeId: kimi },
    });
    expect(await pick({ stage: 'execute', models: ['opus-5.5'] })).toMatchObject({
      ok: true,
      route: { routeId: 'solo' },
    });
    // 没带模型顺序的（三段一条龙）照路由两层走
    expect(await pick({ stage: 'execute' })).toMatchObject({ ok: true, route: { routeId: 'solo' } });
  });

  it('【故意造出的失败】配置里的模型只剩被避开的、或在这个阶段一条路由都没有：派不出、写明是流程配置的模型，不拿别的模型顶', async () => {
    const { kimi } = await fusionWorld();
    const avoided = await pick({ stage: 'execute', models: ['kimi-k3'], avoidRouteIds: [kimi] });
    expect(avoided).toMatchObject({ ok: false, waitFor: 'none' });
    const none = await pick({ stage: 'execute', models: ['deepseek-flash'] });
    expect(none).toMatchObject({ ok: false, waitFor: 'none' });
    expect(!none.ok && none.detail).toContain(
      '流程配置里这一步的模型（deepseek-flash）在写码阶段的路由两层顺序里没有接上的路由',
    );
    const empty = await pick({ stage: 'execute', models: [] });
    expect(!empty.ok && empty.detail).toContain('流程配置里这一步的模型（一个都没配）');
  });

  it('人点名的路由不受配置限制；续会话的路由模型不在配置里：照配置选，写明为什么没续', async () => {
    const { kimi } = await fusionWorld();
    const named = await pick({ stage: 'execute', models: ['kimi-k3'], preferRouteId: 'solo' });
    expect(named).toMatchObject({ ok: true, route: { routeId: 'solo' } });
    expect(named.ok && named.why).toContain('点名的路由');
    const stuck = await pick({ stage: 'execute', models: ['kimi-k3'], stickRouteId: 'solo' });
    expect(stuck).toMatchObject({ ok: true, route: { routeId: kimi } });
    expect(stuck.ok && stuck.why).toContain('续会话的路由 solo 的模型不在流程配置这一步的模型里');
  });
});

describe('报警、提问、人闸', () => {
  it('报警按 dedupe_key 一张卡；合并队列这类没有任务的不挂任务', async () => {
    await world(t.db);
    const { task } = await addTask(t.db);
    const p = ports();
    const first = await p.raiseAlert(
      { taskId: task.id, level: 'stuck', title: '卡住了', detail: '第一次', dedupeKey: 'wf:park:1' },
      ctx,
    );
    const again = await p.raiseAlert(
      { taskId: task.id, level: 'stuck', title: '还卡着', detail: '第二次', dedupeKey: 'wf:park:1' },
      ctx,
    );
    expect(again.alertId).toBe(first.alertId);
    await p.raiseAlert(
      { taskId: '', level: 'info', title: '合并队列判断出错', detail: 'x', dedupeKey: 'mq:decide' },
      ctx,
    );
    const rows = await t.db.select().from(notifications);
    expect(rows.map((r) => [r.dedupeKey, r.level, r.taskId]).sort()).toEqual(
      [
        ['mq:decide', 'alert', null],
        ['wf:park:1', 'alert', task.id],
      ].sort(),
    );
  });
});

describe('计时、快照', () => {
  it('活动、等待各记一行，重试重写同一笔不重复', async () => {
    await world(t.db);
    const p = ports();
    const activity = {
      kind: 'activity' as const,
      workflowId: 'req:acme/widgets#12',
      runId: 'temporal-run-1',
      workflowType: 'requirementWorkflow',
      activity: 'pickRoute',
      attempt: 1,
      scheduledAt: NOW.toISOString(),
      startedAt: NOW.toISOString(),
      endedAt: new Date(NOW.getTime() + 20).toISOString(),
      queueMs: 0,
      runMs: 20,
      outcome: 'ok' as const,
    };
    await p.recordTiming(activity, ctx);
    await p.recordTiming(activity, ctx);
    await p.recordTiming(
      {
        kind: 'wait',
        workflowId: 'req:acme/widgets#12',
        runId: 'temporal-run-1',
        workflowType: 'requirementWorkflow',
        waitFor: 'slot',
        detail: '等空位',
        startedAt: NOW.toISOString(),
        endedAt: new Date(NOW.getTime() + MIN).toISOString(),
        waitMs: MIN,
      },
      ctx,
    );
    const rows = await t.db.select().from(stepTimings);
    expect(rows.map((r) => r.kind).sort()).toEqual(['activity', 'wait']);
  });

  it('会话那一笔：看守没写过的由它收尾；看守写过的不改；库里没有这次会话明确报错', async () => {
    await world(t.db);
    const { task } = await addTask(t.db);
    const runId = randomUUID();
    await openSessionRun(t.db, {
      id: runId,
      taskId: task.id,
      subtaskId: null,
      stage: 'execute',
      routeId: 'solo',
      whyRoute: 'x',
      branch: null,
      queuedAt: NOW,
      workflowId: null,
      runAsUser: 'fleet-agent-carpool',
      worktreePath: null,
    });
    const record = {
      kind: 'session' as const,
      workflowId: 'sub:x',
      runId,
      taskId: task.id,
      sessionId: '',
      stage: 'execute' as const,
      routeId: 'solo',
      outcome: 'failed' as const,
      endedAt: new Date(NOW.getTime() + MIN).toISOString(),
      usage: {},
      failureCode: 'SPAWN_FAILED',
    };
    await ports().recordTiming(record, ctx);
    expect(await getSessionRun(t.db, runId)).toMatchObject({
      outcome: 'failed',
      failureCode: 'SPAWN_FAILED',
    });
    await ports().recordTiming({ ...record, outcome: 'ok', failureCode: 'SHOULD_NOT_LAND' }, ctx);
    expect(await getSessionRun(t.db, runId)).toMatchObject({
      outcome: 'failed',
      failureCode: 'SPAWN_FAILED',
    });
    await expect(ports().recordTiming({ ...record, runId: randomUUID() }, ctx)).rejects.toMatchObject({
      code: 'RUN_NOT_FOUND',
    });
  });

  it('任务快照：任务不在库里明确报错', async () => {
    await world(t.db);
    await expect(
      ports().saveTaskState(
        {
          taskId: randomUUID(),
          repoId: randomUUID(),
          issueNumber: 1,
          state: 'running' as never,
          phase: 'x',
          doing: 'x',
          specDir: 'specs/1-x',
          docs: {},
          lastProblem: null,
          subtasks: [],
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
  });
});

/**
 * 这条路由上三段的一次性会话收了场的一笔（runs，#758）：默认是动手那一段失败、失败分流判路由的错。minutesAgo 是收场离现在
 * 多久，开跑在它前一分钟。
 */
async function oneShotEnded(
  routeId: string,
  minutesAgo: number,
  over: {
    segment?: 'manual' | 'verify';
    outcome?: 'done' | 'failed' | 'org_switch' | 'admission_blocked';
    routeOutcome?: 'ok' | 'fail' | 'neutral' | null;
  } = {},
) {
  const endedAt = new Date(NOW.getTime() - minutesAgo * MIN);
  await startRun(t.db, {
    segment: over.segment ?? 'manual',
    model: 'opus-5.5',
    routeId,
    startedAt: new Date(endedAt.getTime() - MIN),
    endedAt,
    outcome: over.outcome ?? 'failed',
    routeOutcome: over.routeOutcome === undefined ? 'fail' : over.routeOutcome,
  });
}

/** 这张单上起过（有开工时刻）的一次会话。 */
async function startedRun(taskId: string, routeId: string, stage: StageKind) {
  const id = randomUUID();
  await openSessionRun(t.db, {
    id,
    taskId,
    subtaskId: null,
    stage,
    routeId,
    whyRoute: 'x',
    branch: null,
    queuedAt: NOW,
    workflowId: null,
    runAsUser: routeId.startsWith('cursor') ? null : 'fleet-agent-carpool',
    worktreePath: null,
  });
  await markSessionRunStarted(t.db, { id, startedAt: NOW, sessionId: `s-${id}`, handle: null });
  return id;
}

describe('开 PR 前验证：只派别家、作者是哪几族、每一轮的记录', () => {
  it('写这张单的是 claude 族：整族避开，派给别家（钉住 kimi 的 cursor 路由）；点名同族的路由也不给', async () => {
    await world(t.db, { stages: ['verify'] });
    const { routeId } = await addCursorRoute(t.db, {
      stages: ['verify'],
      modelId: 'kimi-k3',
      upstreamModel: 'kimi-k3',
    });
    const r = await pick({ stage: 'verify', avoidFamilies: ['claude'] });
    expect(r).toMatchObject({ ok: true, route: { routeId, family: 'kimi' } });
    const named = await pick({ stage: 'verify', avoidFamilies: ['Claude'], preferRouteId: 'solo' });
    expect(named).toMatchObject({ ok: true, route: { routeId } });
    expect(named.ok && named.why).toContain('点名的路由这次用不了');
  });

  it('【故意造出的失败】没有别家可验：一条都派不出，写明没有别家、不拿同族顶', async () => {
    await world(t.db, { stages: ['verify'] });
    const none = await pick({ stage: 'verify', avoidFamilies: ['claude'] });
    expect(none).toMatchObject({ ok: false, waitFor: 'none' });
    expect(!none.ok && none.detail).toMatch(
      /^没有别家可验：写这张单的是 claude 族，这一步只派别家，不拿同族顶；/,
    );
    // 没说要避开哪一族的，照常派 claude
    expect(await pick({ stage: 'verify' })).toMatchObject({ ok: true, route: { routeId: 'solo' } });
  });

  it('碰界面的单（#266，创始人 2026-09-27 拍）：Cursor 上的 GPT-5.6 Luna 被硬禁令挡掉，派给排在它后面的 Grok 4.7；一般的单照排序派给 Luna', async () => {
    await world(t.db, { stages: ['verify'] });
    const luna = await addCursorRoute(t.db, {
      stages: ['verify'],
      modelId: 'gpt-5.6-luna',
      upstreamModel: 'gpt-5.6-luna-high',
    });
    const grok = await addGrokRoute(t.db, { stages: ['verify'] });
    // 验证这个用途的模型顺序照骨架：GPT 5.6 Luna 第一、Grok 4.7 第二，Opus（两个 Claude 池）在后面（写这张单的族避开）。
    // 位置在一个用途里不许重，先挪开再排
    const order = ['gpt-5.6-luna', 'grok-4.7', 'opus-5.5'];
    for (const base of [100, 0]) {
      for (const [i, modelId] of order.entries()) {
        await t.client.query(
          "update routing_purpose_models set position = $2 where purpose = 'verify' and model_id = $1",
          [modelId, base + i],
        );
      }
    }
    expect(await pick({ stage: 'verify', avoidFamilies: ['claude'] })).toMatchObject({
      ok: true,
      route: { routeId: luna.routeId, family: 'gpt' },
    });
    const ui = await pick({ stage: 'verify', avoidFamilies: ['claude'], uiWork: true });
    expect(ui).toMatchObject({ ok: true, route: { routeId: grok.routeId, family: 'grok', hostId: 'grok' } });
  });

  it('【故意造出的失败】别家只剩 Cursor Auto（渠道自己挑模型）：认不出是哪一家，不派，写明为什么', async () => {
    await world(t.db, { stages: ['verify'] });
    await addCursorRoute(t.db, { stages: ['verify'] });
    const none = await pick({ stage: 'verify', avoidFamilies: ['claude'] });
    expect(none).toMatchObject({ ok: false, waitFor: 'none' });
    expect(!none.ok && none.detail).toContain('没有别家可验');
    expect(!none.ok && none.detail).toContain(
      'Cursor Auto 由渠道自己挑模型（上游串 auto），认不出这次是哪一家在答',
    );
  });

  it('作者是哪几族：这张单上起过的会话按路由查模型目录，验证会话不算', async () => {
    await world(t.db);
    const { routeId } = await addCursorRoute(t.db);
    const { task } = await addTask(t.db);
    await startedRun(task.id, 'solo', 'plan');
    await startedRun(task.id, routeId, 'verify');
    expect(await ports().authorFamilies({ taskId: task.id }, ctx)).toEqual({ families: ['claude'] });
    await startedRun(task.id, routeId, 'execute');
    expect(await ports().authorFamilies({ taskId: task.id }, ctx)).toEqual({
      families: ['claude', 'cursor'],
    });
  });

  it('【故意造出的失败】一个起过的会话都查不到（或任务编号不是 UUID）：AUTHORS_UNKNOWN、不可重试，不回空的', async () => {
    await world(t.db);
    const { task } = await addTask(t.db);
    for (const taskId of [task.id, 'task-不是-uuid']) {
      await expect(ports().authorFamilies({ taskId }, ctx)).rejects.toMatchObject({
        code: 'AUTHORS_UNKNOWN',
        retryable: false,
      });
    }
  });
});
