// 拉单挑单读的历史（queries/intake-history.ts，#1336）：失败几次、一小时内起了几条、最近结束的几条、熔断状态。
// 读不出的形状照抛，不当成「正常」。
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  firstTaskCreatedSince,
  INTAKE_BREAKER_SETTING,
  INTAKE_STARTS_SETTING,
  INTAKE_WAITING_SETTING,
  intakeBreakerSetting,
  intakeWorkloadSince,
  readIntakeBreaker,
  readIntakeWaiting,
  recentEndedTasks,
  recordIntakeStart,
  TASK_ADOPT_AUDIT_ACTION,
  taskAdoptsSince,
  taskFailureCount,
  tasksCreatedSince,
  writeIntakeBreaker,
  writeIntakeWaiting,
} from '../src/queries/intake-history.ts';
import { auditLog, runs, settings, stateChanges } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addTask, ago, HOUR, MIN, NOW } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

/** 补一条状态变化记录（触发器记的是真实时钟，测试要定死时刻）。 */
async function change(
  taskId: string,
  toState: 'done' | 'failed',
  at: Date,
  entity: 'task' | 'subtask' = 'task',
) {
  await t.db
    .insert(stateChanges)
    .values({ entity, entityId: taskId, taskId, fromState: 'running', toState, at });
}

describe('这张单失败过几次', () => {
  it('只数这张单任务行的 task 级 failed；别的单、子任务的失败、没有任务行都不算', async () => {
    const repo = await addRepo(t.db, 'aaa');
    const other = await addRepo(t.db, 'bbb');
    const mine = await addTask(t.db, repo.id, { issueNumber: 7 });
    const same = await addTask(t.db, other.id, { issueNumber: 7 });
    await change(mine.id, 'failed', ago(3 * HOUR));
    await change(mine.id, 'failed', ago(HOUR));
    await change(mine.id, 'done', ago(MIN));
    await change(mine.id, 'failed', ago(MIN), 'subtask');
    await change(same.id, 'failed', ago(HOUR));
    expect(await taskFailureCount(t.db, repo.id, 7)).toBe(2);
    expect(await taskFailureCount(t.db, other.id, 7)).toBe(1);
    expect(await taskFailureCount(t.db, repo.id, 8)).toBe(0);
  });
});

describe('一小时内起了几条', () => {
  it('按任务行的建出时刻数，不早于 since 的才算', async () => {
    const repo = await addRepo(t.db, 'aaa');
    await addTask(t.db, repo.id, { createdAt: ago(61 * MIN) });
    await addTask(t.db, repo.id, { createdAt: ago(59 * MIN) });
    await addTask(t.db, repo.id, { createdAt: ago(MIN) });
    expect(await tasksCreatedSince(t.db, ago(HOUR))).toBe(2);
  });
});

describe('一小时内接手了几条老行', () => {
  async function adopt(taskId: string, at: Date, over: Partial<typeof auditLog.$inferInsert> = {}) {
    await t.db.insert(auditLog).values({
      at,
      actorKind: 'engine',
      actorId: 'engine:intake',
      action: TASK_ADOPT_AUDIT_ACTION,
      target: `task:${taskId}`,
      via: 'github',
      ok: true,
      reason: '接手无工作流的老任务行',
      ...over,
    });
  }

  it('窗口内接手成功、且建出时刻早于 since 的才算；窗口外、没做成、本小时新建的不算', async () => {
    const repo = await addRepo(t.db, 'aaa');
    const old = await addTask(t.db, repo.id, { createdAt: ago(2 * HOUR) });
    const outside = await addTask(t.db, repo.id, { createdAt: ago(3 * HOUR) });
    const failed = await addTask(t.db, repo.id, { createdAt: ago(2 * HOUR) });
    const fresh = await addTask(t.db, repo.id, { createdAt: ago(MIN) });
    await adopt(old.id, ago(MIN));
    await adopt(outside.id, ago(2 * HOUR));
    await adopt(failed.id, ago(MIN), { ok: false, error: '没写上' });
    await adopt(fresh.id, ago(MIN));
    expect(await taskAdoptsSince(t.db, ago(HOUR))).toBe(1);
  });
});

