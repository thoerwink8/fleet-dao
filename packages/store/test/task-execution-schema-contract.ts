import { randomUUID } from 'node:crypto';
import { taskExecutionControls as controls, taskExecutionOperations as operations } from '@fleet-dao/db';
import type { TestDb } from '@fleet-dao/db/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { IDS } from '../src/dev-fixtures.ts';
import { createPgStore } from '../src/pg-store.ts';
import { seedPg } from '../src/testing.ts';
import { birthInput, legacyInput, requiredAdmissionTask } from './task-admission-contract.ts';
import {
  EXECUTION_TIME,
  executionAudit,
  executionControl,
  executionInput,
  executionSeed,
} from './task-execution-contract.ts';

export function describeExecutionSchema(name: string, setup: () => Promise<TestDb>): void {
  describe(name, () => {
    let t: TestDb;
    beforeEach(async () => {
      t = await setup();
      await seedPg(t.db, executionSeed(null));
      await t.db.insert(controls).values(executionControl());
    });
    it('DB CHECK拒绝不安全revision及未知protocol', async () => {
      for (const revision of ['-1', '9007199254740992']) {
        await expect(
          t.client.query('update task_execution_controls set revision = $1 where task_id = $2', [
            revision,
            IDS.task12,
          ]),
        ).rejects.toThrow();
      }
      await expect(
        t.client.exec('update task_execution_controls set protocol_version = 2'),
      ).rejects.toThrow();
      const store = createPgStore(t.db, { now: () => EXECUTION_TIME });
      await store.reserveExecution(executionInput(), executionAudit);
      for (const revision of ['0', '-1', '9007199254740992']) {
        await expect(
          t.client.query('update task_execution_operations set revision = $1', [revision]),
        ).rejects.toThrow();
      }
    });
    it('DB CHECK拒绝未知相位、残缺相位、空身份和非法数值代次', async () => {
      await createPgStore(t.db, { now: () => EXECUTION_TIME }).reserveExecution(
        executionInput(),
        executionAudit,
      );
      for (const change of [
        "phase='unknown'",
        "phase='dispatching'",
        "phase='admitted'",
        "phase='resolved', resolved_at=now()",
        "phase='admitted', dispatched_at=now(), admitted_at=now(), admitted_run_id=' '",
        "node_id=' '",
        "namespace=' '",
        "workflow_id=' '",
        "workflow_type=' '",
        "input_hash=' '",
        'generation=0',
        'generation=-1',
        'generation=21',
      ])
        await expect(t.client.exec(`update task_execution_operations set ${change}`)).rejects.toThrow();
    });
    it('组合FK拒绝跨任务、跨epoch、跨revision的当前指针', async () => {
      const input = executionInput();
      await createPgStore(t.db, { now: () => EXECUTION_TIME }).reserveExecution(input, executionAudit);
      await expect(
        t.db
          .insert(controls)
          .values(
            executionControl({ taskId: IDS.task13, revision: 1, currentOperationId: input.operationId }),
          ),
      ).rejects.toThrow();
      await expect(
        t.client.query('update task_execution_controls set coverage_epoch=$1', [randomUUID()]),
      ).rejects.toThrow();
      await expect(t.client.exec('update task_execution_controls set revision=2')).rejects.toThrow();
    });
    it('DB唯一约束兜住第二个active、重复request和revision', async () => {
      const input = executionInput();
      await createPgStore(t.db, { now: () => EXECUTION_TIME }).reserveExecution(input, executionAudit);
      const [row] = await t.db.select().from(operations);
      if (!row) throw new Error('缺少测试操作');
      await expect(
        t.db.insert(operations).values({ ...row, id: randomUUID(), requestId: randomUUID(), revision: 2 }),
      ).rejects.toThrow();
      const resolved = {
        ...row,
        phase: 'resolved' as const,
        resolvedReason: 'cancelled_before_dispatch' as const,
        resolvedAt: EXECUTION_TIME,
      };
      await expect(
        t.db.insert(operations).values({ ...resolved, id: randomUUID(), revision: 2 }),
      ).rejects.toThrow();
      await expect(
        t.db.insert(operations).values({ ...resolved, id: randomUUID(), requestId: randomUUID() }),
      ).rejects.toThrow();
    });
    it('单有operation不是覆盖证明，缺control仍明确unmanaged', async () => {
      const input = executionInput();
      await createPgStore(t.db, { now: () => EXECUTION_TIME }).reserveExecution(input, executionAudit);
      await t.client.exec('delete from task_execution_controls');
      const store = createPgStore(t.db, { now: () => EXECUTION_TIME });
      expect(await store.getExecutionControl(input.taskId)).toEqual({ kind: 'unmanaged' });
      expect(await store.reserveExecution(input, executionAudit)).toEqual({
        kind: 'rejected',
        reason: 'unmanaged',
      });
    });
    it('出生DB约束拒绝半条、未知protocol、错epoch和坏hash', async () => {
      const store = createPgStore(t.db, { now: () => EXECUTION_TIME });
      const input = birthInput();
      expect(await store.createManagedTaskFromIssue(input, executionAudit)).toMatchObject({
        kind: 'created',
      });
      for (const change of [
        'protocol_version=2',
        "namespace=' '",
        "workflow_type='unknown'",
        "task_queue=' '",
        "birth_input_canonical=' '",
        "birth_input_hash='bad'",
        'birth_request_id=null',
        'created_at=null',
        `coverage_epoch='${randomUUID()}'`,
      ])
        await expect(t.client.exec(`update task_execution_births set ${change}`)).rejects.toThrow();
      await expect(
        t.client.query('update task_execution_controls set coverage_epoch=$1 where task_id=$2', [
          randomUUID(),
          input.task.id,
        ]),
      ).rejects.toThrow();
      await expect(
        t.client.query('insert into task_execution_births(task_id) values($1)', [IDS.task12]),
      ).rejects.toThrow();
    });
    it('legacy DB约束按namespace/run唯一，拒半条和非法代次', async () => {
      const store = createPgStore(t.db, { now: () => EXECUTION_TIME });
      const task = requiredAdmissionTask(await store.findTaskByIssue(IDS.repo, 13));
      expect(await store.admitLegacyExecution(legacyInput(task), executionAudit)).toMatchObject({
        kind: 'admitted',
      });
      for (const change of [
        'schema_version=2',
        'generation=0',
        'generation=21',
        "namespace=' '",
        "workflow_id=' '",
        "workflow_type='unknown'",
        "task_queue=' '",
        "input_canonical=' '",
        "input_hash='bad'",
        'admitted_at=null',
        'run_id=null',
      ])
        await expect(
          t.client.exec(`update task_legacy_execution_admissions set ${change}`),
        ).rejects.toThrow();
      await expect(
        t.client.query('insert into task_legacy_execution_admissions(id,task_id) values($1,$2)', [
          randomUUID(),
          task.id,
        ]),
      ).rejects.toThrow();
      // workflowId改写也不能绕开(namespace,runId)唯一键。
      await expect(
        t.client.query(
          `insert into task_legacy_execution_admissions select $1::uuid,schema_version,task_id,namespace,workflow_id||':r2',run_id,workflow_type,task_queue,2,input_canonical,input_hash,admitted_at from task_legacy_execution_admissions`,
          [randomUUID()],
        ),
      ).rejects.toThrow();
    });
  });
}
