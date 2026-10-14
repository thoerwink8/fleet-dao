// 两条线交付质量对比（queries/executor-line-stats.ts，决定 0093 的 A4）：按分支前缀分线，近 7/30 天各算一行。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { executorLineStats, executorLineStatsSql } from '../src/queries/executor-line-stats.ts';
import { githubEvents, pullRequests } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, ago, DAY, HOUR, MIN, NOW } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

async function pr(
  repoId: string,
  number: number,
  o: { head: string; opened: Date; mergeAfter?: number; title?: string },
) {
  await t.db.insert(pullRequests).values({
    repoId,
    number,
    state: o.mergeAfter === undefined ? 'open' : 'merged',
    headRef: o.head,
    headSha: 'a'.repeat(40),
    updatedAt: NOW,
    openedAt: o.opened,
    mergedAt: o.mergeAfter === undefined ? null : new Date(o.opened.getTime() + o.mergeAfter),
    title: o.title ?? `PR ${number}`,
  });
}

let seq = 0;
async function push(number: number, at: Date) {
  seq += 1;
  await t.db.insert(githubEvents).values({
    deliveryId: `d${seq}`,
    event: 'pull_request',
    action: 'synchronize',
    source: 'webhook',
    repo: 'acme/r',
    payload: { pull_request: { number } },
    status: 'accepted',
    receivedAt: at,
    claimedAt: at,
    finishedAt: at,
  });
}

describe('executorLineStats', () => {
  it('按分支前缀分线，7/30 天各一行；中位、一轮做成率、返工、合并后 7 天内被回退都对得上', async () => {
    const r = await addRepo(t.db, 'r');
    await pr(r.id, 1, { head: 'fleet/1-a', opened: ago(10 * DAY), mergeAfter: 30 * MIN });
    await pr(r.id, 2, { head: 'fleet/2-b', opened: ago(9 * DAY), mergeAfter: 60 * MIN });
    await push(2, ago(9 * DAY - 10 * MIN));
    await push(2, ago(9 * DAY - 20 * MIN));
    // 合并后 1 小时开的回退，点名 #1
    await pr(r.id, 3, {
      head: 'fleet/3-c',
      opened: new Date(ago(10 * DAY).getTime() + 30 * MIN + HOUR),
      mergeAfter: 5 * MIN,
      title: '回退 #1',
    });
    await pr(r.id, 10, { head: 'local/10-x', opened: ago(2 * DAY), mergeAfter: 10 * MIN });
    await pr(r.id, 11, { head: 'worktree-q', opened: ago(DAY) });

    const rows = await executorLineStats(t.db, NOW);
    const find = (days: number, line: string) => rows.find((x) => x.days === days && x.line === line);

    expect(find(30, 'engine')).toEqual({
      days: 30,
      line: 'engine',
      nOpened: 3,
      nMerged: 3,
      openToMergeP50Min: 30,
      openToMergeP90Min: 54,
      oneRoundRate: 0.667,
      reworkPushesAvg: 0.67,
      nObserved7d: 3,
      fixedWithin7dRate: 0.333,
    });
    expect(find(7, 'engine')).toBeUndefined();
    expect(find(7, 'local')).toEqual({
      days: 7,
      line: 'local',
      nOpened: 2,
      nMerged: 1,
      openToMergeP50Min: 10,
      openToMergeP90Min: 10,
      oneRoundRate: 1,
      reworkPushesAvg: 0,
      nObserved7d: 0,
      fixedWithin7dRate: null,
    });
  });

  it('SQL 时刻不是有效日期就抛', () => {
    expect(() => executorLineStatsSql(new Date('x'))).toThrow();
  });
});
