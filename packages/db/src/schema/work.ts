// 干活的记录：仓、需求、子任务、会话、叫停请求、进度、追问、人闸批准、状态变化、PR 镜像、需求文档索引。
import type { RunAsUser } from '@fleet-dao/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { routes } from './catalog.ts';
import {
  prChecks,
  progressKind,
  prState,
  RUN_AS_USERS,
  runOutcome,
  stageKind,
  stateEntity,
  subtaskState,
  taskState,
} from './enums.ts';

const tz = { withTimezone: true, mode: 'date' } as const;

export const repos = pgTable(
  'repos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    defaultBranch: text('default_branch').notNull().default('main'),
    testCommand: text('test_command').notNull(),
    /**
     * 自动派活开关（design 第九节「在哪能做与仓级开关」）：打开的时刻，空 = 关着。关着只收单、显示；
     * 打开以前就开着的 issue 也不自动派，要人点「交给 fleet」。
     */
    autoDispatchSince: timestamp('auto_dispatch_since', tz),
  },
  (t) => [unique('repos_owner_name_unique').on(t.owner, t.name)],
);

/** 需求：一张 GitHub issue 一行。 */
export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id),
    issueNumber: integer('issue_number').notNull(),
    title: text('title').notNull(),
    rawRequest: text('raw_request').notNull(),
    requestedBy: text('requested_by').notNull(),
    state: taskState('state').notNull().default('queued'),
    priority: integer('priority').notNull(),
    specDir: text('spec_dir'),
    /** 做完标准，引擎从需求文档写进来（fleet task 要给会话看）。 */
    acceptance: text('acceptance').array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    /** 引擎工作流此刻在哪个大阶段（分诊、写方案、执行……），白话见 doing。 */
    phase: text('phase'),
    /** 正在做什么的白话，例如「等第 2 个子任务的 CI」。 */
    doing: text('doing'),
    docs: jsonb('docs')
      .$type<{ requirement?: string; plan?: string; result?: string }>()
      .notNull()
      .default({}),
    /** 最近一次卡住或失败的白话原因；顺利推进时清空。 */
    lastProblem: text('last_problem'),
    /** 由 saveTaskSnapshot 显式写；从没做过快照的任务是空，不是「没变化」。 */
    updatedAt: timestamp('updated_at', tz),
  },
  (t) => [
    unique('tasks_repo_issue_unique').on(t.repoId, t.issueNumber),
    check('tasks_issue_number_positive', sql`${t.issueNumber} > 0`),
  ],
);

/** 子任务只在引擎里，不开 issue。依赖关系在 subtask_deps。 */
export const subtasks = pgTable(
  'subtasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id),
    index: integer('index').notNull(),
    title: text('title').notNull(),
    touches: text('touches').array().notNull().default(sql`'{}'::text[]`),
    state: subtaskState('state').notNull().default('pending'),
    prNumber: integer('pr_number'),
    waitingOn: text('waiting_on'),
    /** 方案里的子任务编号（人看的，例如 login-form），fleet 命令和引擎按它认子任务。 */
    key: text('key'),
    workflowId: text('workflow_id'),
    /** 人闸标记（release / spend / delete……）；非空 = 合并前要人批。 */
    holds: text('holds').array().notNull().default(sql`'{}'::text[]`),
    /** 重拆方案时旧子任务标这个时刻，不删（已有 session_runs 引用删不掉）；非空 = 已作废，读的地方要跳过。 */
    supersededAt: timestamp('superseded_at', tz),
  },
  (t) => [
    // 部分唯一：重拆方案时新子任务会和旧的撞 index，旧子任务标了作废就不算数了。
    uniqueIndex('subtasks_task_index_unique').on(t.taskId, t.index).where(sql`${t.supersededAt} is null`),
    // 给组合外键用：依赖和会话引用的子任务必须属于同一个需求。
    unique('subtasks_task_id_id_unique').on(t.taskId, t.id),
  ],
);

