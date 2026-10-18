// 改文件的增删行数怎么数、子代理标记怎么认（#3140）。
import { describe, expect, it } from 'vitest';
import { countCreatedContent, countStructuredPatch, countTextDiff } from '../src/edit-lines.ts';
import { isSubagentMeta } from '../src/transcript.ts';

describe('countTextDiff：按行差分计数，没变的中间行不计入', () => {
  it('不相邻的修改与重复行按最长公共子序列计数', () => {
    expect(countTextDiff('head\na\nunchanged\nb\ntail', 'head\nA\nunchanged\nB\ntail')).toEqual({
      added: 2,
      removed: 2,
    });
    expect(countTextDiff('a\nkeep\nb\nkeep\nc\n', 'keep\nx\nkeep\n')).toEqual({ added: 1, removed: 3 });
  });
  it('行末换行是否存在也是修改', () => {
    expect(countTextDiff('a\n', 'a')).toEqual({ added: 1, removed: 1 });
  });
  it('无法在计算上限内准确完成时明确未知，不返回近似值', () => {
    expect(countTextDiff('old\n'.repeat(2000), 'new\n'.repeat(2000))).toBeUndefined();
    expect(countTextDiff('x'.repeat(1_000_001), '')).toBeUndefined();
    // 大片相同上下文可先剥掉，不会把一次窄修改误报为超限。
    const context = 'same\n'.repeat(2000);
    expect(countTextDiff(`${context}a\n`, `${context}b\n`)).toEqual({ added: 1, removed: 1 });
  });
  it('改一行、加两行、删一行', () => {
    expect(countTextDiff('a\nb\nc', 'a\nB\nB2\nc')).toEqual({ added: 2, removed: 1 });
    expect(countTextDiff('a\nb\n', 'a\nb\nc\n')).toEqual({ added: 1, removed: 0 });
    expect(countTextDiff('a\nb\nc', 'a\nc')).toEqual({ added: 0, removed: 1 });
  });
  it('一样、空到有、有到空', () => {
    expect(countTextDiff('x', 'x')).toEqual({ added: 0, removed: 0 });
    expect(countTextDiff('', 'a\nb\n')).toEqual({ added: 2, removed: 0 });
    expect(countTextDiff('a\nb', '')).toEqual({ added: 0, removed: 2 });
  });
});

describe('countStructuredPatch：数块里行首的 + 和 -', () => {
  it('上下文行不算；多个块相加', () => {
    expect(
      countStructuredPatch([
        { lines: [' # notes', '-- TODO: 写测试', '+- DONE: 写测试'] },
        { lines: ['+新增', ' 上下文'] },
      ]),
    ).toEqual({ added: 2, removed: 1 });
    expect(countStructuredPatch([])).toEqual({ added: 0, removed: 0 });
  });
  it('形状不对返回 undefined，不猜', () => {
    expect(countStructuredPatch(undefined)).toBeUndefined();
    expect(countStructuredPatch('x')).toBeUndefined();
    expect(countStructuredPatch([{ lines: 'x' }])).toBeUndefined();
    expect(countStructuredPatch([{ lines: [1] }])).toBeUndefined();
  });
});

describe('countCreatedContent', () => {
  it('整份内容按新增行数；末尾换行不多算一行；空文件是 0', () => {
    expect(countCreatedContent('# plan\n')).toEqual({ added: 1, removed: 0 });
    expect(countCreatedContent('a\nb\nc')).toEqual({ added: 3, removed: 0 });
    expect(countCreatedContent('')).toEqual({ added: 0, removed: 0 });
  });
});

describe('isSubagentMeta', () => {
  it('引擎写的是调用编号字符串；true 也认；缺、false、空串不认', () => {
    expect(isSubagentMeta({ subagent: 'toolu_01A' })).toBe(true);
    expect(isSubagentMeta({ subagent: true })).toBe(true);
    expect(isSubagentMeta({ subagent: false })).toBe(false);
    expect(isSubagentMeta({ subagent: '' })).toBe(false);
    expect(isSubagentMeta({ callId: 'x' })).toBe(false);
    expect(isSubagentMeta(undefined)).toBe(false);
  });
});
