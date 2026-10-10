// 任务列表查询（queries/task-list.ts，#1639）：SQL 里的分组必须和 shared 的 taskListGroupOf 一字不差；
// 最近更新取开单、快照写入、状态变化三者最晚的；搜索里的 % _ 当普通字符。
// 数据库是 PGlite 上的真 Postgres（和生产同一批迁移）。
import { TASK_LIST_GROUPS, type TaskListGroup, type TaskState, taskListGroupOf } from '@fleet-dao/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toTask } from '../src/domain-map.ts';
import { countTaskGroups, listTaskRows } from '../src/queries/task-list.ts';
import { stateChanges } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addTask, ago, HOUR, MIN } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
let repoId: string;
beforeEach(async () => {
  await resetTestDb(t);
  repoId = (await addRepo(t.db)).id;
});

const STATES: TaskState[] = [
  'queued',
  'triaging',
  'asking',
  'planning',
  'running',
  'merging',
  'done',
  'stopped',
  'failed',
  'stalled',
];

describe('任务列表查询', () => {
  it('每一种状态、暂停与否，SQL 分到的组都和 shared 的 taskListGroupOf 一致', async () => {
    for (const state of STATES) {
      await addTask(t.db, repoId, { state });
      await addTask(t.db, repoId, { state, phase: 'paused', doing: '已暂停：测试' });
    }
    const { rows } = await listTaskRows(t.db, { limit: 100 });
    expect(rows).toHaveLength(STATES.length * 2);
    const expected = Object.fromEntries(TASK_LIST_GROUPS.map((g) => [g, 0])) as Record<TaskListGroup, number>;
    for (const { task } of rows) expected[taskListGroupOf(task)] += 1;
    expect(await countTaskGroups(t.db, {})).toEqual(expected);
    for (const group of TASK_LIST_GROUPS) {
      const got = await listTaskRows(t.db, { group, limit: 100 });
      expect(got.rows.map((r) => r.task.id).sort(), group).toEqual(
        rows
          .filter((r) => taskListGroupOf(r.task) === group)
          .map((r) => r.task.id)
          .sort(),
      );
    }
  });

  it('暂停的单读回来带那句话；已结束的单哪怕 phase 留着 paused 也按结束的状态分', async () => {
    const paused = await addTask(t.db, repoId, {
      state: 'running',
      phase: 'paused',
      doing: '已暂停：先等等',
    });
    const doneOne = await addTask(t.db, repoId, { state: 'done', phase: 'paused', doing: '旧的' });
    const { rows } = await listTaskRows(t.db, { limit: 10 });
    expect(rows.find((r) => r.task.id === paused.id)?.task.paused).toBe('已暂停：先等等');
    expect(taskListGroupOf(rows.find((r) => r.task.id === doneOne.id)?.task ?? toTask(doneOne))).toBe('done');
  });

  it('最近更新取开单、快照写入、状态变化里最晚的', async () => {
    const byChange = await addTask(t.db, repoId, { createdAt: ago(10 * HOUR) });
    const bySnapshot = await addTask(t.db, repoId, { createdAt: ago(10 * HOUR), updatedAt: ago(30 * MIN) });
    const byCreate = await addTask(t.db, repoId, { createdAt: ago(5 * MIN) });
    // 建单的触发器记的状态变化在「现在」：先把三张单各自的状态变化时刻摆好
    await t.db
      .update(stateChanges)
      .set({ at: ago(9 * HOUR) })
      .where(eq(stateChanges.entityId, bySnapshot.id));
    await t.db
      .update(stateChanges)
      .set({ at: ago(20 * MIN) })
      .where(eq(stateChanges.entityId, byChange.id));
    await t.db
      .update(stateChanges)
      .set({ at: ago(8 * HOUR) })
      .where(eq(stateChanges.entityId, byCreate.id));
    const { rows } = await listTaskRows(t.db, { limit: 10 });
    expect(rows.map((r) => r.task.id)).toEqual([byCreate.id, byChange.id, bySnapshot.id]);
    expect(rows.map((r) => r.updatedAt)).toEqual([
      ago(5 * MIN).toISOString(),
      ago(20 * MIN).toISOString(),
      ago(30 * MIN).toISOString(),
    ]);
  });

  it('搜索：% _ 当普通字符；数字（可带 #）按单号精确、也找标题里带这串数字的', async () => {
    await addTask(t.db, repoId, { issueNumber: 7, title: '登录页' });
    await addTask(t.db, repoId, { issueNumber: 8, title: '覆盖率 100% 达标' });
    await addTask(t.db, repoId, { issueNumber: 9, title: '覆盖率 1000 达标' });
    await addTask(t.db, repoId, { issueNumber: 10, title: 'snake_case 改名' });
    await addTask(t.db, repoId, { issueNumber: 11, title: 'snakeXcase 改名' });
    const found = async (q: string) =>
      (await listTaskRows(t.db, { q, limit: 10 })).rows.map((r) => r.task.issueNumber).sort((a, b) => a - b);
    expect(await found('100%')).toEqual([8]);
    expect(await found('snake_')).toEqual([10]);
    expect(await found('#7')).toEqual([7]);
    expect(await found('登录')).toEqual([7]);
    expect(await found('1000')).toEqual([9]);
  });
});
