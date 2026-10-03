// release.yml 里「核版本里程碑（打 tag 之前）」「关里程碑」两步的编排（release-milestone.ts）：GitHub 换替身。
import { describe, expect, it } from 'vitest';
import type { MergedPull, MilestoneDetail } from '../src/github-api.ts';
import { type ReleaseMilestoneGitHub, releaseMilestone } from '../src/release-milestone.ts';

const ms = (number: number, title: string, closedAt: string | null = null): MilestoneDetail => ({
  number,
  title,
  state: closedAt === null ? 'open' : 'closed',
  description: '',
  closedAt,
});

/** 仓里 2026-10-04 的样子：v1 早关了，开着的是 v3。 */
const REPO_NOW = [ms(8, 'v1 Fusion 接活', '2026-10-01T14:58:46Z'), ms(10, 'v3 三段一条龙')];
const MERGED = '2026-10-05T02:00:00Z';

/** GitHub 替身：记下每一次调用；关里程碑默认回「关上了」。 */
function fake(opts: {
  milestones?: () => Promise<readonly MilestoneDetail[]>;
  pulls?: readonly MergedPull[] | (() => Promise<readonly MergedPull[]>);
  close?: (n: number) => Promise<MilestoneDetail>;
}) {
  const calls: string[] = [];
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
  };
  return { github, calls };
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
  it('开着的当前版本就是这一版 → 关它，拿回包核到 closed', async () => {
    const { github, calls } = fake({});
    const r = await releaseMilestone({ mode: 'close', version: 'v3', mergedAt: MERGED, github });
    expect(r.kind).toBe('closed');
    expect(r.milestone).toMatchObject({ number: 10, state: 'closed' });
    expect(calls).toEqual(['milestones', 'close 10']);
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
        { number: 731, mergedAt: MERGED },
        { number: 700, mergedAt: '2026-10-04T00:00:00Z' },
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
