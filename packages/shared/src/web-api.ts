// 驾驶舱前端（packages/web）⇄ 驾驶舱后端（packages/api）的接口约定：请求与返回的形状。两边都照这份实现。
// 认证：飞书登录后拿到 HttpOnly 会话 Cookie；写操作（POST/PUT/PATCH/DELETE）另带请求头 `X-CSRF-Token`，值来自 GET /api/me。
// fleet 令牌（agent-api.ts）在这里一律被拒。
// 改这里之前：后端对每个返回都按这份 parse（多余字段会被剥掉），前端也照它解析；字段增删两边要一起改。
import { z } from 'zod';
import type {
  BillingKind,
  HostId,
  ProgressKind,
  QuotaStatus,
  QuotaUnit,
  QuotaWindowKind,
  ReadingKind,
  RunOutcome,
  ScheduleOutcome,
  StageKind,
  StepState,
  SubtaskState,
  TaskState,
} from './domain.ts';
import { type ChangeEvent, REALTIME_TABLES } from './realtime.ts';

export const WEB_API_PREFIX = '/api';
export const AUTH_PREFIX = '/auth';
export const CSRF_HEADER = 'X-CSRF-Token';

/**
 * 飞书网关调 /api 的第二种进法（不用 Cookie、不用 CSRF）：`Authorization: Bearer <网关通行证>`，
 * 再用这个请求头写明代表哪位创始人（飞书 open_id）。后端按 open_id 认人，不是创始人就 403；操作记录写 via=feishu。
 */
export const FEISHU_ACTING_HEADER = 'X-Fleet-Acting-Feishu';

const Id = z.string().min(1).max(200);
const Time = z.iso.datetime({ offset: true });
const Cursor = z.string().min(1).max(500);

// —— 与 domain.ts 一一对应的枚举（domain.ts 只有类型，这里给运行时校验）——

export const StageKindSchema = z.enum([
  'triage',
  'spec',
  'plan',
  'execute',
  'ui',
  'review',
  'research',
  'judge',
]);
export const TaskStateSchema = z.enum([
  'queued',
  'triaging',
  'asking',
  'planning',
  'running',
  'merging',
  'done',
  'stopped',
  'failed',
  'stalled',
]);
export const SubtaskStateSchema = z.enum([
  'pending',
  'waiting_deps',
  'waiting_slot',
  'running',
  'verifying',
  'in_merge_queue',
  'merged',
  'stopped',
  'failed',
  'stalled',
]);
export const StepStateSchema = z.enum(['pending', 'in_progress', 'done']);
export const BillingKindSchema = z.enum(['subscription', 'metered']);
export const ReadingKindSchema = z.enum(['measured', 'estimated']);
export const QuotaWindowKindSchema = z.enum([
  '5h',
  '7d',
  '7d_model',
  'month_usd',
  'points',
  'period_usd',
  'other',
]);
export const HostIdSchema = z.enum(['claude-code', 'codex', 'cursor-agent', 'grok', 'mirasim', 'api-shell']);
export const RunOutcomeSchema = z.enum(['ok', 'failed', 'stopped', 'stalled']);
export const ProgressKindSchema = z.enum(['plan', 'say', 'tool', 'file', 'test', 'ask', 'done', 'blocked']);
export const QuotaStatusSchema = z.enum(['allowed', 'warning', 'limit_reached']);
export const QuotaUnitSchema = z.enum(['percent', 'usd', 'tokens', 'points']);
export const ScheduleOutcomeSchema = z.enum(['ok', 'partial', 'unscanned', 'failed']);

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** 编译期闸：上面的枚举和 domain.ts 的联合类型必须一字不差，改了一边没改另一边 `tsc` 当场报错。 */
export const ENUMS_MATCH_DOMAIN: [
  Same<z.infer<typeof StageKindSchema>, StageKind>,
  Same<z.infer<typeof TaskStateSchema>, TaskState>,
  Same<z.infer<typeof SubtaskStateSchema>, SubtaskState>,
  Same<z.infer<typeof StepStateSchema>, StepState>,
  Same<z.infer<typeof BillingKindSchema>, BillingKind>,
  Same<z.infer<typeof ReadingKindSchema>, ReadingKind>,
  Same<z.infer<typeof QuotaWindowKindSchema>, QuotaWindowKind>,
  Same<z.infer<typeof HostIdSchema>, HostId>,
  Same<z.infer<typeof RunOutcomeSchema>, RunOutcome>,
  Same<z.infer<typeof ProgressKindSchema>, ProgressKind>,
  Same<z.infer<typeof QuotaStatusSchema>, QuotaStatus>,
  Same<z.infer<typeof QuotaUnitSchema>, QuotaUnit>,
  Same<z.infer<typeof ScheduleOutcomeSchema>, ScheduleOutcome>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true];

