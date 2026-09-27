// 关单对账（#241）：每天一次按受管的仓看一遍，做完没关的、子单都关了的母单、关了没结果的，单上留言一次、驾驶舱一条提醒；
// 这一种都没有了就撤。读不到算没查成，不当成齐了、也不撤提醒。
import { describe, expect, it } from 'vitest';
import {
  type CloseSweepJobDeps,
  type CloseSweepRead,
  closeSweepDue,
  sweepClosing,
} from '../src/jobs/close-sweep.ts';

const NOW = new Date('2026-09-28T01:00:00Z');
const REPO = { owner: 'example', name: 'canary' };
const SLUG = 'example/canary';
const noSubs = { total: 0, open: [], closed: [] };

const facts = (over: Partial<CloseSweepRead> = {}): CloseSweepRead => ({
  specsFiles: ['specs/12-登录/需求.md', 'specs/12-登录/结果.md'],
  openIssues: [{ number: 12, title: '登录', subIssues: noSubs }],
  closedIssues: [],
  openPulls: [],
  ...over,
});

function harness(read: () => Promise<CloseSweepRead>, over: Partial<CloseSweepJobDeps> = {}) {
  const calls: string[] = [];
  const comments: { issue: number; key: string; body: string }[] = [];
  const alerts: { key: string; title: string; body: string }[] = [];
  const resolved: { key: string; why: string }[] = [];
  let since: Date | undefined;
  const deps: CloseSweepJobDeps = {
    repos: async () => [REPO],
    facts: async (_repo, s) => {
      since = s;
      calls.push('facts');
      return read();
    },
    comment: async (input) => {
      comments.push({ issue: input.issueNumber, key: input.key, body: input.body });
      return { created: true };
    },
    alert: async (key, title, body) => {
      alerts.push({ key, title, body });
    },
    resolve: async (key, why) => {
      resolved.push({ key, why });
    },
    now: () => NOW,
    log: () => {},
    ...over,
  };
  return { deps, calls, comments, alerts, resolved, since: () => since };
}

describe('关单对账：留言一次、驾驶舱一条、没了就撤', () => {
  it('做完没关的：单上留言、驾驶舱一条要人拍；另两种没有的撤掉；关掉的单往回看 30 天', async () => {
    const h = harness(async () => facts());
    expect(await sweepClosing(h.deps)).toEqual({ scanned: 1, found: 1, unchecked: [] });
    expect(h.since()?.toISOString()).toBe('2026-08-29T01:00:00.000Z');
    expect(h.comments).toEqual([{ issue: 12, key: 'close-sweep:due', body: expect.stringContaining('pnpm issue:close 12') }]);
    expect(h.alerts.map((a) => [a.key, a.title])).toEqual([[`close-sweep:${SLUG}:due`, `${SLUG}：1 张单看着做完了没关`]]);
    expect(h.resolved.map((r) => r.key)).toEqual([`close-sweep:${SLUG}:mother`, `close-sweep:${SLUG}:no-result`]);
  });

  it('以前留过言的（按键认下）不算这一轮新提醒的', async () => {
    const h = harness(async () => facts(), { comment: async () => ({ created: false }) });
    expect((await sweepClosing(h.deps)).found).toBe(0);
  });

  it('【故意造出的失败】子单全关了：提醒母单照目标看能不能关（留言、驾驶舱各一条）', async () => {
    const h = harness(async () =>
      facts({ openIssues: [{ number: 20, title: '母单', subIssues: { total: 2, open: [], closed: [21, 22] } }] }),
    );
    await sweepClosing(h.deps);
    expect(h.comments).toEqual([
      { issue: 20, key: 'close-sweep:mother', body: expect.stringContaining('子单都关了（#21、#22）') },
    ]);
    expect(h.alerts.map((a) => a.title)).toEqual([`${SLUG}：1 张母单的子单都关了`]);
  });

  it('都处理完了：三种提醒都撤', async () => {
    const h = harness(async () => facts({ openIssues: [] }));
    expect(await sweepClosing(h.deps)).toEqual({ scanned: 1, found: 0, unchecked: [] });
    expect(h.alerts).toEqual([]);
    expect(h.resolved.map((r) => r.key)).toEqual([
      `close-sweep:${SLUG}:due`,
      `close-sweep:${SLUG}:mother`,
      `close-sweep:${SLUG}:no-result`,
    ]);
  });

  it('【故意造出的失败】读不到仓的现状：记没查成，不留言、不报、也不撤（没查成不是都齐了）', async () => {
    const h = harness(async () => {
      throw new Error('GitHub 回 502');
    });
    expect(await sweepClosing(h.deps)).toEqual({
      scanned: 0,
      found: 0,
      unchecked: [`关单对账 ${SLUG} 没查成（GitHub 回 502），提醒一条没动`],
    });
    expect([h.comments, h.alerts, h.resolved]).toEqual([[], [], []]);
  });

  it('【故意造出的失败】子单一页没读全：这张记没查成，母单那一种的提醒不撤', async () => {
    const h = harness(async () =>
      facts({ openIssues: [{ number: 20, title: '母单', subIssues: { total: 60, open: [], closed: [21] } }] }),
    );
    const r = await sweepClosing(h.deps);
    expect(r.unchecked).toEqual([`关单对账 ${SLUG} #20 有 60 张子单，只读到 1 张，判不了是不是都关了`]);
    expect(h.resolved.map((x) => x.key)).not.toContain(`close-sweep:${SLUG}:mother`);
  });

  it('【故意造出的失败】留言、提醒没写成：照实记没查成，不当成写上了；别的照做', async () => {
    const h = harness(async () => facts(), {
      comment: async () => {
        throw new Error('卫生检查拦下');
      },
      resolve: async () => {
        throw new Error('库连不上');
      },
    });
    const r = await sweepClosing(h.deps);
    expect(r.unchecked).toEqual([
      `关单对账 ${SLUG}#12 留言没留成（卫生检查拦下）`,
      `关单对账 ${SLUG} 的「子单都关了的母单」提醒没写成（库连不上）`,
      `关单对账 ${SLUG} 的「关了没结果」提醒没写成（库连不上）`,
    ]);
    expect(h.alerts.map((a) => a.key)).toEqual([`close-sweep:${SLUG}:due`]);
  });

  it('仓里没有 specs/：这个仓不按「关单要有结果」查，不算查过，什么都不动', async () => {
    const h = harness(async () => facts({ specsFiles: null }));
    expect(await sweepClosing(h.deps)).toEqual({ scanned: 0, found: 0, unchecked: [] });
    expect([h.comments, h.alerts, h.resolved]).toEqual([[], [], []]);
  });

  it('列不出受管的仓：原样抛出（调用方记这一步没跑成）', async () => {
    const h = harness(async () => facts(), {
      repos: async () => {
        throw new Error('读 repos 表超时');
      },
    });
    await expect(sweepClosing(h.deps)).rejects.toThrow('读 repos 表超时');
  });
});

describe('关单对账一天一次：北京时间 9:00 起的那一轮', () => {
  it.each([
    ['2026-09-28T01:00:05Z', true],
    ['2026-09-28T01:14:59Z', true],
    ['2026-09-28T01:15:00Z', false],
    ['2026-09-28T00:59:59Z', false],
    ['2026-09-28T09:00:00Z', false],
  ])('%s → %s', (at, due) => {
    expect(closeSweepDue(new Date(at))).toBe(due);
  });
});
