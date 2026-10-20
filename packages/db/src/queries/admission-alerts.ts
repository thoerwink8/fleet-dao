// 独立的准入未知通知移交；不刷新既有通知、不重开、不声称渠道已送达。
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../client.ts';
import { notifications } from '../schema/index.ts';

const text = (max: number) =>
  z
    .string()
    .min(1)
    .refine((s) => Buffer.byteLength(s) <= max);
export const AdmissionAlertIdentitySchema = z.strictObject({
  version: z.literal(1),
  category: z.literal('legacy_admission_unknown'),
  namespace: text(1024),
  workflowId: text(1024),
  runId: z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
});
export const AdmissionAlertCodeSchema = z.enum([
  'cancelled',
  'deadline',
  'capacity',
  'input_limit',
  'protocol',
  'child_failed',
  'cleanup_pending',
  'store_unavailable',
  'missing_context',
  'invalid_activity_context',
  'unsupported_schema',
  'canonical_failed',
  'start_unavailable',
  'start_invalid_context',
  'start_cancelled',
  'start_deadline',
  'start_not_found',
  'start_limit',
  'start_malformed_history',
  'start_identity_conflict',
  'start_unsupported_encoding',
  'start_decode_failed',
]);
export const AdmissionAlertObservationSchema = z.strictObject({
  identity: AdmissionAlertIdentitySchema,
  firstCode: AdmissionAlertCodeSchema,
});
export type AdmissionAlertIdentity = z.infer<typeof AdmissionAlertIdentitySchema>;
export type AdmissionAlertObservation = z.infer<typeof AdmissionAlertObservationSchema>;
export const ADMISSION_ALERT_PREFIX = 'admission-unknown:v1:';
export const ADMISSION_ALERT_TITLE = '旧运行准入状态未知，责任待核实';

export function admissionAlertIdentityJson(input: AdmissionAlertIdentity): string {
  const i = AdmissionAlertIdentitySchema.parse(input);
  return JSON.stringify({
    version: i.version,
    category: i.category,
    namespace: i.namespace,
    workflowId: i.workflowId,
    runId: i.runId,
  });
}
export function admissionAlertKey(input: AdmissionAlertIdentity): string {
  return createHash('sha256').update(admissionAlertIdentityJson(input)).digest('hex');
}
export function admissionAlertJson(input: AdmissionAlertObservation): string {
  const o = AdmissionAlertObservationSchema.parse(input);
  return JSON.stringify({
    identity: JSON.parse(admissionAlertIdentityJson(o.identity)),
    firstCode: o.firstCode,
  });
}
export function admissionAlertRecordHash(input: AdmissionAlertObservation): string {
  return createHash('sha256').update(admissionAlertJson(input)).digest('hex');
}

/** 调用方在独立有界宿主事务内执行，COMMIT 和连接关闭后才能删除本地 pending。 */
export async function insertAdmissionUnknownAlertOnce(
  db: Db,
  input: AdmissionAlertObservation,
): Promise<
  | { kind: 'persisted'; notificationId: string }
  | { kind: 'unknown'; code: 'notification_conflict' | 'store_unavailable' }
> {
  const o = AdmissionAlertObservationSchema.parse(input);
  const dedupeKey = ADMISSION_ALERT_PREFIX + admissionAlertKey(o.identity);
  // READ COMMITTED 冲突后持有者可能删除；只作有限重读，空 RETURNING 不是成功。
  for (let attempt = 0; attempt < 4; attempt++) {
    await db
      .insert(notifications)
      .values({
        dedupeKey,
        level: 'alert',
        taskId: null,
        repoId: null,
        title: ADMISSION_ALERT_TITLE,
        body: admissionAlertJson(o),
        link: null,
      })
      .onConflictDoNothing({ target: notifications.dedupeKey });
    const [row] = await db.select().from(notifications).where(eq(notifications.dedupeKey, dedupeKey));
    if (!row) continue;
    let stored: AdmissionAlertObservation;
    try {
      stored = AdmissionAlertObservationSchema.parse(JSON.parse(row.body));
    } catch {
      return { kind: 'unknown', code: 'notification_conflict' };
    }
    if (
      row.level !== 'alert' ||
      row.taskId !== null ||
      row.repoId !== null ||
      row.title !== ADMISSION_ALERT_TITLE ||
      row.link !== null ||
      row.body !== admissionAlertJson(stored) ||
      admissionAlertIdentityJson(stored.identity) !== admissionAlertIdentityJson(o.identity)
    )
      return { kind: 'unknown', code: 'notification_conflict' };
    // 首码是第一次观察，不是全局 identity；这里绝不比较/覆盖后来重建的本地首码。
    return { kind: 'persisted', notificationId: row.id };
  }
  return { kind: 'unknown', code: 'store_unavailable' };
}
