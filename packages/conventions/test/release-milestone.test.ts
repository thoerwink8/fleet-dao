// release.yml 里「核版本里程碑（打 tag 之前）」「关里程碑」两步的编排（release-milestone.ts）：GitHub 换替身。
import { describe, expect, it } from 'vitest';
import type { MergedPull, MilestoneDetail, PlanIssue } from '../src/github-api.ts';
import { type ReleaseMilestoneGitHub, releaseMilestone } from '../src/release-milestone.ts';

const ms = (number: number, title: string, closedAt: string | null = null): MilestoneDetail => ({
  number,
  title,
  state: closedAt === null ? 'open' : 'closed',
  description: '',
  closedAt,
});

/** 一张单（默认开着、没挂里程碑）。 */
const is = (number: number, milestone: string | null, extra: Partial<PlanIssue> = {}): PlanIssue => ({
  number,
  title: `单 ${number}`,
  state: 'open',
  isPr: false,
  createdAt: '2026-09-26T00:00:00Z',
  labels: ['需求'],
  milestone,
  stateReason: null,
  subIssues: 0,
  subIssuesDone: 0,
  ...extra,
});

/** 仓里 2026-10-04 的样子：v1 早关了，开着的是 v3。 */
const REPO_NOW = [ms(8, 'v1 Fusion 接活', '2026-10-01T14:58:46Z'), ms(10, 'v3 三段一条龙')];
const MERGED = '2026-10-05T02:00:00Z';

/** GitHub 替身：记下每一次调用；关里程碑默认回「关上了」；单子挂在 titles 上，改里程碑就是把这张单挂过去（核回读用）。 */
function fake(opts: {
  milestones?: () => Promise<readonly MilestoneDetail[]>;
  pulls?: readonly MergedPull[] | (() => Promise<readonly MergedPull[]>);
  close?: (n: number) => Promise<MilestoneDetail>;
  issues?: PlanIssue[];
  comments?: Record<number, string[]>;
  fail?: Partial<Record<'milestoneIssues' | 'comments' | 'comment' | 'setIssueMilestone', string>>;
}) {
  const calls: string[] = [];
  const issues = opts.issues ?? [];
  // 每张单挂的里程碑：以它的编号为准；改的时候把 placements 挪过去，回读靠 milestoneIssues 再筛一遍。
  const byTitle = (title: string | null) => REPO_NOW.find((x) => x.title === title)?.number ?? null;
  const placements = new Map<number, number | null>(issues.map((i) => [i.number, byTitle(i.milestone)]));
  const comments = new Map<number, string[]>(
    Object.entries(opts.comments ?? {}).map(([k, v]) => [Number(k), [...v]]),
  );
  const guard = (name: keyof NonNullable<typeof opts.fail>) => {
    const msg = opts.fail?.[name];
    if (msg) throw new Error(msg);
  };
  const github: ReleaseMilestoneGitHub = {
    async milestones() {
      calls.push('milestones');
      return opts.milestones ? await opts.milestones() : REPO_NOW;
    },
    async mergedPulls(head) {
      calls.push(`mergedPulls ${head}`);
      const p = opts.pulls ?? [];
      return typeof p === 'function' ? await p() : p;
    },
    async closeMilestone(n) {
      calls.push(`close ${n}`);
      if (opts.close) return await opts.close(n);
      const m = REPO_NOW.find((x) => x.number === n);
      return { ...(m ?? ms(n, '?')), state: 'closed', closedAt: '2026-10-05T02:01:30Z' };
    },
    async milestoneIssues(n) {
      calls.push(`milestoneIssues ${n}`);
      guard('milestoneIssues');
      return issues.filter((i) => placements.get(i.number) === n);
    },
    async comments(n) {
      calls.push(`comments ${n}`);
      guard('comments');
      return comments.get(n) ?? [];
    },
    async comment(n, body) {
      calls.push(`comment ${n}`);
      guard('comment');
      comments.set(n, [...(comments.get(n) ?? []), body]);
    },
    async setIssueMilestone(n, milestone) {
      calls.push(`setIssueMilestone ${n} ${milestone ?? 'null'}`);
      guard('setIssueMilestone');
      placements.set(n, milestone);
      return milestone;
    },
  };
  return { github, calls, comments, placements };
}

