// 新内核的表（决定 0124，#3773），全在独立 schema fleet2 里：不建跨 schema 外键、不写旧表。
// 事件表是唯一真相，投影表可以删了从事件重建；对外副作用只经 outbox。
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

export const fleet2 = pgSchema('fleet2');
const tz = { withTimezone: true, mode: 'date' } as const;

/** 事件：同一条流的 seq 从 1 连续往上，(stream_id, seq) 唯一挡住并发追加。先落库后广播。 */
export const events = fleet2.table(
  'events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    streamId: text('stream_id').notNull(),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    unique('events_stream_seq_unique').on(t.streamId, t.seq),
    check('events_seq_positive', sql`${t.seq} > 0`),
  ],
);

/** 命令回执：同一个幂等键只做一次，重放回原结果；同键异命令拒。 */
export const commandReceipts = fleet2.table('command_receipts', {
  key: text('key').primaryKey(),
  command: text('command').notNull(),
  result: jsonb('result').notNull(),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
});

/**
 * 外部动作（至少一次投递）。state：
 * pending 等着做；claimed 有人领着（lease_until 前别人不领）；done 做成并查证过；
 * unknown 发出去了但结果不知道（超时、断线），只能先查证不能盲重试；dead 重试到顶或令牌对不上，进人工。
 */
export const outbox = fleet2.table(
  'outbox',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    opKey: text('op_key').notNull(),
    kind: text('kind').notNull(),
    repo: text('repo').notNull(),
    issue: integer('issue').notNull(),
    fencing: bigint('fencing', { mode: 'number' }).notNull(),
    payload: jsonb('payload').notNull(),
    state: text('state').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAt: timestamp('next_at', tz).notNull().defaultNow(),
    leaseUntil: timestamp('lease_until', tz),
    claimToken: text('claim_token'),
    result: jsonb('result'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  },
  (t) => [
    unique('outbox_op_key_unique').on(t.opKey),
    check('outbox_state_known', sql`${t.state} in ('pending', 'claimed', 'done', 'unknown', 'dead')`),
    check(
      'outbox_claim_fields',
      sql`(${t.state} = 'claimed') = (${t.leaseUntil} is not null and ${t.claimToken} is not null)`,
    ),
    index('outbox_due_idx').on(t.nextAt).where(sql`${t.state} in ('pending', 'unknown')`),
  ],
);

/** 投影走到事件表的哪一条（按 events.id）。删了投影，这里清零重放。 */
export const projectionCheckpoints = fleet2.table('projection_checkpoints', {
  name: text('name').primaryKey(),
  lastEventId: bigint('last_event_id', { mode: 'number' }).notNull(),
  updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
});

/**
 * 调度器的活（#3774，决定 0124 第 3 条：不用 Temporal，自建）。一行一件到点要做的事：定时、重试、续轮都是它。
 * state：pending 等到点；claimed 有人领着（续租靠心跳）；done 做完；cancelled 被取消（领着的人下次心跳就知道）；dead 重试到顶。
 * deadline_at 是绝对截止时刻：子活继承父活的，自己只能更早；过了截止还没做完的不再领、直接 dead。
 */
export const jobs = fleet2.table(
  'jobs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    queue: text('queue').notNull(),
    key: text('key').notNull(),
    /** 父活的 key：取消父活时一路取消下去；截止时刻不晚于父活。 */
    parentKey: text('parent_key'),
    payload: jsonb('payload').notNull(),
    state: text('state').notNull().default('pending'),
    dueAt: timestamp('due_at', tz).notNull().defaultNow(),
    deadlineAt: timestamp('deadline_at', tz),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    leaseUntil: timestamp('lease_until', tz),
    claimToken: text('claim_token'),
    claimedAt: timestamp('claimed_at', tz),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  },
  (t) => [
    unique('jobs_key_unique').on(t.key),
    check('jobs_state_known', sql`${t.state} in ('pending', 'claimed', 'done', 'cancelled', 'dead')`),
    check(
      'jobs_claim_fields',
      sql`(${t.state} = 'claimed') = (${t.leaseUntil} is not null and ${t.claimToken} is not null)`,
    ),
    check('jobs_attempts_range', sql`${t.attempts} >= 0 and ${t.maxAttempts} >= 1`),
    index('jobs_due_idx').on(t.queue, t.dueAt).where(sql`${t.state} = 'pending'`),
    index('jobs_lease_idx').on(t.leaseUntil).where(sql`${t.state} = 'claimed'`),
    index('jobs_claimed_at_idx').on(t.queue, t.claimedAt),
    index('jobs_parent_idx').on(t.parentKey).where(sql`${t.parentKey} is not null`),
  ],
);

/** 每个队列的限速：同时在领的上限、每分钟新领的上限。停机后积压一起到期时靠它限住追赶速度。没有行的队列不让领。 */
export const queueLimits = fleet2.table(
  'queue_limits',
  {
    queue: text('queue').primaryKey(),
    maxInflight: integer('max_inflight').notNull(),
    perMinute: integer('per_minute').notNull(),
  },
  (t) => [check('queue_limits_positive', sql`${t.maxInflight} > 0 and ${t.perMinute} > 0`)],
);

/** 第一个投影：每条流走到第几条、最后一条是什么类型。拿它证明「删了重建结果一致」。 */
export const streamHeads = fleet2.table('stream_heads', {
  streamId: text('stream_id').primaryKey(),
  headSeq: integer('head_seq').notNull(),
  lastType: text('last_type').notNull(),
  events: integer('events').notNull(),
});
