// 关单收尾数开着的会话（#3002）：没有任务行、对上多行、数认不出都抛，不当成 0。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { countOpenRunsForIssue, requireOpenRunCount } from '../src/queries/idle-running.ts';
import { repos, runs, tasks } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addTask } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

const at = new Date('2026-10-17T20:00:00.000Z');

describe('requireOpenRunCount', () => {
  it('收非负整数、数字串和 bigint；空、小数、负数都抛，不当成没有会话', () => {
    expect(requireOpenRunCount(0, 'a/b#1')).toBe(0);
    expect(requireOpenRunCount(2, 'a/b#1')).toBe(2);
    expect(requireOpenRunCount('0', 'a/b#1')).toBe(0);
    expect(requireOpenRunCount('3', 'a/b#1')).toBe(3);
    expect(requireOpenRunCount(0n, 'a/b#1')).toBe(0);
    expect(requireOpenRunCount(4n, 'a/b#1')).toBe(4);
    for (const raw of [null, undefined, '', 1.5, '1.5', '01', -1, true]) {
      expect(() => requireOpenRunCount(raw, 'a/b#1')).toThrow('不当成没有会话');
    }
  });
});

describe('countOpenRunsForIssue', () => {
  it('两笔已结束的会话数是 0；还有一笔没结束、或只靠工作流编号挂上的，数进去', async () => {
    const repo = await addRepo(t.db, 'fleet-dao');
    const task = await addTask(t.db, repo.id, { issueNumber: 2928, state: 'running' });
    const wf = 'task:acme/fleet-dao#2928';
    await t.db.insert(runs).values([
      {
        segment: 'manual',
        model: 'm1',
        taskId: task.id,
        workflowId: wf,
        startedAt: at,
        endedAt: at,
        outcome: 'done',
      },
      {
        segment: 'manual',
        model: 'm1',
        taskId: task.id,
        workflowId: wf,
        startedAt: at,
        endedAt: at,
        outcome: 'done',
      },
    ]);
    expect(await countOpenRunsForIssue(t.db, { owner: 'ACME', name: 'Fleet-Dao' }, 2928, wf)).toBe(0);
    await t.db.insert(runs).values({
      segment: 'manual',
      model: 'm1',
      workflowId: wf,
      startedAt: at,
    });
    expect(await countOpenRunsForIssue(t.db, { owner: 'acme', name: 'fleet-dao' }, 2928, wf)).toBe(1);
  });

  it('没有任务行、或大小写不同的两行都对上：抛，不当成没有会话', async () => {
    await expect(countOpenRunsForIssue(t.db, { owner: 'acme', name: 'missing' }, 1)).rejects.toThrow(
      '没有任务行',
    );
    const [a] = await t.db
      .insert(repos)
      .values({ owner: 'acme', name: 'demo', testCommand: 'pnpm check' })
      .returning();
    const [b] = await t.db
      .insert(repos)
      .values({ owner: 'Acme', name: 'Demo', testCommand: 'pnpm check' })
      .returning();
    if (!a || !b) throw new Error('repo 没写进去');
    await t.db.insert(tasks).values([
      {
        repoId: a.id,
        issueNumber: 7,
        title: '甲',
        rawRequest: '甲',
        requestedBy: 'founder-a',
        priority: 10,
      },
      {
        repoId: b.id,
        issueNumber: 7,
        title: '乙',
        rawRequest: '乙',
        requestedBy: 'founder-a',
        priority: 10,
      },
    ]);
    await expect(countOpenRunsForIssue(t.db, { owner: 'acme', name: 'demo' }, 7)).rejects.toThrow(
      '对上 2 行',
    );
  });
});
