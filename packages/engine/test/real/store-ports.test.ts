// 选路、报警、提问、人闸、计时、快照接真库（PGlite）：三种结果原样换成端口的；点名、续会话、被暂停的账号池、
// 没接上的执行方式各有去处；库里对不上的明确报错，不当成「没有路由」「记上了」。
import { randomUUID } from 'node:crypto';
import {
  asks,
  finishSessionRun,
  getSessionRun,
  markSessionRunStarted,
  notifications,
  openSessionRun,
  savePoolQuota,
  saveRouteProbe,
  sessionRuns,
  stagePolicyRoutes,
  stepTimings,
  upsertAlert,
  verifyRoundsOfTask,
} from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PickRouteInput } from '../../src/ports.ts';
import type { UserExec } from '../../src/real/exec.ts';
import { type SessionOrgReader, sessionOrgReader } from '../../src/real/session-org.ts';
import { createStorePorts, ORG_READ_RETRY_SECONDS, poolHoldKey } from '../../src/real/store-ports.ts';
import {
  addCursorRoute,
  addGrokRoute,
  addTask,
  CARPOOL_ORG_ID,
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
  it('按调度台的顺序派；两个 Claude 池是同一个会话用户，不再分主池、备池；派出去的带上组织类型（失败分流要）', async () => {
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

  it('点名的路由用不了（被避开）：照常选，并写明点名的为什么没用上', async () => {
    await world(t.db);
    const r = await pick({ preferRouteId: 'solo', avoidPoolIds: ['claude-solo'] });
    expect(r).toMatchObject({ ok: true, route: { routeId: 'carpool' } });
    expect(r.ok && r.why).toContain('点名的路由这次用不了');
    const unknown = await pick({ preferRouteId: 'nope' });
    expect(unknown.ok && unknown.why).toContain('不在这个阶段的调度台顺序里');
  });

  it('阶段没排顺序：派不出（不按编号乱挑）', async () => {
    await world(t.db, { stages: [] });
    const r = await pick({ stage: 'plan' });
    expect(r).toMatchObject({ ok: false, waitFor: 'none' });
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

  it('关掉的路由（调度台上单条开关）不派', async () => {
    await world(t.db);
    await t.client.query(
      "update stage_policy_routes set enabled = false where stage = 'triage' and route_id = 'solo'",
    );
    expect(await pick()).toMatchObject({ ok: true, route: { routeId: 'carpool' } });
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

  it('挂独享：派独享池；拼车池挡掉，只剩它时派不出、写明挂的是独享', async () => {
    rig.answer('solo');
    const p = onRig();
    expect(await pick({ stage: 'execute' }, p)).toMatchObject({
      ok: true,
      route: { routeId: 'solo', poolId: 'claude-solo' },
    });
    const none = await pick({ stage: 'execute', avoidRouteIds: ['solo'] }, p);
    expect(none).toMatchObject({ ok: false, waitFor: 'none' });
    expect(!none.ok && none.detail).toContain(
      '会话用户现在挂的是独享组织，Claude 订阅 · 拼车要等切过去才能派',
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
    release();
    // 解除时丢掉留着的「拼车」（留 60 秒也不用它），现读出独享
    expect(await pick({ stage: 'execute' }, p)).toMatchObject({ ok: true, route: { routeId: 'solo' } });
    expect(rig.calls).toHaveLength(calls + 1);
  });

  it('候选里没有带组织类型的池：不读（省一次以会话用户起 scope）', async () => {
    await t.client.query(`update pools set org_kind = null, run_as_user = null where id like 'claude-%'`);
    rig.answer({ code: 1, stderr: 'not logged in' });
    expect(await pick({ stage: 'execute' }, onRig())).toMatchObject({ ok: true, route: { routeId: 'solo' } });
    expect(rig.calls).toHaveLength(0);
  });
});

describe('流程配置里这一步的模型顺序（Fusion 的 models）', () => {
  /** 写码阶段：调度台上 Opus 两条排最前（solo、carpool），Cursor Auto 第 9 条，钉住 Kimi k3 的 cursor 路由第 10 条。 */
  async function fusionWorld() {
    await world(t.db, { stages: ['execute'] });
    const auto = (await addCursorRoute(t.db, { stages: ['execute'] })).routeId;
    const kimi = (await addCursorRoute(t.db, { modelId: 'kimi-k3', upstreamModel: 'kimi-k3' })).routeId;
    await t.db
      .insert(stagePolicyRoutes)
      .values({ stage: 'execute', routeId: kimi, position: 10, enabled: true });
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

  it('只派配置里这几个模型的路由：先按配置的先后（压过调度台上排在前面的），同一个模型的照调度台的先后', async () => {
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
    // 没带模型顺序的（旧的需求工作流）照调度台走
    expect(await pick({ stage: 'execute' })).toMatchObject({ ok: true, route: { routeId: 'solo' } });
  });

  it('【故意造出的失败】配置里的模型只剩被避开的、或在这个阶段一条路由都没有：派不出、写明是流程配置的模型，不拿别的模型顶', async () => {
    const { kimi } = await fusionWorld();
    const avoided = await pick({ stage: 'execute', models: ['kimi-k3'], avoidRouteIds: [kimi] });
    expect(avoided).toMatchObject({ ok: false, waitFor: 'none' });
    const none = await pick({ stage: 'execute', models: ['deepseek-flash'] });
    expect(none).toMatchObject({ ok: false, waitFor: 'none' });
    expect(!none.ok && none.detail).toContain(
      '流程配置里这一步的模型（deepseek-flash）在写码阶段的调度台上没有接上的路由',
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

  it('提问按 askId 只发一张；人闸按 approvalId 只开一张、同时开一条要人拍的提醒', async () => {
    await world(t.db);
    const { task } = await addTask(t.db);
    const p = ports();
    const askId = randomUUID();
    await p.askHuman(
      { taskId: task.id, askId, question: '要不要兼容旧接口？', options: ['要', '不要'] },
      ctx,
    );
    await p.askHuman({ taskId: task.id, askId, question: '要不要兼容旧接口？' }, ctx);
    expect(await t.db.select().from(asks)).toHaveLength(1);
    const approvalId = randomUUID();
    const approval = {
      taskId: task.id,
      approvalId,
      holds: ['release'],
      repo: { owner: 'acme', name: 'widgets', defaultBranch: 'main', testCommand: 'pnpm check' },
      prNumber: 7,
      head: 'a'.repeat(40),
      title: '发版',
      summary: '合并即上线',
    };
    await p.requestApproval(approval as never, ctx);
    await p.requestApproval(approval as never, ctx);
    const cards = (await t.db.select().from(notifications)).filter(
      (n) => n.dedupeKey === `approval:${approvalId}`,
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]?.level).toBe('decision');
  });

  it('提问的任务不在库里：照常抛（不假装发出去了）', async () => {
    await world(t.db);
    await expect(
      ports().askHuman({ taskId: randomUUID(), askId: randomUUID(), question: '？' }, ctx),
    ).rejects.toThrow();
  });

  it('引擎自己问、带推荐的（分诊说不清，#259）：记成这张单范围内按推荐先做的；读回来空的列不给，照改只记回答了的、时刻不往后挪', async () => {
    await world(t.db);
    const { task } = await addTask(t.db);
    const { task: other } = await addTask(t.db);
    const p = ports();
    const withRec = randomUUID();
    const legacy = randomUUID();
    await p.askHuman(
      {
        taskId: task.id,
        askId: withRec,
        question: '验证码几位？',
        options: ['6 位', '4 位'],
        recommended: '6 位',
      },
      ctx,
    );
    await p.askHuman({ taskId: task.id, askId: legacy, question: '要不要兼容旧接口？' }, ctx);
    await p.askHuman({ taskId: other.id, askId: randomUUID(), question: '别的单问的' }, ctx);

    expect(await p.taskAsks({ taskId: task.id }, ctx)).toEqual([
      {
        id: withRec,
        question: '验证码几位？',
        options: ['6 位', '4 位'],
        applied: false,
        scope: 'task',
        recommended: '6 位',
      },
      { id: legacy, question: '要不要兼容旧接口？', options: [], applied: false },
    ]);

    // 回答了的那条记上照改；没回答的不记；再记一次时刻不动
    await t.client.query(
      "update asks set answer = '4 位', answered_by = 'founder', answered_at = now() where id = $1",
      [withRec],
    );
    await p.markAsksApplied({ taskId: task.id, askIds: [withRec, legacy] }, ctx);
    const first = (await t.db.select().from(asks)).find((a) => a.id === withRec)?.appliedAt;
    expect(first).toEqual(NOW);
    await createStorePorts({
      db: t.db,
      now: () => new Date(NOW.getTime() + 60_000),
      draw: () => 0.5,
      log: () => {},
      sessionOrg: onCarpool,
    }).markAsksApplied({ taskId: task.id, askIds: [withRec] }, ctx);
    const rows = await p.taskAsks({ taskId: task.id }, ctx);
    expect(rows.map((r) => [r.id, r.answer, r.applied])).toEqual([
      [withRec, '4 位', true],
      [legacy, undefined, false],
    ]);
    expect((await t.db.select().from(asks)).find((a) => a.id === withRec)?.appliedAt).toEqual(first);
  });

  it('【故意造出的失败】读问过的、记照改：任务不在（或编号不是 UUID）报 TASK_NOT_FOUND、不可重试，不当成「一条都没问过」', async () => {
    await world(t.db);
    const p = ports();
    for (const taskId of [randomUUID(), 'not-a-uuid']) {
      await expect(p.taskAsks({ taskId }, ctx)).rejects.toMatchObject({
        code: 'TASK_NOT_FOUND',
        retryable: false,
      });
    }
    await expect(p.markAsksApplied({ taskId: 'not-a-uuid', askIds: [] }, ctx)).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
      retryable: false,
    });
    // 任务在、一条都没问过：是空的（这才是真的没问过）
    const { task } = await addTask(t.db);
    expect(await p.taskAsks({ taskId: task.id }, ctx)).toEqual([]);
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

describe('开 PR 前验证：只派别家、作者是哪几族、每一轮的记录', () => {
  /** 这张单上起过（有开工时刻）的一次会话。 */
  async function startedRun(taskId: string, routeId: string, stage: 'execute' | 'verify' | 'plan') {
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
    // 验证阶段的顺序照法国：Luna 第一、Grok 第二，两个 Claude 池在后面（写这张单的族避开）。位置在阶段里不许重，先挪开再排
    const order = [luna.routeId, grok.routeId, 'solo', 'carpool'];
    for (const base of [100, 0]) {
      for (const [i, routeId] of order.entries()) {
        await t.client.query(
          "update stage_policy_routes set position = $2 where stage = 'verify' and route_id = $1",
          [routeId, base + i],
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

  it('每一轮的记录：先记验证模型判的，Lead 驳回后改写同一行', async () => {
    await world(t.db);
    const { routeId } = await addCursorRoute(t.db);
    const { task } = await addTask(t.db);
    const runId = await startedRun(task.id, routeId, 'verify');
    const record = {
      taskId: task.id,
      id: randomUUID(),
      round: 1,
      head: 'a'.repeat(40),
      runId,
      routeId,
      family: 'cursor',
      authorFamilies: ['claude'],
      criteria: ['过期的验证码登录不了'],
      report: { head: 'a'.repeat(40), results: [], findings: [] },
      verdict: 'block' as const,
      rebuttals: [],
      finalVerdict: 'block' as const,
      reasons: ['安全：验证码写进了日志（证据：code.ts 第 12 行）'],
      notes: [],
    };
    await ports().recordVerification(record, ctx);
    const rebuttal = { target: '验证码写进了日志', evidence: 'code.ts 第 12 行打的是编号' };
    await ports().recordVerification(
      { ...record, rebuttals: [rebuttal], finalVerdict: 'pass', reasons: [] },
      ctx,
    );
    const rows = await verifyRoundsOfTask(t.db, task.id);
    expect(rows).toMatchObject([
      { id: record.id, verdict: 'block', finalVerdict: 'pass', rebuttals: [rebuttal], invalidWhy: null },
    ]);
  });

  it('【故意造出的失败】记录对不上库里的规矩（作废却有结论）：照常抛，不假装记上了', async () => {
    await world(t.db);
    const { routeId } = await addCursorRoute(t.db);
    const { task } = await addTask(t.db);
    const runId = await startedRun(task.id, routeId, 'verify');
    await expect(
      ports().recordVerification(
        {
          taskId: task.id,
          id: randomUUID(),
          round: 1,
          head: 'a'.repeat(40),
          runId,
          routeId,
          family: 'cursor',
          authorFamilies: ['claude'],
          criteria: ['x'],
          report: null,
          verdict: 'invalid',
          invalidWhy: '审的不是送检的头',
          rebuttals: [],
          finalVerdict: 'pass',
          reasons: [],
          notes: [],
        },
        ctx,
      ),
    ).rejects.toThrow();
    expect(await verifyRoundsOfTask(t.db, task.id)).toEqual([]);
  });
});

describe('Fusion 开工前读的：流程配置副本、单子正文', () => {
  it('流程配置副本原样交出去（时刻换成 ISO）：能不能用由 core 判，这里不补默认值', async () => {
    const synced = await addTask(t.db, { testCommand: 'pnpm test:changed' });
    expect(await ports().flowConfig({ taskId: synced.task.id }, ctx)).toEqual({
      replica: {
        syncedAt: synced.repo.flowSyncedAt?.toISOString(),
        error: null,
        unread: null,
        testCommand: 'pnpm test:changed',
      },
      source: 'project',
      config: { formatVersion: 1, testCommand: 'pnpm test:changed' },
    });
    // 从没同步成过、认不出：照实交出去（core 判停派），不拿空配置顶
    const never = await addTask(t.db, { flowSyncedAt: null, flowError: '认不出：formatVersion 写成了 9' });
    expect(await ports().flowConfig({ taskId: never.task.id }, ctx)).toEqual({
      replica: { syncedAt: null, error: '认不出：formatVersion 写成了 9', unread: null, testCommand: null },
      source: null,
      config: null,
    });
  });

  it('单子正文：库里这张单现在的标题和正文', async () => {
    const { task } = await addTask(t.db);
    expect(await ports().taskRequest({ taskId: task.id }, ctx)).toEqual({
      title: '登录页加验证码',
      rawRequest: '登录页加一个手机验证码',
    });
  });

  it('【故意造出的失败】任务不在（或编号不是 UUID）：两个都报 TASK_NOT_FOUND、不可重试，不交空的', async () => {
    for (const taskId of [randomUUID(), 'task-不是-uuid']) {
      await expect(ports().flowConfig({ taskId }, ctx)).rejects.toMatchObject({
        code: 'TASK_NOT_FOUND',
        retryable: false,
      });
      await expect(ports().taskRequest({ taskId }, ctx)).rejects.toMatchObject({
        code: 'TASK_NOT_FOUND',
        retryable: false,
      });
    }
  });
});
