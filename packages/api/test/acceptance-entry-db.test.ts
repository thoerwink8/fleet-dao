import { acceptanceGate } from '@fleet-dao/conventions/acceptance-gate';
import {
  readAcceptanceDutyRows,
  readAcceptanceDutySupersessions,
  repos,
  tasks,
  upsertAcceptanceDuty,
} from '@fleet-dao/db';
import { createTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { acceptancePublicRoutes } from '../src/acceptance-public.ts';
import { type CliDeps, main } from '../src/cli.ts';
import type { Deps } from '../src/deps.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
it(
  '生产CLI真实落账，公开只读口回读同一责任代次与证据',
  async () => {
    const [repo] = await t.db
      .insert(repos)
      .values({ owner: 'o', name: 'r', testCommand: 'pnpm check' })
      .returning();
    if (!repo) throw new Error('repo seed failed');
    const [task] = await t.db
      .insert(tasks)
      .values({
        repoId: repo.id,
        issueNumber: 7,
        title: '现场验收',
        rawRequest: '验收',
        requestedBy: 'frank',
        priority: 1,
        state: 'running',
      })
      .returning();
    if (!task) throw new Error('task seed failed');
    const head = 'a'.repeat(40);
    await upsertAcceptanceDuty(t.db, {
      taskId: task.id,
      repo: 'o/r',
      issueNumber: 7,
      prNumber: 9,
      head,
      items: ['现场核验'],
      mergeCommit: 'b'.repeat(40),
      mergedAt: new Date(),
    });
    const row = (await readAcceptanceDutyRows(t.db, { repo: 'o/r', issueNumber: 7 }))[0];
    if (!row) throw new Error('duty seed failed');
    const output: string[] = [];
    const errors: string[] = [];
    const deps = {
      env: { DATABASE_URL: 'test' },
      out: (x: string) => output.push(x),
      err: (x: string) => errors.push(x),
      openDb: async () => ({ db: t.db, close: async () => {} }),
      openStore: async () => {
        throw new Error('unexpected');
      },
      now: () => new Date('2026-10-18T10:00:00Z'),
    } as CliDeps;
    expect(await main(['acceptance', 'status', 'o/r', '7'], deps)).toBe(0);
    expect(JSON.parse(output.pop() ?? 'null')[0]).toMatchObject({
      id: row.id,
      generation: row.generation,
      settledAt: null,
    });
    const settle = [
      'acceptance',
      'settle',
      'o/r',
      '7',
      '--id',
      String(row.id),
      '--generation',
      String(row.generation + 1),
      '--pr',
      '9',
      '--head',
      head,
      '--evidence',
      '现场命令exit0',
    ];
    expect(await main(settle, deps)).toBe(1);
    expect((await readAcceptanceDutyRows(t.db, { repo: 'o/r', issueNumber: 7 }))[0]?.settledAt).toBeNull();
    settle[7] = String(row.generation);
    expect(await main(settle, deps)).toBe(0);
    const app = acceptancePublicRoutes({
      ciPolicyBridge: { read: async () => ({ repo: 'o/r' }) },
      acceptanceDuties: (x: { repo: string; issueNumber: number }) => readAcceptanceDutyRows(t.db, x),
    } as unknown as Deps);
    const res = await app.request('/api/public/acceptance/v1/repos/1/issues/7');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { duties: unknown[] }).duties[0]).toMatchObject({
      id: row.id,
      generation: row.generation,
      head,
      settleEvidence: '现场命令exit0',
      settledAt: '2026-10-18T10:00:00.000Z',
    });
  },
  TEST_DB_TIMEOUT_MS,
);

