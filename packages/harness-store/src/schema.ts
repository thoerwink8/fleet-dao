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
    // 按流取新事件、取最后一条（驾驶舱读会话，#3818）：读的行数跟一页成正比
    index('events_stream_id_idx').on(t.streamId, t.id),
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

/**
 * 会话令牌（#3775）：只存哈希，不存明文；一个令牌只绑一个会话、一个角色。
 * revoked_at 非空即作废，开着的连接下一次核验时被关掉。
 */
export const sessionTokens = fleet2.table(
  'session_tokens',
  {
    id: text('id').primaryKey(),
    tokenHash: text('token_hash').notNull(),
    sessionId: text('session_id').notNull(),
    role: text('role').notNull(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', tz),
  },
  (t) => [
    unique('session_tokens_hash_unique').on(t.tokenHash),
    check('session_tokens_role_known', sql`${t.role} in ('commander', 'worker')`),
    index('session_tokens_session_idx').on(t.sessionId),
  ],
);

/**
 * 影子比对的批次清单（#3776）：冻结那一刻每张单的基线提交，新旧两边都从它起。冻结后不改，改了就另起一批。
 */
export const shadowBatchItems = fleet2.table(
  'shadow_batch_items',
  {
    batchId: text('batch_id').notNull(),
    repo: text('repo').notNull(),
    issue: integer('issue').notNull(),
    baseSha: text('base_sha').notNull(),
    snapshotAt: timestamp('snapshot_at', tz).notNull(),
  },
  (t) => [
    unique('shadow_batch_items_unique').on(t.batchId, t.repo, t.issue),
    check('shadow_batch_items_sha', sql`${t.baseSha} ~ '^[0-9a-f]{40}$'`),
  ],
);

/** 影子跑一次的产物：补丁只留在这里，不推、不开 PR，任何自动流程不消费它。 */
export const shadowRuns = fleet2.table(
  'shadow_runs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: text('run_id').notNull(),
    batchId: text('batch_id').notNull(),
    repo: text('repo').notNull(),
    issue: integer('issue').notNull(),
    baseSha: text('base_sha').notNull(),
    /** 交回核验的四态（harness-dispatch 的 verify）。 */
    verdict: text('verdict').notNull(),
    patch: text('patch').notNull(),
    wallMs: integer('wall_ms').notNull(),
    tokens: integer('tokens'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    unique('shadow_runs_run_unique').on(t.runId),
    check('shadow_runs_verdict_known', sql`${t.verdict} in ('unverified', 'passed', 'failed', 'unknown')`),
    index('shadow_runs_batch_idx').on(t.batchId, t.id),
  ],
);

/** 旧 PR 合并后拿合并 diff 给影子补丁评的分；旧的结果永远是权威，这里只记差多少。 */
export const shadowCompare = fleet2.table(
  'shadow_compare',
  {
    shadowRunId: bigint('shadow_run_id', { mode: 'number' }).primaryKey(),
    batchId: text('batch_id').notNull(),
    mergedPr: integer('merged_pr').notNull(),
    mergedSha: text('merged_sha').notNull(),
    /** compareDiffs 的结果：文件重合、改动行重合、两边各自多改的文件。 */
    score: jsonb('score').notNull(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [index('shadow_compare_batch_idx').on(t.batchId, t.shadowRunId)],
);

/** 第一个投影：每条流走到第几条、最后一条是什么类型。拿它证明「删了重建结果一致」。 */
export const streamHeads = fleet2.table(
  'stream_heads',
  {
    streamId: text('stream_id').primaryKey(),
    headSeq: integer('head_seq').notNull(),
    lastType: text('last_type').notNull(),
    events: integer('events').notNull(),
    /** 这条流最后一条事件的 events.id 和时刻（#3818）：驾驶舱会话列表按它倒序分页。 */
    lastEventId: bigint('last_event_id', { mode: 'number' }).notNull(),
    lastAt: timestamp('last_at', tz).notNull(),
  },
  (t) => [
    // 会话列表：只看 session:* 的流，按最后事件倒序
    index('stream_heads_session_last_idx')
      .on(t.lastEventId.desc())
      .where(sql`${t.streamId} like 'session:%'`),
  ],
);
