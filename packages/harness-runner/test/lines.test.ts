import { describe, expect, it } from 'vitest';
import { LineSplitter } from '../src/lines.ts';

describe('hostd 标准输出按 UTF-8 切行（#3928）', () => {
  it('中文一行原样留下，不按 GBK 解', () => {
    const text = '收到：请回一句收到';
    const splitter = new LineSplitter();
    const lines = splitter.push(Buffer.from(`${text}\n`, 'utf8'));
    expect(lines).toEqual([text]);
  });
});
