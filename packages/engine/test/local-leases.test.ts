// 拉单收本机领单到期的租约（决定 0096，jobs/local-leases.ts）：单关了记做完/停下；还活着（心跳、开着的 PR）顺延；
// 都没有就摘「本机做」、留言、退回法国队列。先动 GitHub 再改行；读不到记没查成，不当成没有。
import { LOCAL_LABEL } from '@fleet-dao/conventions';
import type { LocalSession } from '@fleet-dao/shared';
import { LOCAL_LEASE_MS } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import {
  type ExpiredLease,
  type FranceVerdict,
  type LeaseNotice,
  type LocalLeaseDeps,
  liveLocalIssues,
  sweepLocalLeases,
} from '../src/jobs/local-leases.ts';

const NOW = new Date('2026-10-14T12:00:00Z');
const REPO = { id: 'r1', owner: 'acme', name: 'app' };
const lease = (issueNumber: number): ExpiredLease => ({
  taskId: `t${issueNumber}`,
  issueNumber,
  leaseUntil: new Date(NOW.getTime() - 60_000),
});

function world(o: {
  expired: ExpiredLease[];
  unexpired?: ExpiredLease[];
  unexpiredFails?: boolean;
  live?: number[] | Error;
  merged?: Record<number, number>;
  open: Record<number, string[]>;
  claims?: Record<number, number>;
  unmarkFails?: boolean;
  /** 任务行 → 还开着的验收责任（#3037）；Error = 读不到。不给 = 没装这个口子。 */
  duties?: Record<string, { prNumber: number; head: string; items: string[] }[]> | Error;
  /** 法国接不接得了（#3461）：单号 → 判决；没写的算接得了；Error = 判不了。不给 = 没装这个口子，照旧退回。 */
  verdicts?: Record<number, FranceVerdict> | Error;
}) {
  const steps: string[] = [];
  const bodies: string[] = [];
  const notices: string[] = [];
  const duties = o.duties;
  const deps: LocalLeaseDeps = {
    ...(duties === undefined
      ? {}
      : {
          async openDuties(taskId: string) {
            if (duties instanceof Error) throw duties;
            return duties[taskId] ?? [];
          },
        }),
    async expired() {
      return o.expired;
    },
    async unexpired() {
      if (o.unexpiredFails) throw new Error('库连不上');
      return o.unexpired ?? [];
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
    async settle({ taskId, how, early }) {
      steps.push(`settle ${taskId} ${how}${early ? ' early' : ''}`);
      return 1;
    },
    async unmarkLocal({ issueNumber }) {
      if (o.unmarkFails) throw new Error('GitHub 502');
      steps.push(`unmark ${issueNumber}`);
    },
  };
  const verdicts = o.verdicts;
  const run = () =>
    sweepLocalLeases(deps, REPO, {
      open: new Map(Object.entries(o.open).map(([k, v]) => [Number(k), v] as const)),
      prClaims: async () => new Map(Object.entries(o.claims ?? {}).map(([k, v]) => [Number(k), v] as const)),
      comment: async ({ issueNumber, key, body }) => {
        steps.push(`comment ${issueNumber} ${key.split(':')[0]}`);
        bodies.push(body);
        return { created: true };
      },
      ...(verdicts === undefined
        ? {}
        : {
            async franceVerdict(issueNumber: number): Promise<FranceVerdict> {
              if (verdicts instanceof Error) throw verdicts;
              return verdicts[issueNumber] ?? { ok: true };
            },
            async notify({ issueNumber, key, title }: LeaseNotice) {
              steps.push(`notify ${issueNumber} ${key.split(':')[0]}`);
              notices.push(title);
            },
          }),
      now: NOW,
      log: () => {},
    });
  return { steps, bodies, notices, run };
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

  it('没到期的租约：单已关且 PR 合了就当轮收成做完（不用手动 work done）；单还开着、或 PR 镜像还没到的不动', async () => {
    const fresh = (n: number): ExpiredLease => ({
      taskId: `t${n}`,
      issueNumber: n,
      leaseUntil: new Date(NOW.getTime() + 3_600_000),
    });
    const w = world({
      expired: [],
      unexpired: [fresh(7), fresh(8), fresh(9)],
      open: { 8: [LOCAL_LABEL] },
      merged: { 7: 70 },
    });
    const r = await w.run();
    expect(r).toMatchObject({ closed: 1, unchecked: [] });
    expect(w.steps).toEqual(['settle t7 done early']);
  });

  it('【故意造出的失败】没到期的租约读不到：记没查成，到期的照常收', async () => {
    const w = world({ expired: [lease(7)], unexpiredFails: true, open: { 7: [] } });
    const r = await w.run();
    expect(r.unchecked.join()).toContain('提前收没做成');
    expect(r.returned).toBe(1);
  });

  it('单上本来没贴「本机做」：不摘，照样留言、退回', async () => {
    const w = world({ expired: [lease(7)], open: { 7: [] } });
    await w.run();
    expect(w.steps).toEqual(['comment 7 local-lease-expired', 'settle t7 returned']);
  });
});

