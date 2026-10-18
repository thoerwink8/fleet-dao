// 看门狗提醒的受控修复（#3033）：POST /api/notifications/:id/repair 和列表上的 repair。
// 两条贯通用的是引擎里真的看门狗，跑在 PGlite 真库上：提醒由 runWatchdogJob(watchdogJob(...)) 里的 idle-running 检测（jobs/idle-running.ts，
// 读库用 db 的 listRunningEngineTasks）和发版卡住检测（jobs/release-watch.ts，读临时发布目录里的进度记录）写进 notifications 表，
// 再走真路由、真 Store、api 的真 pgAlertRepair：
//   发现 → 落库 → 列出当前动作 → 选择 → 同一个操作接活 → 执行 / 核验 → 结果写回原卡 → 看门狗自己撤卡。
// 1. idle-running：能安全恢复——发「继续」两下信号只记 accepted，任务行动了才核成 verified，卡由真看门狗下一轮撤。
// 2. 发版卡住（running）：现有恢复入口不开，只剩「交给修复」；开单失败卡保留，重试开成一张，同一 incident 不开第二张。
// 另外：要人本人拍的发版恢复动作（选项 / 先不动 / 自由输入 / 不答）、409 全家（条件变了、已撤、incident 对不上、动作过期、
// 在途、结果未知）、幂等重放、状态落库。
// 为什么 api 的 devDependencies 有 engine：这里要跑引擎的真检测器；引擎检测器改了键、标题、撤卡口径，这些测试就会红。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkIssueBody } from '@fleet-dao/conventions';
import { registerScheduledJobs, runs, tasks } from '@fleet-dao/db';
import { createTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import type { AlertRepairRecord } from '@fleet-dao/shared';
import { NotificationsResponse, TASK_SIGNAL_NAMES, WEB_API_PREFIX } from '@fleet-dao/shared';
import { devFixtures, IDS, type MemoryData } from '@fleet-dao/store';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runWatchdogJob, WATCHDOG_JOB, type WatchdogDeps } from '../../engine/src/jobs/watchdog.ts';
import { watchdogJob } from '../../engine/src/real/watchdog.ts';
import { type AlertRepairPort, pgAlertRepair, repairSettingKey } from '../src/alert-repair.ts';
import { type FranceReleasePort, liveFranceReleasePort } from '../src/france-release.ts';
import { type TaskSignal, WorkflowGoneError, WorkflowUnavailableError } from '../src/ports.ts';
import { repairDispatcher } from '../src/repair-dispatch.ts';
import { harness, pgHarness, T0, write } from './harness.ts';

type PgHarness = Awaited<ReturnType<typeof pgHarness>>;
type MemHarness = ReturnType<typeof harness>;
type AnyHarness = PgHarness | MemHarness;
/** 修复接口的回包（成功带 repair，409 带 error）。 */
interface RepairJson {
  replayed?: boolean;
  repair: AlertRepairRecord;
  error: { code: string; message: string };
}
interface OpenedIssue {
  repo: { owner: string; name: string };
  key: string;
  title: string;
  body: string;
  labels: string[];
}
interface Issues {
  calls: OpenedIssue[];
  failWith?: Error;
}

const LIST = `${WEB_API_PREFIX}/notifications?status=all`;
const repairPath = (id: string) => `${WEB_API_PREFIX}/notifications/${id}/repair`;
const MIN = 60_000;
const ago = (minutes: number) => new Date(T0.getTime() - minutes * MIN);
const iso = (minutes: number) => ago(minutes).toISOString();
const SELF = {
  id: 'a0000000-0000-4000-8000-0000000000fd',
  owner: 'thoerwink8',
  name: 'fleet-dao',
  defaultBranch: 'main',
  testCommand: 'pnpm check',
};
const HEAD = `2005b290${'a'.repeat(32)}`;
const uuid = () => crypto.randomUUID();

function data(masterOn: boolean | null = null): Partial<MemoryData> {
  const d = devFixtures(T0);
  return {
    ...d,
    repos: [...(d.repos ?? []), SELF],
    ...(masterOn === null
      ? {}
      : {
          settings: [
            ...(d.settings ?? []),
            { key: 'engine.master', value: masterOn, version: 1, updatedAt: iso(5), updatedBy: 'u' },
          ],
        }),
  };
}

function issuesPort(issues: Issues): Pick<AlertRepairPort, 'openIssue'> {
  return {
    openIssue: async (input) => {
      issues.calls.push(input);
      if (issues.failWith) throw issues.failWith;
      return {
        number: 3100,
        url: 'https://github.com/thoerwink8/fleet-dao/issues/3100',
        created: issues.calls.length === 1,
      };
    },
  };
}

async function list(h: AnyHarness, s: { cookie: string }) {
  const res = await h.cockpit.request(LIST, { headers: { cookie: s.cookie } });
  expect(res.status).toBe(200);
  return NotificationsResponse.parse(await res.json());
}

async function post(
  h: AnyHarness,
  s: { cookie: string; csrf: string },
  id: string,
  body: Record<string, unknown>,
) {
  const res = await h.cockpit.request(repairPath(id), write('POST', s, body));
  return { status: res.status, json: (await res.json()) as RepairJson };
}

const repairAudits = async (h: AnyHarness) =>
  (await h.store.listAudit({ limit: 100 })).items.filter((a) => a.action === 'alert.repair');

async function findAlert(h: AnyHarness, keyPrefix: string) {
  const n = (await h.store.listNotifications({ status: 'all', limit: 200 })).items.find((x) =>
    x.dedupeKey?.startsWith(keyPrefix),
  );
  if (!n) throw new Error(`没有 ${keyPrefix} 的提醒`);
  return n;
}

// —— 真看门狗（引擎的 watchdogJob + runWatchdogJob，真库）——

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());

