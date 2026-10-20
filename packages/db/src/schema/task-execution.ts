// 持久执行资格；没有控制行的旧任务保持未受管，不据任务镜像自动补资格。

import { MAX_TASK_GENERATION } from '@fleet-dao/shared/task-redo';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { tasks } from './work.ts';

const tz = { withTimezone: true, mode: 'date' } as const;
export const taskExecutionOperations = pgTable(
  'task_execution_operations',
  {
    id: uuid('id').primaryKey(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id),
    coverageEpoch: uuid('coverage_epoch').notNull(),
    revision: bigint('revision', { mode: 'number' }).notNull(),
    requestId: uuid('request_id').notNull(),
    nodeId: text('node_id').notNull(),
    kind: text('kind').$type<'start' | 'redo'>().notNull(),
    namespace: text('namespace').notNull(),
    workflowId: text('workflow_id').notNull(),
    generation: integer('generation').notNull(),
    workflowType: text('workflow_type').notNull(),
    inputHash: text('input_hash').notNull(),
    phase: text('phase').$type<'reserved' | 'dispatching' | 'admitted' | 'resolved'>().notNull(),
    admittedRunId: text('admitted_run_id'),
    resolvedReason: text('resolved_reason').$type<'cancelled_before_dispatch'>(),
    createdAt: timestamp('created_at', tz).notNull(),
    updatedAt: timestamp('updated_at', tz).notNull(),
    dispatchedAt: timestamp('dispatched_at', tz),
    admittedAt: timestamp('admitted_at', tz),
    resolvedAt: timestamp('resolved_at', tz),
  },
  (t) => [
    unique('task_execution_operations_task_id_id_unique').on(t.taskId, t.id),
    unique('task_execution_operations_current_identity').on(t.taskId, t.id, t.coverageEpoch, t.revision),
    unique('task_execution_operations_request_unique').on(t.taskId, t.requestId),
    unique('task_execution_operations_revision_unique').on(t.taskId, t.revision),
    uniqueIndex('task_execution_operations_one_active').on(t.taskId).where(sql`${t.phase} <> 'resolved'`),
    check('task_execution_operations_revision_safe', sql`${t.revision} between 1 and 9007199254740991`),
    check(
      'task_execution_operations_generation_range',
      sql`${t.generation} between 1 and ${sql.raw(String(MAX_TASK_GENERATION))}`,
    ),
    check(
      'task_execution_operations_identity_nonempty',
      sql`length(btrim(${t.nodeId})) > 0 and length(btrim(${t.namespace})) > 0 and length(btrim(${t.workflowId})) > 0 and length(btrim(${t.workflowType})) > 0 and length(btrim(${t.inputHash})) > 0`,
    ),
    check('task_execution_operations_kind_known', sql`${t.kind} in ('start', 'redo')`),
    check(
      'task_execution_operations_phase_fields',
      sql`
    (${t.phase} = 'reserved' and ${t.admittedRunId} is null and ${t.resolvedReason} is null and ${t.dispatchedAt} is null and ${t.admittedAt} is null and ${t.resolvedAt} is null)
    or (${t.phase} = 'dispatching' and ${t.admittedRunId} is null and ${t.resolvedReason} is null and ${t.dispatchedAt} is not null and ${t.admittedAt} is null and ${t.resolvedAt} is null)
    or (${t.phase} = 'admitted' and length(btrim(${t.admittedRunId})) > 0 and ${t.admittedRunId} is not null and ${t.dispatchedAt} is not null and ${t.admittedAt} is not null and ${t.resolvedReason} is null and ${t.resolvedAt} is null)
    or (${t.phase} = 'resolved' and ${t.resolvedReason} = 'cancelled_before_dispatch' and ${t.resolvedReason} is not null and ${t.resolvedAt} is not null and ${t.admittedRunId} is null and ${t.dispatchedAt} is null and ${t.admittedAt} is null)`,
    ),
  ],
);

