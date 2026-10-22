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
import { notifications, pullRequests, registerScheduledJobs, repos, runs, tasks } from '@fleet-dao/db';
import { createTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import type { AlertRepairLink, AlertRepairRecord } from '@fleet-dao/shared';
import {
  ALERT_REPAIR_KINDS,
  ALERT_REPAIR_STATES,
  AlertRepairViewSchema,
  LinkAlertRepairResponse,
  NotificationsResponse,
  TASK_SIGNAL_NAMES,
  WEB_API_PREFIX,
} from '@fleet-dao/shared';
import { createPgStore, devFixtures, IDS, type MemoryData } from '@fleet-dao/store';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runWatchdogJob, WATCHDOG_JOB, type WatchdogDeps } from '../../engine/src/jobs/watchdog.ts';
import { watchdogJob } from '../../engine/src/real/watchdog.ts';
import {
  type AlertRepairPort,
  alertRepairViews,
  pgAlertRepair,
  repairSettingKey,
} from '../src/alert-repair.ts';
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

const repairAuditHits = async (h: AnyHarness, state: string, requestId?: string) =>
  (await repairAudits(h)).filter((a) => {
    const after = a.after as { state?: string; requestId?: string } | undefined;
    return after?.state === state && (requestId === undefined || after.requestId === requestId);
  });

async function repairRow(h: AnyHarness, id: string) {
  const row = (await h.store.listSettings()).find((item) => item.key === repairSettingKey(id));
  if (!row) throw new Error('没有修复状态');
  return row;
}

type PutSetting = PgHarness['store']['putSetting'];

/** 只拦最终结算（接活的 executing 照写）。用来让最后一次 putSetting 冲突、抛错，或先落一个并发赢家。 */
function hookFinalSettle(
  h: PgHarness,
  settle: (
    input: Parameters<PutSetting>[0],
    audit: Parameters<PutSetting>[1],
    original: PutSetting,
  ) => ReturnType<PutSetting>,
) {
  const original = h.store.putSetting.bind(h.store) as PutSetting;
  h.store.putSetting = (input, audit) => {
    const value = input.value;
    const state =
      typeof value === 'object' && value !== null && 'state' in value
        ? (value as { state?: string }).state
        : undefined;
    if (state !== undefined && state !== 'executing') return settle(input, audit, original);
    return original(input, audit);
  };
}

/** 信号发出去之后任务行变新，同一次 POST 的核验会在内存里算出 verified。 */
function recoverDuringSignal(h: PgHarness) {
  const signal = h.deps.workflows.signal.bind(h.deps.workflows);
  h.deps.workflows.signal = async (workflowId, sig, runId) => {
    await signal(workflowId, sig, runId);
    await setTask({ updatedAt: new Date(h.clock.now.getTime() - MIN) });
  };
}

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
    const acceptedRow = await repairRow(h, alert.id);
    expect(acceptedRow.value).toEqual(sent.json.repair);
    expect(await repairAuditHits(h, 'accepted', requestId)).toHaveLength(1);
    // 真发了两下：先继续、再路由叫醒，发给当前工作流
    expect(h.signals.map((x) => [x.workflowId, x.signal.name])).toEqual([
      ['task:example/canary#12', TASK_SIGNAL_NAMES.continue],
      ['task:example/canary#12', TASK_SIGNAL_NAMES.routeWake],
    ]);
    // 受理不撤卡；列表上这张卡写着「已受理、未修好」，同一个动作不再给按钮
    const mid = (await list(h, s)).items.find((n) => n.id === alert.id);
    expect(mid?.resolvedAt).toBeUndefined();
    expect(mid?.repair?.last).toEqual(sent.json.repair);
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
    expect(after?.repair?.last).toMatchObject({ state: 'verified', requestId, check: { ok: true } });
    const verifiedRow = await repairRow(h, alert.id);
    expect(verifiedRow.value).toEqual(after?.repair?.last);
    expect(await repairAuditHits(h, 'verified', requestId)).toHaveLength(1);
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
    const requestId = uuid();
    const unknown = await post(h, s, alert.id, {
      actionId: recover?.id,
      incident: view?.incident,
      requestId,
    });
    expect(unknown.status).toBe(200);
    expect(unknown.json.repair).toMatchObject({ state: 'unknown', requestId, kind: 'task-recover' });
    const unknownRow = await repairRow(h, alert.id);
    expect(unknownRow.value).toEqual(unknown.json.repair);
    expect((await list(h, s)).items.find((n) => n.id === alert.id)?.repair?.last).toEqual(
      unknown.json.repair,
    );
    expect(await repairAuditHits(h, 'unknown', requestId)).toHaveLength(1);
    const click = () =>
      post(h, s, alert.id, { actionId: recover?.id, incident: view?.incident, requestId: uuid() });
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