let current: PgHarness | undefined;
let releaseDir: string | undefined;
afterEach(async () => {
  await current?.stop();
  current = undefined;
  if (releaseDir) rmSync(releaseDir, { recursive: true, force: true });
  releaseDir = undefined;
});

/** 真看门狗这一轮，只看 idle-running 和发版卡住两项（其余项另有引擎自己的测试）；读库、写提醒、撤提醒都是引擎的真装配。 */
function watchdogDeps(h: PgHarness, only: 'idle' | 'release'): WatchdogDeps {
  const real = watchdogJob({
    db: t.db,
    now: () => new Date(h.clock.now),
    log: () => undefined,
    releasesDir: releaseDir ?? join(tmpdir(), 'alert-repair-no-releases'),
    healthzUrl: 'http://127.0.0.1:1/healthz',
    fetchImpl: (async () =>
      new Response(JSON.stringify({ ok: true, checks: {} }), { status: 200 })) as unknown as typeof fetch,
    quotaNotRead: async () => [],
  })();
  return {
    health: async () => [],
    alerts: real.alerts,
    runs: real.runs,
    now: real.now,
    log: real.log,
    ...(only === 'idle' ? { idleRunning: real.idleRunning } : { releaseWatch: real.releaseWatch }),
  } as WatchdogDeps;
}

async function runWatchdog(h: PgHarness, only: 'idle' | 'release') {
  return runWatchdogJob(watchdogDeps(h, only));
}

async function pgWorld(
  over: { workflows?: Parameters<typeof pgHarness>[1] extends infer O ? O : never; issues?: Issues } = {},
) {
  const h = await pgHarness(t, { data: data(), ...(over.workflows ?? {}) });
  current = h;
  await registerScheduledJobs(t.db, [{ ...WATCHDOG_JOB, registeredAt: ago(30 * 24 * 60) }]);
  // 任务 12：引擎做、在干活、没有开着的会话、任务行 60 分钟没动（换路由续之后睡在等选路里的样子）
  await t.db
    .update(runs)
    .set({ endedAt: ago(30) })
    .where(and(eq(runs.taskId, IDS.task12), isNull(runs.endedAt)));
  await setTask({ updatedAt: ago(60) });
  h.deps.workflows.taskWorkflowExecution ??= async (workflowId) => ({
    workflowId,
    runId: 'original-run',
    running: true,
  });
  h.deps.alertRepair = pgAlertRepair(t.db, issuesPort(over.issues ?? { calls: [] }) as never, async () => ({
    ok: true,
    text: '已派工',
  }));
  return h;
}

const DOING = '第 2 轮：换一条路由带上进度续一次，不停下等人';
async function setTask(set: { updatedAt?: Date; state?: 'running' | 'stalled' }) {
  await t.db
    .update(tasks)
    .set({ doing: DOING, ...set })
    .where(eq(tasks.id, IDS.task12));
}