describe('最近结束的任务', () => {
  it('只要 done / failed，新的在前；叫停和子任务不算；after 之后的才要；limit 生效', async () => {
    const repo = await addRepo(t.db, 'aaa');
    const a = await addTask(t.db, repo.id);
    const b = await addTask(t.db, repo.id);
    await change(a.id, 'failed', ago(5 * HOUR));
    await change(b.id, 'done', ago(4 * HOUR));
    await change(a.id, 'failed', ago(3 * HOUR));
    await change(b.id, 'failed', ago(HOUR), 'subtask');
    // 叫停：触发器写的 stopped 不在 done/failed 里
    await t.db.insert(stateChanges).values({
      entity: 'task',
      entityId: b.id,
      taskId: b.id,
      fromState: 'running',
      toState: 'stopped',
      at: ago(2 * HOUR),
    });
    const all = await recentEndedTasks(t.db, { limit: 6 });
    expect(all.map((r) => r.state)).toEqual(['failed', 'done', 'failed']);
    expect(all[0]?.endedAt.toISOString()).toBe(ago(3 * HOUR).toISOString());
    const after = await recentEndedTasks(t.db, { limit: 6, after: ago(4 * HOUR + MIN) });
    expect(after.map((r) => r.state)).toEqual(['failed', 'done']);
    expect(await recentEndedTasks(t.db, { limit: 1 })).toHaveLength(1);
  });
});

describe('熔断试探的那一条', () => {
  it('从 since 起建出来的第一条；没有是 null', async () => {
    const repo = await addRepo(t.db, 'aaa');
    await addTask(t.db, repo.id, { createdAt: ago(3 * HOUR), state: 'running' });
    const first = await addTask(t.db, repo.id, { createdAt: ago(30 * MIN), state: 'running' });
    await addTask(t.db, repo.id, { createdAt: ago(10 * MIN) });
    expect(await firstTaskCreatedSince(t.db, ago(HOUR))).toMatchObject({ id: first.id, state: 'running' });
    expect(await firstTaskCreatedSince(t.db, NOW)).toBeNull();
  });
});

describe('熔断状态（设置表）', () => {
  it('没写过是 null；写了读回；再写版本加 1、值换掉', async () => {
    expect(await readIntakeBreaker(t.db)).toBeNull();
    await writeIntakeBreaker(t.db, { state: 'open', at: ago(HOUR), by: 'engine:intake' });
    expect(await readIntakeBreaker(t.db)).toEqual({ state: 'open', at: ago(HOUR) });
    await writeIntakeBreaker(t.db, { state: 'closed', at: NOW, by: 'engine:intake' });
    expect(await readIntakeBreaker(t.db)).toEqual({ state: 'closed', at: NOW });
    const [row] = await t.db.select().from(settings);
    expect(row?.version).toBe(2);
  });

  it('【故意造出的失败】这一行的形状认不出：抛错，不当成正常', async () => {
    await t.db.insert(settings).values({ key: INTAKE_BREAKER_SETTING, value: { state: 'half', at: 'x' } });
    await expect(readIntakeBreaker(t.db)).rejects.toThrow(/认不出/);
  });

  it('状态键带仓号：A 仓写开不影响 B 仓；旧的无仓键仍可读', async () => {
    const a = await addRepo(t.db, 'aaa');
    const b = await addRepo(t.db, 'bbb');
    await writeIntakeBreaker(t.db, { state: 'open', at: ago(HOUR), by: 'engine:intake' }, a.id);
    expect(await readIntakeBreaker(t.db, a.id)).toMatchObject({ state: 'open' });
    expect(await readIntakeBreaker(t.db, b.id)).toBeNull();
    expect(intakeBreakerSetting(a.id)).toBe(`${INTAKE_BREAKER_SETTING}:${a.id}`);
  });
});

