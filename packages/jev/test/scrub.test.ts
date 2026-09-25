// 写库前的脱敏只抹开头一段：窗口截在令牌之外、不留半截；一整串不断开的长串不整段过。
import { describe, expect, it } from 'vitest';
import { scrubHead } from '../src/scrub.ts';

describe('只抹开头一段', () => {
  it('短的整段脱敏，再截到 max 个字', () => {
    expect(scrubHead('发给 someone@example.com', 200)).toBe('发给 <邮箱>');
    expect(scrubHead('一二三四五', 3)).toBe('一二三');
  });

  it('窗口截在令牌之外：前面的长串脱敏后变短，窗口边上的密钥也不会剩半截露进开头', () => {
    // 窗口要是正好截在第 800 字：770 个 A 缩成「<长串>」，跨过第 800 字的 B 只剩 29 个（不到 40 个认不出），就露在开头里。
    const text = `${'A'.repeat(770)} ${'B'.repeat(60)} 后面还有字`;
    expect(scrubHead(text, 200)).toBe('<长串> <长串>');
  });

  it('一整串不断开的长串：不整段过，退回到它前面能截的地方；从头就是一整串的只留「<长串>」', () => {
    expect(scrubHead(`开头几个字 ${'Z'.repeat(50_000)} 结尾`, 200)).toBe('开头几个字');
    expect(scrubHead(`${'Z'.repeat(50_000)} 结尾`, 200)).toBe('<长串>');
  });
});
