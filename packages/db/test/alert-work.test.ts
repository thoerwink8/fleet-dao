// 提醒是一件活（design 15.3「谁在处理」）的读写：一批提醒的跟进单、认领、挂钩的 PR、静默一次读齐；挂跟进单不覆盖人挂的、
// 换单记操作记录；静默按库的 now 定到期、最长 7 天由约束钉死、撤了记谁撤的。
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createSilence,
  expireSilence,
  findAlert,
  linkAlertWork,
  listSilences,
  readAlertWork,
} from '../src/queries/alert-work.ts';
import { upsertAlert } from '../src/queries/engine.ts';
import { alertSilences, auditLog, issueClaims, pullRequests } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addTask, expectViolation, NOW } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

const ENGINE = { actorKind: 'engine' as const, actorId: 'engine:alert-dispatch', via: 'engine' as const };
const SEAT = { actorKind: 'ai' as const, actorId: '本机/s1', via: 'engine' as const };

async function pr(
  repoId: string,
  number: number,
  over: Partial<typeof pullRequests.$inferInsert> = {},
): Promise<void> {
  await t.db.insert(pullRequests).values({
    repoId,
    number,
    state: 'open',
    headRef: `fix/${number}`,
    headSha: 'a'.repeat(40),
    updatedAt: NOW,
    ...over,
  });
}

/** 往认领账里直接写一行（老的行：没有新认领了，提醒的「谁在处理」还读它）。 */
async function claimOn(repoId: string, issueNumber: number, over: { prs?: number[]; engine?: boolean } = {}) {
  const [row] = await t.db
    .insert(issueClaims)
    .values({
      repoId,
      issueNumber,
      claimId: randomUUID(),
      ownerKind: over.engine ? 'engine' : 'worker',
      ownerMachine: over.engine ? null : '本机',
      ownerLabel: over.engine ? null : '工人A',
      seatScope: over.engine ? null : 'main',
      seatTerm: over.engine ? null : 3,
      state: over.prs?.length ? 'pr_open' : over.engine ? 'pending_start' : 'claimed',
      workflowId: over.engine ? `req:acme/x#${issueNumber}` : null,
      prNumbers: over.prs ?? [],
      graceMinutes: 120,
      claimedAt: NOW,
      heartbeatAt: NOW,
      updatedAt: NOW,
      note: null,
    })
    .returning();
  if (!row) throw new Error('认领没写进去');
  return row;
}

describe('findAlert：按编号或键找', () => {
  it('编号、键都认；处理过的也给；没有是 null', async () => {
    const { id } = await upsertAlert(t.db, {
      dedupeKey: 'pool-hold:claude-solo',
      level: 'alert',
      taskId: null,
      title: '整池暂停',
      body: '',
    });
    expect((await findAlert(t.db, id))?.dedupeKey).toBe('pool-hold:claude-solo');
    expect((await findAlert(t.db, 'pool-hold:claude-solo'))?.id).toBe(id);
    expect(await findAlert(t.db, 'nope')).toBeNull();
    expect(await findAlert(t.db, randomUUID())).toBeNull();
  });
});

