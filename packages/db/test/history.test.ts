import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { searchSpecs } from '../src/queries/history.ts';
import { specs } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addSubtask, addTask, ago, DAY } from './helpers.ts';

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

async function spec(
  over: {
    title: string;
    summary: string;
    result?: string;
    mergedAt?: Date;
    touches?: string[];
    specDir?: string;
  },
  repo = repoId,
) {
  const task = await addTask(t.db, repo, {
    title: over.title,
    rawRequest: over.title,
    specDir: over.specDir ?? null,
  });
  await addSubtask(t.db, task.id, { touches: over.touches ?? [] });
  await t.db.insert(specs).values({
    taskId: task.id,
    summary: over.summary,
    resultSummary: over.result ?? null,
    mergedAt: over.mergedAt ?? null,
  });
  return task;
}

describe('fleet history：翻做过的需求', () => {
  it('按关键词找标题、摘要、结果；新合并的排前面；形状对齐 HistoryResponse', async () => {
    const older = await spec({
      title: '登录页加验证码',
      summary: '手机号登录要验证码',
      result: '加了 60 秒过期',
      mergedAt: ago(10 * DAY),
      specDir: 'specs/12-登录验证码',
    });
    const newer = await spec({ title: '验证码限流', summary: '同一手机号每分钟一次', mergedAt: ago(DAY) });
    await spec({ title: '看板配色', summary: '多套主题色' });
    const hits = await searchSpecs(t.db, { query: '验证码' });
    expect(hits).toEqual([
      { taskId: newer.id, title: '验证码限流', mergedAt: ago(DAY).toISOString() },
      {
        taskId: older.id,
        title: '登录页加验证码',
        specDir: 'specs/12-登录验证码',
        resultSummary: '加了 60 秒过期',
        mergedAt: ago(10 * DAY).toISOString(),
      },
    ]);
  });

  it('按改动位置找：子任务改过的路径', async () => {
    const hit = await spec({ title: '数据表 v1', summary: '建表', touches: ['packages/db/src/schema'] });
    await spec({ title: '驾驶舱首页', summary: '看板', touches: ['packages/web/src'] });
    expect((await searchSpecs(t.db, { query: 'packages/db' })).map((h) => h.taskId)).toEqual([hit.id]);
  });

  it('多个词要都命中', async () => {
    const both = await spec({ title: '登录验证码', summary: '短信' });
    await spec({ title: '登录页改版', summary: '换布局' });
    expect((await searchSpecs(t.db, { query: '登录  短信' })).map((h) => h.taskId)).toEqual([both.id]);
  });

  it('查询里的 % 和 _ 按字面匹配，不当通配符', async () => {
    const pct = await spec({ title: '成功率显示成 100%', summary: '百分号' });
    await spec({ title: '成功率显示成 1000', summary: '数字' });
    expect((await searchSpecs(t.db, { query: '100%' })).map((h) => h.taskId)).toEqual([pct.id]);
    expect(await searchSpecs(t.db, { query: '_' })).toEqual([]);
  });

  it('条数限制在 1–20，可以只查一个仓，空查询不返回东西', async () => {
    for (let i = 0; i < 25; i++) await spec({ title: `需求 ${i}`, summary: '批量' });
    const other = await addRepo(t.db);
    const elsewhere = await spec({ title: '别的仓的需求', summary: '批量' }, other.id);
    expect(await searchSpecs(t.db, { query: '批量', limit: 100 })).toHaveLength(20);
    expect(await searchSpecs(t.db, { query: '批量' })).toHaveLength(5);
    expect(await searchSpecs(t.db, { query: '批量', limit: 0 })).toHaveLength(1);
    expect(
      (await searchSpecs(t.db, { query: '批量', repoId: other.id, limit: 20 })).map((h) => h.taskId),
    ).toEqual([elsewhere.id]);
    expect(await searchSpecs(t.db, { query: '   ' })).toEqual([]);
  });
});
