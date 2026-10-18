// 版本收口（#2683）：用内存里的假 GitHub 跑 cutVersions。过期收口、挪单失败不关旧版、同一天重跑不出重复、没过期什么都不做、
// 手工关了还挂着开着单的版本兜底挪走，各有一条。
import { describe, expect, it } from 'vitest';
import type { MilestoneDetail, PlanIssue } from '../src/github-api.ts';
import { parseOrder } from '../src/plan-view.ts';
import {
  addDays,
  beijingDate,
  cutVersions,
  dueDateOf,
  rollOrder,
  type VersionCutGitHub,
  versionTitle,
} from '../src/version-cut.ts';
import { issue, milestone, order } from './fake-github.ts';

const HEAD = 'a'.repeat(40);
const V4 = 'v4 10-12～10-18 统一与验收';
/** 北京时间 2026-10-19 09:41：v4（10-18 到期）过期一天。 */
const DAY_AFTER = new Date('2026-10-19T01:41:00Z');

interface World {
  milestones: MilestoneDetail[];
  issues: PlanIssue[];
  comments: Record<number, string[]>;
}

/** 假 GitHub：读写都落在 world 上；failMove 里的单挪不动（故意造出的失败）。 */
function fake(w: World, opts: { failMove?: number[] } = {}) {
  const writes: string[] = [];
  const byNumber = (n: number) => {
    const m = w.milestones.find((x) => x.number === n);
    if (!m) throw new Error(`假数据里没有里程碑 ${n}`);
    return m;
  };
  const gh: VersionCutGitHub = {
    async milestones() {
      return w.milestones.map((m) => ({ ...m }));
    },
    async milestoneIssues(n) {
      const title = byNumber(n).title;
      return w.issues.filter((i) => i.milestone === title).map((i) => ({ ...i }));
    },
    async comments(n) {
      return [...(w.comments[n] ?? [])];
    },
    async comment(n, body) {
      writes.push(`comment #${n}`);
      w.comments[n] = [...(w.comments[n] ?? []), body];
    },
    async mainHead() {
      return HEAD;
    },
    async createMilestone({ title, description, dueOn }) {
      writes.push(`create ${title}`);
      const number = Math.max(0, ...w.milestones.map((m) => m.number)) + 1;
      const m = milestone(number, title, description, { dueOn: `${dueOn.slice(0, 10)}T07:00:00Z` });
      w.milestones.push(m);
      return { ...m };
    },
    async closeMilestone(n) {
      writes.push(`close ${n}`);
      const m = byNumber(n);
      m.state = 'closed';
      m.closedAt = '2026-10-19T01:41:00Z';
      return { ...m };
    },
    async setMilestoneDescription(n, description) {
      writes.push(`describe ${n}`);
      const m = byNumber(n);
      m.description = description;
      return { ...m };
    },
    async setIssueMilestone(n, ms) {
      if (opts.failMove?.includes(n)) throw new Error(`给 #${n} 挂里程碑，GitHub 回了 502`);
      writes.push(`move #${n} → ${ms}`);
      const i = w.issues.find((x) => x.number === n);
      if (!i) throw new Error(`假数据里没有 #${n}`);
      i.milestone = byNumber(ms).title;
    },
  };
  return { gh, writes };
}

/** v4（11 号里程碑，10-18 到期）：3 张开着（#10、#20、#30，先后里排了 #20、#10），关了 3 张（完成 2、不做 1）。 */
function world(): World {
  return {
    milestones: [
      milestone(10, 'v3 旧版本', order(1), {
        state: 'closed',
        closedAt: '2026-10-05T00:00:00Z',
        dueOn: null,
      }),
      milestone(11, V4, `目标：统一。\n\n${order(20, 10, 40)}`, { dueOn: '2026-10-18T07:00:00Z' }),
    ],
    issues: [
      issue(10, { milestone: V4 }),
      issue(20, { milestone: V4 }),
      issue(30, { milestone: V4 }),
      issue(40, { milestone: V4, state: 'closed', stateReason: 'completed' }),
      issue(41, { milestone: V4, state: 'closed', stateReason: 'completed' }),
      issue(42, { milestone: V4, state: 'closed', stateReason: 'not_planned' }),
      issue(1, { milestone: 'v3 旧版本', state: 'closed', stateReason: 'completed' }),
    ],
    comments: {},
  };
}

