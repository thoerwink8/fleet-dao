// 额度读取器的共用形状。窗口读数的字段名跟 @fleet-dao/shared 的 QuotaWindow 一致（同名字段同义）；
// QuotaWindow 没有的几项（原名、单位、读法、other 类窗口）库表还没有列，入库要 db 那边跟上（见 PR 说明）。
import type { QuotaWindow, QuotaWindowKind } from '@fleet-dao/shared';

/** 窗口归类：在 QuotaWindowKind 之外多一个 other——上游新出的、还没归类的窗口也原样收下，原名在 label。 */
export type ReadingWindowKind = QuotaWindowKind | 'other';

/** 额度数字（used / limit）的单位。上游只给百分比时记 percent，上限记 100。 */
export type QuotaUnit = 'percent' | 'points' | 'usd';

/** 一条窗口读数：每个账号池、每个时间窗各一条。 */
export interface QuotaReading extends Omit<QuotaWindow, 'window'> {
  window: ReadingWindowKind;
  /** 上游对这个窗口的原名（如 7d_claude、weekly_all）。window 是归类，label 是原样；同一池里 label 不重复。 */
  label: string;
  unit: QuotaUnit;
  /** 读法，例如 mirasim-relay、claude-usage、cursor-dashboard、estimate。 */
  source: string;
  /** 上游的原字（Claude 的 severity、中转的 status…）。归不进 upstreamStatus 的也留着给人看，不猜。 */
  statusRaw?: string;
}

export type ReaderType = 'claude-usage' | 'mirasim-relay' | 'cursor-dashboard' | 'grok-billing' | 'estimate';

export type QuotaErrorCode =
  /** 配置写错了。 */
  | 'config'
  /** 凭据文件读不到、或里面没有令牌。 */
  | 'no_credentials'
  /** 上游说没登录、令牌过期或被拒（401/403）。要人重新登录。 */
  | 'auth'
  /** 连不上上游或本机服务。 */
  | 'unreachable'
  /** 上游明确报错（5xx、错误帧、接口说自己没拿到数）。 */
  | 'upstream'
  /** 回包认不出：收到了东西，却一格额度都没认出来（多半是上游改了字段名）。 */
  | 'bad_response'
  /** Claude：这台机器当前挂的不是这个组织。额度只能读当前组织，读取器不切号。 */
  | 'not_current'
  /** 读额度这一下花了钱（本该零成本）。读数不采信，要人查为什么。 */
  | 'read_cost'
  /** 估算：没有用量记录的来源，或来源（日账目录）不在、读不了。 */
  | 'no_usage_source'
  | 'timeout'
  /** 读取器自己出了没预料到的错。 */
  | 'crashed';

export interface QuotaError {
  code: QuotaErrorCode;
  /** 已脱敏，可以直接进日志和驾驶舱。 */
  message: string;
}

export class QuotaReadError extends Error {
  readonly code: QuotaErrorCode;
  constructor(code: QuotaErrorCode, message: string) {
    super(message);
    this.name = 'QuotaReadError';
    this.code = code;
  }
}

/** 订阅信息，能读就读。 */
export interface SubscriptionInfo {
  plan?: string;
  /** 付到哪天。按月自动续费的套餐就是本账期结束（下一次扣费）。 */
  expiresAt?: string;
}

/**
 * 模型组成员表：scope 为某组名的窗口具体扣哪些模型。
 * 没给成员表的组，按「模型 id 含组名、或模型族等于组名」匹配（中转的 7d_claude、7d_fable 就是这个规则）。
 */
export type ScopeMembership = { in: string[] } | { notIn: string[] };

interface PoolResultBase {
  poolId: string;
  channelId: string;
  reader: ReaderType;
  startedAt: string;
  durationMs: number;
  /** 给人看的补充说明，例如「额外用量没开：超出套餐不会自动扣钱」。 */
  notes: string[];
}

export interface PoolReadOk extends PoolResultBase {
  ok: true;
  /** 可以是空数组：上游明说没有额度窗口。这和「没读成」（ok: false）是两回事。 */
  windows: QuotaReading[];
  subscription?: SubscriptionInfo;
  scopeModels?: Record<string, ScopeMembership>;
}

