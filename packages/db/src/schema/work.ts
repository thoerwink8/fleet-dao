// 干活的记录：仓、需求、子任务、会话、叫停请求、进度、追问、人闸批准、状态变化、PR 镜像、需求文档索引。
import type { FlowMode, FlowSource, TaskExecutor, VerifyRejectClass } from '@fleet-dao/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
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
    /** 这张单走哪种流程（#2823）：three = 三步单，full = 模型全程；老单、还没分过组的是空。分组的来龙去脉在 task_flow_assignments。 */
    flowMode: text('flow_mode').$type<FlowMode>(),
  },
  (t) => [
    unique('tasks_repo_issue_unique').on(t.repoId, t.issueNumber),
    check('tasks_issue_number_positive', sql`${t.issueNumber} > 0`),
    check('tasks_executor_known', sql`${t.executor} in ('engine', 'local')`),
    check('tasks_flow_mode_known', sql`${t.flowMode} is null or ${t.flowMode} in ('three', 'full')`),
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

/**
 * PR 的头改了哪些文件、各增删几行（#3140）：引擎推分支成功后，按推上去的头现算 `git diff --numstat <主线>...<头>` 写进来
 * （键是仓、PR、头、路径）。任务页「已编辑 N 个文件 +x −y」读最新那个头的这几行，不拿每次编辑的行数加起来。
 * 二进制文件 git 不给行数：binary 为真、added / removed 为空。一个头一次写全（同键冲突跳过，重放不重复）；
 * 单个头最多记 500 个文件，超了 truncated 那一行不另建，页面按「记了 N 个」写（引擎写之前截断并在日志里说明）。
 * 推的时候没数成不写这张表：页面写「没读到」，不拿 0 顶。
 */
export const prHeadFiles = pgTable(
  'pr_head_files',
  {
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id),
    prNumber: integer('pr_number').notNull(),
    headSha: text('head_sha').notNull(),
    path: text('path').notNull(),
    /** 新增、删除的行数；二进制文件为空。 */
    added: integer('added'),
    removed: integer('removed'),
    binary: boolean('binary').notNull().default(false),
    recordedAt: timestamp('recorded_at', tz).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pr_head_files_pk', columns: [t.repoId, t.prNumber, t.headSha, t.path] }),
    check('pr_head_files_head_sha_shape', sql`${t.headSha} ~ '^[0-9a-f]{40}$'`),
    check('pr_head_files_number_positive', sql`${t.prNumber} > 0`),
    check(
      'pr_head_files_lines_nonneg',
      sql`(${t.added} is null or ${t.added} >= 0) and (${t.removed} is null or ${t.removed} >= 0)`,
    ),
    // 二进制没有行数、文本一定有
    check(
      'pr_head_files_binary_shape',
      sql`(${t.binary} and ${t.added} is null and ${t.removed} is null) or (not ${t.binary} and ${t.added} is not null and ${t.removed} is not null)`,
    ),
    index('pr_head_files_pr_idx').on(t.repoId, t.prNumber),
  ],
);

/**
 * 一轮动手怎么结束的（#2762）：引擎任务工作流每一轮收场时写一行（patched('round-outcome')），每日简报的「流程健康」按它算。
 * merged 做成；verify_rejected 冷验收拒；ci_red CI 红（含等合并时必过检查红）；leftover 交活树里有剩；no_commit 没提交（含推的时候空交付）；
 * push_conflict 推分支并主线冲突；merge_conflict 等 CI、等合并时和主线冲突；timeout 超时停下后被放弃；stopped 放弃、叫停；other 别的（卫生检查拦下……）。
 * 同一条工作流里第几次收场（seq）只记一行：活动重试不重复写。
 */
export const ROUND_OUTCOMES = [
  'merged',
  'verify_rejected',
  'ci_red',
  'leftover',
  'no_commit',
  'push_conflict',
  'merge_conflict',
  'timeout',
  'stopped',
  'other',
] as const;
export type RoundOutcome = (typeof ROUND_OUTCOMES)[number];

export const taskRounds = pgTable(
  'task_rounds',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id),
    workflowId: text('workflow_id').notNull(),
    /** 这条工作流里第几次收场（从 1 起）：「继续」后轮数会从 0 再计，round 会重复，seq 不会。 */
    seq: integer('seq').notNull(),
    /** 工作流里的轮数（动手第几轮；「继续」后从 0 再计）。 */
    round: integer('round').notNull(),
    outcome: text('outcome').$type<RoundOutcome>().notNull(),
    /** 派工档（fast / medium / heavyweight）；判不出是空。 */
    tier: text('tier'),
    /** 这一轮第一个派上的模型；一个会话都没派上是空。 */
    firstModel: text('first_model'),
    /** 收场时 PR 相对主线的新增行数（最近一次推上去的头）；还没推过、没量成是空。 */
    addedLines: integer('added_lines'),
    endedAt: timestamp('ended_at', tz).notNull().defaultNow(),
    /** 这一轮属于哪种流程（#2823）；还没记流程的老行、老写法是空。 */
    flowMode: text('flow_mode').$type<FlowMode>(),
    /**
     * 冷验收拒绝的分类（#2823）：只在人工审过之后填，所以默认空。real_defect 真实缺陷、verifier_false_reject 验收误拒、
     * incomplete_spec 需求不全、infra 基础设施。名单和 shared 的 VERIFY_REJECT_CLASSES 一字不差。
     */
    verifyRejectClass: text('verify_reject_class').$type<VerifyRejectClass>(),
    /**
     * 这一轮开始的时刻（#3140，工作流的时钟）：回合视图的起点。老行为空，页面退回这一轮第一笔会话的起跑时刻。
     */
    startedAt: timestamp('started_at', tz),
    /**
     * 这一轮为什么返工、下一轮要改什么（#3140，≤500 字）：返工意见的头一截（CI 失败摘要、验收问题、没提交……）。
     * 做成了（merged）、放弃叫停、老行为空。页面在下一回合顶上写它。
     */
    reworkSummary: text('rework_summary'),
  },
  (t) => [
    unique('task_rounds_workflow_seq_unique').on(t.workflowId, t.seq),
    check(
      'task_rounds_rework_summary_short',
      sql`${t.reworkSummary} is null or char_length(${t.reworkSummary}) <= 500`,
    ),
    check('task_rounds_flow_mode_known', sql`${t.flowMode} is null or ${t.flowMode} in ('three', 'full')`),
    check(
      'task_rounds_verify_reject_class_known',
      sql`${t.verifyRejectClass} is null or ${t.verifyRejectClass} in ('real_defect', 'verifier_false_reject', 'incomplete_spec', 'infra')`,
    ),
    // 名单和 ROUND_OUTCOMES 一字不差（test/task-rounds.test.ts 核对）
    check(
      'task_rounds_outcome_known',
      sql`${t.outcome} in ('merged', 'verify_rejected', 'ci_red', 'leftover', 'no_commit', 'push_conflict', 'merge_conflict', 'timeout', 'stopped', 'other')`,
    ),
    check('task_rounds_seq_positive', sql`${t.seq} > 0`),
    check('task_rounds_round_nonneg', sql`${t.round} >= 0`),
    check('task_rounds_added_lines_nonneg', sql`${t.addedLines} is null or ${t.addedLines} >= 0`),
    index('task_rounds_ended_at_idx').on(t.endedAt),
  ],
);