// —— 通用 ——

/** 所有非 2xx 的返回体。code 给程序判断，message 是给人看的白话。 */
export const ApiErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

/** 翻页：游标是后端给的不透明字符串，原样带回来即可。 */
export const PageQuery = z.object({
  cursor: Cursor.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** 谁做的：人（驾驶舱用户）、AI 帅位、引擎、会话里的 AI。 */
export const ActorSchema = z.object({
  kind: z.enum(['user', 'ai', 'engine', 'agent']),
  id: Id,
  name: z.string().optional(),
});

// —— 登录与当前用户 ——

/**
 * 驾驶舱只放行创始人。以后要放别人进来，给 users 加一个显式字段（比如 cockpitAccess），不按角色推断。
 * （users 表同时是 GitHub 作者白名单，那边协作者和自家机器人照样算数。）
 */
export const UserRoleSchema = z.enum(['founder']);

export const MeResponse = z.object({
  user: z.object({
    id: Id,
    displayName: z.string(),
    role: UserRoleSchema,
    avatarUrl: z.string().optional(),
  }),
  /** 写操作放进请求头 `X-CSRF-Token`。 */
  csrfToken: z.string(),
});

/** 登录页要知道的：飞书应用编号（tt.requestAccess 要用；飞书登录没配置时没有）、开发环境免登是否开着。 */
export const AuthConfigResponse = z.object({
  feishuAppId: z.string().optional(),
  devLogin: z.boolean(),
});

/** 飞书客户端内免登：前端调 `tt.requestAccess` 拿到 code 交给后端换登录态。 */
export const FeishuAccessRequest = z.object({ code: z.string().min(1).max(1024) });

/** 只在开发环境存在的免登入口；userId 仍须在白名单里。 */
export const DevLoginRequest = z.object({ userId: Id });

// —— 仓与看板 ——

export const RepoSchema = z.object({
  id: Id,
  owner: z.string(),
  name: z.string(),
  defaultBranch: z.string(),
});
export const ReposResponse = z.object({ repos: z.array(RepoSchema) });

export const ProgressSchema = z.object({
  done: z.number().int().min(0),
  total: z.number().int().min(0),
});

/** 卡片上「此刻在干什么」。前端用 since 实时显示「已 N 分钟」，所以后端不拼进文字。 */
export const ActivitySchema = z.object({
  runId: Id,
  stage: StageKindSchema,
  routeId: Id,
  /** 例如「Opus 5.5」；路由或模型查不到时是「未知模型」。 */
  modelName: z.string(),
  hostId: HostIdSchema.optional(),
  /** true = 还在排队，since 是排队开始的时刻。 */
  queued: z.boolean(),
  since: Time,
  /** 进行中的那一步（fleet plan 里 in_progress 的那条）；没报过就没有。 */
  step: z.string().optional(),
  /** 例如「Opus 5.5 正在写登录页」「Opus 5.5 排队中」。 */
  text: z.string(),
});

export const BoardSubtaskSchema = z.object({
  id: Id,
  index: z.number().int(),
  title: z.string(),
  state: SubtaskStateSchema,
  prNumber: z.number().int().positive().optional(),
  dependsOn: z.array(Id),
  touches: z.array(z.string()),
  /** 当前会话步骤清单的完成数；会话没报过步骤就没有。 */
  progress: ProgressSchema.optional(),
  activity: ActivitySchema.optional(),
});

export const BoardTaskSchema = z.object({
  id: Id,
  issueNumber: z.number().int().positive(),
  title: z.string(),
  state: TaskStateSchema,
  priority: z.number(),
  requestedBy: z.string(),
  createdAt: Time,
  /** 子任务合并数 / 子任务总数。 */
  progress: ProgressSchema,
  /** 需求级的会话（分诊、写需求文档、规划）。 */
  activity: ActivitySchema.optional(),
  subtasks: z.array(BoardSubtaskSchema),
});

export const NowItemSchema = ActivitySchema.extend({
  taskId: Id,
  taskTitle: z.string(),
  subtaskId: Id.optional(),
});

export const BoardResponse = z.object({
  repo: RepoSchema,
  tasks: z.array(BoardTaskSchema),
  /** 「此刻」面板：这个仓里正在跑或排队的会话。 */
  now: z.array(NowItemSchema),
  asOf: Time,
});

// —— 任务详情、时间线、步骤 ——

export const TaskSchema = z.object({
  id: Id,
  repoId: Id,
  issueNumber: z.number().int().positive(),
  title: z.string(),
  rawRequest: z.string(),
  requestedBy: z.string(),
  state: TaskStateSchema,
  priority: z.number(),
  specDir: z.string().optional(),
  createdAt: Time,
});

export const RunSchema = z.object({
  id: Id,
  subtaskId: Id.optional(),
  stage: StageKindSchema,
  routeId: Id,
  modelName: z.string(),
  hostId: HostIdSchema.optional(),
  /** 一句话「为什么派给它」。 */
  whyRoute: z.string(),
  queuedAt: Time,
  startedAt: Time.optional(),
  endedAt: Time.optional(),
  outcome: RunOutcomeSchema.optional(),
  inputTokens: z.number().int().min(0).optional(),
  outputTokens: z.number().int().min(0).optional(),
  costUsd: z.number().min(0).optional(),
});

export const AskSchema = z.object({
  id: Id,
  runId: Id.optional(),
  question: z.string(),
  options: z.array(z.string()),
  askedAt: Time,
  status: z.enum(['pending', 'answered']),
  answer: z.string().optional(),
  answeredBy: z.string().optional(),
  answeredAt: Time.optional(),
});

export const TaskDetailResponse = z.object({
  task: TaskSchema,
  repo: RepoSchema,
  subtasks: z.array(BoardSubtaskSchema),
  runs: z.array(RunSchema),
  asks: z.array(AskSchema),
});

export const TimelineItemSchema = z.object({
  id: Id,
  at: Time,
  /** session = 会话里报的或读出来的；engine = 引擎记的（状态变化等）；person = 人做的操作。 */
  source: z.enum(['session', 'engine', 'person']),
  /** ProgressKind 之一，或 state（状态变化）、pause/resume/stop/reroute/answer 这类操作名。 */
  kind: z.string(),
  runId: Id.optional(),
  subtaskId: Id.optional(),
  /** 一行白话，后端按 kind 和原始内容拼好。 */
  text: z.string(),
  detail: z.unknown().optional(),
});

export const TimelineResponse = z.object({
  items: z.array(TimelineItemSchema),
  nextCursor: Cursor.optional(),
});

export const RunStepSchema = z.object({
  index: z.number().int().min(0),
  title: z.string(),
  state: StepStateSchema,
});

export const RunStepsResponse = z.object({
  runId: Id,
  steps: z.array(RunStepSchema),
  /** 步骤清单最后一次更新的时刻；没报过就没有。 */
  updatedAt: Time.optional(),
  lastSay: z.object({ text: z.string(), at: Time }).optional(),
});

// —— 发给工作流的信号 ——

export const TaskActionRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('pause'), reason: z.string().max(500).optional() }),
  z.object({ action: z.literal('resume') }),
  z.object({ action: z.literal('stop'), reason: z.string().max(500).optional() }),
  z.object({
    action: z.literal('reroute'),
    routeId: Id,
    /** 只换某个子任务的；不填 = 换这个需求当前在跑的那一个会话。 */
    subtaskId: Id.optional(),
    reason: z.string().max(500).optional(),
  }),
]);
export const TaskActionResponse = z.object({ ok: z.literal(true) });

