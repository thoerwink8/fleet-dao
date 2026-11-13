import { describe, expect, it } from 'vitest';
import { remember } from '../src/ade/service.ts';

describe('列表摘要的中文（#3928）', () => {
  const text = '收到：请回一句收到';

  it('助手正文和 result 原样留下，不按 GBK 再解一遍', () => {
    const assistant = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text }] },
    });
    const result = JSON.stringify({ type: 'result', result: text });
    expect(remember(assistant, '')).toBe(text);
    expect(remember(result, '上一句')).toBe(text);
  });
});