describe('日期和标题', () => {
  it('北京时间的日期、加天数、标题「v<N> MM-DD～MM-DD」、到期日只认日期', () => {
    expect(beijingDate(new Date('2026-10-18T16:30:00Z'))).toBe('2026-10-19');
    expect(addDays('2026-10-18', 7)).toBe('2026-10-25');
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(versionTitle(5, '2026-10-19', '2026-10-25')).toBe('v5 10-19～10-25');
    expect(dueDateOf({ dueOn: '2026-10-18T07:00:00Z' })).toBe('2026-10-18');
    expect(dueDateOf({ dueOn: null })).toBeNull();
    expect(dueDateOf({})).toBeUndefined();
  });
});

describe('到期收口', () => {
  it('过期一天、3 张开着的单：开 v5（+7 天）、3 张挪过去各留一句、先后接到最前、旧版写收口段后关掉', async () => {
    const w = world();
    const { gh } = fake(w);
    const r = await cutVersions(gh, DAY_AFTER);
    expect(r.failed).toEqual([]);
    expect(r.problems).toEqual([]);

    const v5 = w.milestones.find((m) => m.title.startsWith('v5 '));
    expect(v5).toMatchObject({ title: 'v5 10-19～10-25', state: 'open' });
    expect(dueDateOf(v5 ?? {})).toBe('2026-10-25');
    expect(w.issues.filter((i) => i.state === 'open').map((i) => [i.number, i.milestone])).toEqual([
      [10, 'v5 10-19～10-25'],
      [20, 'v5 10-19～10-25'],
      [30, 'v5 10-19～10-25'],
    ]);
    for (const n of [10, 20, 30]) {
      expect(w.comments[n]).toHaveLength(1);
      expect(w.comments[n]?.[0]).toContain('到期收口');
      expect(w.comments[n]?.[0]).toContain('v5 10-19～10-25');
    }
    // 旧版先后里还开着的 #20、#10 原样接到最前（已关的 #40 不跟过去）
    expect(parseOrder(v5?.description ?? '')).toMatchObject({ ok: true, order: [20, 10] });

    const v4 = w.milestones.find((m) => m.number === 11);
    expect(v4?.state).toBe('closed');
    expect(v4?.description).toContain('目标：统一。');
    expect(v4?.description).toContain(
      '- 这一版做了什么：[CHANGELOG v4](https://github.com/thoerwink8/fleet-dao/blob/main/CHANGELOG.md#v4)',
    );
    expect(v4?.description).not.toContain('- 关了');
    expect(v4?.description).toContain('- 滚到「v5 10-19～10-25」：#10、#20、#30（3 张）');
    expect(v4?.description).toContain(`- 收口时主线头：${HEAD}`);
    expect(v4?.description).not.toContain('收口中');
    expect(r.lines.join('\n')).toContain('收口');
  });

  it('同一天重跑：不再开 v5、不再留言、不再改', async () => {
    const w = world();
    const { gh, writes } = fake(w);
    await cutVersions(gh, DAY_AFTER);
    const before = writes.length;
    const again = await cutVersions(gh, new Date('2026-10-19T05:00:00Z'));
    expect(again.failed).toEqual([]);
    expect(writes.slice(before)).toEqual([]);
    expect(w.milestones.filter((m) => m.title.startsWith('v5 '))).toHaveLength(1);
    expect(again.lines.join('\n')).toContain('还没过期，什么也不做');
  });

  it('【故意造出的失败】挪单失败：不关旧版、记 failed（退出码非 0）；下一次跑接着挪、不开第二个 v5、滚过去的单号记全', async () => {
    const w = world();
    const first = fake(w, { failMove: [20] });
    const r = await cutVersions(first.gh, DAY_AFTER);
    expect(r.failed.join('\n')).toContain('#20 没挪到');
    expect(r.failed.join('\n')).toContain('旧版不关');
    expect(w.milestones.find((m) => m.number === 11)?.state).toBe('open');
    expect(w.milestones.find((m) => m.number === 11)?.description).toContain('收口中');

    const second = fake(w);
    const fixed = await cutVersions(second.gh, DAY_AFTER);
    expect(fixed.failed).toEqual([]);
    expect(w.milestones.filter((m) => m.title.startsWith('v5 '))).toHaveLength(1);
    const v4 = w.milestones.find((m) => m.number === 11);
    expect(v4?.state).toBe('closed');
    expect(v4?.description).toContain('#10、#20、#30（3 张）');
    // 已经留过言的不再留
    expect(w.comments[10]).toHaveLength(1);
    expect(w.comments[20]).toHaveLength(1);
  });

  it('没过期（到期日当天）：什么都不做', async () => {
    const w = world();
    const { gh, writes } = fake(w);
    const r = await cutVersions(gh, new Date('2026-10-18T15:00:00Z')); // 北京时间 10-18 23:00
    expect(r).toMatchObject({ failed: [], problems: [] });
    expect(writes).toEqual([]);
    expect(r.lines).toEqual(['「v4 10-12～10-18 统一与验收」2026-10-18 到期，还没过期，什么也不做。']);
  });

  it('当前版本没设到期日：不收口，记要人看的', async () => {
    const w = world();
    const v4 = w.milestones.find((m) => m.number === 11);
    if (v4) v4.dueOn = null;
    const { gh, writes } = fake(w);
    const r = await cutVersions(gh, DAY_AFTER);
    expect(writes).toEqual([]);
    expect(r.problems.join()).toContain('没设到期日');
  });

  it('开着的 v<N> 不止一个（又不是收口断在半路的那一对）：什么都不动，记要人看的', async () => {
    const w = world();
    w.milestones.push(milestone(12, 'v7 别的', order(30), { dueOn: '2026-11-01T07:00:00Z' }));
    const { gh, writes } = fake(w);
    const r = await cutVersions(gh, DAY_AFTER);
    expect(writes).toEqual([]);
    expect(r.problems.join()).toContain('只该开一个');
  });
});