describe('最终结算的回执必须是已落库的记录', () => {
  async function idleClick() {
    const h = await pgWorld();
    await runWatchdog(h, 'idle');
    const alert = await findAlert(h, 'watchdog:idle-running:');
    const s = await h.login();
    const view = (await list(h, s)).items.find((n) => n.id === alert.id)?.repair;
    const recover = view?.actions.find((a) => a.kind === 'task-recover');
    const hand = view?.actions.find((a) => a.kind === 'hand-to-repair');
    if (!view || !recover || !hand) throw new Error('没有可点的修复');
    return { h, s, alert, view, recover, hand };
  }

  const bodyOf = (
    view: { incident: string },
    actionId: string,
    requestId = uuid(),
  ): { actionId: string; incident: string; requestId: string } => ({
    actionId,
    incident: view.incident,
    requestId,
  });

  it('当场核验通过：POST、设置表、随后的 GET 和 verified 审计是同一份', async () => {
    const { h, s, alert, view, recover } = await idleClick();
    recoverDuringSignal(h);
    const requestId = uuid();
    const sent = await post(h, s, alert.id, bodyOf(view, recover.id, requestId));
    expect(sent.status).toBe(200);
    expect(sent.json.replayed).toBe(false);
    expect(sent.json.repair).toMatchObject({ state: 'verified', requestId, kind: 'task-recover' });
    const row = await repairRow(h, alert.id);
    expect(row.value).toEqual(sent.json.repair);
    const again = (await list(h, s)).items.find((n) => n.id === alert.id)?.repair?.last;
    expect(again).toEqual(sent.json.repair);
    expect(await repairAuditHits(h, 'verified', requestId)).toHaveLength(1);
    expect(h.signals).toHaveLength(2);
  });

  it('最终 putSetting 冲突：内存 verified 不能当 200；持久仍是 executing；同请求不重放，新请求和新事故都不覆盖', async () => {
    const { h, s, alert, view, recover } = await idleClick();
    recoverDuringSignal(h);
    hookFinalSettle(h, () => Promise.resolve('conflict'));
    const requestId = uuid();
    const sent = await post(h, s, alert.id, bodyOf(view, recover.id, requestId));
    expect([sent.status, sent.json.error.code]).toEqual([409, 'repair_conflict']);
    expect(JSON.stringify(sent.json)).not.toContain('verified');
    const row = await repairRow(h, alert.id);
    expect(row.value).toMatchObject({
      state: 'executing',
      requestId,
      incident: view.incident,
      actionId: recover.id,
    });
    expect((await list(h, s)).items.find((n) => n.id === alert.id)?.repair?.last).toMatchObject({
      state: 'executing',
      requestId,
    });
    expect(await repairAuditHits(h, 'verified')).toHaveLength(0);
    expect(await repairAuditHits(h, 'executing', requestId)).toHaveLength(1);
    expect(h.signals).toHaveLength(2);

    const replay = await post(h, s, alert.id, bodyOf(view, recover.id, requestId));
    expect(replay.status).toBe(200);
    expect(replay.json).toMatchObject({ replayed: true, repair: { state: 'executing', requestId } });
    expect(h.signals).toHaveLength(2);

    // 信号把任务行更新了，动作编号会变；拨回原来的更新时间，旧编号仍在，新请求被在途挡住，不会重发。
    await setTask({ updatedAt: ago(60) });
    const again = await post(h, s, alert.id, bodyOf(view, recover.id));
    expect([again.status, again.json.error.code]).toEqual([409, 'repair_in_flight']);
    expect(h.signals).toHaveLength(2);
    expect((await repairRow(h, alert.id)).value).toMatchObject({ state: 'executing', requestId });

    await t.db
      .update(notifications)
      .set({ raisedAt: new Date(T0.getTime() + MIN) })
      .where(eq(notifications.id, alert.id));
    const next = (await list(h, s)).items.find((n) => n.id === alert.id)?.repair;
    expect(next?.incident).not.toBe(view.incident);
    expect(next?.actions).toEqual([]);
    const denied = await post(h, s, alert.id, {
      actionId: recover.id,
      incident: next?.incident ?? '',
      requestId: uuid(),
    });
    expect([denied.status, denied.json.error.code]).toEqual([409, 'repair_prior_incident_pending']);
    expect((await repairRow(h, alert.id)).value).toMatchObject({
      state: 'executing',
      requestId,
      incident: view.incident,
    });
    expect(h.signals).toHaveLength(2);
  });

  it('冲突赢家是精确同一事故、请求和动作：回已落库的那条，不回内存 verified，也不再写', async () => {
    const { h, s, alert, view, recover } = await idleClick();
    recoverDuringSignal(h);
    const requestId = uuid();
    let finals = 0;
    hookFinalSettle(h, async (input, audit, original) => {
      finals += 1;
      const winner = { ...asRepair(input.value), state: 'failed', text: '并发赢家落库的失败结果' };
      await original(
        { ...input, value: winner },
        {
          ...audit,
          reason: winner.text,
          after: { ...(audit.after as Record<string, unknown>), state: 'failed' },
        },
      );
      return 'conflict';
    });
    const sent = await post(h, s, alert.id, bodyOf(view, recover.id, requestId));
    expect(sent.status).toBe(200);
    expect(sent.json.replayed).toBe(false);
    expect(sent.json.repair).toMatchObject({
      state: 'failed',
      requestId,
      actionId: recover.id,
      incident: view.incident,
      text: '并发赢家落库的失败结果',
    });
    expect(sent.json.repair.state).not.toBe('verified');
    expect((await repairRow(h, alert.id)).value).toEqual(sent.json.repair);
    expect((await list(h, s)).items.find((n) => n.id === alert.id)?.repair?.last).toEqual(sent.json.repair);
    expect(await repairAuditHits(h, 'verified')).toHaveLength(0);
    expect(await repairAuditHits(h, 'failed', requestId)).toHaveLength(1);
    expect(finals).toBe(1);
    expect(h.signals).toHaveLength(2);
  });

  it('并发赢家是别的请求或别的事故：409，不回内存 verified，也不覆盖赢家', async () => {
    const otherRequest = uuid();
    const { h, s, alert, view, recover } = await idleClick();
    recoverDuringSignal(h);
    hookFinalSettle(h, async (input, audit, original) => {
      const winner = {
        ...asRepair(input.value),
        requestId: otherRequest,
        state: 'failed',
        text: '别的请求先落库了',
      };
      await original(
        { ...input, value: winner },
        {
          ...audit,
          reason: winner.text,
          after: { ...(audit.after as Record<string, unknown>), state: 'failed', requestId: otherRequest },
        },
      );
      return 'conflict';
    });
    const sent = await post(h, s, alert.id, bodyOf(view, recover.id));
    expect([sent.status, sent.json.error.code]).toEqual([409, 'repair_conflict']);
    expect(JSON.stringify(sent.json)).not.toContain('verified');
    expect((await repairRow(h, alert.id)).value).toMatchObject({
      state: 'failed',
      requestId: otherRequest,
      text: '别的请求先落库了',
    });
    expect(h.signals).toHaveLength(2);

    const next = await idleClick();
    recoverDuringSignal(next.h);
    hookFinalSettle(next.h, async (input, audit, original) => {
      const winner = {
        ...asRepair(input.value),
        incident: 'other-incident',
        state: 'accepted',
        text: '别的事故先落库了',
      };
      await original(
        { ...input, value: winner },
        {
          ...audit,
          reason: winner.text,
          after: { ...(audit.after as Record<string, unknown>), state: 'accepted' },
        },
      );
      return 'conflict';
    });
    const crossed = await post(next.h, next.s, next.alert.id, bodyOf(next.view, next.recover.id));
    expect([crossed.status, crossed.json.error.code]).toEqual([409, 'repair_conflict']);
    expect((await repairRow(next.h, next.alert.id)).value).toMatchObject({
      incident: 'other-incident',
      state: 'accepted',
      text: '别的事故先落库了',
    });
    expect(next.h.signals).toHaveLength(2);
  });

  it('持久写入失败：不回内存 verified；读也失败时明确读不懂，都不重放', async () => {
    const { h, s, alert, view, recover } = await idleClick();
    recoverDuringSignal(h);
    hookFinalSettle(h, () => Promise.reject(new Error('设置表写不进去')));
    const requestId = uuid();
    const sent = await post(h, s, alert.id, bodyOf(view, recover.id, requestId));
    expect([sent.status, sent.json.error.code]).toEqual([409, 'repair_conflict']);
    expect(sent.json.error.message).toContain('持久写入失败');
    expect(JSON.stringify(sent.json)).not.toContain('verified');
    expect((await repairRow(h, alert.id)).value).toMatchObject({ state: 'executing', requestId });
    expect((await list(h, s)).items.find((n) => n.id === alert.id)?.repair?.last?.state).toBe('executing');
    expect(await repairAuditHits(h, 'verified')).toHaveLength(0);
    const replay = await post(h, s, alert.id, bodyOf(view, recover.id, requestId));
    expect(replay.json).toMatchObject({ replayed: true, repair: { state: 'executing', requestId } });
    expect(h.signals).toHaveLength(2);

    const unread = await idleClick();
    recoverDuringSignal(unread.h);
    let trap = false;
    const listSettings = unread.h.store.listSettings.bind(unread.h.store);
    unread.h.store.listSettings = async () => {
      if (trap) {
        trap = false;
        throw new Error('设置表读不出来');
      }
      return listSettings();
    };
    hookFinalSettle(unread.h, () => {
      trap = true;
      return Promise.reject(new Error('设置表写不进去'));
    });
    const blind = await post(unread.h, unread.s, unread.alert.id, bodyOf(unread.view, unread.recover.id));
    expect([blind.status, blind.json.error.code]).toEqual([409, 'repair_state_unreadable']);
    expect(JSON.stringify(blind.json)).not.toContain('verified');
    expect((await repairRow(unread.h, unread.alert.id)).value).toMatchObject({ state: 'executing' });
    expect(unread.h.signals).toHaveLength(2);
  });

  it('结算冲突后持久状态读不到或读不懂：不回内存 verified，设置表仍是 executing', async () => {
    const thrown = await idleClick();
    recoverDuringSignal(thrown.h);
    let trap = false;
    const listSettings = thrown.h.store.listSettings.bind(thrown.h.store);
    thrown.h.store.listSettings = async () => {
      if (trap) {
        trap = false;
        throw new Error('设置表读不出来');
      }
      return listSettings();
    };
    hookFinalSettle(thrown.h, () => {
      trap = true;
      return Promise.resolve('conflict');
    });
    const sent = await post(thrown.h, thrown.s, thrown.alert.id, bodyOf(thrown.view, thrown.recover.id));
    expect([sent.status, sent.json.error.code]).toEqual([409, 'repair_state_unreadable']);
    expect(sent.json.error.message).toContain('没读到');
    expect((await repairRow(thrown.h, thrown.alert.id)).value).toMatchObject({ state: 'executing' });
    expect(
      (await list(thrown.h, thrown.s)).items.find((n) => n.id === thrown.alert.id)?.repair?.last?.state,
    ).toBe('executing');
    expect(await repairAuditHits(thrown.h, 'verified')).toHaveLength(0);
    expect(thrown.h.signals).toHaveLength(2);

    const corrupt = await idleClick();
    recoverDuringSignal(corrupt.h);
    let lie = false;
    const read = corrupt.h.store.listSettings.bind(corrupt.h.store);
    corrupt.h.store.listSettings = async () => {
      const rows = await read();
      if (!lie) return rows;
      lie = false;
      return rows.map((row) =>
        row.key === repairSettingKey(corrupt.alert.id) ? { ...row, value: { broken: true } } : row,
      );
    };
    hookFinalSettle(corrupt.h, () => {
      lie = true;
      return Promise.resolve('conflict');
    });
    const garbled = await post(
      corrupt.h,
      corrupt.s,
      corrupt.alert.id,
      bodyOf(corrupt.view, corrupt.recover.id),
    );
    expect([garbled.status, garbled.json.error.code]).toEqual([409, 'repair_state_unreadable']);
    expect(garbled.json.error.message).toContain('读不懂');
    expect(JSON.stringify(garbled.json)).not.toContain('verified');
    expect((await repairRow(corrupt.h, corrupt.alert.id)).value).toMatchObject({ state: 'executing' });
    expect(corrupt.h.signals).toHaveLength(2);
  });

  it('交给修复的最终结算冲突：不回 handed；开单和派工只发生一次，重试不再开', async () => {
    const issues: Issues = { calls: [] };
    const h = await pgWorld({ issues });
    await runWatchdog(h, 'idle');
    const alert = await findAlert(h, 'watchdog:idle-running:');
    const s = await h.login();
    const view = (await list(h, s)).items.find((n) => n.id === alert.id)?.repair;
    const hand = view?.actions.find((a) => a.kind === 'hand-to-repair');
    if (!view || !hand || !h.deps.alertRepair?.dispatchIssue) throw new Error('没有交给修复');
    let dispatches = 0;
    const dispatch = h.deps.alertRepair.dispatchIssue.bind(h.deps.alertRepair);
    h.deps.alertRepair.dispatchIssue = async (...args) => {
      dispatches += 1;
      return dispatch(...args);
    };
    hookFinalSettle(h, () => Promise.resolve('conflict'));
    const requestId = uuid();
    const sent = await post(h, s, alert.id, bodyOf(view, hand.id, requestId));
    expect([sent.status, sent.json.error.code]).toEqual([409, 'repair_conflict']);
    expect(JSON.stringify(sent.json)).not.toContain('handed');
    expect(issues.calls).toHaveLength(1);
    expect(dispatches).toBe(1);
    expect((await repairRow(h, alert.id)).value).toMatchObject({
      state: 'executing',
      requestId,
      kind: 'hand-to-repair',
    });
    const replay = await post(h, s, alert.id, bodyOf(view, hand.id, requestId));
    expect(replay.json).toMatchObject({ replayed: true, repair: { state: 'executing', requestId } });
    const again = await post(h, s, alert.id, bodyOf(view, hand.id));
    expect([again.status, again.json.error.code]).toEqual([409, 'repair_in_flight']);
    expect(issues.calls).toHaveLength(1);
    expect(dispatches).toBe(1);
  });

  it('结果未知的结算冲突：不回内存 unknown，不重发信号', async () => {
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
    if (!view || !recover) throw new Error('没有叫醒');
    let calls = 0;
    h.deps.workflows.signal = async () => {
      calls += 1;
      throw new WorkflowUnavailableError('Temporal 超时');
    };
    hookFinalSettle(h, () => Promise.resolve('conflict'));
    const requestId = uuid();
    const sent = await post(h, s, alert.id, bodyOf(view, recover.id, requestId));
    expect([sent.status, sent.json.error.code]).toEqual([409, 'repair_conflict']);
    expect(JSON.stringify(sent.json)).not.toContain('unknown');
    expect((await repairRow(h, alert.id)).value).toMatchObject({ state: 'executing', requestId });
    expect(await repairAuditHits(h, 'unknown')).toHaveLength(0);
    const replay = await post(h, s, alert.id, bodyOf(view, recover.id, requestId));
    expect(replay.json).toMatchObject({ replayed: true, repair: { state: 'executing' } });
    expect(calls).toBe(1);
  });
});

