import { describe, expect, it } from 'vitest';
import { LineSplitter } from '../src/lines.ts';

describe('LineSplitter', () => {
  it('跨块拼行，\\r\\n 当 \\n', () => {
    const s = new LineSplitter();
    expect(s.push('{"a":1}\r\n{"b"')).toEqual(['{"a":1}']);
    expect(s.push(':2}\n')).toEqual(['{"b":2}']);
    expect(s.end()).toEqual([]);
  });

  it('多字节汉字被切在两块中间也能拼回来', () => {
    const bytes = Buffer.from('{"text":"改好了"}\n', 'utf8');
    const cut = bytes.indexOf(Buffer.from('好', 'utf8')) + 1; // 切在「好」的三个字节中间
    const s = new LineSplitter();
    expect(s.push(bytes.subarray(0, cut))).toEqual([]);
    expect(s.push(bytes.subarray(cut))).toEqual(['{"text":"改好了"}']);
  });

  it('没有换行收尾的最后一段在 end() 时交出', () => {
    const s = new LineSplitter();
    expect(s.push('a\nb')).toEqual(['a']);
    expect(s.end()).toEqual(['b']);
  });

  it('超长行整行丢掉并计数，后面的行照常', () => {
    const s = new LineSplitter(10);
    expect(s.push('0123456789ABC')).toEqual([]);
    expect(s.push('DEF\nok\n')).toEqual(['ok']);
    expect(s.push('01234567890123\nfine\n')).toEqual(['fine']);
    expect(s.dropped).toBe(2);
  });
});
