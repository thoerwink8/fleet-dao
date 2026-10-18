import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CheckoutReceiptInput, recordCheckoutReceipt } from '../src/queries/checkout-receipts.ts';
import { resolveAlertIfUnchangedSince, upsertAlert } from '../src/queries/engine-alerts.ts';
import { auditLog, notifications } from '../src/schema/ops.ts';
import { createTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(async () => {
  await t?.close();
});
const make = (): CheckoutReceiptInput => ({
  receiptId: randomUUID(),
  taskId: randomUUID(),
  runId: randomUUID(),
  workflowId: 'task:acme/demo#12',
  head: 'a'.repeat(40),
  dir: '/tmp/verify-unique',
  startedAt: new Date('2026-10-19T00:00:00Z'),
  completedAt: new Date('2026-10-19T00:00:01Z'),
  type: 'full',
});
describe('完整检出成功回执实际持久化', () => {
  it('旧卡不存在也追加；同 ID 重送幂等，不同物理调用独立保存', async () => {
    const first = make();
    await recordCheckoutReceipt(t.db, first);
    await recordCheckoutReceipt(t.db, first);
    const second = { ...first, receiptId: randomUUID() };
    await recordCheckoutReceipt(t.db, second);
    const rows = await t.db.select().from(auditLog).where(eq(auditLog.action, 'cold_verify.checkout_full'));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.after).toMatchObject({
      head: first.head,
      taskId: first.taskId,
      workflowId: first.workflowId,
      startedAt: first.startedAt.toISOString(),
      completedAt: first.completedAt.toISOString(),
      type: 'full',
    });
    await expect(recordCheckoutReceipt(t.db, { ...first, dir: '/different' })).rejects.toThrow(
      'ID 已用于不同内容',
    );
    expect(await t.db.select().from(auditLog)).toHaveLength(2);
  });
  it('旧卡早已恢复后，连续成功仍有各自独立回执且不重写旧卡', async () => {
    const dedupeKey = 'verify-checkout:already-resolved';
    await upsertAlert(t.db, { dedupeKey, level: 'alert', taskId: null, title: 'failed', body: 'old' });
    expect(
      await resolveAlertIfUnchangedSince(t.db, { dedupeKey, by: 'test', since: new Date('2100-01-01') }),
    ).toBe('ok');
    const [before] = await t.db.select().from(notifications).where(eq(notifications.dedupeKey, dedupeKey));
    const one = make();
    await recordCheckoutReceipt(t.db, one);
    await recordCheckoutReceipt(t.db, { ...one, receiptId: randomUUID(), dir: '/tmp/verify-next' });
    const [after] = await t.db.select().from(notifications).where(eq(notifications.dedupeKey, dedupeKey));
    expect(after).toEqual(before);
    expect(
      (await t.db.select().from(auditLog).where(eq(auditLog.action, 'cold_verify.checkout_full'))).filter(
        (row) => (row.after as { taskId: string }).taskId === one.taskId,
      ),
    ).toHaveLength(2);
  });
  it('不接受短 head、缺工作流或倒序时间，不补造旧历史', async () => {
    const receipt = make();
    await expect(recordCheckoutReceipt(t.db, { ...receipt, head: 'abc' })).rejects.toThrow('不合法');
    await expect(recordCheckoutReceipt(t.db, { ...receipt, workflowId: undefined })).rejects.toThrow(
      '不合法',
    );
    await expect(
      recordCheckoutReceipt(t.db, { ...receipt, completedAt: new Date('2020-01-01') }),
    ).rejects.toThrow('不合法');
  });
});
