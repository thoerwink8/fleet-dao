import { taskExecutionControls, tasks } from '@fleet-dao/db';
import {
  allSettledOrThrow,
  createConcurrentTestDb,
  realTestPgUrl,
  resetTestDb,
  TEST_DB_TIMEOUT_MS,
} from '@fleet-dao/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IDS } from '../src/dev-fixtures.ts';
import { createPgStore } from '../src/pg-store.ts';
import type { Store } from '../src/ports.ts';
import type { ExecutionResult } from '../src/task-execution.ts';
import { seedPg } from '../src/testing.ts';
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
    for (const action of ['reserve', 'dispatch', 'admit', 'resolve'] as const)
      it(`真实审计INSERT trigger失败：${action}整笔回滚`, async () => {
        const input = executionInput();
        if (action !== 'reserve') await stores[0].reserveExecution(input, executionAudit);
        if (action === 'admit') await stores[0].dispatchExecution(input, executionAudit);
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
});
