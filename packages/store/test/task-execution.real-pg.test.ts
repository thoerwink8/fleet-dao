import { taskExecutionControls, tasks } from '@fleet-dao/db';
import {
  allSettledOrThrow,
  createConcurrentTestDb,
  realTestPgUrl,
  resetTestDb,
  TEST_DB_TIMEOUT_MS,
} from '@fleet-dao/db/testing';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IDS } from '../src/dev-fixtures.ts';
import { createPgStore } from '../src/pg-store.ts';
import type { Store } from '../src/ports.ts';
import type { ExecutionResult } from '../src/task-execution.ts';
import { seedPg } from '../src/testing.ts';
import {
  admissionSeed,
  birthInput,
  describeAdmissionContract,
  legacyInput,
  requiredAdmissionTask,
} from './task-admission-contract.ts';
import {
  describeExecutionContract,
  EXECUTION_TIME,
  executionAudit,
  executionControl,
  executionInput,
  executionSeed,
} from './task-execution-contract.ts';
import { readExecutionOperations } from './task-execution-pg-fixture.ts';
import { describeExecutionSchema } from './task-execution-schema-contract.ts';

const url = realTestPgUrl();
it.runIf(Boolean(process.env.CI) && !url)('CI真实竞争测试缺FLEET_TEST_PG_URL必须失败', () => {
  throw new Error('真实竞争测试必须在pg台运行，缺FLEET_TEST_PG_URL');
});
describe.runIf(Boolean(url))('真实PG执行资格（同随机隔离库/独立backend）', () => {
  let t: Awaited<ReturnType<typeof createConcurrentTestDb>>;
  let stores: readonly [Store, Store];
  let pids: readonly number[];
  beforeAll(async () => {
    t = await createConcurrentTestDb();
    const identities = await allSettledOrThrow(
      t.peers.map((peer) =>
        peer.client.query<{ db: string; pid: number }>(
          'select current_database() as db, pg_backend_pid() as pid',
        ),
      ),
    );
    const first = identities[0]?.rows[0];
    const second = identities[1]?.rows[0];
    if (!first || !second) throw new Error('真实PG缺少独立连接身份');
    expect(first.db).toMatch(/^fleet_test_[a-f0-9]{32}$/);
    expect(first.db).toBe(second.db);
    expect(first.pid).not.toBe(second.pid);
    pids = [first.pid, second.pid];
    console.info('真实PG竞争夹具', { database: first.db, backendPids: pids });
    stores = [
      createPgStore(t.peers[0].db, { now: () => EXECUTION_TIME }),
      createPgStore(t.peers[1].db, { now: () => EXECUTION_TIME }),
    ];
  }, TEST_DB_TIMEOUT_MS);
  afterAll(async () => {
    await t?.close();
  });
  const reset = async () => {
    await resetTestDb(t);
    await seedPg(t.db, executionSeed(null));
    await t.db.insert(taskExecutionControls).values(executionControl());
  };

  /** 先持tasks锁，再启动两条真实方法；确认两backend已在PG锁等待，才放开barrier。 */
  async function compete(
    actions: readonly [() => Promise<ExecutionResult>, () => Promise<ExecutionResult>],
  ): Promise<ExecutionResult[]> {
    let release!: () => void;
    let entered!: () => void;
    let failReady!: (reason: unknown) => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve, reject) => {
      entered = resolve;
      failReady = reject;
    });
    const blocker = t.blocker.db.transaction(async (tx) => {
      await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, IDS.task12)).for('update');
      entered();
      await gate;
    });
    void blocker.catch(failReady);
    // ready不能隐藏连接/事务错误；查询前由beforeAll已验证本次真实库。
    let pending: Promise<ExecutionResult>[] = [];
    let observationFailure: unknown;
    try {
      await ready;
      pending = actions.map((action) => action());
      for (const promise of pending) void promise.catch(() => {});
      const deadline = performance.now() + 5000;
      let bothWaiting = false;
      while (performance.now() < deadline) {
        const waits = await t.client.query<{ n: number }>(
          "select count(*)::int as n from pg_stat_activity where datname=current_database() and pid=any($1::int[]) and wait_event_type='Lock' and cardinality(pg_blocking_pids(pid))>0",
          [pids],
        );
        if (waits.rows[0]?.n === 2) {
          bothWaiting = true;
          break;
        }
      }
      expect(bothWaiting, '两个独立backend必须均有真实锁等待证据').toBe(true);
    } catch (error) {
      observationFailure = error;
    } finally {
      release();
    }
    const settled = await allSettledOrThrow([...pending, blocker]);
    if (observationFailure) throw observationFailure;
    return settled.slice(0, pending.length) as ExecutionResult[];
  }

  describe('真实竞争与回滚', () => {
    beforeEach(reset);
    it('两个reserve只提交一个赢家，操作和审计只有一条', async () => {
      const inputs = [executionInput(), executionInput()] as const;
      const results = await compete([
        () => stores[0].reserveExecution(inputs[0], executionAudit),
        () => stores[1].reserveExecution(inputs[1], executionAudit),
      ]);
      expect(results.filter((r) => r.kind === 'applied')).toHaveLength(1);
      expect(results.filter((r) => r.kind === 'rejected')).toHaveLength(1);
      expect(
        (await t.client.query<{ n: number }>('select count(*)::int as n from task_execution_operations'))
          .rows[0]?.n,
      ).toBe(1);
      expect(
        (
          await t.client.query<{ n: number }>(
            "select count(*)::int as n from audit_log where action='task_execution.reserve'",
          )
        ).rows[0]?.n,
      ).toBe(1);
    });
    it('dispatch/cancel竞争只允许一个提交，迟到admit不能覆盖墓碑', async () => {
      const input = executionInput();
      await stores[0].reserveExecution(input, executionAudit);
      const results = await compete([
        () => stores[0].dispatchExecution(input, executionAudit),
        () => stores[1].resolveExecution({ ...input, reason: 'cancelled_before_dispatch' }, executionAudit),
      ]);
      expect(results.filter((r) => r.kind === 'applied')).toHaveLength(1);
      expect(results.filter((r) => r.kind === 'rejected')).toHaveLength(1);
      const state = await stores[0].getExecutionControl(input.taskId);
      if (state.kind !== 'managed') throw new Error('测试资格消失');
      if (state.current?.phase === 'dispatching') {
        expect(
          await stores[1].resolveExecution({ ...input, reason: 'cancelled_before_dispatch' }, executionAudit),
        ).toEqual({ kind: 'rejected', reason: 'proof_required' });
      } else {
        expect(state.control.currentOperationId).toBeNull();
        expect(await stores[0].admitExecution({ ...input, runId: 'late' }, executionAudit)).toMatchObject({
          kind: 'rejected',
        });
        expect(await stores[0].reserveExecution(input, executionAudit)).toMatchObject({
          kind: 'replayed',
          operation: { phase: 'resolved' },
        });
      }
    });
    it('两个run竞争只绑定一个；重建和推进时钟均不释放', async () => {
      const input = executionInput();
      await stores[0].reserveExecution(input, executionAudit);
      await stores[0].dispatchExecution(input, executionAudit);
      const results = await compete([
        () => stores[0].admitExecution({ ...input, runId: 'run-a' }, executionAudit),
        () => stores[1].admitExecution({ ...input, runId: 'run-b' }, executionAudit),
      ]);
      expect(results.filter((r) => r.kind === 'applied')).toHaveLength(1);
      expect(results.filter((r) => r.kind === 'rejected')).toHaveLength(1);
      const rebuilt = createPgStore(t.peers[1].db, { now: () => new Date('2099-01-01') });
      expect(
        await rebuilt.resolveExecution({ ...input, reason: 'cancelled_before_dispatch' }, executionAudit),
      ).toEqual({ kind: 'rejected', reason: 'proof_required' });
      const winner = results.find((r) => r.kind === 'applied');
      if (!winner || winner.kind === 'rejected' || !winner.operation.admittedRunId)
        throw new Error('缺赢家run身份');
      expect(
        await rebuilt.admitExecution({ ...input, runId: winner.operation.admittedRunId }, executionAudit),
      ).toMatchObject({ kind: 'replayed' });
    });
    it('两个不同终态证明竞争 admitted：只提交一个释放，另一个冲突，审计只有一条', async () => {
      const input = executionInput();
      await stores[0].reserveExecution(input, executionAudit);
      await stores[0].dispatchExecution(input, executionAudit);
      await stores[0].admitExecution({ ...input, runId: 'run-a' }, executionAudit);
      const results = await compete([
        () =>
          stores[0].closeExecutionRun({ ...input, runId: 'run-a', terminal: 'completed' }, executionAudit),
        () => stores[1].closeExecutionRun({ ...input, runId: 'run-a', terminal: 'failed' }, executionAudit),
      ]);
      expect(results.filter((r) => r.kind === 'applied')).toHaveLength(1);
      expect(results.filter((r) => r.kind === 'rejected')).toHaveLength(1);
      expect(
        (
          await t.client.query<{ n: number }>(
            "select count(*)::int as n from audit_log where action='task_execution.close'",
          )
        ).rows[0]?.n,
      ).toBe(1);
      const reasons = await t.client.query<{ r: string }>(
        'select resolved_reason as r from task_execution_operations',
      );
      expect(reasons.rows).toHaveLength(1);
      expect(['run_completed', 'run_failed']).toContain(reasons.rows[0]?.r);
    });
    it('终态证明与晚到的另一 run admit 竞争：admit 不能覆盖已释放的墓碑', async () => {
      const input = executionInput();
      await stores[0].reserveExecution(input, executionAudit);
      await stores[0].dispatchExecution(input, executionAudit);
      await stores[0].admitExecution({ ...input, runId: 'run-a' }, executionAudit);
      await stores[0].closeExecutionRun({ ...input, runId: 'run-a', terminal: 'terminated' }, executionAudit);
      expect(await stores[1].admitExecution({ ...input, runId: 'run-b' }, executionAudit)).toMatchObject({
        kind: 'rejected',
      });
      expect(
        await stores[1].closeExecutionRun(
          { ...input, runId: 'run-b', terminal: 'terminated' },
          executionAudit,
        ),
      ).toEqual({
        kind: 'rejected',
        reason: 'identity_conflict',
      });
    });
    for (const action of ['reserve', 'dispatch', 'admit', 'resolve', 'close'] as const)
      it(`真实审计INSERT trigger失败：${action}整笔回滚`, async () => {
        const input = executionInput();
        if (action !== 'reserve') await stores[0].reserveExecution(input, executionAudit);
        if (action === 'admit' || action === 'close')
          await stores[0].dispatchExecution(input, executionAudit);
        if (action === 'close') await stores[0].admitExecution({ ...input, runId: 'run-a' }, executionAudit);
        const before = await stores[0].getExecutionControl(input.taskId);
        const operationsBefore = await t.client.query('select * from task_execution_operations order by id');
        const auditBefore = await t.client.query('select * from audit_log order by id');
        await t.client.exec(
          `create function reject_execution_audit() returns trigger language plpgsql as $$ begin if NEW.action = 'task_execution.${action}' then raise exception 'test_actual_audit_insert_failure'; end if; return NEW; end $$; create trigger test_execution_audit_failure before insert on audit_log for each row execute function reject_execution_audit()`,
        );
        try {
          const call =
            action === 'reserve'
              ? stores[0].reserveExecution(input, executionAudit)
              : action === 'dispatch'
                ? stores[0].dispatchExecution(input, executionAudit)
                : action === 'admit'
                  ? stores[0].admitExecution({ ...input, runId: 'run-a' }, executionAudit)
                  : action === 'close'
                    ? stores[0].closeExecutionRun(
                        { ...input, runId: 'run-a', terminal: 'completed' },
                        executionAudit,
                      )
                    : stores[0].resolveExecution(
                        { ...input, reason: 'cancelled_before_dispatch' },
                        executionAudit,
                      );
          await expect(call).rejects.toThrow();
          expect(await stores[1].getExecutionControl(input.taskId)).toEqual(before);
          expect(await t.client.query('select * from task_execution_operations order by id')).toEqual(
            operationsBefore,
          );
          expect(await t.client.query('select * from audit_log order by id')).toEqual(auditBefore);
        } finally {
          await t.client.exec(
            'drop trigger test_execution_audit_failure on audit_log; drop function reject_execution_audit()',
          );
        }
      });
  });

  describeExecutionContract('真实PgStore共用身份合同', async (control) => {
    await resetTestDb(t);
    await seedPg(t.db, executionSeed(null));
    if (control)
      await t.db
        .insert(taskExecutionControls)
        .values([...(executionSeed(control).executionControls?.values() ?? [])]);
    return {
      store: stores[0],
      rebuild: (now) => createPgStore(t.peers[1].db, { now: () => now }),
      operations: () => readExecutionOperations(t.db),
      audits: async () => (await t.client.query('select action,target,ok from audit_log order by id')).rows,
    };
  });
  describeExecutionSchema('真实PG SQL约束', async () => {
    await resetTestDb(t);
    return t;
  });

  describeAdmissionContract('真实PG出生/legacy共用合同', async () => {
    await resetTestDb(t);
    await seedPg(t.db, admissionSeed());
    return {
      store: stores[0],
      rebuild: (now) => createPgStore(t.peers[1].db, { now: () => now }),
      audits: async () =>
        (await t.client.query('select action,target,after,ok from audit_log order by id')).rows,
    };
  });

  describe('出生与legacy真实双连接可控交错', () => {
    beforeEach(async () => {
      await resetTestDb(t);
      await seedPg(t.db, admissionSeed());
    });
    /** INSERT trigger由真正PG advisory锁阻塞；读pg_stat_activity证明指定backend到达窗口。 */
    async function withInsertBarrier(
      table: 'task_execution_births' | 'task_legacy_execution_admissions',
      body: (wait: (indices: number[]) => Promise<void>) => Promise<void>,
    ): Promise<void> {
      await t.client.exec(
        `create function admission_test_barrier() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(3337001); return NEW; end $$; create trigger test_admission_barrier before insert on ${table} for each row execute function admission_test_barrier()`,
      );
      let release!: () => void;
      let ready!: () => void;
      let failed!: (error: unknown) => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve, reject) => {
        ready = resolve;
        failed = reject;
      });
      const blocker = t.blocker.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(3337001)`);
        ready();
        await gate;
      });
      void blocker.catch(failed);
      const wait = async (indices: number[]) => {
        const chosen = indices.map((i) => pids[i]);
        const deadline = performance.now() + 5000;
        while (performance.now() < deadline) {
          const observed = await t.client.query<{ n: number }>(
            "select count(*)::int as n from pg_stat_activity where datname=current_database() and pid=any($1::int[]) and wait_event_type='Lock' and cardinality(pg_blocking_pids(pid))>0",
            [chosen],
          );
          if (observed.rows[0]?.n === chosen.length) return;
        }
        throw new Error('准入barrier未观察到指定backend真实锁等待');
      };
      try {
        await entered;
        await body(wait);
      } finally {
        release();
        await blocker;
        await t.client.exec(
          `drop trigger test_admission_barrier on ${table}; drop function admission_test_barrier()`,
        );
      }
    }
    const rows = async () => {
      const result: Record<string, unknown> = {};
      for (const table of [
        'tasks',
        'task_execution_controls',
        'task_execution_births',
        'task_legacy_execution_admissions',
        'state_changes',
        'audit_log',
      ])
        result[table] = (await t.client.query(`select * from ${table} order by 1`)).rows;
      return result;
    };
    it('同完整出生请求竞争只审计一次，赢家created、其余replayed', async () => {
      const input = birthInput();
      let pending: ReturnType<Store['createManagedTaskFromIssue']>[] = [];
      await withInsertBarrier('task_execution_births', async (wait) => {
        pending = [
          stores[0].createManagedTaskFromIssue(input, executionAudit),
          stores[1].createManagedTaskFromIssue(input, executionAudit),
        ];
        for (const promise of pending) void promise.catch(() => {});
        await wait([0, 1]);
        // 调用后修改外部对象，事务必须仍只使用入口时的快照。
        input.task.title = 'caller mutation while blocked';
      });
      const results = await allSettledOrThrow(pending);
      expect(results.map((r) => r.kind).sort()).toEqual(['created', 'replayed']);
      for (const result of results) {
        if (result.kind === 'rejected') throw new Error('出生竞争失败');
        expect(result.task.title).toBe('出生');
        expect(result.birth.birthInputCanonical).not.toContain('caller mutation');
      }
      expect((await rows()).audit_log).toHaveLength(1);
    });
    for (const sameIssue of [true, false])
      it(`并发出生${sameIssue ? '同issue不同request' : '不同task同全局request'} loser整事务零残留`, async () => {
        const first = birthInput();
        const second = birthInput({
          birthRequestId: sameIssue ? birthInput().birthRequestId : first.birthRequestId,
          task: {
            ...first.task,
            id: birthInput().task.id,
            issueNumber: sameIssue ? first.task.issueNumber : 901,
          },
        });
        let pending: Promise<unknown>[] = [];
        await withInsertBarrier('task_execution_births', async (wait) => {
          pending = [
            stores[0].createManagedTaskFromIssue(first, executionAudit),
            stores[1].createManagedTaskFromIssue(second, executionAudit),
          ];
          for (const promise of pending) void promise.catch(() => {});
          await wait([0, 1]);
        });
        const results = (await allSettledOrThrow(pending)) as { kind: string }[];
        expect(results.filter((r) => r.kind === 'created')).toHaveLength(1);
        expect(results.filter((r) => r.kind === 'rejected')).toHaveLength(1);
        const state = await rows();
        expect(state.task_execution_controls).toHaveLength(1);
        expect(state.task_execution_births).toHaveLength(1);
        expect(state.task_legacy_execution_admissions).toHaveLength(0);
        expect(
          (state.tasks as { id: string }[]).filter((t) => [first.task.id, second.task.id].includes(t.id)),
        ).toHaveLength(1);
        expect(
          (state.state_changes as { task_id: string }[]).filter((s) =>
            [first.task.id, second.task.id].includes(s.task_id),
          ),
        ).toHaveLength(1);
        expect(state.audit_log).toHaveLength(1);
      });
    it('出生未提交时legacy不读脏task；提交后只允许operation路径', async () => {
      const input = birthInput();
      let pending!: ReturnType<Store['createManagedTaskFromIssue']>;
      await withInsertBarrier('task_execution_births', async (wait) => {
        pending = stores[0].createManagedTaskFromIssue(input, executionAudit);
        void pending.catch(() => {});
        await wait([0]);
        expect(await stores[1].admitLegacyExecution(legacyInput({ ...input.task }), executionAudit)).toEqual({
          kind: 'rejected',
          reason: 'not_found',
        });
      });
      expect(await pending).toMatchObject({ kind: 'created' });
      expect(await stores[1].admitLegacyExecution(legacyInput(input.task), executionAudit)).toEqual({
        kind: 'rejected',
        reason: 'managed_requires_operation',
      });
      expect(await stores[0].listLegacyExecutionAdmissions(input.task.id)).toEqual([]);
    });
    it('legacy先持task锁写责任时，出生不能管理化旧task', async () => {
      const task = requiredAdmissionTask(await stores[0].findTaskByIssue(IDS.repo, 12));
      const input = legacyInput(task);
      let pending!: ReturnType<Store['admitLegacyExecution']>;
      await withInsertBarrier('task_legacy_execution_admissions', async (wait) => {
        pending = stores[0].admitLegacyExecution(input, executionAudit);
        void pending.catch(() => {});
        await wait([0]);
        expect(
          await stores[1].createManagedTaskFromIssue(
            birthInput({
              task: {
                id: task.id,
                repoId: task.repoId,
                issueNumber: task.issueNumber,
                title: task.title,
                rawRequest: task.rawRequest,
                requestedBy: task.requestedBy,
              },
            }),
            executionAudit,
          ),
        ).toEqual({ kind: 'rejected', reason: 'existing_task_forbidden' });
      });
      expect(await pending).toMatchObject({ kind: 'admitted' });
      expect(await stores[0].getExecutionBirth(task.id)).toBeNull();
      expect(await stores[0].getExecutionControl(task.id)).toEqual({ kind: 'unmanaged' });
    });
    it('不同task同时竞争namespace/run，身份均自洽也只允许一条责任', async () => {
      const a = requiredAdmissionTask(await stores[0].findTaskByIssue(IDS.repo, 12));
      const b = requiredAdmissionTask(await stores[0].findTaskByIssue(IDS.repo, 13));
      const first = legacyInput(a);
      let pending: Promise<unknown>[] = [];
      await withInsertBarrier('task_legacy_execution_admissions', async (wait) => {
        pending = [
          stores[0].admitLegacyExecution(first, executionAudit),
          stores[1].admitLegacyExecution(legacyInput(b, { runId: first.runId }), executionAudit),
        ];
        for (const promise of pending) void promise.catch(() => {});
        await wait([0, 1]);
      });
      const results = (await allSettledOrThrow(pending)) as { kind: string; reason?: string }[];
      expect(results.filter((r) => r.kind === 'admitted')).toHaveLength(1);
      expect(results.filter((r) => r.kind === 'rejected' && r.reason === 'identity_conflict')).toHaveLength(
        1,
      );
      const state = await rows();
      expect(state.task_legacy_execution_admissions).toHaveLength(1);
      expect(state.audit_log).toHaveLength(1);
    });
    it('相同legacy run并发重送只写一次，等待期间输入修改不改变持久候选', async () => {
      const task = requiredAdmissionTask(await stores[0].findTaskByIssue(IDS.repo, 12));
      const input = legacyInput(task);
      let pending: ReturnType<Store['admitLegacyExecution']>[] = [];
      await withInsertBarrier('task_legacy_execution_admissions', async (wait) => {
        pending = [
          stores[0].admitLegacyExecution(input, executionAudit),
          stores[1].admitLegacyExecution(input, executionAudit),
        ];
        for (const promise of pending) void promise.catch(() => {});
        await wait([0, 1]);
        input.taskQueue = 'caller mutation while blocked';
      });
      const results = await allSettledOrThrow(pending);
      expect(results.map((r) => r.kind).sort()).toEqual(['admitted', 'replayed']);
      for (const result of results) {
        if (result.kind === 'rejected') throw new Error('legacy并发重送失败');
        expect(result.admission.taskQueue).toBe('legacy');
      }
      const state = await rows();
      expect(state.task_legacy_execution_admissions).toHaveLength(1);
      expect(state.audit_log).toHaveLength(1);
    });
    for (const action of ['birth', 'legacy_admit'] as const)
      it(`${action}审计触发器失败包括state_changes的整事务回滚`, async () => {
        const before = await rows();
        await t.client.exec(
          `create function reject_admission_audit() returns trigger language plpgsql as $$ begin if NEW.action = 'task_execution.${action}' then raise exception 'test_admission_audit_failure'; end if; return NEW; end $$; create trigger test_admission_audit_failure before insert on audit_log for each row execute function reject_admission_audit()`,
        );
        try {
          const call =
            action === 'birth'
              ? stores[0].createManagedTaskFromIssue(birthInput(), executionAudit)
              : stores[0].admitLegacyExecution(
                  legacyInput(requiredAdmissionTask(await stores[0].findTaskByIssue(IDS.repo, 12))),
                  executionAudit,
                );
          await expect(call).rejects.toThrow();
          expect(await rows()).toEqual(before);
        } finally {
          await t.client.exec(
            'drop trigger test_admission_audit_failure on audit_log; drop function reject_admission_audit()',
          );
        }
      });
  });
});
