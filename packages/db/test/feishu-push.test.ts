// 提醒推飞书的查询：哪些该推、到点、退避、试满不再试；送达记录；推送状态；看门狗「推送不通」的判法。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  FEISHU_MAIN_RED_ESCALATE_MS,
  FEISHU_PUSH_ESCALATE_MS,
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

describe('feishuPushableSince（推送分级）', () => {
  const since = (level: 'decision' | 'alert' | 'daily', dedupeKey: string, redPushedBefore?: boolean) =>
    feishuPushableSince({
      level,
      dedupeKey,
      createdAt: NOW,
      ...(redPushedBefore === undefined ? {} : { redPushedBefore }),
    });
  const escalated = new Date(NOW.getTime() + 120 * MIN);
  const redEscalated = new Date(NOW.getTime() + 60 * MIN);

  it('要你拍、每日简报、推送测试马上推', () => {
    expect(since('decision', 'x')).toEqual(NOW);
    expect(since('daily', 'feishu:test:2026-10-15T00:00:00.000Z')).toEqual(NOW);
    expect(since('daily', 'feishu:brief:2026-10-15')).toEqual(NOW);
  });

  it('卡住报警开满 120 分钟、主线红开满 60 分钟没撤才推（和配置的两个常量一致）', () => {
    expect(FEISHU_PUSH_ESCALATE_MS).toBe(120 * MIN);
    expect(FEISHU_MAIN_RED_ESCALATE_MS).toBe(60 * MIN);
    expect(since('alert', 'task:o/r#1:park:1')).toEqual(escalated);
    expect(since('daily', 'feishu:main-red:abc')).toEqual(redEscalated);
  });

  it('主线已恢复：之前真推出去过主线红才推，没推过不打扰', () => {
    expect(since('daily', 'feishu:main-recovered:abc', true)).toEqual(NOW);
    expect(since('daily', 'feishu:main-recovered:abc', false)).toBeNull();
    expect(since('daily', 'feishu:main-recovered:abc')).toBeNull();
  });

  it('白名单里的几类报警都是开满 120 分钟才推', () => {
    for (const key of [
      'task:o/r#1:park:2',
      'deploy-lag:abc',
      'auto-release:o/r:failed',
      'watchdog:healthz:x',
      'watchdog:release:x',
      'github-app:bot:o/r',
      'reconcile:pr:o/r#5',
    ]) {
      expect(since('alert', key), key).toEqual(escalated);
    }
  });

  it('白名单之外一律不推：看门狗任务、红、额度读数、对账额度、主线已恢复、再提醒、路由疑似降智、日报、整池暂停到期、主线结论记账行', () => {
    for (const key of [
      'watchdog:job:x:run',
      'watchdog:red:x',
      'quota-read:x',
      'reconcile:quota:x',
      'task:o/r#1:history',
      'new-kind:x',
    ]) {
      expect(since('alert', key), key).toBeNull();
    }
    expect(since('daily', 'feishu:main-recovered:abc')).toBeNull();
    expect(since('alert', 'remind:abc:2026-10-14')).toBeNull();
    expect(since('alert', 'probe-iq:auto:cursor:claude-haiku-5-5-low')).toBeNull();
    expect(since('daily', 'groom:done:1')).toBeNull();
    expect(since('daily', 'feishu:pool-hold-overdue:2026-10-14')).toBeNull();
    expect(since('daily', 'feishu:main-ci-verdict')).toBeNull();
  });
});

describe('pendingFeishuPushes', () => {
  it('只给该推、到点、没处理、24 小时内的，老的在前', async () => {
    await note('decide', 'decision', ago(5 * MIN));
    await note('deploy-lag:old-enough', 'alert', ago(121 * MIN));
    await note('deploy-lag:too-new', 'alert', ago(90 * MIN));
    await note('deploy-lag:healed', 'alert', ago(3 * HOUR), { resolvedAt: ago(70 * MIN) });
    await note('task:o/r#1:park:1', 'alert', ago(122 * MIN));
    await note('watchdog:job:x:run', 'alert', ago(3 * HOUR));
    await note('quota-read:x', 'alert', ago(3 * HOUR));
    await note('remind:abc:2026-10-14', 'alert', ago(3 * HOUR));
    await note('probe-iq:auto:cursor:x', 'alert', ago(3 * HOUR));
    await note('feishu:brief:2026-10-15', 'daily', ago(1 * MIN));
    await note('feishu:main-red:abc', 'daily', ago(20 * MIN));
    await note('feishu:main-ci-verdict', 'daily', ago(1 * MIN));
    await note('groom:done:1', 'daily', ago(1 * MIN));
    await note('handled', 'decision', ago(5 * MIN), { resolvedAt: ago(1 * MIN) });
    await note('too-old', 'decision', ago(25 * HOUR));
    expect(await keys()).toEqual([
      'task:o/r#1:park:1',
      'deploy-lag:old-enough',
      'decide',
      'feishu:brief:2026-10-15',
    ]);
    // 主线红开满 60 分钟还没撤（没转绿）：推
    expect(await keys(new Date(NOW.getTime() + 41 * MIN))).toContain('feishu:main-red:abc');
  });

  it('主线已恢复：之前 24 小时内真推出去过主线红才推', async () => {
    const red = await note('feishu:main-red:aaa', 'daily', ago(3 * HOUR), { resolvedAt: ago(1 * HOUR) });
    await note('feishu:main-recovered:aaa', 'daily', ago(1 * HOUR));
    expect(await keys()).toEqual([]);
    await recordFeishuDelivery(t.db, { notificationId: red, at: ago(2 * HOUR), messageId: 'om_red' });
    expect(await keys()).toEqual(['feishu:main-recovered:aaa']);
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