/** 子任务依赖。只能依赖同一个需求里的子任务；指向不存在的子任务会被拒，不会让子任务永远「等依赖」。 */
export const subtaskDeps = pgTable(
  'subtask_deps',
  {
    taskId: uuid('task_id').notNull(),
    subtaskId: uuid('subtask_id').notNull(),
    dependsOnId: uuid('depends_on_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.subtaskId, t.dependsOnId] }),
    foreignKey({
      name: 'subtask_deps_subtask_fk',
      columns: [t.taskId, t.subtaskId],
      foreignColumns: [subtasks.taskId, subtasks.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'subtask_deps_depends_on_fk',
      columns: [t.taskId, t.dependsOnId],
      foreignColumns: [subtasks.taskId, subtasks.id],
    }).onDelete('cascade'),
    check('subtask_deps_not_self', sql`${t.subtaskId} <> ${t.dependsOnId}`),
  ],
);

/**
 * 一次 AI 会话。排队和干活分开计时：queue_ms = 开始干活（没开始就被叫停则取结束）− 排进队列，run_ms = 结束 − 开始干活。
 * 两个时长由库算，不许写。token、花费不知道就是空，不记 0。
 * 帅位会话、考新模型的会话不属于任何需求（task_id 为空），照样记、照样占账号池并发。
 */
export const sessionRuns = pgTable(
  'session_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id').references(() => tasks.id),
    subtaskId: uuid('subtask_id'),
    stage: stageKind('stage').notNull(),
    routeId: text('route_id')
      .notNull()
      .references(() => routes.id),
    whyRoute: text('why_route').notNull(),
    /** 会话干活的分支。 */
    branch: text('branch'),
    queuedAt: timestamp('queued_at', tz).notNull().defaultNow(),
    startedAt: timestamp('started_at', tz),
    endedAt: timestamp('ended_at', tz),
    outcome: runOutcome('outcome'),
    actualModel: text('actual_model'),
    inputTokens: bigint('input_tokens', { mode: 'number' }),
    outputTokens: bigint('output_tokens', { mode: 'number' }),
    costUsd: numeric('cost_usd', { precision: 14, scale: 6, mode: 'number' }),
    queueMs: bigint('queue_ms', { mode: 'number' }).generatedAlwaysAs(
      sql`(extract(epoch from (coalesce(started_at, ended_at) - queued_at)) * 1000)::bigint`,
    ),
    runMs: bigint('run_ms', { mode: 'number' }).generatedAlwaysAs(
      sql`(extract(epoch from (ended_at - started_at)) * 1000)::bigint`,
    ),
    /** 执行体自己的会话编号（续会话用）。 */
    sessionId: text('session_id'),
    workflowId: text('workflow_id'),
    /** 这次会话跑在哪个系统用户下（引擎按池挑，从不切号）。 */
    runAsUser: text('run_as_user').$type<RunAsUser>(),
    worktreePath: text('worktree_path'),
    /** 起出来的会话进程在哪（插头的 onSpawn 报上来的），工人重启后看守和收尾靠它找回旧会话。 */
    handle: jsonb('handle').$type<{ pid?: number; scope?: string }>(),
    /** 插头判定的失败原因（quota_exhausted、model_mismatch……）或 SESSION_LOST 之类的结构化码。 */
    failureCode: text('failure_code'),
    /** 白话失败详情，写入时截到 2000 字。 */
    failureMessage: text('failure_message'),
    /** 这次会话对选路账本算胜负：ok 记一胜、fail 记一败、neutral 不进战绩（叫停、环境问题）。 */
    routeOutcome: text('route_outcome').$type<'ok' | 'fail' | 'neutral'>(),
    /** 执行体报的会话累计花费（续会话时含前几轮），对账用；不知道就是空，不记 0。 */
    sessionCostUsd: numeric('session_cost_usd', { precision: 14, scale: 6, mode: 'number' }),
    contextTokens: bigint('context_tokens', { mode: 'number' }),
  },
  (t) => [
    foreignKey({
      name: 'session_runs_subtask_in_task_fk',
      columns: [t.taskId, t.subtaskId],
      foreignColumns: [subtasks.taskId, subtasks.id],
    }),
    // 给组合外键用：追问挂的会话必须属于同一个需求。
    unique('session_runs_task_id_id_unique').on(t.taskId, t.id),
    // 组合外键遇到空值不查，所以要单独拦：写了子任务就必须写它所属的需求。
    check('session_runs_subtask_needs_task', sql`${t.subtaskId} is null or ${t.taskId} is not null`),
    // 结束了就必须有结局，有结局就必须已结束：不许出现「结束了但不知道怎么样」的行。
    check('session_runs_outcome_iff_ended', sql`(${t.endedAt} is null) = (${t.outcome} is null)`),
    check(
      'session_runs_started_after_queued',
      sql`${t.startedAt} is null or ${t.startedAt} >= ${t.queuedAt}`,
    ),
    check(
      'session_runs_ended_after_start',
      sql`${t.endedAt} is null or ${t.endedAt} >= coalesce(${t.startedAt}, ${t.queuedAt})`,
    ),
    check(
      'session_runs_usage_nonneg',
      sql`coalesce(${t.inputTokens}, 0) >= 0 and coalesce(${t.outputTokens}, 0) >= 0 and coalesce(${t.costUsd}, 0) >= 0 and coalesce(${t.sessionCostUsd}, 0) >= 0 and coalesce(${t.contextTokens}, 0) >= 0`,
    ),
    check(
      'session_runs_run_as_user_known',
      sql`${t.runAsUser} is null or ${t.runAsUser} in (${sql.raw(RUN_AS_USERS.map((u) => `'${u}'`).join(', '))})`,
    ),
    check(
      'session_runs_route_outcome_known',
      sql`${t.routeOutcome} is null or ${t.routeOutcome} in ('ok', 'fail', 'neutral')`,
    ),
    index('session_runs_task_idx').on(t.taskId, t.queuedAt),
    // 在途会话（还没结束的）按路由查，算账号池的并发。
    index('session_runs_open_idx').on(t.routeId).where(sql`${t.endedAt} is null`),
    index('session_runs_session_id_idx').on(t.sessionId),
  ],
);

