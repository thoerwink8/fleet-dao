import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GitHubPrLabeler, GitHubReader, IssueInfo, MilestoneInfo, PullInfo } from '../src/github-api.ts';
import { linkedIssue, type PrState, planLabels, runPrLabels, titlePrefixKind } from '../src/pr-labels.ts';

const body = (issue: string) => `**做了什么**：x\n\n**需求**：${issue}\n\n**对应计划**：P1「工作流」\n`;

function pr(extra: Partial<PrState> = {}): PullInfo {
  return { number: 100, title: 'feat: x', body: body('#74'), labels: [], milestone: null, ...extra };
}

function issue(extra: Partial<IssueInfo> = {}): IssueInfo {
  return {
    number: 74,
    title: '合并闸',
    state: 'open',
    isPr: false,
    createdAt: '2026-09-25T00:00:00Z',
    labels: ['杂项', '要人看'],
    milestone: 'P1 核心闭环',
    ...extra,
  };
}

describe('认对应的 issue', () => {
  it('先看正文「需求」栏；模板注释不算', () => {
    expect(linkedIssue(body('#74'), 'x (#9)')).toBe(74);
    expect(linkedIssue(body('#74、#85'), '')).toBe(74);
    expect(linkedIssue('**需求**：<!-- issue 的 #号 -->#12\n', '')).toBe(12);
  });

  it('栏里没有号（「无」、只有注释、别的仓的号）：看标题里的 (#号)，全角括号也算', () => {
    expect(linkedIssue(body('无'), 'feat: x（#43）')).toBe(43);
    expect(linkedIssue('**需求**：<!-- issue 的 #号 -->\n', 'fix: y (#67)')).toBe(67);
    expect(linkedIssue(body('o/r#5'), 'z (#8)')).toBe(8);
  });

  it('都没有：undefined；标题里不带括号的 #号不算', () => {
    expect(linkedIssue(body('无'), 'feat: x #43')).toBeUndefined();
    expect(linkedIssue('', '')).toBeUndefined();
  });
});

/** 大多数测试用不到里程碑列表：给个含当前版本的默认值，要测「没有当前版本」的用例自己传 []。 */
const OPEN_MILESTONES = [{ number: 2, title: 'v1 Fusion 接活' }];

describe('要补什么', () => {
  it('缺类别和里程碑：照抄 issue 的；issue 上别的标签不抄', () => {
    expect(planLabels(pr(), 74, issue(), OPEN_MILESTONES)).toEqual({
      issue: 74,
      addLabel: '杂项',
      labelSource: 'issue',
      milestone: 'P1 核心闭环',
      milestoneSource: 'issue',
      notes: [],
    });
  });

  it('PR 已有的不动：有类别不补标签，有里程碑不补里程碑', () => {
    const p = planLabels(pr({ labels: ['需求'], milestone: 'P2 驾驶舱' }), 74, issue(), OPEN_MILESTONES);
    expect(p).toMatchObject({ addLabel: undefined, milestone: undefined, notes: [] });
    expect(planLabels(pr({ labels: ['缺陷'] }), 74, issue(), OPEN_MILESTONES)).toMatchObject({
      addLabel: undefined,
      milestone: 'P1 核心闭环',
      milestoneSource: 'issue',
    });
  });

  it('issue 自己也没有：提醒两边都贴；有好几个类别：不猜（有效的对应 issue 存在，不落到按标题猜那条路）', () => {
    const none = planLabels(pr(), 74, issue({ labels: ['要人看'], milestone: null }), OPEN_MILESTONES);
    expect(none).toMatchObject({ addLabel: undefined, milestone: undefined });
    expect(none.notes).toEqual([
      expect.stringContaining('自己也没有，请两边都贴上'),
      expect.stringContaining('自己也没有，请两边都挂上'),
    ]);
    const many = planLabels(
      pr({ milestone: 'P1 核心闭环' }),
      74,
      issue({ labels: ['需求', '缺陷'] }),
      OPEN_MILESTONES,
    );
    expect(many.addLabel).toBeUndefined();
    expect(many.notes[0]).toContain('有好几个类别标签（需求、缺陷）');
  });
});

describe('titlePrefixKind：PR 标题前缀猜类别', () => {
  it.each([
    ['fix: 修好', '缺陷'],
    ['fix(engine): 修好', '缺陷'],
    ['fix!: 修好', '缺陷'],
    ['feat: 加个东西', '需求'],
    ['feature(web): 加个东西', '需求'],
    ['docs: 补文档', '杂项'],
    ['chore(deps): 升级', '杂项'],
    ['test: 补测试', '杂项'],
    ['refactor: 改改', '杂项'],
    ['std(commander-seat): 改规矩', '杂项'],
  ])('%s → %s', (title, kind) => {
    expect(titlePrefixKind(title)).toBe(kind);
  });

  it('认不出前缀（没有冒号、纯中文一句话）：undefined，不猜', () => {
    expect(titlePrefixKind('提醒减负：删提醒派单整层')).toBeUndefined();
    expect(titlePrefixKind('随手改了一下')).toBeUndefined();
  });
});

