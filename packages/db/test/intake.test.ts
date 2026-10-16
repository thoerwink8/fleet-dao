// 引擎拉单从库里读的两样（queries/intake.ts）：受管的仓带开关、一张单的任务行状态。
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findRepoProfile, listIntakeRepos, setRepoProfile, taskStateByIssue } from '../src/queries/intake.ts';
import { auditLog, repos } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addTask, ago, DAY } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

describe('受管的仓（listIntakeRepos）', () => {
  it('开关开着的、关着的都列，按仓名排；开关打开的时刻带着，关着是 null', async () => {
    const b = await addRepo(t.db, 'bbb');
    const a = await addRepo(t.db, 'aaa');
    const opened = ago(DAY);
    await t.db.update(repos).set({ autoDispatchSince: opened }).where(eq(repos.id, b.id));
    const rows = await listIntakeRepos(t.db);
    expect(rows.map((r) => r.name)).toEqual(['aaa', 'bbb']);
    expect(rows[0]).toMatchObject({
      id: a.id,
      owner: 'acme',
      defaultBranch: 'main',
      testCommand: 'pnpm check',
      autoDispatchSince: null,
      ciPolicy: 'force',
    });
    expect(rows[1]?.autoDispatchSince?.toISOString()).toBe(opened.toISOString());
    expect(rows[1]?.ciPolicy).toBe('force');
  });

  it('切成不强制之后读回来是 off；没改过的仍是强制', async () => {
    const a = await addRepo(t.db, 'aaa');
    await t.db.update(repos).set({ ciPolicy: 'off' }).where(eq(repos.id, a.id));
    const rows = await listIntakeRepos(t.db);
    expect(rows.map((r) => [r.name, r.ciPolicy])).toEqual([['aaa', 'off']]);
  });

  it('一个仓都没有：空数组（调用方把它当「库里没有受管的仓」报，不当成都关着）', async () => {
    expect(await listIntakeRepos(t.db)).toEqual([]);
  });
});

describe('一张单的任务行（taskStateByIssue）', () => {
  it('有就回编号和状态；同一个号在另一个仓里的不串；没有是 null', async () => {
    const a = await addRepo(t.db, 'aaa');
    const b = await addRepo(t.db, 'bbb');
    const queued = await addTask(t.db, a.id, { issueNumber: 7, state: 'queued' });
    await addTask(t.db, b.id, { issueNumber: 7, state: 'done' });
    expect(await taskStateByIssue(t.db, a.id, 7)).toEqual({ id: queued.id, state: 'queued' });
    expect(await taskStateByIssue(t.db, b.id, 7)).toMatchObject({ state: 'done' });
    expect(await taskStateByIssue(t.db, a.id, 8)).toBeNull();
  });
});

describe('仓档案（findRepoProfile、setRepoProfile，#2738）', () => {
  const actor = { kind: 'ops', id: 'ops:project' } as const;

  it('按 owner/仓名找，不分大小写；没有的回 null；老行档案是空对象、仓号空', async () => {
    const r = await addRepo(t.db, 'Widgets');
    expect(await findRepoProfile(t.db, 'ACME', 'widgets')).toMatchObject({
      id: r.id,
      owner: 'acme',
      name: 'Widgets',
      githubId: null,
      profile: {},
      testCommand: 'pnpm check',
    });
    expect(await findRepoProfile(t.db, 'acme', 'nope')).toBeNull();
  });

  it('写档案和操作记录同一事务，带改前改后；写了测试命令的连 test_command 一起改；同样的再写一遍不改、不记', async () => {
    const r = await addRepo(t.db, 'flux');
    const profile = { language: 'go', testCommand: 'go test ./...', moduleRoots: ['cmd/*', 'internal/*'] };
    const first = await setRepoProfile(t.db, { repoId: r.id, profile, actor, reason: '服务器上 root 跑的' });
    expect(first).toMatchObject({ changed: true });
    if (first === 'not_found') throw new Error('不该找不到');
    expect(first.auditId).toEqual(expect.any(Number));
    const back = await findRepoProfile(t.db, 'acme', 'flux');
    expect(back).toMatchObject({ profile, testCommand: 'go test ./...' });
    const [audit] = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.id, first.auditId ?? -1));
    expect(audit).toMatchObject({
      actorKind: 'ops',
      actorId: 'ops:project',
      action: 'repo.profile.set',
      target: `repo:${r.id}`,
      before: {},
      after: profile,
      reason: '服务器上 root 跑的',
      via: 'ops',
      ok: true,
    });

    const again = await setRepoProfile(t.db, { repoId: r.id, profile: { ...profile }, actor, reason: 'x' });
    expect(again).toEqual({ changed: false, auditId: null });
    expect(
      await t.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.target, `repo:${r.id}`)),
    ).toHaveLength(1);
  });

  it('没写测试命令的档案不动 test_command；仓不在回 not_found', async () => {
    const r = await addRepo(t.db, 'plain');
    await setRepoProfile(t.db, { repoId: r.id, profile: { weight: 2 }, actor, reason: 'x' });
    expect(await findRepoProfile(t.db, 'acme', 'plain')).toMatchObject({
      profile: { weight: 2 },
      testCommand: 'pnpm check',
    });
    expect(
      await setRepoProfile(t.db, {
        repoId: '00000000-0000-0000-0000-000000000000',
        profile: {},
        actor,
        reason: 'x',
      }),
    ).toBe('not_found');
  });
});