describe('近 24 小时各仓已起单的加权工作量', () => {
  async function manual(taskId: string, tier: 'fast' | 'medium' | 'heavyweight', at: Date) {
    await t.db.insert(runs).values({ segment: 'manual', model: 'test-model', taskId, tier, startedAt: at });
  }

  it('按窗口内已起的任务算档，不靠设置回填：快档 1、中档 2、主力档 4；窗口外和本机领的不算', async () => {
    const a = await addRepo(t.db, 'aaa');
    const b = await addRepo(t.db, 'bbb');
    const heavy = await addTask(t.db, a.id, { createdAt: ago(MIN) });
    const fast = await addTask(t.db, a.id, { createdAt: ago(30 * MIN) });
    const medium = await addTask(t.db, b.id, { createdAt: ago(MIN) });
    const old = await addTask(t.db, a.id, { createdAt: ago(2 * HOUR) });
    const local = await addTask(t.db, b.id, { createdAt: ago(MIN), executor: 'local' });
    await manual(heavy.id, 'heavyweight', ago(MIN));
    await manual(fast.id, 'fast', ago(30 * MIN));
    await manual(medium.id, 'medium', ago(MIN));
    await manual(old.id, 'heavyweight', ago(2 * HOUR));
    await manual(local.id, 'heavyweight', ago(MIN));
    expect(await intakeWorkloadSince(t.db, ago(HOUR))).toEqual({ [a.id]: 5, [b.id]: 2 });
  });

  it('动手段还没写下档时用起单记录里的档；只有设置、没有任务行的不算一条', async () => {
    const a = await addRepo(t.db, 'aaa');
    const task = await addTask(t.db, a.id, { createdAt: ago(MIN) });
    expect(await intakeWorkloadSince(t.db, ago(HOUR))).toEqual({ [a.id]: 1 });
    await recordIntakeStart(t.db, {
      repoId: a.id,
      taskId: task.id,
      at: ago(MIN),
      tier: 'heavyweight',
      by: 'test',
    });
    expect(await intakeWorkloadSince(t.db, ago(HOUR))).toEqual({ [a.id]: 4 });
    await recordIntakeStart(t.db, {
      repoId: a.id,
      taskId: '00000000-0000-0000-0000-000000000099',
      at: ago(MIN),
      tier: 'medium',
      by: 'test',
    });
    expect(await intakeWorkloadSince(t.db, ago(HOUR))).toEqual({ [a.id]: 4 });
    const [row] = await t.db.select().from(settings).where(eq(settings.key, INTAKE_STARTS_SETTING));
    expect(row?.value).toEqual(expect.any(Array));
  });

  it('接手窗口内的老行按接手时刻算，档从动手段读', async () => {
    const a = await addRepo(t.db, 'aaa');
    const task = await addTask(t.db, a.id, { createdAt: ago(48 * HOUR) });
    await manual(task.id, 'medium', ago(MIN));
    await t.db.insert(auditLog).values({
      at: ago(MIN),
      actorKind: 'engine',
      actorId: 'engine:intake',
      action: TASK_ADOPT_AUDIT_ACTION,
      target: `task:${task.id}`,
      via: 'github',
      ok: true,
      reason: '接手无工作流的老任务行',
    });
    expect(await intakeWorkloadSince(t.db, ago(HOUR))).toEqual({ [a.id]: 2 });
  });
});

describe('每个仓等空位的单数（设置表 engine.intakeWaiting，决定 0093）', () => {
  it('没写过是 null；写了读回；再写整份换掉', async () => {
    expect(await readIntakeWaiting(t.db)).toBeNull();
    await writeIntakeWaiting(t.db, { at: ago(HOUR), byRepo: { a: 2, b: 0 }, by: 'engine:intake' });
    expect(await readIntakeWaiting(t.db)).toEqual({ at: ago(HOUR), byRepo: { a: 2, b: 0 } });
    await writeIntakeWaiting(t.db, { at: NOW, byRepo: { b: 1 }, by: 'engine:intake' });
    expect(await readIntakeWaiting(t.db)).toEqual({ at: NOW, byRepo: { b: 1 } });
  });

  it('【故意造出的失败】张数不是非负整数、时刻认不出：抛错，不当成「没有待做的单」', async () => {
    await t.db
      .insert(settings)
      .values({ key: INTAKE_WAITING_SETTING, value: { at: NOW.toISOString(), byRepo: { a: -1 } } });
    await expect(readIntakeWaiting(t.db)).rejects.toThrow(/认不出/);
    await t.db.delete(settings);
    await t.db.insert(settings).values({ key: INTAKE_WAITING_SETTING, value: { at: 'x', byRepo: {} } });
    await expect(readIntakeWaiting(t.db)).rejects.toThrow(/认不出/);
  });
});
