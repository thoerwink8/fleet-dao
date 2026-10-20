// 驾驶舱后端自己的接口：发给工作流的信号（Temporal）、数据变化推送、健康检查、飞书登录。
// Store 契约、GitHub 事件的接口、Logger 这些「不碰 HTTP」的在 @fleet-dao/store（引擎也用，api 不能被引擎反着依赖）；
// 下面一行把它们转出来，是因为 auth.ts、health.ts、session.ts 这几份安全文件从 './ports.ts' 取类型，它们不跟着改。
import type {
  AbandonCommand,
  ContinueCommand,
  PauseCommand,
  RealtimeTable,
  RepinCommand,
  RouteWakeCommand,
  TASK_SIGNAL_NAMES,
} from '@fleet-dao/shared';

export * from '@fleet-dao/store';

// —— 发给工作流的信号（Temporal）——

/**
 * 驾驶舱后端能发给任务工作流的信号：引擎里真有人听的（继续、放弃、暂停、现在就换模型、路由叫醒；名字和参数形状在
 * shared/task-signals.ts，引擎的 defineSignal 用同一份）。以前这里还列着 pause / reroute / answer / requireApproval / agentEvent，
 * 引擎里没有一个接收处，发出去等于没发（#901）；要加新信号，先在引擎里接上、在 shared/task-signals.ts 里定名字，再回这里加。
 * 路由叫醒平时由引擎在切号之后发；「继续」再带一发，把睡在等选路里的工作流叫醒（#2392）。
 */
export type TaskSignal =
  | ({ name: typeof TASK_SIGNAL_NAMES.continue } & ContinueCommand)
  | ({ name: typeof TASK_SIGNAL_NAMES.abandon } & AbandonCommand)
  | ({ name: typeof TASK_SIGNAL_NAMES.pause } & PauseCommand)
  | ({ name: typeof TASK_SIGNAL_NAMES.repin } & RepinCommand)
  | ({ name: typeof TASK_SIGNAL_NAMES.routeWake } & RouteWakeCommand);

export interface WorkflowControl {
  /**
   * 发给这条工作流（编号已经算好：调用方按 taskWorkflowIdForTask 查库拼，见 temporal.ts）。
   * 工作流不存在或已结束时抛 WorkflowGoneError；Temporal 连不上、超时时抛 WorkflowUnavailableError。
   */
  signal(workflowId: string, signal: TaskSignal, runId?: string): Promise<void>;
  /** 当前具体运行身份与状态；查不到抛错，不猜最新 run。 */
  taskWorkflowExecution?(
    workflowId: string,
  ): Promise<{ workflowId: string; runId: string; running: boolean }>;
  /**
   * 这张单的信号该打到哪一代（在跑的，或都结束了就最高的那一代）。没给就用第一代编号。
   * 问不清抛 WorkflowUnavailableError，不假装打到第一代。
   */
  runningTaskWorkflow?(repo: { owner: string; name: string }, issueNumber: number): Promise<string>;
  /**
   * 体量关口重评（#3249）：对精确 run、精确停点、精确 head 和固定 base，让工作流自己确认停在体量关口并重新核这一份成果。
   * 先现读 taskStatus 的停点身份（不凭自由文本猜），再发 taskRemeasureLineBudget Update；check 只测，resume 才放行这一份。
   * 没接 Temporal、旧 worker 不认都明确拒绝；Temporal 连不上抛 WorkflowUnavailableError。
   */
  remeasureLineBudget?(request: LineBudgetRemeasureRequest): Promise<LineBudgetRemeasureResponse>;
}

/** 停点编号：parks.generation.continued（预检打印、执行时必须原样带回）。 */
export interface LineBudgetRemeasureRequest {
  workflowId: string;
  runId: string;
  repo: { owner: string; name: string };
  taskId: string;
  head: string;
  base: string;
  mode: 'check' | 'resume';
  /** 执行（resume）必带：预检时看到的停点编号。 */
  park?: string;
  by: string;
}

export interface LineBudgetRemeasureReceiptView {
  head: string;
  base: string;
  rawAddedLines: number;
  verifiedGeneratedLines: number;
  chargeableAddedLines: number;
  budget: number;
  reason: string;
}

export type LineBudgetRemeasureResponse =
  | {
      ok: true;
      outcome: 'eligible' | 'resumed' | 'already_resumed';
      park: string;
      receipt: LineBudgetRemeasureReceiptView;
    }
  | {
      ok: false;
      /** 引擎的拒绝类别（unsupported / identity / stale / busy / unknown / changed / unverified / over_budget）。 */
      reason: string;
      detail: string;
      park?: string;
      /** 工作流此刻停点上的交付头和预算，供人对照；不在体量停点时没有。 */
      current?: { head: string; rawAddedLines: number; chargeableAddedLines: number; budget: number };
    };

export class WorkflowGoneError extends Error {
  readonly workflowId: string;
  constructor(workflowId: string, cause?: unknown) {
    super(`工作流 ${workflowId} 不存在或已结束`, { cause });
    this.name = 'WorkflowGoneError';
    this.workflowId = workflowId;
  }
}

/** 发不了信号、起不了工作流：Temporal 客户端没接上、连不上或超时。 */
export class WorkflowUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'WorkflowUnavailableError';
  }
}

/** 把任务解成工作流编号时，任务或它所在的仓不在库里：拼不出编号，不瞎拼，明确报错。 */
export class WorkflowTargetNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowTargetNotFoundError';
  }
}

/** 连 Temporal 的一份连接：发信号 + 给健康检查用的两项探活。用 @temporalio/client 实现，见 temporal.ts。 */
export interface TemporalConnection {
  control: WorkflowControl;
  /** 连得上、命名空间也在就正常返回；连不上、超时、命名空间不存在都抛错（错误文字只进日志，不对外）。 */
  check(): Promise<void>;
  /** 查 FLEET_TASK_QUEUE 上 workflow、activity 两类 poller 在不在、新不新鲜；不在/太久没拉都抛错。 */
  checkEngine(): Promise<void>;
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

/**
 * 一项依赖的探活：正常返回 = 好（返回一句话的，健康报告里这一项带上它当说明，公网看得到）；抛错 = 坏（错误原文只进日志，
 * 对外只报「坏了」）。
 */
export interface HealthCheck {
  name: string;
  // biome-ignore lint/suspicious/noConfusingVoidType: 多数检查是 async () => {}（Promise<void>），换成 undefined 它们就对不上了
  check(): Promise<void | string>;
  /**
   * 这一项对应的功能压根还没接上（装配时就知道，不是跑出来的）：给了就不跑 check，报「未接」、不算失败。
   * 只由 serviceHealthChecks 按「没接上的那个实现」自带的标记填（比如 judge-health.ts 没配判断题时的 notWired）；
   * check 抛什么都判不成「未接」，接上以后出错照样红。公网看得到：一句中性的话，可以带单号。
   */
  notWired?: string;
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
