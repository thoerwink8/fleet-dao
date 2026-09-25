// 实时通知：触发器装在哪些表、报什么，都照 @fleet-dao/shared 的 REALTIME_TABLES 核对。
import { FLEET_CHANGES_CHANNEL, REALTIME_TABLES } from '@fleet-dao/shared';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { savePoolQuota } from '../src/queries/quota.ts';
import {
  asks,
  auditLog,
  channels,
  notifications,
  pools,
  progressEvents,
  quotaWindows,
  sessionRuns,
  settings,
  stagePolicies,
  stagePolicyRoutes,
  tasks,
} from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addRoute, addRun, addSubtask, addTask, catalog, NOW } from './helpers.ts';

let t: TestDb;
/** 收到的原始载荷，原样 JSON.parse：键多了少了都要看得出来。 */
let heard: unknown[];
let unlisten: () => Promise<void>;

beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
  heard = [];
  unlisten = await t.client.listen(FLEET_CHANGES_CHANNEL, (payload) => heard.push(JSON.parse(payload)));
});
afterEach(() => unlisten());

/** 通知在提交后才送达，PGlite 在下一个任务里回调。 */
const settle = () => new Promise((r) => setTimeout(r, 20));
const tables = () => heard.map((h) => (h as { table: string }).table);

/** 先把准备数据引起的通知收完、清空，再做要测的那一下。 */
async function freshEars() {
  await settle();
  heard = [];
}

