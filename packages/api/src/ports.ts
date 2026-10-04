// 驾驶舱后端自己的接口：飞书草稿开单、发给工作流的信号（Temporal）、数据变化推送、健康检查、飞书登录。
// Store 契约、GitHub 事件的接口、Logger 这些「不碰 HTTP」的在 @fleet-dao/store（引擎也用，api 不能被引擎反着依赖）；
// 下面一行把它们转出来，是因为 auth.ts、health.ts、session.ts 这几份安全文件从 './ports.ts' 取类型，它们不跟着改。
import type {
  AbandonCommand,
  ContinueCommand,
  RealtimeTable,
  Repo,
  TASK_SIGNAL_NAMES,
} from '@fleet-dao/shared';

export * from '@fleet-dao/store';

// —— 飞书草稿开单：开 issue + 建任务 + 拉起需求工作流（飞书里确认的草稿用）——
// 和 GitHub 那边的接活（issue 已经在了，进来建任务）方向相反：这里从飞书草稿出发，由后端去开 issue。

/** 飞书里确认了的草稿，交给开单的那一步：开 GitHub issue、建任务行、拉起需求工作流。 */
export interface DraftOpenRequest {
  /** 幂等键：同一个草稿再来（包括后端重启之后），交回第一次开成的那张 issue 和那个任务，不开第二张。 */
  draftId: string;
  repo: Repo;
  /** issue 标题（「我理解为」的第一行截短）。 */
  title: string;
  /** 创始人的原话（「改一下」的补充整句接在后面）。 */
  rawText: string;
  /** 「我理解为」。 */
  understanding: string;
  proposedBy: { userId: string; name: string };
  confirmedBy: { userId: string; name: string };
}

export interface DraftOpenResult {
  /** 库里 tasks.id（开单那一步建的任务行）。 */
  taskId: string;
  issueNumber: number;
}

/**
 * 飞书草稿开单：开 issue + 建任务行 + 拉起需求工作流。确认草稿时调一次；没成的草稿留在「待开单」，后端定时补开
 * （draft-opening.ts）。后端自己计时：到点没回算没成、那次调用挂着期间不再开第二次，所以 signal 中止后要尽快放手。
 * 实现要按 draftId 幂等：确认时和补开时可能同时来、超时之后可能再来，发版重启后后端一起来就会马上再调一遍
 * （「正在开」只记在后端进程里，重启就没了）。所以幂等要记在重启后还查得到的地方，不能靠进程内存：比如开 issue 之前
 * 先在库里按草稿编号占住、开出来马上记下 issue 号，或者 issue 正文带上草稿编号、再来时能查回来。issue 已经开出来、
 * 还没交回结果时进程没了，再来也得认出那张 issue，交回它，不开第二张。
 * 没接上或暂时开不成抛 DraftOpenerUnavailableError；抛别的错也一样留着补开。
 */
export interface DraftOpener {
  open(request: DraftOpenRequest, signal: AbortSignal): Promise<DraftOpenResult>;
  /** 健康检查（/healthz 的 draft_opener）：开不了单就抛（对外的原因用 PublicHealthError），接好了就返回。 */
  check(): Promise<void>;
  /** 只有 notWiredDraftOpener 设：开单压根没接上，健康检查报「未接」（公网看得到的那句话）。真实现不设。 */
  readonly notWired?: string;
}

export class DraftOpenerUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'DraftOpenerUnavailableError';
  }
}

// —— 发给工作流的信号（Temporal）——

/**
 * 驾驶舱后端能发给任务工作流的信号：只有引擎里真有人听的两个（名字和参数形状在 shared/task-signals.ts，引擎的 defineSignal
 * 用同一份）。以前这里还列着 pause / reroute / answer / requireApproval / agentEvent，引擎里没有一个接收处，发出去等于没发（#901）；
 * 要加新信号，先在引擎里接上、在 shared/task-signals.ts 里定名字，再回这里加。路由叫醒（taskRouteWake）只有引擎进程自己发。
 */
export type TaskSignal =
  | ({ name: typeof TASK_SIGNAL_NAMES.continue } & ContinueCommand)
  | ({ name: typeof TASK_SIGNAL_NAMES.abandon } & AbandonCommand);

export interface WorkflowControl {
  /**
   * 发给这条工作流（编号已经算好：调用方按 taskWorkflowIdForTask 查库拼，见 temporal.ts）。
   * 工作流不存在或已结束时抛 WorkflowGoneError；Temporal 连不上、超时时抛 WorkflowUnavailableError。
   */
  signal(workflowId: string, signal: TaskSignal): Promise<void>;
}

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
   * 只由 serviceHealthChecks 按「没接上的那个实现」自带的标记填（比如 notWiredDraftOpener 的 notWired）；
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