export const AnswerAskRequest = z.object({ answer: z.string().min(1).max(4000) });
export const AnswerAskResponse = z.object({ ok: z.literal(true) });

// —— 调度台：路由与阶段策略 ——

export const ChannelSchema = z.object({
  id: Id,
  name: z.string(),
  billing: BillingKindSchema,
  enabled: z.boolean(),
});

export const ModelSchema = z.object({
  id: Id,
  family: z.string(),
  displayName: z.string(),
  retiredAt: Time.optional(),
});

export const RouteSchema = z.object({
  id: Id,
  channelId: Id,
  poolId: Id,
  modelId: Id,
  hostId: HostIdSchema,
  /** 只由探针和熔断写。 */
  alive: z.boolean(),
});

export const StagePolicySchema = z.object({
  stage: StageKindSchema,
  routeIds: z.array(Id),
  /** 创始人手动钉住的顺序，AI 帅位不改。 */
  pinned: z.boolean(),
});

export const BanSchema = z.object({
  family: z.string().optional(),
  modelId: Id.optional(),
  stage: StageKindSchema.optional(),
  reason: z.string(),
});

export const PoolSchema = z.object({
  id: Id,
  channelId: Id,
  maxConcurrency: z.number().int().min(0),
  expiresAt: Time.optional(),
});