describe('check（打 tag 之前）', () => {
  it('开着的当前版本就是这一版 → will-close，只读不写（不关、不查合并时间）', async () => {
    const { github, calls } = fake({});
    const r = await releaseMilestone({ mode: 'check', version: 'v3', mergedAt: MERGED, github });
    expect(r.kind).toBe('will-close');
    expect(r.milestone.number).toBe(10);
    expect(calls).toEqual(['milestones']);
  });

  // 【故意造出的失败】#593 那种：版本号算成了 v1、开着的是 v3。在打 tag 之前就红，说清 tag、release 都还没动。
  it('版本号对不上版本里程碑 → 抛，写明 tag、release 都还没动', async () => {
    const { github, calls } = fake({});
    await expect(
      releaseMilestone({ mode: 'check', version: 'v1', mergedAt: MERGED, github }),
    ).rejects.toThrow(
      /打 tag 之前核版本里程碑没过（tag、release 都还没动）[\s\S]*「v1 Fusion 接活」在 2026-10-01T14:58:46Z 就关了/,
    );
    expect(calls).not.toContain('close 8');
  });

  it('故意造出的失败：读里程碑失败 → 抛（不当成没有、不当成已经关过了）', async () => {
    const { github } = fake({
      milestones: async () => {
        throw new Error('读里程碑，GitHub 回了 502');
      },
    });
    await expect(
      releaseMilestone({ mode: 'check', version: 'v3', mergedAt: MERGED, github }),
    ).rejects.toThrow(/读 GitHub 上的里程碑失败：读里程碑，GitHub 回了 502/);
  });

  it('故意造出的失败：版本号不是 v<N> → 抛', async () => {
    const { github } = fake({});
    await expect(releaseMilestone({ mode: 'check', version: 'vNext', github })).rejects.toThrow(/不是 v<N>/);
  });
});