describe('idle-running：真看门狗 → 落库 → 当前动作 → 点 → 受理 → 核验 → 卡自己撤', () => {
  it('发「继续」只记 accepted；任务行动了才核成 verified；同一幂等身份重放不再发信号；真看门狗下一轮撤卡', async () => {
    const h = await pgWorld();
    const found = await runWatchdog(h, 'idle');
    expect(found).toMatchObject({ outcome: 'ok', found: 1 });
    const alert = await findAlert(h, 'watchdog:idle-running:');
    expect(alert.dedupeKey).toBe(`watchdog:idle-running:${IDS.task12}`);

    const s = await h.login();
    const before = (await list(h, s)).items.find((n) => n.id === alert.id);
    const repair = before?.repair;
    expect(repair).toBeDefined();
    // 动作绑定明确的任务、仓、当前工作流；不是从正文猜的
    const recover = repair?.actions.find((a) => a.kind === 'task-recover');
    expect(recover?.target).toMatchObject({
      taskId: IDS.task12,
      issueNumber: 12,
      repo: { owner: 'example', name: 'canary' },
      workflowId: 'task:example/canary#12',
    });
    expect(recover?.choice).toBeUndefined();
    // 全局归属明确：交给修复开在 fleet-dao，不跟任务走
    expect(repair?.actions.find((a) => a.kind === 'hand-to-repair')?.target.repo).toEqual({
      owner: 'thoerwink8',
      name: 'fleet-dao',
    });
    expect(before?.level).toBe('alert');
    expect(before?.options).toBeUndefined();

    const requestId = uuid();
    const sent = await post(h, s, alert.id, {
      actionId: recover?.id,
      incident: repair?.incident,
      requestId,
    });
    expect(sent.status).toBe(200);
    expect(sent.json.replayed).toBe(false);
    expect(sent.json.repair).toMatchObject({ state: 'accepted', kind: 'task-recover', requestId });
    expect(sent.json.repair.check).toMatchObject({ ok: false });
    // 真发了两下：先继续、再路由叫醒，发给当前工作流
    expect(h.signals.map((x) => [x.workflowId, x.signal.name])).toEqual([
      ['task:example/canary#12', TASK_SIGNAL_NAMES.continue],
      ['task:example/canary#12', TASK_SIGNAL_NAMES.routeWake],
    ]);
    // 受理不撤卡；列表上这张卡写着「已受理、未修好」，同一个动作不再给按钮
    const mid = (await list(h, s)).items.find((n) => n.id === alert.id);
    expect(mid?.resolvedAt).toBeUndefined();
    expect(mid?.repair?.last).toMatchObject({ state: 'accepted', check: { ok: false } });
    expect(mid?.repair?.actions).toEqual([]);

    // 同一幂等身份重放：回原结果，信号不再发
    const replay = await post(h, s, alert.id, {
      actionId: recover?.id,
      incident: repair?.incident,
      requestId,
    });
    expect(replay.status).toBe(200);
    expect(replay.json.replayed).toBe(true);
    expect(h.signals).toHaveLength(2);
    // 新身份重复点同一个动作：已受理等核验，409，不重复发
    const again = await post(h, s, alert.id, {
      actionId: recover?.id,
      incident: repair?.incident,
      requestId: uuid(),
    });
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe('repair_pending_verify');
    expect(h.signals).toHaveLength(2);

    // 真看门狗再跑一轮，任务行还没动：卡还在、没被撤（受理不等于修好）
    h.clock.now = new Date(T0.getTime() + 5 * MIN);
    await runWatchdog(h, 'idle');
    expect((await findAlert(h, 'watchdog:idle-running:')).resolvedAt).toBeUndefined();

    // 状态落在设置表，每次写都有操作记录
    const saved = (await h.store.listSettings()).find((x) => x.key === repairSettingKey(alert.id));
    expect(saved?.value).toMatchObject({ state: 'accepted', actionId: recover?.id });
    expect((await repairAudits(h)).length).toBeGreaterThanOrEqual(2);

    // 60 分钟前变成 30 分钟前，仍超过原 20 分钟阈值，不能假绿。
    await setTask({ updatedAt: new Date(h.clock.now.getTime() - 30 * MIN) });
    expect((await list(h, s)).items.find((n) => n.id === alert.id)?.repair?.last).toMatchObject({
      state: 'accepted',
      check: { ok: false },
    });
    await runWatchdog(h, 'idle');
    expect((await findAlert(h, 'watchdog:idle-running:')).resolvedAt).toBeUndefined();
    // 即使另一 run 有新活动，也不能核实原 run 恢复。
    h.deps.workflows.taskWorkflowExecution = async (workflowId) => ({
      workflowId,
      runId: 'another-run',
      running: true,
    });
    await setTask({ updatedAt: new Date(h.clock.now.getTime() - MIN) });
    expect((await list(h, s)).items.find((n) => n.id === alert.id)?.repair?.last).toMatchObject({
      state: 'accepted',
      check: { ok: null },
    });
    h.deps.workflows.taskWorkflowExecution = async (workflowId) => ({
      workflowId,
      runId: 'original-run',
      running: true,
    });
    // 引擎有了反应（任务行更新了）：原条件不再成立，核成 verified；真看门狗下一轮自己撤卡
    await setTask({ updatedAt: new Date(h.clock.now.getTime() - MIN) });
    const after = (await list(h, s)).items.find((n) => n.id === alert.id);
    expect(after?.repair?.last).toMatchObject({ state: 'verified', check: { ok: true } });
    h.clock.now = new Date(T0.getTime() + 10 * MIN);
    await runWatchdog(h, 'idle');
    const done = (await list(h, s)).items.find((n) => n.id === alert.id);
    expect(done?.resolvedAt).toBeDefined();
    expect(done?.repair?.actions).toEqual([]);
    expect(done?.repair?.last?.state).toBe('verified');
  });

  it('【故意造出的失败】条件变了、已撤、incident 对不上、动作不是服务端给的：全是 409，一个信号都不发', async () => {
    const h = await pgWorld();
    await runWatchdog(h, 'idle');
    const alert = await findAlert(h, 'watchdog:idle-running:');
    const s = await h.login();
    const view = (await list(h, s)).items.find((n) => n.id === alert.id)?.repair;
    const recover = view?.actions.find((a) => a.kind === 'task-recover');
    const body = { actionId: recover?.id, incident: view?.incident, requestId: uuid() };

    const forged = await post(h, s, alert.id, { ...body, actionId: 'task-recover:forged' });
    expect([forged.status, forged.json.error.code]).toEqual([409, 'action_expired']);
    const wrongIncident = await post(h, s, alert.id, { ...body, incident: 'deadbeef0000' });
    expect([wrongIncident.status, wrongIncident.json.error.code]).toEqual([409, 'incident_mismatch']);

    // 点之前任务行动了（证据变了）：旧动作编号过期
    await setTask({ updatedAt: ago(2) });
    const stale = await post(h, s, alert.id, body);
    expect([stale.status, stale.json.error.code]).toEqual([409, 'action_expired']);
    // 条件整个变了（任务不再是引擎在干活）：列表里不再给任务继续，说明原因
    await setTask({ state: 'stalled' });
    const changed = (await list(h, s)).items.find((n) => n.id === alert.id)?.repair;
    expect(changed?.actions.map((a) => a.kind)).toEqual(['hand-to-repair']);
    expect(changed?.problems.join('；')).toContain('条件已变');

    // 提醒已撤
    await h.store.resolveNotification(
      { id: alert.id, by: { kind: 'user', id: 'u' } },
      {
        actor: { kind: 'user', id: 'u' },
        action: 'notification.resolve',
        target: `notification:${alert.id}`,
        via: 'cockpit',
        ok: true,
      },
    );
    const resolved = await post(h, s, alert.id, body);
    expect([resolved.status, resolved.json.error.code]).toEqual([409, 'alert_resolved']);
    // 不存在的提醒 404
    expect((await post(h, s, uuid(), body)).status).toBe(404);
    expect(h.signals).toEqual([]);
    expect((await h.store.listSettings()).some((x) => x.key.startsWith('alert.repair:'))).toBe(false);
  });

  it('POST 读完计划后通知被撤：claim 事务核开放条件，409 且零信号', async () => {
    const h = await pgWorld();
    await runWatchdog(h, 'idle');
    const alert = await findAlert(h, 'watchdog:idle-running:');
    const s = await h.login();
    const view = (await list(h, s)).items.find((n) => n.id === alert.id)?.repair;
    const action = view?.actions.find((a) => a.kind === 'task-recover');
    const port = h.deps.alertRepair;
    if (!port?.idleTask) throw new Error('未装配');
    const original = port.idleTask;
    port.idleTask = async (id) => {
      const fact = await original(id);
      await h.store.resolveNotification(
        { id: alert.id, by: { kind: 'user', id: IDS.founderA } },
        {
          actor: { kind: 'user', id: IDS.founderA },
          action: 'notification.resolve',
          target: `notification:${alert.id}`,
          via: 'cockpit',
          ok: true,
        },
      );
      return fact;
    };
    const result = await post(h, s, alert.id, {
      actionId: action?.id,
      incident: view?.incident,
      requestId: uuid(),
    });
    expect([result.status, result.json.error.code]).toEqual([409, 'repair_conflict']);
    expect(h.signals).toEqual([]);
    expect(
      (await h.store.listSettings()).find((row) => row.key === repairSettingKey(alert.id)),
    ).toBeUndefined();
  });

  it('信号回执未知：记 unknown，不自动重试，也不核成修好', async () => {
    const h = await pgWorld({
      workflows: {
        workflows: {
          async signal() {
            throw new WorkflowUnavailableError('Temporal 超时');
          },
        },
      },
    });
    await runWatchdog(h, 'idle');
    const alert = await findAlert(h, 'watchdog:idle-running:');
    const s = await h.login();
    const view = (await list(h, s)).items.find((n) => n.id === alert.id)?.repair;
    const recover = view?.actions.find((a) => a.kind === 'task-recover');
    const click = () =>
      post(h, s, alert.id, { actionId: recover?.id, incident: view?.incident, requestId: uuid() });
    expect((await click()).json.repair).toMatchObject({ state: 'unknown' });
    const hand = view?.actions.find((a) => a.kind === 'hand-to-repair');
    const other = await post(h, s, alert.id, {
      actionId: hand?.id,
      incident: view?.incident,
      requestId: uuid(),
    });
    expect([other.status, other.json.error.code]).toEqual([409, 'repair_in_flight']);
    // A unknown → B handoff → A，B 不能覆盖未知副作用，再点 A 仍禁止。
    // 结果未知：同一个动作再点是 409，不盲重试
    const blocked = await click();
    expect([blocked.status, blocked.json.error.code]).toEqual([409, 'repair_in_flight']);
    expect((await list(h, s)).items.find((n) => n.id === alert.id)?.repair?.last?.state).toBe('unknown');
  });

  it('同 key 重开以 raisedAt 换代：旧 verified 不冒充新绿，旧按钮 409；旧 unknown 跨代仍阻挡', async () => {
    const h = await pgWorld();
    await runWatchdog(h, 'idle');
    const alert = await findAlert(h, 'watchdog:idle-running:');
    const s = await h.login();
    const first = (await list(h, s)).items.find((n) => n.id === alert.id)?.repair;
    const action = first?.actions.find((a) => a.kind === 'task-recover');
    const clicked = await post(h, s, alert.id, {
      actionId: action?.id,
      incident: first?.incident,
      requestId: uuid(),
    });
    expect(clicked.json.repair.state).toBe('accepted');
    // 真核验持久结清旧代，而不是伪造一份绿色状态。
    await setTask({ updatedAt: ago(1) });
    const auditsBefore = (await repairAudits(h)).length;
    await Promise.all([list(h, s), list(h, s)]);
    const record = (await h.store.listSettings()).find((row) => row.key === repairSettingKey(alert.id));
    if (!record) throw new Error('缺修复记录');
    expect(record.value).toMatchObject({ state: 'verified' });
    expect((await repairAudits(h)).length - auditsBefore).toBe(1);
    await runWatchdog(h, 'idle');
    await setTask({ updatedAt: ago(60) });
    await runWatchdog(h, 'idle');
    const reopened = await findAlert(h, 'watchdog:idle-running:');
    expect(reopened.id).toBe(alert.id);
    expect(reopened.createdAt).toBe(alert.createdAt);
    expect(reopened.raisedAt).not.toBe(alert.raisedAt);
    const current = (await list(h, s)).items.find((n) => n.id === alert.id)?.repair;
    expect(current?.incident).not.toBe(first?.incident);
    expect(current?.last).toBeUndefined();
    expect(current?.actions.some((a) => a.kind === 'task-recover')).toBe(true);
    expect(
      (await post(h, s, alert.id, { actionId: action?.id, incident: first?.incident, requestId: uuid() }))
        .json.error.code,
    ).toBe('incident_mismatch');
    const latest = (await h.store.listSettings()).find((row) => row.key === record.key);
    await h.store.putSetting(
      {
        key: record.key,
        value: { ...clicked.json.repair, state: 'unknown' },
        expectedVersion: latest?.version ?? 0,
        by: { kind: 'user', id: IDS.founderA },
      },
      {
        actor: { kind: 'user', id: IDS.founderA },
        action: 'test.repair',
        target: `notification:${alert.id}`,
        via: 'cockpit',
        ok: true,
      },
    );
    const held = (await list(h, s)).items.find((n) => n.id === alert.id)?.repair;
    expect(held?.actions).toEqual([]);
    expect(held?.last?.state).toBe('unknown');
    const denied = await post(h, s, alert.id, {
      actionId: current?.actions[0]?.id,
      incident: current?.incident,
      requestId: uuid(),
    });
    expect([denied.status, denied.json.error.code]).toEqual([409, 'repair_prior_incident_pending']);
    expect(h.signals).toHaveLength(2);
  });

  it('旧代核验读完后卡重开：结算的通知代次守卫拒绝旧 verified，不覆盖新事故', async () => {
    const h = await pgWorld();
    await runWatchdog(h, 'idle');
    const alert = await findAlert(h, 'watchdog:idle-running:');
    const s = await h.login();
    const view = (await list(h, s)).items.find((n) => n.id === alert.id)?.repair;
    const action = view?.actions.find((a) => a.kind === 'task-recover');
    expect(
      (await post(h, s, alert.id, { actionId: action?.id, incident: view?.incident, requestId: uuid() })).json
        .repair.state,
    ).toBe('accepted');
    await setTask({ updatedAt: ago(1) });
    const original = h.store.putSetting.bind(h.store);
    h.store.putSetting = async (input, audit) => {
      if (
        typeof input.value === 'object' &&
        input.value !== null &&
        'state' in input.value &&
        input.value.state === 'verified'
      ) {
        h.store.putSetting = original;
        await runWatchdog(h, 'idle');
        await setTask({ updatedAt: ago(60) });
        await runWatchdog(h, 'idle');
      }
      return original(input, audit);
    };
    const raced = (await list(h, s)).items.find((n) => n.id === alert.id)?.repair;
    expect(raced?.last).toMatchObject({ state: 'accepted', check: { ok: null } });
    expect(
      (await h.store.listSettings()).find((row) => row.key === repairSettingKey(alert.id))?.value,
    ).toMatchObject({ state: 'accepted' });
    const next = (await list(h, s)).items.find((n) => n.id === alert.id)?.repair;
    expect(next?.incident).not.toBe(view?.incident);
    expect(next?.actions).toEqual([]);
    expect(next?.problems.join('')).toContain('上一代事故');
    expect(
      (await repairAudits(h)).filter(
        (a) => (a.after as { state?: string } | undefined)?.state === 'verified',
      ),
    ).toHaveLength(0);
  });

  it('原自测预算仍有效：40 分钟未更新不提供唤醒，60 分钟过期才提供', async () => {
    const h = await pgWorld();
    await runWatchdog(h, 'idle');
    const alert = await findAlert(h, 'watchdog:idle-running:');
    const s = await h.login();
    await t.db
      .update(tasks)
      .set({ doing: '引擎跑测试和类型检查', updatedAt: ago(40) })
      .where(eq(tasks.id, IDS.task12));
    expect(
      (await list(h, s)).items
        .find((n) => n.id === alert.id)
        ?.repair?.actions.some((a) => a.kind === 'task-recover'),
    ).toBe(false);
    await t.db
      .update(tasks)
      .set({ updatedAt: ago(60) })
      .where(eq(tasks.id, IDS.task12));
    expect(
      (await list(h, s)).items
        .find((n) => n.id === alert.id)
        ?.repair?.actions.some((a) => a.kind === 'task-recover'),
    ).toBe(true);
  });

  it('确定没发出去（工作流已结束）：记 failed，卡保留，能重来', async () => {
    let mode: 'gone' | 'ok' = 'gone';
    const sent: TaskSignal[] = [];
    const h = await pgWorld({
      workflows: {
        workflows: {
          async signal(_id, signal) {
            if (mode === 'gone') throw new WorkflowGoneError('task:example/canary#12');
            sent.push(signal);
          },
        },
      },
    });
    await runWatchdog(h, 'idle');
    const alert = await findAlert(h, 'watchdog:idle-running:');
    const s = await h.login();
    const view = (await list(h, s)).items.find((n) => n.id === alert.id)?.repair;
    const act = view?.actions.find((a) => a.kind === 'task-recover');
    const click = () =>
      post(h, s, alert.id, { actionId: act?.id, incident: view?.incident, requestId: uuid() });
    const failed = await click();
    expect(failed.json.repair).toMatchObject({ state: 'failed' });
    expect(failed.json.repair.text).toContain('没发出去');
    expect((await list(h, s)).items.find((n) => n.id === alert.id)?.resolvedAt).toBeUndefined();
    mode = 'ok';
    expect((await click()).json.repair.state).toBe('accepted');
    expect(sent.map((x) => x.name)).toEqual([TASK_SIGNAL_NAMES.continue, TASK_SIGNAL_NAMES.routeWake]);
  });
});

