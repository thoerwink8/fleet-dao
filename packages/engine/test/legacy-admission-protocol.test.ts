import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  LEGACY_REQUEST_MAX_BYTES,
  LEGACY_RESULT_MAX_BYTES,
  LegacyFrameReader,
  LegacyRequestSchema,
  LegacyResponseSchema,
  legacyFrame,
} from '../src/real/legacy-admission-protocol.ts';

const response = () => ({
  version: 1,
  id: randomUUID(),
  result: { kind: 'unknown', code: 'store_unavailable' },
});
describe('legacy SQL 原始字节封闭帧', () => {
  it('逐字节接收，完整 EOF 才解析；一帧不能被重复消费', () => {
    const value = response(),
      frame = legacyFrame(value, LEGACY_RESULT_MAX_BYTES);
    const reader = new LegacyFrameReader(LEGACY_RESULT_MAX_BYTES);
    for (const byte of frame) reader.push(Buffer.from([byte]));
    expect(LegacyResponseSchema.parse(reader.finish())).toEqual(value);
    expect(() => reader.finish()).toThrow();
  });
  it.each([0, 1, 3, 4, 8])('截断在 %s 字节不能冒充完整结果', (bytes) => {
    const reader = new LegacyFrameReader(LEGACY_RESULT_MAX_BYTES);
    reader.push(legacyFrame(response(), LEGACY_RESULT_MAX_BYTES).subarray(0, bytes));
    expect(() => reader.finish()).toThrow();
  });
  it('超大头/大块先按原始字节拒绝；不先JSON.parse', () => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(0xffffffff);
    expect(() => new LegacyFrameReader(4096).push(header)).toThrow();
    expect(() => new LegacyFrameReader(4096).push(Buffer.alloc(4101))).toThrow();
    expect(() => legacyFrame('x'.repeat(4096), 4096)).toThrow();
  });
  it('多余帧、尾字节、错误UTF8和JSON均拒绝', () => {
    const frame = legacyFrame(response(), LEGACY_RESULT_MAX_BYTES);
    for (const extra of [Buffer.from('x'), frame]) {
      const reader = new LegacyFrameReader(4096);
      expect(() => reader.push(Buffer.concat([frame, extra]))).toThrow();
    }
    for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from('{')]) {
      const reader = new LegacyFrameReader(4096),
        header = Buffer.alloc(4);
      header.writeUInt32BE(bytes.length);
      reader.push(Buffer.concat([header, bytes]));
      expect(() => reader.finish()).toThrow();
    }
  });
  it('结果严格字段，不接受canonical、URL、驱动异常或伪造allowed结构', () => {
    const good = response();
    expect(LegacyResponseSchema.safeParse(good).success).toBe(true);
    for (const extra of [{ databaseUrl: 'private' }, { inputCanonical: 'private' }, { error: 'private' }])
      expect(LegacyResponseSchema.safeParse({ ...good, ...extra }).success).toBe(false);
    expect(LegacyResponseSchema.safeParse({ ...good, result: { kind: 'allowed' } }).success).toBe(false);
    expect(
      LegacyResponseSchema.safeParse({ ...good, result: { kind: 'unknown', code: 'private message' } })
        .success,
    ).toBe(false);
  });
  it('2MiB Start的canonical与再次JSON转义可完整来回，不截正文', () => {
    const inputCanonical = JSON.stringify({ body: '\u0000'.repeat(Math.floor((2 * 1024 * 1024) / 6)) });
    const request = LegacyRequestSchema.parse({
      version: 1,
      id: randomUUID(),
      databaseUrl: 'postgres://fixture:fixture@127.0.0.1/fixture',
      killAt: Date.now() + 9000,
      budgetMs: 9000,
      input: {
        schemaVersion: 1,
        taskId: randomUUID(),
        namespace: 'test',
        workflowId: 'task:a/b#1',
        runId: randomUUID(),
        workflowType: 'taskWorkflow',
        taskQueue: 'test',
        generation: 1,
        operation: 'legacy_first_limits',
        inputCanonical,
        inputHash: 'a'.repeat(64),
      },
      audit: { actor: { kind: 'engine', id: 'fixture' }, via: 'engine' },
    });
    const frame = legacyFrame(request, LEGACY_REQUEST_MAX_BYTES),
      reader = new LegacyFrameReader(LEGACY_REQUEST_MAX_BYTES);
    for (let at = 0; at < frame.length; at += 65536) reader.push(frame.subarray(at, at + 65536));
    expect(LegacyRequestSchema.parse(reader.finish()).input.inputCanonical).toBe(inputCanonical);
  });
});
