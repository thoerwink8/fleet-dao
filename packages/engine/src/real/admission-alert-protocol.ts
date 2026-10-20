import { AdmissionAlertObservationSchema } from '@fleet-dao/db';
import { z } from 'zod';

export const ALERT_TOTAL_MS = 10_000;
export const ALERT_CLEANUP_MS = 1_000;
export const ALERT_DTO_BYTES = 4096;
export const ALERT_FRAME_BYTES = 24 * 1024;
export const AlertUnknownCodeSchema = z.enum([
  'cancelled',
  'deadline',
  'capacity',
  'input_limit',
  'protocol',
  'child_failed',
  'cleanup_pending',
  'store_unavailable',
  'notification_conflict',
  'busy',
  'corrupt',
  'private_path',
  'io',
  'unsupported',
]);
export const AlertObservationSchema = AdmissionAlertObservationSchema.refine(
  (v) => Buffer.byteLength(JSON.stringify(v)) <= ALERT_DTO_BYTES,
);
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
export const AlertOutcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('spooled'), key: hex, recordHash: hex }),
  z.strictObject({ kind: z.literal('transferred'), key: hex, recordHash: hex, notificationId: uuid }),
  z.strictObject({ kind: z.literal('empty') }),
  z.strictObject({ kind: z.literal('unknown'), code: AlertUnknownCodeSchema }),
]);
const common = {
  version: z.literal(1),
  id: uuid,
  spoolPath: z.string().min(1).max(4096),
  killAt: z.number().int().positive(),
  budgetMs: z.number().int().min(1).max(ALERT_TOTAL_MS),
};
export const AlertRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ ...common, operation: z.literal('record'), observation: AlertObservationSchema }),
  z.strictObject({
    ...common,
    operation: z.literal('transferOne'),
    databaseUrl: z.string().min(1).max(16384),
  }),
]);
export const AlertResponseSchema = z.strictObject({
  version: z.literal(1),
  id: uuid,
  result: AlertOutcomeSchema,
});
export type AlertRequest = z.infer<typeof AlertRequestSchema>;
export type AlertOutcome = z.infer<typeof AlertOutcomeSchema>;
export type AlertUnknownCode = z.infer<typeof AlertUnknownCodeSchema>;
export interface AlertCallOptions {
  signal: AbortSignal;
  deadlineAt: number;
}
