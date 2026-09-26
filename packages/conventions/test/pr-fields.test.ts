import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseMd } from '../src/markdown.ts';
import { planPhases } from '../src/plan.ts';
import {
  annotation,
  checkPlanValue,
  checkPrFields,
  PR_COLUMNS,
  type PrFacts,
  prColumns,
  prFromEvent,
  type RepoFacts,
  specsPaths,
} from '../src/pr-fields.ts';

const PLAN = [
  '# 计划',
  '',
  '## 三、分阶段',
  '',
  '### P0 地基（约 6 小时）',
  '',
  '- 仓骨架：pnpm、CI。',
  '',
  '**验收**：装两遍。',
  '',
  '### P1 核心闭环（约 12 小时）',
  '',
  '- 工作流：需求、子任务。',
  '- 错误按「下一步动作」分流、路由熔断。',
  '',
].join('\n');

const SPECS = new Set(['specs', 'specs/12-登录验证码', 'specs/12-登录验证码/需求.md']);
const repo: RepoFacts = { phases: planPhases(parseMd('docs/plan.md', PLAN)), exists: (p) => SPECS.has(p) };
const TEMPLATE = readFileSync(new URL('../../../.github/pull_request_template.md', import.meta.url), 'utf8');

function body(plan: string | null, specs: string | null): string {
  return [
    '**做了什么**：',
    '- 加了验证码',
    '**需求**：#12',
    ...(plan === null ? [] : [`**对应计划**：${plan}`]),
    ...(specs === null ? [] : [`**specs**：${specs}`]),
    '**档位**：直接合——只加了一个输入框',
    '**文档**：不适用',
  ].join('\n');
}

const good: PrFacts = {
  labels: ['需求', '界面'],
  milestone: 'P1 核心闭环',
  body: body('P1「工作流」', 'specs/12-登录验证码/'),
};
const check = (over: Partial<PrFacts>) => checkPrFields({ ...good, ...over }, repo);

describe('PR 必填栏：齐了就过', () => {
  it('一个类别标签（别的标签随便）、挂了里程碑、对应计划和 specs 都写对', () => {
    expect(check({})).toEqual([]);
  });

  it('对应计划的几种写法：带 plan.md、隔「的」、跨两条、引号里套引号、另起一行写', () => {
    for (const plan of [
      'plan.md P1「工作流」',
      'P1 的「工作流」',
      'P0「验收」、P1「错误按「下一步动作」分流」',
      '\n- P1「路由熔断」',
    ]) {
      expect(check({ body: body(plan, 'specs/12-登录验证码/') }), plan).toEqual([]);
    }
  });

  it('specs 的几种写法：「不适用」、反引号、链接、指到里面的文件', () => {
    for (const specs of [
      '不适用',
      '不适用（杂活）',
      '`specs/12-登录验证码/`',
      '[specs/12-登录验证码/](https://github.com/o/r/tree/main/specs/12-登录验证码)',
      'specs/12-登录验证码/需求.md',
    ]) {
      expect(check({ body: body('P1「工作流」', specs) }), specs).toEqual([]);
    }
  });

  it('栏的几种写法都认：**对应计划**：、**对应计划：**、不加粗的「对应计划：」（#39、#46 这么写）、列表里的、英文冒号、Specs 大写', () => {
    for (const text of [
      '**对应计划**：P1「工作流」\n**specs**：不适用\n**档位**：直接合（纯文档）',
      '**对应计划：** P1「工作流」\n**specs：** 不适用\n**档位：** 先合后看——一般改动',
      '对应计划：plan.md P1「工作流」（本 PR 新加这一条）\nspecs：`specs/12-登录验证码/`\n档位：先审后合，碰了引擎核心',
      '- 对应计划：P1「工作流」\n- specs：不适用\n- 档位：`直接合` 只改测试',
      '**对应计划**: P1「工作流」\nSpecs: 不适用\n档位: 直接合 - 纯文档',
    ]) {
      expect(check({ body: text }), text).toEqual([]);
    }
  });

  it('不加粗时只认模板里的栏名：正文里带冒号的一句话不会把上一栏截断', () => {
    const cols = prColumns('对应计划：\nP1「工作流」：先跑通\n注意：跨两条\nspecs：不适用');
    expect(cols.get('对应计划')).toBe('P1「工作流」：先跑通\n注意：跨两条');
    expect(cols.get('specs')).toBe('不适用');
    expect([...cols.keys()]).toEqual(['对应计划', 'specs']);
  });

  it('栏写在正文开头、后面分了小标题：小标题截断上一栏，各节里提到的 specs 路径不当成 specs 这一栏', () => {
    const text = [
      '对应计划：P1「工作流」',
      'specs：specs/12-登录验证码/',
      '档位：直接合——只改文档',
      '',
      '## 改了什么',
      '- `specs/99-别的/需求.md`：顺带提一句',
    ].join('\n');
    expect(prColumns(text).get('specs')).toBe('specs/12-登录验证码/');
    expect(check({ body: text })).toEqual([]);
  });

  it('specs 路径后面紧跟全角冒号、句号：只取路径', () => {
    for (const specs of ['`specs/12-登录验证码/需求.md`：照 #12 抄。', 'specs/12-登录验证码/。']) {
      expect(check({ body: body('P1「工作流」', specs) }), specs).toEqual([]);
    }
  });

  it('不加粗认的栏名就是 PR 模板里的那几栏，顺序也一样', () => {
    expect([...prColumns(TEMPLATE).keys()]).toEqual([...PR_COLUMNS]);
  });

  it('specsPaths 取出的路径和 specs 一栏认的一样（合并闸先按它去 GitHub 上问在不在）', () => {
    expect(
      specsPaths('`specs/12-登录验证码/`、[specs/13-x/](https://github.com/o/r/tree/main/specs/13-x)。'),
    ).toEqual(['specs/12-登录验证码/', 'specs/13-x/']);
    expect(specsPaths('不适用')).toEqual([]);
  });
});

