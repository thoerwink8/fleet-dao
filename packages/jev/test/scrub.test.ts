// 写库之前：脱敏只抹开头一段（窗口截在令牌之外、不留半截，一整串不断开的长串不整段过）；库收不下的字换掉；引用转成收得下的样子。
import { describe, expect, it } from 'vitest';
import { cutAt, scrubHead, storableRef, wellFormed } from '../src/scrub.ts';

// 这几个字用码点拼：直接写进源码，编辑器和工具会把它们换掉或吞掉。
const NUL = String.fromCharCode(0);
const LONE = String.fromCharCode(0xd83d);
const REPLACEMENT = String.fromCharCode(0xfffd);

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

  it('截在 emoji（代理对）中间：去掉落单的前一半；整个 emoji 在界内的照留', () => {
    expect(scrubHead(`${'字'.repeat(199)}🔴后面`, 200)).toBe('字'.repeat(199));
    expect(scrubHead(`${'字'.repeat(198)}🔴后面`, 200)).toBe(`${'字'.repeat(198)}🔴`);
    expect(cutAt('ab🔴', 3)).toBe('ab');
    expect(cutAt('ab🔴', 4)).toBe('ab🔴');
  });

  it('原文里本来就落单的代理项（编码坏了）换成 U+FFFD，不让整行写不进库', () => {
    expect(scrubHead('坏\uD83D字\uDE00尾', 50)).toBe('坏\uFFFD字\uFFFD尾');
    expect(wellFormed('好的🔴')).toBe('好的🔴');
  });

  it('NUL（命令输出里常混进来）也换成 U+FFFD：jsonb 和 text 列都收不下它', () => {
    expect(wellFormed(`a${NUL}b${NUL}`)).toBe(`a${REPLACEMENT}b${REPLACEMENT}`);
    expect(scrubHead(`退出码 1${NUL}stderr`, 50)).toBe(`退出码 1${REPLACEMENT}stderr`);
  });

  it('一整串不断开的长串：不整段过，退回到它前面能截的地方；从头就是一整串的只留「<长串>」', () => {
    expect(scrubHead(`开头几个字 ${'Z'.repeat(50_000)} 结尾`, 200)).toBe('开头几个字');
    expect(scrubHead(`${'Z'.repeat(50_000)} 结尾`, 200)).toBe('<长串>');
  });
});

describe('调用方给的引用写库之前', () => {
  it('转成 JSON 再解析回来：日期变字符串、undefined 去掉；字符串和键里的坏字换成 U+FFFD，别的原样', () => {
    const ref = {
      at: new Date('2026-09-25T00:00:00Z'),
      gone: undefined,
      [`k${NUL}`]: [`v${LONE}`, 1, null, { ok: '好的🔴' }],
    };
    // toStrictEqual：值是 undefined 的键得真的没了，不是留着个 undefined。
    expect(storableRef(ref)).toStrictEqual({
      ref: {
        at: '2026-09-25T00:00:00.000Z',
        [`k${REPLACEMENT}`]: [`v${REPLACEMENT}`, 1, null, { ok: '好的🔴' }],
      },
    });
  });

  it('转不成 JSON 的（BigInt、循环引用、函数）不抛，交回原因；原因里的坏字也换掉', () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    const bad = {
      toJSON() {
        throw new Error(`坏${NUL}了`);
      },
    };
    expect(storableRef({ id: 10n })).toEqual({ problem: expect.stringContaining('BigInt') });
    expect(storableRef(loop)).toEqual({ problem: expect.stringContaining('circular') });
    expect(storableRef(() => 1)).toEqual({ problem: '转不成 JSON（是函数或 undefined）' });
    expect(storableRef(bad)).toEqual({ problem: `转不成 JSON：坏${REPLACEMENT}了` });
  });
});
