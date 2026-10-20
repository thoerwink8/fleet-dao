// 实时通知：触发器装在哪些表、报什么，都照 @fleet-dao/shared 的 REALTIME_TABLES 核对。
import { FLEET_CHANGES_CHANNEL, REALTIME_TABLES } from '@fleet-dao/shared';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { savePoolQuota } from '../src/queries/quota.ts';
import {
  approvals,
  asks,
  auditLog,
  channels,
  nodeReports,
  notifications,
  pools,
  quotaWindows,
  requests,
  runs,
  settings,
  tasks,
  users,
} from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addRoute, addRun, addSubtask, addTask, catalog, later, MIN, NOW } from './helpers.ts';

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
  unlisten = await t.client.listen(FLEET_CHANGES_CHANNEL, (payload) => {
    const msg = JSON.parse(payload) as { settle?: number };
    if (msg.settle === undefined) heard.push(msg);
    else marks.get(msg.settle)?.();
  });
});
afterEach(() => unlisten());

/** 等着的哨兵号 → 收到它时放行。 */
const marks = new Map<number, () => void>();
let lastMark = 0;
/**
 * 通知在提交后才送达：PGlite 在下一个任务里回调，真 Postgres 走单独的 LISTEN 连接，机器忙时晚多少说不准。
 * 所以不按固定时长等，发一条哨兵通知、等它回来：通知按提交顺序排队，哨兵到了，之前已提交的写入引起的通知都到了。
 */
async function settle() {
  const mark = ++lastMark;
  const back = new Promise<void>((resolve) => marks.set(mark, resolve));
  await t.client.query('select pg_notify($1, $2)', [FLEET_CHANGES_CHANNEL, JSON.stringify({ settle: mark })]);
  await back;
  marks.delete(mark);
}
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

  it('三段流水开一段、收场都发（主页的流水线图靠它刷新）；不属于任何需求的一段也发', async () => {
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id);
    await freshEars();
    const [scope] = await t.db
      .insert(runs)
      .values({ segment: 'scope', taskId: task.id, model: 'opus-5.5', startedAt: NOW })
      .returning();
    if (!scope) throw new Error('流水没写进去');
    await t.db.update(runs).set({ endedAt: NOW, outcome: 'done' }).where(eq(runs.id, scope.id));
    const [patrol] = await t.db
      .insert(runs)
      .values({ segment: 'manual', taskId: null, model: 'opus-5.5', startedAt: NOW })
      .returning();
    await settle();
    expect(heard).toEqual([
      { table: 'runs', id: scope.id },
      { table: 'runs', id: scope.id },
      { table: 'runs', id: patrol?.id },
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

  it('别的环境推来快照：头一回写、覆盖写各发一条，id 是 node_id（看板的环境切换器靠它刷新）', async () => {
    await freshEars();
    const row = {
      nodeId: 'local',
      displayName: '本机',
      schemaVersion: 1,
      reportedAt: NOW,
      receivedAt: NOW,
      payload: {},
    };
    await t.db.insert(nodeReports).values(row);
    await t.db
      .insert(nodeReports)
      .values({ ...row, codeSha: 'abc1234' })
      .onConflictDoUpdate({ target: nodeReports.nodeId, set: { codeSha: 'abc1234' } });
    await settle();
    expect(heard).toEqual([
      { table: 'node_reports', id: 'local' },
      { table: 'node_reports', id: 'local' },
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
    const run = await addRun(t.db, { taskId: task.id, routeId: 'r1' });
    await t.db.insert(runs).values({ segment: 'manual', taskId: task.id, model: 'opus-5.5', startedAt: NOW });
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
    await t.db.insert(approvals).values({
      taskId: task.id,
      subtaskId: sub.id,
      holds: ['release'],
      prNumber: 1,
      head: 'deadbeef',
      title: '标题',
      summary: '摘要',
    });
    await t.db.insert(settings).values({ key: 'theme', value: 'dusk' });
    await t.db.insert(nodeReports).values({
      nodeId: 'local',
      displayName: '本机',
      schemaVersion: 1,
      reportedAt: NOW,
      receivedAt: NOW,
      payload: {},
    });
    await t.db
      .insert(auditLog)
      .values({ actorKind: 'engine', actorId: 'w1', action: 'x', target: 'task:x', via: 'engine' });
    await addRequest(repo.id);
    await settle();
    expect([...new Set(tables())].sort()).toEqual([...REALTIME_TABLES].sort());
  });

  /** 提需求（#2060）：建一条需求，回它的需求号。 */
  async function addRequest(repoId: string) {
    const [u] = await t.db.insert(users).values({ displayName: '创始人', role: 'founder' }).returning();
    if (!u) throw new Error('没建成用户');
    const [r] = await t.db
      .insert(requests)
      .values({ repoId, initiatorId: u.id, draftJson: { title: '一条需求' }, lastActivityAt: NOW })
      .returning();
    if (!r) throw new Error('没建成需求');
    return r;
  }

  it('需求的增、改各发一条，id 是需求号（页面按号重读；进度卡、引擎提问追加时同事务改了 last_activity_at）', async () => {
    const repo = await addRepo(t.db);
    const r = await addRequest(repo.id);
    await settle();
    expect(heard.filter((h) => (h as { table: string }).table === 'requests')).toEqual([
      { table: 'requests', id: String(r.seq) },
    ]);
    heard = [];
    await t.db
      .update(requests)
      .set({ lastActivityAt: later(MIN) })
      .where(eq(requests.id, r.id));
    await settle();
    expect(heard).toEqual([{ table: 'requests', id: String(r.seq) }]);
  });
});
