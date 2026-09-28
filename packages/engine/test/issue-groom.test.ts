// 单子进门自动打标挂版本（#448）：类别问 Jev、版本按规则挂、版本交接、闲置清理，一个仓一个仓地查、记没查成。
import type { LabelEvent } from '@fleet-dao/conventions';
import { describe, expect, it, vi } from 'vitest';
import {
  type GroomFactsRead,
  type IssueGroomJobDeps,
  type IssueGroomRepo,
  issueGroomDue,
  renderDigest,
  sweepIssueGroom,
} from '../src/jobs/issue-groom.ts';

const repo: IssueGroomRepo = { owner: 'o', name: 'r' };
const NOW = new Date('2026-09-28T00:00:00Z');

const issue = (over: Partial<GroomFactsRead['issues'][number]> = {}): GroomFactsRead['issues'][number] => ({
  number: 1,
  title: 't',
  body: 'b',
  authorIsBot: false,
  updatedAt: NOW.toISOString(),
  labels: [],
  milestone: null,
  ...over,
});

const V1 = { number: 3, title: 'v1 Fusion 接活', state: 'open' as const };
const V0_CLOSED = { number: 2, title: 'v0 老版本', state: 'closed' as const };

/** 假 deps：记下每次写了什么；facts、labelEvents、askKind 按仓/单号/问法给固定答案或抛错。 */
function fakeDeps(opts: {
  repos?: IssueGroomRepo[] | Error;
  facts?: Map<string, GroomFactsRead | Error>;
  labelEvents?: Map<string, LabelEvent[] | Error>;
  askKind?: (issue: {
    number: number;
    title: string;
    body: string;
  }) => Promise<import('@fleet-dao/conventions').JevKindAnswer>;
  addLabelFails?: Set<string>;
  setMilestoneFails?: Set<number>;
  commentFails?: Set<number>;
  closeFails?: Set<number>;
  digestFails?: boolean;
}) {
  const writes: string[] = [];
  const key = (r: IssueGroomRepo) => `${r.owner}/${r.name}`;
  const deps: IssueGroomJobDeps = {
    async repos() {
      if (opts.repos instanceof Error) throw opts.repos;
      return opts.repos ?? [repo];
    },
    async facts(r) {
      const v = opts.facts?.get(key(r));
      if (v instanceof Error) throw v;
      if (!v) throw new Error(`没准备 facts(${key(r)})`);
      return v;
    },
    async labelEvents(r, n) {
      const v = opts.labelEvents?.get(`${key(r)}#${n}`);
      if (v instanceof Error) throw v;
      return v ?? [];
    },
    async askKind(i) {
      return (opts.askKind ?? (async () => ({ judged: true, kind: '杂项', confidence: 0.9 })))(i);
    },
    async addLabel(r, n, label) {
      if (opts.addLabelFails?.has(`${key(r)}#${n}`)) throw new Error('回了 403');
      writes.push(`label ${key(r)}#${n} ${label}`);
    },
    async setMilestone(r, n, m) {
      if (opts.setMilestoneFails?.has(n)) throw new Error('回了 422');
      writes.push(`milestone ${key(r)}#${n} ${m}`);
    },
    async comment(r, n, k) {
      if (opts.commentFails?.has(n)) throw new Error('回了 500');
      writes.push(`comment ${key(r)}#${n} ${k}`);
    },
    async closeNotPlanned(r, n) {
      if (opts.closeFails?.has(n)) throw new Error('回了 409');
      writes.push(`close ${key(r)}#${n}`);
    },
    async digest(r, title) {
      if (opts.digestFails) throw new Error('回了 500');
      writes.push(`digest ${key(r)} ${title}`);
    },
    now: () => NOW,
    log: vi.fn(),
  };
  return { deps, writes };
}

const facts = (over: Partial<GroomFactsRead> = {}): GroomFactsRead => ({
  milestones: [V1],
  issues: [],
  ...over,
});

