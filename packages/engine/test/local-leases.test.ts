// 拉单收本机领单到期的租约（决定 0096，jobs/local-leases.ts）：单关了记做完/停下；还活着（心跳、开着的 PR）顺延；
// 都没有就摘「本机做」、留言、退回法国队列。先动 GitHub 再改行；读不到记没查成，不当成没有。
import { LOCAL_LABEL } from '@fleet-dao/conventions';
import { LOCAL_LEASE_MS } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { type ExpiredLease, type LocalLeaseDeps, sweepLocalLeases } from '../src/jobs/local-leases.ts';

const NOW = new Date('2026-10-14T12:00:00Z');
const REPO = { id: 'r1', owner: 'acme', name: 'app' };
const lease = (issueNumber: number): ExpiredLease => ({
  taskId: `t${issueNumber}`,
  issueNumber,
  leaseUntil: new Date(NOW.getTime() - 60_000),
});

function world(o: {
  expired: ExpiredLease[];
  live?: number[] | Error;
  merged?: Record<number, number>;
  open: Record<number, string[]>;
  claims?: Record<number, number>;
  unmarkFails?: boolean;
}) {
  const steps: string[] = [];
  const deps: LocalLeaseDeps = {
    async expired() {
      return o.expired;
    },
    async liveIssues() {
      if (o.live instanceof Error) throw o.live;
      return new Set(o.live ?? []);
    },
    async mergedPr(_repo, n) {
      return o.merged?.[n] ?? null;
    },
    async extend(taskId, until) {
      steps.push(`extend ${taskId} ${until.getTime() - NOW.getTime()}`);
    },
    async settle({ taskId, how }) {
      steps.push(`settle ${taskId} ${how}`);
      return 1;
    },
    async unmarkLocal({ issueNumber }) {
      if (o.unmarkFails) throw new Error('GitHub 502');
      steps.push(`unmark ${issueNumber}`);
    },
  };
  const run = () =>
    sweepLocalLeases(deps, REPO, {
      open: new Map(Object.entries(o.open).map(([k, v]) => [Number(k), v] as const)),
      prClaims: async () => new Map(Object.entries(o.claims ?? {}).map(([k, v]) => [Number(k), v] as const)),
      comment: async ({ issueNumber, key }) => {
        steps.push(`comment ${issueNumber} ${key.split(':')[0]}`);
        return { created: true };
      },
      now: NOW,
      log: () => {},
    });
  return { steps, run };
}

describe('sweepLocalLeases', () => {
  it('没心跳、没 PR：摘「本机做」→ 留言 → 行退回法国（先 GitHub 后库）', async () => {
    const w = world({ expired: [lease(7)], open: { 7: [LOCAL_LABEL, '需求'] } });
    const r = await w.run();
    expect(r).toMatchObject({ returned: 1, extended: 0, closed: 0, unchecked: [] });
    expect(w.steps).toEqual(['unmark 7', 'comment 7 local-lease-expired', 'settle t7 returned']);
  });

  it('心跳里还在 local/<单号>- 分支上动、或有开着的 PR 挂着：顺延一个租约时长，不退回', async () => {
    const w = world({
      expired: [lease(7), lease(8)],
      open: { 7: [LOCAL_LABEL], 8: [LOCAL_LABEL] },
      live: [7],
      claims: { 8: 99 },
    });
    const r = await w.run();
    expect(r).toMatchObject({ extended: 2, returned: 0 });
    expect(w.steps).toEqual([`extend t7 ${LOCAL_LEASE_MS}`, `extend t8 ${LOCAL_LEASE_MS}`]);
  });

  it('单已关：有合并的 PR 记做完，没有记停下；不摘标签、不留言', async () => {
    const w = world({ expired: [lease(7), lease(8)], open: {}, merged: { 7: 70 } });
    const r = await w.run();
    expect(r).toMatchObject({ closed: 2 });
    expect(w.steps).toEqual(['settle t7 done', 'settle t8 closed']);
  });

  it('【故意造出的失败】心跳读不到：这一轮只顺延不退回，记没查成', async () => {
    const w = world({ expired: [lease(7)], open: { 7: [LOCAL_LABEL] }, live: new Error('库连不上') });
    const r = await w.run();
    expect(r.returned).toBe(0);
    expect(r.unchecked.join()).toContain('心跳没读成');
    expect(w.steps).toEqual([`extend t7 ${LOCAL_LEASE_MS}`]);
  });

  it('【故意造出的失败】标签摘不掉：行不动（下一轮整件事重来），记没查成', async () => {
    const w = world({ expired: [lease(7)], open: { 7: [LOCAL_LABEL] }, unmarkFails: true });
    const r = await w.run();
    expect(r.returned).toBe(0);
    expect(r.unchecked.join()).toContain('GitHub 502');
    expect(w.steps).toEqual([]);
  });

  it('单上本来没贴「本机做」：不摘，照样留言、退回', async () => {
    const w = world({ expired: [lease(7)], open: { 7: [] } });
    await w.run();
    expect(w.steps).toEqual(['comment 7 local-lease-expired', 'settle t7 returned']);
  });
});