function asRepair(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error('修复记录不是对象');
  return { ...(value as Record<string, unknown>) };
}

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
    expect(checkIssueBody(opened.body, { kind: '缺陷' }).ok).toBe(true);
    for (const sec of ['## 场景', '## 影响', '## 原话', '## 已知的模块', '## 怎么算做完']) {
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

// —— 明确关联已有单（#3100）——
// 场景：自然告警 watchdog:red:hourly-reconcile:after-27632 的根因已由开放单 #3090 承接。可信操作者显式指定「这次告警归 #3090」，
// 服务端现读核实后落库；之后交给修复沿用这条绑定，不再开第二张单，也不对已有工人 / 开放 PR 的单再派工。
// 没有显式绑定的相似标题不自动归并。全部跑在 PGlite 真库 + 真路由 + 真 Store 上，GitHub 读单和派工是可控替身。

const HOURLY_KEY = 'watchdog:red:hourly-reconcile:after-27632';
const HOURLY_ID = 'b0ff48f3-0a97-4b8f-817e-1f2cc240f73c';
const EXISTING = 3090;
const SELF_REPO = { owner: 'thoerwink8', name: 'fleet-dao' };
const linkPath = `${WEB_API_PREFIX}/notifications/${HOURLY_ID}/repair/link`;
interface IssueRead {
  state: 'open' | 'closed';
  stateReason: string | null;
}
const OPEN_ISSUE: IssueRead = { state: 'open', stateReason: null };
const ghError = (code: string) => Object.assign(new Error(`GitHub ${code}`), { code });

// 已有消费者的线上契约（#3033 上线时的样子，#3034 / PR3083 的通知卡按它查 PHASE_META[state].tone、KIND_LABEL[kind]）：
// 枚举照抄、对象严格（多一个字段也算不兼容）。关联不能让 last / repair 里冒出新的 kind / state / 字段。
const OLD_STATES = ['executing', 'accepted', 'verified', 'failed', 'unknown', 'declined', 'handed'] as const;
const OLD_KINDS = [
  'task-recover',
  'release-retry',
  'release-restore',
  'release-abort',
  'hand-to-repair',
] as const;
const OldRecord = z.strictObject({
  incident: z.string(),
  actionId: z.string(),
  kind: z.enum(OLD_KINDS),
  requestId: z.string(),
  state: z.enum(OLD_STATES),
  text: z.string(),
  at: z.string(),
  by: z.string(),
  optionId: z.string().optional(),
  target: z.record(z.string(), z.unknown()).optional(),
  baseline: z.string().optional(),
  check: z.unknown().optional(),
  issue: z
    .strictObject({
      repo: z.strictObject({ owner: z.string(), name: z.string() }),
      number: z.number(),
      url: z.string(),
      created: z.boolean(),
    })
    .optional(),
});
const PHASE_META: Record<string, { tone: string }> = Object.fromEntries(
  OLD_STATES.map((s) => [s, { tone: s }]),
);
const KIND_LABEL: Record<string, string> = Object.fromEntries(OLD_KINDS.map((k) => [k, k]));
/** 旧消费者读一条修复记录：先过旧 schema，再做和通知卡同一个解引用（新枚举在这里会抛 reading 'tone'）。 */
function oldConsumer(raw: unknown): string {
  const rec = OldRecord.parse(raw);
  const loose = raw as { state: string; kind: string };
  const tone = (PHASE_META[loose.state] as { tone: string }).tone;
  const label = KIND_LABEL[loose.kind];
  if (label === undefined) throw new Error(`旧消费者认不出 kind ${loose.kind}`);
  return `${label}/${tone}/${rec.state}`;
}
/** 视图过新契约，并且 last（有的话）过旧消费者。 */
function expectOldSafe(view: unknown): void {
  const parsed = AlertRepairViewSchema.parse(view);
  if (parsed.last) oldConsumer((view as { last: unknown }).last);
}

async function linkWorld() {
  const base = data();
  const h = await pgHarness(t, {
    data: {
      ...base,
      notifications: [
        ...(base.notifications ?? []),
        {
          id: HOURLY_ID,
          level: 'alert',
          title: '每小时对账持续 partial',
          body: '旧树 thoerwink8_fleet-dao/3033-t01a14e1b 的复杂脏成果保全保护导致对账持续 partial',
          createdAt: iso(30),
          deliveries: [],
          dedupeKey: HOURLY_KEY,
        },
      ],
    },
  });
  current = h;
  const f = {
    opened: [] as OpenedIssue[],
    dispatched: [] as { number: number; argc: number; operator: string }[],
    reads: [] as number[],
    read: (_n: number): IssueRead | Error => OPEN_ISSUE,
  };
  const port: AlertRepairPort = {
    openIssue: async (input) => {
      f.opened.push(input);
      return { number: 4000, url: 'https://github.com/thoerwink8/fleet-dao/issues/4000', created: true };
    },
    readIssueState: async ({ issueNumber }) => {
      f.reads.push(issueNumber);
      const got = f.read(issueNumber);
      if (got instanceof Error) throw got;
      return got;
    },
    dispatchIssue: async (...args: unknown[]) => {
      f.dispatched.push({ number: args[1] as number, argc: args.length, operator: String(args[2]) });
      return { ok: true, text: '已派' };
    },
  };
  h.deps.alertRepair = port;
  return { h, f, port, s: await h.login() };
}
type LinkWorld = Awaited<ReturnType<typeof linkWorld>>;

async function hourlyView(w: LinkWorld) {
  const v = (await list(w.h, w.s)).items.find((n) => n.id === HOURLY_ID)?.repair;
  if (!v) throw new Error('没有 repair 视图');
  expectOldSafe(v);
  return v;
}
type HourlyView = Awaited<ReturnType<typeof hourlyView>>;

function linkBody(v: HourlyView, over: Record<string, unknown> = {}) {
  if (!v.linkAction) throw new Error('视图没有给关联版本');
  return {
    actionId: v.linkAction.actionId,
    incident: v.incident,
    requestId: uuid(),
    repo: SELF_REPO,
    issueNumber: EXISTING,
    ...over,
  };
}

/** 关联接口的回包（成功只带 linked，不带 repair；409 带 error）。 */
interface LinkJson {
  replayed?: boolean;
  linked: AlertRepairLink;
  repair?: unknown;
  error: { code: string; message: string };
}
async function postLink(w: LinkWorld, body: Record<string, unknown>) {
  const res = await w.h.cockpit.request(linkPath, write('POST', w.s, body));
  const json = (await res.json()) as LinkJson;
  if (res.status === 200) LinkAlertRepairResponse.parse(json);
  return { status: res.status, json };
}

/** 重建 deps（全新的 Store 实例读同一个库）后列表视图：过新契约 + 旧消费者。 */
async function rebuiltView(w: LinkWorld) {
  const fresh = createPgStore(t.db, { now: () => new Date(w.h.clock.now) });
  const items = (await fresh.listNotifications({ status: 'all', limit: 200 })).items;
  const view = (await alertRepairViews({ ...w.h.deps, store: fresh }, items)).get(HOURLY_ID);
  if (!view) throw new Error('重建后没有 repair 视图');
  expectOldSafe(JSON.parse(JSON.stringify(view)));
  return { view, open: items.find((n) => n.id === HOURLY_ID)?.resolvedAt === undefined };
}

/** 点过的「交给修复」编号：在途 / 已开单后列表不再给按钮，再点用旧编号，验证服务端自己挡住。 */
const seenHand = new WeakMap<LinkWorld, string>();
async function clickHand(w: LinkWorld) {
  const v = await hourlyView(w);
  const hand = v.actions.find((a) => a.kind === 'hand-to-repair') ?? { id: seenHand.get(w) };
  if (!hand.id) throw new Error('没有交给修复');
  seenHand.set(w, hand.id);
  const res = await post(w.h, w.s, HOURLY_ID, { actionId: hand.id, incident: v.incident, requestId: uuid() });
  if (res.status === 200) oldConsumer(res.json.repair);
  return res;
}

const hourlyRow = async (h: AnyHarness) =>
  (await h.store.listSettings()).find((row) => row.key === repairSettingKey(HOURLY_ID));

/** 没开单、没派工、没落库、没有修复审计：拒绝路径的共同断言。 */
async function expectUntouched(w: LinkWorld) {
  expect(w.f.opened).toEqual([]);
  expect(w.f.dispatched).toEqual([]);
  expect(await hourlyRow(w.h)).toBeUndefined();
  expect(await repairAudits(w.h)).toEqual([]);
}

describe('明确关联已有单：线上契约不加枚举', () => {
  it('修复记录的 kind / state 枚举和 #3033 上线时一样：关联不占枚举，只走可选的 linked / linkAction', () => {
    expect([...ALERT_REPAIR_STATES]).toEqual([...OLD_STATES]);
    expect([...ALERT_REPAIR_KINDS]).toEqual([...OLD_KINDS]);
    // 旧消费者对新枚举确实会崩（证明上面这条守的是真问题）
    expect(() => oldConsumer({ state: 'linked', kind: 'link-existing' })).toThrow();
    expect(PHASE_META.linked).toBeUndefined();
  });
});

describe('明确关联已有单：端点校验与审计', () => {
  it('成功只回 linked 元数据（不是一次修复）；非 issue / 错仓 / 已关闭 / 404 / 无读权限 / 网络错误 / 事实读不到全部拒绝，零开单零派工零记录，不回退成开单', async () => {
    const w = await linkWorld();
    const v = await hourlyView(w);
    expect(v.linkAction).toMatchObject({ repo: SELF_REPO });
    expect(v.linked).toBeUndefined();
    expect(v.actions.map((a) => a.kind)).toEqual(['hand-to-repair']);

    const rejected: [string, IssueRead | Error, Record<string, unknown>, number, string][] = [
      ['非 issue（PR）', ghError('NOT_AN_ISSUE'), {}, 409, 'link_not_issue'],
      ['已关闭', { state: 'closed', stateReason: 'completed' }, {}, 409, 'link_issue_closed'],
      ['404', ghError('NOT_FOUND'), {}, 404, 'link_issue_not_found'],
      ['无读权限', ghError('FORBIDDEN'), {}, 502, 'link_issue_forbidden'],
      ['网络错误', new Error('socket hang up'), {}, 502, 'link_issue_unreadable'],
      ['错仓', OPEN_ISSUE, { repo: { owner: 'thoerwink8', name: 'other' } }, 409, 'link_wrong_repo'],
      ['动作版本不是服务端给的', OPEN_ISSUE, { actionId: 'link-existing:forged' }, 409, 'action_expired'],
      ['incident 不是当前事故', OPEN_ISSUE, { incident: 'stale' }, 409, 'incident_mismatch'],
    ];
    for (const [why, read, over, status, code] of rejected) {
      w.f.read = () => read;
      const r = await postLink(w, linkBody(v, over));
      expect([why, r.status, r.json.error.code]).toEqual([why, status, code]);
      await expectUntouched(w);
    }
    // 请求里多塞字段（比如伪造的 actor）：整个请求 400
    w.f.read = () => OPEN_ISSUE;
    expect((await postLink(w, { ...linkBody(v), actor: 'attacker' })).status).toBe(400);
    expect((await postLink(w, { ...linkBody(v), issueNumber: 0 })).status).toBe(400);
    await expectUntouched(w);
    // 任务 / PR 事实读不到：不能当成「没有工人」放行
    const realFind = w.h.deps.store.findTaskByIssue.bind(w.h.deps.store);
    w.h.deps.store.findTaskByIssue = async () => {
      throw new Error('库连不上');
    };
    const facts = await postLink(w, linkBody(v));
    expect([facts.status, facts.json.error.code]).toEqual([502, 'link_facts_unreadable']);
    await expectUntouched(w);
    w.h.deps.store.findTaskByIssue = realFind;

    const ok = await postLink(w, linkBody(v));
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({
      replayed: false,
      linked: {
        incident: v.incident,
        actionId: v.linkAction?.actionId,
        by: IDS.founderA,
        issue: {
          repo: SELF_REPO,
          number: EXISTING,
          url: `https://github.com/thoerwink8/fleet-dao/issues/${EXISTING}`,
        },
        reason: 'operator-explicit',
        stage: 'linked',
      },
    });
    expect(ok.json.repair).toBeUndefined();
    expect(ok.json.linked.invalid).toBeUndefined();
    expect(w.f.reads.at(-1)).toBe(EXISTING);
    expect(w.f.opened).toEqual([]);
    expect(w.f.dispatched).toEqual([]);
    // 列表：关联只进 linked，last 里没有冒出新枚举（没有 last），关联入口不再给
    const after = await hourlyView(w);
    expect(after.last).toBeUndefined();
    expect(after.linked).toEqual(ok.json.linked);
    expect(after.linkAction).toBeUndefined();
  });

  it('审计 spy：成功只有一次，actor / via / 通知 / incident / 目标单 / 关联原因精确匹配登录身份和请求；拒绝与伪造 actor 不产生审计', async () => {
    const w = await linkWorld();
    const real = w.h.deps.store.putSetting.bind(w.h.deps.store);
    const calls: Parameters<typeof real>[] = [];
    w.h.deps.store.putSetting = (...args) => {
      calls.push(args);
      return real(...args);
    };
    const v = await hourlyView(w);
    expect((await postLink(w, { ...linkBody(v), actor: 'attacker' })).status).toBe(400);
    w.f.read = () => ({ state: 'closed', stateReason: 'completed' });
    expect((await postLink(w, linkBody(v))).status).toBe(409);
    expect((await postLink(w, linkBody(v, { repo: { owner: 'x', name: 'y' } }))).status).toBe(409);
    expect(calls).toEqual([]);
    expect(await repairAudits(w.h)).toEqual([]);

    w.f.read = () => OPEN_ISSUE;
    const body = linkBody(v);
    expect((await postLink(w, body)).status).toBe(200);
    expect(calls).toHaveLength(1);
    const [input, audit] = calls[0] ?? [];
    expect(input).toMatchObject({
      key: repairSettingKey(HOURLY_ID),
      by: { kind: 'user', id: IDS.founderA },
      expectedVersion: 0,
      expectedNotification: { id: HOURLY_ID, requireOpen: true },
    });
    expect(audit).toMatchObject({
      actor: { kind: 'user', id: IDS.founderA },
      action: 'alert.repair',
      target: `notification:${HOURLY_ID}`,
      via: 'cockpit',
      ok: true,
      after: {
        kind: 'link-existing',
        state: 'linked',
        actionId: body.actionId,
        requestId: body.requestId,
        incident: v.incident,
        issue: `thoerwink8/fleet-dao#${EXISTING}`,
        linkReason: 'operator-explicit',
        linkStage: 'linked',
        linkBy: IDS.founderA,
      },
    });
    expect(audit?.reason).toContain(`thoerwink8/fleet-dao#${EXISTING}`);
    expect(JSON.stringify(calls)).not.toContain('attacker');
    const stored = await repairAudits(w.h);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ actor: { id: IDS.founderA }, target: `notification:${HOURLY_ID}` });
  });
});

