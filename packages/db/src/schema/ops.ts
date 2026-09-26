// 人与运维：成员、通知、操作记录、外部写操作的幂等键、收到的 GitHub 事件、Jev 判断记录、定时任务登记与每次跑的记录、设置。
// 「谁做的」统一记成 actor_kind + actor_id（人是用户 id，会话里的 AI 是会话 id……），和驾驶舱接口的 Actor 同形。
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
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
import {
  actorKind,
  auditVia,
  jevMode,
  jevQuestionType,
  jevTruthSource,
  notificationLevel,
  scheduleOutcome,
  userRole,
} from './enums.ts';
import { tasks } from './work.ts';

const tz = { withTimezone: true, mode: 'date' } as const;

/**
 * 成员：驾驶舱登录白名单，也是 GitHub 作者白名单。登录只认飞书 open_id / union_id（不认邮箱、手机号）；
 * GitHub 有数字编号就只按编号认（登录名可改、可被别人注册）。机器人不登录驾驶舱。
 * 另可用户名 + 密码登录（#120），白名单还是这张表。
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    displayName: text('display_name').notNull(),
    role: userRole('role').notNull(),
    active: boolean('active').notNull().default(true),
    avatarUrl: text('avatar_url'),
    feishuOpenId: text('feishu_open_id').unique(),
    feishuUnionId: text('feishu_union_id').unique(),
    /** 可以没有：创始人不需要 GitHub 账号。 */
    githubLogin: text('github_login'),
    githubId: bigint('github_id', { mode: 'number' }).unique(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    /** 账密登录的用户名：大小写不敏感地唯一（按 lower() 建的唯一索引）；没设过是空。 */
    username: text('username'),
    /** 加盐慢哈希，格式由 packages/api 的 password.ts 定；不存明文。没设过是空。 */
    passwordHash: text('password_hash'),
    passwordChangedAt: timestamp('password_changed_at', tz),
    /** 连续输错几次，登录成功清零；到上限记 locked_until，锁期内对的密码也不放。 */
    failedLogins: integer('failed_logins').notNull().default(0),
    lockedUntil: timestamp('locked_until', tz),
    /**
     * 会话版本：设密码、改密码、退出时加 1。会话 Cookie 里带着签发时的版本，对不上就作废——
     * 会话是自签 Cookie，不在库里，要让别处已登的会话失效只能靠这个。
     */
    sessionVersion: integer('session_version').notNull().default(0),
  },
  (t) => [
    uniqueIndex('users_username_lower_unique').on(sql`lower(${t.username})`),
    check('users_password_needs_username', sql`${t.passwordHash} is null or ${t.username} is not null`),
    check('users_failed_logins_nonneg', sql`${t.failedLogins} >= 0`),
  ],
);

/** 提醒中心。同一件事只有一条（dedupe_key），状态变了原地更新，不另发。 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    level: notificationLevel('level').notNull(),
    dedupeKey: text('dedupe_key').notNull().unique(),
    taskId: uuid('task_id').references(() => tasks.id),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    /** 点提醒直达的驾驶舱页面。 */
    link: text('link'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz)
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    resolvedAt: timestamp('resolved_at', tz),
    /** 谁处理掉的（actor id）。 */
    resolvedBy: text('resolved_by'),
  },
  (t) => [
    index('notifications_task_idx').on(t.taskId),
    index('notifications_open_idx').on(t.createdAt).where(sql`${t.resolvedAt} is null`),
  ],
);

/** 每条通知送到每个去处一行。拿到飞书 message_id 才算送到；卡片原地更新也靠它。 */
export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    notificationId: uuid('notification_id')
      .notNull()
      .references(() => notifications.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
    target: text('target').notNull(),
    messageId: text('message_id'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    lastAttemptAt: timestamp('last_attempt_at', tz),
    deliveredAt: timestamp('delivered_at', tz),
  },
  (t) => [
    unique('notification_deliveries_target_unique').on(t.notificationId, t.channel, t.target),
    check(
      'notification_deliveries_delivered_needs_message_id',
      sql`${t.deliveredAt} is null or ${t.messageId} is not null`,
    ),
    check('notification_deliveries_attempts_nonneg', sql`${t.attempts} >= 0`),
  ],
);

