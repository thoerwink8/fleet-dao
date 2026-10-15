// stream-kit 里工具摘要、结果正文、失败说明的公共部分。各渠道的字段映射不在这里测，夹具测。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_TOOL_RESULT,
  FAILURE_TEXT_MAX,
  TOOL_SUMMARY_MAX,
  TRANSCRIPT_SUMMARY_MAX,
  exitCodeText,
  failureText,
  firstStringField,
  rec,
  resultText,
  searchSummary,
  str,
  todoSummary,
  toolSummary,
} from '../src/stream-kit.ts';

const repeat = (n: number) => 'a'.repeat(n);

describe('工具摘要的截断', () => {
  it('上限只有这一处：会话记录 2000，进度事件默认 200', () => {
    expect(TRANSCRIPT_SUMMARY_MAX).toBe(2000);
    expect(TOOL_SUMMARY_MAX).toBe(200);
    expect(toolSummary(repeat(TOOL_SUMMARY_MAX))).toBe(repeat(TOOL_SUMMARY_MAX));
    expect(toolSummary(repeat(TOOL_SUMMARY_MAX + 1))).toBe(`${repeat(TOOL_SUMMARY_MAX)}…`);
    expect(toolSummary(repeat(TRANSCRIPT_SUMMARY_MAX), TRANSCRIPT_SUMMARY_MAX)).toBe(
      repeat(TRANSCRIPT_SUMMARY_MAX),
    );
    expect(toolSummary(repeat(TRANSCRIPT_SUMMARY_MAX + 1), TRANSCRIPT_SUMMARY_MAX)).toBe(
      `${repeat(TRANSCRIPT_SUMMARY_MAX)}…`,
    );
  });

  it('没挑到文本给空串；短的、空串、两侧空白都原样留下', () => {
    expect(toolSummary(undefined)).toBe('');
    expect(toolSummary('')).toBe('');
    expect(toolSummary('  命令  ')).toBe('  命令  ');
    expect(toolSummary('ls')).toBe('ls');
  });
});

describe('结果正文', () => {
  it('字符串原样（含空串）；不是字符串也不是数组给空串', () => {
    expect(resultText('export const T = 1')).toBe('export const T = 1');
    expect(resultText('')).toBe('');
    expect(resultText(undefined)).toBe('');
    expect(resultText(1)).toBe('');
    expect(resultText({ text: '不算' })).toBe('');
  });

  it('claude 的内容块：认块上的 text，空块留成空串，中间不加分隔', () => {
    expect(resultText([{ text: 'a' }, {}, { text: '' }, { text: 'b' }])).toBe('ab');
    expect(resultText(['不是对象'])).toBe('');
  });

  it('grok 的内容块：取内层 text，空块丢掉，分隔由调用方定', () => {
    const content = [
      { content: { text: '第一行' } },
      { content: { text: '' } },
      { content: { text: '第二行' } },
    ];
    const pick = (block: unknown) => str(rec(rec(block)?.content)?.text);
    expect(resultText(content, { pick, sep: '\n', dropEmpty: true })).toBe('第一行\n第二行');
    expect(resultText(content, { pick, sep: '：', dropEmpty: true })).toBe('第一行：第二行');
    expect(resultText([], { pick, dropEmpty: true })).toBe('');
  });
});

describe('失败说明', () => {
  it('默认截到 500；正好 500 不截；不去空白、不改字', () => {
    expect(FAILURE_TEXT_MAX).toBe(500);
    expect(failureText('退出码 1：boom')).toBe('退出码 1：boom');
    expect(failureText(`  ${repeat(10)}  `)).toBe(`  ${repeat(10)}  `);
    expect(failureText(repeat(FAILURE_TEXT_MAX))).toBe(repeat(FAILURE_TEXT_MAX));
    expect(failureText(repeat(FAILURE_TEXT_MAX + 1))).toBe(`${repeat(FAILURE_TEXT_MAX)}…`);
  });

  it('退出码读不到写问号，读到 0 就是 0', () => {
    expect(exitCodeText(undefined)).toBe('退出码 ?');
    expect(exitCodeText(0)).toBe('退出码 0');
    expect(exitCodeText(143)).toBe('退出码 143');
  });

  it('成功但没有正文时的那一句', () => {
    expect(EMPTY_TOOL_RESULT).toBe('（无输出）');
  });
});

describe('摘要里各家一样的拼法', () => {
  it('搜索：图案 @ 相对路径；树外的路径原样；都没有就 undefined', () => {
    expect(searchSummary('foo', '/work/repo/src/a.ts', '/work/repo')).toBe('foo @ src/a.ts');
    expect(searchSummary('foo', '/other/a.ts', '/work/repo')).toBe('foo @ /other/a.ts');
    expect(searchSummary('foo', undefined, '/work/repo')).toBe('foo');
    expect(searchSummary(undefined, '/work/repo/src/a.ts', '/work/repo')).toBe('src/a.ts');
    expect(searchSummary(undefined, undefined, '/work/repo')).toBeUndefined();
  });

  it('认不出的工具拿第一个字符串字段，空串也算，没有就 undefined', () => {
    expect(firstStringField({ n: 1, s: 'hello' })).toBe('hello');
    expect(firstStringField({ a: '', b: '后面的' })).toBe('');
    expect(firstStringField({ n: 1, ok: true })).toBeUndefined();
  });

  it('待办清单数条数；不是数组按 0', () => {
    expect(todoSummary([{ id: '1' }, { id: '2' }])).toBe('待办 2 条');
    expect(todoSummary([])).toBe('待办 0 条');
    expect(todoSummary(undefined)).toBe('待办 0 条');
    expect(todoSummary('不是数组')).toBe('待办 0 条');
  });
});

describe('三个渠道不再各自抄截断常量', () => {
  const src = join(import.meta.dirname, '../src');

  it('TRANSCRIPT_SUMMARY_MAX 只在 stream-kit 赋值，三家 stream 改为导入', () => {
    const name = 'TRANSCRIPT_SUMMARY_MAX';
    const assignment = `${name} =`;
    const kit = readFileSync(join(src, 'stream-kit.ts'), 'utf8');
    expect(kit.includes(`export const ${assignment} 2000`)).toBe(true);
    for (const file of ['claude-code/stream.ts', 'cursor/stream.ts', 'grok/stream.ts']) {
      const code = readFileSync(join(src, file), 'utf8');
      expect(code.includes(name), file).toBe(true);
      expect(code.includes(assignment), file).toBe(false);
      expect(code.includes('resultText'), file).toBe(true);
      expect(code.includes('failureText'), file).toBe(true);
    }
  });
});