const task3090 = { id: 'task-3090', repoId: SELF.id, issueNumber: EXISTING, state: 'running' };
const pr3090 = {
  repoId: SELF.id,
  number: 3095,
  state: 'open',
  headRef: 'fleet/3090',
  headSha: 'abc',
  checks: 'pending',
  issueRefs: [EXISTING],
};

describe('明确关联已有单：真实存储', () => {
  it.each([
    ['只绑定、待处理', {}, 'linked', {}],
    ['已有进行中的任务', { findTaskByIssue: async () => task3090 }, 'worker-active', { taskId: 'task-3090' }],
    ['已有开放修复 PR', { listPullRequests: async () => [pr3090] }, 'pr-open', { prNumber: 3095 }],
  ] as const)(
    '%s：精确 incident 关联和版本落库；重建 deps 后 linked 给出 issue / 操作者 / 阶段 / 原因 / 原版本，last 没有新枚举；通知仍开着，不写 verified / handed',
    async (_name, stub, stage, extra) => {
      const w = await linkWorld();
      const v = await hourlyView(w);
      const body = linkBody(v);
      // 任务 / PR 事实只在关联那一刻替身；下面重建的 deps 用全新 Store，不带替身
      Object.assign(w.h.deps.store, stub);
      expect((await postLink(w, body)).status).toBe(200);

      const { view: after, open } = await rebuiltView(w);
      expect(after.incident).toBe(v.incident);
      expect(after.last).toBeUndefined();
      expect(after.linked).toEqual({
        incident: v.incident,
        issue: {
          repo: SELF_REPO,
          number: EXISTING,
          url: `https://github.com/thoerwink8/fleet-dao/issues/${EXISTING}`,
        },
        reason: 'operator-explicit',
        stage,
        ...extra,
        actionId: v.linkAction?.actionId,
        requestId: body.requestId,
        by: IDS.founderA,
        at: expect.any(String),
        text: expect.stringContaining(`thoerwink8/fleet-dao#${EXISTING}`),
      });
      expect(after.linkAction).toBeUndefined();
      expect(after.actions.map((a) => a.kind)).toEqual(['hand-to-repair']);
      expect(open).toBe(true);
      // 原卡的修复状态：内部关联记录，不是 verified / handed / accepted，也没有核验结果
      const row = (await hourlyRow(w.h))?.value as Record<string, unknown>;
      expect(row).toMatchObject({ state: 'linked', kind: 'link-existing', incident: v.incident });
      expect(row.check).toBeUndefined();
      expect(w.f.opened).toEqual([]);
      expect(w.f.dispatched).toEqual([]);
    },
  );

  it('旧事故的关联行不盖新代次：重开后重建 deps，新事故既没有 last 也没有 linked，可重新关联', async () => {
    const w = await linkWorld();
    const v = await hourlyView(w);
    expect((await postLink(w, linkBody(v))).status).toBe(200);
    await t.db
      .update(notifications)
      .set({ raisedAt: new Date(T0.getTime() + MIN) })
      .where(eq(notifications.id, HOURLY_ID));
    const { view } = await rebuiltView(w);
    expect(view.incident).not.toBe(v.incident);
    expect(view.last).toBeUndefined();
    expect(view.linked).toBeUndefined();
    expect(view.linkAction?.actionId).toBeDefined();
    expect(view.linkAction?.actionId).not.toBe(v.linkAction?.actionId);
  });
});