export const RoutingResponse = z.object({
  channels: z.array(ChannelSchema),
  pools: z.array(PoolSchema),
  models: z.array(ModelSchema),
  routes: z.array(RouteSchema),
  stages: z.array(StagePolicySchema),
  /** 写死在代码里的全局禁令（bans.ts），驾驶舱只读展示，改不了。 */
  hardBans: z.array(z.object({ id: z.string(), reason: z.string() })),
  /** 库里另外配的禁令，和 hardBans 一起生效。 */
  bans: z.array(BanSchema),
});

const RouteIdList = z
  .array(Id)
  .max(50)
  .refine((ids) => new Set(ids).size === ids.length, { message: '同一条路由不能出现两次' });

/**
 * 改一个阶段的路由顺序。expected 填你改之前看到的样子：别人（或 AI 帅位）先改了就返回 409，刷新后再改，
 * 不会悄悄盖掉别人的改动。
 */
export const UpdateStagePolicyRequest = z.object({
  routeIds: RouteIdList,
  pinned: z.boolean(),
  expected: z.object({ routeIds: z.array(Id), pinned: z.boolean() }),
  /** 写进操作记录。 */
  reason: z.string().max(500).optional(),
});
export const UpdateStagePolicyResponse = z.object({ stage: StagePolicySchema });

/** 上架 / 下架一个渠道。 */
export const UpdateChannelRequest = z.object({
  enabled: z.boolean(),
  reason: z.string().max(500).optional(),
});
export const UpdateChannelResponse = z.object({ ok: z.literal(true) });

// —— 账号池与额度 ——

