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
  RouteProbeState,
  RunOutcome,
  ScheduleOutcome,
  SegmentKind,
  SegmentOutcome,
  SegmentTier,
  StageKind,
  StepState,
  SubtaskState,
  TaskState,
} from './domain.ts';
import { SESSION_EFFORTS } from './effort.ts';
import { type ChangeEvent, REALTIME_TABLES } from './realtime.ts';
import { SEGMENT_KINDS, SEGMENT_OUTCOMES, SEGMENT_TIERS, type SegmentRunView } from './segment-runs.ts';
import type { TaskUsage } from './usage.ts';

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
  'verify',
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
export const RouteProbeStateSchema = z.enum(['ok', 'failed', 'not_wired', 'skipped']);
export const SegmentKindSchema = z.enum(SEGMENT_KINDS);
export const SegmentTierSchema = z.enum(SEGMENT_TIERS);
export const SegmentOutcomeSchema = z.enum(SEGMENT_OUTCOMES);

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
  Same<z.infer<typeof RouteProbeStateSchema>, RouteProbeState>,
  Same<z.infer<typeof SegmentKindSchema>, SegmentKind>,
  Same<z.infer<typeof SegmentTierSchema>, SegmentTier>,
  Same<z.infer<typeof SegmentOutcomeSchema>, SegmentOutcome>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true];

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

/**
 * 登录页要知道的：飞书应用编号（tt.requestAccess 要用；飞书登录没配置时没有）、开发环境免登是否开着、
 * 账密登录开没开（#120；后端恒为 true。可选只为兼容还不认这一项的旧后端：没有就当没开）。
 */
export const AuthConfigResponse = z.object({
  feishuAppId: z.string().optional(),
  devLogin: z.boolean(),
  passwordLogin: z.boolean().optional(),
});

/** 飞书客户端内免登：前端调 `tt.requestAccess` 拿到 code 交给后端换登录态。 */
export const FeishuAccessRequest = z.object({ code: z.string().min(1).max(1024) });

/** 只在开发环境存在的免登入口；userId 仍须在白名单里。 */
export const DevLoginRequest = z.object({ userId: Id });

/**
 * 账密登录（#120）：成功 204 + 和飞书登录同一种会话 Cookie（再 GET /api/me 取 CSRF 令牌）。
 * 失败都是统一的错误体（ApiErrorBody）：
 * - 401 code=bad_credentials：没这个人、没设过密码、密码错、不在白名单，一律这一句，不区分；
 * - 429 code=locked，details.until = 锁到什么时候（同一用户名或同一来源连续输错 5 次，锁 15 分钟；锁期内对的密码也不放）。
 * 字段只限长度，格式不合（比如用户名写错了格式）也按 401 答，不提示。
 */
export const PasswordLoginRequest = z.object({
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(1024),
});

export const PASSWORD_MIN_LENGTH = 10;

/**
 * 设置页看账密登录的状态。canSetWithoutCurrent：还没设过密码、且这次会话是 10 分钟内飞书登录的——
 * 只有这时能不带当前密码设第一次；过了 10 分钟要重新用飞书登录一次。
 */
export const CredentialsResponse = z.object({
  hasPassword: z.boolean(),
  username: z.string().nullable(),
  passwordChangedAt: Time.nullable(),
  canSetWithoutCurrent: z.boolean(),
});

/**
 * 设或改用户名、密码（PUT，写操作带 X-CSRF-Token），成功 204。已设过密码的，改什么都要带 currentPassword。
 * 设、改了密码：这个人别处已登的会话全部作废（接口回 401 session_revoked）；这一处的响应里换上新 Cookie，CSRF 令牌不变。
 * 用户名 3–32 位（字母或数字开头，字母、数字、点、下划线、连字符），大小写不敏感地唯一；密码至少 10 位。
 * 失败（ApiErrorBody，details.field 指明哪一栏）：
 * - 400 invalid_username / username_taken（field=username）、username_required（第一次设密码没给用户名，field=username）；
 * - 400 weak_password / password_too_long（field=newPassword）、nothing_to_change（两样都没给）；
 * - 400 current_password_required（field=currentPassword）；401 bad_current_password（field=currentPassword，也计入输错次数）；
 * - 403 recent_feishu_login_required：没设过密码、这次会话不是 10 分钟内飞书登录的；
 * - 429 locked（details.until）。
 */
export const UpdateCredentialsRequest = z.object({
  username: z.string().max(200).optional(),
  newPassword: z.string().max(1024).optional(),
  currentPassword: z.string().max(1024).optional(),
});

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
  cacheReadTokens: z.number().int().min(0).optional(),
  cacheWriteTokens: z.number().int().min(0).optional(),
  costUsd: z.number().min(0).optional(),
  /** 路由所在渠道的计费方式：按量的花费是真花的钱，套餐内的只是按 API 价折合。渠道查不到就没有（不猜成套餐内）。 */
  billing: BillingKindSchema.optional(),
});

// 用量汇总：算法和各栏的意思在 usage.ts。每一样只加读到的，没读到的次数在 missing* 里，不当成 0。
const Count = z.number().int().min(0);
const CostShareSchema = z.object({ runs: Count, usd: z.number().min(0), missing: Count });
export const UsageTotalsSchema = z.object({
  runs: Count,
  running: Count,
  notStarted: Count,
  inputTokens: Count,
  outputTokens: Count,
  missingTokens: Count,
  cacheReadTokens: Count,
  cacheWriteTokens: Count,
  missingCache: Count,
  inputEquivalent: Count,
  missingEquivalent: Count,
  costUsd: z.number().min(0),
  missingCost: Count,
  /** 花费按计费方式分开：按量（真花的钱）、套餐内（按 API 价折合，不另花钱）、渠道查不到分不清的。 */
  cost: z.object({ metered: CostShareSchema, subscription: CostShareSchema, unknown: CostShareSchema }),
  queueMs: Count,
  runMs: Count,
  missingTime: Count,
  /** 结束了的里没有排队记录的笔数（三段的 runs 不记排队）：排队合计要把它算作没读到。 */
  noQueue: Count,
});
const ModelUsageTotalsSchema = UsageTotalsSchema.extend({ model: z.string(), modelName: z.string() });
export const TaskUsageSchema = z.object({
  total: UsageTotalsSchema,
  byModel: z.array(ModelUsageTotalsSchema),
  byStage: z.array(UsageTotalsSchema.extend({ stage: StageKindSchema })),
  /** 三段按段（对题、动手、验收；段名认不出的 segment 为 null，排最后），每段再按模型分。 */
  bySegment: z.array(
    UsageTotalsSchema.extend({
      segment: SegmentKindSchema.nullable(),
      tiers: z.array(SegmentTierSchema),
      missingTier: Count,
      byModel: z.array(ModelUsageTotalsSchema),
    }),
  ),
});
/** 编译期闸：和 usage.ts 算出来的形状一字不差，改了一边没改另一边 `tsc` 当场报错。 */
export const USAGE_MATCHES_SUMMARY: Same<z.infer<typeof TaskUsageSchema>, TaskUsage> = true;

