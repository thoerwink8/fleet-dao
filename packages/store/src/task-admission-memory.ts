import { randomUUID } from 'node:crypto';
import type { Task } from '@fleet-dao/shared';
import type { MemoryData } from './memory-store.ts';
import {
  admissionAudit,
  birthCanonical,
  executionInputHash,
  legacyMatchesTask,
  sameLegacyIdentity,
  validLegacyIdentity,
} from './task-admission-logic.ts';
import type {
  AdmissionWarning,
  ExecutionBirthV1,
  ExecutionControl,
  LegacyExecutionAdmissionV1,
  TaskAdmissionStore,
} from './task-execution.ts';
import { canonicalExecutionUuid } from './task-execution-logic.ts';
import { nextTaskPriority } from './task-logic.ts';

export function memoryTaskAdmission(
  data: MemoryData,
  now: () => Date,
  nextId: () => string,
  notify: (table: 'tasks' | 'audit_log', id: string) => void,
): TaskAdmissionStore {
  // 通知在提交之后；订阅者异常不能把已提交的事务伪装成失败。
  const committed = (warnings: AdmissionWarning[], table: 'tasks' | 'audit_log', id: string) => {
    try {
      notify(table, id);
    } catch {
      warnings.push({ code: 'notification_failed', table, id });
    }
  };
  return {
    async createManagedTaskFromIssue(input, audit) {
      const canonical = birthCanonical(input);
      if (canonical === null) return { kind: 'rejected', reason: 'invalid_identity' };
      const existing = [...data.executionBirths.values()].find(
        (b) => b.birthRequestId === input.birthRequestId,
      );
      if (existing) {
        if (existing.birthInputCanonical !== canonical)
          return { kind: 'rejected', reason: 'identity_conflict' };
        const task = data.tasks.find((t) => t.id === existing.taskId);
        const control = data.executionControls.get(existing.taskId);
        if (!task || !control || control.coverageEpoch !== existing.coverageEpoch)
          throw new Error('出生记录缺少一致的任务或控制行');
        return structuredClone({ kind: 'replayed', task, control, birth: existing, postCommitWarnings: [] });
      }
      const idConflict = data.tasks.find((t) => t.id === input.task.id);
      if (
        idConflict &&
        (idConflict.repoId !== input.task.repoId || idConflict.issueNumber !== input.task.issueNumber)
      )
        return { kind: 'rejected', reason: 'identity_conflict' };
      if (
        idConflict ||
        data.tasks.some((t) => t.repoId === input.task.repoId && t.issueNumber === input.task.issueNumber)
      )
        return { kind: 'rejected', reason: 'existing_task_forbidden' };
      if (!data.repos.some((r) => r.id === input.task.repoId)) throw new Error('出生任务的仓不存在');
      const at = now().toISOString();
      const task: Task = {
        ...input.task,
        state: 'queued',
        priority: nextTaskPriority(
          data.tasks.filter((t) => t.repoId === input.task.repoId).map((t) => t.priority),
        ),
        acceptance: [],
        createdAt: at,
      };
      const control: ExecutionControl = {
        taskId: task.id,
        protocolVersion: 1,
        coverageEpoch: input.coverageEpoch,
        revision: 0,
        currentOperationId: null,
      };
      const birth: ExecutionBirthV1 = {
        taskId: task.id,
        protocolVersion: 1,
        birthRequestId: input.birthRequestId,
        coverageEpoch: input.coverageEpoch,
        namespace: input.namespace,
        workflowType: input.workflowType,
        taskQueue: input.taskQueue,
        birthInputCanonical: canonical,
        birthInputHash: executionInputHash(canonical),
        createdAt: at,
      };
      const entry = admissionAudit(
        'birth',
        task.id,
        {
          birthRequestId: birth.birthRequestId,
          coverageEpoch: birth.coverageEpoch,
          namespace: birth.namespace,
          workflowType: birth.workflowType,
          taskQueue: birth.taskQueue,
          inputHash: birth.birthInputHash,
        },
        audit,
        at,
      );
      // ID生成和所有副本构造均先完成，最后同步提交，没有await交错或失败点。
      const stateId = nextId();
      const auditId = nextId();
      const change = structuredClone({
        task,
        control,
        birth,
        audit: { ...entry, id: auditId, at },
        state: {
          id: stateId,
          entity: 'task' as const,
          entityId: task.id,
          taskId: task.id,
          to: task.state,
          at,
        },
      });
      const result = structuredClone({
        kind: 'created' as const,
        task,
        control,
        birth,
        postCommitWarnings: [] as AdmissionWarning[],
      });
      data.tasks.push(change.task);
      data.executionControls.set(task.id, change.control);
      data.executionBirths.set(task.id, change.birth);
      data.stateChanges.push(change.state);
      data.audit.push(change.audit);
      committed(result.postCommitWarnings, 'tasks', task.id);
      committed(result.postCommitWarnings, 'audit_log', auditId);
      return result;
    },
    async getExecutionBirth(taskId) {
      return canonicalExecutionUuid(taskId)
        ? structuredClone(data.executionBirths.get(taskId) ?? null)
        : null;
    },
    async admitLegacyExecution(input, audit) {
      if (!validLegacyIdentity(input)) return { kind: 'rejected', reason: 'invalid_identity' };
      const task = data.tasks.find((t) => t.id === input.taskId);
      if (!task) return { kind: 'rejected', reason: 'not_found' };
      if (data.executionControls.has(task.id))
        return { kind: 'rejected', reason: 'managed_requires_operation' };
      if (!legacyMatchesTask(input, task)) return { kind: 'rejected', reason: 'identity_conflict' };
      const existing = [...data.legacyExecutionAdmissions.values()].find(
        (a) => a.namespace === input.namespace && a.runId === input.runId,
      );
      if (existing)
        return sameLegacyIdentity(existing, input)
          ? structuredClone({ kind: 'replayed', admission: existing, postCommitWarnings: [] })
          : { kind: 'rejected', reason: 'identity_conflict' };
      const at = now().toISOString();
      const admission: LegacyExecutionAdmissionV1 = {
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
        id: randomUUID(),
        admittedAt: at,
      };
      const entry = admissionAudit(
        'legacy_admit',
        task.id,
        {
          admissionId: admission.id,
          namespace: input.namespace,
          workflowId: input.workflowId,
          runId: input.runId,
          generation: input.generation,
          operation: input.operation,
          inputHash: input.inputHash,
        },
        audit,
        at,
      );
      const id = nextId();
      const result = structuredClone({
        kind: 'admitted' as const,
        admission,
        postCommitWarnings: [] as AdmissionWarning[],
      });
      const stored = structuredClone(admission);
      const storedAudit = structuredClone({ ...entry, id, at });
      data.legacyExecutionAdmissions.set(admission.id, stored);
      data.audit.push(storedAudit);
      committed(result.postCommitWarnings, 'audit_log', id);
      return result;
    },
    async listLegacyExecutionAdmissions(taskId) {
      return canonicalExecutionUuid(taskId)
        ? structuredClone(
            [...data.legacyExecutionAdmissions.values()]
              .filter((a) => a.taskId === taskId)
              .sort((a, b) => a.id.localeCompare(b.id)),
          )
        : [];
    },
  };
}