/** 操作记录：谁在什么时候、经哪里、对什么做了什么、为什么、成没成。只追加。 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    at: timestamp('at', tz).notNull().defaultNow(),
    actorKind: actorKind('actor_kind').notNull(),
    actorId: text('actor_id').notNull(),
    /** 例如 stage_policy.update、task.pause、login。 */
    action: text('action').notNull(),
    /** 例如 stage:execute、task:<id>、channel:cursor。 */
    target: text('target').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    reason: text('reason'),
    via: auditVia('via').notNull(),
    ok: boolean('ok').notNull().default(true),
    error: text('error'),
  },
  (t) => [
    check('audit_log_failure_has_error', sql`${t.ok} or ${t.error} is not null`),
    index('audit_log_at_idx').on(t.at),
    index('audit_log_target_idx').on(t.target, t.at),
  ],
);

/** 对 GitHub 等外部写操作防重复：先占键再写，写成了把回执记上；重放时直接拿回执。GitHub 事件的投递编号不在这里，在 github_events。 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    key: text('key').primaryKey(),
    action: text('action').notNull(),
    target: text('target'),
    claimedAt: timestamp('claimed_at', tz).notNull().defaultNow(),
    completedAt: timestamp('completed_at', tz),
    /** 写成后的回执（URL、编号……）。 */
    result: jsonb('result'),
  },
  (t) => [index('idempotency_keys_claimed_at_idx').on(t.claimedAt)],
);

/**
 * processing = 正在处理（进程死在半路也停在这）；accepted = 放进来、处理完；ignored = 按规矩不收；failed = 处理出错，等重投、
 * 补收或重放；waiting = 现在做不了、要等前一件事做完（重开时上一轮还没结束），每轮对账都重放，不占自动重放的次数。
 */
export const GITHUB_EVENT_STATUSES = ['processing', 'accepted', 'ignored', 'failed', 'waiting'] as const;
export const GITHUB_EVENT_SOURCES = ['webhook', 'poll', 'redelivery'] as const;

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/**
 * 收到的 GitHub 事件，一次投递一行：原文留着能重放，投递编号去重也靠它（design 第十四节「收 GitHub 事件」）。
 * 验签不过的不进这里：没认证的请求不许往库里写。它带着哪些对象的哪一版，记在 github_event_versions。
 */
export const githubEvents = pgTable(
  'github_events',
  {
    deliveryId: text('delivery_id').primaryKey(),
    event: text('event').notNull(),
    action: text('action'),
    source: text('source').notNull().$type<(typeof GITHUB_EVENT_SOURCES)[number]>(),
    /** owner/name，原样取自事件；没有仓的事件（安装类）为空。 */
    repo: text('repo'),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().$type<(typeof GITHUB_EVENT_STATUSES)[number]>(),
    /** 不收、出错的原因，等着的在等什么。 */
    reason: text('reason'),
    /** 放进来之后做了什么（建了任务、拉起了工作流、叫停……），给人查。 */
    note: text('note'),
    /** 算自动重放次数的处理次数：重投、重放、接管各加一；从「等着」接回来的不加（等上一轮不占次数）。 */
    attempts: integer('attempts').notNull().default(1),
    receivedAt: timestamp('received_at', tz).notNull().defaultNow(),
    /** 这次占用的时刻，也是记结局的凭据：接管会把它改新，旧的那次就记不上了。 */
    claimedAt: timestamp('claimed_at', tz).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', tz),
  },
  (t) => [
    check('github_events_status_known', sql`${t.status} in (${inList(GITHUB_EVENT_STATUSES)})`),
    check('github_events_source_known', sql`${t.source} in (${inList(GITHUB_EVENT_SOURCES)})`),
    // 不收、出错、等着都得写原因：不许出现「没处理，也不知道为什么」的行（空字符串也不算原因）。
    check(
      'github_events_reason_when_not_taken',
      sql`${t.status} not in ('ignored', 'failed', 'waiting') or coalesce(length(${t.reason}), 0) > 0`,
    ),
    check('github_events_finished_iff_done', sql`(${t.status} = 'processing') = (${t.finishedAt} is null)`),
    check('github_events_attempts_positive', sql`${t.attempts} > 0`),
    // 对账捞没处理成的：先捞次数少的。
    index('github_events_unfinished_idx')
      .on(t.attempts, t.receivedAt)
      .where(sql`${t.status} in ('processing', 'failed', 'waiting')`),
  ],
);

