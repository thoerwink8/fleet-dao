// PR 正文挂的单和修的提醒（design 15.3「谁在处理」）：PR 镜像照这个记，驾驶舱据此现算「PR 开着 / 合进主线 / 法国已发布」。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FIX_ALERT_COLUMN, fixAlertRefs, prLinks } from '../src/pr-links.ts';

const TEMPLATE = readFileSync(new URL('../../../.github/pull_request_template.md', import.meta.url), 'utf8');

describe('「修提醒」栏', () => {
  it('PR 模板里有这一栏（只留模板提示没填的，就是没写）', () => {
    expect(TEMPLATE).toContain(`**${FIX_ALERT_COLUMN}**：`);
    expect(fixAlertRefs(TEMPLATE)).toEqual([]);
  });

  it('键、编号都认；空白、逗号、顿号隔开；反引号、句末标点去掉；重复的只算一次', () => {
    const body = [
      '**做了什么**：修备份',
      '**修提醒**：`watchdog:job:backup:after-12`、req:acme/fleet-dao#293:park:1, 11111111-2222-4333-8444-555555555555。',
      'watchdog:job:backup:after-12',
      '**这个 PR 做完就关单**：否',
    ].join('\n');
    expect(fixAlertRefs(body)).toEqual([
      'watchdog:job:backup:after-12',
      'req:acme/fleet-dao#293:park:1',
      '11111111-2222-4333-8444-555555555555',
    ]);
  });

  it('不加粗、冒号是英文的也认（模板里的栏名）', () => {
    expect(fixAlertRefs('修提醒: pool-hold:claude-solo\n需求: 无')).toEqual(['pool-hold:claude-solo']);
  });

  it('写「无」「不适用」、没有这一栏：不挂提醒', () => {
    for (const body of ['**修提醒**：无', '**修提醒**：不适用', '**做了什么**：别的', '']) {
      expect(fixAlertRefs(body), body).toEqual([]);
    }
  });
});

describe('挂的单：需求栏（没有再看标题）+ 关单词，只算同仓的', () => {
  it('需求栏、关单词合起来，从小到大、不重复', () => {
    const body = [
      '**需求**：#342',
      '**修提醒**：无',
      'Closes #342',
      'fixes acme/fleet-dao#350',
      'Fixes other/repo#7',
    ].join('\n');
    expect(prLinks({ body, title: 'fix: 修备份' }, 'acme/fleet-dao')).toEqual({
      issues: [342, 350],
      alerts: [],
    });
  });

  it('需求栏没写：看标题里的 (#号)；正文是空的也不出错', () => {
    expect(prLinks({ body: null, title: 'feat: 看门狗（#203）' }, 'acme/fleet-dao')).toEqual({
      issues: [203],
      alerts: [],
    });
  });

  it('标题括号里 #号后面有字：认这一处，不认末尾这个 PR 自己的号', () => {
    expect(
      prLinks({ body: '**需求**：无', title: 'feat: x（#345，创始人 09-28） (#392)' }, 'acme/fleet-dao'),
    ).toEqual({ issues: [345], alerts: [] });
  });

  it('代码块里举例的关单词不算（和合并闸同一个认法）', () => {
    expect(prLinks({ body: '```\nCloses #1\n```\n**需求**：无', title: 'x' }, 'acme/r')).toEqual({
      issues: [],
      alerts: [],
    });
  });
});