export interface PoolReadFailed extends PoolResultBase {
  ok: false;
  error: QuotaError;
}

export type PoolQuotaResult = PoolReadOk | PoolReadFailed;

export interface QuotaReport {
  startedAt: string;
  finishedAt: string;
  /** 与配置里的池一一对应、顺序相同；读失败的池也在，带失败原因。 */
  results: PoolQuotaResult[];
}

/* ---------------- 配置 ---------------- */

interface PoolConfigBase {
  poolId: string;
  channelId: string;
  /** 给人看的名字，例如「Claude 订阅 · 独享组织」。 */
  name?: string;
  timeoutMs?: number;
}

export type ClaudeOrgKind = 'solo' | 'carpool';

export interface ClaudeUsageConfig extends PoolConfigBase {
  reader: 'claude-usage';
  /** 起 Claude Code 的命令前缀，例如 ["/home/<服务用户>/.local/bin/reclaude"]；/usage 与 org list 都拼在它后面。 */
  command: string[];
  /** 这个池是 reclaude 下的哪个组织。给了就先用 `org list` 核对当前组织，对不上不读。 */
  orgKind?: ClaudeOrgKind;
  cwd?: string;
  /** 额外的环境变量（会话环境一律显式构造，不继承宿主的）。 */
  env?: Record<string, string>;
}

export interface MirasimRelayConfig extends PoolConfigBase {
  reader: 'mirasim-relay';
  port?: number;
  /** 回环令牌文件，默认 ~/.mirasim/run/local-<port>.token。 */
  tokenFile?: string;
}

export interface CursorDashboardConfig extends PoolConfigBase {
  reader: 'cursor-dashboard';
  /** 默认 ~/.config/cursor/auth.json。 */
  authFile?: string;
  baseUrl?: string;
}

export interface GrokBillingConfig extends PoolConfigBase {
  reader: 'grok-billing';
  /** 默认 ~/.grok/auth.json。 */
  authFile?: string;
  baseUrl?: string;
  clientVersion?: string;
}

/** 估算窗口的定义：按我们自己的用量记录算「用了多少」，上限是撞限记下的或创始人定的。 */
export interface EstimateWindowSpec {
  label: string;
  window: ReadingWindowKind;
  /** usd：把记录的 costUsd 加起来；points：把 points 加起来。 */
  unit: 'usd' | 'points';
  periodHours: number;
  /** 给了就是固定窗（从 anchor 起每 periodHours 一格，清零时刻可算）；不给就是往回看 periodHours 的滚动窗。 */
  anchor?: string;
  limit?: number;
  /** 只算这一组模型（按模型 id 含组名或模型族等于组名匹配）。 */
  scope?: string;
}

/** 旧系统 Jev 的日账：<dir>/<YYYY-MM-DD>.json = {tokens, calls}，按 UTC 日切。 */
export interface DailyTokenFilesSource {
  type: 'daily-token-files';
  dir: string;
  usdPerMTok: number;
}

export interface EstimateConfig extends PoolConfigBase {
  reader: 'estimate';
  windows: EstimateWindowSpec[];
  /** 不给就用引擎注入的用量来源（以后从库里给）；两样都没有就报 no_usage_source。 */
  usage?: DailyTokenFilesSource;
}

export type PoolConfig =
  | ClaudeUsageConfig
  | MirasimRelayConfig
  | CursorDashboardConfig
  | GrokBillingConfig
  | EstimateConfig;

export interface QuotaConfig {
  /** 每个池的默认超时；池上的 timeoutMs 优先。 */
  timeoutMs?: number;
  pools: PoolConfig[];
}

/* ---------------- 用量记录（估算的输入） ---------------- */

/** 一段用量：一次会话、一次调用或一天的合计都行，at 是它落在的时刻。 */
export interface UsageRecord {
  poolId: string;
  at: string;
  modelId?: string;
  family?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  points?: number;
}

export type UsageSource = (query: { poolId: string; since: Date; until: Date }) => Promise<UsageRecord[]>;
