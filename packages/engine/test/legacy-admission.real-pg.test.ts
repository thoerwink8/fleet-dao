import { randomUUID } from 'node:crypto';
import {
  createConcurrentTestDb,
  realTestPgUrl,
  resetTestDb,
  TEST_DB_TIMEOUT_MS,
} from '@fleet-dao/db/testing';
import {
  canonicalExecutionInput,
  createPgStore,
  devFixtures,
  executionInputHash,
  IDS,
  type LegacyExecutionIdentityV1,
} from '@fleet-dao/store';
import { seedPg } from '@fleet-dao/store/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBoundedLegacyAdmission } from '../src/real/legacy-admission-process.ts';
import { commitAckProxy } from './fixtures/legacy-admission-pg-proxy.ts';

const url = realTestPgUrl();
it.runIf(Boolean(process.env.CI) && !url)('CI必须在pg台提供真实PG配置', () => {
  throw new Error('legacy进程真实PG验收缺配置');
});
describe.runIf(Boolean(url))('legacy独立宿主真实PG（随机库/独立observer）', () => {
  let t: Awaited<ReturnType<typeof createConcurrentTestDb>>;
  let databaseUrl: string;
  let observerPids: number[];
  const audit = {
    actor: { kind: 'user' as const, id: IDS.founderA },
    via: 'agent' as const,
    reason: 'legacy独立宿主真实隔离验证',
  };
  const callOptions = (signal = new AbortController().signal) => ({
    signal,
    deadlineAt: performance.now() + 10_000,
  });
  const candidate = (over: Partial<LegacyExecutionIdentityV1> = {}): LegacyExecutionIdentityV1 => {
    const inputCanonical = canonicalExecutionInput({
      schemaVersion: 1,
      taskId: IDS.task12,
      repo: { id: IDS.repo, owner: 'example', name: 'canary' },
      issueNumber: 12,
      title: '真实隔离Start',
    });
    return {
      schemaVersion: 1,
      taskId: IDS.task12,
      namespace: 'test',
      workflowId: 'task:example/canary#12',
      runId: randomUUID(),
      workflowType: 'taskWorkflow',
      taskQueue: 'legacy',
      generation: 1,
      inputCanonical,
      inputHash: executionInputHash(inputCanonical),
      ...over,
    };
  };
  beforeAll(async () => {
    t = await createConcurrentTestDb();
    const identities = [];
    for (const connection of [t, ...t.peers, t.blocker])
      identities.push(
        (
          await connection.client.query<{ db: string; pid: number }>(
            'select current_database() as db, pg_backend_pid() as pid',
          )
        ).rows[0],
      );
    const db = identities[0]?.db;
    expect(db).toMatch(/^fleet_test_[a-f0-9]{32}$/);
    expect(new Set(identities.map((i) => i?.db)).size).toBe(1);
    observerPids = identities.map((i) => {
      if (!i) throw new Error('PG身份缺失');
      return i.pid;
    });
    expect(new Set(observerPids).size).toBe(4);
    const parsed = new URL(url as string);
    parsed.pathname = `/${db}`;
    // 故意带0，验证事务SET LOCAL不能被URL覆盖。
    parsed.searchParams.set('statement_timeout', '0');
    parsed.searchParams.set('lock_timeout', '0');
    databaseUrl = parsed.href;
  }, TEST_DB_TIMEOUT_MS);
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await resetTestDb(t);
    const fixtures = devFixtures(new Date('2026-10-19T09:00:00Z'));
    await seedPg(t.db, { repos: fixtures.repos ?? [], tasks: fixtures.tasks ?? [] });
  });
  async function counts() {
    const rows = await t.client.query<{ admissions: number; audits: number }>(
      'select (select count(*)::int from task_legacy_execution_admissions) as admissions, (select count(*)::int from audit_log) as audits',
    );
    return rows.rows[0];
  }
  async function extraBackends(waitingOnly = false) {
    const found = await t.client.query<{ pid: number }>(
      `select pid from pg_stat_activity where datname=current_database() and not (pid=any($1::int[])) ${waitingOnly ? "and wait_event_type='Lock'" : ''}`,
      [observerPids],
    );
    return found.rows;
  }
  async function noResidualLocks() {
    await expect.poll(async () => (await extraBackends()).length, { timeout: 4000 }).toBe(0);
    expect(
      (
        await t.client.query<{ n: number }>(
          'select count(*)::int as n from pg_locks l join pg_stat_activity a on l.pid=a.pid where a.datname=current_database() and not (a.pid=any($1::int[]))',
          [observerPids],
        )
      ).rows[0]?.n,
    ).toBe(0);
  }
  it('正常admitted+replayed，共一份责任一条审计，子backend/锁均已收掉', async () => {
    const c = createBoundedLegacyAdmission({ databaseUrl }),
      input = candidate();
    const first = await c.admit(input, audit, callOptions());
    expect(first).toMatchObject({ kind: 'allowed', status: 'admitted', postCommitWarnings: [] });
    expect(await c.admit(input, audit, callOptions())).toEqual({ ...first, status: 'replayed' });
    expect(await counts()).toEqual({ admissions: 1, audits: 1 });
    await noResidualLocks();
  });
  it.each(['tasks', 'controls', 'unique'] as const)(
    '%s真实锁在途取消，已发IO未知但无新责任/锁残留',
    async (kind) => {
      const input = candidate(),
        controller = new AbortController();
      await t.blocker.client.exec('begin');
      try {
        if (kind === 'tasks')
          await t.blocker.client.query('select id from tasks where id=$1 for update', [IDS.task12]);
        if (kind === 'controls')
          await t.blocker.client.exec('lock table task_execution_controls in access exclusive mode');
        if (kind === 'unique')
          await t.blocker.client.query(
            'insert into task_legacy_execution_admissions (id,schema_version,task_id,namespace,workflow_id,run_id,workflow_type,task_queue,generation,input_canonical,input_hash,admitted_at) values ($1,1,$2,$3,$4,$5,$6,$7,1,$8,$9,now())',
            [
              randomUUID(),
              IDS.task13,
              input.namespace,
              input.workflowId,
              input.runId,
              input.workflowType,
              input.taskQueue,
              input.inputCanonical,
              input.inputHash,
            ],
          );
        const c = createBoundedLegacyAdmission({ databaseUrl }),
          run = c.admit(input, audit, callOptions(controller.signal));
        await expect
          .poll(async () => (await extraBackends(true)).length, { timeout: 4000, interval: 10 })
          .toBe(1);
        controller.abort();
        expect(await run).toEqual({ kind: 'unknown', code: 'cancelled' });
        expect(c.status().active).toBe(0);
        await noResidualLocks();
      } finally {
        await t.blocker.client.exec('rollback');
      }
      expect(await counts()).toEqual({ admissions: 0, audits: 0 });
    },
  );
  it('服务端lock_timeout兜底：URL里的0无效，未到父总期限就未知收尾', async () => {
    await t.blocker.client.exec('begin');
    try {
      await t.blocker.client.query('select id from tasks where id=$1 for update', [IDS.task12]);
      const c = createBoundedLegacyAdmission({ databaseUrl }),
        start = performance.now();
      const run = c.admit(candidate(), audit, callOptions());
      await expect
        .poll(async () => (await extraBackends(true)).length, { timeout: 4000, interval: 10 })
        .toBe(1);
      expect(await run).toEqual({ kind: 'unknown', code: 'store_unavailable' });
      expect(performance.now() - start).toBeLessThan(6000);
      await noResidualLocks();
    } finally {
      await t.blocker.client.exec('rollback');
    }
    expect(await counts()).toEqual({ admissions: 0, audits: 0 });
  });
  it('audit真实失败：admission同事务回滚，不冒成功也不泄漏原始异常', async () => {
    await t.client.exec(
      "create function legacy_probe_fail_audit() returns trigger language plpgsql as $$ begin raise exception 'private fixture audit failure'; end $$; create trigger legacy_probe_fail_audit before insert on audit_log for each row execute function legacy_probe_fail_audit()",
    );
    try {
      expect(
        await createBoundedLegacyAdmission({ databaseUrl }).admit(candidate(), audit, callOptions()),
      ).toEqual({ kind: 'unknown', code: 'store_unavailable' });
      expect(await counts()).toEqual({ admissions: 0, audits: 0 });
      await noResidualLocks();
    } finally {
      await t.client.exec(
        'drop trigger legacy_probe_fail_audit on audit_log; drop function legacy_probe_fail_audit()',
      );
    }
  });
  it('两个独立宿主并发同run，原Store幂等判定和审计原子性不复制', async () => {
    const input = candidate();
    const results = await Promise.all([
      createBoundedLegacyAdmission({ databaseUrl }).admit(input, audit, callOptions()),
      createBoundedLegacyAdmission({ databaseUrl }).admit(input, audit, callOptions()),
    ]);
    expect(results.map((r) => (r.kind === 'allowed' ? r.status : r.kind)).sort()).toEqual([
      'admitted',
      'replayed',
    ]);
    expect(await counts()).toEqual({ admissions: 1, audits: 1 });
    await noResidualLocks();
  });
  it('外层COMMIT前不发通知；真提交但ACK被挡后取消仍unknown，observer保留责任', async () => {
    const proxy = await commitAckProxy(databaseUrl),
      controller = new AbortController(),
      messages: string[] = [];
    const unlisten = await t.client.listen('fleet_changes', (payload) => messages.push(payload));
    observerPids = (
      await t.client.query<{ pid: number }>(
        'select pid from pg_stat_activity where datname=current_database()',
      )
    ).rows.map((row) => row.pid);
    try {
      const input = candidate(),
        c = createBoundedLegacyAdmission({ databaseUrl: proxy.url });
      const run = c.admit(input, audit, callOptions(controller.signal));
      await expect.poll(() => proxy.status().seenCommit, { timeout: 4000 }).toBe(true);
      expect(await counts()).toEqual({ admissions: 0, audits: 0 });
      expect(messages).toEqual([]);
      proxy.releaseCommit();
      await expect.poll(counts, { timeout: 3000 }).toEqual({ admissions: 1, audits: 1 });
      await expect.poll(() => proxy.status().droppedBytes, { timeout: 2000 }).toBeGreaterThan(0);
      controller.abort();
      expect(await run).toEqual({ kind: 'unknown', code: 'cancelled' });
      const retained = await createPgStore(t.db).listLegacyExecutionAdmissions(input.taskId);
      expect(retained).toHaveLength(1);
      expect(retained[0]?.runId).toBe(input.runId);
      expect(await counts()).toEqual({ admissions: 1, audits: 1 });
      await noResidualLocks();
      // 空warning不代表送达；这里独立LISTEN验证真外层提交之后才可见audit通知。
      await expect
        .poll(() => messages.some((p) => JSON.parse(p).table === 'audit_log'), { timeout: 2000 })
        .toBe(true);
    } finally {
      controller.abort();
      await proxy.close();
      await unlisten();
    }
  });
});
