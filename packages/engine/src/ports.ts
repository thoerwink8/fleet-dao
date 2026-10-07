import type { HostId, OrgKind, Repo, StageKind, SubtaskState, TaskState } from '@fleet-dao/shared';
import type {
  CiResult,
  Feedback,
  Finding,
  MergeOutcome,
  PlannedSubtask,
  ReviewResult,
  SyncResult,
  TestResult,
  TriageVerdict,
} from './decisions/types.ts';

export type {
  CiResult,
  Feedback,
  Finding,
  MergeOutcome,
  PlannedSubtask,
  ReviewResult,
  SyncResult,
  TestResult,
  TriageVerdict,
};

/** 活动属于哪个需求、哪个子任务。taskId、subtaskId 就是库里 tasks.id、subtasks.id。 */
export interface Scope {
  taskId: string;
  subtaskId?: string;
  /** 方案里的子任务编号（人看的，例如 `login-form`）。 */
  subtaskKey?: string;
}

export interface PortContext {
  /** 叫停或超时时触发。只有调过 heartbeat 的活动才收得到取消。 */
  readonly signal: AbortSignal;
  heartbeat(details?: unknown): void;
  /** 第几次尝试，从 1 开始。 */
  readonly attempt: number;
  /** 上一次尝试最后一次心跳带的内容；接着干的时候用。 */
  readonly lastHeartbeat: unknown;
  /**
   * 这次活动所在的工作流编号（重做后是 task:<仓>#<号>:r2）。没给就退回第一代的编号：
   * 活动测试不经 Temporal，上下文里没有这一项。
   */
  readonly workflowId?: string;
}

/** 端口抛这个，错误码和「能不能重试」原样过 Temporal 边界，失败分流按错误码判。 */
export class PortError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: unknown;
  constructor(code: string, message: string, options: { retryable?: boolean; details?: unknown } = {}) {
    super(message);
    this.name = 'PortError';
    this.code = code;
    this.retryable = options.retryable ?? true;
    this.details = options.details;
  }
}

// ---- 路由

export interface RouteChoice {
  routeId: string;
  poolId: string;
  modelId: string;
  family: string;
  hostId: HostId;
  /**
   * Claude 订阅池的组织类型（pools.org_kind：拼车、独享，共用一个会话用户）：额度用满时不原地睡到清零（失败分流 QT1
   * 的 orgLadder）。别的池、老历史里没有。
   */
  orgKind?: OrgKind;
  /** 这条路由所在的渠道（routes.channel_id）：失败分流换渠道时标哪个渠道不可用。老历史里没有。 */
  channelId?: string;
  /**
   * 选路时给这一段预占上的池的名额（PickRouteInput.reserve，#757，pool_reservations 的编号）：开跑那一行写进去时换成那一行，
   * 没开跑就收场的由起会话的那一边放掉。没要预占的选路（Fusion、对账）、老历史里没有。
   */
  reservationId?: string;
}

export interface PickRouteInput extends Scope {
  stage: StageKind;
  avoidRouteIds: string[];
  /** 整个账号池都不用（封号、额度用满：同一个池的别的路由照样撞）。 */
  avoidPoolIds: string[];
  avoidModelIds: string[];
  /** 人或帅位点名的路由；犯禁令、不在线就不用，并在 why 里写明。 */
  preferRouteId?: string;
  /**
   * 续同一个会话（重试、等完额度、修好机器后人点「继续」）：还是这条路由——暂时派不了就等它，不换；
   * 用不了（下线、被禁）才照常选。账号池被暂停（设备被撤销）时它也放行：这一单就是看人修好了没有的试探。
   */
  stickRouteId?: string;
  /**
   * 这一步要整族避开的模型族：开 PR 前验证只派别家（写这张单的族都在这里）；开了 PR 之后的副手避开 Lead 那一族。点名的、
   * 续会话的路由也照样避开，渠道自己挑模型的（上游串 auto）也不派；避开之后一条都派不出，detail 写明「没有别家可验」，
   * 不拿同族顶。
   */
  avoidFamilies?: string[];
  /** 这一步算界面类的活（改到了页面代码）：禁令按 UI 判，GPT 不派（含审界面）。 */
  uiWork?: boolean;
  /**
   * 流程配置里这一步的模型顺序（0003 第 9 条，目录里的模型 id）：只派这几个模型的路由，按这个先后；同一个模型的几条路由
   * 照路由两层的先后。给了空数组 = 这一步没配模型，派不出。不给 = 照路由两层（用途 → 模型 → 路由，#574；三段一条龙不给）。
   */
  models?: string[];
  /**
   * 三段的一段（动手、验收）来选路（#757）：派得出就当场给这张单（taskId，库里的 tasks.id）的这一段预占一个池的名额，交回的
   * route 带 reservationId；这一段之前预占的作废。预占和数名额在同一把锁下（db 的 pool-runs.ts），几张单同时选路也只放得进
   * 池的上限那么多：选中的池在这一下被别的单占满了，按新的事实重选。不给 = 不预占（Fusion 起会话自己排队；对账只问派不派得出）。
   */
  reserve?: { segment: 'manual' | 'verify' };
  /**
   * 上一次起会话时这个渠道运行中失败、失败分流判了该换渠道（#1118）：选路先在 channel_states 把它标成 disabled（写原因、引发的路由），
   * 再选；选到了别的渠道就记「顺到谁」。同一个失败重复带无妨（覆盖写）。不给 = 没有这回事。
   */
  failedChannel?: FailedChannel;
}