it(
  '旧头替代收口经生产CLI落账：旧行回执不伪填，status 与公开口同一有效终态，目标新增项后替代失效',
  async () => {
    const [repo] = await t.db
      .insert(repos)
      .values({ owner: 'o', name: 's', testCommand: 'pnpm check' })
      .returning();
    if (!repo) throw new Error('repo seed failed');
    const [task] = await t.db
      .insert(tasks)
      .values({
        repoId: repo.id,
        issueNumber: 3071,
        title: '换头的单',
        rawRequest: '验收',
        requestedBy: 'frank',
        priority: 1,
        state: 'running',
      })
      .returning();
    if (!task) throw new Error('task seed failed');
    const OLD = 'c471bae51632e024f9aeaace4c8e074e627c1376';
    const FINAL = 'aa5b84356ca84f8b50cdb05cf606614741049437';
    const SQUASH = 'b41eaed8886eb30e799a1a9911414b55e17d56c6';
    const issue = { repo: 'o/s', issueNumber: 3071 };
    const base = { taskId: task.id, ...issue, prNumber: 3081 };
    await upsertAcceptanceDuty(t.db, { ...base, head: OLD, items: ['现场核验'] });
    await upsertAcceptanceDuty(t.db, {
      ...base,
      head: FINAL,
      items: ['现场核验', '最终头一条'],
      mergeCommit: SQUASH,
      mergedAt: new Date(),
    });
    const rows = await readAcceptanceDutyRows(t.db, issue);
    const old = rows.find((r) => r.head === OLD);
    const final = rows.find((r) => r.head === FINAL);
    if (!old || !final) throw new Error('duty seed failed');
    const output: string[] = [];
    const deps = {
      env: { DATABASE_URL: 'test' },
      out: (x: string) => output.push(x),
      err: () => {},
      openDb: async () => ({ db: t.db, close: async () => {} }),
      openStore: async () => {
        throw new Error('unexpected');
      },
      now: () => new Date('2026-10-18T11:00:00Z'),
    } as CliDeps;
    const settle = (id: number, generation: number, head: string) =>
      main(
        [
          'acceptance',
          'settle',
          'o/s',
          '3071',
          '--id',
          String(id),
          '--generation',
          String(generation),
          '--pr',
          '3081',
          '--head',
          head,
          '--evidence',
          '最终头现场验收',
        ],
        deps,
      );
    const supersede = (targetGeneration: number, evidence = 'PR #3081 最终头已合已验') =>
      main(
        [
          'acceptance',
          'supersede',
          'o/s',
          '3071',
          '--id',
          String(old.id),
          '--generation',
          String(old.generation),
          '--pr',
          '3081',
          '--head',
          OLD,
          '--target-id',
          String(final.id),
          '--target-generation',
          String(targetGeneration),
          '--target-pr',
          '3081',
          '--target-head',
          FINAL,
          '--evidence',
          evidence,
        ],
        deps,
      );
    const status = async () => {
      expect(await main(['acceptance', 'status', 'o/s', '3071'], deps)).toBe(0);
      const list = JSON.parse(output.pop() ?? 'null') as { head: string; state: string }[];
      return Object.fromEntries(list.map((d) => [d.head, d.state]));
    };
    const app = acceptancePublicRoutes({
      ciPolicyBridge: { read: async () => ({ repo: 'o/s' }) },
      acceptanceDuties: (x: { repo: string; issueNumber: number }) => readAcceptanceDutyRows(t.db, x),
    } as unknown as Deps);
    const publicDuties = async () => {
      const res = await app.request('/api/public/acceptance/v1/repos/1/issues/3071');
      expect(res.status).toBe(200);
      return ((await res.json()) as { duties: Record<string, unknown>[] }).duties;
    };

    // 关单闸（issue-close / close-on-merge 共用的 acceptanceGate）读同一个公开口：和 status 同一有效终态
    const gh = async () => ({
      code: 0,
      stdout: JSON.stringify({ id: 1, full_name: 'o/s', private: false }),
      stderr: '',
    });
    const gate = () =>
      acceptanceGate(
        gh,
        'https://api.github.com/repos/o/s',
        3071,
        (async (url: string) => app.request(new URL(url).pathname)) as unknown as typeof fetch,
        'https://example.org',
      );

    // 目标没验完不许替代；旧头走标准 settle 被合并回执 guard 拒（不冒领）
    expect(await supersede(final.generation)).toBe(1);
    expect(await settle(old.id, old.generation, OLD)).toBe(1);
    expect(await settle(final.id, final.generation, FINAL)).toBe(0);
    expect(await status()).toEqual({ [OLD]: 'open', [FINAL]: 'settled' });
    expect(await gate()).toContain('未结清');
    // 陈旧目标代次：拒，不落账
    expect(await supersede(final.generation + 1)).toBe(1);
    expect(await readAcceptanceDutySupersessions(t.db, issue)).toEqual([]);

    expect(await supersede(final.generation)).toBe(0);
    expect(JSON.parse(output.pop() ?? 'null')).toMatchObject({
      id: old.id,
      head: OLD,
      mergeCommit: null,
      mergedAt: null,
      settledAt: null,
      successorId: final.id,
      successorGeneration: final.generation,
      supersedeEvidence: 'PR #3081 最终头已合已验',
    });
    expect(await status()).toEqual({ [OLD]: 'superseded', [FINAL]: 'settled' });
    expect(await gate()).toBeUndefined();
    const [oldPublic, finalPublic] = await publicDuties();
    expect(oldPublic).toMatchObject({
      id: old.id,
      state: 'superseded',
      mergeCommit: null,
      settledAt: null,
      supersededAt: '2026-10-18T11:00:00.000Z',
      successorId: final.id,
      successorGeneration: final.generation,
    });
    expect(String(oldPublic?.supersededBy)).toMatch(/^ops:acceptance:/);
    expect(finalPublic).toMatchObject({ state: 'settled', mergeCommit: SQUASH });

    // 重放幂等；换证据不冒充成功；操作记录只一条
    expect(await supersede(final.generation)).toBe(0);
    expect(await supersede(final.generation, '另一份证据')).toBe(1);
    expect(await readAcceptanceDutySupersessions(t.db, issue)).toHaveLength(1);

    // 目标后来新增项：替代过期，status、公开口一起回到开着
    await upsertAcceptanceDuty(t.db, { ...base, head: FINAL, items: ['合后补一条'] });
    expect(await status()).toEqual({ [OLD]: 'open', [FINAL]: 'open' });
    expect((await publicDuties()).map((d) => d.state)).toEqual(['open', 'open']);
    expect(await gate()).toContain('未结清');
    expect(await readAcceptanceDutyRows(t.db, issue)).toHaveLength(2);
  },
  TEST_DB_TIMEOUT_MS,
);