describe('兜底：手工关了的版本还挂着开着的单', () => {
  it('v3 已关还挂着 #5：挪到开着的 v4、留一句；没有就不动', async () => {
    const w = world();
    w.issues.push(issue(5, { milestone: 'v3 旧版本' }));
    const { gh } = fake(w);
    const r = await cutVersions(gh, new Date('2026-10-16T01:00:00Z'));
    expect(r.failed).toEqual([]);
    expect(w.issues.find((i) => i.number === 5)?.milestone).toBe(V4);
    expect(w.comments[5]?.[0]).toContain('已经关了');
    expect(r.lines.join('\n')).toContain('#5');
  });

  it('一个开着的版本都没有：今天起开一版（7 天），再把开着的单挪过去', async () => {
    const w = world();
    const v4 = w.milestones.find((m) => m.number === 11);
    if (v4) v4.state = 'closed';
    const { gh } = fake(w);
    const r = await cutVersions(gh, new Date('2026-10-16T01:00:00Z'));
    expect(r.failed).toEqual([]);
    const v5 = w.milestones.find((m) => m.title.startsWith('v5 '));
    expect(v5?.title).toBe('v5 10-16～10-22');
    expect(w.issues.filter((i) => i.state === 'open').every((i) => i.milestone === v5?.title)).toBe(true);
  });
});

describe('rollOrder：旧版先后整段接到新版最前', () => {
  it('新版自己排过的接在后面、去重；旧版里没挪过来的不带', () => {
    const inNew = [issue(1), issue(2), issue(3), issue(9)];
    const r = rollOrder(order(2, 7, 1), order(9, 1), inNew);
    expect(r).toMatchObject({ ok: true, order: [2, 1, 9] });
  });

  it('一张也接不上：把挪过来的顶层单按号排进去，不留空先后（子单不排）', () => {
    const inNew = [issue(8), issue(3), issue(4, { parent: 3 })];
    const r = rollOrder('没有先后', `x\n\n${order()}`, inNew);
    expect(r).toMatchObject({ ok: true, order: [3, 8] });
  });
});