/** 一笔三段哪一样没读到、为什么（segment-runs.ts 的 readSegmentRun 判）。 */
export const UnreadNoteSchema = z.object({
  item: z.enum(['segment', 'time', 'outcome', 'tokens', 'cost', 'tier']),
  reason: z.string().min(1),
});

/**
 * 三段（库里的 runs 表）的一笔，读好给页面的样子：只给认得出的值，认不出、没记的写在 unread 里带原因，不拿 0 顶。
 * 怎么读见 segment-runs.ts。
 */
export const SegmentRunSchema = z.object({
  id: Id,
  /** 认不出的段是 null（原样在 unread 的原因里）。 */
  segment: SegmentKindSchema.nullable(),
  /** 路由挑的模型（模型目录的 id）和给人看的名字。 */
  model: z.string(),
  modelName: z.string(),
  channel: z.string().optional(),
  /** 渠道的计费方式：按量的花费是真花的钱，套餐内的只是按 API 价折合。渠道查不到就没有（不猜成套餐内）。 */
  billing: BillingKindSchema.optional(),
  /** 派工档；只有动手段分档。 */
  tier: SegmentTierSchema.optional(),
  startedAt: Time.optional(),
  endedAt: Time.optional(),
  /** 还在跑：没结束、单子也没结束。用量等它结束才有。 */
  running: z.boolean(),
  outcome: SegmentOutcomeSchema.optional(),
  /** 结束 − 开始（毫秒）；起止读不到的没有。 */
  durationMs: Count.optional(),
  inputTokens: Count.optional(),
  outputTokens: Count.optional(),
  cacheReadTokens: Count.optional(),
  cacheWriteTokens: Count.optional(),
  costUsd: z.number().min(0).optional(),
  memoryPeakMb: Count.optional(),
  failureReason: z.string().optional(),
  prNumber: z.number().int().positive().optional(),
  branch: z.string().optional(),
  /** task = 按 task_id 对上；issueNumber = 这笔没记 task_id、按单号兜底对上的（单号几个仓可能重）。 */
  matchedBy: z.enum(['task', 'issueNumber']),
  unread: z.array(UnreadNoteSchema),
});
/** 编译期闸：和 segment-runs.ts 读出来的形状一字不差。 */
export const SEGMENT_RUN_MATCHES_READING: Same<z.infer<typeof SegmentRunSchema>, SegmentRunView> = true;

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
  /**
   * 问他不挡路（#259）：task = 这张单范围内的岔路，已按推荐先做；outside = 超出范围，另开单等他拍；
   * hold = 碰了人闸，先按推荐做、合并前等批。没有 = 老式的（会话停着等回答）。
   */
  scope: z.enum(['task', 'outside', 'hold']).optional(),
  /** 推荐的那个（选项里排第一个）。 */
  recommended: z.string().optional(),
  /** scope = hold 时碰的是哪类：release 对外发布、spend 花钱、delete 删数据、standard 改标准。 */
  hold: z.enum(['release', 'spend', 'delete', 'standard']).optional(),
  /**
   * 按推荐先做了的、回答了之后会怎样（core 的 lateAnswer）：confirmed 选的就是推荐的；applied 已照改；
   * change 下个存档点改；follow-up 这张单已合，开后续单；recorded 这张单没做成就停了，只记下。
   */
  effect: z.enum(['confirmed', 'applied', 'change', 'follow-up', 'recorded']).optional(),
  /** 为这条提问另开的单（超出范围的，或合并后才改的后续单）。 */
  followUpIssue: z.number().int().positive().optional(),
});