/** 真格式的发版进度记录（deploy/france/release-request/lib.mjs 写的那个形状），写进临时发布目录的 .train。 */
function writeTrain(dir: string, status: string, startedMinAgo: number) {
  writeFileSync(
    join(dir, '.train', 'release-train.json'),
    JSON.stringify({
      schema: 1,
      status,
      phase: 4,
      startedAt: iso(startedMinAgo),
      updatedAt: iso(startedMinAgo),
      target: { kind: 'sha', value: HEAD },
    }),
  );
}

function requestPort() {
  const written: string[] = [];
  return {
    written,
    port: {
      receiverInstalled: async () => ({ ok: true as const }),
      pendingRequest: async () => false,
      readLast: async () => null,
      writeRequest: async (text: string) => {
        written.push(text);
      },
    },
  };
}

describe('发版卡住（真看门狗）：没有直接恢复入口时只能交给修复，失败保留、成功只开一张', () => {
  it('进度停在 running 超 70 分钟，真看门狗报卡：恢复入口不开 → 只剩交给修复；开单失败卡保留，重试开成，再点不开第二张；发完真看门狗撤卡', async () => {
    releaseDir = mkdtempSync(join(tmpdir(), 'alert-repair-release-'));
    mkdirSync(join(releaseDir, '.train'), { recursive: true });
    writeTrain(releaseDir, 'running', 120);
    const req = requestPort();
    const issues: Issues = { calls: [], failWith: new Error('GitHub 502') };
    const h = await pgWorld({ issues });
    h.deps.releaseRequest = req.port;
    h.deps.franceRelease = liveFranceReleasePort(join(releaseDir, '.train'));
    expect(await runWatchdog(h, 'release')).toMatchObject({ outcome: 'ok', found: 1 });
    const alert = await findAlert(h, 'watchdog:release:');
    expect(alert.dedupeKey).toBe(`watchdog:release:train:${HEAD.slice(0, 12)}:running`);

    const s = await h.login();
    const view = (await list(h, s)).items.find((n) => n.id === alert.id)?.repair;
    expect(view?.actions.map((a) => a.kind)).toEqual(['hand-to-repair']);
    expect(view?.problems.join('；')).toContain('入口此刻都没开');
    const hand = view?.actions[0];

    // 开单失败：记 failed，卡保留，没有假单号
    const failed = await post(h, s, alert.id, {
      actionId: hand?.id,
      incident: view?.incident,
      requestId: uuid(),
    });
    expect(failed.json.repair).toMatchObject({ state: 'failed' });
    expect(failed.json.repair.issue).toBeUndefined();
    expect((await list(h, s)).items.find((n) => n.id === alert.id)?.resolvedAt).toBeUndefined();

    // 重试：开成，返回真实单号并关联原卡
    delete issues.failWith;
    const ok = await post(h, s, alert.id, {
      actionId: hand?.id,
      incident: view?.incident,
      requestId: uuid(),
    });
    expect(ok.json.repair).toMatchObject({
      state: 'handed',
      issue: { repo: { owner: 'thoerwink8', name: 'fleet-dao' }, number: 3100, created: expect.any(Boolean) },
    });
    const opened = issues.calls.at(-1);
    if (!opened) throw new Error('没开过单');
    expect(opened.repo).toEqual({ owner: 'thoerwink8', name: 'fleet-dao' });
    expect(opened.key).toBe(`alert-repair:${view?.incident}`);
    expect(opened.labels).toContain('缺陷');
    // 合规四节单，正文带着真看门狗写的键
    expect(checkIssueBody(opened.body).ok).toBe(true);
    for (const sec of ['## 场景', '## 原话', '## 已知的模块', '## 怎么算做完']) {
      expect(opened.body).toContain(sec);
    }
    expect(opened.body).toContain(alert.dedupeKey ?? '');
    expect(opened.body).toContain(alert.title);

    // 同一 incident 再点（新身份）：不再开单，回原来那张
    const callsBefore = issues.calls.length;
    const dup = await post(h, s, alert.id, {
      actionId: hand?.id,
      incident: view?.incident,
      requestId: uuid(),
    });
    expect(dup.status).toBe(200);
    expect(dup.json.repair.issue?.number).toBe(3100);
    expect(issues.calls).toHaveLength(callsBefore);
    // 列表上这张卡带着单号，卡仍开着（根因修好、看门狗撤才算完）
    const card = (await list(h, s)).items.find((n) => n.id === alert.id);
    expect(card?.repair?.last).toMatchObject({ state: 'handed', issue: { number: 3100 } });
    expect(card?.resolvedAt).toBeUndefined();
    expect(req.written).toEqual([]);

    // 发版收尾（进度 done）：真看门狗自己撤，原卡上仍留着修复单号
    writeTrain(releaseDir, 'done', 120);
    h.clock.now = new Date(T0.getTime() + 5 * MIN);
    await runWatchdog(h, 'release');
    const done = (await list(h, s)).items.find((n) => n.id === alert.id);
    expect(done?.resolvedAt).toBeDefined();
    expect(done?.repair?.last).toMatchObject({ state: 'handed', issue: { number: 3100 } });
  });
});