/**
 * 一次投递带着的每个对象的那一版：issue、评论、PR 各一行（评论事件同时带着被它顶新的 issue，审查类事件带着 PR）。
 * 两个用处：轮询补收时认出 webhook 收过的同一版，不再算漏收；issue 事件晚到或重放时，同一张 issue 有更新的一版
 * 已经处理过、开关状态又和这条不一样，这条旧的就不再做（旧的「重开」不会把后来关了的单又拉起来）。
 */
export const githubEventVersions = pgTable(
  'github_event_versions',
  {
    deliveryId: text('delivery_id')
      .notNull()
      .references(() => githubEvents.deliveryId, { onDelete: 'cascade' }),
    /** `<owner/name 小写>:<issue|comment|pull>:<编号>`。 */
    object: text('object').notNull(),
    /** 这个对象在 GitHub 上的 updated_at。 */
    version: timestamp('version', tz).notNull(),
    /** issue、PR 这一版开着还是关着；评论没有。 */
    state: text('state').$type<'open' | 'closed'>(),
  },
  (t) => [
    primaryKey({ columns: [t.deliveryId, t.object] }),
    check('github_event_versions_state_known', sql`${t.state} is null or ${t.state} in ('open', 'closed')`),
    index('github_event_versions_object_idx').on(t.object, t.version),
  ],
);

/** Jev 的题目。先只记不拦，攒够样本、准确率过线才改成真拦。 */
export const jevQuestions = pgTable(
  'jev_questions',
  {
    id: text('id').primaryKey(),
    /** 接在哪：triage / dedupe / spec-check / delivery-check …… */
    site: text('site').notNull(),
    prompt: text('prompt').notNull(),
    type: jevQuestionType('type').notNull(),
    options: text('options').array(),
    mode: jevMode('mode').notNull().default('shadow'),
    /** 把握度低于它 = 没判出来，走默认。 */
    confidenceLine: doublePrecision('confidence_line').notNull(),
    /** 钉死的模型版本。 */
    model: text('model').notNull(),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz)
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check(
      'jev_questions_choice_has_options',
      sql`(${t.type} = 'choice') = (${t.options} is not null and cardinality(${t.options}) >= 2)`,
    ),
    check('jev_questions_confidence_line_range', sql`${t.confidenceLine} between 0 and 1`),
    // 用 latest 别名，版本一漂准确率就不作数了。
    check('jev_questions_model_pinned', sql`${t.model} not ilike '%latest%'`),
  ],
);

/**
 * Jev 每次判断一行：样本、答案、把握度、这次是否只记不拦；事后的真值也记在这一行。
 * 没判出来（连不上、超时、答了题面外的选项）ok = false 并写原因，不当成「否」。
 */