describe('sweepLocalLeases：法国接不了的单不退回（#3461）', () => {
  const offDiff: FranceVerdict = {
    ok: false,
    reason: 'acceptance_off_diff',
    why: '「怎么算做完」要 diff 外证据：截图',
  };

  it('验收要 diff 外证据（法国接不了）：不摘「本机做」、不退回、行不动；先通知本机再留言写明为什么', async () => {
    const w = world({ expired: [lease(7)], open: { 7: [LOCAL_LABEL] }, verdicts: { 7: offDiff } });
    const r = await w.run();
    expect(r).toMatchObject({ keptLocal: 1, returned: 0, extended: 0, closed: 0, unchecked: [] });
    expect(w.steps).toEqual(['notify 7 local-lease-kept', 'comment 7 local-lease-kept']);
    expect(w.notices[0]).toContain('#7');
    expect(w.bodies[0]).toContain('acceptance_off_diff');
    expect(w.bodies[0]).toContain('截图');
    expect(w.bodies[0]).toContain('没摘');
  });

  it('法国接得了：照旧摘标签、留言、退回', async () => {
    const w = world({ expired: [lease(7)], open: { 7: [LOCAL_LABEL] }, verdicts: {} });
    const r = await w.run();
    expect(r).toMatchObject({ returned: 1, keptLocal: 0 });
    expect(w.steps).toEqual(['unmark 7', 'comment 7 local-lease-expired', 'settle t7 returned']);
  });

  it('一次到期两张：接不了的留着，接得了的退回，互不影响', async () => {
    const w = world({
      expired: [lease(7), lease(8)],
      open: { 7: [LOCAL_LABEL], 8: [LOCAL_LABEL] },
      verdicts: { 7: offDiff },
    });
    const r = await w.run();
    expect(r).toMatchObject({ keptLocal: 1, returned: 1 });
    expect(w.steps).toEqual([
      'notify 7 local-lease-kept',
      'comment 7 local-lease-kept',
      'unmark 8',
      'comment 8 local-lease-expired',
      'settle t8 returned',
    ]);
  });

  it('还活着（心跳、开着的 PR）的照旧顺延，不去判法国接不接得了', async () => {
    const w = world({ expired: [lease(7)], open: { 7: [LOCAL_LABEL] }, live: [7], verdicts: { 7: offDiff } });
    const r = await w.run();
    expect(r).toMatchObject({ extended: 1, keptLocal: 0 });
    expect(w.steps).toEqual([`extend t7 ${LOCAL_LEASE_MS}`]);
  });

  it('【故意造出的失败】判不了（试判读不到东西）：这一条记没查成，不摘标签、不退回、行不动', async () => {
    const w = world({ expired: [lease(7)], open: { 7: [LOCAL_LABEL] }, verdicts: new Error('GitHub 502') });
    const r = await w.run();
    expect(r).toMatchObject({ returned: 0, keptLocal: 0 });
    expect(r.unchecked).toEqual([expect.stringContaining('GitHub 502')]);
    expect(w.steps).toEqual([]);
  });

  it('不给判口子（老装配）：和原来一样退回', async () => {
    const w = world({ expired: [lease(7)], open: { 7: [LOCAL_LABEL] } });
    const r = await w.run();
    expect(r).toMatchObject({ returned: 1, keptLocal: 0 });
  });
});