describe('没有有效的对应 issue：按标题猜类别、挂当前版本（#448，替掉 #425「没有就只提醒」）', () => {
  it('没找到对应 issue 的 #号：标题能猜出类别、有当前版本——都补上，不提醒', () => {
    const p = planLabels(
      pr({ body: body('无'), title: 'fix: 修一下' }),
      undefined,
      undefined,
      OPEN_MILESTONES,
    );
    expect(p).toEqual({
      issue: undefined,
      addLabel: '缺陷',
      labelSource: 'title',
      milestone: 'v1 Fusion 接活',
      milestoneSource: 'current-version',
      notes: [],
    });
  });

  it('标题猜不出类别：提醒手动贴，里程碑照样能挂', () => {
    const p = planLabels(
      pr({ body: body('无'), title: '随手改了一下' }),
      undefined,
      undefined,
      OPEN_MILESTONES,
    );
    expect(p.addLabel).toBeUndefined();
    expect(p.milestone).toBe('v1 Fusion 接活');
    expect(p.notes).toEqual([expect.stringContaining('标题看不出 fix/feat 这类常见前缀')]);
  });

  it('现在没有还开着的 v<N> 里程碑：类别照样能猜，里程碑提醒手动挂，不猜', () => {
    const p = planLabels(pr({ body: body('无'), title: 'feat: 加个东西' }), undefined, undefined, []);
    expect(p.addLabel).toBe('需求');
    expect(p.milestone).toBeUndefined();
    expect(p.notes).toEqual([expect.stringContaining('现在也没有还开着的 v<N> 里程碑')]);
  });

  it('号在 GitHub 上没有、是个 PR、是这个 PR 自己：都算「没有有效的对应 issue」，一样走标题/当前版本这条路', () => {
    expect(planLabels(pr({ title: 'fix: x' }), 74, undefined, OPEN_MILESTONES).addLabel).toBe('缺陷');
    expect(planLabels(pr({ title: 'fix: x' }), 74, issue({ isPr: true }), OPEN_MILESTONES).addLabel).toBe(
      '缺陷',
    );
    expect(planLabels(pr({ title: 'fix: x' }), 100, undefined, OPEN_MILESTONES).addLabel).toBe('缺陷');
  });
});

/** 假 GitHub：记下读了、写了什么；某一步可以故意出错。 */
function fakeGh(opts: {
  pull?: PullInfo | Error;
  issue?: IssueInfo | undefined | Error;
  milestones?: MilestoneInfo[] | Error;
  labelsAfter?: string[] | Error;
  milestoneAfter?: string | null | Error;
}) {
  const writes: string[] = [];
  const reads: string[] = [];
  const give = <T>(v: T | Error): Promise<T> => (v instanceof Error ? Promise.reject(v) : Promise.resolve(v));
  const gh: GitHubReader & GitHubPrLabeler = {
    openIssues: () => Promise.reject(new Error('不该读')),
    openInMilestone: () => Promise.reject(new Error('不该读')),
    pull: (n) => {
      reads.push(`pull ${n}`);
      return give(opts.pull ?? { ...pr(), number: n });
    },
    issue: (n) => {
      reads.push(`issue ${n}`);
      return give('issue' in opts ? opts.issue : issue({ number: n }));
    },
    milestones: () => give(opts.milestones ?? [{ number: 2, title: 'P1 核心闭环', state: 'open' as const }]),
    addLabel: (n, name) => {
      writes.push(`label ${n} ${name}`);
      return give(opts.labelsAfter ?? [name]);
    },
    setMilestone: (n, m) => {
      writes.push(`milestone ${n} ${m}`);
      return give(opts.milestoneAfter === undefined ? 'P1 核心闭环' : opts.milestoneAfter);
    },
  };
  return { gh, writes, reads };
}

function eventFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'pr-labels-'));
  const path = join(dir, 'event.json');
  writeFileSync(path, content);
  return path;
}
const EVENT = eventFile(JSON.stringify({ pull_request: { number: 100, labels: [{ name: '需求' }] } }));

