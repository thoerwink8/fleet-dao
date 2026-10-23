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
  /** 当前活动 SDK 给出的 execution runId；调用方输入和本机会话不能补造。 */
  readonly temporalRunId?: string;
  /**
   * 这一次尝试必须在这之前结束（这次开跑时刻 + startToClose，毫秒）。
   * 不心跳的活动收不到取消信号，服务端判了超时之后进程里的代码还会往下走；写外部副作用之前用它拦。
   * 活动测试不经 Temporal 时不填，当没有这一限。
   */
  readonly attemptDeadlineMs?: number;
  /**
   * 这一次调度（含排队、重试、退避）必须在这之前结束（第一次调度时刻 + scheduleToClose，毫秒）。
   * 没设 scheduleToClose（0）就不填，不当成已经到期。
   */
  readonly scheduleDeadlineMs?: number;
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
  /**
   * 作者族（db 的 authorFamilyOf，选路时算好）：目录记成 unclassified、按模型 id 开头认得出的那一族。换路由按族避开（决定 0093）
   * 用它；老历史、假端口里没有，照 family 用。
   */
  authorFamily?: string;
  hostId: HostId;
  /**
   * 选路时那句「为什么派它」（和 PickRouteResult 成功时的 why 同一句）。起这一段时写进 runs.route_why。
   * 老历史、假端口里没有。
   */
  why?: string;
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
   * 这一单的派工档（fast / medium / heavyweight，和 rt.status.tier.tier、runs.tier 同一套）。
   * 不给 = 不按档排（老历史、还没分档、冷验收）。工作流只在 patched('route-by-tier') 下才带。
   */
  tier?: 'fast' | 'medium' | 'heavyweight';
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
  /** 哪张单的会话断的（GitHub 单号）：老历史里带着，现在不用。 */
  issueNumber?: number;
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
  /** 没合并就收（叫停、失败）；所有清理都先保全独有成果，复杂未提交状态要独立恢复核过才删，核不上留树。 */
  archive: boolean;
  /**
   * 收之前先核对界面验收图片（_tmp/shots/<标签>/ 的 PNG/JPEG/WebP、树里没推的孤儿图片提交，#2983）：远端 shots/<单号> 读得到
   * 才算交付，读不到就存进受限归档；归档也没成就不删树。老历史不带时，端口仍按树的 HEAD 核对并保全。
   */
  shots?: ShotsInput;
}

export interface ShotsInput {
  issueNumber: number;
  /** 固定的代码头（推上去、合并的那个）：归档按它分目录，换了头不覆盖。 */
  head: string;
}

/** 一张受管图片：路径、多大、字节 sha256、git blob 号、从哪来。 */
export interface ShotFileRecord {
  /** 树里的：相对 _tmp/shots 的路径（<标签>/<图>）；孤儿提交里的：<提交短号>/<提交里的路径>。 */
  path: string;
  bytes: number;
  sha256: string;
  blob: string;
  /** tree＝_tmp/shots 里的文件；否则是那个没推的孤儿提交号。 */
  from: string;
}

/**
 * 图片交付的结局：none＝没有受管图片；delivered＝远端 shots/<单号> 上全读得到（按 blob 号比，不认本地文件和本地提交）；
 * archived＝远端没有（或没读成），已存进受限归档，待交付；failed＝没交付也没存档成，树留着没删；
 * unknown＝树已经收了、又没有核对记录，交没交付不知道。
 */
export type ShotsOutcome = 'none' | 'delivered' | 'archived' | 'failed' | 'unknown';

export interface ShotsDelivery {
  outcome: ShotsOutcome;
  head: string;
  /** 远端图片分支：shots/<单号>。 */
  branch: string;
  files: ShotFileRecord[];
  /** 读到的远端图片分支头；分支不在（404）不带。 */
  remoteHead?: string;
  /** 远端缺的图片（路径）。 */
  missing?: string[];
  /** 核对记录（清单）：归档了的和图片在一个目录。 */
  archivedTo?: string;
  /** 拒收的东西（路径：原因）：符号链接、不是图片、层级不对……不读、不存。 */
  rejected?: string[];
  /** 为什么不是 delivered（远端没读成、归档满了、写不进去……）。 */
  reason?: string;
}