/** 叫停一次会话的请求：可能早于 session_runs 那一行插入（起会话的活动还没返回时工作流只知道 runId），不设外键。 */
export const sessionStops = pgTable('session_stops', {
  runId: uuid('run_id').primaryKey(),
  requestedAt: timestamp('requested_at', tz).notNull().defaultNow(),
  reason: text('reason').notNull(),
});

/** 会话过程中的一条进度或动作。只追加。 */
export const progressEvents = pgTable(
  'progress_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    runId: uuid('run_id')
      .notNull()
      .references(() => sessionRuns.id),
    at: timestamp('at', tz).notNull().defaultNow(),
    kind: progressKind('kind').notNull(),
    payload: jsonb('payload'),
  },
  (t) => [
    index('progress_events_run_at_idx').on(t.runId, t.at),
    // plan 的 payload 是 { steps: Step[] }（和 fleet plan 的请求体同形）：写成别的形状，看板的进度条会静默变成 0/0。
    check(
      'progress_events_plan_has_steps',
      sql`${t.kind} <> 'plan' or coalesce(jsonb_typeof(${t.payload} -> 'steps') = 'array', false)`,
    ),
  ],
);

/**
 * 会话在任务里问创始人的话（fleet ask，一句最长 2000 字），回答来自驾驶舱、飞书或 issue 评论。
 * 同一会话问一模一样的一句只有一条：命令重试不会刷屏，写入用 on conflict (run_id, md5(question))。答过就不再改。
 */
export const asks = pgTable(
  'asks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id),
    runId: uuid('run_id'),
    question: text('question').notNull(),
    options: text('options').array().notNull().default(sql`'{}'::text[]`),
    askedAt: timestamp('asked_at', tz).notNull().defaultNow(),
    answer: text('answer'),
    /** 谁答的（actor id）。 */
    answeredBy: text('answered_by'),
    answeredAt: timestamp('answered_at', tz),
  },
  (t) => [
    foreignKey({
      name: 'asks_run_in_task_fk',
      columns: [t.taskId, t.runId],
      foreignColumns: [sessionRuns.taskId, sessionRuns.id],
    }),
    // 按问题的摘要去重，不直接在长文本上建唯一：一行索引放不下 900 多个汉字。
    uniqueIndex('asks_run_question_unique').on(t.runId, sql`md5(${t.question})`),
    check(
      'asks_answer_shape',
      sql`(${t.answer} is null) = (${t.answeredAt} is null) and (${t.answer} is null) = (${t.answeredBy} is null)`,
    ),
    index('asks_task_idx').on(t.taskId, t.askedAt),
  ],
);