describe('类别：Jev 判、只贴不摘', () => {
  it('没有类别标签的单：问 Jev，判出来就贴', async () => {
    // 里程碑先挂好，隔开版本那条循环，这个用例只看类别这一件事
    const { deps, writes } = fakeDeps({
      facts: new Map([
        ['o/r', facts({ issues: [issue({ milestone: { number: 3, title: 'v1 Fusion 接活' } })] })],
      ]),
      askKind: async () => ({ judged: true, kind: '需求', confidence: 0.9 }),
    });
    const r = await sweepIssueGroom(deps);
    expect(writes).toContain('label o/r#1 需求');
    expect(r).toMatchObject({ scanned: 1, found: 1, unchecked: [] });
  });

  it('【故意造出的失败】Jev 连不上（没问成）：不贴、记没查成', async () => {
    const { deps, writes } = fakeDeps({
      facts: new Map([['o/r', facts({ issues: [issue()] })]]),
      askKind: async () => ({ judged: false, reason: 'unreachable', detail: '判断题起不来' }),
    });
    const r = await sweepIssueGroom(deps);
    expect(writes.some((w) => w.startsWith('label'))).toBe(false);
    expect(r.unchecked).toEqual([expect.stringContaining('判断题起不来')]);
  });

  it('【故意造出的失败】把握不够：不贴、进日报（不记没查成）', async () => {
    const { deps, writes } = fakeDeps({
      facts: new Map([['o/r', facts({ issues: [issue()] })]]),
      askKind: async () => ({ judged: false, reason: 'low_confidence', detail: '把握度 0.4' }),
    });
    const r = await sweepIssueGroom(deps);
    expect(writes.some((w) => w.startsWith('label'))).toBe(false);
    expect(r.unchecked).toEqual([]);
    const digestCall = writes.find((w) => w.startsWith('digest'));
    expect(digestCall).toBeDefined();
  });

  it('【故意造出的失败】人摘掉过 Jev 贴的类别：以后不再贴，不问 Jev，不算没查成', async () => {
    const askKind = vi.fn(async () => ({ judged: true as const, kind: '需求' as const, confidence: 0.99 }));
    const { deps, writes } = fakeDeps({
      facts: new Map([['o/r', facts({ issues: [issue()] })]]),
      labelEvents: new Map([
        [
          'o/r#1',
          [
            { label: '需求', action: 'labeled', bot: true, at: '2026-09-01T00:00:00Z' },
            { label: '需求', action: 'unlabeled', bot: false, at: '2026-09-05T00:00:00Z' },
          ],
        ],
      ]),
      askKind,
    });
    const r = await sweepIssueGroom(deps);
    expect(askKind).not.toHaveBeenCalled();
    expect(writes.some((w) => w.startsWith('label'))).toBe(false);
    expect(r.unchecked).toEqual([]);
  });

  it('已经有类别标签的单（不管谁贴的）：不在候选范围里，不问 Jev', async () => {
    const askKind = vi.fn(async () => ({ judged: true as const, kind: '需求' as const, confidence: 0.9 }));
    const { deps } = fakeDeps({
      facts: new Map([['o/r', facts({ issues: [issue({ labels: ['缺陷'] })] })]]),
      askKind,
    });
    await sweepIssueGroom(deps);
    expect(askKind).not.toHaveBeenCalled();
  });

  it('【故意造出的失败】标签时间线读不到：不问 Jev，记没查成', async () => {
    const askKind = vi.fn(async () => ({ judged: true as const, kind: '需求' as const, confidence: 0.9 }));
    const { deps } = fakeDeps({
      facts: new Map([['o/r', facts({ issues: [issue()] })]]),
      labelEvents: new Map([['o/r#1', new Error('回了 502')]]),
      askKind,
    });
    const r = await sweepIssueGroom(deps);
    expect(askKind).not.toHaveBeenCalled();
    expect(r.unchecked).toEqual([expect.stringContaining('回了 502')]);
  });

  it('【故意造出的失败】贴标签写不成：记没查成', async () => {
    const { deps } = fakeDeps({
      facts: new Map([['o/r', facts({ issues: [issue()] })]]),
      askKind: async () => ({ judged: true, kind: '需求', confidence: 0.9 }),
      addLabelFails: new Set(['o/r#1']),
    });
    const r = await sweepIssueGroom(deps);
    expect(r.unchecked).toEqual([expect.stringContaining('回了 403')]);
  });
});