describe('PR 必填栏：缺一样报一句，说清缺什么、怎么补', () => {
  const cases: [name: string, over: Partial<PrFacts>, message: string][] = [
    [
      '没贴类别标签',
      { labels: ['界面'] },
      '没贴类别标签：在 PR 右边的 Labels 里从「需求」「缺陷」「杂项」里挑一个贴上。',
    ],
    ['贴了两个类别标签', { labels: ['需求', '缺陷'] }, '类别标签贴了 2 个（需求、缺陷）：只留一个。'],
    ['没挂里程碑', { milestone: null }, '没挂里程碑：在 PR 右边的 Milestone 里挑这块活属于的阶段（P0–P1）。'],
    [
      '里程碑不是阶段',
      { milestone: '以后再说' },
      '里程碑「以后再说」认不出是哪个阶段：换成 plan.md 的阶段（P0–P1）之一。',
    ],
    [
      '里程碑的阶段 plan 里没有',
      { milestone: 'P9 以后' },
      '里程碑「P9 以后」的 P9 在 plan.md 里没有：换成 P0–P1 之一。',
    ],
    [
      '没有对应计划这一栏',
      { body: body(null, '不适用') },
      '正文里认不出「对应计划」一栏：要写成 对应计划：P1「工作流」（单独起一行；plan.md 的阶段加那一条的原话开头）。',
    ],
    [
      '对应计划写在一句话中间，认不出这一栏',
      { body: `这次的对应计划：P1「工作流」\n${body(null, '不适用')}` },
      '正文里认不出「对应计划」一栏：要写成 对应计划：P1「工作流」（单独起一行；plan.md 的阶段加那一条的原话开头）。',
    ],
    [
      '对应计划只留着模板提示',
      { body: body('<!-- 阶段加条目 -->', '不适用') },
      '「对应计划」一栏是空的：写 plan.md 的阶段加那一条的原话开头，比如 P1「工作流」。',
    ],
    [
      '对应计划写的认不出',
      { body: body('plan.md 的核心闭环', '不适用') },
      '「对应计划」写的「plan.md 的核心闭环」认不出是 plan.md 哪一条：要写成 对应计划：P1「工作流」，阶段加那一条的原话开头。',
    ],
    [
      '只写了阶段',
      { body: body('P1（工作流）', '不适用') },
      '「对应计划」的 P1 没写是哪一条：后面加上那一条的原话开头，比如 P1「工作流」。',
    ],
    [
      '引号是空的',
      { body: body('P1「」', '不适用') },
      '「对应计划」的 P1「」 引号里是空的：写上 P1 里那一条的原话开头，比如 P1「工作流」。',
    ],
    [
      '阶段不在',
      { body: body('P1「工作流」、P7「上线」', '不适用') },
      '「对应计划」的 P7「上线」 在 plan.md 里没有 P7 这个阶段：阶段只有 P0–P1。',
    ],
    [
      '条目不在那个阶段里',
      { body: body('P1「看板」', '不适用') },
      '「对应计划」的 P1「看板」 在 plan.md 的 P1 一节里找不到：照抄那一条的原话（开头几个字就行）。',
    ],
    [
      '里程碑和对应计划不是一个阶段',
      { milestone: 'P0 地基' },
      '里程碑是 P0，「对应计划」里却没有 P0 的条目：改里程碑，或在「对应计划」里写上 P0 的哪一条。',
    ],
    [
      '没有 specs 这一栏',
      { body: body('P1「工作流」', null) },
      '正文里认不出「specs」一栏：要写成 specs：specs/<号>-<短名>/（单独起一行），杂活写 specs：不适用。',
    ],
    [
      'specs 是空的',
      { body: body('P1「工作流」', '<!-- 需求目录 -->') },
      '「specs」一栏是空的：写需求文档的目录（specs/<号>-<短名>/），杂活写「不适用」。',
    ],
    [
      'specs 写的不是目录',
      { body: body('P1「工作流」', '见 issue') },
      '「specs」写的「见 issue」不是 specs/ 下的需求目录：写成 specs/<号>-<短名>/，杂活写「不适用」。',
    ],
    [
      'specs 目录在这个 PR 里没有',
      { body: body('P1「工作流」', 'specs/99-没建/') },
      '「specs」写的 specs/99-没建/ 在这个 PR 里没有：先把需求.md 放进去，或者改成已有的目录。',
    ],
    [
      'specs 往上跳出去',
      { body: body('P1「工作流」', 'specs/12-登录验证码/../../docs') },
      '「specs」写的 specs/12-登录验证码/../../docs 在这个 PR 里没有：先把需求.md 放进去，或者改成已有的目录。',
    ],
  ];

  it.each(cases)('%s', (_name, over, message) => {
    expect(check(over)).toEqual([message]);
  });

  it('全缺：五样各一句，按标签、里程碑、对应计划、specs、档位的顺序', () => {
    const problems = checkPrFields({ labels: [], milestone: null, body: '' }, repo);
    expect(problems.map((p) => p.slice(0, p.indexOf('：')))).toEqual([
      '没贴类别标签',
      '没挂里程碑',
      '正文里认不出「对应计划」一栏',
      '正文里认不出「specs」一栏',
      '正文里认不出「档位」一栏',
    ]);
    for (const p of problems) expect(p).not.toContain('\n');
  });

  it('没写档位：说清怎么写（三档、跟理由、拿不准写先审后合）', () => {
    const noTier = good.body.replace(/\*\*档位\*\*：.*\n/, '');
    expect(check({ body: noTier })).toEqual([
      '正文里认不出「档位」一栏：要写成 档位：CI 绿就合——理由（单独起一行；两档是「CI 绿就合」「先审后合」，见 design 第五节，拿不准写「先审后合」）。',
    ]);
  });

  it('照仓里的 PR 模板开、一个字没填：三栏都在，都判成空的（模板提示不算填了）', () => {
    expect(check({ body: TEMPLATE })).toEqual([
      '「对应计划」一栏是空的：写 plan.md 的阶段加那一条的原话开头，比如 P1「工作流」。',
      '「specs」一栏是空的：写需求文档的目录（specs/<号>-<短名>/），杂活写「不适用」。',
      '「档位」一栏是空的：写「CI 绿就合」「先审后合」之一，后面跟理由（拿不准写「先审后合」）。',
    ]);
  });
});