describe('readAlertWork：一批提醒的跟进单、认领、挂钩的 PR、静默一次读齐', () => {
  it('任务的单是跟进单；另挂的优先；三种挂钩的 PR 都找得到，不相干的不带', async () => {
    const repo = await addRepo(t.db, 'fleet-dao');
    const task = await addTask(t.db, repo.id, { issueNumber: 293 });
    const onTask = await upsertAlert(t.db, {
      dedupeKey: `req:acme/fleet-dao#293:park:1`,
      level: 'alert',
      taskId: task.id,
      title: '没有别家可验',
      body: '',
    });
    const taskless = await upsertAlert(t.db, {
      dedupeKey: 'watchdog:job:backup:after-12',
      level: 'alert',
      taskId: null,
      title: '备份没跑成',
      body: '',
    });
    expect(
      await linkAlertWork(t.db, {
        notificationId: taskless.id,
        repoId: repo.id,
        issueNumber: 342,
        source: 'engine',
        linkedBy: 'engine:alert-dispatch',
        mode: 'if_absent',
        audit: ENGINE,
      }),
    ).toEqual({ result: 'linked', before: null });
    await claimOn(repo.id, 293, { engine: true });
    await claimOn(repo.id, 342, { prs: [352] });
    await pr(repo.id, 350, { alertRefs: ['watchdog:job:backup:after-12'] });
    await pr(repo.id, 351, { issueRefs: [342] });
    await pr(repo.id, 352);
    await pr(repo.id, 353, { issueRefs: [999], alertRefs: ['other:key'] });
    await pr(repo.id, 354, { alertRefs: [onTask.id] });

    const raw = await readAlertWork(t.db, [onTask.id, taskless.id]);
    expect(raw.alerts.map((a) => a.id).sort()).toEqual([onTask.id, taskless.id].sort());
    expect(raw.tasks).toEqual([
      { id: task.id, repoId: repo.id, owner: 'acme', name: 'fleet-dao', issueNumber: 293 },
    ]);
    expect(raw.work.map((w) => [w.notificationId, w.issueNumber, w.owner, w.name])).toEqual([
      [taskless.id, 342, 'acme', 'fleet-dao'],
    ]);
    expect(raw.claims.map((c) => [c.issueNumber, c.ownerKind]).sort()).toEqual([
      [293, 'engine'],
      [342, 'worker'],
    ]);
    expect(raw.prs.map((p) => p.number)).toEqual([350, 351, 352, 354]);
    expect(raw.now).toBeInstanceOf(Date);
  });

  it('一个都不给、编号认不出：回空的一批，不查；超过 500 个明确拒绝', async () => {
    expect((await readAlertWork(t.db, [])).alerts).toEqual([]);
    expect((await readAlertWork(t.db, ['not-a-uuid'])).alerts).toEqual([]);
    await expect(
      readAlertWork(
        t.db,
        Array.from({ length: 501 }, () => randomUUID()),
      ),
    ).rejects.toThrow(/一次最多看 500 条/);
  });

  it('只给还管用的静默：撤了的、到期的不带', async () => {
    const live = await createSilence(t.db, {
      matchKind: 'key',
      match: 'pool-hold:claude-solo',
      comment: '创始人拍的临时开关',
      createdBy: '本机/s1',
      minutes: 60,
      audit: SEAT,
    });
    const gone = await createSilence(t.db, {
      matchKind: 'prefix',
      match: 'watchdog:job:',
      comment: '换盘',
      createdBy: '本机/s1',
      minutes: 60,
      audit: SEAT,
    });
    await expireSilence(t.db, { id: gone.id, by: '本机/s1', note: '换完了', audit: SEAT });
    const a = await upsertAlert(t.db, {
      dedupeKey: 'x:y',
      level: 'alert',
      taskId: null,
      title: 'x',
      body: '',
    });
    expect((await readAlertWork(t.db, [a.id])).silences.map((s) => s.id)).toEqual([live.id]);
  });
});

describe('linkAlertWork：挂跟进单', () => {
  it('【故意造出的失败】提醒派单只在没有时挂（if_absent）：人已经挂了别的，不覆盖、回 kept', async () => {
    const repo = await addRepo(t.db);
    const a = await upsertAlert(t.db, {
      dedupeKey: 'deploy-lag:behind',
      level: 'alert',
      taskId: null,
      title: 'x',
      body: '',
    });
    await linkAlertWork(t.db, {
      notificationId: a.id,
      repoId: repo.id,
      issueNumber: 10,
      source: 'claim',
      linkedBy: '本机/s1',
      note: '帅位挂的',
      mode: 'replace',
      audit: SEAT,
    });
    expect(
      await linkAlertWork(t.db, {
        notificationId: a.id,
        repoId: repo.id,
        issueNumber: 11,
        source: 'engine',
        linkedBy: 'engine:alert-dispatch',
        mode: 'if_absent',
        audit: ENGINE,
      }),
    ).toEqual({ result: 'kept', before: { repoId: repo.id, issueNumber: 10 } });
    const raw = await readAlertWork(t.db, [a.id]);
    expect(raw.work[0]).toMatchObject({ issueNumber: 10, source: 'claim', linkedBy: '本机/s1' });
  });

  it('帅位换单（replace）：换成新的，操作记录写原来是哪张、为什么；一样的回 same、不另记', async () => {
    const repo = await addRepo(t.db);
    const a = await upsertAlert(t.db, {
      dedupeKey: 'canary:broken',
      level: 'alert',
      taskId: null,
      title: 'x',
      body: '',
    });
    const first = {
      notificationId: a.id,
      repoId: repo.id,
      source: 'engine' as const,
      linkedBy: 'e',
      mode: 'if_absent' as const,
      audit: ENGINE,
    };
    await linkAlertWork(t.db, { ...first, issueNumber: 19 });
    expect(
      await linkAlertWork(t.db, {
        ...first,
        issueNumber: 360,
        source: 'claim',
        linkedBy: '本机/s1',
        note: '巡检单是被测的，修在 fleet-dao 的 #360',
        mode: 'replace',
        audit: SEAT,
      }),
    ).toEqual({ result: 'linked', before: { repoId: repo.id, issueNumber: 19 } });
    expect(
      await linkAlertWork(t.db, { ...first, issueNumber: 360, mode: 'replace', audit: SEAT }),
    ).toMatchObject({ result: 'same' });
    const audits = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.target, `notification:${a.id}`));
    expect(audits.map((x) => [x.action, x.actorId, x.reason])).toEqual([
      ['alert.link', 'engine:alert-dispatch', null],
      ['alert.link', '本机/s1', '巡检单是被测的，修在 fleet-dao 的 #360'],
    ]);
    expect(audits[1]?.before).toEqual({ repoId: repo.id, issueNumber: 19 });
  });

  it('【故意造出的失败】提醒不在：回 not_found，什么都不写', async () => {
    const repo = await addRepo(t.db);
    expect(
      await linkAlertWork(t.db, {
        notificationId: randomUUID(),
        repoId: repo.id,
        issueNumber: 1,
        source: 'engine',
        linkedBy: 'e',
        mode: 'if_absent',
        audit: ENGINE,
      }),
    ).toEqual({ result: 'not_found', before: null });
    expect(await t.db.select().from(auditLog)).toEqual([]);
  });
});