describe('版本：创始人开的进当前版本，AI 发现的进未排期', () => {
  it('人开的、进门时类别和版本都没有：这一轮贴上类别，也挂当前版本', async () => {
    const { deps, writes } = fakeDeps({
      facts: new Map([['o/r', facts({ issues: [issue({ authorIsBot: false })] })]]),
    });
    const r = await sweepIssueGroom(deps);
    expect(writes).toContain('label o/r#1 杂项');
    expect(writes).toContain('milestone o/r#1 3');
    expect(r.found).toBe(2);
  });

  it('【故意造出的失败】人开的、有类别没版本（issue:new 开的「未排期」）：有意未排期，不挂', async () => {
    // 09-28 上线第一轮就栽在这：52 张有意未排期的单被全挂进 v1，引擎当场照版本接了活
    const { deps, writes } = fakeDeps({
      facts: new Map([['o/r', facts({ issues: [issue({ authorIsBot: false, labels: ['需求'] })] })]]),
    });
    const r = await sweepIssueGroom(deps);
    expect(writes.some((w) => w.startsWith('milestone'))).toBe(false);
    expect(r.unchecked).toEqual([]);
  });

  it('机器人开的（引擎对账、提醒）：未排期，不挂，不算没查成', async () => {
    const { deps, writes } = fakeDeps({
      facts: new Map([['o/r', facts({ issues: [issue({ authorIsBot: true })] })]]),
    });
    const r = await sweepIssueGroom(deps);
    expect(writes.some((w) => w.startsWith('milestone'))).toBe(false);
    expect(r.unchecked).toEqual([]);
  });

  it('【故意造出的失败】当前版本读不到（没有还开着的 v<N> 里程碑）：不挂、报没查成', async () => {
    const { deps, writes } = fakeDeps({
      facts: new Map([
        ['o/r', facts({ milestones: [{ number: 9, title: '杂项', state: 'open' }], issues: [issue()] })],
      ]),
    });
    const r = await sweepIssueGroom(deps);
    expect(writes.some((w) => w.startsWith('milestone'))).toBe(false);
    expect(r.unchecked).toEqual([expect.stringContaining('没有当前版本')]);
  });

  it('已经挂着里程碑的单：不在候选范围里', async () => {
    const { deps, writes } = fakeDeps({
      facts: new Map([
        ['o/r', facts({ issues: [issue({ milestone: { number: 3, title: 'v1 Fusion 接活' } })] })],
      ]),
    });
    await sweepIssueGroom(deps);
    expect(writes.some((w) => w.startsWith('milestone'))).toBe(false);
  });

  it('【故意造出的失败】挂里程碑写不成：记没查成', async () => {
    const { deps } = fakeDeps({
      facts: new Map([['o/r', facts({ issues: [issue()] })]]),
      setMilestoneFails: new Set([1]),
    });
    const r = await sweepIssueGroom(deps);
    expect(r.unchecked).toEqual([expect.stringContaining('回了 422')]);
  });
});