/** 渠道运行中失败（PickRouteInput.failedChannel）。reason 是失败分流的原因（带上游原文），页面原样显示。 */
export interface FailedChannel {
  channelId: string;
  routeId: string;
  modelId: string;
  reason: string;
}

export type PickRouteResult =
  /** why：一句「为什么派给它」；额度没读成的账号池排在后面，被选上时写明「额度未知」。 */
  | { ok: true; route: RouteChoice; why: string }
  | { ok: false; waitFor: 'slot' | 'quota'; detail: string; retryAfterSeconds?: number }
  /** 一条能用的路由都没有（都下线、都被避开、都犯禁令）：等也等不来，交人。 */
  | { ok: false; waitFor: 'none'; detail: string };

// ---- 工作树、测试、GitHub

export interface CreateWorktreeInput extends Scope {
  repo: Repo;
  branch: string;
}

/** 从最新主线建树，并装好依赖（会话里不装）。 */
export interface Worktree {
  path: string;
  branch: string;
  baseSha: string;
}

export interface RemoveWorktreeInput extends Scope {
  repo: Repo;
  path: string;
  branch: string;
  /** 没合并就收（叫停、失败）时先存档未提交的改动。 */
  archive: boolean;
}

export interface RemoveWorktreeResult {
  removed: boolean;
  /** 本来就不在了（正常返回，不抛）。 */
  gone: boolean;
  archivedTo?: string;
}

export interface PushBranchInput extends Scope {
  repo: Repo;
  /** 会话的工作树：新提交由会话用户从这里打包交出来（引擎不在里面跑 git）。 */
  worktreePath: string;
  branch: string;
  /** 要推上去的本地提交；推完远端分支头应当就是它。 */
  head: string;
}

/**
 * PR 正文的内容。正文由 github 包的 renderPrBody 按 .github/pull_request_template.md 的栏目生成（四栏，#654；design：引擎开的 PR
 * 和人开的同一套栏目，对不上测试会红），这里只给结构，不自己拼字。
 */
export interface PrBody {
  /** 对应的需求（issue 号）。 */
  requirement?: number;
  /** 子任务名。 */
  subtask?: string;
  /** 做了什么，3–5 条。 */
  did: string[];
  /** 怎么验证的。 */
  verified: string[];
  /** 还欠什么；空 = 无。 */
  owed?: string[];
  risks?: string[];
  /** 「按推荐先做了」：问创始人的岔路里没等他回、按推荐先做了的（core 的 assumedLines，#259）；空 = 无。 */
  assumed?: string[];
}

export interface OpenPrInput extends Scope {
  repo: Repo;
  branch: string;
  head: string;
  title: string;
  body: PrBody;
}

export interface PullRequestRef {
  prNumber: number;
  url?: string;
}

export interface WaitCiInput extends Scope {
  repo: Repo;
  prNumber: number;
  branch: string;
  head: string;
  /**
   * 子任务的工作树：github 包认了新头（新头含着老头，见 packages/github/src/pulls.ts 的 waitCi）就顺手把它也
   * 快进到那个头——不给就只更新证据里的 head，不碰工作树（合并队列没有工作树）。会话在跑（工作树里有没提交的
   * 改动、或本地还有没推的提交）时不碰：等下一轮再试，不强上（#307/#389 那次真事：CI 认了新头，工作树没跟上，
   * 后面再并主线、再推都是从旧头算起，最后推送被拒）。
   */
  worktreePath?: string;
}

export interface SyncMainlineInput extends Scope {
  repo: Repo;
  /** 没给（还没开 PR）：并主线的提交说明少写一句，不影响并不并（跟着 github 包的 SyncMainlineInput）。 */
  prNumber?: number | undefined;
  branch: string;
  /** 以为分支现在的头是它；对不上说明被别人推过，先认领新头。 */
  head: string;
  /** 子任务的工作树：并完、推完后由会话用户把它快进到新头（接着返工用）；合并队列没有工作树。 */
  worktreePath?: string;
}

export interface MergePrInput extends Scope {
  repo: Repo;
  prNumber: number;
  /** 只合这个头；头变了就不合。 */
  expectedHead: string;
}

export interface IssueProgress {
  state: TaskState;
  /** 白话「正在：……」。 */
  current: string;
  done: number;
  total: number;
  subtasks: { key: string; title: string; state: string; prNumber: number | null }[];
  docs: { requirement?: string; plan?: string; result?: string };
}

