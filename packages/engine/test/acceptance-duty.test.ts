// 验收责任（#3037）只剩旧行只读（#3591 停写，#3630 删掉结清、替代、归并的写口）：真库上还开着的旧行照旧读得到——
// 本机租约到期时代码已合、责任还开着，不退回法国重做；协调责任（PR 0、头空）照样留着等人验；读不成抛「没查成」，不回空数组冒充没有。
// 还开着的旧行由 jobs/acceptance-handback-once.ts 一次性交回原单（见 acceptance-handback-once.test.ts）。

import { LOCAL_LABEL } from '@fleet-dao/conventions';
import { acceptanceDuties, expiredLocalClaims, repos, settleExpiredLocalClaim, tasks } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type LocalLeaseDeps, sweepLocalLeases } from '../src/jobs/local-leases.ts';
import { PortError } from '../src/ports.ts';
import { openAcceptanceDuties } from '../src/real/store-ports.ts';
import { handoffBody } from '../src/real/task-verify.ts';

const NOW = new Date('2026-10-18T08:00:00Z');
const HEAD = '6864f9d19e663b2d99086c1f5f830cd08a44d79e';
const MERGE = 'd920584aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const FIELD = ['现场 add 一条', '现场 check 一条'];
const REPO_REF = { owner: 'acme', name: 'shop' };

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

/** 一个仓、一张本机在做、租约已过的单。 */
async function seed(): Promise<{ repoId: string; taskId: string }> {
  const [repo] = await t.db
    .insert(repos)
    .values({ ...REPO_REF, testCommand: 'pnpm check' })
    .returning();
  if (!repo) throw new Error('仓没建成');
  const [task] = await t.db
    .insert(tasks)
    .values({
      repoId: repo.id,
      issueNumber: 2994,
      title: '现场 add/check',
      rawRequest: '把本机能做的继续做',
      requestedBy: 'frank',
      priority: 1,
      state: 'running',
      executor: 'local',
      claimedBy: 'env-1',
      leaseUntil: new Date(NOW.getTime() - 60_000),
    })
    .returning();
  if (!task) throw new Error('任务行没建成');
  return { repoId: repo.id, taskId: task.id };
}

/** #3037 时期留下的旧行（#3591 起引擎不再写）：测试直接插库造。 */
const oldDuty = (taskId: string, over: Partial<typeof acceptanceDuties.$inferInsert> = {}) =>
  t.db.insert(acceptanceDuties).values({
    taskId,
    repo: 'acme/shop',
    issueNumber: 2994,
    prNumber: 3031,
    head: HEAD,
    items: FIELD,
    source: 'cold_verify',
    ...over,
  });

const taskRow = (taskId: string) => t.db.query.tasks.findFirst({ where: (r, { eq }) => eq(r.id, taskId) });

/** 本机租约收回的依赖：行、责任都读真库；GitHub 那一侧记下做了什么。 */
function leaseDeps(merged: number | null, steps: string[]): LocalLeaseDeps {
  return {
    expired: (repo, at) => expiredLocalClaims(t.db, repo.id, at),
    liveIssues: async () => new Set(),
    mergedPr: async () => merged,
    extend: async () => {
      throw new Error('不该顺延');
    },
    settle: (input) => settleExpiredLocalClaim(t.db, input),
    unmarkLocal: async ({ issueNumber }) => {
      steps.push(`unmark ${issueNumber}`);
    },
    openDuties: (taskId) => openAcceptanceDuties(t.db, taskId),
  };
}

const sweepCtx = (steps: string[], bodies: string[]) => ({
  open: new Map([[2994, [LOCAL_LABEL]]]),
  prClaims: async () => new Map<number, number>(),
  comment: async ({ issueNumber, key, body }: { issueNumber: number; key: string; body: string }) => {
    steps.push(`comment ${issueNumber} ${key.split(':')[0]}`);
    bodies.push(body);
    return { created: true };
  },
  now: NOW,
  log: () => {},
});

