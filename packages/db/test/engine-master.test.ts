// 引擎总开关从库里读的那一行（queries/engine-master.ts）：设置表 engine.master。认不认得出由 shared 的 engineMasterOf 判，这里只管读。
// #1732：enableEngineMasterStuck 同一事务再核审计 + version 条件。
import {
  ENGINE_MASTER_DISABLE,
  ENGINE_MASTER_ENABLE,
  ENGINE_MASTER_SETTING,
  engineMasterOf,
} from '@fleet-dao/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  enableEngineMasterStuck,
  latestEngineMasterAudit,
  readEngineMasterRow,
} from '../src/queries/engine-master.ts';
import { auditLog, settings } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

describe('读总开关（readEngineMasterRow）', () => {
  it('没设过：null，按 engineMasterOf 是「关，从没设过」（默认关）', async () => {
    const row = await readEngineMasterRow(t.db);
    expect(row).toBeNull();
    expect(engineMasterOf(row)).toEqual({ on: false, why: 'never_set' });
  });

  it('设成 true：开，带谁改的、什么时候改的（ISO）', async () => {
    const at = new Date('2026-10-05T13:00:00.000Z');
    await t.db.insert(settings).values({
      key: ENGINE_MASTER_SETTING,
      value: true,
      version: 1,
      updatedAt: at,
      updatedBy: 'user:frank',
    });
    const row = await readEngineMasterRow(t.db);
    expect(row).toEqual({ value: true, updatedBy: 'user:frank', updatedAt: at.toISOString() });
    expect(engineMasterOf(row)).toEqual({ on: true, by: 'user:frank', at: at.toISOString() });
  });

  it('设成 false：关，why 是 set；值不是布尔：关，why 是 unreadable（不拿它当开）', async () => {
    await t.db
      .insert(settings)
      .values({ key: ENGINE_MASTER_SETTING, value: false, version: 1, updatedBy: 'ops:engine' });
    expect(engineMasterOf(await readEngineMasterRow(t.db))).toMatchObject({
      on: false,
      why: 'set',
      by: 'ops:engine',
    });
    await t.db.delete(settings);
    await t.db.insert(settings).values({ key: ENGINE_MASTER_SETTING, value: 'yes', version: 1 });
    expect(engineMasterOf(await readEngineMasterRow(t.db))).toEqual({ on: false, why: 'unreadable' });
  });
});

describe('enableEngineMasterStuck（#1732）', () => {
  const disableAt = new Date('2026-10-10T06:00:00.000Z');

  async function seedStuck() {
    await t.db.insert(settings).values({
      key: ENGINE_MASTER_SETTING,
      value: false,
      version: 3,
      updatedAt: disableAt,
      updatedBy: 'ops:engine',
    });
    await t.db.insert(auditLog).values({
      at: disableAt,
      actorKind: 'engine',
      actorId: 'ops:engine',
      action: ENGINE_MASTER_DISABLE,
      target: `setting:${ENGINE_MASTER_SETTING}`,
      before: true,
      after: false,
      reason: '发版前暂停（驾驶舱点击发布，目标 6ae542cc8c43）',
      via: 'engine',
      ok: true,
    });
  }

  it('发版前暂停卡住：开回并记 enable', async () => {
    await seedStuck();
    const at = new Date('2026-10-10T08:00:00.000Z');
    await expect(
      enableEngineMasterStuck(t.db, {
        by: 'engine:master-restore',
        reason: '看门狗自动开回（#1732）',
        at,
        expectDisableAt: disableAt,
      }),
    ).resolves.toBe('enabled');
    expect(engineMasterOf(await readEngineMasterRow(t.db)).on).toBe(true);
    const latest = await latestEngineMasterAudit(t.db);
    expect(latest?.action).toBe(ENGINE_MASTER_ENABLE);
    expect(latest?.reason).toContain('#1732');
  });

  it('判断后人工又关了（审计时刻对不上）：skipped，不开', async () => {
    await seedStuck();
    const humanAt = new Date('2026-10-10T07:30:00.000Z');
    await t.db.insert(auditLog).values({
      at: humanAt,
      actorKind: 'user',
      actorId: 'user:founder',
      action: ENGINE_MASTER_DISABLE,
      target: `setting:${ENGINE_MASTER_SETTING}`,
      before: false,
      after: false,
      reason: '今晚先停派活',
      via: 'cockpit',
      ok: true,
    });
    await expect(
      enableEngineMasterStuck(t.db, {
        by: 'engine:master-restore',
        reason: '看门狗自动开回（#1732）',
        expectDisableAt: disableAt,
      }),
    ).resolves.toBe('skipped');
    expect(engineMasterOf(await readEngineMasterRow(t.db)).on).toBe(false);
  });

  it('已经开着：already_on', async () => {
    await t.db.insert(settings).values({
      key: ENGINE_MASTER_SETTING,
      value: true,
      version: 1,
      updatedBy: 'ops:engine',
    });
    await expect(
      enableEngineMasterStuck(t.db, {
        by: 'engine:master-restore',
        reason: 'x',
        expectDisableAt: disableAt,
      }),
    ).resolves.toBe('already_on');
  });
});