describe('sweepLocalLeases：验收责任跟着单子走（#3037）', () => {
  const HEAD = 'a'.repeat(40);
  const field = { prNumber: 3031, head: HEAD, items: ['现场 add/check 五条', '线上数据核对'] };

  it('代码已合、验收责任还开着：不退回法国重做、不摘标签；留言列出原验收项和 PR、头，行记做完', async () => {
    const w = world({
      expired: [lease(7)],
      open: { 7: [LOCAL_LABEL] },
      merged: { 7: 3031 },
      duties: { t7: [field] },
    });
    const r = await w.run();
    expect(r).toMatchObject({ returned: 0, awaitingAcceptance: 1, unchecked: [] });
    expect(w.steps).toEqual(['comment 7 local-lease-acceptance', 'settle t7 done']);
    expect(w.bodies[0]).toContain('PR #3031');
    expect(w.bodies[0]).toContain(HEAD);
    expect(w.bodies[0]).toContain('- 现场 add/check 五条');
    expect(w.bodies[0]).toContain('- 线上数据核对');
  });

  it('只剩协调验收责任（没有代码、没有 PR）：同样留着等人验，不要求开空 PR', async () => {
    const w = world({
      expired: [lease(7)],
      open: { 7: [LOCAL_LABEL] },
      duties: { t7: [{ prNumber: 0, head: '', items: ['和对方确认上线窗口'] }] },
    });
    const r = await w.run();
    expect(r).toMatchObject({ returned: 0, awaitingAcceptance: 1 });
    expect(w.steps).toEqual(['comment 7 local-lease-acceptance', 'settle t7 done']);
    expect(w.bodies[0]).toContain('协调验收责任');
  });

  it('有验收责任、代码还没合：照旧退回法国，退回的留言里列出原验收项（收回不丢验收范围）', async () => {
    const w = world({ expired: [lease(7)], open: { 7: [LOCAL_LABEL] }, duties: { t7: [field] } });
    const r = await w.run();
    expect(r).toMatchObject({ returned: 1, awaitingAcceptance: 0 });
    expect(w.steps).toEqual(['unmark 7', 'comment 7 local-lease-expired', 'settle t7 returned']);
    expect(w.bodies[0]).toContain('- PR #3031：现场 add/check 五条');
  });

  it('没有验收责任、代码也没合：和原来一样退回', async () => {
    const w = world({ expired: [lease(7)], open: { 7: [LOCAL_LABEL] }, duties: {} });
    const r = await w.run();
    expect(r).toMatchObject({ returned: 1, awaitingAcceptance: 0 });
    expect(w.steps).toEqual(['unmark 7', 'comment 7 local-lease-expired', 'settle t7 returned']);
  });

  it('#3601：#3591 起责任账恒为空，代码已合、单还开着、贴着「本机做」：不摘标签、不退回法国重做，记做完留着等人验', async () => {
    for (const duties of [{}, undefined]) {
      const w = world({
        expired: [lease(7)],
        open: { 7: [LOCAL_LABEL] },
        merged: { 7: 3031 },
        ...(duties === undefined ? {} : { duties }),
        verdicts: {},
      });
      const r = await w.run();
      expect(r).toMatchObject({ returned: 0, awaitingAcceptance: 1, unchecked: [] });
      expect(w.steps).toEqual(['comment 7 local-lease-acceptance', 'settle t7 done']);
      expect(w.steps).not.toContain('unmark 7');
      expect(w.bodies[0]).toContain('PR #3031');
      expect(w.bodies[0]).toContain('单子还开着');
    }
  });

  it('【故意造出的失败】验收责任读不到：这一条记没查成，不摘标签、不退回、不改行（不当成没有待验的）', async () => {
    const w = world({
      expired: [lease(7)],
      open: { 7: [LOCAL_LABEL] },
      merged: { 7: 3031 },
      duties: new Error('库连不上'),
    });
    const r = await w.run();
    expect(r).toMatchObject({ returned: 0, awaitingAcceptance: 0 });
    expect(r.unchecked).toEqual([expect.stringContaining('库连不上')]);
    expect(w.steps).toEqual([]);
  });
});

const MIN = 60_000;
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

function session(over: Partial<LocalSession>): LocalSession {
  return {
    id: 's',
    repo: 'acme/app',
    branch: 'local/7-x',
    worktree: 'a2',
    subagent: true,
    startedAt: at(-60 * MIN),
    lastSeenAt: at(-MIN),
    last: 'tool',
    lastTool: 'Bash',
    ...over,
  };
}

function node(sessions: LocalSession[], receivedAgo = MIN) {
  return {
    receivedAt: at(-receivedAgo),
    report: {
      schemaVersion: 1 as const,
      reportedAt: at(-receivedAgo),
      machine: 'pc',
      sessions,
      problems: [],
    },
  };
}

describe('liveLocalIssues：心跳里还活着的本机单', () => {
  it('local/<单号>- 分支上、不到租约时长前动过、没收场的才算；仓要对上；引擎分支不算', () => {
    const live = liveLocalIssues(
      [
        node([
          session({ id: 'a', branch: 'local/7-x' }),
          session({ id: 'b', branch: 'local/8-x', last: 'stop', lastSeenAt: at(-30 * MIN) }),
          session({ id: 'c', branch: 'local/9-x', lastSeenAt: at(-LOCAL_LEASE_MS - MIN) }),
          session({ id: 'd', branch: 'local/10-x', last: 'end' }),
          session({ id: 'e', branch: 'fleet/11-tabcdef12' }),
          session({ id: 'f', branch: 'local/12-x', repo: 'acme/other' }),
          session({ id: 'g', branch: 'feat/x' }),
        ]),
      ],
      'ACME/app',
      NOW,
    );
    expect([...live].sort((a, b) => a - b)).toEqual([7, 8]);
  });

  it('【故意造出的失败】整份推来已经超过租约时长：不拿旧心跳当活着', () => {
    expect(liveLocalIssues([node([session({})], LOCAL_LEASE_MS + MIN)], 'acme/app', NOW).size).toBe(0);
  });
});
