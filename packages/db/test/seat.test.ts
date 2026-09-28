// 帅位租约和认领的语句（#299，specs/299-帅位只一个/方案.md 第二节）：接班一条语句、任期只增不减；抢认领一条语句、只有一边拿到；
// 心跳和过期用库的 now()。PGlite 只有一条连接，真并发在法国真库上演练（方案第八节）；这里按先后造两边抢。
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { saveTaskSnapshot } from '../src/queries/engine.ts';
import {
  endClaimRow,
  listClaimRows,
  listStalePendingEngineClaimRows,
  readClaim,
  readDbNow,
  readSeat,
  startEngineClaimRow,
  stepClaimRow,
  takeClaimRow,
  takeSeatRow,
  touchSeatActivityRow,
  writeHandoffRow,
} from '../src/queries/seat.ts';
import { auditLog, issueClaims, seatLeases } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addTask, expectViolation } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

/** 把一张单认领的心跳往前挪 minutes 分钟（造「很久没心跳」）。 */
async function backdateHeartbeat(repoId: string, issueNumber: number, minutes: number) {
  await t.db
    .update(issueClaims)
    .set({ heartbeatAt: sql`${issueClaims.heartbeatAt} - make_interval(mins => ${minutes})` })
    .where(and(eq(issueClaims.repoId, repoId), eq(issueClaims.issueNumber, issueNumber)));
}

const worker = (
  repoId: string,
  issueNumber: number,
  over: Partial<Parameters<typeof takeClaimRow>[1]> = {},
) => ({
  repoId,
  issueNumber,
  claimId: randomUUID(),
  ownerKind: 'worker' as const,
  ownerMachine: '本机',
  ownerLabel: '工人甲',
  seatScope: 'main',
  seatTerm: 1,
  state: 'claimed' as const,
  workflowId: null,
  graceMinutes: 120,
  note: '开工',
  ...over,
});
const engine = (repoId: string, issueNumber: number) =>
  worker(repoId, issueNumber, {
    ownerKind: 'engine',
    ownerMachine: null,
    ownerLabel: null,
    seatScope: null,
    seatTerm: null,
    state: 'pending_start',
    workflowId: `req:acme/x#${issueNumber}`,
    note: null,
  });

