import {
  auditLog,
  taskExecutionControls as controls,
  type Db,
  taskExecutionOperations as operations,
  tasks,
} from '@fleet-dao/db';
import { and, eq, or } from 'drizzle-orm';
import type {
  ExecutionAudit,
  ExecutionOperation,
  ExecutionRead,
  ExecutionResult,
  TaskExecutionStore,
} from './task-execution.ts';
import {
  canonicalExecutionUuid,
  type ExecutionAction,
  type ExecutionInput,
  planExecution,
  validExecutionIdentity,
} from './task-execution-logic.ts';

function operationOf(row: typeof operations.$inferSelect): ExecutionOperation {
  const { id, createdAt, updatedAt, dispatchedAt, admittedAt, resolvedAt, ...rest } = row;
  return {
    ...rest,
    operationId: id,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    dispatchedAt: dispatchedAt?.toISOString() ?? null,
    admittedAt: admittedAt?.toISOString() ?? null,
    resolvedAt: resolvedAt?.toISOString() ?? null,
  };
}
export function pgTaskExecution(db: Db, now: () => Date): TaskExecutionStore {
  async function readLocked(tx: Db, taskId: string): Promise<ExecutionRead> {
    const [task] = await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId)).for('update');
    if (!task) return { kind: 'not_found' };
    const [control] = await tx.select().from(controls).where(eq(controls.taskId, taskId)).for('update');
    if (!control) return { kind: 'unmanaged' };
    if (control.protocolVersion !== 1) throw new Error('执行资格协议版本未知');
    const [current] = control.currentOperationId
      ? await tx
          .select()
          .from(operations)
          .where(and(eq(operations.taskId, taskId), eq(operations.id, control.currentOperationId)))
          .for('update')
      : [];
    if (control.currentOperationId && !current) throw new Error('执行资格当前指针缺少操作记录');
    return {
      kind: 'managed',
      control: { ...control, protocolVersion: 1 },
      current: current ? operationOf(current) : null,
    };
  }
  async function mutate(
    action: ExecutionAction,
    input: ExecutionInput,
    audit: ExecutionAudit,
  ): Promise<ExecutionResult> {
    if (!validExecutionIdentity(input)) return { kind: 'rejected', reason: 'invalid_identity' };
    return db.transaction(async (tx) => {
      const read = await readLocked(tx, input.taskId);
      if (read.kind !== 'managed') return { kind: 'rejected', reason: read.kind };
      // 跨task的UUID碰撞只读判冲突，不获取外任务的operation锁。
      const [foreign] = await tx
        .select({ taskId: operations.taskId })
        .from(operations)
        .where(eq(operations.id, input.operationId));
      if (foreign && foreign.taskId !== input.taskId)
        return { kind: 'rejected', reason: 'identity_conflict' };
      const matches = await tx
        .select()
        .from(operations)
        .where(
          and(
            eq(operations.taskId, input.taskId),
            or(eq(operations.id, input.operationId), eq(operations.requestId, input.requestId)),
          ),
        )
        .for('update');
      if (matches.length > 1) return { kind: 'rejected', reason: 'identity_conflict' };
      const at = now().toISOString();
      const plan = planExecution(action, input, read, matches[0] ? operationOf(matches[0]) : null, audit, at);
      if (!plan.change) return plan.result;
      const { operation, control, audit: entry } = plan.change;
      const { operationId, createdAt, updatedAt, dispatchedAt, admittedAt, resolvedAt, ...rest } = operation;
      const values = {
        ...rest,
        id: operationId,
        createdAt: new Date(createdAt),
        updatedAt: new Date(updatedAt),
        dispatchedAt: dispatchedAt ? new Date(dispatchedAt) : null,
        admittedAt: admittedAt ? new Date(admittedAt) : null,
        resolvedAt: resolvedAt ? new Date(resolvedAt) : null,
      };
      if (action === 'reserve') {
        const inserted = await tx
          .insert(operations)
          .values(values)
          .onConflictDoNothing()
          .returning({ id: operations.id });
        if (inserted.length === 0) return { kind: 'rejected', reason: 'identity_conflict' };
      } else {
        const previous = matches[0];
        if (!previous) throw new Error('执行资格操作缺少原快照');
        const changed = await tx
          .update(operations)
          .set(values)
          .where(
            and(
              eq(operations.taskId, input.taskId),
              eq(operations.id, input.operationId),
              eq(operations.phase, previous.phase),
            ),
          )
          .returning({ id: operations.id });
        if (changed.length !== 1) throw new Error('执行资格操作CAS未写入');
      }
      const changed = await tx
        .update(controls)
        .set(control)
        .where(
          and(
            eq(controls.taskId, input.taskId),
            eq(controls.coverageEpoch, read.control.coverageEpoch),
            eq(controls.revision, read.control.revision),
          ),
        )
        .returning({ id: controls.taskId });
      if (changed.length !== 1) throw new Error('执行资格控制CAS未写入');
      const auditRows = await tx
        .insert(auditLog)
        .values({
          at: new Date(at),
          actorKind: entry.actor.kind,
          actorId: entry.actor.id,
          action: entry.action,
          target: entry.target,
          before: entry.before ?? null,
          after: entry.after ?? null,
          reason: entry.reason ?? null,
          via: entry.via,
          ok: true,
          error: null,
        })
        .returning({ id: auditLog.id });
      if (auditRows.length !== 1) throw new Error('执行资格审计未写入');
      return plan.result;
    });
  }
  return {
    getExecutionControl: async (taskId) =>
      canonicalExecutionUuid(taskId) ? db.transaction((tx) => readLocked(tx, taskId)) : { kind: 'not_found' },
    reserveExecution: (input, audit) => mutate('reserve', input, audit),
    dispatchExecution: (input, audit) => mutate('dispatch', input, audit),
    admitExecution: (input, audit) => mutate('admit', input, audit),
    resolveExecution: (input, audit) => mutate('resolve', input, audit),
  };
}
