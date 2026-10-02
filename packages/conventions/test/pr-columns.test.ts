// PR 正文的栏（pr-columns.ts）：PR 挂了哪张单、「修提醒」写了什么，都从这认。#654 起模板只有四栏，旧栏名还认（读旧 PR 的正文）。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { linkedIssue, OPTIONAL_COLUMNS, PR_COLUMNS, prColumns } from '../src/pr-columns.ts';

const TEMPLATE = readFileSync(new URL('../../../.github/pull_request_template.md', import.meta.url), 'utf8');

describe('PR 模板的栏（#654）', () => {
  it('模板里的栏就是 PR_COLUMNS 那四栏，顺序也一样；模板提示里讲的多写栏不在模板正文里', () => {
    expect([...prColumns(TEMPLATE).keys()]).toEqual(PR_COLUMNS.map((c) => c.toLowerCase()));
    expect(PR_COLUMNS).toEqual(['做了什么', '怎么验证的', '还欠什么', '需求']);
    for (const c of OPTIONAL_COLUMNS) expect([...prColumns(TEMPLATE).keys()]).not.toContain(c);
  });

  it('照模板开、一个字没填：四栏都在，值都是空的（模板提示不算填了）', () => {
    const cols = prColumns(TEMPLATE);
    for (const c of PR_COLUMNS) expect(cols.get(c), c).toBe('');
  });
});

describe('各栏怎么认', () => {
  it('加粗、冒号在里在外、列表里、英文冒号、大写栏名都认', () => {
    for (const text of [
      '**需求**：#12',
      '**需求：** #12',
      '- **需求**：#12',
      '需求：#12',
      '需求: #12',
      '- 需求：#12',
    ]) {
      expect(prColumns(text).get('需求'), text).toBe('#12');
    }
    expect(prColumns('SPECS：x').get('specs')).toBe('x');
  });

  it('不加粗时只认模板里的栏名：正文里带冒号的一句话不会把上一栏截断', () => {
    const cols = prColumns('需求：\n#12：先跑通\n注意：跨两条\n修提醒：无');
    expect(cols.get('需求')).toBe('#12：先跑通\n注意：跨两条');
    expect(cols.get('修提醒')).toBe('无');
    expect([...cols.keys()]).toEqual(['需求', '修提醒']);
  });

  it('栏写在正文开头、后面分了小标题：小标题截断上一栏，各节里提到的 #号 不当成这一栏的', () => {
    const text = ['需求：#12', '', '## 改了什么', '- 顺带提一句 #99'].join('\n');
    expect(prColumns(text).get('需求')).toBe('#12');
    expect(linkedIssue(text, '')).toBe(12);
  });

  it('旧 PR 正文里的旧栏照样认得出边界：「修提醒」「需求」不会把后面紧跟的旧栏吞进去', () => {
    const old = [
      '**需求**：#12',
      '**认领**：引擎',
      '**修提醒**：watchdog:job:backup:after-12',
      '**这个 PR 做完就关单**：否',
      '**对应计划**：v3',
      '对应计划后面不加粗的旧栏：',
      '档位：CI 绿就合',
    ].join('\n');
    const cols = prColumns(old);
    expect(cols.get('需求')).toBe('#12');
    expect(cols.get('认领')).toBe('引擎');
    expect(cols.get('修提醒')).toBe('watchdog:job:backup:after-12');
    expect(cols.get('档位')).toBe('CI 绿就合');
  });
});

describe('PR 挂了哪张单', () => {
  it('「需求」栏先于标题；标题里的 (#号)（全角括号也行）兜底；别的仓的、都没有的不算', () => {
    expect(linkedIssue('**需求**：#12', '加验证码（#77）')).toBe(12);
    expect(linkedIssue('**做了什么**：x', '加验证码（#77）')).toBe(77);
    expect(linkedIssue('**做了什么**：x', '加验证码 (#78)')).toBe(78);
    expect(linkedIssue('**需求**：acme/w#9', '加验证码')).toBeUndefined();
    expect(linkedIssue('**做了什么**：x', '加验证码')).toBeUndefined();
  });

  it('【故意造出的失败】「需求」栏只留着模板提示、写「无」：认不出号，不瞎编', () => {
    expect(linkedIssue('**需求**：<!-- 单号 -->', '')).toBeUndefined();
    expect(linkedIssue('**需求**：无', '')).toBeUndefined();
  });
});
