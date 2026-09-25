import { describe, expect, it } from 'vitest';
import type { GitHubReader, IssueInfo, MilestoneInfo } from '../src/github-api.ts';
import { milestoneCloseCheck } from '../src/milestone-close.ts';

const MILESTONES: MilestoneInfo[] = [
  { number: 1, title: 'P0 地基', state: 'closed' },
  { number: 2, title: 'P1 核心闭环', state: 'open' },
  { number: 3, title: 'P2 驾驶舱 v1', state: 'open' },
];

function item(number: number, extra: Partial<IssueInfo> = {}): IssueInfo {
  return {
    number,
    title: `单 ${number}`,
    state: 'open',
    isPr: false,
    createdAt: '2026-09-25T00:00:00Z',
    labels: ['需求'],
    milestone: 'P1 核心闭环',
    ...extra,
  };
}

function fake(opts: {
  milestones?: MilestoneInfo[] | Error;
  items?: Record<number, IssueInfo[]> | Error;
}): GitHubReader {
  return {
    async openIssues() {
      return [];
    },
    async issue() {
      return undefined;
    },
    async milestones() {
      if (opts.milestones instanceof Error) throw opts.milestones;
      return opts.milestones ?? MILESTONES;
    },
    async openInMilestone(n) {
      if (opts.items instanceof Error) throw opts.items;
      return opts.items?.[n] ?? [];
    },
  };
}

describe('阶段收口：还有开着的就不许关', () => {
  it('P1 认成「P1 核心闭环」；开着的 issue 和 PR 按号列出，退出码 1', async () => {
    const r = await milestoneCloseCheck(
      ['P1'],
      fake({ items: { 2: [item(67, { labels: ['杂项'] }), item(56, { isPr: true, title: '接活入口' })] } }),
    );
    expect(r).toEqual({
      code: 1,
      lines: [
        '「P1 核心闭环」里还有 2 张开着（issue 1 张、PR 1 个），没处置完不许关。每张要么做完关掉，要么挪到后面的里程碑并在单上写明原因：',
        '  #56  PR     [需求] 接活入口',
        '  #67  issue  [杂项] 单 67',
      ],
    });
  });

  it('里面没有开着的：退出码 0；写全名、前面多个 -- 也行', async () => {
    expect(await milestoneCloseCheck(['--', 'P2', '驾驶舱', 'v1'], fake({}))).toEqual({
      code: 0,
      lines: ['「P2 驾驶舱 v1」里没有开着的 issue 和 PR，可以关。'],
    });
  });

  it('里程碑已经关了还有开着的：照样列、照样 1，并注明已经关了', async () => {
    const r = await milestoneCloseCheck(['P0'], fake({ items: { 1: [item(33)] } }));
    expect(r.code).toBe(1);
    expect(r.lines[0]).toContain('（这个里程碑已经关了）');
  });
});

describe('阶段收口：没查成是 2，不当成「里面是空的」', () => {
  it.each([
    ['没给里程碑', [], fake({}), '没查成：没说是哪个里程碑。用法：pnpm milestone:close-check P1'],
    ['给的是参数不是里程碑', ['--all'], fake({}), '没查成：没说是哪个里程碑。'],
    [
      '没有这个里程碑',
      ['P9'],
      fake({}),
      '没查成：没有叫「P9」的里程碑，有的是 P0 地基、P1 核心闭环、P2 驾驶舱 v1。',
    ],
    [
      'P1 对上两个',
      ['P1'],
      fake({ milestones: [...MILESTONES, { number: 9, title: 'P1 旧的', state: 'closed' }] }),
      '没查成：「P1」对上了好几个里程碑（P1 核心闭环、P1 旧的）：写全名。',
    ],
    [
      '读不到里程碑',
      ['P1'],
      fake({ milestones: new Error('连不上 GitHub（fetch failed）') }),
      '没查成：读不到里程碑（连不上 GitHub（fetch failed））。',
    ],
    [
      '读不到里面的单',
      ['P1'],
      fake({ items: new Error('读里程碑里开着的单，GitHub 回了 502') }),
      '没查成：读不到「P1 核心闭环」里开着的单（读里程碑里开着的单，GitHub 回了 502）。',
    ],
  ])('%s', async (_name, argv, gh, line) => {
    const r = await milestoneCloseCheck(argv, gh);
    expect(r.code).toBe(2);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toContain(line);
  });
});
