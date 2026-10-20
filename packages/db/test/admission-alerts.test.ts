import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMISSION_ALERT_PREFIX,
  type AdmissionAlertObservation,
  admissionAlertJson,
  admissionAlertKey,
  insertAdmissionUnknownAlertOnce,
} from '../src/queries/admission-alerts.ts';
import { pendingFeishuPushes } from '../src/queries/feishu-push.ts';
import { notificationDeliveries, notifications } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';

let t: TestDb;
const observation = (): AdmissionAlertObservation => ({
  identity: {
    version: 1,
    category: 'legacy_admission_unknown',
    namespace: 'test',
    workflowId: 'task:example/test#1',
    runId: randomUUID(),
  },
  firstCode: 'deadline',
});
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
beforeEach(async () => {
  await resetTestDb(t);
});
afterAll(async () => {
  await t?.close();
});
describe('准入未知通知专用insert-once', () => {
  it('相同全局identity换首码重建及100次重复不改任何通知/交付字段，不重开已解决卡', async () => {
    const o = observation();
    const first = await t.db.transaction((tx) => insertAdmissionUnknownAlertOnce(tx, o));
    expect(first.kind).toBe('persisted');
    if (first.kind !== 'persisted') throw Error('未持久化');
    await t.db
      .update(notifications)
      .set({
        resolvedAt: new Date('2026-10-01T00:00:00Z'),
        resolvedBy: 'test-operator',
        answer: { at: '2026-10-01T00:00:00Z', by: 'test-operator', text: '保留原处理状态' },
      })
      .where(eq(notifications.id, first.notificationId));
    await t.db.insert(notificationDeliveries).values({
      notificationId: first.notificationId,
      channel: 'feishu',
      target: 'isolated',
      messageId: 'real-test-message',
      deliveredAt: new Date('2026-10-01T00:00:00Z'),
      attempts: 2,
    });
    const before = await t.db.select().from(notifications);
    const deliveries = await t.db.select().from(notificationDeliveries);
    const rebuilt = { ...o, firstCode: 'store_unavailable' as const };
    for (let n = 0; n < 100; n++)
      expect(await t.db.transaction((tx) => insertAdmissionUnknownAlertOnce(tx, rebuilt))).toEqual(first);
    expect(await t.db.select().from(notifications)).toEqual(before);
    expect(await t.db.select().from(notificationDeliveries)).toEqual(deliveries);
    expect(before[0]?.body).toBe(admissionAlertJson(o));
  });
  it('冲突行正文/identity损坏明确conflict，不覆盖也不丢原件', async () => {
    const o = observation();
    await t.db.insert(notifications).values({
      dedupeKey: ADMISSION_ALERT_PREFIX + admissionAlertKey(o.identity),
      level: 'alert',
      title: 'foreign',
      body: 'keep-me',
    });
    const before = await t.db.select().from(notifications);
    expect(await insertAdmissionUnknownAlertOnce(t.db, o)).toEqual({
      kind: 'unknown',
      code: 'notification_conflict',
    });
    expect(await t.db.select().from(notifications)).toEqual(before);
  });
  it('新前缀不冒充飞书白名单；持久化不造delivery', async () => {
    await insertAdmissionUnknownAlertOnce(t.db, observation());
    expect(await t.db.select().from(notificationDeliveries)).toEqual([]);
    expect(await pendingFeishuPushes(t.db, new Date(), 100)).toEqual([]);
    expect((await t.db.select().from(notifications))[0]?.taskId).toBeNull();
  });
});