export const TaskDetailResponse = z.object({
  task: TaskSchema,
  repo: RepoSchema,
  subtasks: z.array(BoardSubtaskSchema),
  /** 老流程的会话（session_runs）。 */
  runs: z.array(RunSchema),
  /** 三段（runs 表）的流水，按起跑先后：task_id 对上的，加上 task_id 没记、按单号兜底的（matchedBy 标明）。 */
  segmentRuns: z.array(SegmentRunSchema),
  asks: z.array(AskSchema),
  /** 用量：老流程的会话加三段的流水整张合计、按模型；会话按阶段、三段按段（每段再按模型）。 */
  usage: TaskUsageSchema,
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

/** 探针多久一轮（design 第九节「路由探针」：Claude 订阅起步 15 分钟，和对账补漏错开）。 */
export const ROUTE_PROBE_EVERY_MINUTES = 15;
/** 结论超过这么久没更新（连着三轮没跑）：驾驶舱标「探测过期」，探针可能停了。 */
export const ROUTE_PROBE_STALE_MINUTES = 45;
/**
 * 按一次的成本放慢的执行方式（design 第九节「路由探针」：贵的放慢）：上一次探通了，隔这么久才再真探；没通的照样每轮探
 * （没登录、连不上的报错走不到模型，不扣用量）。没列的每轮都探。cursor-agent：一次最小会话约 1.3 万输入 token
 * （2026-09-27 本机实测），扣的是按月的包含用量、和创始人在编辑器里用的是同一份——每轮都探一个月约 2900 次，2 小时一次约 360 次。
 * grok：同一个道理——SuperGrok 订阅按周的额度、和创始人在 grok.com 上用的是同一份，一次最小会话光系统提示就一万多输入 token
 * （法国真跑的过程记录：一次模型调用约 1.5 万输入、其中 1.2 万走缓存）。mirasim：探通即代表真打了一次上游（MS-27，账本要
 * 见到 2xx），扣的是 Mirasim 那份紧张的中转额度（#345，创始人 2026-09-27「额度不太够」）——15 分钟一轮会一个月探约 2900 次，
 * 和 cursor-agent、grok 一样放慢到 2 小时。
 */
export const ROUTE_PROBE_HOST_EVERY_MINUTES: Readonly<Partial<Record<HostId, number>>> = {
  'cursor-agent': 120,
  grok: 120,
  mirasim: 120,
};

/** 这种执行方式探通之后隔多久再真探（分钟）。 */
export function routeProbeEveryMinutes(hostId: string | undefined): number {
  const slow =
    hostId === undefined ? undefined : (ROUTE_PROBE_HOST_EVERY_MINUTES as Record<string, number>)[hostId];
  return slow ?? ROUTE_PROBE_EVERY_MINUTES;
}

/** 这条路由的结论多久没更新算过期（探针可能停了）：再探的间隔加两轮。每轮都探的就是 ROUTE_PROBE_STALE_MINUTES。 */
export function routeProbeStaleMinutes(hostId: string | undefined): number {
  return routeProbeEveryMinutes(hostId) + ROUTE_PROBE_STALE_MINUTES - ROUTE_PROBE_EVERY_MINUTES;
}

/** 路由探针最近一次的结论（domain.ts 的 RouteProbe）。 */
export const RouteProbeSchema = z.object({
  state: RouteProbeStateSchema,
  at: Time,
  /** 不是 ok 必须写原因；ok 也带一句（回答、用时）。 */
  detail: z.string().optional(),
});

export const RouteSchema = z.object({
  id: Id,
  channelId: Id,
  poolId: Id,
  modelId: Id,
  hostId: HostIdSchema,
  /** 只由探针和熔断写：为真时 probe 一定是 ok（库里有约束）。 */
  alive: z.boolean(),
  /** 没有 = 探针还没看过这条路由（上线后第一轮之前），不是离线。 */
  probe: RouteProbeSchema.optional(),
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

/**
 * 一块功能还没做（装配时定，不是跑出来的；和 /healthz 的「未接」同一个做法）：驾驶舱整块显示「待实现」占位，
 * 写明排在哪个阶段、哪张单，不把「没读到」说成「没查成」「离线」。接上以后后端不再给这一项。
 */
export const NotWiredSchema = z.object({
  /** 这块是什么：额度读数、路由在线状态…… */
  what: z.string(),
  /** 排在 plan.md 的哪个阶段，如 P3。 */
  phase: z.string(),
  /** 对应的单号。 */
  issue: z.number().int().positive(),
  /** 单开在哪个仓（驾驶舱据此链过去）；受管的仓里找不到它就不给，只显示单号。 */
  issueRepo: z.object({ owner: z.string(), name: z.string() }).optional(),
});
export type NotWired = z.infer<typeof NotWiredSchema>;

/**
 * 路由目录：渠道、账号池、模型、路由和禁令。每个用途按什么先后用哪些路由不在这里——那是路由两层（下面的
 * RoutingLayersResponse，GET /routing/layers），换模型对话框、路由页都读那一份（#574）。
 */
export const RoutingResponse = z.object({
  channels: z.array(ChannelSchema),
  pools: z.array(PoolSchema),
  models: z.array(ModelSchema),
  routes: z.array(RouteSchema),
  /** 写死在代码里的全局禁令（bans.ts），驾驶舱只读展示，改不了。 */
  hardBans: z.array(z.object({ id: z.string(), reason: z.string() })),
  /** 库里另外配的禁令，和 hardBans 一起生效。 */
  bans: z.array(BanSchema),
});

/** 上架 / 下架一个渠道。 */
export const UpdateChannelRequest = z.object({
  enabled: z.boolean(),
  reason: z.string().max(500).optional(),
});
export const UpdateChannelResponse = z.object({ ok: z.literal(true) });

// —— 路由两层（#574）：每个用途 → 模型 → 路由，每一层现在活着吗 ——
// 活不活不存，读的时候按探针、额度、禁令现算（db 的 routing-liveness.ts，判法只在那里）。

/** live 派得出去；dead 派不出去；unknown 不知道（探针没看过、额度没读成）——不当活，也不当死。 */
export const LivenessVerdictSchema = z.enum(['live', 'dead', 'unknown']);

/** 接得上、额度够、没被禁令挡里的一件：结论和原因。原因总有：没查成不等于没问题。 */
export const LivenessFactSchema = z.object({
  verdict: LivenessVerdictSchema,
  reason: z.string().min(1),
});

export const RoutingLayerRouteSchema = z.object({
  routeId: Id,
  channelId: Id,
  /** 渠道目录里的名字；目录里找不到就是渠道编号。 */
  channelName: z.string(),
  poolId: Id,
  hostId: HostIdSchema,
  /** 这条路由在它的模型下开着吗（关着的照样挂在顺序里，但不派，ban 那一件写「开关关着」）。 */
  enabled: z.boolean(),
  /** 三件事合起来：任何一件 dead 就 dead；没有 dead、有 unknown 就 unknown；三件都 live 才 live。 */
  verdict: LivenessVerdictSchema,
  connect: LivenessFactSchema,
  quota: LivenessFactSchema,
  ban: LivenessFactSchema,
  /** 探针最近一次下结论的时刻；没有 = 探针还没看过。过没过期按执行方式判（routeProbeStaleMinutes）。 */
  probedAt: Time.optional(),
  /** 挡着这条路由的、用满了的额度窗：哪一个、几点清零（读数里没有清零时刻就不给）。 */
  exhausted: z.array(z.object({ label: z.string(), resetsAt: Time.optional() })),
  /** 账号池此刻在跑几个、最多几个：满了是等空位，不算死。 */
  inFlight: z.number().int().min(0),
  maxConcurrency: z.number().int().min(0),
});

export const RoutingLayerModelSchema = z.object({
  modelId: Id,
  /** 模型目录里的名字；目录里找不到就是模型编号。 */
  displayName: z.string(),
  /** 目录里找不到、下面也没有路由时不给。 */
  family: z.string().optional(),
  /** 下面有一条 live 就 live；没有 live、有 unknown 就 unknown；全 dead 或一条都没有就 dead。 */
  verdict: LivenessVerdictSchema,
  /** 按这个模型下路由的先后。空 = 一条都没有（用途的 problems 里写明）。 */
  routes: z.array(RoutingLayerRouteSchema),
});

export const RoutingLayerPurposeSchema = z.object({
  purpose: StageKindSchema,
  /** 判法和模型那一层一样：有一个模型 live 就 live。 */
  verdict: LivenessVerdictSchema,
  /** 配置上的缺口：这个用途没配模型顺序、某个模型下一条路由都没有。照实写，不当成「没有」。 */
  problems: z.array(z.string()),
  /** 按这个用途的模型先后。 */
  models: z.array(RoutingLayerModelSchema),
});

export const RoutingLayersResponse = z.object({
  /** 现算的时刻。 */
  asOf: Time,
  /** 每个用途一份，按 StageKind 的先后；unavailable 时为空。 */
  purposes: z.array(RoutingLayerPurposeSchema),
  /** 这里读不了路由两层（开发环境的内存版没有这两张表）：写明为什么，不拿空列表冒充「都没配」。 */
  unavailable: z.string().optional(),
});

// —— 思考档位（#470）：路由两层里每个模型下的每条路由，起会话想多深 ——
// 存在库里（routing_catalog.effort，运行时配置，决定 0011 第 7 条）：改了下一个起的会话就照新的，不走改仓库再部署。
// 能配哪几档照 effort.ts 的 routeEffortChoices（和引擎起会话、骨架装载同一份判法）。

export const SessionEffortSchema = z.enum(SESSION_EFFORTS);

export const RouteEffortSchema = z.object({
  routeId: Id,
  channelId: Id,
  /** 渠道目录里的名字；目录里找不到就是渠道编号。 */
  channelName: z.string(),
  poolId: Id,
  hostId: HostIdSchema,
  /** 起会话时发给执行体的模型串（路由的上游模型串，没有就是模型编号）：cursor 能不能配看它带不带方括号。 */
  model: z.string(),
  /** 这条路由在它的模型下开着吗：关着的也能先配好，开了就照它。 */
  enabled: z.boolean(),
  /** 配的档位；没有 = 没配，起会话用 defaultEffort。 */
  effort: SessionEffortSchema.optional(),
  /** 能配哪几档，从低到高；配不了时为空，fixed 写为什么。 */
  choices: z.array(SessionEffortSchema),
  fixed: z.string().optional(),
});

export const EffortModelSchema = z.object({
  modelId: Id,
  /** 模型目录里的名字；目录里找不到就是模型编号。 */
  displayName: z.string(),
  family: z.string().optional(),
  /** 这个模型下的路由，按路由两层里的先后。 */
  routes: z.array(RouteEffortSchema),
});

export const RoutingEffortsResponse = z.object({
  /** 没配的路由起会话用这一档。 */
  defaultEffort: SessionEffortSchema,
  /** 挂进了路由两层的模型（按模型编号排）。unavailable 时为空。 */
  models: z.array(EffortModelSchema),
  /** 这里读不了（开发环境的内存版没有路由两层那两张表）：写明为什么，不拿空列表冒充「都没配」。 */
  unavailable: z.string().optional(),
});

/**
 * 改一条路由的思考档位。effort 写 null = 清掉、回到没配（用 defaultEffort）。expected 填改之前看到的（没配写 null）：
 * 别人先改了就返回 409，刷新后再改，不悄悄盖掉。这条路由的执行方式不认的档返回 422 写明为什么。
 */
export const UpdateRouteEffortRequest = z.object({
  effort: SessionEffortSchema.nullable(),
  expected: SessionEffortSchema.nullable(),
  /** 写进操作记录。 */
  reason: z.string().max(500).optional(),
});
export const UpdateRouteEffortResponse = z.object({
  modelId: Id,
  routeId: Id,
  /** 改完的档位；没有 = 没配。 */
  effort: SessionEffortSchema.optional(),
});

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
  /**
   * 过期标记：读成了、但上游从这个时刻起没再报这个窗口。照样显示，注明「上游这次没报」；不挡路由、不参与排序。
   * 上游重新报了就清空，满 24 小时库里删掉（数据库包的 savePoolQuota 管）。
   */
  staleSince: Time.optional(),
  /** 这条读数本身太旧（读数时刻超过 staleAfterMinutes），不能当现值用。 */
  stale: z.boolean(),
});

export const PoolViewSchema = z.object({
  id: Id,
  channelId: Id,
  channelName: z.string(),
  /** null = 这个池挂的渠道在库里查不到（数据不一致），计费方式未知——不猜成「套餐内」。 */
  billing: BillingKindSchema.nullable(),
  channelEnabled: z.boolean(),
  /** Claude 订阅池对应的组织类型（独享 / 拼车）；不是 Claude 订阅池没有。额度页顶上的切号现状按它认出独享池。 */
  orgKind: z.enum(['solo', 'carpool']).optional(),
  maxConcurrency: z.number().int().min(0),
  /** 正在跑的会话数。 */
  running: z.number().int().min(0),
  expiresAt: Time.optional(),
  /**
   * 按池看，不逐窗口看（和每小时对账、选路由同一个判法，数据库包的 quotaReadOverdue）：
   * unread = 一次都没读成过（没查成，不是「没用量」）；stale = 最近一次读成、或上游数据本身超过 staleAfterMinutes；fresh = 其余。
   */
  quotaStatus: z.enum(['fresh', 'stale', 'unread']),
  /** 最近一次完整读成的时刻（我们读的时刻），读失败不动；一次都没读成过就没有。 */
  lastReadOkAt: Time.optional(),
  /** 上游数据本身的时刻：还在报的窗口里最新的读数时刻（中转给的是它自己的采集时刻）。读成了、上游的数却冻住时看它。 */
  dataAt: Time.optional(),
  /** 按清零时刻排，快清零的在前（不知道清零时刻的在后）；同时清零的按原名。 */
  windows: z.array(QuotaWindowViewSchema),
});

/**
 * 会话用户切号的现状（#194，方案 v2 4.4：驾驶舱额度表顶上一行「挂着独享；拼车预计 HH:MM 恢复」）。从引擎落库的切号账本读：
 * unavailable = 没接上（开发、内存版）或引擎还没记过；unreadable = 账本在库里却认不出（引擎也因此不切号，要人看）；
 * known = 读到了。soloPaused 是设置里的「引擎暂不用独享」（人叫停）。
 */
export const SoloReserveViewSchema = z.object({
  /** reached = 独享到了留量线；unreadable = 留量线的设置认不出（引擎也因此不派、不切独享）；unknown = 配了线、对应的读数读不到（按额度未知，照派）。 */
  state: z.enum(['reached', 'unreadable', 'unknown']),
  why: z.string(),
});

export const OrgSwitchViewSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('unavailable'),
    why: z.string(),
    soloPaused: z.boolean(),
    soloReserve: SoloReserveViewSchema.optional(),
  }),
  z.object({
    state: z.literal('unreadable'),
    why: z.string(),
    soloPaused: z.boolean(),
    soloReserve: SoloReserveViewSchema.optional(),
  }),
  z.object({
    state: z.literal('known'),
    /** 引擎最近一次读到会话用户挂的组织（拼车 / 独享）；还没读到过为 null。 */
    live: z.enum(['carpool', 'solo']).nullable(),
    liveAt: Time.optional(),
    /** 这一次挂到独享的时刻（挂着拼车没有）。 */
    onSoloSince: Time.optional(),
    /** 记着的拼车恢复条件：哪一种用不了（E1 本人额度、E2 整辆车、E3 组织本身）、凭什么、预计几点恢复、从哪读来。 */
    outage: z
      .object({
        kind: z.enum(['E1', 'E2', 'E3']),
        evidence: z.string(),
        since: Time,
        resetsAt: Time.optional(),
        resetsFrom: z.enum(['api', 'text']).optional(),
      })
      .optional(),
    /** 渠道（所有 Claude 账号合起来）：ok 可用 ≥ 2；single 只剩 1 个；unavailable 一个都没有；unknown 读不到账号状态。 */
    channel: z
      .object({
        state: z.enum(['ok', 'single', 'unavailable', 'unknown']),
        since: Time,
        why: z.string(),
      })
      .optional(),
    /** 切回宽限从这一刻起（新活不往独享派）；不在宽限中没有。 */
    backPendingSince: Time.optional(),
    /** 连着白切几次。 */
    whites: z.number().int().min(0),
    /** 最近一次读接口：几点、成没成（没成写原因）。 */
    lastRead: z.object({ at: Time, ok: z.boolean(), why: z.string().optional() }).optional(),
    /**
     * 拼车额度烧得多快（#194 方案 4.1，shared 的 estimateBurn 按最近 15 分钟的接口读数算）：
     * known 带每分钟花多少、还剩多少、还能撑几分钟（null = 最近没在花、用不满）；unknown = 还算不出（写原因，不显示 0 也不显示猜的数）。
     * 挂着独享时不算（那时本人拼车额度没在花）；后端没带这一项（老后端）没有。
     */
    burn: z
      .discriminatedUnion('state', [
        z.object({
          state: z.literal('known'),
          usdPerMinute: z.number().min(0),
          remainingUsd: z.number().min(0),
          minutesLeft: z.number().min(0).nullable(),
          spanMinutes: z.number().positive(),
        }),
        z.object({ state: z.literal('unknown'), why: z.string() }),
      ])
      .optional(),
    soloPaused: z.boolean(),
    /** 独享的额度留量线现状（#194 方案 4.8）：没到线、也没有要说的就没有这一项。 */
    soloReserve: SoloReserveViewSchema.optional(),
    updatedAt: Time,
  }),
]);

