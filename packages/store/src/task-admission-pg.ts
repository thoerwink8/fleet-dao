import { randomUUID } from 'node:crypto';
import {
  taskLegacyExecutionAdmissions as admissions,
  auditLog,
  taskExecutionBirths as births,
  taskExecutionControls as controls,
  type Db,
  tasks,
  toTask,
} from '@fleet-dao/db';
import { and, asc, eq, or, sql } from 'drizzle-orm';
import type { NewAuditEntry } from './ports.ts';
import {
  admissionAudit,
  birthCanonical,
  executionInputHash,
  legacyMatchesTask,
  sameLegacyIdentity,
  validLegacyIdentity,
} from './task-admission-logic.ts';
import type {
  BirthResult,
  ExecutionBirthV1,
  LegacyExecutionAdmissionV1,
  ManagedTaskBirthV1,
  TaskAdmissionStore,
} from './task-execution.ts';
import { canonicalExecutionUuid } from './task-execution-logic.ts';

const birthOf = (row: typeof births.$inferSelect): ExecutionBirthV1 => {
  if (row.protocolVersion !== 1) throw new Error('出生协议版本未知');
  return { ...row, protocolVersion: 1, createdAt: row.createdAt.toISOString() };
};
const legacyOf = (row: typeof admissions.$inferSelect): LegacyExecutionAdmissionV1 => {
  if (row.schemaVersion !== 1) throw new Error('legacy准入版本未知');
  return { ...row, schemaVersion: 1, admittedAt: row.admittedAt.toISOString() };
};
async function writeAudit(tx: Db, entry: NewAuditEntry, at: Date): Promise<void> {
  const inserted = await tx
    .insert(auditLog)
    .values({
      at,
      actorKind: entry.actor.kind,
      actorId: entry.actor.id,
      action: entry.action,
      target: entry.target,
      before: null,
      after: entry.after,
      reason: entry.reason ?? null,
      via: entry.via,
      ok: true,
      error: null,
    })
    .returning({ id: auditLog.id });
  if (inserted.length !== 1) throw new Error('执行准入审计未写入');
}
/** 仅用于本事务确定的身份碰撞；抛出使已插入的task/control一并回滚。 */
class BirthConflict extends Error {}
export function pgTaskAdmission(db: Db, now: () => Date): TaskAdmissionStore {
  async function replay(tx: Db, input: ManagedTaskBirthV1, canonical: string): Promise<BirthResult | null> {
    const [row] = await tx.select().from(births).where(eq(births.birthRequestId, input.birthRequestId));
    if (!row) return null;
    if (row.birthInputCanonical !== canonical) return { kind: 'rejected', reason: 'identity_conflict' };
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, row.taskId));
    const [control] = await tx.select().from(controls).where(eq(controls.taskId, row.taskId));
    if (!task || !control || control.protocolVersion !== 1 || control.coverageEpoch !== row.coverageEpoch)
      throw new Error('出生记录缺少一致的任务或控制行');
    return {
      kind: 'replayed',
      task: toTask(task),
      control: { ...control, protocolVersion: 1 },
      birth: birthOf(row),
      postCommitWarnings: [],
    };
  }
  return {
    async createManagedTaskFromIssue(input, audit) {
      const canonical = birthCanonical(input);
      if (canonical === null) return { kind: 'rejected', reason: 'invalid_identity' };
      // 事务等待期间调用方仍可修改自己的对象；持久字段只取已核验的私有快照。
      input = JSON.parse(canonical) as ManagedTaskBirthV1;
      audit = structuredClone(audit);
      try {
        return await db.transaction(async (tx): Promise<BirthResult> => {
          const previous = await replay(tx, input, canonical);
          if (previous) return previous;
          const at = now();
          const [created] = await tx
            .insert(tasks)
            .values({
              ...input.task,
              priority: sql`(select coalesce(max(${tasks.priority}), 0) + 1 from ${tasks} where ${tasks.repoId} = ${input.task.repoId})`,
              createdAt: at,
            })
            .onConflictDoNothing()
            .returning();
          if (!created) {
            // INSERT等待竞争者提交之后再读request；同请求完整相同才是重放。
            const raced = await replay(tx, input, canonical);
            if (raced) return raced;
            const matches = await tx
              .select()
              .from(tasks)
              .where(
                or(
                  eq(tasks.id, input.task.id),
                  and(eq(tasks.repoId, input.task.repoId), eq(tasks.issueNumber, input.task.issueNumber)),
                ),
              );
            const existing = matches.find((row) => row.id === input.task.id) ?? matches[0];
            if (!existing) throw new Error('出生任务唯一冲突后没有持久行');
            return {
              kind: 'rejected',
              reason:
                existing.id === input.task.id &&
                (existing.repoId !== input.task.repoId || existing.issueNumber !== input.task.issueNumber)
                  ? 'identity_conflict'
                  : 'existing_task_forbidden',
            };
          }
          const [control] = await tx
            .insert(controls)
            .values({
              taskId: created.id,
              protocolVersion: 1,
              coverageEpoch: input.coverageEpoch,
              revision: 0,
              currentOperationId: null,
            })
            .returning();
          if (!control) throw new Error('出生控制行未写入');
          const [birth] = await tx
            .insert(births)
            .values({
              taskId: created.id,
              protocolVersion: 1,
              birthRequestId: input.birthRequestId,
              coverageEpoch: input.coverageEpoch,
              namespace: input.namespace,
              workflowType: input.workflowType,
              taskQueue: input.taskQueue,
              birthInputCanonical: canonical,
              birthInputHash: executionInputHash(canonical),
              createdAt: at,
            })
            .onConflictDoNothing()
            .returning();
          if (!birth) throw new BirthConflict('出生请求身份冲突');
          await writeAudit(
            tx,
            admissionAudit(
              'birth',
              created.id,
              {
                birthRequestId: birth.birthRequestId,
                coverageEpoch: birth.coverageEpoch,
                namespace: birth.namespace,
                workflowType: birth.workflowType,
                taskQueue: birth.taskQueue,
                inputHash: birth.birthInputHash,
              },
              audit,
              at.toISOString(),
            ),
            at,
          );
          return {
            kind: 'created',
            task: toTask(created),
            control: { ...control, protocolVersion: 1 },
            birth: birthOf(birth),
            postCommitWarnings: [],
          };
        });
      } catch (error) {
        if (error instanceof BirthConflict) return { kind: 'rejected', reason: 'identity_conflict' };
        throw error;
      }
    },
    async getExecutionBirth(taskId) {
      if (!canonicalExecutionUuid(taskId)) return null;
      const [row] = await db.select().from(births).where(eq(births.taskId, taskId));
      return row ? birthOf(row) : null;
    },
    async admitLegacyExecution(input, audit) {
      if (!validLegacyIdentity(input)) return { kind: 'rejected', reason: 'invalid_identity' };
      input = structuredClone(input);
      audit = structuredClone(audit);
      return db.transaction(async (tx) => {
        const [task] = await tx.select().from(tasks).where(eq(tasks.id, input.taskId)).for('update');
        if (!task) return { kind: 'rejected', reason: 'not_found' };
        const [control] = await tx
          .select()
          .from(controls)
          .where(eq(controls.taskId, input.taskId))
          .for('update');
        if (control) return { kind: 'rejected', reason: 'managed_requires_operation' };
        if (!legacyMatchesTask(input, task)) return { kind: 'rejected', reason: 'identity_conflict' };
        const key = and(eq(admissions.namespace, input.namespace), eq(admissions.runId, input.runId));
        const [existing] = await tx.select().from(admissions).where(key);
        if (existing)
          return sameLegacyIdentity(legacyOf(existing), input)
            ? { kind: 'replayed', admission: legacyOf(existing), postCommitWarnings: [] }
            : { kind: 'rejected', reason: 'identity_conflict' };
        const at = now();
        const [created] = await tx
          .insert(admissions)
          .values({
            id: randomUUID(),
            schemaVersion: 1,
            taskId: input.taskId,
            namespace: input.namespace,
            workflowId: input.workflowId,
            runId: input.runId,
            workflowType: input.workflowType,
            taskQueue: input.taskQueue,
            generation: input.generation,
            operation: input.operation,
            inputCanonical: input.inputCanonical,
            inputHash: input.inputHash,
            admittedAt: at,
          })
          .onConflictDoNothing()
          .returning();
        if (!created) {
          const [raced] = await tx.select().from(admissions).where(key);
          if (!raced) throw new Error('legacy唯一冲突后没有持久行');
          return sameLegacyIdentity(legacyOf(raced), input)
            ? { kind: 'replayed', admission: legacyOf(raced), postCommitWarnings: [] }
            : { kind: 'rejected', reason: 'identity_conflict' };
        }
        await writeAudit(
          tx,
          admissionAudit(
            'legacy_admit',
            task.id,
            {
              admissionId: created.id,
              namespace: input.namespace,
              workflowId: input.workflowId,
              runId: input.runId,
              generation: input.generation,
              operation: input.operation,
              inputHash: input.inputHash,
            },
            audit,
            at.toISOString(),
          ),
          at,
        );
        return { kind: 'admitted', admission: legacyOf(created), postCommitWarnings: [] };
      });
    },
    async listLegacyExecutionAdmissions(taskId) {
      if (!canonicalExecutionUuid(taskId)) return [];
      return (
        await db.select().from(admissions).where(eq(admissions.taskId, taskId)).orderBy(asc(admissions.id))
      ).map(legacyOf);
    },
  };
}
