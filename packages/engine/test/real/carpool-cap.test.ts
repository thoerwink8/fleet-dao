// 引擎起来核拼车并发上限和登记的对不对得上（real/carpool-cap.ts，#194 方案 4.7）：对不上、没登记、写坏了、库里没有拼车池，
// 每一条都故意造一次——一律推 carpool-cap:registry 提醒、不当成「没配就不限」；对上了自己撤；库读不了照常抛。
import { randomUUID } from 'node:crypto';
import { notifications } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CARPOOL_CAP_ALERT,
  CARPOOL_CAP_ENV,
  carpoolRegistry,
  checkCarpoolCap,
  judgeCarpoolCap,
} from '../../src/real/carpool-cap.ts';
import { createStorePorts } from '../../src/real/store-ports.ts';
import type { CarpoolRegistryView } from '../../src/routing/index.ts';
import { NOW, world } from './fixtures.ts';

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

describe('核对不上选路不往拼车池派（#896）：carpoolRegistry().view() 接进真选路', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  }, TEST_DB_TIMEOUT_MS);
  afterAll(() => t.close());
  beforeEach(async () => {
    await resetTestDb(t);
    // 拼车路由排第一、别家（relay 池）排第二：核对不上时拼车让开、活派给别家；独享池只剩 claude-carpool（上限 3）一个拼车池
    await world(t.db, { order: ['carpool', 'luna'], stages: ['execute'] });
    await t.client.query("update pools set org_kind = 'solo' where id = 'claude-solo'");
  });

  const reg = (raw: string | undefined) =>
    carpoolRegistry({
      db: t.db,
      env: raw === undefined ? {} : { [CARPOOL_CAP_ENV]: raw },
      machine: '法国',
      log: () => {},
    });
  const ports = (registry?: () => Promise<CarpoolRegistryView>) =>
    createStorePorts({
      db: t.db,
      now: () => NOW,
      draw: () => 0.5,
      log: () => {},
      sessionOrg: async () => ({ ok: true, org: 'carpool' }),
      // 别家的路由（luna 走 codex）要这个执行方式接上才算得进来
      wiredHosts: ['claude-code', 'codex'],
      ...(registry ? { carpoolRegistry: registry } : {}),
    });
  const pick = (p: ReturnType<typeof ports>) =>
    p.pickRoute(
      {
        taskId: randomUUID(),
        stage: 'execute',
        avoidRouteIds: [],
        avoidPoolIds: [],
        avoidModelIds: [],
      },
      { signal: new AbortController().signal, heartbeat() {}, attempt: 1, lastHeartbeat: undefined },
    );
  const alert = async () =>
    (await t.db.select().from(notifications)).find((n) => n.dedupeKey === CARPOOL_CAP_ALERT);

  it('对上了：派拼车（排第一）；没接核对（单测）也照常派，不是「对上了」之外的另一种行为', async () => {
    const r = reg('3');
    expect(await pick(ports(() => r.view()))).toMatchObject({ ok: true, route: { routeId: 'carpool' } });
    expect(await alert()).toBeUndefined();
    expect(await pick(ports())).toMatchObject({ ok: true, route: { routeId: 'carpool' } });
  });

  it('【故意造出失败】对不上：不派拼车、派给别家，派工理由写明；推提醒；库里的上限改对后下一次选路自己恢复、提醒自己撤（不用重启）', async () => {
    const r = reg('4');
    const p = ports(() => r.view());
    const first = await pick(p);
    expect(first).toMatchObject({ ok: true, route: { routeId: 'luna' } });
    expect(first.ok && first.why).toContain('拼车并发登记核对不上');
    expect(first.ok && first.why).toContain('登记的拼车并发上限是 4');
    expect(await alert()).toMatchObject({ level: 'alert', resolvedAt: null });
    // 目录配置重装、拼车池的上限改成 4：对上了
    await t.client.query("update pools set max_concurrency = 4 where id = 'claude-carpool'");
    expect(await pick(p)).toMatchObject({ ok: true, route: { routeId: 'carpool' } });
    expect((await alert())?.resolvedAt).not.toBeNull();
  });

  it('【故意造出失败】没登记：不派拼车、推提醒', async () => {
    const p = ports(() => reg(undefined).view());
    const r = await pick(p);
    expect(r).toMatchObject({ ok: true, route: { routeId: 'luna' } });
    expect(r.ok && r.why).toContain(CARPOOL_CAP_ENV);
    expect(await alert()).toMatchObject({ level: 'alert', resolvedAt: null });
  });

  it('【故意造出失败】写坏了：不派拼车', async () => {
    expect(await pick(ports(() => reg('四').view()))).toMatchObject({ ok: true, route: { routeId: 'luna' } });
  });

  it('【故意造出失败】库里没有拼车池：登记了也核不了，交回 ok:false 写明原因（不当成对上了）', async () => {
    await t.client.query("update pools set org_kind = 'solo' where id = 'claude-carpool'");
    const v = await reg('3').view();
    expect(v).toMatchObject({ ok: false });
    expect(!v.ok && v.why).toContain('库里没有带组织类型 carpool 的池');
  });

  it('【故意造出失败】核对本身读不出（库里的池读不了）：不抛、不当成对上了——拼车池按「核对没读成」不派，不拿它顶', async () => {
    const r = reg('3');
    await t.client.exec('alter table pools rename to pools_unreadable');
    try {
      const v = await r.view();
      expect(v.ok).toBe(false);
      expect(!v.ok && v.why).toContain('没核成');
    } finally {
      await t.client.exec('alter table pools_unreadable rename to pools');
    }
    // 读得了、对上了：恢复
    expect(await r.view()).toEqual({ ok: true });
  });

  it('人把提醒点掉不放开拼车：核对还是对不上就还是不派（开关是现核的结论，不是提醒开没开）', async () => {
    const r = reg('4');
    expect(await r.view()).toMatchObject({ ok: false });
    await t.client.query(
      "update notifications set resolved_at = now() where dedupe_key = 'carpool-cap:registry'",
    );
    expect(await r.view()).toMatchObject({ ok: false });
    expect(await pick(ports(() => r.view()))).toMatchObject({ ok: true, route: { routeId: 'luna' } });
  });

  it('提醒推不出去（notifications 写不进）：只记日志，选路结论照样是不派拼车', async () => {
    const logs: string[] = [];
    const r = carpoolRegistry({
      db: t.db,
      env: { [CARPOOL_CAP_ENV]: '4' },
      machine: '法国',
      log: (level, text) => void logs.push(`${level}:${text}`),
    });
    await t.client.exec('alter table notifications rename to notifications_unwritable');
    try {
      expect(await r.view()).toMatchObject({ ok: false });
    } finally {
      await t.client.exec('alter table notifications_unwritable rename to notifications');
    }
    expect(logs.some((l) => l.includes('提醒没推、撤成'))).toBe(true);
    // 提醒没推成不记成「已经推过」：下一次再试，这次推得出去
    expect(await r.view()).toMatchObject({ ok: false });
    expect(await alert()).toMatchObject({ resolvedAt: null });
  });
});