/**
 * 拼车额度对账（#194 方案 4.7）：这一窗本机记到在拼车上花了多少，接口说用了多少；差得多、扣掉没记到花费的会话以后还差得多，
 * 多半是别的设备在用。先只显示、不报警。unavailable = 没法对（没读到窗口、窗口已过、没接上），why 写明，不拿「对得上」冒充。
 * verdict：match 对得上 / others 差得多、多半是别的设备在用 / unrecorded 没记到花费的会话太多、说不准 / local_over 本机记的比接口说的还多。
 */
export const CarpoolReconcileViewSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unavailable'), why: z.string() }),
  z.object({
    state: z.literal('known'),
    windowStart: Time,
    windowEnd: Time,
    /** 接口这次读数的时刻；本机的花费也只算到这一刻开始的会话。 */
    apiReadAt: Time,
    localUsd: z.number().min(0),
    apiUsedUsd: z.number().min(0),
    apiLimitUsd: z.number().positive(),
    /** 窗口里开始了的拼车会话数、其中没记到花费的、其中被切号停下的。 */
    sessions: z.number().int().min(0),
    unrecorded: z.number().int().min(0),
    unrecordedSwitchStopped: z.number().int().min(0),
    /** 接口说的减本机记的（可为负）。 */
    gapUsd: z.number(),
    verdict: z.enum(['match', 'others', 'unrecorded', 'local_over']),
    /** 给人看的一句话（差多少、凭什么这么说）。 */
    note: z.string(),
  }),
]);

