// 本机租约读口和通行证发放的线上协议（node-claims.ts）：零依赖的解析函数，形状不对一律抛错。
import { describe, expect, it } from 'vitest';
import { nodeErrorCode, parseNodeClaimsResponse, parseNodeKeyNewJson } from '../src/node-claims.ts';

const ROW = { repo: 'Acme/App', issue: 7, claimedBy: 'founder-pc', leaseUntil: '2026-10-20T05:00:00.000Z' };

describe('parseNodeClaimsResponse', () => {
  it('认得出，且只留四个字段', () => {
    expect(parseNodeClaimsResponse({ claims: [{ ...ROW, extra: 1 }] })).toEqual({ claims: [ROW] });
    expect(parseNodeClaimsResponse({ claims: [] })).toEqual({ claims: [] });
  });
  it('【故意造出的失败】形状不对抛错，不当成空列表', () => {
    for (const bad of [
      null,
      {},
      { claims: 'x' },
      { claims: [{ ...ROW, issue: '7' }] },
      { claims: [{ ...ROW, issue: 1.5 }] },
      { claims: [{ ...ROW, leaseUntil: 'not a date' }] },
      { claims: [{ repo: 'a/b', issue: 1, leaseUntil: ROW.leaseUntil }] },
    ]) {
      expect(() => parseNodeClaimsResponse(bad)).toThrow();
    }
  });
});

describe('parseNodeKeyNewJson / nodeErrorCode', () => {
  it('node-key new --json 的一行', () => {
    expect(parseNodeKeyNewJson('{"env":"founder-pc","token":"abc"}\n')).toEqual({
      env: 'founder-pc',
      token: 'abc',
    });
    for (const bad of ['', 'nope', '{"env":"a"}', '{"env":"a","token":""}', '[]']) {
      expect(() => parseNodeKeyNewJson(bad)).toThrow();
    }
  });
  it('错误码两种写法都认，认不出是 null', () => {
    expect(nodeErrorCode({ error: 'node_token_invalid' })).toBe('node_token_invalid');
    expect(nodeErrorCode({ error: { code: 'node_keys_unreadable', message: 'x' } })).toBe(
      'node_keys_unreadable',
    );
    expect(nodeErrorCode({})).toBeNull();
    expect(nodeErrorCode(null)).toBeNull();
  });
});