describe('明确关联已有单：交给修复沿用绑定（#3090 形状）', () => {
  const task = task3090;
  const pr = pr3090;
  it.each([
    ['已有进行中的任务', { findTaskByIssue: async () => task }, 'worker-active', 0],
    ['已有开放修复 PR', { listPullRequests: async () => [pr] }, 'pr-open', 0],
    ['任务已结束不算有效工人', { findTaskByIssue: async () => ({ ...task, state: 'done' }) }, 'linked', 1],
    ['没有任何工人', {}, 'linked', 1],
  ] as const)('%s：不开单；只在没有有效工人时经现有准入派一次', async (_name, stub, stage, dispatches) => {
    const w = await linkWorld();
    Object.assign(w.h.deps.store, stub);
    const v = await hourlyView(w);
    const linked = await postLink(w, linkBody(v));
    expect(linked.json.linked).toMatchObject({ stage });
    // 已关联待处理：只绑定，什么都没派
    expect(w.f.dispatched).toEqual([]);
    expect(w.f.opened).toEqual([]);

    // 明确请求一次受控派工
    const clicked = await clickHand(w);
    expect(w.f.opened).toEqual([]);
    expect(w.f.dispatched).toHaveLength(dispatches);
    if (dispatches === 0) {
      // 已有人在处理：什么都没做，明确 409，绑定原样留着（不记成 handed / accepted）
      expect([clicked.status, clicked.json.error.code]).toEqual([409, 'link_already_handled']);
      expect((await hourlyRow(w.h))?.value).toMatchObject({
        state: 'linked',
        kind: 'link-existing',
        link: { stage, requestId: linked.json.linked.requestId, by: IDS.founderA },
      });
      const { view } = await rebuiltView(w);
      expect(view.last).toBeUndefined();
      expect(view.linked).toMatchObject({ stage, actionId: linked.json.linked.actionId });
    } else {
      expect(clicked.status).toBe(200);
      expect(clicked.json.repair).toMatchObject({
        kind: 'hand-to-repair',
        state: 'handed',
        issue: { number: EXISTING, created: false },
      });
      expect(clicked.json.repair).not.toHaveProperty('link');
      // 只经现有准入：三个参数（仓、单号、操作者），不传 force
      expect(w.f.dispatched[0]).toMatchObject({ number: EXISTING, argc: 3 });
      expect(w.f.dispatched[0]?.operator).toContain(IDS.founderA);
      // 重建 deps：last 是旧契约里的 handed 交给修复，linked 仍是原来那次关联
      const { view } = await rebuiltView(w);
      expect(view.last).toMatchObject({
        kind: 'hand-to-repair',
        state: 'handed',
        issue: { number: EXISTING },
      });
      expect(view.linked).toMatchObject({
        stage: 'linked',
        actionId: linked.json.linked.actionId,
        requestId: linked.json.linked.requestId,
        by: IDS.founderA,
      });
    }
    // 再点：仍不开单，派工总数不增加
    await clickHand(w);
    expect(w.f.opened).toEqual([]);
    expect(w.f.dispatched).toHaveLength(dispatches);
  });

  it('绑定失效（关闭 / 变成 PR / 换仓）：交给修复标 failed 并保留绑定，不开新单也不派工；恢复后才派', async () => {
    const w = await linkWorld();
    const v = await hourlyView(w);
    expect((await postLink(w, linkBody(v))).status).toBe(200);
    for (const bad of [{ state: 'closed', stateReason: 'completed' } as IssueRead, ghError('NOT_AN_ISSUE')]) {
      w.f.read = () => bad;
      const failed = await clickHand(w);
      expect(failed.json.repair).toMatchObject({
        kind: 'hand-to-repair',
        state: 'failed',
        issue: { number: EXISTING, created: false },
      });
      expect(failed.json.repair.text).toContain('已失效');
      // 绑定标失效（仍是原来那次关联），last 只是旧契约里的 failed
      const view = await hourlyView(w);
      expect(view.linked).toMatchObject({
        reason: 'operator-explicit',
        invalid: { text: expect.any(String) },
      });
    }
    // 换仓：受管的 fleet-dao 不在原 owner 下了，原绑定对不上
    await t.db.update(repos).set({ owner: 'moved-org' }).where(eq(repos.id, SELF.id));
    w.f.read = () => OPEN_ISSUE;
    const moved = await clickHand(w);
    expect(moved.json.repair).toMatchObject({ state: 'failed', issue: { number: EXISTING } });
    expect(moved.json.repair.text).toContain('已失效');
    expect(w.f.opened).toEqual([]);
    expect(w.f.dispatched).toEqual([]);
    await t.db.update(repos).set({ owner: SELF.owner }).where(eq(repos.id, SELF.id));
    const recovered = await clickHand(w);
    expect(recovered.json.repair).toMatchObject({ state: 'handed', issue: { number: EXISTING } });
    expect(w.f.opened).toEqual([]);
    expect(w.f.dispatched).toHaveLength(1);
    const { view } = await rebuiltView(w);
    expect(view.linked?.invalid).toBeUndefined();
    expect(view.linked?.stage).toBe('linked');
  });
});