export const PoolsResponse = z.object({
  pools: z.array(PoolViewSchema),
  staleAfterMinutes: z.number().int().positive(),
  /** 切号现状。后端没接这一块（老后端）没有这一项。 */
  orgSwitch: OrgSwitchViewSchema.optional(),
  /** 拼车额度对账。后端没接这一块（老后端）没有这一项。 */
  carpoolReconcile: CarpoolReconcileViewSchema.optional(),
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

/**
 * 提醒的处理状态（design 15.3「谁在处理」）：读时从认领、PR 镜像、发布记录现算（@fleet-dao/core 的 alertHandling），
 * 不另存。判法和这几个名字在 core 里用的是同一份。
 */
export const ALERT_STAGES = [
  'resolved',
  'silenced',
  'waiting_founder',
  'unclaimed',
  'pr_open',
  'merged',
  'deployed',
] as const;

/** 提醒挂的单、修它的 PR 在哪个仓：链接由驾驶舱按品牌拼（正式版给 GitHub 外链，演示版不给），后端不发网址。 */
const AlertRepoSchema = z.object({ owner: z.string(), name: z.string() });

export const AlertHandlingSchema = z.object({
  stage: z.enum(ALERT_STAGES),
  /** 阶段说成人话：没人在修、有人在修、PR 开着、合进主线、等发布…… */
  stageText: z.string(),
  /** 进这个阶段的时刻：「多久了」从它算。 */
  since: Time,
  /** 谁在处理：PR #号、建静默的人、创始人；没人是空（认领账 2026-10-03 起整张删掉，不再有「机器/工人」）。 */
  who: z.string().optional(),
  /** 跟进单：提醒挂的任务的单，或者 alert_work 表里挂的单（原来「提醒派单」自动开、`alert claim` 手动挂，#445 起这两条写路都删了，只留历史挂的）。 */
  work: z.object({ repo: AlertRepoSchema, issueNumber: z.number().int().positive() }).optional(),
  /** 带动这个阶段的 PR。 */
  pr: z
    .object({
      repo: AlertRepoSchema,
      number: z.number().int().positive(),
      state: z.enum(['open', 'closed', 'merged']),
    })
    .optional(),
  silence: z.object({ by: z.string(), comment: z.string(), endsAt: Time }).optional(),
  /** 合了以后才有：发布了没有；判不了写为什么。 */
  deploy: z
    .object({ state: z.enum(['deployed', 'not_yet', 'unknown']), why: z.string().optional() })
    .optional(),
  /** 给人看的一行：「PR #350 在处理 · owner/仓#342 · PR #350 开着 · 35 分钟」。 */
  line: z.string(),
  /** 没查成的，一条一句。 */
  problems: z.array(z.string()),
});

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
  /** 谁在处理、修到哪（现算）；这一页没算成时整页的 handlingProblem 写为什么。 */
  handling: AlertHandlingSchema.optional(),
});

