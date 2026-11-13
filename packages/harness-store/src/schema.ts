// 新内核的表（决定 0124，#3773），全在独立 schema fleet2 里：不建跨 schema 外键、不写旧表。
// 事件表是唯一真相，投影表可以删了从事件重建；对外副作用只经 outbox。
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
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
    // 按单查这张单的外部动作（切回、状态页，#3783）
    index('outbox_task_idx').on(t.repo, t.issue, t.id),
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
    // 驾驶舱的批次列表按冻结时刻从新到老翻页（#3784）：沿这个索引一个时刻一个时刻地跳，读的行数跟批次数走，不扫整张表
    index('shadow_batch_items_snapshot_idx').on(t.snapshotAt, t.batchId),
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

/**
 * 真执行批次的清单（#3783，第 7 片）：和影子批次分开存（影子的驱动、波次图都只认 shadow_batch_items），冻结后不改。
 * 这几张单交给新内核真推分支、真开 PR（不合并）；基线是冻结那一刻的主线提交。
 */
export const realBatchItems = fleet2.table(
  'real_batch_items',
  {
    batchId: text('batch_id').notNull(),
    repo: text('repo').notNull(),
    issue: integer('issue').notNull(),
    baseSha: text('base_sha').notNull(),
    snapshotAt: timestamp('snapshot_at', tz).notNull(),
  },
  (t) => [
    unique('real_batch_items_unique').on(t.batchId, t.repo, t.issue),
    check('real_batch_items_sha', sql`${t.baseSha} ~ '^[0-9a-f]{40}$'`),
    // 按单找它在哪一批（切回、状态页）
    index('real_batch_items_task_idx').on(t.repo, t.issue, t.snapshotAt),
  ],
);

/**
 * 真执行一次的产物（#3783）：工人交回后抓到的补丁、拿的是哪个令牌、用的哪个模型、核验结论，以及要不要推。
 * state：ready 已排了 git.push；held 核验没过，不推（人看）；empty 没有改动，不推；released 单被切回旧系统，不再推。
 * 补丁存这里，outbox 的推送从这里取（载荷里只放 runId）。
 */
export const publishRuns = fleet2.table(
  'publish_runs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: text('run_id').notNull(),
    batchId: text('batch_id').notNull(),
    repo: text('repo').notNull(),
    issue: integer('issue').notNull(),
    baseSha: text('base_sha').notNull(),
    /** 派这件活时旧库 tasks.fencing 的值：外部动作的所有权令牌。 */
    fencing: bigint('fencing', { mode: 'number' }).notNull(),
    model: text('model').notNull(),
    title: text('title').notNull(),
    verdict: text('verdict').notNull(),
    patch: text('patch').notNull(),
    wallMs: integer('wall_ms').notNull(),
    branch: text('branch').notNull(),
    state: text('state').notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  },
  (t) => [
    unique('publish_runs_run_unique').on(t.runId),
    check('publish_runs_verdict_known', sql`${t.verdict} in ('unverified', 'passed', 'failed', 'unknown')`),
    check('publish_runs_state_known', sql`${t.state} in ('ready', 'held', 'empty', 'released')`),
    index('publish_runs_task_idx').on(t.repo, t.issue, t.id),
    index('publish_runs_batch_idx').on(t.batchId, t.repo, t.issue),
  ],
);

/**
 * 每个会话当前的工人状态（#3853 第 2 片）。事件往前推，窗口和判法跟 deriveWorkerState 同一份。
 * 卡住个数不扫这张表，读 worker_state_counts 里那一行。
 */
export const sessionWorkerState = fleet2.table(
  'session_worker_state',
  {
    streamId: text('stream_id').primaryKey(),
    state: text('state').notNull(),
    /** 还在跑、且这次启动写了截止时间。过了宽限又没有新事件时，读计数前改判卡住。 */
    deadline: timestamp('deadline', tz),
    /** 最近 TAIL_EVENTS 条瘦身事件，最旧在前。下一条折进来不用再读事件表。 */
    tail: jsonb('tail').notNull(),
    headSeq: integer('head_seq').notNull(),
    lastEventId: bigint('last_event_id', { mode: 'number' }).notNull(),
  },
  (t) => [
    check('session_worker_state_known', sql`${t.state} in ('stuck', 'running', 'waiting', 'done')`),
    // 到点改判：只沿还在跑、记了截止时间的行往下找，不扫全部会话
    index('session_worker_state_deadline_idx')
      .on(t.deadline)
      .where(sql`${t.state} = 'running' and ${t.deadline} is not null`),
  ],
);