describe('明确关联已有单：开放 PR 按目标精确读（真库分页）', () => {
  /** 别的仓 200 条更新的开放 PR + 目标单的那条 PR 排第 201：全局读前 200 条会把它截掉。 */
  async function crowd(target: { number: number; refs: number[] }[] = [{ number: 3095, refs: [EXISTING] }]) {
    await t.db.insert(pullRequests).values([
      ...Array.from({ length: 200 }, (_, i) => ({
        repoId: IDS.repo,
        number: 5000 + i,
        state: 'open' as const,
        headRef: `fleet/other-${i}`,
        headSha: `other${i}`,
        updatedAt: new Date(T0.getTime() - i * 1000),
        issueRefs: [EXISTING],
      })),
      ...target.map((p, i) => ({
        repoId: SELF.id,
        number: p.number,
        state: 'open' as const,
        headRef: `fleet/3090-${i}`,
        headSha: `t${i}`,
        updatedAt: ago(600 + i),
        issueRefs: p.refs,
      })),
    ]);
  }

  it('关联：第 201 条的目标 PR 照样认出来，记 pr-open；交给修复不派工', async () => {
    const w = await linkWorld();
    await crowd();
    // 证明这是评审说的场景：全局前 200 条里没有目标 PR（别的仓同号单的 PR 也不能当成它）
    const global = await w.h.deps.store.listPullRequests({ state: 'open', limit: 200 });
    expect(global).toHaveLength(200);
    expect(global.some((p) => p.repoId === SELF.id)).toBe(false);

    const v = await hourlyView(w);
    const linked = await postLink(w, linkBody(v));
    expect(linked.json.linked).toMatchObject({ stage: 'pr-open', prNumber: 3095 });
    const clicked = await clickHand(w);
    expect([clicked.status, clicked.json.error.code]).toEqual([409, 'link_already_handled']);
    expect(w.f.dispatched).toEqual([]);
    expect(w.f.opened).toEqual([]);
  });

  it('交给修复：关联之后才出现的第 201 条目标 PR 也认得，不派工；关联时没有 PR 的阶段会刷新成 pr-open', async () => {
    const w = await linkWorld();
    const v = await hourlyView(w);
    expect((await postLink(w, linkBody(v))).json.linked).toMatchObject({ stage: 'linked' });
    await crowd();
    const clicked = await clickHand(w);
    expect([clicked.status, clicked.json.error.code]).toEqual([409, 'link_already_handled']);
    expect(w.f.dispatched).toEqual([]);
    const { view } = await rebuiltView(w);
    expect(view.last).toBeUndefined();
    expect(view.linked).toMatchObject({ stage: 'pr-open', prNumber: 3095 });
  });

  it('目标单的开放 PR 满一页（没读全）：关联 502 拒绝；交给修复标 failed 不派工，绑定不判失效', async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ number: 6000 + i, refs: [EXISTING] }));
    const w = await linkWorld();
    const v = await hourlyView(w);
    expect((await postLink(w, linkBody(v))).status).toBe(200);
    await crowd(many);
    const clicked = await clickHand(w);
    expect(clicked.status).toBe(200);
    expect(clicked.json.repair).toMatchObject({ kind: 'hand-to-repair', state: 'failed' });
    expect(clicked.json.repair.text).toContain('没读全');
    expect(w.f.dispatched).toEqual([]);
    expect(w.f.opened).toEqual([]);
    expect((await hourlyView(w)).linked?.invalid).toBeUndefined();
  });

  it('目标单的开放 PR 满一页时直接关联：502 link_facts_unreadable，不落库、不开单、不派工', async () => {
    const w = await linkWorld();
    await crowd(Array.from({ length: 50 }, (_, i) => ({ number: 6000 + i, refs: [EXISTING] })));
    const v = await hourlyView(w);
    const r = await postLink(w, linkBody(v));
    expect([r.status, r.json.error.code]).toEqual([502, 'link_facts_unreadable']);
    await expectUntouched(w);
  });
});