export const NotificationsQuery = PageQuery.extend({
  status: z.enum(['open', 'all']).default('open'),
});
export const NotificationsResponse = z.object({
  items: z.array(NotificationSchema),
  nextCursor: Cursor.optional(),
  /** 这一页「谁在处理」没算成：为什么（没接上、读不到库）。算成了没有这一项。 */
  handlingProblem: z.string().optional(),
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

/**
 * 额度留量线的一个比例（#194 方案 4.8）：已用到这个比例，引擎就不再往这个渠道派新活、也不切过去。0–1，不收负数、大于 1、
 * 不是数字的值。null = 明确不限；不写这个窗口 = 未配置（也是不限）。
 */
const ReserveRatioSchema = z.number().min(0, '留量线不能小于 0').max(1, '留量线不能大于 1（100%）');
export const PoolReserveLinesSchema = z.strictObject({
  '5h': ReserveRatioSchema.nullable().optional(),
  '7d': ReserveRatioSchema.nullable().optional(),
  '7d_model': ReserveRatioSchema.nullable().optional(),
  month_usd: ReserveRatioSchema.nullable().optional(),
  points: ReserveRatioSchema.nullable().optional(),
  period_usd: ReserveRatioSchema.nullable().optional(),
  other: ReserveRatioSchema.nullable().optional(),
});
/** 账号池编号 → 这个池各额度窗的留量线（按池配，池就是额度页上的「渠道」一行）。 */
export const QuotaReserveSettingSchema = z.record(z.string().min(1), PoolReserveLinesSchema);
// 窗口种类加了一种、这里漏了，tsc 当场报错
export const RESERVE_KEYS_MATCH_WINDOWS: Same<keyof z.infer<typeof PoolReserveLinesSchema>, QuotaWindowKind> =
  true;

/** 驾驶舱能改的全局设置。新增一项就在这里加一行；不在表里的键一律拒收。 */
export const SETTING_SCHEMAS = {
  /** 同时跑的 AI 会话上限（设计文档第四节：起步 6 个）。 */
  'sessions.maxConcurrent': z.number().int().min(1).max(32),
  /** 飞书免打扰时段（北京时间）；null = 不设。 */
  'notify.quietHours': z.object({ start: HHMM, end: HHMM }).nullable(),
  /** Jev 每天最多调用多少次。 */
  'judge.dailyCallLimit': z.number().int().min(0).max(100_000),
  /**
   * 引擎暂不用独享（#194 方案 v2 4.8）：开着时拼车用不了也不切独享，Claude 的活等拼车恢复或交给别家模型——创始人自己要大用
   * 独享时一键关掉引擎这一路。已经挂着独享时不受影响（该切回照切回）。没设过 = false。
   */
  'engine.soloPaused': z.boolean(),
  /**
   * 每个渠道（账号池）的额度留量线（#194 方案 4.8，创始人 2026-10-04：「到了配置额度，这个渠道就不能用了……是全渠道配置项」）：
   * {池编号: {窗口: 比例 | null}}。已用到线，选路不再派新活到这个池、切号也不切过去。代码里没有任何默认值：起始值在种子文件
   * packages/db/quota-reserve.default.json（装载器只补缺装进库），之后在驾驶舱改。这个池没写 = 不限（驾驶舱写「未配置」）；
   * 库里没有这一行 = 种子没装上，明确失败（引擎不派、不切），不当成不限。
   */
  'engine.quotaReserve': QuotaReserveSettingSchema,
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

// —— 演示版：游客能看什么（设计文档第十四节）——

/** 演示版里能逐个开关的模块。总览跟着看板走，任务清单跟着任务详情走。 */
export const DEMO_MODULES = [
  'board',
  'task',
  'quota',
  'schedules',
  'notifications',
  'audit',
  'settings',
] as const;
export const DemoModuleSchema = z.enum(DEMO_MODULES);

/**
 * 细节看到哪一级：status = 只看状态和耗时（标题换成「需求 #12」这类编号）；titles = 还能看任务标题；
 * process = 还能看步骤清单和过程（原话、追问、会话时间线、日志）。
 */
export const DemoDetailSchema = z.enum(['status', 'titles', 'process']);

/**
 * 删掉的模块（调度台、渠道页，#556）：法国上已经写下的范围文件（default.json、各链接的）里还有它们，
 * 读的时候丢掉、不当成「读不懂」——否则演示链接列表、每小时撤过期链接、香港同步都会整个停下。
 */
export const RETIRED_DEMO_MODULES: readonly string[] = ['dispatch', 'channels'];

const DemoModuleList = z.preprocess(
  (v) => (Array.isArray(v) ? v.filter((m) => !RETIRED_DEMO_MODULES.includes(m)) : v),
  z
    .array(DemoModuleSchema)
    .max(DEMO_MODULES.length)
    .refine((ms) => new Set(ms).size === ms.length, { message: '同一个模块不能出现两次' }),
);

/**
 * 可见范围文件：后端发布到静态托管上，演示版只读它（法国停了照样能看）。演示链接的那份按链接口令的
 * SHA-256（十六进制）命名，不带链接打开时读 default.json。只放游客能看什么，不放备注、创建人——
 * 拿到链接的人都读得到这个文件。
 */
export const DemoScopeSchema = z.object({
  v: z.literal(1),
  modules: DemoModuleList,
  detail: DemoDetailSchema,
  /** 到期时刻；没有 = 不过期（默认范围不过期）。 */
  expiresAt: Time.optional(),
});
export type DemoScope = z.infer<typeof DemoScopeSchema>;

/** 不带链接、默认范围也没发布过（或读不到）时用这一份：默认从严，只看看板、只看状态和耗时。 */
export const DEMO_STRICT_DEFAULT: DemoScope = { v: 1, modules: ['board'], detail: 'status' };

/** 默认范围文件的名字；演示链接的文件名是 64 位十六进制，不会和它撞。 */
export const DEMO_DEFAULT_SCOPE_FILE = 'default.json';

export const DemoLinkSchema = z.object({
  /** 链接口令的 SHA-256（十六进制），也是可见范围文件的名字。口令本身只在新建时返回一次，后端不存。 */
  id: z.string().regex(/^[0-9a-f]{64}$/),
  modules: DemoModuleList,
  detail: DemoDetailSchema,
  expiresAt: Time,
  /** 发给谁、为什么（只在驾驶舱里看得到，不进可见范围文件）。 */
  note: z.string().optional(),
  createdAt: Time,
  createdBy: z.string().optional(),
  /** 过期了：可见范围文件已撤掉，演示版按默认范围显示。 */
  expired: z.boolean(),
});

export const DemoLinksResponse = z.object({
  /** 后端配了发布目录没有（FLEET_DEMO_DIR）。没配时发不了链接——不是「没有链接」。 */
  configured: z.boolean(),
  links: z.array(DemoLinkSchema),
  /** 不带链接打开时的范围；defaultPublished=false 表示还没发布过，演示版用内置的从严那份。 */
  defaultScope: DemoScopeSchema,
  defaultPublished: z.boolean(),
});

export const CreateDemoLinkRequest = z.object({
  modules: DemoModuleList.refine((ms) => ms.length > 0, { message: '至少开一个模块' }),
  detail: DemoDetailSchema,
  /** 有效天数，到期自动失效；随时可以提前作废。 */
  expiresInDays: z.number().int().min(1).max(90),
  note: z.string().trim().max(60).optional(),
});
export const CreateDemoLinkResponse = z.object({
  link: DemoLinkSchema,
  /**
   * 链接口令：只在这里出现一次，演示版地址后面加 ?k=<它>。演示版在哪由发布脚本定、构建时写进驾驶舱前端，
   * 完整链接由前端拼，后端不管演示版的地址。
   */
  token: z.string().min(32).max(64),
});
export const RevokeDemoLinkResponse = z.object({ ok: z.literal(true) });

export const UpdateDemoDefaultRequest = z.object({
  modules: DemoModuleList,
  detail: DemoDetailSchema,
});
export const UpdateDemoDefaultResponse = z.object({ defaultScope: DemoScopeSchema });

// —— 发布：/changelog 页的「发布 v<N>」（#725）——

const MilestoneRefSchema = z.object({ number: z.number().int().positive(), title: z.string() });

/**
 * 这一版发出去叫什么：后端现读 GitHub 上开着的里程碑，照 `pnpm publish:pr` 同一份判法定（conventions 的 releaseVersion：
 * 当前版本里程碑＝开着的 v<N> 里 N 最小的那张，再拿仓根 CHANGELOG.md 已发的版本核一遍）。三种结果分开，都不拿「上一版 +1」顶：
 * - ok：定得出。
 * - blocked：读到了，判法不让发（一张版本里程碑都没开、CHANGELOG.md 已经有这一版或比它新的）；why 是判法的原话，
 *   这时跑 publish:pr 也一样被拒。
 * - unreadable：没读成（GitHub、CHANGELOG.md、这台后端没接上），why 写为什么。
 */
export const ReleaseVersionResponse = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('ok'),
    /** v<N>：当前版本里程碑的版本号。 */
    version: z.string().regex(/^v\d+$/),
    /** 这一版的里程碑：发布 PR 合并之后 release.yml 关的就是它。 */
    milestone: MilestoneRefSchema,
    /** 还开着的别的版本里程碑（发布 PR 正文里也列）：这次不发它们。 */
    others: z.array(MilestoneRefSchema),
    /** 读 GitHub 的时刻。 */
    asOf: Time,
  }),
  z.object({ state: z.literal('blocked'), why: z.string().min(1), asOf: Time }),
  z.object({ state: z.literal('unreadable'), why: z.string().min(1), asOf: Time }),
]);

