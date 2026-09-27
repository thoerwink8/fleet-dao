// 开 PR 前验证照哪几条问：单子正文指的需求文档目录、需求文档里「怎么算做完」逐条原文。认不出的一律明确报错，不拿空清单顶。
import { describe, expect, it } from 'vitest';
import { bodyCriteria, criteriaOf, specDirOf, specOf, specShortName } from '../src/criteria.ts';

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

describe('需求文档从哪来：有那一行照它，没有的正文写全了需求也照收（#295）', () => {
  const body = [
    '创始人在 #12（登录页加验证码）的提问里改选了「4 位」。',
    '',
    '## 怎么算做完',
    '',
    '- #12 里按推荐先做的「6 位」改成「4 位」，测试跟着改',
    '- CI 绿，合进主线',
    '',
    '<!-- fleet:issue:abc123 -->',
  ].join('\r\n');

  it('没有那一行、正文有写了字的「怎么算做完」：目录按标题取短名，需求文档照正文写（去掉引擎的标记）', () => {
    const got = specOf({ body, issueNumber: 13, title: '#12 的后续：验证码几位？改成「4 位」' });
    expect(got).toEqual({
      ok: 'specs/13-12的后续验证码几位改成4位',
      requirement: [
        '# #12 的后续：验证码几位？改成「4 位」（#13）',
        '',
        '创始人在 #12（登录页加验证码）的提问里改选了「4 位」。',
        '',
        '## 怎么算做完',
        '',
        '- #12 里按推荐先做的「6 位」改成「4 位」，测试跟着改',
        '- CI 绿，合进主线',
        '',
      ].join('\n'),
    });
    // 照这份写的需求文档，「怎么算做完」和正文里的逐条一样
    const doc = 'ok' in got ? (got.requirement ?? '') : '';
    expect(ok(criteriaOf(doc))).toEqual(ok(bodyCriteria(body)));
    expect(ok(bodyCriteria(body))).toEqual([
      '#12 里按推荐先做的「6 位」改成「4 位」，测试跟着改',
      'CI 绿，合进主线',
    ]);
  });

  it('有那一行的照那一行（不改用正文），也不带需求文档', () => {
    const withPointer = `文档：\`specs/<本单号>-登录验证码/需求.md\`\n\n${body}`;
    expect(specOf({ body: withPointer, issueNumber: 13, title: '随便' })).toEqual({
      ok: 'specs/13-登录验证码',
    });
  });

  it.each([
    [
      '那一行写错了（指的是别的单）：照样报错，不改用正文',
      `文档：\`specs/99-别的/需求.md\`\n\n${body}`,
      /#99 的需求文档/,
    ],
    ['没有那一行、正文没有「怎么算做完」', '原话：给登录页加验证码', /没有指需求文档.*也没写全需求/],
    ['没有那一行、「怎么算做完」是空的', '原话：……\n\n## 怎么算做完\n\n<!-- 还没写 -->\n', /一节是空的/],
  ])('【失败】%s → 明确报错、停下等人', (_name, text, why) => {
    const got = specOf({ body: text, issueNumber: 13, title: '登录页加验证码' });
    expect('error' in got && got.error).toMatch(why);
  });

  it('【失败】开 PR 前照正文核时，正文里的「怎么算做完」被删了或空了：明确报错，不拿空清单去验', () => {
    expect(bodyCriteria('原话：……')).toEqual({ error: '单子正文里没有「## 怎么算做完」一节' });
    expect(bodyCriteria('## 怎么算做完\n\n')).toEqual({ error: '单子正文里「怎么算做完」一节是空的' });
  });

  it('短名：只留字母、数字、汉字，最多 20 个字；一个都不剩写「需求」', () => {
    expect(specShortName('巡检：主线 CI 红了 3 次')).toBe('巡检主线CI红了3次');
    expect(specShortName('一二三四五六七八九十一二三四五六七八九十多出来的')).toBe(
      '一二三四五六七八九十一二三四五六七八九十',
    );
    expect(specShortName('？！…… / \\')).toBe('需求');
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