export interface UpdateIssueProgressInput extends Scope {
  repo: Repo;
  issueNumber: number;
  progress: IssueProgress;
}

/** 需求和子任务此刻的样子，写进库给驾驶舱（驾驶舱读库，不读 Temporal 查询）。 */
export interface TaskStateSnapshot extends Scope {
  repoId: string;
  issueNumber: number;
  state: TaskState;
  phase: string;
  doing: string;
  /** 需求文档目录和文档：不给就不动库里的（Fusion 认出单子正文指的需求文档之前，写空的会冲掉上一轮记下的）。 */
  specDir?: string;
  docs?: { requirement?: string; plan?: string; result?: string };
  lastProblem: string | null;
  subtasks: {
    id: string;
    key: string;
    index: number;
    title: string;
    touches: string[];
    /** 依赖的子任务 id。 */
    dependsOn: string[];
    state: SubtaskState;
    prNumber: number | null;
    /** 白话，在等什么；不在等就是 null。 */
    waitingOn: string | null;
    workflowId: string | null;
    /** 人闸标记（release / spend / delete…）；非空 = 合并前要人批。 */
    holds: string[];
  }[];
}

export interface CloseIssueInput extends Scope {
  repo: Repo;
  issueNumber: number;
  reason: 'completed' | 'not_planned';
  comment?: string;
}

export interface WriteSpecDocInput extends Scope {
  repo: Repo;
  issueNumber: number;
  specDir: string;
  doc: 'requirement' | 'plan' | 'result';
  markdown: string;
}

// ---- 人、报警、计时

export interface RaiseAlertInput extends Scope {
  level: 'stuck' | 'info';
  title: string;
  detail: string;
  /** 同一件事只一张卡，状态变了原地更新。 */
  dedupeKey: string;
}

/** 在等什么：deps 等依赖、overlap 等改同一块的子任务、capacity 等需求内并发、slot 等账号池空位、quota 等额度、human 等人（暂停、挂起、回答、批准）、merge-queue 等合并队列、retry 退避中。 */
export type WaitKind = 'deps' | 'overlap' | 'capacity' | 'slot' | 'quota' | 'human' | 'merge-queue' | 'retry';

/** 一次活动尝试：排队（排进任务队列 → 工人开始干）和干活（开始 → 结束）分开记。 */
export interface ActivityTiming {
  kind: 'activity';
  workflowId: string;
  runId: string;
  workflowType: string;
  activity: string;
  attempt: number;
  taskId?: string;
  subtaskId?: string;
  subtaskKey?: string;
  scheduledAt: string;
  startedAt: string;
  endedAt: string;
  queueMs: number;
  runMs: number;
  outcome: 'ok' | 'failed' | 'cancelled';
  errorCode?: string;
}

/** 工作流层面的一段等待（等依赖、等空位、等人……）。 */
export interface WaitTiming {
  kind: 'wait';
  workflowId: string;
  runId: string;
  workflowType: string;
  taskId?: string;
  subtaskId?: string;
  subtaskKey?: string;
  waitFor: WaitKind;
  detail: string;
  startedAt: string;
  endedAt: string;
  waitMs: number;
}

export type TimingEntry = ActivityTiming | WaitTiming;

export interface EnginePorts {
  pickRoute(input: PickRouteInput, ctx: PortContext): Promise<PickRouteResult>;
  createWorktree(input: CreateWorktreeInput, ctx: PortContext): Promise<Worktree>;
  removeWorktree(input: RemoveWorktreeInput, ctx: PortContext): Promise<RemoveWorktreeResult>;
  /**
   * changedFiles：推上去的头相对主线的净改动（推之前刚并了最新主线，git diff 主线...头）。老版端口推的没有（重放在途任务
   * 的历史里就是这样），工作流照旧按会话交的累计算。
   */
  pushBranch(input: PushBranchInput, ctx: PortContext): Promise<{ head: string; changedFiles?: string[] }>;
  openPr(input: OpenPrInput, ctx: PortContext): Promise<PullRequestRef>;
  waitCi(input: WaitCiInput, ctx: PortContext): Promise<CiResult>;
  syncMainline(input: SyncMainlineInput, ctx: PortContext): Promise<SyncResult>;
  saveTaskState(input: TaskStateSnapshot, ctx: PortContext): Promise<void>;
  closeIssue(input: CloseIssueInput, ctx: PortContext): Promise<void>;
  /** 写这张单的会话用过的路由的族（验证只派别家）。一个都查不到明确报错（AUTHORS_UNKNOWN，不可重试），不回空的。 */
  authorFamilies(input: Scope, ctx: PortContext): Promise<{ families: string[] }>;
  raiseAlert(input: RaiseAlertInput, ctx: PortContext): Promise<{ alertId: string }>;
  recordTiming(input: TimingEntry, ctx: PortContext): Promise<void>;
}

export type PortName = keyof EnginePorts;
