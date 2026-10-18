import { readAcceptanceDutyRows, repos, tasks, upsertAcceptanceDuty } from '@fleet-dao/db';
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