it(
  '#3071 真实措辞不同的验收项：生产CLI带 --coverage 才能替代，status、公开口、关单闸同一结论',
  async () => {
    const [repo] = await t.db
      .insert(repos)
      .values({ owner: 'o', name: 'w', testCommand: 'pnpm check' })
      .returning();
    if (!repo) throw new Error('repo seed failed');
    const [task] = await t.db
      .insert(tasks)
      .values({
        repoId: repo.id,
        issueNumber: 3072,
        title: '换头且措辞不同的单',
        rawRequest: '验收',
        requestedBy: 'frank',
        priority: 1,
        state: 'running',
      })
      .returning();
    if (!task) throw new Error('task seed failed');
    const OLD = 'c471bae51632e024f9aeaace4c8e074e627c1376';
    const FINAL = 'aa5b84356ca84f8b50cdb05cf606614741049437';
    const SRC_ITEM = '第 5 条：PR 全套 CI 是否最终全绿并 squash 需要看合并闸和 PR 状态，diff 无法判定。';
    const TGT_ITEM = '第5条：PR 全套 CI 是否已绿、是否已 squash 需要 GitHub 外部状态，diff 和材料无法判定。';
    const issue = { repo: 'o/w', issueNumber: 3072 };
    const base = { taskId: task.id, ...issue, prNumber: 3081 };
    await upsertAcceptanceDuty(t.db, { ...base, head: OLD, items: [SRC_ITEM] });
    await upsertAcceptanceDuty(t.db, {
      ...base,
      head: FINAL,
      items: [TGT_ITEM],
      mergeCommit: 'b41eaed8886eb30e799a1a9911414b55e17d56c6',
      mergedAt: new Date(),
    });
    const find = async (head: string) => {
      const row = (await readAcceptanceDutyRows(t.db, issue)).find((r) => r.head === head);
      if (!row) throw new Error('duty seed failed');
      return row;
    };
    const output: string[] = [];
    const deps = {
      env: { DATABASE_URL: 'test' },
      out: (x: string) => output.push(x),
      err: () => {},
      openDb: async () => ({ db: t.db, close: async () => {} }),
      openStore: async () => {
        throw new Error('unexpected');
      },
      now: () => new Date('2026-10-18T12:00:00Z'),
    } as CliDeps;
    const final0 = await find(FINAL);
    expect(
      await main(
        [
          'acceptance',
          'settle',
          'o/w',
          '3072',
          '--id',
          String(final0.id),
          '--generation',
          String(final0.generation),
          '--pr',
          '3081',
          '--head',
          FINAL,
          '--evidence',
          '最终头现场验收',
        ],
        deps,
      ),
    ).toBe(0);
    const old = await find(OLD);
    const final = await find(FINAL);
    const supersede = (...extra: string[]) =>
      main(
        [
          'acceptance',
          'supersede',
          'o/w',
          '3072',
          '--id',
          String(old.id),
          '--generation',
          String(old.generation),
          '--pr',
          '3081',
          '--head',
          OLD,
          '--target-id',
          String(final.id),
          '--target-generation',
          String(final.generation),
          '--target-pr',
          '3081',
          '--target-head',
          FINAL,
          '--evidence',
          'PR #3081 最终头已合已验',
          ...extra,
        ],
        deps,
      );
    const coverage = JSON.stringify([
      { source: SRC_ITEM, target: TGT_ITEM, basis: '同为最终全 CI 绿 + squash 的外部状态判定' },
    ]);
    // 不带声明、声明写错原文：拒，不落账
    expect(await supersede()).toBe(1);
    expect(
      await supersede('--coverage', JSON.stringify([{ source: '第 5 条', target: TGT_ITEM, basis: '子串' }])),
    ).toBe(1);
    expect(await readAcceptanceDutySupersessions(t.db, issue)).toEqual([]);
    expect((await find(OLD)).supersededAt).toBeNull();

    expect(await supersede('--coverage', coverage)).toBe(0);
    expect(JSON.parse(output.pop() ?? 'null')).toMatchObject({
      head: OLD,
      mergeCommit: null,
      supersedeCoverage: [{ source: SRC_ITEM, target: TGT_ITEM }],
    });
    expect(await supersede('--coverage', coverage)).toBe(0);
    expect(await readAcceptanceDutySupersessions(t.db, issue)).toEqual([
      expect.objectContaining({
        coverage: [expect.objectContaining({ source: SRC_ITEM, target: TGT_ITEM })],
      }),
    ]);

    expect(await main(['acceptance', 'status', 'o/w', '3072'], deps)).toBe(0);
    const list = JSON.parse(output.pop() ?? 'null') as { head: string; state: string }[];
    expect(Object.fromEntries(list.map((d) => [d.head, d.state]))).toEqual({
      [OLD]: 'superseded',
      [FINAL]: 'settled',
    });
    const app = acceptancePublicRoutes({
      ciPolicyBridge: { read: async () => ({ repo: 'o/w' }) },
      acceptanceDuties: (x: { repo: string; issueNumber: number }) => readAcceptanceDutyRows(t.db, x),
    } as unknown as Deps);
    const res = await app.request('/api/public/acceptance/v1/repos/1/issues/3072');
    const duties = ((await res.json()) as { duties: Record<string, unknown>[] }).duties;
    expect(duties[0]).toMatchObject({ state: 'superseded', supersedeCoverage: [{ source: SRC_ITEM }] });
    const gh = async () => ({
      code: 0,
      stdout: JSON.stringify({ id: 1, full_name: 'o/w', private: false }),
      stderr: '',
    });
    expect(
      await acceptanceGate(
        gh,
        'https://api.github.com/repos/o/w',
        3072,
        (async (url: string) => app.request(new URL(url).pathname)) as unknown as typeof fetch,
        'https://example.org',
      ),
    ).toBeUndefined();
  },
  TEST_DB_TIMEOUT_MS,
);