export const QuotaWindowViewSchema = z.object({
  /** 上游对这个窗口的原名（5h、7d_claude、auto_percent……），同一池里不重复。显示用它；window 只是归类。 */
  label: z.string().min(1),
  /** 归类；上游新出的、归不了类的是 other，看 label。 */
  window: QuotaWindowKindSchema,
  /** 只扣某一组模型的窗口的组名（中转的 fable、Cursor 的 auto / api 桶……）；账号级窗口没有。 */
  scope: z.string().optional(),
  /** 已用比例。超额是真实情况，可以大于 1——原样给出，显示进度条时再截到 100%。 */
  utilization: z.number().min(0).optional(),
  used: z.number().optional(),
  limit: z.number().optional(),
  /** used / limit 的单位。上游只给百分比时是 percent，limit 是 100。 */
  unit: QuotaUnitSchema,
  resetsAt: Time.optional(),
  /** 上游自己说的状态，以它为准（实测 99% 就可能已经 limit_reached）。 */
  upstreamStatus: QuotaStatusSchema.optional(),
  /** 上游的原状态字：归不进 upstreamStatus 的也原样给人看，不猜。 */
  statusRaw: z.string().optional(),
  /** measured = 实读；estimated = 按用量估算。 */
  reading: ReadingKindSchema,
  /** 读法：claude-usage、mirasim-relay、cursor-dashboard、grok-billing、estimate……（官方接口、网页接口还是估算）。 */
  source: z.string().min(1),
  readAt: Time,
  /** 过期：读数太旧（超过 staleAfterMinutes），不能当现值用。上游不再报的窗口不删，旧读数到点就按过期显示。 */
  stale: z.boolean(),
});

export const PoolViewSchema = z.object({
  id: Id,
  channelId: Id,
  channelName: z.string(),
  /** null = 这个池挂的渠道在库里查不到（数据不一致），计费方式未知——不猜成「套餐内」。 */
  billing: BillingKindSchema.nullable(),
  channelEnabled: z.boolean(),
  maxConcurrency: z.number().int().min(0),
  /** 正在跑的会话数。 */
  running: z.number().int().min(0),
  expiresAt: Time.optional(),
  /** fresh = 读数都新鲜；stale = 有读数过期；unread = 一条读数都没有（没查成，不是「没用量」）。 */
  quotaStatus: z.enum(['fresh', 'stale', 'unread']),
  /** 最近一次读成的时刻（这个池各窗口读数里最新的那个）；一次都没读成过就没有。 */
  lastReadAt: Time.optional(),
  /** 按清零时刻排，快清零的在前（不知道清零时刻的在后）；同时清零的按原名。 */
  windows: z.array(QuotaWindowViewSchema),
});

export const PoolsResponse = z.object({
  pools: z.array(PoolViewSchema),
  staleAfterMinutes: z.number().int().positive(),
  asOf: Time,
});

// —— 定时任务 ——

export const JobViewSchema = z.object({
  id: Id,
  name: z.string(),
  schedule: z.string(),
  /** 上次成功距今超过这么多分钟就算过期（登记时已含周期、抖动和一轮耗时）。 */
  expectEveryMinutes: z.number().int().positive(),
  lastRun: z
    .object({
      startedAt: Time,
      endedAt: Time.optional(),
      /**
       * 没有 = 还在跑。四种结局分开，「没跑成」「没扫到」不能当「没问题」：
       * ok = 跑完了、扫了对象；partial = 跑完了但有一部分没查成；unscanned = 跑完了但一个对象都没扫到；failed = 没跑成。
       */
      outcome: ScheduleOutcomeSchema.optional(),
      /** 扫了几个对象。 */
      scanned: z.number().int().min(0).optional(),
      /** 查出几条问题。ok 且 found=0 才是「查过，没事」。 */
      found: z.number().int().min(0).optional(),
      /** 不是 ok 时写的原因。 */
      why: z.string().optional(),
    })
    .optional(),
  /** 最近一次跑成（ok 或 partial）的结束时刻。 */
  lastSuccessAt: Time.optional(),
  /** fresh = 上次跑成在 expectEveryMinutes 之内；overdue = 超过了；never = 从没跑成过。 */
  status: z.enum(['fresh', 'overdue', 'never']),
});

export const JobsResponse = z.object({ jobs: z.array(JobViewSchema), asOf: Time });

// —— 通知 ——

