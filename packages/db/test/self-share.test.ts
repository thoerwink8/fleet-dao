// 名额档位那一行设置，和判档要用的两项库里指标（#3618）：主线红了多少分钟、非掏钱非删数据的拍板卡有几张。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  mainRedMinutes,
  offReasonDecisions,
  readSelfShare,
  type SelfShareRecord,
  writeSelfShare,
} from '../src/queries/self-share.ts';
import { notifications, settings } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { ago, askFields, MIN, NOW } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

const rec = (over: Partial<SelfShareRecord> = {}): SelfShareRecord => ({
  tier: 'budget',
  at: NOW,
  day: '2026-09-25',
  checks: [{ key: 'oneRoundRate', value: 0.5, pass: true }],
  days: [{ day: '2026-09-25', allPass: false }],
  ...over,
});

describe('engine.selfShare 读写', () => {
  it('没有这一行是 null；写了读得回；再写换掉', async () => {
    expect(await readSelfShare(t.db)).toBeNull();
    await writeSelfShare(t.db, rec(), 'engine:daily-brief');
    expect(await readSelfShare(t.db)).toEqual(rec());
    const next = rec({ tier: 'frozen', at: new Date(NOW.getTime() + MIN) });
    await writeSelfShare(t.db, next, 'engine:daily-brief');
    expect(await readSelfShare(t.db)).toEqual(next);
  });

  it('形状不对照抛，不当成没有档位', async () => {
    await t.db.insert(settings).values({ key: 'engine.selfShare', value: { tier: 'weird' } });
    await expect(readSelfShare(t.db)).rejects.toThrow('engine.selfShare');
  });
});

describe('mainRedMinutes / offReasonDecisions', () => {
  const to = NOW;

  it('主线红：截到窗口里、还开着的算到窗口尾、重叠只算一次；窗口外和别的提醒不算', async () => {
    const windowStart = new Date(to.getTime() - 7 * 24 * 60 * MIN);
    await t.db.insert(notifications).values([
      {
        dedupeKey: 'feishu:main-red:aaa',
        level: 'daily',
        title: '红',
        body: '',
        createdAt: ago(2 * 60 * MIN),
        resolvedAt: ago(60 * MIN),
      },
      {
        dedupeKey: 'feishu:main-red:bbb',
        level: 'daily',
        title: '叠上',
        body: '',
        createdAt: ago(90 * MIN),
        resolvedAt: ago(30 * MIN),
      },
      {
        dedupeKey: 'feishu:main-red:open',
        level: 'daily',
        title: '还红',
        body: '',
        createdAt: ago(15 * MIN),
      },
      {
        dedupeKey: 'feishu:main-red:old',
        level: 'daily',
        title: '旧的',
        body: '',
        createdAt: new Date(windowStart.getTime() - 2 * 60 * MIN),
        resolvedAt: new Date(windowStart.getTime() - MIN),
      },
      {
        dedupeKey: 'feishu:brief:2026-09-25',
        level: 'daily',
        title: '简报',
        body: '',
        createdAt: ago(60 * MIN),
      },
    ]);
    // aaa+bbb 并成 10:00–11:30＝90 分钟；11:45 起还开着的算到 12:00＝15 分钟。一共 105。
    expect(await mainRedMinutes(t.db, to)).toBe(105);
  });

  it('开着的拍板卡：只有人能做的算，掏新钱和删了找不回的不算，处理掉的不算', async () => {
    await t.db.insert(notifications).values([
      {
        dedupeKey: 'ask:human',
        level: 'decision',
        title: '只有人能做',
        body: '',
        ...askFields('decision'),
      },
      {
        dedupeKey: 'ask:money',
        level: 'decision',
        title: '掏钱',
        body: '',
        ...askFields('decision'),
        decisionReason: 'new-money',
      },
      {
        dedupeKey: 'ask:delete',
        level: 'decision',
        title: '删',
        body: '',
        ...askFields('decision'),
        decisionReason: 'irreversible-delete',
      },
      {
        dedupeKey: 'ask:done',
        level: 'decision',
        title: '处理了',
        body: '',
        ...askFields('decision'),
        resolvedAt: ago(MIN),
      },
      { dedupeKey: 'alert:1', level: 'alert', title: '卡住', body: '' },
    ]);
    expect(await offReasonDecisions(t.db)).toBe(1);
  });
});
