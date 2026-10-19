// 单次可信子进程的封闭协议；不把 Start 正文、连接串或驱动异常放进结果。
import type { AdmissionWarning, LegacyExecutionIdentityV1 } from '@fleet-dao/store';
import { z } from 'zod';

export const LEGACY_ADMISSION_TOTAL_MS = 10_000;
export const LEGACY_ADMISSION_CLEANUP_MS = 1_000;
// 容纳 2MiB Start 的 canonical 最坏转义，再容纳外层 JSON 对字符串的第二次转义。
export const LEGACY_CANONICAL_MAX_BYTES = 2 * 1024 * 1024 * 6;
export const LEGACY_REQUEST_MAX_BYTES = 2 * LEGACY_CANONICAL_MAX_BYTES + 64 * 1024;
export const LEGACY_RESULT_MAX_BYTES = 4 * 1024;

const text = (bytes: number) =>
  z
    .string()
    .min(1)
    .refine((value) => Buffer.byteLength(value) <= bytes);
// 与现有 Store 的规范UUID合同一致，不额外缩到某个UUID版本。
const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
export const LegacyIdentitySchema = z.strictObject({
  schemaVersion: z.literal(1),
  taskId: uuid,
  namespace: text(1024),
  workflowId: text(1024),
  runId: uuid,
  workflowType: z.literal('taskWorkflow'),
  taskQueue: text(1024),
  generation: z.number().int().min(1).max(20),
  inputCanonical: text(LEGACY_CANONICAL_MAX_BYTES),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const AuditSchema = z.strictObject({
  actor: z.strictObject({
    kind: z.enum(['user', 'ai', 'engine', 'agent', 'ops']),
    id: text(4096),
  }),
  via: z.enum(['cockpit', 'feishu', 'github', 'engine', 'agent', 'ops']),
  reason: z
    .string()
    .max(16 * 1024)
    .optional(),
});
export const LegacyRequestSchema = z.strictObject({
  version: z.literal(1),
  id: uuid,
  databaseUrl: text(16 * 1024),
  killAt: z.number().int().positive().max(8_640_000_000_000_000),
  budgetMs: z.number().int().min(1).max(LEGACY_ADMISSION_TOTAL_MS),
  input: LegacyIdentitySchema,
  audit: AuditSchema,
});
export type LegacyRequest = z.infer<typeof LegacyRequestSchema>;
export const LegacySqlUnknownCodeSchema = z.enum([
  'cancelled',
  'deadline',
  'capacity',
  'input_limit',
  'protocol',
  'child_failed',
  'cleanup_pending',
  'store_unavailable',
]);
export type LegacySqlUnknownCode = z.infer<typeof LegacySqlUnknownCodeSchema>;
export const LegacySqlOutcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('allowed'),
    status: z.enum(['admitted', 'replayed']),
    admissionId: uuid,
    postCommitWarnings: z
      .array(
        z.strictObject({
          code: z.literal('notification_failed'),
          table: z.enum(['tasks', 'audit_log']),
          id: text(256),
        }),
      )
      .max(16),
  }),
  z.strictObject({
    kind: z.literal('denied'),
    code: z.enum(['not_found', 'invalid_identity', 'identity_conflict', 'managed_requires_operation']),
  }),
  z.strictObject({ kind: z.literal('unknown'), code: LegacySqlUnknownCodeSchema }),
]);
export type LegacySqlOutcome =
  | {
      kind: 'allowed';
      status: 'admitted' | 'replayed';
      admissionId: string;
      postCommitWarnings: readonly AdmissionWarning[];
    }
  | Extract<z.infer<typeof LegacySqlOutcomeSchema>, { kind: 'denied' | 'unknown' }>;
export const LegacyResponseSchema = z.strictObject({
  version: z.literal(1),
  id: uuid,
  result: LegacySqlOutcomeSchema,
});
/** deadlineAt是同一父进程performance.now()的绝对期限，不是Date.now()。 */
export interface LegacySqlCallOptions {
  signal: AbortSignal;
  deadlineAt: number;
}
export type BoundedLegacyAdmission = (
  input: LegacyExecutionIdentityV1,
  audit: LegacyRequest['audit'],
  options: LegacySqlCallOptions,
) => Promise<LegacySqlOutcome>;

/** 四字节长度 + 一帧 UTF-8 JSON。头/原始字节先限额，完整 EOF 后才允许解码。 */
export class LegacyFrameReader {
  private readonly maxBytes: number;
  private chunks: Buffer[] = [];
  private bytes = 0;
  private length: number | undefined;
  private prefix = Buffer.alloc(0);
  private failed = false;
  private finished = false;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  push(chunk: Buffer): void {
    if (this.failed || this.finished) throw new Error('legacy frame state');
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes + 4) this.fail();
    if (this.prefix.length < 4) {
      this.prefix = Buffer.concat([this.prefix, chunk.subarray(0, 4 - this.prefix.length)]);
      if (this.prefix.length === 4) {
        this.length = this.prefix.readUInt32BE(0);
        if (this.length < 1 || this.length > this.maxBytes) this.fail();
      }
    }
    if (this.length !== undefined && this.bytes > this.length + 4) this.fail();
    // 不保存超限块；有界块只复制一次，不在每次 data 时重拼整帧。
    this.chunks.push(Buffer.from(chunk));
  }

  finish(): unknown {
    if (this.failed || this.finished || this.length === undefined || this.bytes !== this.length + 4)
      return this.fail();
    this.finished = true;
    const bytes = Buffer.concat(this.chunks, this.bytes).subarray(4);
    this.chunks = [];
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  }

  private fail(): never {
    this.failed = true;
    this.chunks = [];
    throw new Error('legacy frame invalid');
  }
}

export function legacyFrame(value: unknown, maxBytes: number): Buffer {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length < 1 || bytes.length > maxBytes) throw new Error('legacy frame limit');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length);
  return Buffer.concat([header, bytes]);
}