describe('只核「对应计划」一栏的值（引擎收需求文档时用，和 PR 上判的同一套）', () => {
  it('对得上 plan.md 的条目就没问题；带不带 plan.md 前缀、跨两条都认', () => {
    expect(checkPlanValue('plan.md P1「工作流」', PLAN)).toEqual([]);
    expect(checkPlanValue('P0「仓骨架」、P1「错误按」', PLAN)).toEqual([]);
  });

  it('认不出、没写哪一条、引号空着、条目不在、阶段不在：各报一句', () => {
    expect(checkPlanValue('plan.md P0 的验收', PLAN)).toEqual([expect.stringContaining('P0 没写是哪一条')]);
    expect(checkPlanValue('P1「」', PLAN)).toEqual([expect.stringContaining('引号里是空的')]);
    expect(checkPlanValue('P1「没有这一条」', PLAN)).toEqual([expect.stringContaining('找不到')]);
    expect(checkPlanValue('P9「工作流」', PLAN)).toEqual([expect.stringContaining('没有 P9 这个阶段')]);
    expect(checkPlanValue('无', PLAN)).toEqual([expect.stringContaining('认不出是 plan.md 哪一条')]);
  });

  it('plan.md 里一个阶段都认不出：算一条问题，不当成过了', () => {
    expect(checkPlanValue('P1「工作流」', '# 计划\n\n没有阶段标题')).toEqual([
      expect.stringContaining('一个阶段'),
    ]);
  });
});

describe('从事件或读回来的 PR 里取必填栏要的东西', () => {
  const pr = {
    number: 33,
    labels: [{ name: '杂项' }],
    milestone: { title: 'P0 地基' },
    body: body('P0「仓骨架」', '不适用'),
  };

  it('取出 PR 号、标签、里程碑、正文；正文是 null 当成空的', () => {
    expect(prFromEvent({ pull_request: pr })).toEqual({
      number: 33,
      labels: ['杂项'],
      milestone: 'P0 地基',
      body: pr.body,
    });
    expect(prFromEvent({ pull_request: { ...pr, milestone: null, body: null } })).toMatchObject({
      milestone: null,
      body: '',
    });
  });

  it('认不出的说为什么，不当成「什么都没贴」', () => {
    expect(prFromEvent({ issue: {} })).toBe('事件里没有 pull_request（这条检查只接 pull_request 事件）');
    expect(prFromEvent({ pull_request: { ...pr, labels: 'x' } })).toBe(
      'pull_request.labels 认不出（应当是带 name 的列表）',
    );
    expect(prFromEvent({ pull_request: { ...pr, milestone: 'P0' } })).toBe(
      'pull_request.milestone 认不出（应当是 null 或带 title 的对象）',
    );
  });
});

describe('Actions 注解', () => {
  it('报错是 error、提醒是 warning；% 和换行转义掉', () => {
    expect(annotation('缺了 100%\n第二行')).toBe('::error::缺了 100%25%0A第二行');
    expect(annotation('提醒：没贴类别标签', 'warning')).toBe('::warning::提醒：没贴类别标签');
  });
});
