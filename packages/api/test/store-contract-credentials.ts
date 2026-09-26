// Store 契约：账密登录那几列（#120）。内存版和 Postgres 版过同一套（store.memory.test.ts / store.pg.test.ts 调）。
import { beforeEach, describe, expect, it } from 'vitest';
import { DEV_USER_ID, devFixtures, IDS } from '../src/dev-fixtures.ts';
import type { NewAuditEntry, Store } from '../src/ports.ts';
import { type MakeStore, T0 } from './store-contract.ts';

const MIN = 60_000;
const OTHER_UUID = '99999999-0000-4000-8000-000000000000';
const HASH = 'scrypt$32768$8$3$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g';

const audit = (over: Partial<NewAuditEntry> = {}): NewAuditEntry => ({
  actor: { kind: 'user', id: DEV_USER_ID },
  action: 'credentials.set',
  target: `user:${DEV_USER_ID}`,
  via: 'cockpit',
  ok: true,
  ...over,
});

export function describeCredentialsStoreContract(name: string, make: MakeStore): void {
  describe(`Store 契约（账密）：${name}`, () => {
    let store: Store;
    const clock = { now: new Date(T0) };
    beforeEach(async () => {
      clock.now = new Date(T0);
      store = (await make(devFixtures(T0), clock)).store;
    });

    const fail = (at = clock.now) =>
      store.recordPasswordFailure({ userId: DEV_USER_ID, at, maxFails: 5, lockMs: 15 * MIN });

    it('没设过：计数 0、没有用户名和哈希；没这个人（含编号不是 uuid）是 null', async () => {
      expect(await store.getPasswordCredentials(DEV_USER_ID)).toMatchObject({
        userId: DEV_USER_ID,
        failedLogins: 0,
      });
      const creds = await store.getPasswordCredentials(DEV_USER_ID);
      expect(creds?.username).toBeUndefined();
      expect(creds?.passwordHash).toBeUndefined();
      expect(creds?.lockedUntil).toBeUndefined();
      expect(await store.getPasswordCredentials(OTHER_UUID)).toBeNull();
      expect(await store.getPasswordCredentials('not-a-uuid')).toBeNull();
      expect(
        await store.recordPasswordFailure({ userId: OTHER_UUID, at: T0, maxFails: 5, lockMs: MIN }),
      ).toBeNull();
    });

    it('设了之后按用户名（大小写不敏感）找得到人；读回哈希和改密时间；操作记录同时写进去', async () => {
      const at = new Date(T0.getTime() + MIN);
      expect(
        await store.setPasswordCredentials(
          { userId: DEV_USER_ID, username: 'Founder-A', passwordHash: HASH, at },
          audit(),
        ),
      ).toBe('ok');
      expect((await store.findUserByUsername('founder-a'))?.id).toBe(DEV_USER_ID);
      expect((await store.findUserByUsername('FOUNDER-A'))?.id).toBe(DEV_USER_ID);
      expect(await store.findUserByUsername('founder-b')).toBeNull();
      expect(await store.getPasswordCredentials(DEV_USER_ID)).toMatchObject({
        username: 'Founder-A',
        passwordHash: HASH,
        passwordChangedAt: at.toISOString(),
      });
      const { items } = await store.listAudit({ target: `user:${DEV_USER_ID}`, limit: 10 });
      expect(items.map((a) => a.action)).toEqual(['credentials.set']);
    });

    it('只改用户名：哈希和改密时间不动', async () => {
      await store.setPasswordCredentials(
        { userId: DEV_USER_ID, username: 'a-name', passwordHash: HASH, at: T0 },
        audit(),
      );
      await store.setPasswordCredentials(
        { userId: DEV_USER_ID, username: 'b-name', at: new Date(T0.getTime() + MIN) },
        audit(),
      );
      expect(await store.getPasswordCredentials(DEV_USER_ID)).toMatchObject({
        username: 'b-name',
        passwordHash: HASH,
        passwordChangedAt: T0.toISOString(),
      });
      expect(await store.findUserByUsername('a-name')).toBeNull();
    });

    it('用户名被别人占了（大小写不同也算）：username_taken，什么都不改、不留记录', async () => {
      await store.setPasswordCredentials({ userId: IDS.founderB, username: 'Shared', at: T0 }, audit());
      expect(
        await store.setPasswordCredentials(
          { userId: DEV_USER_ID, username: 'shared', passwordHash: HASH, at: T0 },
          audit({ action: 'x.taken' }),
        ),
      ).toBe('username_taken');
      expect((await store.getPasswordCredentials(DEV_USER_ID))?.passwordHash).toBeUndefined();
      const { items } = await store.listAudit({ limit: 50 });
      expect(items.some((a) => a.action === 'x.taken')).toBe(false);
      // 自己占着的名字再写一遍不算撞
      expect(
        await store.setPasswordCredentials({ userId: IDS.founderB, username: 'SHARED', at: T0 }, audit()),
      ).toBe('ok');
    });

    it('没这个人：not_found', async () => {
      expect(
        await store.setPasswordCredentials({ userId: OTHER_UUID, username: 'x-name', at: T0 }, audit()),
      ).toBe('not_found');
      expect(
        await store.setPasswordCredentials({ userId: 'nope', username: 'x-name', at: T0 }, audit()),
      ).toBe('not_found');
    });

    it('操作记录写不进（ok=false 没带原因）：改动一起回滚', async () => {
      await expect(
        store.setPasswordCredentials(
          { userId: DEV_USER_ID, username: 'rollback', passwordHash: HASH, at: T0 },
          audit({ ok: false }),
        ),
      ).rejects.toThrow();
      expect((await store.getPasswordCredentials(DEV_USER_ID))?.passwordHash).toBeUndefined();
      expect(await store.findUserByUsername('rollback')).toBeNull();
    });

    it('有密码没用户名：拒（库里是约束 users_password_needs_username）', async () => {
      await expect(
        store.setPasswordCredentials({ userId: DEV_USER_ID, passwordHash: HASH, at: T0 }, audit()),
      ).rejects.toThrow();
      expect((await store.getPasswordCredentials(DEV_USER_ID))?.passwordHash).toBeUndefined();
    });

    it('输错：第 5 次锁到 at+锁期、计数清零；锁着时再错不变；过期后从 1 算；登录成功清零', async () => {
      await store.setPasswordCredentials(
        { userId: DEV_USER_ID, username: 'lock-me', passwordHash: HASH, at: T0 },
        audit(),
      );
      for (let i = 1; i <= 4; i++) {
        expect(await fail()).toEqual({ lockedUntil: undefined });
        expect((await store.getPasswordCredentials(DEV_USER_ID))?.failedLogins).toBe(i);
      }
      const until = new Date(T0.getTime() + 15 * MIN).toISOString();
      expect(await fail()).toEqual({ lockedUntil: until });
      expect(await store.getPasswordCredentials(DEV_USER_ID)).toMatchObject({
        failedLogins: 0,
        lockedUntil: until,
      });

      expect(await fail(new Date(T0.getTime() + MIN))).toEqual({ lockedUntil: until });
      expect((await store.getPasswordCredentials(DEV_USER_ID))?.failedLogins).toBe(0);

      expect(await fail(new Date(T0.getTime() + 16 * MIN))).toEqual({ lockedUntil: undefined });
      expect(await store.getPasswordCredentials(DEV_USER_ID)).toMatchObject({ failedLogins: 1 });
      expect((await store.getPasswordCredentials(DEV_USER_ID))?.lockedUntil).toBeUndefined();

      await fail(new Date(T0.getTime() + 17 * MIN));
      await store.recordPasswordSuccess(DEV_USER_ID);
      expect((await store.getPasswordCredentials(DEV_USER_ID))?.failedLogins).toBe(0);
    });

    it('设密码把计数和锁清零（root 用 set-password 就能解锁）', async () => {
      await store.setPasswordCredentials(
        { userId: DEV_USER_ID, username: 'lock-me', passwordHash: HASH, at: T0 },
        audit(),
      );
      for (let i = 0; i < 5; i++) await fail();
      expect((await store.getPasswordCredentials(DEV_USER_ID))?.lockedUntil).toBeDefined();
      await store.setPasswordCredentials({ userId: DEV_USER_ID, passwordHash: HASH, at: T0 }, audit());
      const creds = await store.getPasswordCredentials(DEV_USER_ID);
      expect(creds?.lockedUntil).toBeUndefined();
      expect(creds?.failedLogins).toBe(0);
    });
  });
}
