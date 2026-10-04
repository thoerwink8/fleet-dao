// 开 PR 前验证照哪几条问：单子正文指的需求文档目录、需求文档里「怎么算做完」逐条原文。认不出的一律明确报错，不拿空清单顶。
import { describe, expect, it } from 'vitest';
import { cleanBody, criteriaOf, hasSpecPointer, specDirOf } from '../src/criteria.ts';

const ok = <T>(r: { ok: T } | { error: string }): T => {
  if ('error' in r) throw new Error(r.error);
  return r.ok;
};

describe('单子正文指的需求文档目录', () => {
  it('pnpm issue:new 写的占位 <本单号> 换成这张单的号', () => {
    const body = '原话：……\n\n文档：`specs/<本单号>-开PR前验证/需求.md`（完整需求和怎么算做完）\n';
    expect(specDirOf(body, 213)).toEqual({ ok: 'specs/213-开PR前验证' });
  });

  it('已经写成真号的也认', () => {
    expect(specDirOf('文档：specs/12-登录验证码/需求.md', 12)).toEqual({ ok: 'specs/12-登录验证码' });
  });

  it.each([
    ['正文里没有这一行', '原话：给登录页加验证码', /没有指需求文档/],
    ['指的是别的单', '文档：`specs/99-别的/需求.md`', /#99 的需求文档/],
    ['目录名认不出（没有短名）', '文档：`specs/<本单号>/需求.md`', /认不出/],
    ['目录名带上一级', '文档：`specs/<本单号>-../需求.md`', /认不出/],
  ])('【失败】%s → 明确报错', (_name, body, why) => {
    const got = specDirOf(body, 12);
    expect('error' in got && got.error).toMatch(why);
  });
});

describe('「怎么算做完」逐条原文', () => {
  it('一条一个列表项，前后的节不算，照原文（空白压成一个）', () => {
    const md = [
      '# 登录页加验证码（#12）',
      '',
      '## 怎么算做完',
      '',
      '- 过期的验证码登录不了，有 `auth.test.ts` 的测试。',
      '* 错 5 次被锁',
      '1. 日志里搜不到明文密码',
      '',
      '## 现状',
      '',
      '- 未开工。',
    ].join('\n');
    expect(ok(criteriaOf(md))).toEqual([
      '过期的验证码登录不了，有 `auth.test.ts` 的测试。',
      '错 5 次被锁',
      '日志里搜不到明文密码',
    ]);
  });

  it('续行、下一级的小项、隔一个空行缩进着写的都并进上一条；没写成列表的一段话也算一条；重复的只留一条', () => {
    const md = [
      '## 怎么算做完（原文）',
      '以下都要有测试：',
      '- 本机：账密能登进驾驶舱，',
      '  会话和飞书登录一样',
      '  - 错 5 次被锁',
      '',
      '  锁期内正确密码也进不去',
      '- 本机：账密能登进驾驶舱， 会话和飞书登录一样 - 错 5 次被锁 锁期内正确密码也进不去',
      '<!-- 写给人看的提示，不算一条 -->',
      '### 法国真机',
      '- 发布后改一次密码',
      '```',
      'set-password founder',
      '```',
    ].join('\r\n');
    expect(ok(criteriaOf(md))).toEqual([
      '以下都要有测试：',
      '本机：账密能登进驾驶舱， 会话和飞书登录一样 - 错 5 次被锁 锁期内正确密码也进不去',
      '发布后改一次密码 set-password founder',
    ]);
  });

  it('pnpm issue:new 写出来的真样子（specs/169 的一节原样抄来：标题前后有空行、条目里带括号和单号）', () => {
    const md = [
      '# Fusion 形态（#169）',
      '',
      '对应计划：v1 Fusion 接活',
      '',
      '## 怎么算做完',
      '',
      '- 七题都有创始人拍的结论，记在上面，并汇总进 design 正文、旧说法一并改掉；要改的通用规矩和 discuss skill 那个 PR 合了（人闸：改标准）。',
      '- （2026-09-26 晚挪到母单 #193「Fusion 第一道门」，这张单只管定稿）实施后：fleet-dao 连续 10 张真单，至少 8 张没人插手做完。',
      '',
      '## 现状',
      '',
      '未开工。',
      '',
    ].join('\n');
    expect(ok(criteriaOf(md))).toEqual([
      '七题都有创始人拍的结论，记在上面，并汇总进 design 正文、旧说法一并改掉；要改的通用规矩和 discuss skill 那个 PR 合了（人闸：改标准）。',
      '（2026-09-26 晚挪到母单 #193「Fusion 第一道门」，这张单只管定稿）实施后：fleet-dao 连续 10 张真单，至少 8 张没人插手做完。',
    ]);
  });

  it.each([
    ['没有这一节', '# 标题\n\n## 要什么\n- 做个页面\n', /没有「## 怎么算做完」/],
    ['这一节是空的', '## 怎么算做完\n\n<!-- 还没写 -->\n\n## 现状\n- 未开工\n', /是空的/],
    ['只在代码块里提到', '```\n## 怎么算做完\n- 一条\n```\n', /没有「## 怎么算做完」/],
  ])('【失败】%s → 明确报错，不回空清单', (_name, md, why) => {
    const got = criteriaOf(md);
    expect('error' in got && got.error).toMatch(why);
  });
});

describe('hasSpecPointer / cleanBody（派活读交代时用，#632 S2-1）', () => {
  it('正文里有指需求文档的那一行（占位或真号都算）才是 true；没有、或只提到 specs/ 不算', () => {
    expect(hasSpecPointer('概述。\n\n文档：`specs/<本单号>-短名/需求.md`（完整需求）')).toBe(true);
    expect(hasSpecPointer('文档：`specs/12-短名/需求.md`')).toBe(true);
    expect(hasSpecPointer('## 场景\n\n正文自己写全了。')).toBe(false);
    expect(hasSpecPointer('见 specs/12-短名/需求.md')).toBe(false);
  });

  it('指错了（别的单的）是另一回事：hasSpecPointer 仍是 true，由 specDirOf 报错', () => {
    const body = '文档：`specs/99-别的单/需求.md`';
    expect(hasSpecPointer(body)).toBe(true);
    expect('error' in specDirOf(body, 7)).toBe(true);
  });

  it('cleanBody：去 BOM、统一换行、去 HTML 注释、压空行、掐头尾', () => {
    expect(cleanBody('﻿\r\n甲\r\n\r\n\r\n\r\n<!-- 提示 -->乙\r\n')).toBe('甲\n\n乙');
  });
});
