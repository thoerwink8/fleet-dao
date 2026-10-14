// 本机领单（决定 0096）：本机发给法国的那一条，strict 收。
import { describe, expect, it } from 'vitest';
import { LocalClaimRequestSchema } from '../src/local-claims.ts';

describe('LocalClaimRequestSchema', () => {
  it('【故意造出的失败】多带字段、仓名不对、结局认不出：拒收', () => {
    expect(
      LocalClaimRequestSchema.safeParse({ action: 'renew', repo: 'a/b', issue: 1, token: 'x' }).success,
    ).toBe(false);
    expect(LocalClaimRequestSchema.safeParse({ action: 'renew', repo: 'ab', issue: 1 }).success).toBe(false);
    expect(
      LocalClaimRequestSchema.safeParse({ action: 'finish', repo: 'a/b', issue: 1, outcome: 'gone' }).success,
    ).toBe(false);
    expect(
      LocalClaimRequestSchema.safeParse({ action: 'claim', repo: 'a/b', issue: 1, title: 't' }).success,
    ).toBe(true);
  });
});
