// 新内核契约（#3773）：S2 认不出的 schemaVersion 拒；操作键带令牌，换了所有者就是另一件事。
import { describe, expect, it } from 'vitest';
import {
  OUTBOX_KINDS,
  OUTBOX_SCHEMA_TRANSITION,
  OUTBOX_SCHEMA_VERSION,
  opKey,
  parseEvent,
  parseOutbox,
  StreamId,
} from '../src/index.ts';

describe('parseEvent', () => {
  it('认得的版本和类型收；版本不对、类型不认识拒，原因写明', () => {
    expect(parseEvent({ schemaVersion: 1, type: 'worker.spawned', payload: {} })).toMatchObject({ ok: true });
    expect(parseEvent({ schemaVersion: 2, type: 'worker.spawned', payload: {} })).toEqual({
      ok: false,
      why: '事件版本 2 认不出（只认 1）',
    });
    expect(parseEvent({ schemaVersion: 1, type: 'worker.exploded', payload: {} })).toMatchObject({
      ok: false,
    });
    expect(parseEvent(null)).toMatchObject({ ok: false });
  });
});

describe('StreamId', () => {
  it('只认三种流名', () => {
    expect(StreamId.safeParse('issue:acme/app#7').success).toBe(true);
    expect(StreamId.safeParse('session:abc').success).toBe(true);
    expect(StreamId.safeParse('task:1').success).toBe(false);
  });
});

describe('出站信封', () => {
  it('新写出 change.*；过渡版读得进 github.pr.open；不认识的 schemaVersion 拒', () => {
    expect(OUTBOX_KINDS).toEqual(['change.push', 'change.pr.open', 'change.comment', 'change.merge']);
    for (const kind of OUTBOX_KINDS) {
      expect(parseOutbox({ schemaVersion: OUTBOX_SCHEMA_VERSION, kind })).toEqual({ ok: true, kind });
    }
    expect(parseOutbox({ schemaVersion: OUTBOX_SCHEMA_TRANSITION, kind: 'github.pr.open' })).toEqual({
      ok: true,
      kind: 'github.pr.open',
    });
    expect(parseOutbox({ schemaVersion: 9, kind: 'change.push' })).toEqual({
      ok: false,
      why: '出站信封版本 9 认不出（只认 2，过渡版 1）',
    });
    expect(parseEvent({ schemaVersion: 9, type: 'worker.spawned', payload: {} })).toEqual({
      ok: false,
      why: '事件版本 9 认不出（只认 1）',
    });
  });
});

describe('opKey', () => {
  const ref = { repo: 'acme/app', issue: 7 };
  it('同样输入同一个键；令牌变了键就变', () => {
    expect(opKey('change.pr.open', ref, 3, 'pr')).toBe(opKey('change.pr.open', ref, 3, 'pr'));
    expect(opKey('change.pr.open', ref, 4, 'pr')).not.toBe(opKey('change.pr.open', ref, 3, 'pr'));
  });
  it('令牌不是非负整数、区分词空：拒', () => {
    expect(() => opKey('change.push', ref, -1, 'x')).toThrow();
    expect(() => opKey('change.push', ref, 1.5, 'x')).toThrow();
    expect(() => opKey('change.push', ref, 1, ' ')).toThrow();
  });
});