describe('版本交接：里程碑关了，没做完的单挪到下一个版本', () => {
  it('挂着已关闭里程碑的单：挪到当前版本、留一句言', async () => {
    const { deps, writes } = fakeDeps({
      facts: new Map([
        [
          'o/r',
          facts({
            milestones: [V1, V0_CLOSED],
            issues: [issue({ milestone: { number: 2, title: 'v0 老版本' }, labels: ['需求'] })],
          }),
        ],
      ]),
    });
    const r = await sweepIssueGroom(deps);
    expect(writes).toContain('milestone o/r#1 3');
    expect(writes).toContain('comment o/r#1 issue-groom:handoff:2');
    expect(r.found).toBe(1);
  });

  it('挂着的里程碑还开着：不用交接', async () => {
    const { deps, writes } = fakeDeps({
      facts: new Map([
        ['o/r', facts({ issues: [issue({ milestone: { number: 3, title: 'v1 Fusion 接活' } })] })],
      ]),
    });
    await sweepIssueGroom(deps);
    expect(writes.some((w) => w.includes('handoff'))).toBe(false);
  });

  it('【故意造出的失败】没有下一个版本：不挪、报出来', async () => {
    const { deps, writes } = fakeDeps({
      facts: new Map([
        [
          'o/r',
          facts({
            milestones: [V0_CLOSED],
            issues: [issue({ milestone: { number: 2, title: 'v0 老版本' } })],
          }),
        ],
      ]),
    });
    const r = await sweepIssueGroom(deps);
    expect(writes.some((w) => w.startsWith('milestone'))).toBe(false);
    expect(r.unchecked).toEqual([expect.stringContaining('没有下一个版本')]);
  });

  it('【故意造出的失败】版本交接写不成：记没查成', async () => {
    const { deps } = fakeDeps({
      facts: new Map([
        [
          'o/r',
          facts({
            milestones: [V1, V0_CLOSED],
            issues: [issue({ milestone: { number: 2, title: 'v0 老版本' } })],
          }),
        ],
      ]),
      setMilestoneFails: new Set([1]),
    });
    const r = await sweepIssueGroom(deps);
    expect(r.unchecked).toEqual([expect.stringContaining('回了 422')]);
  });
});

describe('闲置清理（照 Kubernetes）：只查真未排期的单，这一轮刚挂了版本的不查', () => {
  it('人开的单闲置很久：这一轮挂了当前版本，不查闲置（不会既挂版本又被关）', async () => {
    const old = new Date(NOW.getTime() - 999 * 86_400_000).toISOString();
    const { deps, writes } = fakeDeps({
      facts: new Map([['o/r', facts({ issues: [issue({ updatedAt: old })] })]]),
    });
    const r = await sweepIssueGroom(deps);
    expect(writes).toContain('milestone o/r#1 3');
    expect(writes.some((w) => w.includes('过时') || w.startsWith('close'))).toBe(false);
    expect(r.found).toBe(2);
  });

  it('机器人开的、真未排期、闲置满 30 天：贴「过时」', async () => {
    const old = new Date(NOW.getTime() - 30 * 86_400_000).toISOString();
    const { deps, writes } = fakeDeps({
      facts: new Map([
        ['o/r', facts({ issues: [issue({ authorIsBot: true, updatedAt: old, labels: ['需求'] })] })],
      ]),
    });
    const r = await sweepIssueGroom(deps);
    expect(writes).toContain('label o/r#1 过时');
    expect(r.found).toBe(1);
  });

  it('贴了过时满 14 天：关成不做了', async () => {
    const staleSince = new Date(NOW.getTime() - 14 * 86_400_000).toISOString();
    const { deps, writes } = fakeDeps({
      facts: new Map([['o/r', facts({ issues: [issue({ authorIsBot: true, labels: ['过时', '需求'] })] })]]),
      labelEvents: new Map([['o/r#1', [{ label: '过时', action: 'labeled', bot: true, at: staleSince }]]]),
    });
    const r = await sweepIssueGroom(deps);
    expect(writes).toContain('close o/r#1');
    expect(r.found).toBe(1);
  });

  it('【故意造出的失败】闲置到期但贴了「冻结」：不关（也不贴过时）', async () => {
    const old = new Date(NOW.getTime() - 999 * 86_400_000).toISOString();
    const { deps, writes } = fakeDeps({
      facts: new Map([
        ['o/r', facts({ issues: [issue({ authorIsBot: true, updatedAt: old, labels: ['冻结', '需求'] })] })],
      ]),
    });
    const r = await sweepIssueGroom(deps);
    expect(writes.some((w) => w.startsWith('label') || w.startsWith('close'))).toBe(false);
    expect(r.unchecked).toEqual([]);
  });

  it('母单：闲置到期也不动', async () => {
    const old = new Date(NOW.getTime() - 999 * 86_400_000).toISOString();
    const { deps, writes } = fakeDeps({
      facts: new Map([
        ['o/r', facts({ issues: [issue({ authorIsBot: true, updatedAt: old, labels: ['母单', '需求'] })] })],
      ]),
    });
    await sweepIssueGroom(deps);
    expect(writes.some((w) => w.startsWith('label') || w.startsWith('close'))).toBe(false);
  });

  it('【故意造出的失败】贴过时但查不出何时贴的：不硬关，记没查成（这一轮没读到，等下次）', async () => {
    const { deps, writes } = fakeDeps({
      facts: new Map([['o/r', facts({ issues: [issue({ authorIsBot: true, labels: ['过时', '需求'] })] })]]),
      labelEvents: new Map([['o/r#1', new Error('回了 502')]]),
    });
    const r = await sweepIssueGroom(deps);
    expect(writes.some((w) => w.startsWith('close'))).toBe(false);
    expect(r.unchecked).toEqual([expect.stringContaining('回了 502')]);
  });
});