export const jevAnswers = pgTable(
  'jev_answers',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    questionId: text('question_id')
      .notNull()
      .references(() => jevQuestions.id),
    askedAt: timestamp('asked_at', tz).notNull().defaultNow(),
    /** 判的是谁，例如 task:<id>、subtask:<id>、run:<id>。 */
    subject: text('subject').notNull(),
    /** 喂进去的输入，或能复原输入的引用（例如 issue 号 + updated_at），挑金丝雀题用。 */
    sample: jsonb('sample').notNull(),
    shadow: boolean('shadow').notNull(),
    ok: boolean('ok').notNull(),
    answer: text('answer'),
    confidence: doublePrecision('confidence'),
    failReason: text('fail_reason'),
    /** 实际响应的模型版本号。 */
    modelVersion: text('model_version'),
    latencyMs: integer('latency_ms'),
    inputTokens: integer('input_tokens'),
    truth: text('truth'),
    truthSource: jevTruthSource('truth_source'),
    truthBy: uuid('truth_by').references(() => users.id),
    truthAt: timestamp('truth_at', tz),
  },
  (t) => [
    check(
      'jev_answers_ok_shape',
      sql`case when ${t.ok} then ${t.answer} is not null and ${t.confidence} is not null and ${t.failReason} is null else ${t.answer} is null and ${t.failReason} is not null end`,
    ),
    check('jev_answers_confidence_range', sql`${t.confidence} is null or ${t.confidence} between 0 and 1`),
    check('jev_answers_truth_shape', sql`(${t.truth} is null) = (${t.truthSource} is null)`),
    index('jev_answers_question_idx').on(t.questionId, t.askedAt),
  ],
);

/**
 * 该跑的定时任务登记在这里（引擎启动时按代码里的声明写入）。看门狗和驾驶舱按这张表逐个查：
 * 一次都没跑过的任务在 schedule_runs 里没有行，只按那张表查就永远看不见它。
 */
export const scheduledJobs = pgTable(
  'scheduled_jobs',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** 给人看的计划，例如「每 15 分钟」「每天 03:00」。 */
    schedule: text('schedule').notNull(),
    /** 上次成功距今超过这么多分钟就算过期。要大于「周期 + 抖动 + 一轮耗时」，否则每轮开头都误报。 */
    expectEveryMinutes: integer('expect_every_minutes').notNull(),
  },
  (t) => [check('scheduled_jobs_expect_every_positive', sql`${t.expectEveryMinutes} > 0`)],
);

/**
 * 定时任务每跑一次一行。还在跑时 outcome 为空。结局的四种写法见 domain.ts 的 ScheduleOutcome：
 * 「查了、0 个问题」是 ok（scanned > 0、found = 0），「一个都没扫到」是 unscanned（scanned = 0），两者不许混写；
 * 不是 ok 的都要写原因。
 */
export const scheduleRuns = pgTable(
  'schedule_runs',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    job: text('job')
      .notNull()
      .references(() => scheduledJobs.id),
    startedAt: timestamp('started_at', tz).notNull().defaultNow(),
    endedAt: timestamp('ended_at', tz),
    outcome: scheduleOutcome('outcome'),
    scanned: integer('scanned'),
    found: integer('found'),
    why: text('why'),
  },
  (t) => [
    check('schedule_runs_outcome_iff_ended', sql`(${t.endedAt} is null) = (${t.outcome} is null)`),
    check(
      'schedule_runs_ok_scanned_something',
      sql`${t.outcome} is distinct from 'ok' or (${t.scanned} > 0 and ${t.found} is not null)`,
    ),
    check(
      'schedule_runs_unscanned_is_zero',
      sql`${t.outcome} is distinct from 'unscanned' or coalesce(${t.scanned}, 0) = 0`,
    ),
    check(
      'schedule_runs_not_ok_has_why',
      sql`${t.outcome} is null or ${t.outcome} = 'ok' or ${t.why} is not null`,
    ),
    check(
      'schedule_runs_counts_nonneg',
      sql`coalesce(${t.scanned}, 0) >= 0 and coalesce(${t.found}, 0) >= 0`,
    ),
    index('schedule_runs_job_started_idx').on(t.job, t.startedAt),
  ],
);