describe('明确关联已有单：并发 / 幂等', () => {
  it('同 requestId 重放回原记录且不再读单；同 requestId 换单 / 换版本 409；重启 deps 后同请求仍回同一份持久化关联', async () => {
    const w = await linkWorld();
    const v = await hourlyView(w);
    const body = linkBody(v);
    const first = await postLink(w, body);
    expect(first.json.replayed).toBe(false);
    const reads = w.f.reads.length;
    const again = await postLink(w, body);
    expect(again.json).toMatchObject({ replayed: true });
    expect(again.json.linked).toEqual(first.json.linked);
    expect(w.f.reads).toHaveLength(reads);
    // 关联的 requestId 拿去点修复：不当成同一次，也不回内部关联记录
    const hand = v.actions.find((a) => a.kind === 'hand-to-repair');
    const crossed = await post(w.h, w.s, HOURLY_ID, {
      actionId: hand?.id,
      incident: v.incident,
      requestId: body.requestId,
    });
    expect([crossed.status, crossed.json.error.code]).toEqual([409, 'request_reused']);

    for (const over of [{ issueNumber: 3091 }, { actionId: 'link-existing:other' }]) {
      const reused = await postLink(w, { ...body, ...over });
      expect([reused.status, reused.json.error.code]).toEqual([409, 'request_reused']);
    }
    // 换新 requestId 再绑：已经绑定，不改绑
    const rebind = await postLink(w, linkBody(v, { issueNumber: 3091 }));
    expect([rebind.status, rebind.json.error.code]).toEqual([409, 'already_linked']);

    // 重启：换一份全新的 Store 实例
    w.h.deps.store = createPgStore(t.db, { now: () => new Date(w.h.clock.now) });
    const restarted = await postLink(w, body);
    expect(restarted.json).toMatchObject({ replayed: true });
    expect(restarted.json.linked).toEqual(first.json.linked);
    expect(w.f.reads).toHaveLength(reads);
    expect(w.f.opened).toEqual([]);
    expect(w.f.dispatched).toEqual([]);
  });

  it('开单和关联抢同一事故：同一设置版本 CAS 只一边成功，输的明确 409，最多一次开单 / 派工', async () => {
    const w = await linkWorld();
    const v = await hourlyView(w);
    const hand = v.actions.find((a) => a.kind === 'hand-to-repair');
    // 两边都读到版本 0 之后才允许任何一边写
    const real = w.h.deps.store.putSetting.bind(w.h.deps.store);
    let arrived = 0;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    w.h.deps.store.putSetting = async (...args) => {
      if (arrived < 2) {
        arrived += 1;
        if (arrived === 2) open();
        await gate;
      }
      return real(...args);
    };
    const [made, linked] = await Promise.all([
      post(w.h, w.s, HOURLY_ID, { actionId: hand?.id, incident: v.incident, requestId: uuid() }),
      postLink(w, linkBody(v)),
    ]);
    expect([made.status, linked.status].sort()).toEqual([200, 409]);
    const loser = made.status === 409 ? made : linked;
    expect(loser.json.error.code).toBe('repair_conflict');
    if (linked.status === 200) {
      expect(w.f.opened).toHaveLength(0);
      expect(w.f.dispatched).toHaveLength(0);
      expect((await hourlyRow(w.h))?.value).toMatchObject({ state: 'linked' });
    } else {
      expect(w.f.opened).toHaveLength(1);
      expect(w.f.dispatched).toHaveLength(1);
      expect((await hourlyRow(w.h))?.value).toMatchObject({ state: 'handed', issue: { number: 4000 } });
    }
  });

  it('unknown → 关联 → 开单：不覆盖旧锁，不重发未知副作用', async () => {
    const w = await linkWorld();
    w.port.dispatchIssue = async () => {
      throw new Error('回执丢了');
    };
    const v = await hourlyView(w);
    expect((await clickHand(w)).json.repair).toMatchObject({ state: 'unknown', issue: { number: 4000 } });
    const before = await hourlyRow(w.h);
    expect(w.f.opened).toHaveLength(1);
    expect((await hourlyView(w)).linkAction).toBeUndefined();

    const linked = await postLink(w, linkBody(v));
    expect([linked.status, linked.json.error.code]).toEqual([409, 'repair_in_flight']);
    const again = await clickHand(w);
    expect([again.status, again.json.error.code]).toEqual([409, 'repair_in_flight']);
    expect(w.f.opened).toHaveLength(1);
    expect(w.f.reads).toEqual([]);
    expect(await hourlyRow(w.h)).toEqual(before);
  });
});

