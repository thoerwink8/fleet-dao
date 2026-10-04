// 引擎起来核拼车并发上限和登记的对不对得上（real/carpool-cap.ts，#194 方案 4.7）：对不上、没登记、写坏了、库里没有拼车池，
// 每一条都故意造一次——一律推 carpool-cap:registry 提醒、不当成「没配就不限」；对上了自己撤；库读不了照常抛。
import { notifications } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CARPOOL_CAP_ALERT,
  CARPOOL_CAP_ENV,
  checkCarpoolCap,
  judgeCarpoolCap,
} from '../../src/real/carpool-cap.ts';
import { world } from './fixtures.ts';

describe('judgeCarpoolCap：纯判断', () => {
  const pools = [{ poolId: 'claude-carpool', maxConcurrency: 4 }];

  it('登记的数等于库里拼车池上限加起来：对上', () => {
    expect(judgeCarpoolCap({ raw: '4', pools })).toEqual({
      ok: true,
      registered: 4,
      poolIds: ['claude-carpool'],
    });
    expect(
      judgeCarpoolCap({
        raw: ' 6\n',
        pools: [
          { poolId: 'a', maxConcurrency: 4 },
          { poolId: 'b', maxConcurrency: 2 },
        ],
      }),
    ).toMatchObject({ ok: true, registered: 6 });
  });

  it('【故意造出失败】对不上：写明登记的、库里的各是多少', () => {
    const v = judgeCarpoolCap({ raw: '2', pools });
    expect(v).toMatchObject({ ok: false, code: 'mismatch' });
    expect(!v.ok && v.why).toContain('登记的拼车并发上限是 2');
    expect(!v.ok && v.why).toContain('claude-carpool 4');
  });

  it('【故意造出失败】没登记（没写、空）不当成「不限」', () => {
    for (const raw of [undefined, '', '  ']) {
      const v = judgeCarpoolCap({ raw, pools });
      expect(v, String(raw)).toMatchObject({ ok: false, code: 'unregistered' });
      expect(!v.ok && v.why).toContain(CARPOOL_CAP_ENV);
    }
  });

  it('【故意造出失败】写坏了（不是正整数）', () => {
    for (const raw of ['0', '-1', '四', '2.5', '4 个', '1e1']) {
      expect(judgeCarpoolCap({ raw, pools }), raw).toMatchObject({ ok: false, code: 'bad_value' });
    }
  });

  it('【故意造出失败】库里一个拼车池都没有：核不了，不当成上限 0 也不当成对上', () => {
    expect(judgeCarpoolCap({ raw: '4', pools: [] })).toMatchObject({ ok: false, code: 'no_carpool_pool' });
  });
});

describe('checkCarpoolCap：接真库，推提醒、对上了撤', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  }, TEST_DB_TIMEOUT_MS);
  afterAll(() => t.close());
  beforeEach(async () => {
    await resetTestDb(t);
    await world(t.db);
    // 真实的样子：独享池挂独享组织，只剩 claude-carpool（上限 3）一个拼车池
    await t.client.query("update pools set org_kind = 'solo' where id = 'claude-solo'");
  });
  const logs: string[] = [];
  const check = (raw: string | undefined) =>
    checkCarpoolCap({
      db: t.db,
      env: raw === undefined ? {} : { [CARPOOL_CAP_ENV]: raw },
      machine: '法国',
      log: (level, text) => void logs.push(`${level}:${text}`),
    });
  const alert = async () =>
    (await t.db.select().from(notifications)).find((n) => n.dedupeKey === CARPOOL_CAP_ALERT);

  it('对不上推提醒（带机器名），改对后再起来自己撤', async () => {
    expect(await check('4')).toMatchObject({ ok: false, code: 'mismatch' });
    expect(await alert()).toMatchObject({ level: 'alert', resolvedAt: null });
    expect((await alert())?.title).toContain('法国');
    expect(logs.at(-1)).toMatch(/^error:拼车并发上限和登记的对不上（mismatch）/);
    expect(await check('3')).toMatchObject({ ok: true, registered: 3 });
    expect((await alert())?.resolvedAt).not.toBeNull();
    expect((await alert())?.body).toMatch(/^已撤：/);
  });

  it('【故意造出失败】没登记：推提醒，不静默', async () => {
    expect(await check(undefined)).toMatchObject({ ok: false, code: 'unregistered' });
    expect(await alert()).toMatchObject({ level: 'alert', resolvedAt: null });
  });

  it('【故意造出失败】库里没有拼车池：推提醒', async () => {
    await t.client.query("update pools set org_kind = null, run_as_user = null where id = 'claude-carpool'");
    expect(await check('3')).toMatchObject({ ok: false, code: 'no_carpool_pool' });
    expect(await alert()).toMatchObject({ level: 'alert', resolvedAt: null });
  });

  it('【故意造出失败】pools 读不了：照常抛，不报「对上了」也不静默', async () => {
    await t.client.exec('alter table pools rename to pools_unreadable');
    try {
      await expect(check('3')).rejects.toThrow();
    } finally {
      await t.client.exec('alter table pools_unreadable rename to pools');
    }
    expect(await alert()).toBeUndefined();
  });
});
