// 新内核契约（#3773）：S2 认不出的 schemaVersion 拒；操作键带令牌，换了所有者就是另一件事。
import { describe, expect, it } from 'vitest';
import { opKey, parseEvent, StreamId } from '../src/index.ts';

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

describe('opKey', () => {
  const ref = { repo: 'acme/app', issue: 7 };
  it('同样输入同一个键；令牌变了键就变', () => {
    expect(opKey('github.pr.open', ref, 3, 'pr')).toBe(opKey('github.pr.open', ref, 3, 'pr'));
    expect(opKey('github.pr.open', ref, 4, 'pr')).not.toBe(opKey('github.pr.open', ref, 3, 'pr'));
  });
  it('令牌不是非负整数、区分词空：拒', () => {
    expect(() => opKey('git.push', ref, -1, 'x')).toThrow();
    expect(() => opKey('git.push', ref, 1.5, 'x')).toThrow();
    expect(() => opKey('git.push', ref, 1, ' ')).toThrow();
  });
});