// —— 新主页（/）：一屏三块 + 持续状态条（#589）——

/**
 * 「要你拍的」一条：decision 级通知（approvals 未决开的时候就经 openApproval 同步写了这么一条，
 * 不另查 approvals 表，免得一条事显示两回）+ 还没答的追问。
 */
export const HomeDecisionSchema = z.object({
  kind: z.enum(['notification', 'approval', 'ask']),
  id: Id,
  title: z.string(),
  /** 来源需求 / PR / 会话的一句话背景；没有就没有这个键。 */
  context: z.string().optional(),
  since: Time,
  /** 站内路径：通知详情 / 任务详情。 */
  link: z.string(),
});

/** 「在跑的」一张单。segment 还没接上（#556-1+ 落真时补）：现在一律 null，不许按字段猜成失败。 */
export const HomeRunningSchema = z.object({
  issueNumber: z.number().int().positive(),
  title: z.string(),
  /** owner/name。 */
  repo: z.string(),
  /** 卡在哪一段；还没接上（null）。verify_pending 是「合完在等 CI / 等验」，不是失败。 */
  segment: z.enum(['scoping', 'doing', 'verifying', 'verify_pending', 'merge']).nullable(),
  /** 为什么这一刻没进展。nothing = 正常在跑。 */
  waitingReason: z.enum([
    'queue',
    'memory',
    'quota_reset',
    'ci',
    'verify_round',
    'founder_decision',
    'merge_queue',
    'nothing',
  ]),
  /** 从什么时候起在等；waitingReason === 'nothing' 时没有。 */
  waitingSince: Time.optional(),
  /** 站内路径：任务详情。 */
  link: z.string(),
});

