// 验收责任（#3037）在真库上的一条完整的路：本机租约到期 → 退回法国 → 法国冷验收代码过了、有「不归我验」→ PR 合并 → 引擎重启。
// 代码照合（决定 0093），可验收责任一直挂在任务行上：原验收项、精确的仓 / 单 / PR / 头、合并回执都在，租约收回、合并、重启都不丢；
// 重复转交、合并回执重来只落一行；只有最终验收完成（谁验的、凭什么）才把它收掉。读不成抛「没查成」，不回空数组冒充没有。

import { LOCAL_LABEL } from '@fleet-dao/conventions';
import {
  acceptanceDuties,
  expiredLocalClaims,
  readAcceptanceDutyRows,
  repos,
  settleAcceptanceDuty,
  settleExpiredLocalClaim,
  tasks,
} from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type LocalLeaseDeps, sweepLocalLeases } from '../src/jobs/local-leases.ts';
import { PortError } from '../src/ports.ts';
import { openAcceptanceDuties, recordAcceptanceDuties } from '../src/real/store-ports.ts';
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

describe('验收责任（#3037）：租约过期 → 法国接管 → 代码过了带不归我验 → 合并 → 重启', () => {
  it('代码照合，验收责任连原验收项、仓、单、PR、头、合并回执一路留着，不丢、不重复；只有最终验收完成收得掉', async () => {
    const { repoId, taskId } = await seed();
    const repo = { id: repoId, ...REPO_REF };

    // 1. 本机租约到期、没有验收责任：照旧退回法国（同一行任务，stopped + engine）
    const steps: string[] = [];
    const bodies: string[] = [];
    const first = await sweepLocalLeases(leaseDeps(null, steps), repo, sweepCtx(steps, bodies));
    expect(first).toMatchObject({ returned: 1, awaitingAcceptance: 0, unchecked: [] });
    const back = await taskRow(taskId);
    expect(back).toMatchObject({ state: 'stopped', executor: 'engine' });

    // 2. 法国接管同一行：冷验收过了，「不归我验」转给人（handOff 记的那一份）。转人的留言写明代码照合、单子留着
    const handed = await recordAcceptanceDuties(
      t.db,
      { taskId, repo: REPO_REF, issueNumber: 2994, record: [{ prNumber: 3031, head: HEAD, items: FIELD }] },
      NOW,
    );
    expect(handed).toHaveLength(1);
    // 合并收口认的那一句（conventions 的 ACCEPTANCE_OPEN_MARK，两边一字不差）
    expect(handoffBody({ prNumber: 3031, headSha: HEAD }, FIELD)).toContain('验收责任已记下');
    expect(handoffBody({ prNumber: 3031, headSha: HEAD }, FIELD)).toContain(HEAD);

    // 3. 同一个头重复转交（验收重来）：只一行，原验收项并起来不丢
    await recordAcceptanceDuties(
      t.db,
      {
        taskId,
        repo: REPO_REF,
        issueNumber: 2994,
        record: [{ prNumber: 3031, head: HEAD, items: [FIELD[0] ?? ''] }],
      },
      NOW,
    );

    // 4. PR 合并：工作流收尾带合并回执再记一遍（幂等），读回来仍开着 → 不关单
    const merged = await recordAcceptanceDuties(
      t.db,
      {
        taskId,
        repo: REPO_REF,
        issueNumber: 2994,
        record: [{ prNumber: 3031, head: HEAD, items: FIELD, mergeCommit: MERGE }],
      },
      NOW,
    );
    expect(merged).toEqual([
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
    // 合并回执重来（换了个说法）：只补不改
    await recordAcceptanceDuties(
      t.db,
      {
        taskId,
        repo: REPO_REF,
        issueNumber: 2994,
        record: [{ prNumber: 3031, head: HEAD, items: FIELD, mergeCommit: 'ffffffff' }],
      },
      NOW,
    );

    // 5. 引擎重启：不靠内存，从库里现读，原样还在
    const afterRestart = await openAcceptanceDuties(t.db, taskId);
    expect(afterRestart).toEqual(merged);
    expect(await t.db.select().from(acceptanceDuties)).toHaveLength(1);

    // 6. 最终验收完成（谁验的、凭什么）才收掉；收掉以后重复转交同一个头不会再开回去
    const [duty] = await readAcceptanceDutyRows(t.db, { repo: 'acme/shop', issueNumber: 2994 });
    if (!duty) throw new Error('missing duty');
    await settleAcceptanceDuty(t.db, { ...duty, by: 'frank', evidence: '现场截图 #c123' }, NOW);
    expect(await openAcceptanceDuties(t.db, taskId)).toEqual([]);
    await recordAcceptanceDuties(
      t.db,
      { taskId, repo: REPO_REF, issueNumber: 2994, record: [{ prNumber: 3031, head: HEAD, items: FIELD }] },
      NOW,
    );
    expect(await openAcceptanceDuties(t.db, taskId)).toEqual([]);
  });

  it('并发首次与后续转交保留全部不同项，旧代次不能收掉新项', async () => {
    const { taskId } = await seed();
    const record = (items: string[]) =>
      recordAcceptanceDuties(
        t.db,
        {
          taskId,
          repo: REPO_REF,
          issueNumber: 2994,
          record: [{ prNumber: 3031, head: HEAD, items, mergeCommit: MERGE }],
        },
        NOW,
      );
    await Promise.all([record(['A']), record(['B'])]);
    const [first] = await readAcceptanceDutyRows(t.db, { repo: 'acme/shop', issueNumber: 2994 });
    if (!first) throw new Error('missing duty');
    expect(first.items).toEqual(['A', 'B']);
    await Promise.all([record(['C']), record(['D'])]);
    await expect(
      settleAcceptanceDuty(t.db, { ...first, by: 'frank', evidence: '旧凭据' }, NOW),
    ).rejects.toThrow(/代次/);
    const [current] = await readAcceptanceDutyRows(t.db, { repo: 'acme/shop', issueNumber: 2994 });
    if (!current) throw new Error('missing duty');
    expect(current.items).toEqual(['A', 'B', 'C', 'D']);
    await settleAcceptanceDuty(t.db, { ...current, by: 'frank', evidence: '四项均验' }, NOW);
    await record(['E']);
    expect(await openAcceptanceDuties(t.db, taskId)).toEqual([
      expect.objectContaining({ items: ['A', 'B', 'C', 'D', 'E'] }),
    ]);
  });

  it('本机租约到期时代码已合、验收责任还开着（真库读）：不退回法国重做、不摘标签，留言列原验收项，行记做完、责任还在', async () => {
    const { repoId, taskId } = await seed();
    await recordAcceptanceDuties(
      t.db,
      { taskId, repo: REPO_REF, issueNumber: 2994, record: [{ prNumber: 3031, head: HEAD, items: FIELD }] },
      NOW,
    );
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
    const row = await taskRow(taskId);
    expect(row).toMatchObject({ state: 'done', executor: 'local' });
    expect(await openAcceptanceDuties(t.db, taskId)).toHaveLength(1);
  });

  it('长期协调 / 无代码单：协调验收责任 PR 记 0、头记空，不要求开空 PR；租约到期留着等人验', async () => {
    const { repoId, taskId } = await seed();
    const open = await recordAcceptanceDuties(
      t.db,
      {
        taskId,
        repo: REPO_REF,
        issueNumber: 2994,
        record: [{ prNumber: 0, head: '', items: ['和对方确认上线窗口'] }],
      },
      NOW,
    );
    expect(open).toEqual([expect.objectContaining({ prNumber: 0, head: '', source: 'coordination' })]);
    const steps: string[] = [];
    const r = await sweepLocalLeases(
      leaseDeps(null, steps),
      { id: repoId, ...REPO_REF },
      sweepCtx(steps, []),
    );
    expect(r).toMatchObject({ returned: 0, awaitingAcceptance: 1 });
    expect(steps).toEqual(['comment 2994 local-lease-acceptance']);
  });

  it('【故意造出的失败】记不了的形状（没有验收项、有 PR 没头）：明说不记，不悄悄吞掉', async () => {
    const { taskId } = await seed();
    for (const bad of [
      { prNumber: 3031, head: HEAD, items: [' '] },
      { prNumber: 3031, head: '', items: FIELD },
      { prNumber: 0, head: HEAD, items: FIELD },
    ]) {
      await expect(
        recordAcceptanceDuties(t.db, { taskId, repo: REPO_REF, issueNumber: 2994, record: [bad] }, NOW),
      ).rejects.toMatchObject({ code: 'ACCEPTANCE_DUTY_INVALID' });
    }
    expect(await t.db.select().from(acceptanceDuties)).toEqual([]);
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