/**
 * 每次活动尝试、每段工作流层面的等待，看门狗和驾驶舱的耗时图表按它画。不设 task_id / subtask_id 外键：
 * 计时不能因为任务行还没建就丢。活动重试会重复写同一笔，靠部分唯一索引去重，不当错误。
 */
export const stepTimings = pgTable(
  'step_timings',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    kind: text('kind').notNull().$type<'activity' | 'wait'>(),
    workflowId: text('workflow_id').notNull(),
    temporalRunId: text('temporal_run_id').notNull(),
    workflowType: text('workflow_type').notNull(),
    taskId: uuid('task_id'),
    subtaskId: uuid('subtask_id'),
    subtaskKey: text('subtask_key'),
    /** activity 行必填。 */
    activity: text('activity'),
    attempt: integer('attempt'),
    /** wait 行必填：等什么（deps / slot / quota / human……）。 */
    waitFor: text('wait_for'),
    detail: text('detail'),
    scheduledAt: timestamp('scheduled_at', tz),
    startedAt: timestamp('started_at', tz).notNull(),
    endedAt: timestamp('ended_at', tz).notNull(),
    queueMs: bigint('queue_ms', { mode: 'number' }),
    runMs: bigint('run_ms', { mode: 'number' }),
    waitMs: bigint('wait_ms', { mode: 'number' }),
    outcome: text('outcome').$type<'ok' | 'failed' | 'cancelled'>(),
    errorCode: text('error_code'),
    recordedAt: timestamp('recorded_at', tz).notNull().defaultNow(),
  },
  (t) => [
    check('step_timings_kind_known', sql`${t.kind} in ('activity', 'wait')`),
    check('step_timings_ended_after_started', sql`${t.endedAt} >= ${t.startedAt}`),
    check(
      'step_timings_activity_shape',
      sql`${t.kind} <> 'activity' or (${t.activity} is not null and ${t.attempt} is not null and ${t.scheduledAt} is not null and ${t.queueMs} is not null and ${t.runMs} is not null and ${t.outcome} is not null)`,
    ),
    check(
      'step_timings_wait_shape',
      sql`${t.kind} <> 'wait' or (${t.waitFor} is not null and ${t.waitMs} is not null)`,
    ),
    check(
      'step_timings_outcome_known',
      sql`${t.outcome} is null or ${t.outcome} in ('ok', 'failed', 'cancelled')`,
    ),
    check(
      'step_timings_ms_nonneg',
      sql`coalesce(${t.queueMs}, 0) >= 0 and coalesce(${t.runMs}, 0) >= 0 and coalesce(${t.waitMs}, 0) >= 0`,
    ),
    // 活动重试会重复写同一笔（同一次尝试），去重不当错误；wait 行同理（返工时会重新等同一件事，靠 started_at 区分不同的那一次）。
    uniqueIndex('step_timings_activity_unique')
      .on(t.workflowId, t.temporalRunId, t.activity, t.attempt, t.scheduledAt)
      .where(sql`${t.kind} = 'activity'`),
    uniqueIndex('step_timings_wait_unique')
      .on(t.workflowId, t.temporalRunId, t.waitFor, t.startedAt)
      .where(sql`${t.kind} = 'wait'`),
    index('step_timings_task_started_idx').on(t.taskId, t.startedAt),
  ],
);

/** 全局设置（主题色、免打扰时段……）。version 每改一次加 1，改的时候带上看到的版本，防两人同时改互相覆盖。 */
export const settings = pgTable(
  'settings',
  {
    key: text('key').primaryKey(),
    value: jsonb('value').notNull(),
    version: integer('version').notNull().default(1),
    updatedAt: timestamp('updated_at', tz)
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    /** 谁改的（actor id）。 */
    updatedBy: text('updated_by'),
  },
  (t) => [check('settings_version_positive', sql`${t.version} > 0`)],
);
