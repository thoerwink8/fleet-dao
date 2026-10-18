// 验收责任（#3037）在真库上的一条完整的路：本机租约到期 → 退回法国 → 法国冷验收代码过了、有「不归我验」→ PR 合并 → 引擎重启。
// 代码照合（决定 0093），可验收责任一直挂在任务行上：原验收项、精确的仓 / 单 / PR / 头、合并回执都在，租约收回、合并、重启都不丢；
// 重复转交、合并回执重来只落一行；只有最终验收完成（谁验的、凭什么）才把它收掉。读不成抛「没查成」，不回空数组冒充没有。

import { LOCAL_LABEL } from '@fleet-dao/conventions';
import {
  type AcceptanceDutyRow,
  acceptanceDuties,
  acceptanceDutySupersessions,
  expiredLocalClaims,
  readAcceptanceDutyRows,
  readAcceptanceDutySupersessions,
  repos,
  settleAcceptanceDuty,
  settleExpiredLocalClaim,
  supersedeAcceptanceDuty,
  tasks,
} from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { acceptanceDutyState } from '@fleet-dao/shared';
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

// #3071 / PR #3081 的现场：旧头 c471… 转人后 PR 又换头，旧头永远没有合并回执；最终头 aa5b… 绑了真 squash b41e… 并验完。
// 旧头走标准 settle 被拒是对的；替代收口把它指向最终责任，旧行合并回执照旧空着，引擎收尾、status、公开读口同一判法。
describe('旧头验收责任替代收口（#3114）', () => {
  const OLD = 'c471bae51632e024f9aeaace4c8e074e627c1376';
  const FINAL = 'aa5b84356ca84f8b50cdb05cf606614741049437';
  const SQUASH = 'b41eaed8886eb30e799a1a9911414b55e17d56c6';
  const ISSUE = { repo: 'acme/shop', issueNumber: 2994 };
  const BY = 'ops:acceptance:frank';
  const ident = (r: AcceptanceDutyRow) => ({
    id: r.id,
    generation: r.generation,
    repo: r.repo,
    issueNumber: r.issueNumber,
    prNumber: r.prNumber,
    head: r.head,
  });
  async function rowAt(head: string, issue: { repo: string; issueNumber: number } = ISSUE) {
    const row = (await readAcceptanceDutyRows(t.db, issue)).find((r) => r.head === head);
    if (!row) throw new Error(`missing duty ${head}`);
    return row;
  }
  const record = (
    taskId: string,
    r: { prNumber: number; head: string; items: string[]; mergeCommit?: string },
    repo = REPO_REF,
    issueNumber = 2994,
  ) => recordAcceptanceDuties(t.db, { taskId, repo, issueNumber, record: [r] }, NOW);
  const settle = async (head: string, issue = ISSUE) =>
    settleAcceptanceDuty(
      t.db,
      { ...ident(await rowAt(head, issue)), by: 'frank', evidence: '最终头现场验收' },
      NOW,
    );
  const supersede = (
    source: AcceptanceDutyRow,
    target: AcceptanceDutyRow,
    evidence = 'PR #3081 最终头已合已验',
  ) => supersedeAcceptanceDuty(t.db, { source: ident(source), target: ident(target), by: BY, evidence }, NOW);
  const states = async () => {
    const rows = await readAcceptanceDutyRows(t.db, ISSUE);
    return Object.fromEntries(rows.map((r) => [r.head, acceptanceDutyState(r, rows)]));
  };

  /** 旧头转人没合；最终头带真合并回执、最终验收完成。 */
  async function scenario() {
    const { taskId } = await seed();
    await record(taskId, { prNumber: 3081, head: OLD, items: FIELD });
    await record(taskId, {
      prNumber: 3081,
      head: FINAL,
      items: [...FIELD, '最终头多验一条'],
      mergeCommit: SQUASH,
    });
    await settle(FINAL);
    return { taskId, old: await rowAt(OLD), final: await rowAt(FINAL) };
  }

  it('旧头无合并回执、最终头已合已验：标准 settle 照拒；显式替代后旧行保留、回执不伪填，三处读法一致不再挡关单', async () => {
    const { taskId, old, final } = await scenario();
    // 只凭同 PR 已合不自动消账：旧头还开着，引擎收尾照留原单
    expect(await openAcceptanceDuties(t.db, taskId)).toEqual([expect.objectContaining({ head: OLD })]);
    await expect(
      settleAcceptanceDuty(t.db, { ...ident(old), by: 'frank', evidence: '冒领' }, NOW),
    ).rejects.toThrow(/完成回执/);

    const done = await supersede(old, final);
    expect(done).toMatchObject({
      id: old.id,
      generation: old.generation,
      head: OLD,
      mergeCommit: null,
      mergedAt: null,
      settledAt: null,
      settledBy: null,
      supersededBy: BY,
      supersedeEvidence: 'PR #3081 最终头已合已验',
      successorId: final.id,
      successorGeneration: final.generation,
    });
    expect(done.supersededAt).toEqual(NOW);
    expect(await states()).toEqual({ [OLD]: 'superseded', [FINAL]: 'settled' });
    expect(await openAcceptanceDuties(t.db, taskId)).toEqual([]);
    await expect(
      settleAcceptanceDuty(t.db, { ...ident(old), by: 'frank', evidence: '迟到的旧头验收' }, NOW),
    ).rejects.toThrow(/完成回执|代次/);
    expect(await readAcceptanceDutySupersessions(t.db, ISSUE)).toEqual([
      expect.objectContaining({
        sourceId: old.id,
        sourceGeneration: old.generation,
        sourceHead: OLD,
        targetId: final.id,
        targetGeneration: final.generation,
        targetHead: FINAL,
        targetMergeCommit: SQUASH,
        prNumber: 3081,
        by: BY,
        evidence: 'PR #3081 最终头已合已验',
        createdAt: NOW,
      }),
    ]);
    expect(await t.db.select().from(acceptanceDuties)).toHaveLength(2);

    // 同一请求重放幂等，不多记操作；换证据、换目标不冒充成功
    expect(await supersede(old, final)).toMatchObject({ id: old.id, successorId: final.id });
    expect(await readAcceptanceDutySupersessions(t.db, ISSUE)).toHaveLength(1);
    await expect(supersede(old, final, '另一份证据')).rejects.toThrow(/现行替代/);
    await record(taskId, { prNumber: 3081, head: 'd'.repeat(40), items: FIELD, mergeCommit: 'e'.repeat(40) });
    await settle('d'.repeat(40));
    await expect(supersede(old, await rowAt('d'.repeat(40)))).rejects.toThrow(/现行替代/);
    expect(await readAcceptanceDutySupersessions(t.db, ISSUE)).toHaveLength(1);
  });

  it('【故意造出的失败】目标未合、未验、漏项，不同 PR / 单 / 仓，协调责任，身份不明：一律拒绝、不落账', async () => {
    const { repoId, taskId } = await seed();
    await record(taskId, { prNumber: 3081, head: OLD, items: FIELD });
    const old = await rowAt(OLD);
    // 目标没合并回执
    await record(taskId, { prNumber: 3081, head: FINAL, items: FIELD });
    await expect(supersede(old, await rowAt(FINAL))).rejects.toThrow(/合并回执/);
    // 合了但没最终验收
    await record(taskId, { prNumber: 3081, head: FINAL, items: FIELD, mergeCommit: SQUASH });
    await expect(supersede(old, await rowAt(FINAL))).rejects.toThrow(/最终验收/);
    // 目标验收项没盖住源的
    const thin = 'f'.repeat(40);
    await record(taskId, { prNumber: 3081, head: thin, items: [FIELD[0] ?? ''], mergeCommit: SQUASH });
    await settle(thin);
    await expect(supersede(old, await rowAt(thin))).rejects.toThrow(/没盖住.*现场 check 一条/);
    // 不同 PR
    const other = '1'.repeat(40);
    await record(taskId, { prNumber: 3082, head: other, items: FIELD, mergeCommit: SQUASH });
    await settle(other);
    await expect(supersede(old, await rowAt(other))).rejects.toThrow(/同一个 PR/);
    // 不同单、不同仓（各是另一张任务；任务行只占个位，责任上记的仓和单才是比对的）
    for (const [ref, issueNumber, slot] of [
      [REPO_REF, 3000, 3000],
      [{ owner: 'acme', name: 'x' }, 2994, 3001],
    ] as const) {
      const [other] = await t.db
        .insert(tasks)
        .values({
          repoId,
          issueNumber: slot,
          title: '别的单',
          rawRequest: '别的',
          requestedBy: 'frank',
          priority: 1,
        })
        .returning();
      if (!other) throw new Error('task seed failed');
      const issue = { repo: `${ref.owner}/${ref.name}`, issueNumber };
      await record(
        other.id,
        { prNumber: 3081, head: FINAL, items: FIELD, mergeCommit: SQUASH },
        ref,
        issueNumber,
      );
      await settle(FINAL, issue);
      await expect(supersede(old, await rowAt(FINAL, issue))).rejects.toThrow(/跨任务/);
    }
    // 协调责任没有 PR 头
    await record(taskId, { prNumber: 0, head: '', items: FIELD });
    await settle(FINAL);
    await expect(supersede(await rowAt(''), await rowAt(FINAL))).rejects.toThrow(/协调责任/);
    // 身份不明：头、仓、PR、id 任一对不上现读
    const final = await rowAt(FINAL);
    for (const [source, target] of [
      [{ ...ident(old), head: 'a'.repeat(40) }, ident(final)],
      [ident(old), { ...ident(final), repo: 'acme/x' }],
      [ident(old), { ...ident(final), prNumber: 3082 }],
      [ident(old), { ...ident(final), id: 999_999 }],
      [ident(old), ident(old)],
    ] as const)
      await expect(
        supersedeAcceptanceDuty(t.db, { source, target, by: BY, evidence: '证' }, NOW),
      ).rejects.toThrow();
    await expect(
      supersedeAcceptanceDuty(
        t.db,
        { source: ident(old), target: ident(final), by: ' ', evidence: '证' },
        NOW,
      ),
    ).rejects.toThrow(/谁做的/);
    // 读不成：照抛，不当成能收
    const broken = {
      transaction: async () => {
        throw new Error('连接断了');
      },
    } as unknown as TestDb['db'];
    await expect(
      supersedeAcceptanceDuty(
        broken,
        { source: ident(old), target: ident(final), by: BY, evidence: '证' },
        NOW,
      ),
    ).rejects.toThrow(/连接断了/);

    expect((await rowAt(OLD)).supersededAt).toBeNull();
    expect(await t.db.select().from(acceptanceDutySupersessions)).toEqual([]);
    expect(await openAcceptanceDuties(t.db, taskId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ head: OLD })]),
    );
  });

  it('换代：源或目标新添项后陈旧请求失败；目标新增项使过期替代不再放行，重验后按新代重新指才收', async () => {
    const { taskId, old, final } = await scenario();
    // 源新增项：源换代，旧请求失败；新代目标没盖住新项也拒
    await record(taskId, { prNumber: 3081, head: OLD, items: ['旧头补一条'] });
    await expect(supersede(old, final)).rejects.toThrow(/源验收责任身份或代次/);
    await expect(supersede(await rowAt(OLD), final)).rejects.toThrow(/没盖住.*旧头补一条/);
    await record(taskId, { prNumber: 3081, head: FINAL, items: ['旧头补一条'] });
    await expect(supersede(await rowAt(OLD), final)).rejects.toThrow(/目标验收责任身份或代次/);
    await settle(FINAL);
    const done = await supersede(await rowAt(OLD), await rowAt(FINAL));
    expect(done.successorGeneration).toBe(final.generation + 1);
    expect(await openAcceptanceDuties(t.db, taskId)).toEqual([]);

    // 目标后来又新增项：目标重开、旧替代过期，旧头也重新算开着
    await record(taskId, { prNumber: 3081, head: FINAL, items: ['合后又补一条'] });
    expect(await states()).toEqual({ [OLD]: 'open', [FINAL]: 'open' });
    expect((await openAcceptanceDuties(t.db, taskId)).map((d) => d.head)).toEqual([OLD, FINAL]);
    await settle(FINAL);
    // 目标重验了，过期替代也不放行；凭旧代目标的请求失败，按新代重新指才收，历史两次都在
    expect(await states()).toEqual({ [OLD]: 'open', [FINAL]: 'settled' });
    expect(await openAcceptanceDuties(t.db, taskId)).toEqual([expect.objectContaining({ head: OLD })]);
    await expect(supersede(await rowAt(OLD), { ...final, generation: final.generation + 1 })).rejects.toThrow(
      /目标验收责任身份或代次/,
    );
    await supersede(await rowAt(OLD), await rowAt(FINAL), '重验后再指');
    expect(await openAcceptanceDuties(t.db, taskId)).toEqual([]);
    expect((await readAcceptanceDutySupersessions(t.db, ISSUE)).map((s) => s.targetGeneration)).toEqual([
      final.generation + 1,
      final.generation + 2,
    ]);
  });

  it('【故意造出的失败】操作记录写不进：源行替代一并回滚（核验、写入、操作记录同一事务）', async () => {
    const { taskId, old, final } = await scenario();
    await t.client.exec(`
      create function fail_supersession_log() returns trigger language plpgsql as $$
      begin raise exception '操作记录写不进'; end $$;
      create trigger fail_supersession_log before insert on acceptance_duty_supersessions
      for each row execute function fail_supersession_log();`);
    try {
      await expect(supersede(old, final)).rejects.toThrow();
    } finally {
      await t.client.exec(
        'drop trigger fail_supersession_log on acceptance_duty_supersessions; drop function fail_supersession_log();',
      );
    }
    expect(await rowAt(OLD)).toMatchObject({ supersededAt: null, successorId: null });
    expect(await openAcceptanceDuties(t.db, taskId)).toEqual([expect.objectContaining({ head: OLD })]);
    await supersede(old, final);
    expect(await openAcceptanceDuties(t.db, taskId)).toEqual([]);
  });

  it('并发：替代和目标新增项同时到，无论谁先，结局都不能凭过期替代放行', async () => {
    const { taskId, old, final } = await scenario();
    const [sup] = await Promise.allSettled([
      supersede(old, final),
      record(taskId, { prNumber: 3081, head: FINAL, items: ['并发新增'] }),
    ]);
    const target = await rowAt(FINAL);
    expect(target.generation).toBe(final.generation + 1);
    expect(target.settledAt).toBeNull();
    if (sup.status === 'rejected') expect((await rowAt(OLD)).supersededAt).toBeNull();
    expect(await states()).toEqual({ [OLD]: 'open', [FINAL]: 'open' });
    expect((await openAcceptanceDuties(t.db, taskId)).map((d) => d.head)).toEqual([OLD, FINAL]);
  });
});