describe('close（建完 release 之后）', () => {
  it('开着的当前版本就是这一版、里头没有还开着的单 → 直接关它，拿回包核到 closed', async () => {
    const { github, calls } = fake({});
    const r = await releaseMilestone({ mode: 'close', version: 'v3', mergedAt: MERGED, github });
    expect(r.kind).toBe('closed');
    expect(r.milestone).toMatchObject({ number: 10, state: 'closed' });
    expect(r.kind === 'closed' && r.moved).toEqual({ count: 0, to: null });
    expect(calls).toEqual(['milestones', 'milestoneIssues 10', 'close 10']);
  });

  it('里头还开着的单 → 关之前搬到下一个版本（v4），每张加留言说明，搬完再关', async () => {
    const { github, calls, comments, placements } = fake({
      milestones: async () => [
        ms(8, 'v1 Fusion 接活', '2026-10-01T14:58:46Z'),
        ms(10, 'v3 三段一条龙'),
        ms(11, 'v4 下一版'),
      ],
      issues: [
        is(31, 'v3 三段一条龙', { state: 'closed' }),
        is(45, 'v3 三段一条龙'),
        is(46, 'v3 三段一条龙'),
      ],
    });
    const r = await releaseMilestone({ mode: 'close', version: 'v3', mergedAt: MERGED, github });
    expect(r.kind).toBe('closed');
    expect(r.kind === 'closed' && r.moved).toEqual({ count: 2, to: { number: 11, title: 'v4 下一版' } });
    // 关着的 #31 不动；两张开着的先留言、再搬到 v4。
    expect(calls).toEqual([
      'milestones',
      'milestoneIssues 10',
      'milestones',
      'comments 45',
      'comment 45',
      'setIssueMilestone 45 11',
      'comments 46',
      'comment 46',
      'setIssueMilestone 46 11',
      'milestoneIssues 10',
      'close 10',
    ]);
    expect(placements.get(45)).toBe(11);
    expect(placements.get(46)).toBe(11);
    expect(comments.get(45)?.[0]).toMatch(
      /「v3 三段一条龙」这个版本关了[\s\S]*搬到了下一个版本「v4 下一版」/,
    );
  });

  it('没有下一个版本 → 搬到未排期（清空里程碑）并留言', async () => {
    const { github, placements } = fake({
      issues: [is(45, 'v3 三段一条龙')],
    });
    const r = await releaseMilestone({ mode: 'close', version: 'v3', mergedAt: MERGED, github });
    expect(r.kind === 'closed' && r.moved).toEqual({ count: 1, to: null });
    expect(placements.get(45)).toBeNull();
  });

  it('重跑：留言已经写过 → 不重发（按正文去重）', async () => {
    const body =
      '「v3 三段一条龙」这个版本关了，这张单还没做完，现在没有下一个版本，先放回「未排期」（没挂版本），等排上版本再接走。\n\n' +
      '这是发布收尾关版本里程碑时自动搬的（#995 第 2 条）；接着做就继续做，不做了就关掉它。';
    const { github, calls, comments } = fake({
      issues: [is(45, 'v3 三段一条龙')],
      comments: { 45: [body] },
    });
    const r = await releaseMilestone({ mode: 'close', version: 'v3', mergedAt: MERGED, github });
    expect(r.kind).toBe('closed');
    expect(calls).not.toContain('comment 45');
    expect(comments.get(45)).toEqual([body]);
  });

  // 【故意造出的失败】#995 第 2 条：v3 发布时里程碑照关、17 张开着的单跟着被关。搬不动就红、不关。
  it('故意造出的失败：单没搬成（改里程碑 GitHub 报错）→ 抛、不关里程碑', async () => {
    const { github, calls, placements } = fake({
      milestones: async () => [ms(10, 'v3 三段一条龙'), ms(11, 'v4 下一版')],
      issues: [is(45, 'v3 三段一条龙')],
      fail: { setIssueMilestone: '在改 #45 挂的里程碑时，GitHub 回了 403' },
    });
    await expect(
      releaseMilestone({ mode: 'close', version: 'v3', mergedAt: MERGED, github }),
    ).rejects.toThrow(
      /关里程碑没关成[\s\S]*把 #45 搬到「v4 下一版」失败：在改 #45 挂的里程碑时，GitHub 回了 403/,
    );
    expect(calls).not.toContain('close 10');
    expect(placements.get(45)).toBe(10);
  });

  it('故意造出的失败：搬完回读还剩开着的单 → 抛、不关里程碑（就是 v3 出事的做法）', async () => {
    // setIssueMilestone 回的是「改到 v4 了」，可原里程碑里这张单还开着（模拟「说搬了、其实没搬」被回读抓住）。
    const { github, calls } = fake({
      milestones: async () => [ms(10, 'v3 三段一条龙'), ms(11, 'v4 下一版')],
      issues: [is(45, 'v3 三段一条龙')],
    });
    let asks = 0;
    const stubborn: ReleaseMilestoneGitHub = {
      ...github,
      async milestoneIssues(n) {
        asks += 1;
        if (asks <= 1) return github.milestoneIssues(n); // 搬之前：照实回（#45 还在）
        return [is(45, 'v3 三段一条龙')]; // 回读：故意还回这张开着的单——模拟「说搬了、其实没搬」
      },
      async setIssueMilestone() {
        return 11;
      },
    };
    await expect(
      releaseMilestone({ mode: 'close', version: 'v3', mergedAt: MERGED, github: stubborn }),
    ).rejects.toThrow(/还剩 1 张还开着的单（#45）：没搬干净，不关里程碑/);
    expect(calls).not.toContain('close 10');
  });

  it('故意造出的失败：读里程碑里的单失败 → 抛、不关里程碑', async () => {
    const { github, calls } = fake({ fail: { milestoneIssues: '读里程碑里的单，GitHub 回了 502' } });
    await expect(
      releaseMilestone({ mode: 'close', version: 'v3', mergedAt: MERGED, github }),
    ).rejects.toThrow(
      /读「v3 三段一条龙」里的单失败（关之前要把还开着的搬走）：读里程碑里的单，GitHub 回了 502/,
    );
    expect(calls).not.toContain('close 10');
  });

  it('故意造出的失败：写搬走说明失败 → 抛（单还没搬，不关里程碑）', async () => {
    const { github, calls } = fake({
      issues: [is(45, 'v3 三段一条龙')],
      fail: { comment: '在 #45 上留言，GitHub 回了 422' },
    });
    await expect(
      releaseMilestone({ mode: 'close', version: 'v3', mergedAt: MERGED, github }),
    ).rejects.toThrow(/在 #45 上写搬走说明失败：在 #45 上留言，GitHub 回了 422/);
    expect(calls).not.toContain('setIssueMilestone 45 null');
    expect(calls).not.toContain('close 10');
  });

  it('故意造出的失败：关了但回包里还开着 → 抛，不当成关了', async () => {
    const { github } = fake({ close: async () => ms(10, 'v3 三段一条龙') });
    await expect(
      releaseMilestone({ mode: 'close', version: 'v3', mergedAt: MERGED, github }),
    ).rejects.toThrow(/关里程碑没关成[\s\S]*状态 open：没关上/);
  });

  it('故意造出的失败：关的时候 GitHub 报错 → 抛，带上原因', async () => {
    const { github } = fake({
      close: async () => {
        throw new Error('在关里程碑 #10 时，GitHub 回了 403');
      },
    });
    await expect(
      releaseMilestone({ mode: 'close', version: 'v3', mergedAt: MERGED, github }),
    ).rejects.toThrow(/关「v3 三段一条龙」失败：在关里程碑 #10 时，GitHub 回了 403/);
  });

  it('重跑：这一版的里程碑在合并之后已经关了 → already-closed，不再关一次', async () => {
    const { github, calls } = fake({
      milestones: async () => [ms(10, 'v3 三段一条龙', '2026-10-05T02:01:30Z'), ms(11, 'v4 下一版')],
    });
    const r = await releaseMilestone({ mode: 'close', version: 'v3', mergedAt: MERGED, github });
    expect(r.kind).toBe('already-closed');
    expect(calls).toEqual(['milestones']);
  });
});

describe('手动补跑（workflow_dispatch：事件里没有合并时间）', () => {
  it('开着的里没有这一版 → 按 head=release/vN 查已合并的 PR、拿 GitHub 回的第一张的合并时间来判', async () => {
    const { github, calls } = fake({
      milestones: async () => [ms(10, 'v3 三段一条龙', '2026-10-05T02:01:30Z')],
      pulls: [
        { number: 731, mergedAt: MERGED, mergeCommitSha: 'a'.repeat(40) },
        { number: 700, mergedAt: '2026-10-04T00:00:00Z', mergeCommitSha: 'b'.repeat(40) },
      ],
    });
    const r = await releaseMilestone({ mode: 'close', version: 'v3', mergedAt: '', github });
    expect(r.kind).toBe('already-closed');
    expect(calls).toEqual(['milestones', 'mergedPulls release/v3']);
  });

  it('开着的里有这一版 → 用不着合并时间，不去查', async () => {
    const { github, calls } = fake({});
    await releaseMilestone({ mode: 'check', version: 'v3', github });
    expect(calls).toEqual(['milestones']);
  });

  it('故意造出的失败：没找到 head=release/vN 已合并的 PR → 抛（version 多半填错了）', async () => {
    const { github } = fake({ milestones: async () => [ms(10, 'v3 三段一条龙', '2026-10-05T02:01:30Z')] });
    await expect(releaseMilestone({ mode: 'check', version: 'v3', github })).rejects.toThrow(
      /没找到 head=release\/v3 已合并的 PR/,
    );
  });

  it('故意造出的失败：查已合并的 PR 失败 → 抛，不当成没合并', async () => {
    const { github } = fake({
      milestones: async () => [ms(10, 'v3 三段一条龙', '2026-10-05T02:01:30Z')],
      pulls: async () => {
        throw new Error('连不上 GitHub（fetch failed）');
      },
    });
    await expect(releaseMilestone({ mode: 'check', version: 'v3', github })).rejects.toThrow(
      /查 head=release\/v3 已合并的 PR 失败：连不上 GitHub/,
    );
  });
});