describe('静默：库的 now 定到期、最长 7 天、撤了记谁', () => {
  it('建：到期 = 库的 now + 分钟数，记操作记录', async () => {
    const s = await createSilence(t.db, {
      matchKind: 'key',
      match: 'pool-hold:claude-solo',
      comment: '创始人 09-27 晚拍：法国暂时不用独享号',
      createdBy: '本机/s1',
      minutes: 90,
      audit: SEAT,
    });
    expect(s.endsAt.getTime() - s.createdAt.getTime()).toBe(90 * 60_000);
    const [audit] = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.target, `silence:${s.id}`));
    expect(audit).toMatchObject({
      action: 'alert.silence',
      actorId: '本机/s1',
      reason: '创始人 09-27 晚拍：法国暂时不用独享号',
    });
  });

  it('【故意造出的失败】超过 7 天、前缀太宽、没写原因：库的约束拒掉', async () => {
    const base = {
      matchKind: 'key' as const,
      match: 'k:1',
      comment: '为什么',
      createdBy: 'x',
      minutes: 60,
      audit: SEAT,
    };
    await expectViolation(
      createSilence(t.db, { ...base, minutes: 7 * 24 * 60 + 1 }),
      'alert_silences_at_most_7_days',
    );
    await expectViolation(
      createSilence(t.db, { ...base, matchKind: 'prefix', match: 'k:' }),
      'alert_silences_match_shape',
    );
    await expectViolation(
      createSilence(t.db, { ...base, matchKind: 'prefix', match: 'watchdog' }),
      'alert_silences_match_shape',
    );
    await expectViolation(createSilence(t.db, { ...base, match: 'a b' }), 'alert_silences_match_shape');
    await expectViolation(
      createSilence(t.db, { ...base, comment: '  ' }),
      'alert_silences_comment_not_blank',
    );
  });

  it('提前撤：记谁、为什么；撤过的、到期的回 ended；没有的回 not_found', async () => {
    const s = await createSilence(t.db, {
      matchKind: 'prefix',
      match: 'watchdog:job:backup:',
      comment: '换盘',
      createdBy: '本机/s1',
      minutes: 60,
      audit: SEAT,
    });
    const got = await expireSilence(t.db, { id: s.id, by: '本机/s2', note: '换完了', audit: SEAT });
    expect(got).toMatchObject({ result: 'expired', row: { expiredBy: '本机/s2', expireNote: '换完了' } });
    expect(await expireSilence(t.db, { id: s.id, by: 'x', note: 'y', audit: SEAT })).toMatchObject({
      result: 'ended',
    });
    expect(await expireSilence(t.db, { id: randomUUID(), by: 'x', note: 'y', audit: SEAT })).toEqual({
      result: 'not_found',
    });
    expect(await expireSilence(t.db, { id: 'nope', by: 'x', note: 'y', audit: SEAT })).toEqual({
      result: 'not_found',
    });
    // 到期的：把建的时刻往前挪两小时（到期跟着挪）
    const old = await createSilence(t.db, {
      ...{ matchKind: 'key' as const, match: 'k:2', comment: 'c', createdBy: 'x' },
      minutes: 60,
      audit: SEAT,
    });
    await t.db
      .update(alertSilences)
      .set({ createdAt: sql`created_at - interval '2 hours'`, endsAt: sql`ends_at - interval '2 hours'` })
      .where(eq(alertSilences.id, old.id));
    expect(await expireSilence(t.db, { id: old.id, by: 'x', note: 'y', audit: SEAT })).toMatchObject({
      result: 'ended',
    });
    expect((await listSilences(t.db, { all: false })).silences).toEqual([]);
    expect((await listSilences(t.db, { all: true })).silences.map((x) => x.match).sort()).toEqual([
      'k:2',
      'watchdog:job:backup:',
    ]);
  });
});
