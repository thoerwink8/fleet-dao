// 引擎总开关从库里读的那一行（queries/engine-master.ts）：设置表 engine.master。认不认得出由 shared 的 engineMasterOf 判，这里只管读。
import { ENGINE_MASTER_SETTING, engineMasterOf } from '@fleet-dao/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readEngineMasterRow } from '../src/queries/engine-master.ts';
import { settings } from '../src/schema/index.ts';
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
