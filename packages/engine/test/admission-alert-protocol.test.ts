import {
  AdmissionAlertCodeSchema,
  type AdmissionAlertObservation,
  admissionAlertJson,
  admissionAlertKey,
  admissionAlertRecordHash,
} from '@fleet-dao/db';
import { describe, expect, it } from 'vitest';
import { AlertObservationSchema, AlertRequestSchema } from '../src/real/admission-alert-protocol.ts';
import type { LegacySourceAdmission } from '../src/real/execution-legacy-admission.ts';
import { LegacyFrameReader, legacyFrame } from '../src/real/legacy-admission-protocol.ts';

const o: AdmissionAlertObservation = {
  identity: {
    version: 1,
    category: 'legacy_admission_unknown',
    namespace: 'test',
    workflowId: 'task:example/test#1',
    runId: '11111111-1111-4111-8111-111111111111',
  },
  firstCode: 'deadline',
};
// 编译期：真实来源所有unknown码必须可原样承接，不能合并丢失诊断来源。
type MissingCode = Exclude<
  Extract<LegacySourceAdmission, { kind: 'unknown' }>['code'],
  AdmissionAlertObservation['firstCode']
>;
const allSourceCodesCovered: MissingCode extends never ? true : never = true;
describe('报警封闭identity与协议', () => {
  it('identity与首码/本地hash分离，重建code变化不改变去重键', () => {
    const later = { ...o, firstCode: 'store_unavailable' as const };
    expect(admissionAlertKey(later.identity)).toBe(admissionAlertKey(o.identity));
    expect(admissionAlertRecordHash(later)).not.toBe(admissionAlertRecordHash(o));
    expect(admissionAlertJson(o)).not.toContain('taskId');
    expect(allSourceCodesCovered).toBe(true);
    for (const code of ['start_deadline', 'missing_context', 'canonical_failed'])
      expect(AdmissionAlertCodeSchema.safeParse(code).success).toBe(true);
  });
  it('拒绝正文、token、任意字段和超限DTO', () => {
    expect(AlertObservationSchema.safeParse({ ...o, canonical: 'private' }).success).toBe(false);
    expect(
      AlertObservationSchema.safeParse({ ...o, identity: { ...o.identity, token: 'private' } }).success,
    ).toBe(false);
    expect(
      AlertObservationSchema.safeParse({
        ...o,
        identity: { ...o.identity, workflowId: '\u0000'.repeat(1024) },
      }).success,
    ).toBe(false);
  });
  it('caller不能选择任意operation或ACK', () => {
    const base = {
      version: 1,
      id: o.identity.runId,
      spoolPath: '/private/spool',
      killAt: 123,
      budgetMs: 1000,
    };
    expect(AlertRequestSchema.safeParse({ ...base, operation: 'record', observation: o }).success).toBe(true);
    expect(
      AlertRequestSchema.safeParse({ ...base, operation: 'ack', key: admissionAlertKey(o.identity) }).success,
    ).toBe(false);
    expect(
      AlertRequestSchema.safeParse({ ...base, operation: 'record', observation: o, databaseUrl: 'private' })
        .success,
    ).toBe(false);
  });
  it('既有帧机械零件严格EOF/UTF8，不扩A请求schema', () => {
    const f = legacyFrame(o, 4096),
      reader = new LegacyFrameReader(4096);
    for (const b of f) reader.push(Buffer.from([b]));
    expect(reader.finish()).toEqual(o);
    const extra = new LegacyFrameReader(4096);
    expect(() => extra.push(Buffer.concat([f, f]))).toThrow();
  });
});