/** 三级：要人拍 / 卡住报警 / 日报。 */
export const NotificationLevelSchema = z.enum(['decision', 'alert', 'daily']);

export const NotificationSchema = z.object({
  id: Id,
  level: NotificationLevelSchema,
  title: z.string(),
  body: z.string(),
  /** 点开直达驾驶舱对应页的站内路径。 */
  link: z.string().optional(),
  taskId: Id.optional(),
  createdAt: Time,
  resolvedAt: Time.optional(),
  resolvedBy: z.string().optional(),
  deliveries: z.array(
    z.object({
      channel: z.string(),
      /** 没拿到消息编号就算没送到。 */
      delivered: z.boolean(),
      attempts: z.number().int().min(0),
      error: z.string().optional(),
      lastAttemptAt: Time.optional(),
    }),
  ),
});

export const NotificationsQuery = PageQuery.extend({
  status: z.enum(['open', 'all']).default('open'),
});
export const NotificationsResponse = z.object({
  items: z.array(NotificationSchema),
  nextCursor: Cursor.optional(),
});
export const ResolveNotificationResponse = z.object({ ok: z.literal(true) });

// —— 操作记录 ——

/**
 * 只追加，不改旧记录；先记后做：动作执行之前先写一条（写不进就不做），这一条的 ok=true 表示「已记录并发起」。
 * 发起之后没做成（例如工作流已结束），再追加一条同 action、同 target、ok=false、带 error 的记录。
 */
export const AuditEntrySchema = z.object({
  id: Id,
  at: Time,
  actor: ActorSchema,
  /** 例如 stage_policy.update、task.pause、login。 */
  action: z.string(),
  /** 例如 stage:execute、task:12、channel:cursor。 */
  target: z.string(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  reason: z.string().optional(),
  via: z.enum(['cockpit', 'feishu', 'github', 'engine', 'agent']),
  ok: z.boolean(),
  error: z.string().optional(),
});

export const AuditQuery = PageQuery.extend({ target: z.string().max(200).optional() });
export const AuditResponse = z.object({
  items: z.array(AuditEntrySchema),
  nextCursor: Cursor.optional(),
});

// —— 设置 ——

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '格式是 HH:MM');

/** 驾驶舱能改的全局设置。新增一项就在这里加一行；不在表里的键一律拒收。 */
export const SETTING_SCHEMAS = {
  /** 同时跑的 AI 会话上限（设计文档第四节：起步 6 个）。 */
  'sessions.maxConcurrent': z.number().int().min(1).max(32),
  /** 飞书免打扰时段（北京时间）；null = 不设。 */
  'notify.quietHours': z.object({ start: HHMM, end: HHMM }).nullable(),
  /** Jev 每天最多调用多少次。 */
  'judge.dailyCallLimit': z.number().int().min(0).max(100_000),
} as const;
export type SettingKey = keyof typeof SETTING_SCHEMAS;

export const SettingSchema = z.object({
  key: z.string(),
  value: z.unknown(),
  /** 0 = 还没设过。 */
  version: z.number().int().min(0),
  updatedAt: Time.optional(),
  updatedBy: z.string().optional(),
});
export const SettingsResponse = z.object({ settings: z.array(SettingSchema) });

/** version 填你改之前看到的；别人先改了就返回 409。 */
export const UpdateSettingRequest = z.object({
  value: z.unknown(),
  version: z.number().int().min(0),
  reason: z.string().max(500).optional(),
});
export const UpdateSettingResponse = z.object({ setting: SettingSchema });

// —— 实时推送（SSE：GET /api/events）——

/**
 * 事件名。ready：连上了，前端全量拉一次；change：某张表的某一行变了，前端重拉受影响的数据；
 * resync：中间可能漏了变化（后端和数据库之间断过线，或者浏览器断开太久），前端全部重拉。
 * change 和 resync 都带 SSE 的 id；浏览器断线重连时（EventSource 自动带 Last-Event-ID）后端补发断开期间的变化，
 * 补不全（后端重启过、断开太久）就先发一条 resync。
 */