describe('交修复的立即派工与持久状态', () => {
  it('已开单但派工失败保留真实单，重试只派原单；派工回执未知不允许盲重试', async () => {
    const issues: Issues = { calls: [] };
    const h = await pgWorld({ issues });
    await runWatchdog(h, 'idle');
    const alert = await findAlert(h, 'watchdog:idle-running:');
    const s = await h.login();
    let code = 1;
    const attempts: string[][] = [];
    const operators: (string | undefined)[] = [];
    const dispatch = repairDispatcher(async (_file, args, options) => {
      attempts.push(args);
      operators.push(options.env.FLEET_OPS_OPERATOR);
      return { code, text: code === 0 ? '已派：已起工作流' : '没派：准入拒绝' };
    });
    if (!h.deps.alertRepair) throw new Error('未装配');
    h.deps.alertRepair.dispatchIssue = dispatch;
    const view = (await list(h, s)).items.find((n) => n.id === alert.id)?.repair;
    const hand = view?.actions.find((a) => a.kind === 'hand-to-repair');
    const click = () =>
      post(h, s, alert.id, { actionId: hand?.id, incident: view?.incident, requestId: uuid() });
    const first = await click();
    expect(first.json.repair).toMatchObject({ state: 'failed', issue: { number: 3100 } });
    expect(issues.calls).toHaveLength(1);
    code = 0;
    const second = await click();
    expect(second.json.repair).toMatchObject({ state: 'handed', issue: { number: 3100 } });
    expect(issues.calls).toHaveLength(1);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.slice(1)).toEqual(['thoerwink8/fleet-dao', '3100']);
    expect(operators[0]).toContain(IDS.founderA);
    expect(attempts[0]?.[0]?.replace(/\\/g, '/')).toContain('/engine/src/bin/dispatch-issue.ts');
    await click();
    expect(attempts).toHaveLength(2);
  });

  it('跨代 failed 不复用已关闭的旧修复单：新 incident 用新幂等键开新单', async () => {
    const h = await pgWorld();
    const opened: string[] = [];
    const dispatched: number[] = [];
    if (!h.deps.alertRepair) throw new Error('未装配');
    h.deps.alertRepair.openIssue = async (input) => {
      opened.push(input.key);
      return {
        number: 3099 + opened.length,
        url: `https://github.com/thoerwink8/fleet-dao/issues/${3099 + opened.length}`,
        created: true,
      };
    };
    let oldClosed = false;
    h.deps.alertRepair.dispatchIssue = async (_repo, number) => {
      dispatched.push(number);
      if (oldClosed && number === 3100) throw new Error('旧修复单已关闭，不可继续派');
      return { ok: oldClosed, text: oldClosed ? '已派新单' : '没派：准入拒绝' };
    };
    await runWatchdog(h, 'idle');
    const alert = await findAlert(h, 'watchdog:idle-running:');
    const s = await h.login();
    const first = (await list(h, s)).items.find((n) => n.id === alert.id)?.repair;
    const hand = first?.actions.find((a) => a.kind === 'hand-to-repair');
    const failed = await post(h, s, alert.id, {
      actionId: hand?.id,
      incident: first?.incident,
      requestId: uuid(),
    });
    expect(failed.json.repair).toMatchObject({ state: 'failed', issue: { number: 3100 } });
    oldClosed = true;
    await setTask({ updatedAt: ago(1) });
    await runWatchdog(h, 'idle');
    await setTask({ updatedAt: ago(60) });
    await runWatchdog(h, 'idle');
    const next = (await list(h, s)).items.find((n) => n.id === alert.id)?.repair;
    const newHand = next?.actions.find((a) => a.kind === 'hand-to-repair');
    const handed = await post(h, s, alert.id, {
      actionId: newHand?.id,
      incident: next?.incident,
      requestId: uuid(),
    });
    expect(handed.json.repair).toMatchObject({ state: 'handed', issue: { number: 3101 } });
    expect(opened).toHaveLength(2);
    expect(opened[0]).not.toBe(opened[1]);
    expect(dispatched).toEqual([3100, 3101]);
  });

  it('派工过程报错结果未知：原单号和 unknown 留存，不重开、不重派', async () => {
    const issues: Issues = { calls: [] };
    const h = await pgWorld({ issues });
    await runWatchdog(h, 'idle');
    const alert = await findAlert(h, 'watchdog:idle-running:');
    const s = await h.login();
    let attempts = 0;
    if (!h.deps.alertRepair) throw new Error('未装配');
    h.deps.alertRepair.dispatchIssue = repairDispatcher(async () => {
      attempts += 1;
      return { code: 1, text: '没查成：审核记录写失败，起工作流回执未知' };
    });
    const view = (await list(h, s)).items.find((n) => n.id === alert.id)?.repair;
    const hand = view?.actions.find((a) => a.kind === 'hand-to-repair');
    const click = () =>
      post(h, s, alert.id, { actionId: hand?.id, incident: view?.incident, requestId: uuid() });
    expect((await click()).json.repair).toMatchObject({ state: 'unknown', issue: { number: 3100 } });
    expect((await click()).status).toBe(409);
    expect(issues.calls).toHaveLength(1);
    expect(attempts).toBe(1);
  });
});

