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

  it('接手 PR：claim 可带精确 PR 号 + 完整小写 40 位 head；确认动作必须带；短 head、大写、多字段、缺字段拒收', () => {
    const base = { repo: 'a/b', issue: 1 };
    const takeoverPr = { pr: 7, head: 'a'.repeat(40) };
    const parse = (v: unknown) => LocalClaimRequestSchema.safeParse(v).success;
    expect(parse({ action: 'claim', ...base, title: 't', takeoverPr })).toBe(true);
    expect(parse({ action: 'takeover_confirm', ...base, takeoverPr })).toBe(true);
    expect(parse({ action: 'takeover_confirm', ...base })).toBe(false);
    for (const bad of [
      { pr: 7, head: 'a'.repeat(39) },
      { pr: 7, head: 'A'.repeat(40) },
      { pr: 0, head: 'a'.repeat(40) },
      { pr: 7, head: 'a'.repeat(40), verified: true },
      { head: 'a'.repeat(40) },
    ]) {
      expect(parse({ action: 'claim', ...base, title: 't', takeoverPr: bad })).toBe(false);
    }
  });
});