/**
 * 人闸：请人批准这个子任务（或整个需求）进合并队列。批准 / 拒绝写一次，同一条 id 幂等；批过的头变了要另开一条。
 * decision 三列（decision、decided_by、decided_at）要么全空要么全有：不许出现「批了但不知道谁批的」。
 */
export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id),
    subtaskId: uuid('subtask_id'),
    /** 为什么要人批：release 对外发布、spend 花钱、delete 删数据（认不得的原样给人看）。 */
    holds: text('holds').array().notNull(),
    prNumber: integer('pr_number').notNull(),
    /** 批的是这个头；之后头变了（返工、解冲突）要重新批。 */
    head: text('head').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    requestedAt: timestamp('requested_at', tz).notNull().defaultNow(),
    decision: text('decision').$type<'approved' | 'rejected'>(),
    /** 谁批的 / 拒的（actor id）。 */
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', tz),
    reason: text('reason'),
  },
  (t) => [
    foreignKey({
      name: 'approvals_subtask_in_task_fk',
      columns: [t.taskId, t.subtaskId],
      foreignColumns: [subtasks.taskId, subtasks.id],
    }),
    check('approvals_pr_number_positive', sql`${t.prNumber} > 0`),
    check(
      'approvals_decision_shape',
      sql`(${t.decision} is null) = (${t.decidedBy} is null) and (${t.decision} is null) = (${t.decidedAt} is null)`,
    ),
    check(
      'approvals_decision_known',
      sql`${t.decision} is null or ${t.decision} in ('approved', 'rejected')`,
    ),
  ],
);

/**
 * 需求和子任务的每次状态变化，由触发器写（见迁移 0001），应用不用写也写不漏。
 * 回放和「进入当前状态多久了」从这里读，不靠 Temporal 历史（只留 30 天）。
 */
export const stateChanges = pgTable(
  'state_changes',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    entity: stateEntity('entity').notNull(),
    entityId: uuid('entity_id').notNull(),
    // 每个需求一建就有一行（触发器写的）；不级联的话任何需求都删不掉。
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    fromState: text('from_state'),
    toState: text('to_state').notNull(),
    at: timestamp('at', tz).notNull().defaultNow(),
  },
  (t) => [
    index('state_changes_task_at_idx').on(t.taskId, t.at),
    // 「最近一次变化」按写入先后取（id），不按时间戳。
    index('state_changes_entity_id_idx').on(t.entityId, t.id),
  ],
);

/** GitHub PR 的镜像：驾驶舱和 fleet done 的核实都从这里读，不直接查 GitHub。由 GitHub 事件与对账写。 */
export const pullRequests = pgTable(
  'pull_requests',
  {
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id),
    number: integer('number').notNull(),
    state: prState('state').notNull(),
    headRef: text('head_ref').notNull(),
    headSha: text('head_sha').notNull(),
    /** 当前 head 上 CI 的汇总；换了 head 要跟着重置。 */
    checks: prChecks('checks').notNull().default('none'),
    /** GitHub 上这条 PR 的最后更新时间。 */
    updatedAt: timestamp('updated_at', tz).notNull(),
    syncedAt: timestamp('synced_at', tz).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.repoId, t.number] }),
    check('pull_requests_number_positive', sql`${t.number} > 0`),
  ],
);

/** specs/<编号>-<短名>/ 的索引，给 fleet history 翻历史需求。目录名在 tasks.spec_dir，这里只放文件里的摘要。 */
export const specs = pgTable('specs', {
  taskId: uuid('task_id')
    .primaryKey()
    .references(() => tasks.id),
  /** 需求.md 的一句话摘要。 */
  summary: text('summary').notNull(),
  /** 结果.md 的摘要；还没做完就是空。 */
  resultSummary: text('result_summary'),
  mergedAt: timestamp('merged_at', tz),
  indexedAt: timestamp('indexed_at', tz).notNull().defaultNow(),
});
