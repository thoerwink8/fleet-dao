// 后端依赖的外部能力，一律按接口写：数据库（packages/db）、Temporal、飞书、GitHub 补收由各自的实现接进来，
// 测试和本地开发用 memory-store.ts 等假实现。改接口之前：db 包按这里实现，签名变了两边一起改。
import type {
  AuditEntrySchema,
  Ban,
  Channel,
  HistoryResponse,
  Model,
  Pool,
  ProgressKind,
  QuotaWindow,
  Repo,
  Route,
  SessionRun,
  StageKind,
  StagePolicy,
  Step,
  Subtask,
  Task,
} from '@fleet-dao/shared';
import type { z } from 'zod';

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
  cursor?: string | undefined;
  limit: number;
}

// —— 记录形状（数据库包按这些返回）——

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

/** 时间线上的一条原始记录；后端按 kind 和 payload 拼白话。 */
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
  lastRun?:
    | {
        startedAt: string;
        endedAt?: string | undefined;
        outcome?: 'ok' | 'unscanned' | 'failed' | undefined;
        found?: number | undefined;
        why?: string | undefined;
      }
    | undefined;
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
  /** 每改一次加 1；从没设过的键不在结果里。 */
  version: number;
  updatedAt?: string | undefined;
  updatedBy?: string | undefined;
}

/** 一次会话在 fleet 命令眼里的样子。令牌只对它有效；endedAt 有值后令牌作废。 */
export interface AgentSession {
  runId: string;
  taskId: string;
  subtaskId?: string | undefined;
  stage: StageKind;
  repoId: string;
  branch: string;
  /** 做完标准（引擎从需求文档写进库）。 */
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

/** 会话里跑过的一次测试：插头从过程记录里读出来，记成 kind=test 的进度（载荷至少带 passed，最好带 command）。 */
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

// —— 数据访问（按用途拆开，db 包可以分批实现）——

export interface UserStore {
  getUser(id: string): Promise<User | null>;
  findUserByFeishu(ids: { openId: string; unionId?: string | undefined }): Promise<User | null>;
  listUsers(): Promise<User[]>;
}

export interface BoardStore {
  listRepos(): Promise<Repo[]>;
  getRepo(id: string): Promise<Repo | null>;
  /** 看板上的需求：没结束的，加上最近 7 天内结束的。 */
  listBoardTasks(repoId: string): Promise<Task[]>;
  getTask(id: string): Promise<Task | null>;
  listSubtasks(taskIds: readonly string[]): Promise<Subtask[]>;
  /** active=true 只要没结束的会话（endedAt 为空）。 */
  listRuns(filter: {
    taskIds?: readonly string[] | undefined;
    active?: boolean | undefined;
  }): Promise<SessionRun[]>;
  getRun(id: string): Promise<SessionRun | null>;
  /** 每个会话最新的步骤清单；没报过的会话不在结果里。 */
  getPlans(runIds: readonly string[]): Promise<Map<string, RunPlan>>;
  lastSay(runId: string): Promise<{ text: string; at: string } | null>;
  /**
   * 一个需求的时间线，三处来源合在一起按时间倒序（memory-store.ts 是参照实现）：
   * - 这个需求所有会话的进度（source=session，kind 就是 ProgressKind，payload 原样）；
   * - 引擎记的状态变化（source=engine，kind=state，payload { from, to }）；
   * - target=`task:<id>` 的操作记录（人做的 source=person，会话里的 AI 做的 source=session，其余 engine；
   *   kind 取 action 最后一段，如 task.pause → pause、agent.done_rejected → done_rejected；
   *   payload 是 after 加上 reason、ok、error）。
   * 游标由实现决定，建议用 (at, id) 做键，翻页不漏同一时刻的多条。
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
  listBans(): Promise<Ban[]>;
  listQuotaWindows(): Promise<QuotaWindow[]>;
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
  listJobs(): Promise<JobRecord[]>;
  listNotifications(query: { status: 'open' | 'all' } & PageRequest): Promise<Page<NotificationRecord>>;
  resolveNotification(
    input: { id: string; by: Actor },
    audit: NewAuditEntry,
  ): Promise<'ok' | 'already_resolved' | 'not_found'>;
  appendAudit(entry: NewAuditEntry): Promise<string>;
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
  /** fleet plan：整张清单替换，同时记一条 kind=plan 的进度（载荷 { steps }），时间线要用。 */
  savePlan(runId: string, steps: Step[]): Promise<void>;
  /** 会话主动报的进度（say / ask / done / blocked），进 ProgressEvent。 */
  appendProgress(runId: string, kind: ProgressKind, payload: unknown): Promise<void>;
  /** 开一条追问。同一会话问过一模一样的一句就复用那一条（created=false），命令重试不会刷屏。 */
  openAsk(input: {
    runId: string;
    taskId: string;
    question: string;
    options: string[];
  }): Promise<{ ask: AskRecord; created: boolean }>;
  searchHistory(input: { repoId: string; query: string; limit: number }): Promise<HistoryItem[]>;
  getPullRequest(repoId: string, number: number): Promise<PullRequestRecord | null>;
  listTestRuns(runId: string): Promise<TestRunRecord[]>;
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
  /** 发给这个需求的工作流。工作流不存在或已结束时抛 WorkflowGoneError。 */
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

// —— 数据变化（Postgres LISTEN/NOTIFY）——

/** change = 某张表的某一行变了；resync = 推送断过，之间的变化可能丢了，订阅方要全量重拉。 */
export type FeedEvent = { type: 'change'; table: string; id: string } | { type: 'resync' };

export interface ChangeFeed {
  /** 返回退订函数。 */
  subscribe(listener: (event: FeedEvent) => void): () => void;
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
