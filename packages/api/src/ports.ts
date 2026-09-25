// 后端依赖的外部能力，一律按接口写：数据库（pg-store.ts 用 @fleet-dao/db 实现）、Temporal、飞书、GitHub 补收
// 由各自的实现接进来；测试和本地开发用 memory-store.ts。两个 Store 实现过同一套契约测试（test/store-contract.ts），
// 改这里的语义要两边一起改、契约测试跟着改。
import type {
  AuditEntrySchema,
  Ban,
  Channel,
  HistoryResponse,
  Model,
  Pool,
  ProgressKind,
  QuotaWindow,
  RealtimeTable,
  Repo,
  Route,
  ScheduleOutcome,
  SessionRun,
  StageKind,
  StagePolicy,
  Step,
  Subtask,
  Task,
} from '@fleet-dao/shared';
import type { z } from 'zod';

/** 库里的一行额度窗：原名、单位、读法入库必填（领域类型里可选，是给还没入库的读数用的）；staleSince 由库的写入口管。 */
export type QuotaWindowRecord = QuotaWindow & Required<Pick<QuotaWindow, 'label' | 'unit' | 'source'>>;

// —— 人 ——

export type UserRole = 'founder' | 'collaborator' | 'bot';

/**
 * users 表的一行，两用：驾驶舱登录白名单（只放 role=founder）+ GitHub 作者白名单（创始人、协作者、自家机器人）。
 * 机器人只按 GitHub 数字编号认。
 */
export interface User {
  id: string;
  displayName: string;
  role: UserRole;
  active: boolean;
  avatarUrl?: string | undefined;
  /** 飞书 open_id（应用内唯一）；登录只认它或 union_id，不认邮箱和手机号（飞书文档：那两项未经本人验证）。 */
  feishuOpenId?: string | undefined;
  feishuUnionId?: string | undefined;
  githubLogin?: string | undefined;
  /** 有数字编号就只按编号认（登录名可改、可被别人注册）。 */
  githubId?: number | undefined;
}

/** 谁做的。user = 驾驶舱用户；ai = AI 帅位；engine = 引擎；agent = 会话里的 AI。 */
export interface Actor {
  kind: 'user' | 'ai' | 'engine' | 'agent';
  id: string;
}

export type AuditRecord = z.infer<typeof AuditEntrySchema>;
export type AuditVia = AuditRecord['via'];

/** 操作记录只追加。ok=false 必须带 error（库里有约束，内存版照样拦）。 */
export interface NewAuditEntry {
  actor: Actor;
  action: string;
  target: string;
  before?: unknown;
  after?: unknown;
  reason?: string | undefined;
  via: AuditVia;
  ok: boolean;
  error?: string | undefined;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string | undefined;
}

export interface PageRequest {
  /** 上一页的 nextCursor。看不懂就抛 InvalidCursorError（翻页的方法都这样）。 */
  cursor?: string | undefined;
  limit: number;
}

// —— 记录形状 ——

export interface RunPlan {
  steps: Step[];
  updatedAt: string;
}

export interface AskRecord {
  id: string;
  taskId: string;
  runId?: string | undefined;
  question: string;
  options: string[];
  askedAt: string;
  answer?: string | undefined;
  answeredBy?: string | undefined;
  answeredAt?: string | undefined;
}

/** 时间线上的一条原始记录；后端按 kind 和 payload 拼白话（views.ts 的 describeTimeline）。 */
export interface TimelineRecord {
  id: string;
  at: string;
  source: 'session' | 'engine' | 'person';
  kind: string;
  runId?: string | undefined;
  subtaskId?: string | undefined;
  payload?: unknown;
}

export interface JobRecord {
  id: string;
  name: string;
  schedule: string;
  expectEveryMinutes: number;
  /** 最近一次（按开始时刻）；一次都没跑过就没有。 */
  lastRun?:
    | {
        startedAt: string;
        endedAt?: string | undefined;
        /** 还在跑时没有。 */
        outcome?: ScheduleOutcome | undefined;
        scanned?: number | undefined;
        found?: number | undefined;
        why?: string | undefined;
      }
    | undefined;
  /** 最近一次跑成（ok 或 partial）的结束时刻。 */
  lastSuccessAt?: string | undefined;
}

export interface DeliveryRecord {
  channel: string;
  /** 飞书返回的消息编号；没有就是没送到。 */
  messageId?: string | undefined;
  attempts: number;
  error?: string | undefined;
  lastAttemptAt?: string | undefined;
}

export interface NotificationRecord {
  id: string;
  level: 'decision' | 'alert' | 'daily';
  title: string;
  body: string;
  link?: string | undefined;
  taskId?: string | undefined;
  createdAt: string;
  resolvedAt?: string | undefined;
  resolvedBy?: string | undefined;
  deliveries: DeliveryRecord[];
}