describe('明确关联已有单：失效边界与无关联路径', () => {
  it('事故重开：旧事故的关联不覆盖新代次，旧 incident / 旧 requestId 都被拒，同一单要重新显式关联', async () => {
    const w = await linkWorld();
    const v = await hourlyView(w);
    const body = linkBody(v);
    expect((await postLink(w, body)).status).toBe(200);
    await t.db
      .update(notifications)
      .set({ raisedAt: new Date(T0.getTime() + MIN) })
      .where(eq(notifications.id, HOURLY_ID));

    const next = await hourlyView(w);
    expect(next.incident).not.toBe(v.incident);
    expect(next.last).toBeUndefined();
    expect(next.linked).toBeUndefined();
    expect(next.linkAction?.actionId).not.toBe(v.linkAction?.actionId);
    const stale = await postLink(w, body);
    expect([stale.status, stale.json.error.code]).toEqual([409, 'incident_mismatch']);
    const reused = await postLink(w, linkBody(next, { requestId: body.requestId }));
    expect([reused.status, reused.json.error.code]).toEqual([409, 'request_reused']);
    expect((await hourlyRow(w.h))?.value).toMatchObject({ incident: v.incident, state: 'linked' });

    const fresh = await postLink(w, linkBody(next));
    expect(fresh.status).toBe(200);
    expect(fresh.json.linked.incident).toBe(next.incident);
    expect((await hourlyRow(w.h))?.value).toMatchObject({ incident: next.incident, state: 'linked' });
  });

  it('动作版本过期：同事故修复状态变了（开单失败），旧版本不能再关联；新版本可以', async () => {
    const w = await linkWorld();
    w.port.openIssue = async () => {
      throw new Error('GitHub 502');
    };
    const v = await hourlyView(w);
    expect((await clickHand(w)).json.repair).toMatchObject({ state: 'failed' });
    const stale = await postLink(w, linkBody(v));
    expect([stale.status, stale.json.error.code]).toEqual([409, 'action_expired']);
    expect(w.f.reads).toEqual([]);
    const now = await hourlyView(w);
    expect(now.linkAction?.actionId).not.toBe(v.linkAction?.actionId);
    expect((await postLink(w, linkBody(now))).status).toBe(200);
    expect(w.f.dispatched).toEqual([]);
  });

  it('没有显式绑定：标题正文相似不自动复用旧单（不读单、照常按 incident 开一张）；同 incident 再点不开第二张', async () => {
    const w = await linkWorld();
    const first = await clickHand(w);
    expect(first.json.repair).toMatchObject({ state: 'handed', issue: { number: 4000, created: true } });
    expect(first.json.repair).not.toHaveProperty('link');
    const v = await hourlyView(w);
    expect(v.linked).toBeUndefined();
    expect(w.f.opened.map((o) => o.key)).toEqual([`alert-repair:${v.incident}`]);
    expect(w.f.reads).toEqual([]);
    expect(w.f.dispatched.map((d) => d.number)).toEqual([4000]);
    await clickHand(w);
    expect(w.f.opened).toHaveLength(1);
    expect(w.f.dispatched).toHaveLength(1);
  });

  it('无关联路径：派工结果未知保留原单，不盲重开也不盲重派', async () => {
    const w = await linkWorld();
    w.port.dispatchIssue = async () => {
      w.f.dispatched.push({ number: 4000, argc: 3, operator: '' });
      throw new Error('回执丢了');
    };
    expect((await clickHand(w)).json.repair).toMatchObject({ state: 'unknown', issue: { number: 4000 } });
    const blocked = await clickHand(w);
    expect([blocked.status, blocked.json.error.code]).toEqual([409, 'repair_in_flight']);
    expect(w.f.opened).toHaveLength(1);
    expect(w.f.dispatched).toHaveLength(1);
  });
});
