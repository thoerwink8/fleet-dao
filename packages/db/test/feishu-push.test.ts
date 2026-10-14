// 提醒推飞书的查询：哪些该推、到点、退避、试满不再试；送达记录；推送状态；看门狗「推送不通」的判法。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  FEISHU_PUSH_MAX_ATTEMPTS,
  feishuPushableSince,
  feishuPushFacts,
  feishuPushProblem,
  pendingFeishuPushes,
  readFeishuPushStatus,
  recordFeishuDelivery,
  writeFeishuPushStatus,
} from '../src/queries/feishu-push.ts';
import { notificationDeliveries, notifications } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { ago, HOUR, MIN, NOW } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

async function note(
  dedupeKey: string,
  level: 'decision' | 'alert' | 'daily',
  createdAt: Date,
  extra: { resolvedAt?: Date } = {},
): Promise<string> {
  const [row] = await t.db
    .insert(notifications)
    .values({ dedupeKey, level, title: `标题 ${dedupeKey}`, body: '正文', createdAt, ...extra })
    .returning({ id: notifications.id });
  if (!row) throw new Error('没插进去');
  return row.id;
}

const keys = async (now = NOW) => (await pendingFeishuPushes(t.db, now, 50)).map((p) => p.dedupeKey);

describe('feishuPushableSince', () => {
  it('要你拍、feishu: 开头的马上推；卡住报警开着 10 分钟才推；日报和主线结论记账行不推', () => {
    expect(feishuPushableSince({ level: 'decision', dedupeKey: 'x', createdAt: NOW })).toEqual(NOW);
    expect(feishuPushableSince({ level: 'daily', dedupeKey: 'feishu:main-red:abc', createdAt: NOW })).toEqual(
      NOW,
    );
    expect(feishuPushableSince({ level: 'alert', dedupeKey: 'x', createdAt: NOW })).toEqual(
      new Date(NOW.getTime() + 10 * MIN),
    );
    expect(feishuPushableSince({ level: 'daily', dedupeKey: 'groom:done:1', createdAt: NOW })).toBeNull();
    expect(
      feishuPushableSince({ level: 'daily', dedupeKey: 'feishu:main-ci-verdict', createdAt: NOW }),
    ).toBeNull();
  });
});

describe('pendingFeishuPushes', () => {
  it('只给该推、到点、没处理、24 小时内的，老的在前', async () => {
    await note('decide', 'decision', ago(5 * MIN));
    await note('alert-old-enough', 'alert', ago(11 * MIN));
    await note('alert-too-new', 'alert', ago(3 * MIN));
    await note('feishu:main-red:abc', 'daily', ago(1 * MIN));
    await note('feishu:main-ci-verdict', 'daily', ago(1 * MIN));
    await note('groom:done:1', 'daily', ago(1 * MIN));
    await note('handled', 'decision', ago(5 * MIN), { resolvedAt: ago(1 * MIN) });
    await note('too-old', 'decision', ago(25 * HOUR));
    expect(await keys()).toEqual(['alert-old-enough', 'decide', 'feishu:main-red:abc']);
  });

  it('送到了不再给；没送成按退避再给，试满不再给', async () => {
    const sent = await note('sent', 'decision', ago(5 * MIN));
    const failing = await note('failing', 'decision', ago(30 * MIN));
    await recordFeishuDelivery(t.db, { notificationId: sent, at: ago(4 * MIN), messageId: 'om_1' });
    await recordFeishuDelivery(t.db, { notificationId: failing, at: ago(1 * MIN), error: '飞书回了 500' });
    expect(await keys()).toEqual([]);
    expect(await keys(new Date(NOW.getTime() + 2 * MIN))).toEqual(['failing']);
    for (let i = 1; i < FEISHU_PUSH_MAX_ATTEMPTS; i++) {
      await recordFeishuDelivery(t.db, { notificationId: failing, at: ago(1 * MIN), error: '还是不行' });
    }
    expect(await keys(new Date(NOW.getTime() + HOUR))).toEqual([]);
    const row = (await t.db.select().from(notificationDeliveries)).find((r) => r.notificationId === failing);
    expect(row).toMatchObject({
      attempts: FEISHU_PUSH_MAX_ATTEMPTS,
      lastError: '还是不行',
      deliveredAt: null,
    });
  });

  it('送达记录：拿到 message_id 才算送到，试的次数累加', async () => {
    const id = await note('d', 'decision', ago(5 * MIN));
    await recordFeishuDelivery(t.db, { notificationId: id, at: ago(3 * MIN), error: '超时' });
    await recordFeishuDelivery(t.db, { notificationId: id, at: ago(1 * MIN), messageId: 'om_9' });
    const rows = await t.db.select().from(notificationDeliveries);
    expect(rows).toEqual([
      expect.objectContaining({
        channel: 'feishu',
        target: 'team',
        messageId: 'om_9',
        attempts: 2,
        lastError: null,
        deliveredAt: ago(1 * MIN),
      }),
    ]);
  });
});

describe('推送状态', () => {
  it('没写过是 null；写了读回一样', async () => {
    expect(await readFeishuPushStatus(t.db)).toBeNull();
    await writeFeishuPushStatus(t.db, { configured: false, why: '机器人在 2 个群里', at: NOW });
    expect(await readFeishuPushStatus(t.db)).toEqual({
      configured: false,
      why: '机器人在 2 个群里',
      at: NOW,
    });
    await writeFeishuPushStatus(t.db, { configured: true, why: null, at: NOW });
    expect(await readFeishuPushStatus(t.db)).toEqual({ configured: true, why: null, at: NOW });
  });
});

describe('feishuPushProblem（看门狗和巡检的判法）', () => {
  it('没东西要推：通着', async () => {
    expect(feishuPushProblem(await feishuPushFacts(t.db, NOW), NOW)).toBeNull();
  });

  it('后端记了没配：马上报，不等 1 小时', async () => {
    await writeFeishuPushStatus(t.db, { configured: false, why: '缺 FEISHU_APP_ID', at: NOW });
    expect(feishuPushProblem(await feishuPushFacts(t.db, NOW), NOW)).toContain(
      '飞书推送没配：缺 FEISHU_APP_ID',
    );
  });

  it('该推的到点超过 1 小时没送到、1 小时里一条都没送成：报；有一条送成了：不报', async () => {
    const old = await note('old', 'decision', ago(2 * HOUR));
    await recordFeishuDelivery(t.db, { notificationId: old, at: ago(HOUR), error: 'code=230002' });
    const facts = await feishuPushFacts(t.db, NOW);
    expect(facts.undelivered).toBe(1);
    const problem = feishuPushProblem(facts, NOW);
    expect(problem).toContain('飞书推送不通');
    expect(problem).toContain('code=230002');
    expect(problem).toContain('从没送到过');

    const fresh = await note('fresh', 'decision', ago(10 * MIN));
    await recordFeishuDelivery(t.db, { notificationId: fresh, at: ago(5 * MIN), messageId: 'om_2' });
    expect(feishuPushProblem(await feishuPushFacts(t.db, NOW), NOW)).toBeNull();
  });

  it('该推的还不到 1 小时：不报', async () => {
    await note('young', 'decision', ago(30 * MIN));
    expect(feishuPushProblem(await feishuPushFacts(t.db, NOW), NOW)).toBeNull();
  });
});