export interface SettingRecord {
  key: string;
  value: unknown;
  /** 每改一次加 1，第一次写入是 1；从没设过的键不在结果里。 */
  version: number;
  updatedAt?: string | undefined;
  updatedBy?: string | undefined;
}

/**
 * 一次会话在 fleet 命令眼里的样子（由会话、需求、仓拼出来）。令牌只对它有效；endedAt 有值后令牌作废。
 * 不属于任何需求的会话（帅位、考新模型）没有这个样子，拿不到 fleet 令牌。
 */
export interface AgentSession {
  runId: string;
  taskId: string;
  subtaskId?: string | undefined;
  stage: StageKind;
  repoId: string;
  /** 引擎给这次会话建了分支才有。 */
  branch?: string | undefined;
  /** 做完标准（需求上的 acceptance）。 */
  acceptance: string[];
  endedAt?: string | undefined;
}

/** GitHub 镜像里的 PR。checks = 当前 head 上 CI 的汇总。 */
export interface PullRequestRecord {
  repoId: string;
  number: number;
  state: 'open' | 'closed' | 'merged';
  headRef: string;
  headSha: string;
  checks: 'success' | 'failure' | 'pending' | 'none';
}

/** 会话里跑过的一次测试：从 kind=test 的进度里读出来的，载荷带布尔 passed 的才算（读不出结果的不算证据）。 */
export interface TestRunRecord {
  at: string;
  passed: boolean;
  command?: string | undefined;
}

export type HistoryItem = z.infer<typeof HistoryResponse>['items'][number];

export interface StagePolicyValue {
  routeIds: string[];
  pinned: boolean;
}

/**
 * 幂等键的状态：
 * - claimed：这次占到了，去执行。token 是这次占用的凭据，记结果、放键都要拿它（被接管后旧凭据就作废）；
 *   tookOver = 接过了一个多半已经死掉的占用。
 * - done：以前执行成功过，直接回当时的结果。
 * - in-flight：上一次还在处理。
 * - other-action：这个键已经用在别的命令上了（一条命令一个键）。
 */
export type CommandClaim =
  | { status: 'claimed'; token: string; tookOver?: true }
  | { status: 'done'; result: unknown }
  | { status: 'in-flight'; claimedAt: string }
  | { status: 'other-action'; action: string };

// —— 数据访问（按用途拆开）——
// 所有按编号查的方法：编号格式不对（例如不是 uuid）当作「没有」，不抛错——编号来自网址，不能让它变成 500。

export interface UserStore {
  getUser(id: string): Promise<User | null>;
  findUserByFeishu(ids: { openId: string; unionId?: string | undefined }): Promise<User | null>;
  listUsers(): Promise<User[]>;
}

export interface BoardStore {
  listRepos(): Promise<Repo[]>;
  getRepo(id: string): Promise<Repo | null>;
  /** 看板上的需求：没结束的，加上进入终态不到 7 天的。按优先级、再按建单先后排。 */
  listBoardTasks(repoId: string): Promise<Task[]>;
  getTask(id: string): Promise<Task | null>;
  listSubtasks(taskIds: readonly string[]): Promise<Subtask[]>;
  /** taskIds 给了就只要这些需求的会话（不属于任何需求的会话不在其中）；active=true 只要没结束的。 */
  listRuns(filter: {
    taskIds?: readonly string[] | undefined;
    active?: boolean | undefined;
  }): Promise<SessionRun[]>;
  getRun(id: string): Promise<SessionRun | null>;
  /** 每个会话最近一次 fleet plan 的步骤清单；没报过的会话不在结果里。 */
  getPlans(runIds: readonly string[]): Promise<Map<string, RunPlan>>;
  lastSay(runId: string): Promise<{ text: string; at: string } | null>;
  /**
   * 一个需求的时间线，按 (at, id) 倒序，游标翻页不重不漏。来源：状态变化（kind=state）、会话排队 / 开工 / 结束
   * （run_queued / run_started / run_ended）、会话进度（kind 就是 ProgressKind，量大的 tool / file 不放）、
   * target 是这个需求或它的子任务的操作记录（kind 取 action 最后一段）、挂在这个需求上的通知（notification）。
   * memory-store.ts 是参照实现。
   */
  listTimeline(taskId: string, page: PageRequest): Promise<Page<TimelineRecord>>;
  listAsks(taskId: string): Promise<AskRecord[]>;
  getAsk(id: string): Promise<AskRecord | null>;
  /** 写回答，和操作记录同一事务。已经答过就不改。 */
  answerAsk(
    input: { askId: string; answer: string; by: Actor },
    audit: NewAuditEntry,
  ): Promise<'ok' | 'already_answered' | 'not_found'>;
}