describe('跑一遍（读、补、核对 GitHub 回的）', () => {
  it('按 PR 现在的样子补（不看事件里的标签），补完核对 GitHub 回的', async () => {
    const { gh, writes, reads } = fakeGh({});
    const r = await runPrLabels({ eventPath: EVENT, gh });
    expect(r.code).toBe(0);
    expect(reads).toEqual(['pull 100', 'issue 74']);
    expect(writes).toEqual(['label 100 杂项', 'milestone 100 2']);
    expect(r.lines).toEqual([
      'PR #100 补上类别标签「杂项」（照抄 #74）。',
      'PR #100 补上里程碑「P1 核心闭环」（照抄 #74）。',
    ]);
  });

  it('都有了：不读 issue、不写', async () => {
    const { gh, writes, reads } = fakeGh({ pull: pr({ labels: ['杂项'], milestone: 'P1 核心闭环' }) });
    const r = await runPrLabels({ eventPath: EVENT, gh });
    expect(r).toMatchObject({ code: 0, notes: [] });
    expect(reads).toEqual(['pull 100']);
    expect(writes).toEqual([]);
  });

  it('试跑：只说要补什么，不写', async () => {
    const { gh, writes } = fakeGh({});
    const r = await runPrLabels({ eventPath: EVENT, gh, dryRun: true });
    expect(writes).toEqual([]);
    expect(r.lines[0]).toContain('（试跑，没写）');
  });

  it('找不到对应 issue、标题猜不出类别、里程碑列表里没有当前版本：两条都提醒，不失败、不写', async () => {
    const { gh, writes } = fakeGh({ pull: pr({ body: body('无'), title: '随手改的' }) });
    const r = await runPrLabels({ eventPath: EVENT, gh });
    expect(r.code).toBe(0);
    expect(writes).toEqual([]);
    expect(r.notes).toHaveLength(2);
  });

  it('找不到对应 issue，但标题猜得出类别、里程碑列表里有当前版本：按标题贴、挂当前版本（#448）', async () => {
    const { gh, writes } = fakeGh({
      pull: pr({ body: body('无'), title: 'fix: 修一下' }),
      milestones: [{ number: 3, title: 'v1 Fusion 接活', state: 'open' as const }],
      milestoneAfter: 'v1 Fusion 接活',
    });
    const r = await runPrLabels({ eventPath: EVENT, gh });
    expect(r.code).toBe(0);
    expect(writes).toEqual(['label 100 缺陷', 'milestone 100 3']);
    expect(r.lines).toEqual([
      'PR #100 补上类别标签「缺陷」（按标题猜的）。',
      'PR #100 补上里程碑「v1 Fusion 接活」（挂当前版本）。',
    ]);
    expect(r.notes).toEqual([]);
  });

  it('issue 读不到（接口出错）：判没补成，不当成没有这张单', async () => {
    const { gh, writes } = fakeGh({ issue: new Error('读 #74 ，GitHub 回了 502') });
    const r = await runPrLabels({ eventPath: EVENT, gh });
    expect(r.code).toBe(2);
    expect(r.lines).toEqual(['没补成：读不到对应的 #74（读 #74 ，GitHub 回了 502）。']);
    expect(writes).toEqual([]);
  });

  it('PR 读不到：没补成', async () => {
    const r = await runPrLabels({ eventPath: EVENT, gh: fakeGh({ pull: new Error('GitHub 回了 500') }).gh });
    expect(r).toMatchObject({ code: 2, lines: ['没补成：读不到 PR #100 现在的样子（GitHub 回了 500）。'] });
  });

  it('写标签出错、GitHub 回的标签里没有它：没补成', async () => {
    const denied = await runPrLabels({
      eventPath: EVENT,
      gh: fakeGh({ labelsAfter: new Error('回了 403') }).gh,
    });
    expect(denied).toMatchObject({ code: 2, lines: ['没补成：回了 403。'] });
    const lost = await runPrLabels({ eventPath: EVENT, gh: fakeGh({ labelsAfter: ['需求x'] }).gh });
    expect(lost.code).toBe(2);
    expect(lost.lines[0]).toContain('GitHub 回的标签里没有它（需求x）');
  });

  it('里程碑：列表读不到、找不到这个名字、挂完读回不对，都是没补成', async () => {
    const run = (o: Parameters<typeof fakeGh>[0]) =>
      runPrLabels({ eventPath: EVENT, gh: fakeGh({ pull: pr({ labels: ['杂项'] }), ...o }).gh });
    expect((await run({ milestones: new Error('回了 500') })).lines).toEqual(['没补成：回了 500。']);
    expect((await run({ milestones: [] })).lines[0]).toContain('在里程碑列表里找不到');
    expect((await run({ milestoneAfter: null })).lines[0]).toContain('GitHub 回的是「没挂」');
    expect((await run({ milestoneAfter: new Error('回了 422') })).code).toBe(2);
  });

  it('补了标签、挂里程碑失败：已补的照报，整体没补成', async () => {
    const r = await runPrLabels({
      eventPath: EVENT,
      gh: fakeGh({ milestoneAfter: new Error('回了 422') }).gh,
    });
    expect(r.code).toBe(2);
    expect(r.lines).toEqual(['PR #100 补上类别标签「杂项」（照抄 #74）。', '没补成：回了 422。']);
  });

  it('事件：没有路径、读不出来、没有 PR 号，都是没补成', async () => {
    const { gh } = fakeGh({});
    expect((await runPrLabels({ eventPath: undefined, gh })).lines[0]).toContain('没有 GITHUB_EVENT_PATH');
    expect((await runPrLabels({ eventPath: eventFile('{'), gh })).lines[0]).toContain('读不出来');
    expect((await runPrLabels({ eventPath: eventFile('{"issue":{}}'), gh })).lines[0]).toContain(
      '没有 pull_request.number',
    );
  });
});