describe('仓、日报', () => {
  it('【故意造出的失败】这个仓读现状没成：记没查成，跳过，别的仓照跑', async () => {
    const repo2 = { owner: 'o', name: 'r2' };
    const { deps, writes } = fakeDeps({
      repos: [repo, repo2],
      facts: new Map<string, GroomFactsRead | Error>([
        ['o/r', new Error('回了 500')],
        ['o/r2', facts({ issues: [issue()] })],
      ]),
    });
    const r = await sweepIssueGroom(deps);
    expect(r.scanned).toBe(1);
    expect(r.unchecked).toEqual([expect.stringContaining('回了 500')]);
    expect(writes.some((w) => w.includes('o/r2'))).toBe(true);
  });

  it('每个仓都写一条日报（不管这一轮有没有动作）', async () => {
    const { deps, writes } = fakeDeps({ facts: new Map([['o/r', facts()]]) });
    await sweepIssueGroom(deps);
    expect(writes).toContain('digest o/r o/r：单子打标挂版本');
  });

  it('【故意造出的失败】日报写不成：记没查成，不挡这一轮别的结果', async () => {
    // 里程碑先挂好，隔开版本那条循环，只留类别这一个动作，方便断言 found 恰好是 1
    const { deps } = fakeDeps({
      facts: new Map([
        ['o/r', facts({ issues: [issue({ milestone: { number: 3, title: 'v1 Fusion 接活' } })] })],
      ]),
      digestFails: true,
    });
    const r = await sweepIssueGroom(deps);
    expect(r.found).toBe(1);
    expect(r.unchecked).toEqual([expect.stringContaining('日报没写成')]);
  });

  it('renderDigest：什么都没做也有一句话，不是空的', () => {
    expect(
      renderDigest({
        labeled: [],
        lowConfidence: [],
        milestoned: [],
        handedOff: [],
        staleMarked: [],
        closed: [],
      }),
    ).toContain('没有要处理的');
  });

  it.each([
    ['2026-09-28T01:00:05Z', true],
    ['2026-09-28T01:14:59Z', true],
    ['2026-09-28T01:15:00Z', false],
    ['2026-09-28T00:59:59Z', false],
    ['2026-09-28T09:00:00Z', true],
  ])('issueGroomDue：每小时一次，不挑北京时间的钟点（%s → %s）', (at, due) => {
    expect(issueGroomDue(new Date(at))).toBe(due);
  });

  it('renderDigest：列出贴了什么、没把握的、清了哪些', () => {
    const text = renderDigest({
      labeled: [{ issue: 1, label: '需求' }],
      lowConfidence: [{ issue: 2, note: '把握度 0.4' }],
      milestoned: [{ issue: 3, milestone: 'v1 Fusion 接活' }],
      handedOff: [{ issue: 4, from: 'v0', to: 'v1' }],
      staleMarked: [5],
      closed: [6],
    });
    for (const needle of ['#1', '需求', '#2', '把握度 0.4', '#3', 'v1 Fusion 接活', '#4', '#5', '#6']) {
      expect(text).toContain(needle);
    }
  });
});
