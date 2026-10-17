import { describe, expect, it } from 'vitest';
import { parentField, withParentField } from '../src/parent-field.ts';

describe('更新活动 parent 字段', () => {
  it('修复全部活动的重复和畸形字段，只保留一个新 parent', () => {
    const before = '第一段\r\nparent: #1\r\nparent : nope\nParent: #3\n末段';
    const result = withParentField(before, 8);
    expect(result).toBe('parent: #8\n第一段\r\n末段');
    expect(parentField(result)).toEqual({ kind: 'parent', number: 8 });
    expect(withParentField(result, 8)).toBe(result);
  });

  it('引用、代码和注释中的示例逐字保留', () => {
    const examples = [
      '> parent: #1',
      '```md',
      'parent: #2',
      '```',
      '~~~',
      'parent: #3',
      '~~~',
      '    parent: #4',
      '\tparent: #5',
      '<!--',
      'parent: #6',
      '> -->',
    ].join('\n');
    expect(withParentField(`${examples}\nparent: #7\n`, 12)).toBe(`parent: #12\n${examples}\n`);
  });

  it.each(['<!-- 未闭合', '```md\n未闭合'])('正文以 %s 结尾时，前置的新关系仍能被读取', (body) => {
    const result = withParentField(body, 9);
    expect(result.endsWith(body)).toBe(true);
    expect(parentField(result)).toEqual({ kind: 'parent', number: 9 });
  });

  it('只有 parent 的末行也能替换，没有残余', () => {
    expect(withParentField('parent: #1', 2)).toBe('parent: #2\n');
  });

  it('同一行出现多段 HTML 注释时，只修改真正活动的字段', () => {
    const before =
      '<!-- 已闭合 --> <!-- 未闭合\nparent: #1\n--> <!-- 仍在注释\nparent: #2\n-->\nparent: #3\n';
    expect(parentField(before)).toEqual({ kind: 'parent', number: 3 });
    const after = withParentField(before, 8);
    expect(after).toBe(`parent: #8\n${before.slice(0, before.lastIndexOf('parent: #3'))}`);
    expect(parentField(after)).toEqual({ kind: 'parent', number: 8 });
  });

  it('parent 示例同行开启的注释保持原样，不能删开头后把注释里的示例变成活动字段', () => {
    const body = 'parent: #1 <!-- 注释示例\nparent: #2\n-->\nparent: #3\n';
    const after = withParentField(body, 8);
    expect(after).toBe('parent: #8\nparent: #1 <!-- 注释示例\nparent: #2\n-->\n');
    expect(parentField(after)).toEqual({ kind: 'parent', number: 8 });
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('非法 parent %s 拒绝写入', (n) => {
    expect(() => withParentField('原文', n)).toThrow();
  });
});
