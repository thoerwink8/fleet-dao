// 人与运维：成员、通知、操作记录、外部写操作的幂等键、Jev 判断记录、定时任务登记与每次跑的记录、设置。
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
  text,
  timestamp,
  unique,
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
 */
export const users = pgTable('users', {
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
});

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

/** 对 GitHub 等外部写操作防重复：先占键再写，写成了把回执记上；重放时直接拿回执。GitHub 事件的投递编号也记在这里。 */
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