/**
 * 「做完的」一篇 PR。链接前端按品牌拼（brand.repoLink，和 alert-work 一个规矩：后端不发网址）；
 * 这里给拼链接要的两段（repo 拆 owner/name 由前端按字符串切，和 alert-work 的 repoRef 一个切法）。
 */
export const HomeDoneSchema = z.object({
  prNumber: z.number().int().positive(),
  title: z.string(),
  /** owner/name。 */
  repo: z.string(),
  mergedAt: Time,
  /** 这篇 PR 挂的单（issueRefs 反查到的）；一个都没挂上没有这个键。 */
  issueNumber: z.number().int().positive().optional(),
});

/**
 * 持续状态条：额度、中转、引擎开关。有问题一直显示、不伪装成失败（tight/degraded/off 都不是「坏了」）。
 * engine 一项：后端读的是这台机器 release.env 的 FLEET_SERVICES（库自主管理才写的期望；运行时状态由 Temporal 拉，
 * 本切片只展示这个开关）。读不到（开发环境、机器上没有 release.env）按开着算，和 config.ts 的 engineEnabled 一个判法。
 */
export const HomeHealthSchema = z.object({
  quota: z.object({
    state: z.enum(['ok', 'tight', 'empty', 'unknown']),
    detail: z.string(),
  }),
  routes: z.object({
    state: z.enum(['ok', 'degraded', 'unknown']),
    detail: z.string(),
  }),
  engine: z.object({
    state: z.enum(['on', 'off']),
    detail: z.string().optional(),
  }),
});

export const HomeResponseSchema = z.object({
  decisions: z.array(HomeDecisionSchema),
  running: z.array(HomeRunningSchema),
  done: z.array(HomeDoneSchema),
  health: HomeHealthSchema,
  asOf: Time,
});

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
  credentials: { method: 'GET', path: '/me/credentials', response: CredentialsResponse },
  /** 成功 204，没有响应体。 */
  updateCredentials: { method: 'PUT', path: '/me/credentials', request: UpdateCredentialsRequest },
  events: { method: 'GET', path: '/events' },
  repos: { method: 'GET', path: '/repos', response: ReposResponse },
  /** 新主页（/）的一屏三块 + 持续状态条，一个往返聚齐（#589）。 */
  home: { method: 'GET', path: '/home', response: HomeResponseSchema },
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
  routingLayers: { method: 'GET', path: '/routing/layers', response: RoutingLayersResponse },
  routingEfforts: { method: 'GET', path: '/routing/efforts', response: RoutingEffortsResponse },
  updateRouteEffort: {
    method: 'PUT',
    path: '/routing/efforts/:modelId/:routeId',
    request: UpdateRouteEffortRequest,
    response: UpdateRouteEffortResponse,
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
  /** /changelog 页「发布 v<N>」的版本号（#725）：现读 GitHub 里程碑，和 pnpm publish:pr 同一份判法。 */
  releaseVersion: { method: 'GET', path: '/release/version', response: ReleaseVersionResponse },
  demoLinks: { method: 'GET', path: '/demo/links', response: DemoLinksResponse },
  createDemoLink: {
    method: 'POST',
    path: '/demo/links',
    request: CreateDemoLinkRequest,
    response: CreateDemoLinkResponse,
  },
  revokeDemoLink: { method: 'DELETE', path: '/demo/links/:linkId', response: RevokeDemoLinkResponse },
  updateDemoDefault: {
    method: 'PUT',
    path: '/demo/default',
    request: UpdateDemoDefaultRequest,
    response: UpdateDemoDefaultResponse,
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
  /** 成功 204 + 会话 Cookie，没有响应体。 */
  passwordLogin: { method: 'POST', path: '/password/login', request: PasswordLoginRequest },
  /** 退出 = 这个人所有设备上的会话都作废（之后拿旧 Cookie 请求回 401 session_revoked）。 */
  logout: { method: 'POST', path: '/logout' },
  devLogin: { method: 'POST', path: '/dev-login', request: DevLoginRequest, response: MeResponse },
} as const;
