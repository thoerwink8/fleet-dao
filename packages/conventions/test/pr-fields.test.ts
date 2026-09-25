import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMd } from '../src/markdown.ts';
import { planPhases } from '../src/plan.ts';
import {
  annotation,
  checkPrFields,
  type PrFacts,
  prColumns,
  prFromEvent,
  type RepoFacts,
  runPrFields,
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

function body(plan: string | null, specs: string | null): string {
  return [
    '**做了什么**：',
    '- 加了验证码',
    '**需求**：#12',
    ...(plan === null ? [] : [`**对应计划**：${plan}`]),
    ...(specs === null ? [] : [`**specs**：${specs}`]),
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

  it('specs 的几种写法：「不适用」、反引号、链接、指到里面的文件、标题大小写不论', () => {
    for (const specs of [
      '不适用',
      '不适用（杂活）',
      '`specs/12-登录验证码/`',
      '[specs/12-登录验证码/](https://github.com/o/r/tree/main/specs/12-登录验证码)',
      'specs/12-登录验证码/需求.md',
    ]) {
      expect(check({ body: body('P1「工作流」', specs) }), specs).toEqual([]);
    }
    expect(check({ body: `**对应计划**: P1「工作流」\n**Specs**: 不适用` })).toEqual([]);
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
      '正文没有「对应计划」一栏：照 PR 模板加一行 **对应计划**：P1「工作流」（plan.md 的阶段加那一条的原话开头）。',
    ],
    [
      '对应计划只留着模板提示',
      { body: body('<!-- 阶段加条目 -->', '不适用') },
      '「对应计划」一栏是空的：写 plan.md 的阶段加那一条的原话开头，比如 P1「工作流」。',
    ],
    [
      '对应计划写的认不出',
      { body: body('plan.md 的核心闭环', '不适用') },
      '「对应计划」写的「plan.md 的核心闭环」认不出是 plan.md 哪一条：写成 P1「工作流」这样，阶段加那一条的原话开头。',
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
      '正文没有「specs」一栏：照 PR 模板加一行 **specs**：specs/<号>-<短名>/，杂活写「不适用」。',
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

  it('全缺：四样各一句，按标签、里程碑、对应计划、specs 的顺序', () => {
    const problems = checkPrFields({ labels: [], milestone: null, body: '' }, repo);
    expect(problems.map((p) => p.slice(0, p.indexOf('：')))).toEqual([
      '没贴类别标签',
      '没挂里程碑',
      '正文没有「对应计划」一栏',
      '正文没有「specs」一栏',
    ]);
    for (const p of problems) expect(p).not.toContain('\n');
  });

  it('照仓里的 PR 模板开、一个字没填：两栏都在，都判成空的（模板提示不算填了）', () => {
    const template = readFileSync(
      new URL('../../../.github/pull_request_template.md', import.meta.url),
      'utf8',
    );
    const cols = prColumns(template);
    expect([...cols.keys()]).toEqual(expect.arrayContaining(['对应计划', 'specs']));
    expect(check({ body: template })).toEqual([
      '「对应计划」一栏是空的：写 plan.md 的阶段加那一条的原话开头，比如 P1「工作流」。',
      '「specs」一栏是空的：写需求文档的目录（specs/<号>-<短名>/），杂活写「不适用」。',
    ]);
  });
});

describe('PR 事件', () => {
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

  it('认不出的事件说为什么，不当成「什么都没贴」', () => {
    expect(prFromEvent({ issue: {} })).toBe('事件里没有 pull_request（这条检查只接 pull_request 事件）');
    expect(prFromEvent({ pull_request: { ...pr, labels: 'x' } })).toBe(
      'pull_request.labels 认不出（应当是带 name 的列表）',
    );
    expect(prFromEvent({ pull_request: { ...pr, milestone: 'P0' } })).toBe(
      'pull_request.milestone 认不出（应当是 null 或带 title 的对象）',
    );
  });

  function tempRepo(plan: string | undefined): string {
    const root = mkdtempSync(join(tmpdir(), 'fleet-pr-fields-'));
    if (plan !== undefined) {
      mkdirSync(join(root, 'docs'));
      writeFileSync(join(root, 'docs', 'plan.md'), plan);
    }
    mkdirSync(join(root, 'specs', '12-登录验证码'), { recursive: true });
    return root;
  }
  function eventFile(event: unknown): string {
    const path = join(mkdtempSync(join(tmpdir(), 'fleet-pr-event-')), 'event.json');
    writeFileSync(path, typeof event === 'string' ? event : JSON.stringify(event));
    return path;
  }

  it('退出码：齐了 0，缺了 1（每样一行）', () => {
    const root = tempRepo(PLAN);
    expect(runPrFields({ eventPath: eventFile({ pull_request: pr }), root })).toEqual({
      code: 0,
      lines: ['PR #33：类别标签、里程碑、对应计划、specs 都齐了。'],
    });
    const bad = runPrFields({ eventPath: eventFile({ pull_request: { ...pr, labels: [] } }), root });
    expect(bad).toEqual({ code: 1, lines: [expect.stringMatching(/^没贴类别标签/)] });
  });

  it('没查成都是 2：没有事件路径、文件读不到、不是 JSON、不是 PR 事件、plan.md 读不到或认不出阶段', () => {
    const root = tempRepo(PLAN);
    const runs = [
      runPrFields({ eventPath: undefined, root }),
      runPrFields({ eventPath: join(root, 'nope.json'), root }),
      runPrFields({ eventPath: eventFile('{不是 json'), root }),
      runPrFields({ eventPath: eventFile({ issue: {} }), root }),
      runPrFields({ eventPath: eventFile({ pull_request: pr }), root: tempRepo(undefined) }),
      runPrFields({ eventPath: eventFile({ pull_request: pr }), root: tempRepo('# 计划\n\n没有阶段。\n') }),
    ];
    for (const r of runs) {
      expect(r.code).toBe(2);
      expect(r.lines[0]).toMatch(/^没查成：/);
    }
  });

  it('报错注解里的 % 和换行转义掉', () => {
    expect(annotation('缺了 100%\n第二行')).toBe('::error::缺了 100%25%0A第二行');
  });
});
