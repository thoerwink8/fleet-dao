import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GitHubPrLabeler, GitHubReader, IssueInfo, MilestoneInfo, PullInfo } from '../src/github-api.ts';
import { currentVersionTitle, linkedIssue, type PrState, planLabels, runPrLabels } from '../src/pr-labels.ts';

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

  it('括号里 #号后面有字：认这一处，不认末尾这个 PR 自己的号', () => {
    expect(linkedIssue(body('无'), 'feat: x（#345，创始人 09-28 凌晨改拍） (#392)')).toBe(345);
    expect(linkedIssue(body('无'), 'drill: x（#399，只改演练目录） (#404)')).toBe(399);
  });

  it('【故意造出的失败】#号不挨着左括号、不带括号：认不出', () => {
    expect(linkedIssue(body('无'), '说明（见 #12）')).toBeUndefined();
    expect(linkedIssue(body('无'), 'fix: x #43')).toBeUndefined();
    expect(linkedIssue(body('#74'), 'feat: x（#345，说明） (#392)')).toBe(74);
  });
});

describe('要补什么', () => {
  it('缺类别和里程碑：照抄 issue 的；issue 上别的标签不抄', () => {
    expect(planLabels(pr(), 74, issue())).toEqual({
      issue: 74,
      addLabel: '杂项',
      milestone: 'P1 核心闭环',
      notes: [],
    });
  });

  it('PR 已有的不动：有类别不补标签，有里程碑不补里程碑', () => {
    const p = planLabels(pr({ labels: ['需求'], milestone: 'P2 驾驶舱' }), 74, issue());
    expect(p).toMatchObject({ addLabel: undefined, milestone: undefined, notes: [] });
    expect(planLabels(pr({ labels: ['缺陷'] }), 74, issue())).toMatchObject({
      addLabel: undefined,
      milestone: 'P1 核心闭环',
    });
  });

  it('找不到对应 issue：按标题补类别；没给当前版本就不编里程碑', () => {
    const p = planLabels(pr({ title: 'feat: x', body: body('无') }), undefined, undefined);
    expect(p).toMatchObject({ issue: undefined, addLabel: '需求', milestone: undefined });
    expect(p.notes).toEqual([expect.stringContaining('没有还开着的 v 版本')]);
  });

  it('号在 GitHub 上没有、是个 PR：只提醒，不改当不挂单', () => {
    expect(planLabels(pr(), 74, undefined).notes[0]).toContain('GitHub 上没有这个号');
    expect(planLabels(pr(), 74, undefined, { currentVersion: 'v1 当前' }).milestone).toBeUndefined();
    expect(planLabels(pr(), 74, issue({ isPr: true })).notes[0]).toContain('是个 PR');
    expect(
      planLabels(pr(), 74, issue({ isPr: true }), { currentVersion: 'v1 当前' }).addLabel,
    ).toBeUndefined();
  });

  it('认到的号就是这个 PR 自己：当不挂单', () => {
    const p = planLabels(pr({ title: 'fix: x', number: 100 }), 100, undefined, { currentVersion: 'v1 当前' });
    expect(p).toMatchObject({ issue: undefined, addLabel: '缺陷', milestone: 'v1 当前', notes: [] });
  });

  it('不挂单：fix 是缺陷、feat 是需求、没有前缀和「请fix:」是杂项；已有类别不动', () => {
    const version = { currentVersion: 'v1 当前' };
    expect(
      planLabels(pr({ title: 'fix(engine): x', body: body('无') }), undefined, undefined, version),
    ).toMatchObject({
      addLabel: '缺陷',
      milestone: 'v1 当前',
    });
    expect(
      planLabels(pr({ title: 'feat!: x', body: body('无') }), undefined, undefined, version).addLabel,
    ).toBe('需求');
    expect(
      planLabels(pr({ title: '账密登录的测试', body: body('无') }), undefined, undefined, version).addLabel,
    ).toBe('杂项');
    expect(
      planLabels(pr({ title: '请fix: 这个', body: body('无') }), undefined, undefined, version).addLabel,
    ).toBe('杂项');
    const kept = planLabels(
      pr({ title: 'fix: x', body: body('无'), labels: ['需求'] }),
      undefined,
      undefined,
      version,
    );
    expect(kept.addLabel).toBeUndefined();
    expect(kept.milestone).toBe('v1 当前');
  });

  it('不挂单、对应计划是未排期：补类别，不挂里程碑，也不提醒', () => {
    const p = planLabels(
      pr({ title: 'fix: x', body: '**需求**：无\n**对应计划**：未排期，以后再说\n' }),
      undefined,
      undefined,
      { currentVersion: 'v1 当前' },
    );
    expect(p).toMatchObject({ addLabel: '缺陷', milestone: undefined, notes: [] });
  });

  it('【故意造出的失败】不挂单、没有还开着的 v 版本：类别照补，里程碑只提醒，不编名字', () => {
    const p = planLabels(pr({ title: 'fix: x', body: body('无') }), undefined, undefined, {
      currentVersion: null,
    });
    expect(p.addLabel).toBe('缺陷');
    expect(p.milestone).toBeUndefined();
    expect(p.notes).toEqual([expect.stringContaining('没有还开着的 v 版本')]);
  });

  it('当前版本：开着的 v 里号最小的；关了的、P 阶段不算；号一样用先出现的', () => {
    expect(
      currentVersionTitle([
        { number: 9, title: 'v3 后', state: 'open' },
        { number: 4, title: 'v1 Fusion 接活', state: 'open' },
        { number: 5, title: 'v1 另一个', state: 'open' },
        { number: 1, title: 'v0 旧', state: 'closed' },
        { number: 2, title: 'P1 核心闭环', state: 'open' },
      ]),
    ).toBe('v1 Fusion 接活');
    expect(
      currentVersionTitle([
        { number: 8, title: 'v2 甲', state: 'open' },
        { number: 9, title: 'v2 乙', state: 'open' },
      ]),
    ).toBe('v2 甲');
    expect(currentVersionTitle([{ number: 2, title: 'P1 核心闭环', state: 'open' }])).toBeNull();
  });

  it('issue 自己也没有：提醒两边都贴；有好几个类别：不猜', () => {
    const none = planLabels(pr(), 74, issue({ labels: ['要人看'], milestone: null }));
    expect(none).toMatchObject({ addLabel: undefined, milestone: undefined });
    expect(none.notes).toEqual([
      expect.stringContaining('自己也没有，请两边都贴上'),
      expect.stringContaining('自己也没有，请两边都挂上'),
    ]);
    const many = planLabels(pr({ milestone: 'P1 核心闭环' }), 74, issue({ labels: ['需求', '缺陷'] }));
    expect(many.addLabel).toBeUndefined();
    expect(many.notes[0]).toContain('有好几个类别标签（需求、缺陷）');
  });

  it('对应的单自己没里程碑：不拿当前版本填；对应计划是未排期时不提醒', () => {
    const open = planLabels(pr(), 74, issue({ milestone: null }), { currentVersion: 'v1 当前' });
    expect(open.milestone).toBeUndefined();
    expect(open.notes.some((n) => n.includes('自己也没有，请两边都挂上'))).toBe(true);
    const later = planLabels(
      pr({ body: '**需求**：#74\n**对应计划**：`未排期`\n' }),
      74,
      issue({ labels: ['要人看'], milestone: null }),
      { currentVersion: 'v1 当前' },
    );
    expect(later.milestone).toBeUndefined();
    expect(later.addLabel).toBeUndefined();
    expect(later.notes.filter((n) => n.includes('里程碑'))).toEqual([]);
    expect(later.notes[0]).toContain('自己也没有，请两边都贴上');
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

  it('不挂单：补标题上的类别和当前版本', async () => {
    const { gh, writes } = fakeGh({
      pull: pr({ title: 'fix(engine): x', body: body('无') }),
      milestones: [
        { number: 9, title: 'v3 后', state: 'open' },
        { number: 4, title: 'v1 Fusion 接活', state: 'open' },
      ],
      milestoneAfter: 'v1 Fusion 接活',
    });
    const r = await runPrLabels({ eventPath: EVENT, gh });
    expect(r.code).toBe(0);
    expect(writes).toEqual(['label 100 缺陷', 'milestone 100 4']);
    expect(r.lines[1]).toContain('挂当前版本');
    expect(r.notes).toEqual([]);
  });

  it('【故意造出的失败】不挂单、没有开着的 v 版本：类别照补，里程碑只提醒', async () => {
    const { gh, writes } = fakeGh({
      pull: pr({ title: 'docs: x', body: body('无') }),
      milestones: [{ number: 2, title: 'P1 核心闭环', state: 'open' }],
    });
    const r = await runPrLabels({ eventPath: EVENT, gh });
    expect(r.code).toBe(0);
    expect(writes).toEqual(['label 100 杂项']);
    expect(r.notes).toEqual([expect.stringContaining('没有还开着的 v 版本')]);
  });

  it('【故意造出的失败】不挂单、里程碑列表读失败：退出码 2，什么都没写', async () => {
    const { gh, writes } = fakeGh({
      pull: pr({ title: 'fix: x', body: body('无') }),
      milestones: new Error('回了 500'),
    });
    const r = await runPrLabels({ eventPath: EVENT, gh });
    expect(r.code).toBe(2);
    expect(writes).toEqual([]);
    expect(r.lines[0]).toContain('读不到里程碑列表（回了 500）');
  });

  it('不挂单、对应计划是未排期：不读里程碑列表', async () => {
    const { gh, writes } = fakeGh({
      pull: pr({ title: 'fix: x', body: '**需求**：无\n**对应计划**：未排期\n' }),
      milestones: new Error('不该读里程碑'),
    });
    const r = await runPrLabels({ eventPath: EVENT, gh });
    expect(r.code).toBe(0);
    expect(writes).toEqual(['label 100 缺陷']);
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
