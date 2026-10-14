// 看门狗「主线 N 小时没合 PR」要的事实（queries/merge-stall.ts，决定 0093）：只看开着「让 AI 接活」的仓；
// 最近一次合并取镜像里 merged_at 最新的；在做的只数分诊、写方案、在干、在合并；等空位的单数取拉单最近一轮记的，没记过是 null。
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { writeIntakeWaiting } from '../src/queries/intake-history.ts';
import { mergeStallFacts } from '../src/queries/merge-stall.ts';
import { pullRequests, repos, settings } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addTask, ago, HOUR, NOW } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

async function pr(repoId: string, number: number, mergedAt: Date | null) {
  await t.db.insert(pullRequests).values({
    repoId,
    number,
    state: mergedAt ? 'merged' : 'open',
    headRef: `fleet/${number}`,
    headSha: 'a'.repeat(40),
    updatedAt: NOW,
    mergedAt,
  });
}

describe('mergeStallFacts', () => {
  it('开着开关的仓才列；最近一次合并、在做几张、等空位几张都对得上', async () => {
    const on = await addRepo(t.db, 'on');
    const off = await addRepo(t.db, 'off');
    await t.db
      .update(repos)
      .set({ autoDispatchSince: ago(48 * HOUR) })
      .where(eq(repos.id, on.id));
    await pr(on.id, 7, ago(5 * HOUR));
    await pr(on.id, 9, ago(2 * HOUR));
    await pr(on.id, 11, null);
    await pr(off.id, 3, ago(HOUR));
    for (const state of ['running', 'stalled', 'done', 'queued'] as const) {
      await addTask(t.db, on.id, { state });
    }
    await addTask(t.db, off.id, { state: 'running' });
    await writeIntakeWaiting(t.db, { at: ago(HOUR), byRepo: { [on.id]: 2 }, by: 'test' });

    expect(await mergeStallFacts(t.db)).toEqual({
      waitingAt: ago(HOUR),
      repos: [
        {
          repoId: on.id,
          repo: 'acme/on',
          dispatchSince: ago(48 * HOUR),
          lastMerged: { number: 9, at: ago(2 * HOUR) },
          inFlight: 1,
          waiting: 2,
        },
      ],
    });
  });

  it('没合过、拉单没记过：lastMerged、waiting、waitingAt 都是 null（不拿 0 冒充）', async () => {
    const on = await addRepo(t.db, 'fresh');
    await t.db
      .update(repos)
      .set({ autoDispatchSince: ago(HOUR) })
      .where(eq(repos.id, on.id));
    const got = await mergeStallFacts(t.db);
    expect(got.waitingAt).toBeNull();
    expect(got.repos).toEqual([
      {
        repoId: on.id,
        repo: 'acme/fresh',
        dispatchSince: ago(HOUR),
        lastMerged: null,
        inFlight: 0,
        waiting: null,
      },
    ]);
  });

  it('【故意造出的失败】拉单记的那一行认不出：照抛，不当成没有待做的单', async () => {
    const on = await addRepo(t.db, 'bad');
    await t.db
      .update(repos)
      .set({ autoDispatchSince: ago(HOUR) })
      .where(eq(repos.id, on.id));
    await t.db.insert(settings).values({ key: 'engine.intakeWaiting', value: { at: 'x', byRepo: {} } });
    await expect(mergeStallFacts(t.db)).rejects.toThrow(/认不出/);
  });
});
