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
