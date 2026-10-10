// 引擎总开关（#1086）：设置表里 engine.master 那一行。认不认得出、没设过算关由 shared 的 engineMasterOf 判；这里只管读。
// 引擎的闸门（engine/src/engine-master.ts）和命令行、驾驶舱读的是同一行同一个读法。
// #1732：看门狗自动开回发版卡住时，同一事务里锁行、再核最近一笔操作记录、带 version 条件写回，避免覆盖人工停派。
import {
  ENGINE_MASTER_DISABLE,
  ENGINE_MASTER_ENABLE,
  ENGINE_MASTER_RELEASE_PAUSE_HINT,
  ENGINE_MASTER_SETTING,
  type EngineMasterAuditRow,
  engineMasterOf,
  type MasterSettingRow,
} from '@fleet-dao/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { auditLog, settings } from '../schema/index.ts';

const MASTER_AUDIT_TARGET = `setting:${ENGINE_MASTER_SETTING}`;

/** 没设过 = null；设过给值、谁改的、什么时候改的（ISO）。库读不了照抛，调用方按「读不到」处理，不当成没设过。 */
export async function readEngineMasterRow(db: Db): Promise<MasterSettingRow | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, ENGINE_MASTER_SETTING));
  if (!row) return null;
  return { value: row.value, updatedBy: row.updatedBy, updatedAt: row.updatedAt.toISOString() };
}

/** 最近一笔总开关开/关操作记录（按时间倒序）；没有是 null。 */
export async function latestEngineMasterAudit(db: Db): Promise<EngineMasterAuditRow | null> {
  const [row] = await db
    .select({
      action: auditLog.action,
      reason: auditLog.reason,
      at: auditLog.at,
    })
    .from(auditLog)
    .where(eq(auditLog.target, MASTER_AUDIT_TARGET))
    .orderBy(desc(auditLog.at))
    .limit(1);
  if (!row) return null;
  return { action: row.action, reason: row.reason, at: row.at };
}

/**
 * 把总开关写成开着并记一条 enable（看门狗自动开回 #1732）。
 * 同一事务：锁设置行 → 再读最近一笔审计 → 仍是 expectDisableAt 那笔发版前暂停才写；
 * 更新带 version 条件，对不上回 conflict；人又关了或审计变了回 skipped。
 */
export async function enableEngineMasterStuck(
  db: Db,
  input: { by: string; reason: string; at?: Date; expectDisableAt: Date },
): Promise<'enabled' | 'already_on' | 'conflict' | 'skipped'> {
  const at = input.at ?? new Date();
  const expectMs = input.expectDisableAt.getTime();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(settings)
      .where(eq(settings.key, ENGINE_MASTER_SETTING))
      .for('update');
    const before = engineMasterOf(
      row ? { value: row.value, updatedBy: row.updatedBy, updatedAt: row.updatedAt.toISOString() } : null,
    );
    if (before.on) return 'already_on';

    const [latest] = await tx
      .select({
        action: auditLog.action,
        reason: auditLog.reason,
        at: auditLog.at,
      })
      .from(auditLog)
      .where(eq(auditLog.target, MASTER_AUDIT_TARGET))
      .orderBy(desc(auditLog.at))
      .limit(1);
    if (
      !latest ||
      latest.action !== ENGINE_MASTER_DISABLE ||
      latest.at.getTime() !== expectMs ||
      !(latest.reason ?? '').includes(ENGINE_MASTER_RELEASE_PAUSE_HINT)
    ) {
      return 'skipped';
    }

    if (!row) {
      await tx.insert(settings).values({
        key: ENGINE_MASTER_SETTING,
        value: true,
        updatedBy: input.by,
        updatedAt: at,
      });
    } else {
      const updated = await tx
        .update(settings)
        .set({
          value: true,
          updatedBy: input.by,
          updatedAt: at,
          version: sql`${settings.version} + 1`,
        })
        .where(and(eq(settings.key, ENGINE_MASTER_SETTING), eq(settings.version, row.version)))
        .returning({ key: settings.key });
      if (updated.length === 0) return 'conflict';
    }
    await tx.insert(auditLog).values({
      at,
      actorKind: 'engine',
      actorId: input.by,
      action: ENGINE_MASTER_ENABLE,
      target: MASTER_AUDIT_TARGET,
      before: row?.value ?? null,
      after: true,
      reason: input.reason,
      via: 'engine',
      ok: true,
    });
    return 'enabled';
  });
}