describe('帅位：接班一条语句，任期只增不减', () => {
  it('座位上没人：第 1 任；再接班：任期加一、上一任抄进 previous；时间是库的 now()', async () => {
    const before = await readDbNow(t.db);
    const first = await takeSeatRow(t.db, { scope: 'main', machine: '本机', session: 's1' });
    expect(first.value).toMatchObject({
      term: 1,
      holderMachine: '本机',
      holderSession: 's1',
      previousMachine: null,
    });
    expect(first.value.renewedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    const second = await takeSeatRow(t.db, { scope: 'main', machine: '笔记本', session: 's9' });
    expect(second.value).toMatchObject({
      term: 2,
      holderMachine: '笔记本',
      holderSession: 's9',
      previousMachine: '本机',
      previousSession: 's1',
    });
    // 同一台同一个会话再被说一次「你当帅位」：照样加一（后说的算，任期号一直往上加）
    expect((await takeSeatRow(t.db, { scope: 'main', machine: '笔记本', session: 's9' })).value.term).toBe(3);
  });

  it('演练座位和真帅位互不影响', async () => {
    await takeSeatRow(t.db, { scope: 'main', machine: '本机', session: 's1' });
    await takeSeatRow(t.db, { scope: 'drill:299', machine: '演练甲', session: 'a1' });
    await takeSeatRow(t.db, { scope: 'drill:299', machine: '演练乙', session: 'b1' });
    expect((await readSeat(t.db, 'main')).value).toMatchObject({ term: 1, holderMachine: '本机' });
    expect((await readSeat(t.db, 'drill:299')).value).toMatchObject({ term: 2, holderMachine: '演练乙' });
  });

  it('touchSeatActivityRow：#446 起没有续约了，只顶「最后活动时间」（renewed_at 那一列，给人看用）', async () => {
    await takeSeatRow(t.db, { scope: 'main', machine: '本机', session: 's1' });
    const before = (await readSeat(t.db, 'main')).value?.renewedAt.getTime();
    await new Promise((r) => setTimeout(r, 5));
    await touchSeatActivityRow(t.db, 'main');
    const after = (await readSeat(t.db, 'main')).value?.renewedAt.getTime();
    expect(before).toBeDefined();
    expect(after).toBeGreaterThan(before ?? 0);
  });

  it('【故意造出的失败】座位上没人时 touchSeatActivityRow 什么都不做：不报错，也不会凭空造一个座位出来', async () => {
    await expect(touchSeatActivityRow(t.db, 'main')).resolves.toBeUndefined();
    expect((await readSeat(t.db, 'main')).value).toBeNull();
  });

  it('座位上没人：读回 null 和库的 now；锁着读要在事务里', async () => {
    const r = await readSeat(t.db, 'main');
    expect(r.value).toBeNull();
    expect(r.now).toBeInstanceOf(Date);
    await takeSeatRow(t.db, { scope: 'main', machine: '本机', session: 's1' });
    const locked = await t.db.transaction(async (tx) => readSeat(tx, 'main', true));
    expect(locked.value?.term).toBe(1);
  });

  it('交接说明整份换掉、带上写的时刻；座位的约束：scope 只认 main 和 drill:', async () => {
    await takeSeatRow(t.db, { scope: 'main', machine: '本机', session: 's1' });
    const row = await writeHandoffRow(t.db, { scope: 'main', text: '在做 #299' });
    expect(row.handoff).toBe('在做 #299');
    expect(row.handoffAt).toBeInstanceOf(Date);
    await expectViolation(
      takeSeatRow(t.db, { scope: 'prod', machine: '本机', session: 's1' }),
      'seat_leases_scope_known',
    );
  });
});

describe('认领：每张单一行，一条语句抢，只有一边拿到', () => {
  it('【故意造出的失败】引擎先拿了（待起），本机再抢：拿不到（回 null），行不动', async () => {
    const repo = await addRepo(t.db);
    const got = await takeClaimRow(t.db, engine(repo.id, 40));
    expect(got?.value).toMatchObject({ ownerKind: 'engine', state: 'pending_start', prNumbers: [] });
    expect(await takeClaimRow(t.db, worker(repo.id, 40))).toBeNull();
    expect((await readClaim(t.db, repo.id, 40)).value).toMatchObject({
      ownerKind: 'engine',
      claimId: got?.value.claimId,
    });
  });

  it('【故意造出的失败】本机先拿了，引擎再抢：拿不到', async () => {
    const repo = await addRepo(t.db);
    const got = await takeClaimRow(t.db, worker(repo.id, 41));
    expect(await takeClaimRow(t.db, engine(repo.id, 41))).toBeNull();
    expect((await readClaim(t.db, repo.id, 41)).value?.claimId).toBe(got?.value.claimId);
  });

  it('结束了的（做完、放下、作废）：下一次认领整行换成新的认领号，心跳、PR 清掉', async () => {
    const repo = await addRepo(t.db);
    const first = await takeClaimRow(t.db, worker(repo.id, 42));
    if (!first) throw new Error('没拿到');
    await stepClaimRow(t.db, { repoId: repo.id, issueNumber: 42, claimId: first.value.claimId, pr: 7 });
    await endClaimRow(t.db, {
      repoId: repo.id,
      issueNumber: 42,
      claimId: first.value.claimId,
      state: 'released',
      reason: '不做了',
    });
    const second = await takeClaimRow(t.db, worker(repo.id, 42, { ownerLabel: '工人乙' }));
    expect(second?.value).toMatchObject({
      ownerLabel: '工人乙',
      state: 'claimed',
      prNumbers: [],
      endedAt: null,
      endReason: null,
    });
    expect(second?.value.claimId).not.toBe(first.value.claimId);
  });

  it('报一步：认领号对得上才写，刚认领的到「在做」；带 PR 的记进 pr_numbers（不重复）、到「开了 PR」', async () => {
    const repo = await addRepo(t.db);
    const got = await takeClaimRow(t.db, worker(repo.id, 43));
    if (!got) throw new Error('没拿到');
    const claimId = got.value.claimId;
    expect(
      await stepClaimRow(t.db, { repoId: repo.id, issueNumber: 43, claimId: randomUUID(), note: 'x' }),
    ).toBeNull();
    const step = await stepClaimRow(t.db, { repoId: repo.id, issueNumber: 43, claimId, note: '在写测试' });
    expect(step?.value).toMatchObject({ state: 'doing', note: '在写测试' });
    await stepClaimRow(t.db, { repoId: repo.id, issueNumber: 43, claimId, pr: 306 });
    const again = await stepClaimRow(t.db, { repoId: repo.id, issueNumber: 43, claimId, pr: 306 });
    await stepClaimRow(t.db, { repoId: repo.id, issueNumber: 43, claimId, pr: 311 });
    expect(again?.value).toMatchObject({ state: 'pr_open', prNumbers: [306], note: '在写测试' });
    expect((await readClaim(t.db, repo.id, 43)).value?.prNumbers).toEqual([306, 311]);
  });

  it('【故意造出的失败】结束了的认领再报一步、再结束：都回 null（旧工人拿着旧认领号来，写不进去）', async () => {
    const repo = await addRepo(t.db);
    const got = await takeClaimRow(t.db, worker(repo.id, 44));
    if (!got) throw new Error('没拿到');
    const key = { repoId: repo.id, issueNumber: 44, claimId: got.value.claimId };
    expect(await endClaimRow(t.db, { ...key, state: 'done', reason: 'PR 合了' })).not.toBeNull();
    expect(await stepClaimRow(t.db, { ...key, note: '我回来了' })).toBeNull();
    expect(await endClaimRow(t.db, { ...key, state: 'released', reason: '再放一次' })).toBeNull();
  });

  it('【故意造出的失败】过了宽限期没心跳：#446 起没有 sweep 了，不再自动作废，一直显示在活跃认领里', async () => {
    const repo = await addRepo(t.db);
    await takeClaimRow(t.db, worker(repo.id, 45));
    await takeClaimRow(t.db, worker(repo.id, 46, { graceMinutes: 2 }));
    await takeClaimRow(t.db, engine(repo.id, 47));
    await backdateHeartbeat(repo.id, 45, 119);
    await backdateHeartbeat(repo.id, 46, 3); // 过了它自己的 2 分钟宽限期，放在 #446 之前这里会被作废
    await backdateHeartbeat(repo.id, 47, 600);
    // 库里已经没有 voidExpiredClaimRows 这个函数了：没有东西会去扫、去作废，三份认领原样躺着
    const active = await listClaimRows(t.db, { repoId: repo.id, activeOnly: true });
    expect(active.value.map((c) => c.issueNumber).sort()).toEqual([45, 46, 47]);
    expect(active.value.find((c) => c.issueNumber === 46)).toMatchObject({
      state: 'claimed',
      endReason: null,
    });
  });

  it('库里的约束兜底：待起只有引擎有；引擎要有工作流编号、不带机器；本机要有机器和工人名；作废、放下要写原因', async () => {
    const repo = await addRepo(t.db);
    await expectViolation(
      takeClaimRow(t.db, worker(repo.id, 50, { state: 'pending_start' })),
      'issue_claims_pending_engine_only',
    );
    await expectViolation(
      takeClaimRow(t.db, { ...engine(repo.id, 51), workflowId: null }),
      'issue_claims_owner_shape',
    );
    await expectViolation(
      takeClaimRow(t.db, worker(repo.id, 52, { ownerLabel: null })),
      'issue_claims_owner_shape',
    );
    await expectViolation(
      takeClaimRow(t.db, worker(repo.id, 53, { seatTerm: null })),
      'issue_claims_seat_shape',
    );
    const got = await takeClaimRow(t.db, worker(repo.id, 54));
    if (!got) throw new Error('没拿到');
    await expectViolation(
      endClaimRow(t.db, {
        repoId: repo.id,
        issueNumber: 54,
        claimId: got.value.claimId,
        state: 'voided',
        reason: '',
      }),
      'issue_claims_end_reason',
    );
    await expectViolation(
      t.db.insert(seatLeases).values({
        scope: 'main',
        term: 0,
        holderMachine: '本机',
        holderSession: 's1',
        acquiredAt: sql`now()`,
        renewedAt: sql`now()`,
      }),
      'seat_leases_term_positive',
    );
  });
});

describe('引擎的认领跟着任务走（写快照的同一个事务里）', () => {
  const snapshot = (
    taskId: string,
    state: Parameters<typeof saveTaskSnapshot>[1]['state'],
    claimEnd: Parameters<typeof saveTaskSnapshot>[1]['claimEnd'],
  ) =>
    saveTaskSnapshot(t.db, {
      taskId,
      state,
      phase: 'fusion:execute',
      doing: '写码',
      lastProblem: null,
      subtasks: [],
      claimEnd,
    });
  const claimOf = async (repoId: string, issueNumber: number) =>
    (await readClaim(t.db, repoId, issueNumber)).value;

  it('工作流在跑：待起的改在做；做完了：认领记做完、记一条 claim.done（在引擎名下）', async () => {
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id, { issueNumber: 70 });
    await takeClaimRow(t.db, engine(repo.id, 70));
    expect(await snapshot(task.id, 'running', null)).toBe('saved');
    expect(await claimOf(repo.id, 70)).toMatchObject({ ownerKind: 'engine', state: 'doing' });
    await snapshot(task.id, 'done', { state: 'done', reason: 'Fusion 做完了' });
    expect(await claimOf(repo.id, 70)).toMatchObject({ state: 'done', endReason: 'Fusion 做完了' });
    const audits = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.target, `claim:${repo.id}#70`));
    expect(audits.map((a) => [a.action, a.actorKind, a.actorId, a.reason])).toEqual([
      ['claim.done', 'engine', 'fusion', 'Fusion 做完了'],
    ]);
  });

  it('【故意造出的失败】引擎在做、库里却没有还活着的认领（认领上线前起的任务）：写快照时补一份引擎的（在做）；叫停了跟着放下', async () => {
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id, { issueNumber: 71 });
    await snapshot(task.id, 'running', null);
    expect(await claimOf(repo.id, 71)).toMatchObject({
      ownerKind: 'engine',
      state: 'doing',
      workflowId: `req:acme/${repo.name}#71`,
    });
    await snapshot(task.id, 'stopped', { state: 'released', reason: '任务叫停了' });
    expect(await claimOf(repo.id, 71)).toMatchObject({ state: 'released', endReason: '任务叫停了' });
  });

  it('【故意造出的失败】本机拿着的：写快照不碰它（补不上、也不结束它）', async () => {
    const repo = await addRepo(t.db);
    const task = await addTask(t.db, repo.id, { issueNumber: 72 });
    const local = await takeClaimRow(t.db, worker(repo.id, 72));
    await snapshot(task.id, 'running', null);
    await snapshot(task.id, 'failed', { state: 'released', reason: 'Fusion 没做成（任务 failed）' });
    expect(await claimOf(repo.id, 72)).toMatchObject({
      claimId: local?.value.claimId,
      ownerKind: 'worker',
      state: 'claimed',
    });
  });

  it('待起的引擎认领：只列待起超过几分钟的（在做的、演练座位下的不列）；起成了改在做只动引擎待起的', async () => {
    const repo = await addRepo(t.db);
    await takeClaimRow(t.db, engine(repo.id, 73));
    await takeClaimRow(t.db, engine(repo.id, 74));
    await takeClaimRow(t.db, { ...engine(repo.id, 75), seatScope: 'drill:299', seatTerm: 1 });
    await takeClaimRow(t.db, worker(repo.id, 76));
    await t.db
      .update(issueClaims)
      .set({ updatedAt: sql`${issueClaims.updatedAt} - make_interval(mins => 10)` })
      .where(eq(issueClaims.repoId, repo.id));
    expect(await startEngineClaimRow(t.db, { repoId: repo.id, issueNumber: 74 })).toMatchObject({
      value: { state: 'doing' },
    });
    expect(await startEngineClaimRow(t.db, { repoId: repo.id, issueNumber: 76 })).toBeNull();
    const stale = await listStalePendingEngineClaimRows(t.db, { minutes: 5, limit: 10 });
    expect(stale.value.map((c) => c.issueNumber)).toEqual([73]);
    expect(await listStalePendingEngineClaimRows(t.db, { minutes: 15, limit: 10 })).toMatchObject({
      value: [],
    });
  });
});