/**
 * 四种工人状态各一行，记当前有几个会话。卡住个数只读 state = 'stuck' 这一行，
 * 读的行数不随会话数涨（整表最多四行）。
 */
export const workerStateCounts = fleet2.table(
  'worker_state_counts',
  {
    state: text('state').primaryKey(),
    n: integer('n').notNull(),
  },
  (t) => [
    check('worker_state_counts_known', sql`${t.state} in ('stuck', 'running', 'waiting', 'done')`),
    check('worker_state_counts_nonneg', sql`${t.n} >= 0`),
  ],
);

/** 还在跑的会话里最早的截止时间。计数前先看这一行：还没到就不用去碰会话表。 */
export const workerStateMeta = fleet2.table('worker_state_meta', {
  id: integer('id').primaryKey(),
  nextDeadline: timestamp('next_deadline', tz),
});

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

/**
 * ADE 工作区（#3914）：本机文件夹。forge 从 git remote 推，推不出就是 local。
 * 当前状态在表里（会被改）；发生了什么在事件流里。
 */
export const adeWorkspaces = fleet2.table(
  'ade_workspaces',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    path: text('path').notNull(),
    isGit: boolean('is_git').notNull(),
    forge: text('forge').notNull(),
    remote: text('remote'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    unique('ade_workspaces_path_unique').on(t.path),
    check('ade_workspaces_forge', sql`${t.forge} in ('github', 'gitlab', 'local')`),
  ],
);

/** ADE 自己的单。来源是手建或以后从平台导入；不依赖 GitHub 也能建。 */
export const adeTasks = fleet2.table(
  'ade_tasks',
  {
    id: integer('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    status: text('status').notNull().default('open'),
    source: jsonb('source').notNull(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [
    index('ade_tasks_workspace_idx').on(t.workspaceId, t.id),
    check('ade_tasks_status', sql`${t.status} in ('open', 'closed')`),
  ],
);

/** ADE 会话的当前状态。队列里是还没开跑的话；轮次过程在事件流和 transcript 流。 */
export const adeSessions = fleet2.table(
  'ade_sessions',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    parentId: text('parent_id'),
    taskId: integer('task_id'),
    agent: text('agent').notNull(),
    model: text('model').notNull(),
    worktree: boolean('worktree').notNull(),
    cwd: text('cwd').notNull(),
    title: text('title').notNull(),
    /** idle 没在跑；running 有一轮进程。 */
    status: text('status').notNull(),
    /** 人按了停：这一轮收掉后不自动把队列里的话开跑。 */
    hold: boolean('hold').notNull().default(false),
    queue: jsonb('queue').notNull().default(sql`'[]'::jsonb`),
    runId: text('run_id'),
    /** agent CLI 自己的会话号（Claude 要 UUID），追问时 --resume。 */
    agentSessionId: text('agent_session_id'),
    /** 远端 SSH 宿主的别名。空表示这一会话用本机 ProcessHost。 */
    hostAlias: text('host_alias'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  },
  (t) => [
    index('ade_sessions_workspace_idx').on(t.workspaceId),
    index('ade_sessions_parent_idx').on(t.parentId).where(sql`${t.parentId} is not null`),
    check('ade_sessions_status', sql`${t.status} in ('idle', 'running')`),
  ],
);

/**
 * 工作区上的一次性定时（#3929）。到点走和人手同一个 createSession。
 * 到期与否由调用方拿自己的钟和 run_at 比，不用数据库 now()，测试才能换钟。
 */
export const adeSchedules = fleet2.table(
  'ade_schedules',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    agent: text('agent').notNull(),
    model: text('model').notNull(),
    /** 到点交给 createSession 的那句话。 */
    prompt: text('prompt').notNull(),
    runAt: timestamp('run_at', tz).notNull(),
    /**
     * active 等点；paused 人停了；firing 正在建会话；
     * done 这一次已经建出会话；error 没建成，不再自动试。
     */
    status: text('status').notNull(),
    sessionId: text('session_id'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  },
  (t) => [
    index('ade_schedules_due_idx').on(t.runAt, t.id).where(sql`${t.status} = 'active'`),
    check('ade_schedules_status', sql`${t.status} in ('active', 'paused', 'firing', 'done', 'error')`),
  ],
);