export interface RoutingStore {
  listChannels(): Promise<Channel[]>;
  listPools(): Promise<Pool[]>;
  listModels(): Promise<Model[]>;
  listRoutes(): Promise<Route[]>;
  listStagePolicies(): Promise<StagePolicy[]>;
  /** 库里另配的禁令（两条全局硬禁令写死在 shared/bans.ts，不在这里）。 */
  listBans(): Promise<Ban[]>;
  /** 按（池, 原名 label）排。上游这次没报的窗口也在（带 staleSince），满 24 小时库里才删。 */
  listQuotaWindows(): Promise<QuotaWindowRecord[]>;
  /** 比较后再改：库里的现值不等于 expected 就不改、返回 conflict。和操作记录同一事务。还没有这一行时现值按「空列表、没钉住」算。 */
  updateStagePolicy(
    input: { stage: StageKind; expected: StagePolicyValue; next: StagePolicyValue },
    audit: NewAuditEntry,
  ): Promise<'ok' | 'conflict'>;
  setChannelEnabled(
    input: { channelId: string; enabled: boolean },
    audit: NewAuditEntry,
  ): Promise<'ok' | 'not_found'>;
}

export interface OpsStore {
  /** 登记过的定时任务全列出来（一次都没跑过的也列）。 */
  listJobs(): Promise<JobRecord[]>;
  /** 按 (建立时刻, id) 倒序。 */
  listNotifications(query: { status: 'open' | 'all' } & PageRequest): Promise<Page<NotificationRecord>>;
  resolveNotification(
    input: { id: string; by: Actor },
    audit: NewAuditEntry,
  ): Promise<'ok' | 'already_resolved' | 'not_found'>;
  appendAudit(entry: NewAuditEntry): Promise<string>;
  /** 按 (at, id) 倒序。 */
  listAudit(query: { target?: string | undefined } & PageRequest): Promise<Page<AuditRecord>>;
  listSettings(): Promise<SettingRecord[]>;
  /** expectedVersion 对不上就不改、返回 conflict（0 = 预期还没设过）。和操作记录同一事务。 */
  putSetting(
    input: { key: string; value: unknown; expectedVersion: number; by: Actor },
    audit: NewAuditEntry,
  ): Promise<'ok' | 'conflict'>;
}

export interface AgentStore {
  getAgentSession(runId: string): Promise<AgentSession | null>;
  /** fleet plan：记一条 kind=plan 的进度，载荷 { steps: [{ title, state }] }（和命令的请求体同形）；最近一条就是现行清单。 */
  savePlan(runId: string, steps: Step[]): Promise<void>;
  /** 会话主动报的进度（say / ask / done / blocked）或插头读出来的（test / file / tool），进 progress_events。 */
  appendProgress(runId: string, kind: ProgressKind, payload: unknown): Promise<void>;
  /**
   * 开一条追问。同一会话问过一模一样的一句就复用那一条（created=false），命令重试不会刷屏。
   * 新开的在同一事务里记一条 kind=ask 的进度（载荷 { askId, question }）：不会有「追问开了、进度没记」，重试也补不回来的半截。
   */
  openAsk(input: {
    runId: string;
    taskId: string;
    question: string;
    options: string[];
  }): Promise<{ ask: AskRecord; created: boolean }>;
  /** 空格分开的每个词都要在标题、原话、需求目录、摘要、结果摘要或改动位置里出现；只找有需求文档索引的需求。 */
  searchHistory(input: { repoId: string; query: string; limit: number }): Promise<HistoryItem[]>;
  getPullRequest(repoId: string, number: number): Promise<PullRequestRecord | null>;
  /** 按时间正序。 */
  listTestRuns(runId: string): Promise<TestRunRecord[]>;
  /**
   * fleet 命令的幂等键（同一会话内）：占键。键被占着没做完、而且是 takeOverBefore 之前占的（那一次多半已经死了）：
   * 原子地接过来——两个请求同时来接，只有一个接得到，另一个看到 in-flight。键用在别的命令上：other-action，不回旧结果。
   */
  claimCommand(input: {
    runId: string;
    key: string;
    action: string;
    takeOverBefore: string;
  }): Promise<CommandClaim>;
  /** 执行成功：记下结果，以后同一个键直接回它。只认自己的凭据：占用已被接管或放掉了就不记，返回 false。 */
  completeCommand(input: { runId: string; key: string; token: string }, result: unknown): Promise<boolean>;
  /** 没执行成功：放掉自己的占用，重试会重新执行。凭据对不上（已被别的请求接管）或已完成的，都不动。 */
  releaseCommand(input: { runId: string; key: string; token: string }): Promise<void>;
}