/**
 * 验收责任（#3037）：冷验收判「不归我验」的验收条（要截图、现场、线上数据、审计结果才判得了）转给人以后，留在这里的那一份账。
 * 代码照合（决定 0093：不归我验不挡合并闸），可单子要等这里每一行都记了「最终验收完成」才许关：引擎收尾照它留着原单。
 * 一行 = 一张单在某个 PR 的某个头上转给人的那几条；没有代码的协调验收责任（长期协调单、无代码单）pr_number 记 0、head 记空串，
 * 不要求为它开空 PR。挂在任务行上（不跟着租约、执行方走）：本机租约收回、退回法国、合并、引擎重启都不丢。
 * 同一张单同一 PR 同一个头只一行（重复转交、合并回执重来都落在同一行）；只进不删，验完的记 settled_* 三列。
 */
export const acceptanceDuties = pgTable(
  'acceptance_duties',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id),
    /** owner/name 原样：合并、重启之后不靠别的表也看得出是哪个仓的哪张单。 */
    repo: text('repo').notNull(),
    issueNumber: integer('issue_number').notNull(),
    /** 哪个 PR 上验出来的；0 = 协调验收责任，没有 PR。 */
    prNumber: integer('pr_number').notNull().default(0),
    /** 验的哪个头（完整 sha）；协调验收责任是空串。 */
    head: text('head').notNull().default(''),
    /** 新增待验项时递增，最终验收只认现读的这一代。 */
    generation: integer('generation').notNull().default(1),
    /** 原验收项：验收方判「不归我验」的那几条原文。 */
    items: text('items').array().notNull(),
    /** cold_verify = 冷验收转人；coordination = 协调验收责任（没有代码）。 */
    source: text('source').notNull().default('cold_verify'),
    /** 合并回执：PR 合进主线的那个提交；还没合、或没有 PR 是空。 */
    mergeCommit: text('merge_commit'),
    mergedAt: timestamp('merged_at', tz),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    /** 最终验收完成的时刻、谁验的、凭什么（证据原文或链接）：三样一起写，空 = 还开着。 */
    settledAt: timestamp('settled_at', tz),
    settledBy: text('settled_by'),
    settleEvidence: text('settle_evidence'),
  },
  (t) => [
    unique('acceptance_duties_task_pr_head_unique').on(t.taskId, t.prNumber, t.head),
    check('acceptance_duties_issue_positive', sql`${t.issueNumber} > 0`),
    check('acceptance_duties_pr_nonneg', sql`${t.prNumber} >= 0`),
    check('acceptance_duties_items_nonempty', sql`cardinality(${t.items}) > 0`),
    check('acceptance_duties_source_known', sql`${t.source} in ('cold_verify', 'coordination')`),
    check(
      'acceptance_duties_settled_complete',
      sql`(${t.settledAt} is null and ${t.settledBy} is null and ${t.settleEvidence} is null) or (${t.settledAt} is not null and ${t.settledBy} is not null and length(${t.settleEvidence}) > 0)`,
    ),
    index('acceptance_duties_open_idx').on(t.taskId).where(sql`${t.settledAt} is null`),
  ],
);

/**
 * 全程模式的分组记录（#2823）：每张单最多一行，写一次不覆盖（task_id 是主键，再写直接撞唯一约束，由查询函数换成明确的错）。
 * source：label 标签指定、hash 按单号哈希、ineligible 不合格退回三段（reason 写原因）。stratum 是分层用的档位。
 */
export const taskFlowAssignments = pgTable(
  'task_flow_assignments',
  {
    taskId: uuid('task_id')
      .primaryKey()
      .references(() => tasks.id),
    mode: text('mode').$type<FlowMode>().notNull(),
    source: text('source').$type<FlowSource>().notNull(),
    stratum: text('stratum').notNull(),
    assignedAt: timestamp('assigned_at', tz).notNull().defaultNow(),
    reason: text('reason'),
  },
  (t) => [
    check('task_flow_assignments_mode_known', sql`${t.mode} in ('three', 'full')`),
    check('task_flow_assignments_source_known', sql`${t.source} in ('label', 'hash', 'ineligible')`),
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