describe('没接上开单（开发环境）', () => {
  it('不出现「交给修复」，原因写在 problems，不假装能修；非看门狗提醒没有 repair', async () => {
    const h = harness({ data: data() });
    h.store.data.notifications.push({
      id: uuid(),
      level: 'alert',
      title: '某个定时任务停了',
      body: 'x',
      createdAt: T0.toISOString(),
      deliveries: [],
      dedupeKey: 'watchdog:job:backup:no-success',
    });
    const s = await h.login();
    const item = (await list(h, s)).items.find((n) => n.dedupeKey === 'watchdog:job:backup:no-success');
    expect(item?.repair?.actions).toEqual([]);
    expect(item?.repair?.problems.join('；')).toContain('立刻重跑');
    expect(item?.repair?.problems.join('；')).toContain('开单没接上');
    h.store.data.notifications.push({
      id: uuid(),
      level: 'alert',
      title: '别的提醒',
      body: '',
      createdAt: T0.toISOString(),
      deliveries: [],
      dedupeKey: 'quota-read:pool-a',
    });
    const other = (await list(h, s)).items.find((n) => n.dedupeKey === 'quota-read:pool-a');
    expect(other?.repair).toBeUndefined();
  });
});

/** 发版进度记录的替身。phase 是下标（3 等收尾、4 发版、7 恢复）。 */
function train(
  status: string,
  phase: number,
  opts: { marker?: boolean; beforeMaster?: boolean | null; sha?: string; startedAt?: string } = {},
): FranceReleasePort {
  return {
    readStateFiles: async () => ({
      stateJson: JSON.stringify({
        schema: 1,
        status,
        phase,
        why: null,
        target: { kind: 'sha', value: opts.sha ?? HEAD },
        updatedAt: iso(90),
        startedAt: opts.startedAt ?? iso(120),
        ...(opts.beforeMaster === undefined ? {} : { before: { master: opts.beforeMaster } }),
      }),
      marker: opts.marker ?? false,
    }),
  };
}

