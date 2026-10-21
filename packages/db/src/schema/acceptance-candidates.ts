// 仅供候选读取的派生索引；验收状态和写授权仍以原责任和 shared 判法为准。
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { tasks } from './work.ts';

export const acceptanceCandidateGroups = pgTable(
  'acceptance_candidate_groups',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    prNumber: integer('pr_number').notNull(),
    revision: bigint('revision', { mode: 'number' }).notNull().default(1),
    dirty: boolean('dirty').notNull().default(true),
    hasOpen: boolean('has_open').notNull().default(false),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.prNumber] }),
    index('acceptance_candidate_dirty_idx')
      .on(t.lastAttemptAt.asc().nullsFirst(), t.taskId, t.prNumber)
      .where(sql`${t.dirty}`),
    index('acceptance_candidate_open_idx').on(t.taskId, t.prNumber).where(sql`${t.hasOpen}`),
  ],
);

export const acceptanceCandidateBootstrap = pgTable(
  'acceptance_candidate_bootstrap',
  {
    id: integer('id').primaryKey().default(1),
    semanticsVersion: integer('semantics_version').notNull(),
    cursorId: bigint('cursor_id', { mode: 'number' }).notNull().default(0),
    highWaterId: bigint('high_water_id', { mode: 'number' }).notNull(),
    ready: boolean('ready').notNull().default(false),
  },
  (t) => [check('acceptance_candidate_bootstrap_singleton', sql`${t.id} = 1`)],
);
