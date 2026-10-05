// 引擎总开关（#1086）：设置表里 engine.master 那一行。认不认得出、没设过算关由 shared 的 engineMasterOf 判；这里只管读。
// 引擎的闸门（engine/src/engine-master.ts）和命令行、驾驶舱读的是同一行同一个读法。
import { ENGINE_MASTER_SETTING, type MasterSettingRow } from '@fleet-dao/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { settings } from '../schema/index.ts';

/** 没设过 = null；设过给值、谁改的、什么时候改的（ISO）。库读不了照抛，调用方按「读不到」处理，不当成没设过。 */
export async function readEngineMasterRow(db: Db): Promise<MasterSettingRow | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, ENGINE_MASTER_SETTING));
  if (!row) return null;
  return { value: row.value, updatedBy: row.updatedBy, updatedAt: row.updatedAt.toISOString() };
}