describe('要人本人拍的发版恢复动作：选项 / 推荐 / 自由输入；拒绝、没选、自由输入都不执行', () => {
  // 旧版本写过的 failed 键：看门狗现在不再写它（发版没成由接活脚本报），库里遗留的还在，所以直接落一条
  const failedKey = `watchdog:release:train:${HEAD.slice(0, 12)}:failed`;
  function seed(h: MemHarness) {
    h.store.data.notifications.push({
      id: uuid(),
      level: 'alert',
      title: `发版没成：${HEAD.slice(0, 12)} 恢复那一步没成`,
      body: '恢复引擎开关没成',
      createdAt: T0.toISOString(),
      deliveries: [],
      dedupeKey: failedKey,
    });
    const n = h.store.data.notifications.find((x) => x.dedupeKey === failedKey);
    if (!n) throw new Error('没落上');
    return n;
  }

  it('带 choice（两项以上、恰好一项推荐、允许自己写）；没选 409；先不动 / 自己写只记 declined；选执行才写请求文件，核验读引擎总开关', async () => {
    const req = requestPort();
    const h = harness({
      data: data(false),
      releaseRequest: req.port,
      franceRelease: train('failed', 7, { beforeMaster: true }),
    });
    const alert = seed(h);
    const s = await h.login();
    const view = (await list(h, s)).items.find((n) => n.id === alert.id)?.repair;
    const restore = view?.actions.find((a) => a.kind === 'release-restore');
    expect(restore?.target.sha).toBe(HEAD);
    expect(restore?.choice?.allowText).toBe(true);
    expect(restore?.choice?.options.map((o) => o.id)).toEqual(['do', 'hold']);
    expect(restore?.choice?.options.filter((o) => o.recommended)).toHaveLength(1);
    const base = { actionId: restore?.id, incident: view?.incident };

    const none = await post(h, s, alert.id, { ...base, requestId: uuid() });
    expect([none.status, none.json.error.code]).toEqual([409, 'choice_required']);
    const bad = await post(h, s, alert.id, { ...base, requestId: uuid(), optionId: 'nuke' });
    expect([bad.status, bad.json.error.code]).toEqual([400, 'unknown_option']);
    const hold = await post(h, s, alert.id, { ...base, requestId: uuid(), optionId: 'hold' });
    expect(hold.json.repair).toMatchObject({ state: 'declined', optionId: 'hold' });
    const text = await post(h, s, alert.id, { ...base, requestId: uuid(), text: '我先看看再说' });
    expect(text.json.repair).toMatchObject({ state: 'declined' });
    expect(req.written).toEqual([]);

    const go = await post(h, s, alert.id, { ...base, requestId: uuid(), optionId: 'do' });
    expect(go.json.repair).toMatchObject({ state: 'accepted', kind: 'release-restore', optionId: 'do' });
    expect(go.json.repair.check).toMatchObject({ ok: false });
    expect(req.written).toHaveLength(1);
    expect(JSON.parse(req.written[0] ?? '{}')).toMatchObject({ v: 1, kind: 'restore' });
    expect((await h.store.listAudit({ limit: 100 })).items.map((a) => a.action)).toContain('release.restore');
    // 请求只是写出去了：卡不撤、不记修好；引擎总开关开回来才核成 verified
    expect((await list(h, s)).items.find((n) => n.id === alert.id)?.repair?.last?.state).toBe('accepted');
    const master = h.store.data.settings.find((x) => x.key === 'engine.master');
    if (master) master.value = true;
    h.deps.franceRelease = train('done', 8, { sha: 'b'.repeat(40), beforeMaster: true });
    expect((await list(h, s)).items.find((n) => n.id === alert.id)?.repair?.last?.state).toBe('accepted');
    h.deps.franceRelease = train('done', 8, { startedAt: iso(10), beforeMaster: true });
    expect((await list(h, s)).items.find((n) => n.id === alert.id)?.repair?.last?.state).toBe('accepted');
    h.deps.franceRelease = train('done', 8, { beforeMaster: true });
    expect((await list(h, s)).items.find((n) => n.id === alert.id)?.repair?.last).toMatchObject({
      state: 'verified',
      check: { ok: true },
    });
  });

  it('重试发版不能用另一 SHA 或另一 run 的 done 核成已修复', async () => {
    const req = requestPort();
    const h = harness({ data: data(false), releaseRequest: req.port, franceRelease: train('blocked', 3) });
    const alert = seed(h);
    const s = await h.login();
    const view = (await list(h, s)).items.find((n) => n.id === alert.id)?.repair;
    const retry = view?.actions.find((a) => a.kind === 'release-retry');
    const result = await post(h, s, alert.id, {
      actionId: retry?.id,
      incident: view?.incident,
      requestId: uuid(),
    });
    expect(result.json.repair.state).toBe('accepted');
    for (const opts of [{ sha: 'b'.repeat(40) }, { startedAt: iso(1) }]) {
      h.deps.franceRelease = train('done', 8, opts);
      expect((await list(h, s)).items.find((n) => n.id === alert.id)?.repair?.last).toMatchObject({
        state: 'accepted',
        check: { ok: null },
      });
    }
    h.deps.franceRelease = train('done', 8);
    expect((await list(h, s)).items.find((n) => n.id === alert.id)?.repair?.last).toMatchObject({
      state: 'verified',
      check: { ok: true },
    });
  });

  it('【故意造出的失败】请求文件写不出去：记 failed 不记成功；上一份请求没被接走时不给动作；读不到进度记录不给动作', async () => {
    const req = requestPort();
    req.port.writeRequest = async () => {
      throw Object.assign(new Error('disk'), { code: 'ENOSPC' });
    };
    const h = harness({
      data: data(false),
      releaseRequest: req.port,
      franceRelease: train('failed', 7, { beforeMaster: true }),
    });
    const alert = seed(h);
    const s = await h.login();
    const view = (await list(h, s)).items.find((n) => n.id === alert.id)?.repair;
    const restore = view?.actions.find((a) => a.kind === 'release-restore');
    const res = await post(h, s, alert.id, {
      actionId: restore?.id,
      incident: view?.incident,
      requestId: uuid(),
      optionId: 'do',
    });
    expect(res.json.repair).toMatchObject({ state: 'failed' });
    expect(res.json.repair.text).toContain('没写出去');
    const failedAudit = (await h.store.listAudit({ limit: 100 })).items.filter(
      (a) => a.action === 'release.restore' && !a.ok,
    );
    expect(failedAudit).toHaveLength(1);

    const pending = harness({
      data: data(false),
      releaseRequest: { ...requestPort().port, pendingRequest: async () => true },
      franceRelease: train('failed', 7, { beforeMaster: true }),
    });
    const a2 = seed(pending);
    const p = (await list(pending, await pending.login())).items.find((n) => n.id === a2.id)?.repair;
    expect(p?.actions.some((a) => a.kind === 'release-restore')).toBe(false);
    expect(p?.problems.join('；')).toContain('还没被法国接走');

    const unreadable = harness({
      data: data(false),
      releaseRequest: requestPort().port,
      franceRelease: {
        readStateFiles: async () => {
          throw new Error('读不了');
        },
      },
    });
    const a3 = seed(unreadable);
    const u = (await list(unreadable, await unreadable.login())).items.find((n) => n.id === a3.id)?.repair;
    expect(u?.actions.some((a) => a.kind.startsWith('release-'))).toBe(false);
  });
});