export interface RemoveWorktreeResult {
  removed: boolean;
  /** 本来就不在了（正常返回，不抛）。 */
  gone: boolean;
  archivedTo?: string;
  /** 给了 shots 或无 shots 的收树发现图片时带上：图片交付核对的结局。 */
  shots?: ShotsDelivery;
  /** 树没删的原因（图片没交付也没存档成）。 */
  kept?: string;
}

export interface PushBranchInput extends Scope {
  repo: Repo;
  /** 会话的工作树：新提交由会话用户从这里打包交出来（引擎不在里面跑 git）。 */
  worktreePath: string;
  branch: string;
  /** 要推上去的本地提交；推完远端分支头应当就是它。 */
  head: string;
  /**
   * 这张单已经开着的 PR（#3140，只记账）：给了，推上去以后把这个头改了哪些文件、各增删几行记进 pr_head_files。
   * 第一轮还没有 PR，由开 PR 那一步按 numstat 记。老历史没有这个字段。
   */
  prNumber?: number;
}

/**
 * 一个头相对主线改了的一个文件（git diff --numstat 主线...头，不做改名识别：改名按删一个加一个算）。
 * 二进制文件 git 不给行数：binary 为真，added / removed 为空。
 */
export interface HeadFileStat {
  path: string;
  added: number | null;
  removed: number | null;
  binary: boolean;
}

/**
 * PR 正文的内容。正文由 github 包的 renderPrBody 按 .github/pull_request_template.md 的栏目生成（四栏，#654；design：引擎开的 PR
 * 和人开的同一套栏目，对不上测试会红），这里只给结构，不自己拼字。
 */
export interface PrBody {
  /** 对应的需求（issue 号）。 */
  requirement?: number;
  /** 验收责任还开着（#3037）：「需求」栏写 Refs、标分片，合并收口和每日对账都不关它。 */
  requirementRefs?: boolean;
  /** 会话的交付声明说只交了一部分（#3406）：「需求」栏同样写 Refs 标分片。只让说明更保守，不改关单。 */
  partial?: boolean;
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
  /**
   * 这一代是第几代（工作流编号上的 :rN；第一代是 1）。重做的新一代（≥ 2）开 PR 时，
   * 同一张单上自己上一代留下的任务分支 PR 关掉再开。没传（老历史）或是第一代：有别的 PR 照旧挡回。
   */
  generation?: number;
  /** 推这个头时数出来的文件清单（#3140，只记账）：开成了就记进 pr_head_files。没数成、老历史没有。 */
  numstat?: HeadFileStat[];
  /** 截断前的总数或采集失败原因；老历史缺失时不能声称清单完整。 */
  numstatSnapshot?: { total: number } | { reason: string };
}

/** 换掉已开着的 PR 的正文（#2723：第 2 轮起「做了什么」换成这一轮会话的回复）。 */
export interface UpdatePrBodyInput extends Scope {
  repo: Repo;
  prNumber: number;
  body: PrBody;
}

/** 一轮动手怎么结束的（#2762）：和 @fleet-dao/db 的 ROUND_OUTCOMES 同一份名单（store-ports 写库时类型核对）。 */
export type RoundOutcome =
  | 'merged'
  | 'verify_rejected'
  | 'ci_red'
  | 'leftover'
  | 'no_commit'
  | 'push_conflict'
  | 'merge_conflict'
  | 'timeout'
  | 'stopped'
  | 'other';

