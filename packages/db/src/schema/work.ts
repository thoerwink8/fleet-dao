// 干活的记录：仓、需求、子任务、会话、叫停请求、进度、追问、人闸批准、状态变化、PR 镜像、需求文档索引。
import type { TaskExecutor } from '@fleet-dao/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { prChecks, prState, stateEntity, subtaskState, taskState } from './enums.ts';
import { runs } from './runs.ts';

const tz = { withTimezone: true, mode: 'date' } as const;

export const repos = pgTable(
  'repos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    defaultBranch: text('default_branch').notNull().default('main'),
    /**
     * 给人看的测试命令（建仓时先填个占位）。流程配置副本和从仓里的流程配置文件同步它的对账
     * 在 #556 一起删了，这一列现在只是展示，没有谁会自动改它。
     */
    testCommand: text('test_command').notNull(),
    /**
     * 自动派活开关（design 第九节「在哪能做与接活开关」）：打开的时刻，空 = 关着。关着只收单、显示；
     * 开着，引擎自己按依据挑单（开单时间不再比这个时刻，#1336）。
     */
    autoDispatchSince: timestamp('auto_dispatch_since', tz),
    /**
     * 合并时要不要等 CI、做冷验收。force = 强制（默认，已有的仓也是这个）；off = 不强制，
     * 引擎开完 PR 直接合并。随时能改，工作流每次走到等 CI 之前现读，不在拉单时定死。
     */
    ciPolicy: text('ci_policy').notNull().default('force'),
    /** GitHub 上这个仓的编号（REST 的 id）：仓改名、转主人照样认得（design 15.7 第 1 条）。老行没填是空。 */
    githubId: bigint('github_id', { mode: 'number' }),
    /**
     * 仓档案（#2738）：语言和工具链、测试命令、模块根、合并要等的检查、标准清单在哪、权重。存显式写了的项，
     * 形状和默认值见 shared 的 repo-profile.ts（读的人用 parseRepoProfile 补默认值）。经 fleet-api project set-profile 改。
     */
    profile: jsonb('profile').notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    unique('repos_owner_name_unique').on(t.owner, t.name),
    unique('repos_github_id_unique').on(t.githubId),
    check('repos_ci_policy_known', sql`${t.ciPolicy} in ('force', 'off')`),
  ],
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
    /**
     * 谁在做（决定 0096，shared 的 local-claims.ts）：engine = 法国引擎；local = 本机会话领的（经 /api/nodes/claims 登记）。
     * 状态仍只用引擎认的那几个：本机在做是 running，退回法国是 stopped + engine。引擎的统计、熔断、对账只数 engine 的行。
     */
    executor: text('executor').$type<TaskExecutor>().notNull().default('engine'),
    /** 本机领单的租约到哪一刻；不是本机在做的是空。 */
    leaseUntil: timestamp('lease_until', tz),
    /** 哪个环境领的（通行证认出的环境编号）；不是本机领的是空。 */
    claimedBy: text('claimed_by'),
  },
  (t) => [
    unique('tasks_repo_issue_unique').on(t.repoId, t.issueNumber),
    check('tasks_issue_number_positive', sql`${t.issueNumber} > 0`),
    check('tasks_executor_known', sql`${t.executor} in ('engine', 'local')`),
    index('tasks_local_lease_idx').on(t.leaseUntil).where(sql`${t.executor} = 'local'`),
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
    /** 重拆方案时旧子任务标这个时刻，不删（留着看历史）；非空 = 已作废，读的地方要跳过。 */
    supersededAt: timestamp('superseded_at', tz),
  },
  (t) => [
    // 部分唯一：重拆方案时新子任务会和旧的撞 index，旧子任务标了作废就不算数了。
    uniqueIndex('subtasks_task_index_unique').on(t.taskId, t.index).where(sql`${t.supersededAt} is null`),
    // 给组合外键用：依赖引用的子任务必须属于同一个需求。
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
 * 会话在任务里问创始人的话（fleet ask，一句最长 2000 字），回答来自驾驶舱、飞书或 issue 评论。
 * 同一会话问一模一样的一句只有一条：命令重试不会刷屏，写入用 on conflict (run_id, md5(question))。答过就不再改。
 * 问他不挡路（#259，判法在 core 的 ask.ts）：会话的提问带选项和推荐（scope 有值），当场按推荐先做、不等回答；
 * scope 是空的是引擎自己等人的（只有他本人才有的东西）和这之前的老提问。
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
    /** 推荐的那个选项：task、hold 两种当场照它先做。 */
    recommended: text('recommended'),
    /** task = 这张单范围内的岔路；outside = 超出这张单的范围（另开单）；hold = 碰了人闸四类（合并前等批）。 */
    scope: text('scope').$type<'task' | 'outside' | 'hold'>(),
    /** scope = hold 时碰的是哪一类：release 对外发布、spend 花钱、delete 删数据、standard 改标准。 */
    hold: text('hold').$type<'release' | 'spend' | 'delete' | 'standard'>(),
    /** 另开的单：超出范围的那张，或他改选了别的、原单已经合了开的后续单。 */
    followUpIssue: integer('follow_up_issue'),
    /** 他改选了别的，引擎在存档点交给主导照改的时刻。 */
    appliedAt: timestamp('applied_at', tz),
  },
  (t) => [
    foreignKey({
      name: 'asks_run_in_task_fk',
      columns: [t.taskId, t.runId],
      foreignColumns: [runs.taskId, runs.id],
    }),
    // 按问题的摘要去重，不直接在长文本上建唯一：一行索引放不下 900 多个汉字。
    uniqueIndex('asks_run_question_unique').on(t.runId, sql`md5(${t.question})`),
    check(
      'asks_answer_shape',
      sql`(${t.answer} is null) = (${t.answeredAt} is null) and (${t.answer} is null) = (${t.answeredBy} is null)`,
    ),
    check('asks_scope_known', sql`${t.scope} is null or ${t.scope} in ('task', 'outside', 'hold')`),
    // 带了范围的都是新问法：一定有推荐，推荐的一定在选项里（不拿空的冒充推荐）
    check(
      'asks_scoped_recommendation',
      sql`${t.scope} is null or (${t.recommended} is not null and ${t.recommended} = any(${t.options}))`,
    ),
    check('asks_hold_shape', sql`(${t.scope} is not distinct from 'hold') = (${t.hold} is not null)`),
    check(
      'asks_hold_known',
      sql`${t.hold} is null or ${t.hold} in ('release', 'spend', 'delete', 'standard')`,
    ),
    check('asks_applied_answered', sql`${t.appliedAt} is null or ${t.answer} is not null`),
    check('asks_follow_up_positive', sql`${t.followUpIssue} is null or ${t.followUpIssue} > 0`),
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
    // —— 下面几列给「提醒谁在处理」现算用（design 15.3）：PR 事件、对账补收都经同一处写（@fleet-dao/github 的 events.ts）。
    // 事件里没带正文、没带合并信息的（审计补合并那一路）不改它们：旧值留着，不拿空顶。
    /** GitHub 上开这个 PR 的时刻；没读到过是空。 */
    openedAt: timestamp('opened_at', tz),
    /** 合并的时刻、合进默认分支的那个提交（squash 的那一个）；没合、没读到是空。 */
    mergedAt: timestamp('merged_at', tz),
    mergeSha: text('merge_sha'),
    /** 正文挂的单：「需求」栏（没有再看标题）的 #号、关单词（Closes #号），同仓的；认法只有一处（conventions 的 linkedIssue）。 */
    issueRefs: integer('issue_refs').array().notNull().default(sql`'{}'::integer[]`),
    /** GitHub 上这个 PR 的标题；主页「做完的」没有任务记录（本机做的单）时用它。没读到过是空。 */
    title: text('title'),
    /** 正文「修提醒」栏写的提醒（键或编号）。 */
    alertRefs: text('alert_refs').array().notNull().default(sql`'{}'::text[]`),
  },
  (t) => [
    primaryKey({ columns: [t.repoId, t.number] }),
    check('pull_requests_number_positive', sql`${t.number} > 0`),
    check('pull_requests_merge_shape', sql`${t.mergeSha} is null or ${t.mergeSha} ~ '^[0-9a-f]{40}$'`),
    index('pull_requests_issue_refs_idx').using('gin', t.issueRefs),
    index('pull_requests_alert_refs_idx').using('gin', t.alertRefs),
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
