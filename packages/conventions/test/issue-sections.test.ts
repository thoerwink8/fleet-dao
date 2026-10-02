// 单子三栏的「全报」和取一节原文（issue-new.ts 里的 requiredSectionProblems、sectionText）：
// 开单只拒第一条（checkRequiredSections，行为不变），派活要一次说清缺哪几处。

import { describe, expect, it } from 'vitest';
import { checkRequiredSections, requiredSectionProblems, sectionText } from '../src/issue-new.ts';
import { parseMd } from '../src/markdown.ts';

const doc = (text: string) => parseMd('t.md', text);
const labels = (text: string) => requiredSectionProblems(doc(text)).map((p) => p.label);

describe('requiredSectionProblems · 一次全报', () => {
  it('三栏都齐 → 没有问题', () => {
    expect(labels('## 场景\n\n甲\n\n## 原话\n\n乙\n\n## 已知的模块\n\n丙\n')).toEqual([]);
  });

  it('三栏都没有 → 按 场景、原话、已知的模块 的顺序全报', () => {
    expect(labels('只有一句话。')).toEqual(['场景', '原话', '已知的模块']);
  });

  it('空栏只报一次，说「是空的」（不会再报一遍「没有」）', () => {
    const ps = requiredSectionProblems(doc('## 场景\n\n## 原话\n\n乙\n\n## 已知的模块\n\n丙\n'));
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ label: '场景' });
    expect(ps[0]?.why).toContain('是空的');
  });

  it('涉及面排最前，后面的缺栏照样报', () => {
    expect(labels('## 涉及面\n\n乙\n\n## 场景\n\n甲\n')).toEqual(['涉及面', '原话', '已知的模块']);
  });

  it('空栏排在缺栏前面（和开单一直以来先报哪条的顺序一样）', () => {
    // 场景没有、原话是空的：原来的 checkRequiredSections 先报「原话是空的」
    expect(labels('## 原话\n\n## 已知的模块\n\n丙\n')).toEqual(['原话', '场景']);
  });

  it('checkRequiredSections 还是只给第一条，和全报的第一条一样', () => {
    for (const text of [
      '无',
      '## 涉及面\n\n乙\n',
      '## 场景\n\n## 原话\n\n乙\n',
      '## 原话\n\n## 已知的模块\n\n丙\n',
      '## 场景\n\n甲\n\n## 原话\n\n乙\n\n## 已知的模块\n\n丙\n',
    ]) {
      expect(checkRequiredSections(doc(text))).toEqual(requiredSectionProblems(doc(text))[0]);
    }
  });
});

describe('sectionText · 取一节原文', () => {
  const text = [
    '开头一段。',
    '',
    '## 已知的模块',
    '',
    '- `a/b.ts`：甲',
    '  续行',
    '- `c/`：乙',
    '',
    '### 小标题',
    '',
    '小标题下面的也算这一节。',
    '',
    '## 怎么算做完',
    '',
    '1. 测试过',
    '',
  ].join('\n');

  it('保留换行和列表，含下一级小标题，到下一个同级标题为止，去掉首尾空行', () => {
    expect(sectionText(doc(text), '已知的模块')).toBe(
      '- `a/b.ts`：甲\n  续行\n- `c/`：乙\n\n### 小标题\n\n小标题下面的也算这一节。',
    );
    expect(sectionText(doc(text), '怎么算做完')).toBe('1. 测试过');
  });

  it('没有这一节 → undefined（不是空串）；有标题没内容 → 空串', () => {
    expect(sectionText(doc(text), '场景')).toBeUndefined();
    expect(sectionText(doc('## 场景\n\n## 原话\n\n乙'), '场景')).toBe('');
  });

  it('HTML 注释不算内容；同名小标题取第一个', () => {
    expect(sectionText(doc('## 场景\n\n<!-- 模板提示 -->\n甲\n\n## 场景\n\n乙'), '场景')).toBe('甲');
  });

  it('标题里的加粗、反引号、编号不影响认栏', () => {
    expect(sectionText(doc('## 三、**已知的模块**\n\n甲'), '已知的模块')).toBe('甲');
  });
});