/** 记一轮收场（#2762，每日简报「流程健康」按它算）。同一条工作流同一个 seq 只记一行。 */
export interface RecordRoundInput extends Scope {
  workflowId: string;
  /** 这条工作流里第几次收场（从 1 起）。 */
  seq: number;
  round: number;
  outcome: RoundOutcome;
  tier?: string;
  firstModel?: string;
  addedLines?: number;
  /** 这张单走的流程（#2826，task_rounds.flow_mode）。定模式之前开工的老历史没有。 */
  flowMode?: 'three' | 'full';
  /** 这一轮开始的时刻（#3140，task_rounds.started_at，工作流的时钟 ISO）。老历史没有。 */
  startedAt?: string;
  /** 这一轮为什么返工、下一轮要改什么（#3140，≤500 字；task_rounds.rework_summary）。做成了、放弃叫停、老历史没有。 */
  reworkSummary?: string;
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

/**
 * 一条要记下的验收责任（#3037，db 的 acceptance_duties）：冷验收判「不归我验」、转给人验的那几条，连哪个 PR、哪个头。
 * 没有代码的协调验收责任 prNumber 记 0、head 记空串（不要求开空 PR）。
 */
export interface AcceptanceDutyRecord {
  prNumber: number;
  head: string;
  /** 原验收项（验收方回的原文），至少一条。 */
  items: string[];
  /** 合并回执：合进主线的提交。只在合并之后带。 */
  mergeCommit?: string;
}

/** 一条还开着的验收责任（读回来的原样）。 */
export interface AcceptanceDuty {
  repo: string;
  issueNumber: number;
  prNumber: number;
  head: string;
  items: string[];
  /** 初建来源：management_merge 是管理归并建出的待验目标（#3207），照原样读，不说成冷验收转的。 */
  source: 'cold_verify' | 'coordination' | 'management_merge';
  mergeCommit: string | null;
}

/**
 * 读回这张单还开着的验收责任（#3037 时期记下的旧行）。#3591（决定 0113）起只读：新工作流 record 恒为空，
 * 老历史、在途重试带来的 record 也不落库。读到空就是没有待验的；读不成照抛，不回空数组冒充「没有待验的」。
 */
export interface AcceptanceDutiesInput extends Scope {
  repo: Repo;
  issueNumber: number;
  record: AcceptanceDutyRecord[];
}

export interface AcceptanceDutiesResult {
  open: AcceptanceDuty[];
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
  level: 'stuck' | 'info' | 'decision';
  title: string;
  detail: string;
  /** 同一件事只一张卡，状态变了原地更新。 */
  dedupeKey: string;
}

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

export type TimingEntry = ActivityTiming;

export interface EnginePorts {
  pickRoute(input: PickRouteInput, ctx: PortContext): Promise<PickRouteResult>;
  createWorktree(input: CreateWorktreeInput, ctx: PortContext): Promise<Worktree>;
  removeWorktree(input: RemoveWorktreeInput, ctx: PortContext): Promise<RemoveWorktreeResult>;
  /**
   * changedFiles：推上去的头相对主线的净改动（推之前刚并了最新主线，git diff 主线...头）。老版端口推的没有（重放在途任务
   * 的历史里就是这样），工作流照旧按会话交的累计算。addedLines：同一个口径的新增行数（#2762，流程健康记账用；没数成不带）。
   */
  pushBranch(
    input: PushBranchInput,
    ctx: PortContext,
  ): Promise<{
    head: string;
    changedFiles?: string[];
    addedLines?: number;
    numstat?: HeadFileStat[];
    numstatSnapshot?: { total: number } | { reason: string };
  }>;
  openPr(input: OpenPrInput, ctx: PortContext): Promise<PullRequestRef>;
  updatePrBody(input: UpdatePrBodyInput, ctx: PortContext): Promise<void>;
  waitCi(input: WaitCiInput, ctx: PortContext): Promise<CiResult>;
  syncMainline(input: SyncMainlineInput, ctx: PortContext): Promise<SyncResult>;
  saveTaskState(input: TaskStateSnapshot, ctx: PortContext): Promise<void>;
  recordRound(input: RecordRoundInput, ctx: PortContext): Promise<void>;
  closeIssue(input: CloseIssueInput, ctx: PortContext): Promise<void>;
  acceptanceDuties(input: AcceptanceDutiesInput, ctx: PortContext): Promise<AcceptanceDutiesResult>;
  raiseAlert(input: RaiseAlertInput, ctx: PortContext): Promise<{ alertId: string }>;
  recordTiming(input: TimingEntry, ctx: PortContext): Promise<void>;
}

export type PortName = keyof EnginePorts;