describe('旧验收责任只读（#3037 → #3591 停写 → #3630 删写口）', () => {
  it('没有旧责任：租约到期照旧退回法国；转人留言只写转人、代码照合、单子留着', async () => {
    const { repoId, taskId } = await seed();
    const steps: string[] = [];
    const first = await sweepLocalLeases(
      leaseDeps(null, steps),
      { id: repoId, ...REPO_REF },
      sweepCtx(steps, []),
    );
    expect(first).toMatchObject({ returned: 1, awaitingAcceptance: 0, unchecked: [] });
    expect(await taskRow(taskId)).toMatchObject({ state: 'stopped', executor: 'engine' });
    expect(handoffBody({ prNumber: 3031, headSha: HEAD }, FIELD)).not.toContain('验收责任已记下');
    expect(handoffBody({ prNumber: 3031, headSha: HEAD }, FIELD)).toContain('这张单留着不关');
  });

  it('本机租约到期时代码已合、旧责任还开着（真库读）：不退回法国重做、不摘标签，留言列原验收项，行记做完、责任还在', async () => {
    const { repoId, taskId } = await seed();
    await oldDuty(taskId, { mergeCommit: MERGE, mergedAt: NOW });
    expect(await openAcceptanceDuties(t.db, taskId)).toEqual([
      {
        repo: 'acme/shop',
        issueNumber: 2994,
        prNumber: 3031,
        head: HEAD,
        items: FIELD,
        source: 'cold_verify',
        mergeCommit: MERGE,
      },
    ]);
    const steps: string[] = [];
    const bodies: string[] = [];
    const r = await sweepLocalLeases(
      leaseDeps(3031, steps),
      { id: repoId, ...REPO_REF },
      sweepCtx(steps, bodies),
    );
    expect(r).toMatchObject({ returned: 0, awaitingAcceptance: 1, unchecked: [] });
    expect(steps).toEqual(['comment 2994 local-lease-acceptance']);
    expect(bodies[0]).toContain(`PR #3031（头 ${HEAD}）`);
    for (const item of FIELD) expect(bodies[0]).toContain(`- ${item}`);
    expect(await taskRow(taskId)).toMatchObject({ state: 'done', executor: 'local' });
    expect(await openAcceptanceDuties(t.db, taskId)).toHaveLength(1);
  });

  it('长期协调 / 无代码单的旧协调责任（PR 0、头空）：租约到期留着等人验', async () => {
    const { repoId, taskId } = await seed();
    await oldDuty(taskId, { prNumber: 0, head: '', items: ['和对方确认上线窗口'], source: 'coordination' });
    expect(await openAcceptanceDuties(t.db, taskId)).toEqual([
      expect.objectContaining({ prNumber: 0, head: '', source: 'coordination' }),
    ]);
    const steps: string[] = [];
    const r = await sweepLocalLeases(
      leaseDeps(null, steps),
      { id: repoId, ...REPO_REF },
      sweepCtx(steps, []),
    );
    expect(r).toMatchObject({ returned: 0, awaitingAcceptance: 1 });
    expect(steps).toEqual(['comment 2994 local-lease-acceptance']);
  });

  it('交回之后（settled_* 写了交回记录）：不再算开着，租约到期照旧退回法国', async () => {
    const { repoId, taskId } = await seed();
    await oldDuty(taskId, { settledAt: NOW, settledBy: 'handback:#3630', settleEvidence: '交回原单' });
    expect(await openAcceptanceDuties(t.db, taskId)).toEqual([]);
    const steps: string[] = [];
    const r = await sweepLocalLeases(
      leaseDeps(null, steps),
      { id: repoId, ...REPO_REF },
      sweepCtx(steps, []),
    );
    expect(r).toMatchObject({ returned: 1, awaitingAcceptance: 0 });
  });

  it('【故意造出的失败】库读不成：抛可重试的「没查成」，不回空数组冒充没有待验的', async () => {
    const broken = {
      query: {
        acceptanceDuties: {
          findMany: async () => {
            throw new Error('连接断了');
          },
        },
      },
    } as unknown as TestDb['db'];
    const err = await openAcceptanceDuties(broken, 'x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortError);
    expect(err).toMatchObject({ code: 'ACCEPTANCE_DUTY_UNCHECKED', retryable: true });
    expect(String((err as Error).message)).toContain('连接断了');
  });
});