export interface GitHubStore {
  /** 记下投递编号；同一编号第二次来返回 duplicate。存 Postgres，不放本机文件。 */
  claimDelivery(delivery: {
    id: string;
    event: string;
    source: 'webhook' | 'poll' | 'redelivery';
    receivedAt: string;
  }): Promise<'new' | 'duplicate'>;
  /** 处理失败时撤销登记，让重投或补收还能进来。 */
  releaseDelivery(id: string): Promise<void>;
}

export type Store = UserStore & BoardStore & RoutingStore & OpsStore & AgentStore & GitHubStore;

// —— 发给工作流的信号（Temporal）——

export type TaskSignal =
  | { name: 'pause'; by: string; reason?: string | undefined }
  | { name: 'resume'; by: string }
  | { name: 'stop'; by: string; reason?: string | undefined }
  | {
      name: 'reroute';
      by: string;
      routeId: string;
      subtaskId?: string | undefined;
      reason?: string | undefined;
    }
  | { name: 'answer'; by: string; askId: string; answer: string }
  /** fleet 命令写库之后叫醒工作流（按进展判死活要用）。 */
  | {
      name: 'agentEvent';
      runId: string;
      kind: 'plan' | 'say' | 'ask' | 'done' | 'blocked';
      askId?: string | undefined;
    };

export interface WorkflowControl {
  /** 发给这个需求的工作流。工作流不存在或已结束时抛 WorkflowGoneError；Temporal 还没接上时抛 WorkflowUnavailableError。 */
  signal(taskId: string, signal: TaskSignal): Promise<void>;
}

export class WorkflowGoneError extends Error {
  readonly taskId: string;
  constructor(taskId: string, cause?: unknown) {
    super(`任务 ${taskId} 的工作流不存在或已结束`, { cause });
    this.name = 'WorkflowGoneError';
    this.taskId = taskId;
  }
}

/** 发不了信号：Temporal 客户端没接上或连不上。 */
export class WorkflowUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'WorkflowUnavailableError';
  }
}

/** 翻页游标看不懂：接口回 400（http.ts），不装成空页。判法在 ids.ts 的 parseCursor。 */
export class InvalidCursorError extends Error {
  constructor(message = '翻页游标看不懂（被改过，或者不是这个列表的），从第一页重新翻') {
    super(message);
    this.name = 'InvalidCursorError';
  }
}

/** 连 Temporal 的一份连接：发信号 + 给健康检查用的探活。引擎的 PR 合了以后用 @temporalio/client 实现。 */
export interface TemporalConnection {
  control: WorkflowControl;
  /** 连得上就正常返回，连不上抛错（错误文字只进日志，不对外）。 */
  check(): Promise<void>;
  close(): Promise<void>;
}

// —— 数据变化（Postgres LISTEN/NOTIFY）——

/** change = 某张表的某一行变了；resync = 推送断过，之间的变化可能丢了，订阅方要全量重拉。 */
export type FeedEvent = { type: 'change'; table: RealtimeTable; id: string } | { type: 'resync' };

export interface ChangeFeed {
  /** 返回退订函数。 */
  subscribe(listener: (event: FeedEvent) => void): () => void;
}

// —— 健康检查 ——

/** 一项依赖的探活：正常返回 = 好；抛错 = 坏（错误原文只进日志，对外只报「坏了」）。 */
export interface HealthCheck {
  name: string;
  check(): Promise<void>;
}

// —— 飞书登录 ——

export interface FeishuIdentity {
  openId: string;
  unionId?: string | undefined;
  name: string;
  avatarUrl?: string | undefined;
}

export interface FeishuAuth {
  /** 浏览器登录：飞书授权页地址（带 PKCE）。 */
  authorizeUrl(input: { redirectUri: string; state: string; codeChallenge: string }): string;
  /** 用授权码换身份：先换 user_access_token，再取用户信息。浏览器登录带 redirectUri 与 codeVerifier；客户端内免登两者都不带。 */
  identify(input: {
    code: string;
    redirectUri?: string | undefined;
    codeVerifier?: string | undefined;
  }): Promise<FeishuIdentity>;
}

// —— GitHub 事件 ——

/** 通过签名与白名单之后交给引擎的事件。wake=false 表示只同步镜像、不叫醒工作流（自家机器人的回声）。 */
export interface IngestedEvent {
  deliveryId: string;
  source: 'webhook' | 'poll' | 'redelivery';
  event: string;
  action?: string | undefined;
  repo: string;
  wake: boolean;
  receivedAt: string;
  payload: unknown;
}

export interface GitHubEventSink {
  accept(event: IngestedEvent): Promise<void>;
}

// —— 日志 ——

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}
