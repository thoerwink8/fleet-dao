// 引擎捞「单关了」的投递、处理完记上（queries/reconcile.ts 的 pendingClosedIssueDeliveries / noteClosedIssueDelivery，#2103）。
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { noteClosedIssueDelivery, pendingClosedIssueDeliveries } from '../src/queries/reconcile.ts';
import { githubEvents } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

const T0 = new Date('2026-10-13T08:00:00.000Z');
const minutesAgo = (m: number) => new Date(T0.getTime() - m * 60_000);

async function delivery(
  deliveryId: string,
  over: Partial<typeof githubEvents.$inferInsert> = {},
): Promise<void> {
  const status = over.status ?? 'accepted';
  await t.db.insert(githubEvents).values({
    deliveryId,
    event: 'issues',
    action: 'closed',
    source: 'webhook',
    repo: 'acme/demo',
    payload: { action: 'closed', issue: { number: 7 }, repository: { full_name: 'acme/demo' } },
    status,
    reason: status === 'accepted' ? null : '用例',
    receivedAt: minutesAgo(1),
    claimedAt: minutesAgo(1),
    finishedAt: status === 'processing' ? null : minutesAgo(1),
    ...over,
  });
}

describe('单关了的投递', () => {
  it('只捞 since 之后、放进来、还没记过的 issues.closed，先收的在前；记过一次就不再捞到', async () => {
    await delivery('late', { receivedAt: minutesAgo(1) });
    await delivery('early', { receivedAt: minutesAgo(5) });
    await delivery('old', { receivedAt: minutesAgo(120) });
    await delivery('opened', { action: 'opened' });
    await delivery('pr', { event: 'pull_request' });
    await delivery('ignored', { status: 'ignored' });
    await delivery('done', { note: '单关了：放弃了 1 条停着等人的任务' });

    const rows = await pendingClosedIssueDeliveries(t.db, minutesAgo(60));
    expect(rows.map((r) => r.deliveryId)).toEqual(['early', 'late']);
    expect(rows[0]).toMatchObject({ repo: 'acme/demo', payload: { issue: { number: 7 } } });

    expect(await noteClosedIssueDelivery(t.db, 'early', '单关了：放弃了 1 条停着等人的任务')).toBe(true);
    expect(await noteClosedIssueDelivery(t.db, 'early', '又一次')).toBe(false);
    expect(await noteClosedIssueDelivery(t.db, 'ignored', '不该记')).toBe(false);
    expect(await noteClosedIssueDelivery(t.db, 'missing', '不在库里')).toBe(false);
    const [row] = await t.db.select().from(githubEvents).where(eq(githubEvents.deliveryId, 'early'));
    expect(row?.note).toBe('单关了：放弃了 1 条停着等人的任务');
    expect((await pendingClosedIssueDeliveries(t.db, minutesAgo(60))).map((r) => r.deliveryId)).toEqual([
      'late',
    ]);
  });
});