export const taskExecutionControls = pgTable(
  'task_execution_controls',
  {
    taskId: uuid('task_id')
      .primaryKey()
      .references(() => tasks.id),
    protocolVersion: integer('protocol_version').notNull(),
    coverageEpoch: uuid('coverage_epoch').notNull(),
    revision: bigint('revision', { mode: 'number' }).notNull(),
    currentOperationId: uuid('current_operation_id'),
  },
  (t) => [
    unique('task_execution_controls_task_epoch_unique').on(t.taskId, t.coverageEpoch),
    check('task_execution_controls_protocol_known', sql`${t.protocolVersion} = 1`),
    check('task_execution_controls_revision_safe', sql`${t.revision} between 0 and 9007199254740991`),
    foreignKey({
      name: 'task_execution_controls_current_identity',
      columns: [t.taskId, t.currentOperationId, t.coverageEpoch, t.revision],
      foreignColumns: [
        taskExecutionOperations.taskId,
        taskExecutionOperations.id,
        taskExecutionOperations.coverageEpoch,
        taskExecutionOperations.revision,
      ],
    }),
  ],
);

/** 不回填旧任务。canonical 仅供私有存储核对，不能复制到审计或公开日志。 */
export const taskExecutionBirths = pgTable(
  'task_execution_births',
  {
    taskId: uuid('task_id').primaryKey(),
    protocolVersion: integer('protocol_version').notNull(),
    birthRequestId: uuid('birth_request_id').notNull().unique(),
    coverageEpoch: uuid('coverage_epoch').notNull(),
    namespace: text('namespace').notNull(),
    workflowType: text('workflow_type').$type<'taskWorkflow'>().notNull(),
    taskQueue: text('task_queue').notNull(),
    birthInputCanonical: text('birth_input_canonical').notNull(),
    birthInputHash: text('birth_input_hash').notNull(),
    createdAt: timestamp('created_at', tz).notNull(),
  },
  (t) => [
    foreignKey({
      name: 'task_execution_births_control_identity',
      columns: [t.taskId, t.coverageEpoch],
      foreignColumns: [taskExecutionControls.taskId, taskExecutionControls.coverageEpoch],
    }),
    check('task_execution_births_protocol_known', sql`${t.protocolVersion} = 1`),
    check(
      'task_execution_births_identity_valid',
      sql`length(btrim(${t.namespace})) > 0 and ${t.workflowType} = 'taskWorkflow' and length(btrim(${t.taskQueue})) > 0 and length(btrim(${t.birthInputCanonical})) > 0 and ${t.birthInputHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

/** 每个精确 run 的持久责任，不用单任务唯一约束把旧系统改造成并发限流。 */
export const taskLegacyExecutionAdmissions = pgTable(
  'task_legacy_execution_admissions',
  {
    id: uuid('id').primaryKey(),
    schemaVersion: integer('schema_version').notNull(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id),
    namespace: text('namespace').notNull(),
    workflowId: text('workflow_id').notNull(),
    runId: uuid('run_id').notNull(),
    workflowType: text('workflow_type').$type<'taskWorkflow'>().notNull(),
    taskQueue: text('task_queue').notNull(),
    generation: integer('generation').notNull(),
    inputCanonical: text('input_canonical').notNull(),
    inputHash: text('input_hash').notNull(),
    admittedAt: timestamp('admitted_at', tz).notNull(),
  },
  (t) => [
    unique('task_legacy_execution_admissions_run_unique').on(t.namespace, t.runId),
    check('task_legacy_execution_admissions_schema_known', sql`${t.schemaVersion} = 1`),
    check(
      'task_legacy_execution_admissions_generation_range',
      sql`${t.generation} between 1 and ${sql.raw(String(MAX_TASK_GENERATION))}`,
    ),
    check(
      'task_legacy_execution_admissions_identity_valid',
      sql`length(btrim(${t.namespace})) > 0 and length(btrim(${t.workflowId})) > 0 and ${t.workflowType} = 'taskWorkflow' and length(btrim(${t.taskQueue})) > 0 and length(btrim(${t.inputCanonical})) > 0 and ${t.inputHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);
