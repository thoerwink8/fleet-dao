// 引擎对外的每个动作都是一个活动，由别的包按这份接口实现（插头、GitHub、数据库、通知……）。
// 实现不用碰 Temporal：拿到的 ctx 里有取消信号和心跳；抛 PortError 就能把错误码原样带过 Temporal 边界。
//
// 实现方必须知道的：
// 1. 长活动（awaitSession / waitCi / runTests）至少每 heartbeatSeconds/3 调一次 ctx.heartbeat()。
//    不调就会在心跳超时后被判「工人丢了」并重试——工人重启后分钟级发现，不再干等整段限时。
// 2. 会被重试的活动必须幂等：推分支、开 PR 按分支复用、合并带头约束（已经合上的回 merged 和它的合并提交）、
//    写 GitHub 带幂等键、删已经不在的对象正常返回。编号由工作流给（记在历史里），实现按编号去重：
//    startSession 按 runId（同一个 runId 起第二次返回已有的那个，不起第二个进程）、askHuman 按 askId（同一个问题只发一张卡）、
//    requestApproval 按 approvalId（同一次批准只发一张卡）。
// 3. 会话只在本地提交：推分支、开 PR 由引擎在会话外面做（pushBranch / openPr，用「干活的」机器人）；
//    会话里拿不到任何 GitHub 凭据，依赖在建工作树时装好。引擎不以自己的身份在会话的工作树里跑 git（design 十四）：
//    pushBranch 由会话用户把起会话前的头之后的新提交打成包（git bundle），引擎导入自己的仓库、核实交付再推；
//    syncMainline 在引擎自己的仓库里并主线、推上去，再由会话用户把工作树快进到新头。
// 4. 会话一律经 fleet-agent-scope 起（scope 名用 runId，内存上限按 input.resources，swap 一起封），跑在按
//    input.route.poolId 那个池定的会话专用用户下（法国只有一个，两个 Claude 池共用；它同一时刻只挂一个组织，design 第九节）；
//    startSession 先按 input.runId 在库里建这一次会话（session_runs），再起进程，把进程号和 scope 交回（handle）。
//    stopSession 按 runId 停（起会话还没返回时工作流只知道 runId）：停掉这个 runId 名下的进程，并记下「这个 runId 已叫停」——
//    之后（或同时在跑的）startSession 再拿这个 runId 来，不起进程，抛 SESSION_STOPPED。
// 5. awaitSession 只是「看守」：工人重启后它会被重试。接得上就接着看；接不上（引擎正常停时会话跟着退了，
//    或者引擎被强杀、会话成了孤儿）就按 handle 把旧会话收掉，回 outcome=failed、code=SESSION_LOST——工作流会续会话重起。
//    工人进程起来时 createEngineWorker 会先调 reapOrphanSessions（fleet-agent-scope list 再逐个 stop）：
//    上一轮的会话输出管道已经断了，接不上。工作流被强行终止留下的会话，归每小时对账收。

import type { HostId, Repo, RunOutcome, StageKind, SubtaskState, TaskState } from '@fleet-dao/shared';
import type { MergeOutcome, TestResult } from './decisions/merge.ts';
import type { PlannedSubtask } from './decisions/plan.ts';
import type { TriageVerdict } from './decisions/triage.ts';
import type { CiResult, Feedback, ReviewResult, SyncResult } from './decisions/verify.ts';

export type {
  CiResult,
  Feedback,
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
  /** 主池 / 备池（拼车号是备池）：额度用满时走法不同（失败分流 QT1）。老历史里没有 = 按主池。 */
  poolRole?: 'primary' | 'backup';
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
}

export type PickRouteResult =
  /** why：一句「为什么派给它」；额度没读成的账号池排在后面，被选上时写明「额度未知」。 */
  | { ok: true; route: RouteChoice; why: string }
  | { ok: false; waitFor: 'slot' | 'quota'; detail: string; retryAfterSeconds?: number }
  /** 一条能用的路由都没有（都下线、都被避开、都犯禁令）：等也等不来，交人。 */
  | { ok: false; waitFor: 'none'; detail: string };

// ---- 会话

export interface SessionBrief {
  title: string;
  /** 创始人原话，或子任务说明。 */
  request: string;
  specDir?: string;
  acceptance: string[];
  touches: string[];
  /** 返工意见：CI 失败、第二意见、冲突、合并队列退回。 */
  feedback: Feedback[];
  /** 追问过的问题和回答。 */
  answers: { question: string; answer: string }[];
  branch?: string;
  /** 第二意见：审哪个 PR 的哪个头。 */
  prNumber?: number;
  head?: string;
}

/** 给会话 scope 的资源上限（fleet-agent-scope 的 --memory-high / --memory-max / --memory-swap-max）。 */
export interface SessionResources {
  memoryHighMb: number;
  memoryMaxMb: number;
  /** 0 = 不许用 swap：只封内存不封 swap，超出的会被换出去、会话不会被杀（法国实测）。 */
  swapMaxMb: number;
}

