// GitHub 合并时认的关单写法（closing-issues.ts）：pr-links 用它把 PR 链到单子上。
import { describe, expect, it } from 'vitest';
import { closingIssues } from '../src/closing-issues.ts';

describe('GitHub 合并时认的关单写法', () => {
  it('几种写法都认，排好、去重', () => {
    expect(
      closingIssues(
        'Closes #12\nfixed: #3 和 resolves o/r#9；Resolved GH-4，close https://github.com/o/r/issues/7，再 closes #12',
      ),
    ).toEqual([3, 4, 7, 9, 12]);
  });

  it('不是关单词的不算：提到单号、closest、prefix、中文的「关联」', () => {
    expect(closingIssues('属于需求 #12；closest #13；prefix #14；关联 #15；fix the bug in #16')).toEqual([]);
  });

  it('代码块、行内代码、HTML 注释里拿来举例的不算（GitHub 不从那里认）；没收尾的围栏不算代码块，照认', () => {
    const body = [
      '用法：`Closes #1` 或 ``fixes #2``',
      '<!-- 模板提示：resolves #3 -->',
      '```',
      'closes #4',
      '```',
      '~~~md',
      'fixed #5',
      '~~~',
      '真的要关：Closes #6',
      '```',
      'closes #7（没收尾）',
    ].join('\n');
    expect(closingIssues(body)).toEqual([6, 7]);
  });

  it('给了仓名：写明是别的仓的不算，同仓的（大小写不同也算）照算', () => {
    expect(closingIssues('fixes a/b#1, fixes O/R#2, fixes #3', 'o/r')).toEqual([2, 3]);
    expect(closingIssues('fixes a/b#1', undefined)).toEqual([1]);
  });
});
