// 各渠道额度留量线种子的装载（#194 方案 4.8，创始人 2026-10-05：不写死，驾驶舱可配置）：只补缺、已有的一个字不动；
// 种子读不到、认不出、引用的池库里没有，整批不装、明确报错。
import { QUOTA_RESERVE_SEED_ACTOR, QUOTA_RESERVE_SETTING } from '@fleet-dao/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readQuotaReserveSetting } from '../src/queries/session-org-state.ts';
import {
  applyQuotaReserveSeed,
  loadQuotaReserveSeed,
  parseQuotaReserveSeed,
  QUOTA_RESERVE_DEFAULT_PATH,
  QuotaReserveSeedError,
  runQuotaReserveApply,
} from '../src/quota-reserve-apply.ts';
import { pools, settings } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { catalog } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetTestDb(t);
  await catalog(t.db);
  await t.db.insert(pools).values({ id: 'claude-solo', channelId: 'relay', maxConcurrency: 2 });
});

const rowOf = async () =>
  (await t.db.select().from(settings).where(eq(settings.key, QUOTA_RESERVE_SETTING)))[0];

describe('仓里的种子文件', () => {
  it('读得出：独享池 5 小时窗 0.8、周窗 0.7，别的池一个都没写（线只来自这份数据）', async () => {
    const seed = await loadQuotaReserveSeed(QUOTA_RESERVE_DEFAULT_PATH);
    expect(seed.pools).toEqual({ 'claude-solo': { '5h': 0.8, '7d': 0.7 } });
  });
});

describe('装进库：只补缺', () => {
  it('库里没有：按种子装，记成种子装的（驾驶舱写「来自种子」）；读设置的口读得到', async () => {
    const seed = await loadQuotaReserveSeed();
    expect(await applyQuotaReserveSeed(t.db, seed)).toEqual({ applied: true });
    const row = await rowOf();
    expect(row).toMatchObject({
      value: { 'claude-solo': { '5h': 0.8, '7d': 0.7 } },
      version: 1,
      updatedBy: QUOTA_RESERVE_SEED_ACTOR,
    });
    expect(await readQuotaReserveSetting(t.db)).toMatchObject({
      set: true,
      value: { 'claude-solo': { '5h': 0.8, '7d': 0.7 } },
    });
  });

  it('【故意造出失败】库里没有这一行时，读设置的口明说「没有」，不拿空对象冒充', async () => {
    expect(await readQuotaReserveSetting(t.db)).toEqual({ set: false });
  });

  it('跑几遍都一样；已有的（包括创始人改过的）一个字不动：值、版本、谁改的都不变', async () => {
    await applyQuotaReserveSeed(t.db, await loadQuotaReserveSeed());
    // 创始人在驾驶舱把周窗改成 0.55、5 小时窗清成不限（版本加一、updatedBy 是他）
    await t.db
      .update(settings)
      .set({ value: { 'claude-solo': { '7d': 0.55, '5h': null } }, version: 2, updatedBy: 'u-founder' })
      .where(eq(settings.key, QUOTA_RESERVE_SETTING));
    const before = await rowOf();
    expect(await applyQuotaReserveSeed(t.db, await loadQuotaReserveSeed())).toEqual({ applied: false });
    expect(await rowOf()).toEqual(before);
    expect(await rowOf()).toMatchObject({
      value: { 'claude-solo': { '7d': 0.55, '5h': null } },
      version: 2,
      updatedBy: 'u-founder',
    });
  });

  it('已有的是坏值（被人直接改库）：装载器也不碰它——认不出由引擎、驾驶舱明说，不在这里悄悄换掉', async () => {
    await t.db.insert(settings).values({ key: QUOTA_RESERVE_SETTING, value: 'oops', updatedBy: 'x' });
    expect(await applyQuotaReserveSeed(t.db, await loadQuotaReserveSeed())).toEqual({ applied: false });
    expect((await rowOf())?.value).toBe('oops');
  });

  it('【故意造出失败】种子里写的池库里没有（编号写错）：一行不装、报错点名，不悄悄不起作用', async () => {
    const seed = parseQuotaReserveSeed(JSON.stringify({ pools: { 'claude-sol0': { '7d': 0.7 } } }));
    await expect(applyQuotaReserveSeed(t.db, seed)).rejects.toThrow(/账号池 claude-sol0 库里没有/);
    expect(await rowOf()).toBeUndefined();
  });

  it('摘要说清装了还是没动', async () => {
    expect(await runQuotaReserveApply(t.db)).toContain('按种子装进去了');
    expect(await runQuotaReserveApply(t.db)).toContain('一个字没动');
  });
});

describe('种子读不到、认不出：整批不装', () => {
  const parse = (v: unknown) => () => parseQuotaReserveSeed(JSON.stringify(v), 'seed.json');

  it('【故意造出失败】线是负数、大于 1、字符串、null 以外的非数字、未知窗口、多余的键：报错', () => {
    for (const bad of [-0.1, 1.2, '0.8', true]) {
      expect(parse({ pools: { p: { '5h': bad } } }), JSON.stringify(bad)).toThrow(QuotaReserveSeedError);
    }
    expect(parse({ pools: { p: { weekly: 0.7 } } })).toThrow(QuotaReserveSeedError);
    expect(parse({ pools: { p: { '5h': 0.8 } }, extra: 1 })).toThrow(QuotaReserveSeedError);
    expect(parse({})).toThrow(/格式不对/);
    expect(parse({ pools: [] })).toThrow(QuotaReserveSeedError);
  });

  it('【故意造出失败】不是 JSON / 文件不存在：报错，不当成空配置；下划线开头的键是注释', async () => {
    expect(() => parseQuotaReserveSeed('{oops', 'seed.json')).toThrow(/不是合法的 JSON/);
    await expect(loadQuotaReserveSeed(new URL('./no-such-seed.json', import.meta.url))).rejects.toThrow(
      /读不到额度留量线种子/,
    );
    expect(parseQuotaReserveSeed('{"_说明":"x","pools":{"p":{"7d":0.5}}}').pools).toEqual({
      p: { '7d': 0.5 },
    });
  });

  it('【故意造出失败】种子坏了，runQuotaReserveApply 抛、库里不留半截', async () => {
    await expect(runQuotaReserveApply(t.db, new URL('./no-such-seed.json', import.meta.url))).rejects.toThrow(
      QuotaReserveSeedError,
    );
    expect(await rowOf()).toBeUndefined();
  });
});