export interface StartSessionInput extends Scope {
  /**
   * 这一次会话的编号（库里 session_runs.id、fleet 通行证里的 runId、scope 名），工作流经 decide 生成、记在历史里的 UUID。
   * 幂等键：活动重试拿同一个 runId 来，返回已经起了的那个。
   */
  runId: string;
  stage: StageKind;
  route: RouteChoice;
  whyRoute: string;
  /** 开始为这次会话选路由（排队）的时刻；会话真正开始干活由实现记。 */
  queuedAt: string;
  brief: SessionBrief;
  worktreePath?: string;
  /** 写码类会话：起会话前分支的头。交付判据是「这之后有新提交、且没有未提交的已跟踪改动」。 */
  baseHead?: string;
  /** 返工、暂停后继续、换路由时给：能续就续，续不了带着进度摘要开新会话。 */
  resumeSessionId?: string;
  /** 没有工具在跑、又这么久没动静就判停滞（插头的 idle 超时）。 */
  stallSeconds: number;
  /** 会话总时长上限。 */
  sessionMinutes: number;
  resources: SessionResources;
}

/** worker 在起会话前补上的东西：通行证只在活动里现签，不进工作流历史。 */
export interface SessionLaunch {
  /** fleet 命令的后端地址（会话环境里的 FLEET_API）。 */
  fleetApi: string;
  /** 只对这个任务这一次会话有效的通行证（会话环境里的 FLEET_TOKEN）。 */
  fleetToken: string;
  /** 放到会话 PATH 最前面的目录：装着 fleet 命令的 packages/cli/bin。 */
  pathPrepend: string[];
}

export type LaunchSessionInput = StartSessionInput & { launch: SessionLaunch };

/** 起出来的会话进程在哪（插头的 onSpawn 报上来的）。工作流记下它，工人重启后看守和收尾都靠它找回旧会话。 */
export interface SessionHandle {
  pid?: number;
  /** systemd scope 名，例如 fleet-agent-<runId>.scope。 */
  scope?: string;
}

export interface StartSessionResult {
  /** 执行体自己的会话编号（续会话用）。 */
  sessionId: string;
  resumed: boolean;
  handle?: SessionHandle;
}

export interface AwaitSessionInput extends Scope {
  runId: string;
  sessionId: string;
  stage: StageKind;
  handle?: SessionHandle;
}

export type SessionOutput =
  | { kind: 'triage'; verdict: TriageVerdict }
  | { kind: 'doc'; markdown: string }
  | { kind: 'plan'; markdown: string; subtasks: PlannedSubtask[] }
  /** 会话只在本地提交；head 是工作树里最新的提交，changedFiles 是相对 baseHead 改了哪些文件（交付对账用）。 */
  | { kind: 'delivery'; head: string; summary: string; testsPassed: boolean; changedFiles?: string[] }
  | { kind: 'review'; review: ReviewResult };

export interface SessionEnd {
  sessionId: string;
  /** stopped = 被 stopSession 停下（暂停、换路由、叫停）。 */
  outcome: 'done' | 'blocked' | 'failed' | 'stalled' | 'stopped';
  output?: SessionOutput;
  blocked?: {
    reason: string;
    needs: 'human' | 'info' | 'access' | 'other';
    question?: string;
    options?: string[];
  };
  /** code 用结构化的：插头判定的原因（quota_exhausted、model_mismatch……）、SESSION_LOST…… */
  failure?: {
    code: string;
    message: string;
    retryable?: boolean;
    /** 上游给的清零时刻（ISO，额度用满时从 rate_limit_event 或原文里读的）/ 等待秒数。 */
    resetsAt?: string;
    retryAfterSeconds?: number;
    httpStatus?: number;
    exitCode?: number | null;
    signal?: string | null;
    /** 最后几段过程记录（老的在前），失败分流只在写明读过程记录的规则里看。 */
    transcriptTail?: string[];
    /** 会话跑在哪台机器（给人看的名字）、哪个会话用户：只有人能修的（重新登录）要写清去哪修。 */
    machine?: string;
    runAsUser?: string;
  };
  /** 这一次会话的 token（执行体终帧报的就是这一次的）。 */
  usage?: { inputTokens?: number; outputTokens?: number };
  /** 整个会话（sessionId）到目前为止的累计花费（续会话时含前几轮）；这一次的由引擎按上一轮求差。 */
  sessionCostUsd?: number;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface StopSessionInput extends Scope {
  /** 按它停：起会话还没返回时只有它。 */
  runId: string;
  sessionId?: string;
  handle?: SessionHandle;
  /** graceful = 停在干净的点（做完的先提交）；kill = 立刻停。 */
  mode: 'graceful' | 'kill';
  reason: string;
}

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
 * PR 正文的内容。正文由 github 包的 renderPrBody 按 .github/pull_request_template.md 的栏目生成（design：引擎开的 PR
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
  /**
   * 需求文档的目录（specs/<号>-<短名>/）：「specs」一栏照写；「对应计划」一栏由端口开 PR 时现读这个目录下需求.md 的
   * 「对应计划：」那一行（读不到、没填就明确报错，不填空的）。
   */
  specs: string;
  /**
   * 「档位」一栏（design 第五节的档位加理由）：只作说明、合并闸只提醒；合并闸按改动路径判要不要等第二意见
   * （当前头上通过的 second-opinion 提交状态），不看这一栏。
   */
  tier: string;
  /** 改到的文件（仓内相对路径）：「文档」一栏按它写。 */
  changedFiles: string[];
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
  head: string;
}

