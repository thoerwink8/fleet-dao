// 会话里助手说的话的小 Markdown 解析（#3277）：认得的几样、认不出的照原文。
import { describe, expect, test } from 'vitest';
import { parseInline, parseMarkdown } from './markdown';

describe('parseInline', () => {
  test('行内代码、加粗、http 链接；代码里不再认加粗', () => {
    expect(parseInline('改 `a**b**` 和 **c**，见 [单](https://x.test/1)')).toEqual([
      { kind: 'text', text: '改 ' },
      { kind: 'code', text: 'a**b**' },
      { kind: 'text', text: ' 和 ' },
      { kind: 'bold', text: 'c' },
      { kind: 'text', text: '，见 ' },
      { kind: 'link', text: '单', href: 'https://x.test/1' },
    ]);
  });

  test('不是 http(s) 的链接不认（javascript: 之类原样当字）', () => {
    expect(parseInline('[点](javascript:alert(1))')).toEqual([
      { kind: 'text', text: '[点](javascript:alert(1))' },
    ]);
  });
});

describe('parseMarkdown', () => {
  test('段落保留单个换行，空行分段', () => {
    expect(parseMarkdown('一行\n两行\n\n另一段')).toEqual([
      { kind: 'para', lines: [[{ kind: 'text', text: '一行' }], [{ kind: 'text', text: '两行' }]] },
      { kind: 'para', lines: [[{ kind: 'text', text: '另一段' }]] },
    ]);
  });

  test('标题、无序列表、有序列表（带起始号）、引用、代码块', () => {
    const blocks = parseMarkdown('## 结论\n- a\n- b\n\n3. c\n4. d\n> 引\n```sh\npnpm test\n```');
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'list', 'list', 'quote', 'code']);
    expect(blocks[1]).toMatchObject({ ordered: false, items: [[{ text: 'a' }], [{ text: 'b' }]] });
    expect(blocks[2]).toMatchObject({ ordered: true, start: 3 });
    expect(blocks[4]).toEqual({ kind: 'code', lang: 'sh', text: 'pnpm test' });
  });

  test('列表紧跟着的段落行另起段落；没收尾的代码块到末尾为止', () => {
    const blocks = parseMarkdown('- a\n后面的话\n```\n没收尾');
    expect(blocks.map((b) => b.kind)).toEqual(['list', 'para', 'code']);
    expect(blocks[2]).toEqual({ kind: 'code', lang: '', text: '没收尾' });
  });
});