export const SSE_EVENTS = { ready: 'ready', change: 'change', resync: 'resync' } as const;

/** change 事件的 data，也是数据库 NOTIFY fleet_changes 的载荷（形状定义在 realtime.ts）。 */
export const ChangeEventSchema = z.object({
  table: z.enum(REALTIME_TABLES),
  id: z.string().min(1).max(200),
});

/** 编译期闸：ChangeEventSchema 和 realtime.ts 的 ChangeEvent 必须同形。 */
export const CHANGE_EVENT_MATCHES_REALTIME: Same<z.infer<typeof ChangeEventSchema>, ChangeEvent> = true;

// —— 路由表（前端据此封装请求；路径都在 WEB_API_PREFIX 之下，:xxx 是路径参数）——

export const WebRoutes = {
  me: { method: 'GET', path: '/me', response: MeResponse },
  events: { method: 'GET', path: '/events' },
  repos: { method: 'GET', path: '/repos', response: ReposResponse },
  board: { method: 'GET', path: '/repos/:repoId/board', response: BoardResponse },
  task: { method: 'GET', path: '/tasks/:taskId', response: TaskDetailResponse },
  timeline: { method: 'GET', path: '/tasks/:taskId/timeline', query: PageQuery, response: TimelineResponse },
  taskAction: {
    method: 'POST',
    path: '/tasks/:taskId/actions',
    request: TaskActionRequest,
    response: TaskActionResponse,
  },
  runSteps: { method: 'GET', path: '/runs/:runId/steps', response: RunStepsResponse },
  answerAsk: {
    method: 'POST',
    path: '/asks/:askId/answer',
    request: AnswerAskRequest,
    response: AnswerAskResponse,
  },
  routing: { method: 'GET', path: '/routing', response: RoutingResponse },
  updateStagePolicy: {
    method: 'PUT',
    path: '/routing/stages/:stage',
    request: UpdateStagePolicyRequest,
    response: UpdateStagePolicyResponse,
  },
  updateChannel: {
    method: 'PATCH',
    path: '/routing/channels/:channelId',
    request: UpdateChannelRequest,
    response: UpdateChannelResponse,
  },
  pools: { method: 'GET', path: '/pools', response: PoolsResponse },
  jobs: { method: 'GET', path: '/jobs', response: JobsResponse },
  notifications: {
    method: 'GET',
    path: '/notifications',
    query: NotificationsQuery,
    response: NotificationsResponse,
  },
  resolveNotification: {
    method: 'POST',
    path: '/notifications/:notificationId/resolve',
    response: ResolveNotificationResponse,
  },
  audit: { method: 'GET', path: '/audit', query: AuditQuery, response: AuditResponse },
  settings: { method: 'GET', path: '/settings', response: SettingsResponse },
  updateSetting: {
    method: 'PUT',
    path: '/settings/:key',
    request: UpdateSettingRequest,
    response: UpdateSettingResponse,
  },
} as const;

/**
 * 登录相关的入口，在 AUTH_PREFIX 之下（不在 /api 之下，因为要被浏览器直接跳转打开）。
 * 浏览器里：跳到 /auth/feishu/login?next=<站内路径>，登录完回到 next。
 * 飞书客户端里：tt.requestAccess 拿 code，POST /auth/feishu/access。
 */
export const AuthRoutes = {
  config: { method: 'GET', path: '/config', response: AuthConfigResponse },
  feishuLogin: { method: 'GET', path: '/feishu/login' },
  feishuCallback: { method: 'GET', path: '/feishu/callback' },
  feishuAccess: {
    method: 'POST',
    path: '/feishu/access',
    request: FeishuAccessRequest,
    response: MeResponse,
  },
  logout: { method: 'POST', path: '/logout' },
  devLogin: { method: 'POST', path: '/dev-login', request: DevLoginRequest, response: MeResponse },
} as const;