export interface SyncMainlineInput extends Scope {
  repo: Repo;
  prNumber: number;
  branch: string;
  /** 以为分支现在的头是它；对不上说明被别人推过，先认领新头。 */
  head: string;
  /** 子任务的工作树：并完、推完后由会话用户把它快进到新头（接着返工用）；合并队列没有工作树。 */
  worktreePath?: string;
}

export interface RunTestsInput extends Scope {
  repo: Repo;
  prNumber: number;
  branch: string;
  head: string;
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
  specDir: string;
  docs: { requirement?: string; plan?: string; result?: string };
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

export interface SpecDocRef {
  path: string;
  commit?: string;
}

// ---- 人、报警、计时

export interface AskHumanInput extends Scope {
  /** 工作流给的提问编号（库里 asks.id，UUID）：幂等键，同一个编号只发一张卡；人回答时带回来。 */
  askId: string;
  question: string;
  options?: string[];
  /** 会话里问的就带上是哪一次会话。 */
  runId?: string;
}

/** 人闸：请人批准这个子任务进合并队列（飞书卡片 + 驾驶舱待点头，一键批准 / 拒绝）。 */
export interface RequestApprovalInput extends Scope {
  /** 工作流给的批准编号（UUID）：幂等键，同一个编号只发一张卡；批准、拒绝时带回来。 */
  approvalId: string;
  /** 为什么要人批：release 对外发布、spend 花钱、delete 删数据（认不得的原样给人看）。 */
  holds: string[];
  repo: Repo;
  prNumber: number;
  /** 批的是这个头；之后头变了（返工、解冲突）要重新批。 */
  head: string;
  title: string;
  summary: string;
}

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

/** 一次会话结束：结局和这一次的用量（花费是和上一轮累计值的差）。写进库里那一行 session_runs（按 runId）。 */
export interface SessionRunRecord {
  kind: 'session';
  workflowId: string;
  runId: string;
  taskId?: string;
  subtaskId?: string;
  subtaskKey?: string;
  sessionId: string;
  stage: StageKind;
  routeId: string;
  outcome: RunOutcome;
  endedAt: string;
  /** 这一次的用量；不知道的字段不给（不记 0）。上一轮的累计花费没读到时，这一次的花费求不了差，也不给。 */
  usage: Usage;
  /** 执行体报的会话累计花费，对账用。 */
  sessionCostUsd?: number;
  failureCode?: string;
}

export type TimingEntry = ActivityTiming | WaitTiming | SessionRunRecord;

export interface EnginePorts {
  pickRoute(input: PickRouteInput, ctx: PortContext): Promise<PickRouteResult>;
  startSession(input: LaunchSessionInput, ctx: PortContext): Promise<StartSessionResult>;
  awaitSession(input: AwaitSessionInput, ctx: PortContext): Promise<SessionEnd>;
  stopSession(input: StopSessionInput, ctx: PortContext): Promise<void>;
  createWorktree(input: CreateWorktreeInput, ctx: PortContext): Promise<Worktree>;
  removeWorktree(input: RemoveWorktreeInput, ctx: PortContext): Promise<RemoveWorktreeResult>;
  pushBranch(input: PushBranchInput, ctx: PortContext): Promise<{ head: string }>;
  runTests(input: RunTestsInput, ctx: PortContext): Promise<TestResult>;
  openPr(input: OpenPrInput, ctx: PortContext): Promise<PullRequestRef>;
  waitCi(input: WaitCiInput, ctx: PortContext): Promise<CiResult>;
  syncMainline(input: SyncMainlineInput, ctx: PortContext): Promise<SyncResult>;
  mergePr(input: MergePrInput, ctx: PortContext): Promise<MergeOutcome>;
  updateIssueProgress(input: UpdateIssueProgressInput, ctx: PortContext): Promise<void>;
  saveTaskState(input: TaskStateSnapshot, ctx: PortContext): Promise<void>;
  closeIssue(input: CloseIssueInput, ctx: PortContext): Promise<void>;
  writeSpecDoc(input: WriteSpecDocInput, ctx: PortContext): Promise<SpecDocRef>;
  askHuman(input: AskHumanInput, ctx: PortContext): Promise<void>;
  requestApproval(input: RequestApprovalInput, ctx: PortContext): Promise<void>;
  raiseAlert(input: RaiseAlertInput, ctx: PortContext): Promise<{ alertId: string }>;
  recordTiming(input: TimingEntry, ctx: PortContext): Promise<void>;
}

export type PortName = keyof EnginePorts;