describe('写入即通知 fleet_changes', () => {
  it('需求的增、改、删各发一条，载荷只有表名和 id', async () => {
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id);
    await t.db.update(tasks).set({ state: 'running' }).where(eq(tasks.id, task.id));
    await t.db.delete(tasks).where(eq(tasks.id, task.id));
    await settle();
    expect(heard).toEqual([
      { table: 'tasks', id: task.id },
      { table: 'tasks', id: task.id },
      { table: 'tasks', id: task.id },
    ]);
  });

  it('额度窗按池通知：id 是 pool_id', async () => {
    await catalog(t.db);
    await freshEars();
    await t.db.insert(quotaWindows).values({
      poolId: 'relay-a',
      label: '7d_fable',
      window: '7d_model',
      scope: 'fable',
      unit: 'points',
      source: 'mirasim-relay',
      reading: 'measured',
      readAt: NOW,
    });
    await settle();
    expect(heard).toEqual([{ table: 'quota_windows', id: 'relay-a' }]);
  });

  it('池本身改了也按池报成 quota_windows：读成了但上游一个窗口都没报，额度页也能刷新', async () => {
    await catalog(t.db);
    await freshEars();
    await savePoolQuota(
      t.db,
      { poolId: 'relay-a', readAt: NOW.toISOString(), complete: true, windows: [] },
      { now: NOW },
    );
    await t.db.update(pools).set({ maxConcurrency: 3 }).where(eq(pools.id, 'relay-b'));
    await settle();
    expect(heard).toEqual([
      { table: 'quota_windows', id: 'relay-a' },
      { table: 'quota_windows', id: 'relay-b' },
    ]);
  });

  it('会话排进队、开跑、结束都发（看板和额度页要刷新）；不属于任何需求的会话也发', async () => {
    await catalog(t.db);
    await addRoute(t.db, { id: 'r1', poolId: 'relay-a', modelId: 'opus-5.5' });
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id);
    await freshEars();
    const run = await addRun(t.db, { taskId: task.id, routeId: 'r1' });
    await t.db.update(sessionRuns).set({ startedAt: NOW }).where(eq(sessionRuns.id, run.id));
    const exam = await addRun(t.db, { taskId: null, stage: 'judge', routeId: 'r1', whyRoute: '考新模型' });
    await settle();
    expect(heard).toEqual([
      { table: 'session_runs', id: run.id },
      { table: 'session_runs', id: run.id },
      { table: 'session_runs', id: exam.id },
    ]);
  });

  it('改路由顺序报成 stage_policies，id 是阶段名', async () => {
    await catalog(t.db);
    await addRoute(t.db, { id: 'r1', poolId: 'relay-a', modelId: 'opus-5.5' });
    await freshEars();
    await t.db
      .insert(stagePolicyRoutes)
      .values({ stage: 'execute', routeId: 'r1', position: 0, enabled: true });
    await t.db.update(stagePolicies).set({ pinned: true }).where(eq(stagePolicies.stage, 'execute'));
    await settle();
    expect(heard).toEqual([
      { table: 'stage_policies', id: 'execute' },
      { table: 'stage_policies', id: 'execute' },
    ]);
  });

  it('渠道开关、改设置、记操作都发', async () => {
    await catalog(t.db);
    await freshEars();
    await t.db.update(channels).set({ enabled: false }).where(eq(channels.id, 'relay'));
    await t.db.insert(settings).values({ key: 'theme', value: 'dusk' });
    const [entry] = await t.db
      .insert(auditLog)
      .values({
        actorKind: 'ai',
        actorId: 'marshal-1',
        action: 'channel.disable',
        target: 'channel:relay',
        via: 'engine',
      })
      .returning();
    await settle();
    expect(heard).toEqual([
      { table: 'channels', id: 'relay' },
      { table: 'settings', id: 'theme' },
      { table: 'audit_log', id: String(entry?.id) },
    ]);
  });

  it('追问答上了发一条，id 就是追问的 id（等回答的 fleet ask 靠它醒）', async () => {
    await catalog(t.db);
    await addRoute(t.db, { id: 'r1', poolId: 'relay-a', modelId: 'opus-5.5' });
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id);
    const run = await addRun(t.db, { taskId: task.id, routeId: 'r1' });
    const [ask] = await t.db
      .insert(asks)
      .values({ taskId: task.id, runId: run.id, question: '?' })
      .returning();
    if (!ask) throw new Error('追问没写进去');
    await freshEars();
    await t.db
      .update(asks)
      .set({ answer: '要', answeredBy: 'user-1', answeredAt: NOW })
      .where(eq(asks.id, ask.id));
    await settle();
    expect(heard).toEqual([{ table: 'asks', id: ask.id }]);
  });

  it('名单外的表写入不发', async () => {
    expect(REALTIME_TABLES).not.toContain('repos');
    await addRepo(t.db);
    await settle();
    expect(heard).toEqual([]);
  });

  it('装了通知触发器的表，报出来的表名恰好就是约定的名单', async () => {
    const rows = await t.client.query<{ table: string; def: string }>(
      `select c.relname as table, pg_get_triggerdef(tr.oid) as def
         from pg_trigger tr join pg_class c on c.oid = tr.tgrelid
        where not tr.tgisinternal and pg_get_triggerdef(tr.oid) like '%fleet_notify_change%'`,
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    const reported = rows.rows.map((r) => {
      const args = /fleet_notify_change\(([^)]*)\)/.exec(r.def)?.[1] ?? '';
      const [, reportedTable] = args.split(',').map((a) => a.trim().replace(/^'|'$/g, ''));
      return reportedTable ?? r.table;
    });
    expect([...new Set(reported)].sort()).toEqual([...REALTIME_TABLES].sort());
  });

  it('名单上的每张表都真的发出了通知', async () => {
    await catalog(t.db);
    await addRoute(t.db, { id: 'r1', poolId: 'relay-a', modelId: 'opus-5.5' });
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id);
    const sub = await addSubtask(t.db, task.id);
    const run = await addRun(t.db, { taskId: task.id, subtaskId: sub.id, routeId: 'r1' });
    await t.db.insert(progressEvents).values({ runId: run.id, kind: 'done', payload: null });
    await t.db.insert(quotaWindows).values({
      poolId: 'relay-a',
      label: '5h',
      window: '5h',
      unit: 'percent',
      source: 'claude-usage',
      reading: 'measured',
      readAt: NOW,
    });
    await t.db.insert(notifications).values({ level: 'daily', dedupeKey: 'daily:2026-09-25', title: '日报' });
    await t.db.insert(asks).values({ taskId: task.id, runId: run.id, question: '要不要兼容旧接口？' });
    await t.db
      .insert(stagePolicyRoutes)
      .values({ stage: 'execute', routeId: 'r1', position: 0, enabled: true });
    await t.db.insert(settings).values({ key: 'theme', value: 'dusk' });
    await t.db
      .insert(auditLog)
      .values({ actorKind: 'engine', actorId: 'w1', action: 'x', target: 'task:x', via: 'engine' });
    await settle();
    expect([...new Set(tables())].sort()).toEqual([...REALTIME_TABLES].sort());
  });
});
