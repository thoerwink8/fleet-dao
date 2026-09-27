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
//    会话的 TMPDIR 是这次会话自己的临时目录（工作树根下的 _tmp/<runId>），会话收场就删。
//    stopSession 按 runId 停（起会话还没返回时工作流只知道 runId）：停掉这个 runId 名下的进程，并记下「这个 runId 已叫停」——
//    之后（或同时在跑的）startSession 再拿这个 runId 来，不起进程，抛 SESSION_STOPPED。
// 5. awaitSession 只是「看守」：工人重启后它会被重试。会话脱开引擎进程跑（real/session-io.ts：输入输出、退出码走文件），
//    新工人上的看守照收发目录和库里那一行接回：从头重读输出，库里确认过的行（session_runs.output_seq）只重建状态、不再写库；
//    引擎不在时跑完了的照样收场。接不回（没有接回记录、库里已经结束或叫停、过了总时限，或者还是接管道跑的旧会话）就按 handle
//    把旧会话收掉，回 outcome=failed、code=SESSION_LOST——工作流会续会话重起；没留下退出码的判 exit_lost（EN1 续会话）。
//    引擎正常停机先排空（drain.ts）：不起新会话（startSession 抛 ENGINE_STOPPING）；脱开跑的会话不等、不停，只等接管道的。
//    工人进程起来时 createEngineWorker 会先调 reapOrphanSessions（fleet-agent-scope list，能接回的留着、其余逐个 stop，再清上一轮
//    会话的临时目录、收发目录）。工作流被强行终止留下的会话，现在要等工人下一次起来时这一步才收（每小时对账还没接这一项：#247）。

import type { Brief, FlowConfigRead, Rebuttable, Rebuttal, TaskAsk, VerifyReport } from '@fleet-dao/core';
import type {
  HostId,
  OrgKind,
  Repo,
  RunOutcome,
  StageKind,
  SubtaskState,
  TaskState,
} from '@fleet-dao/shared';
import type { MergeOutcome, TestResult } from './decisions/merge.ts';
import type { PlannedSubtask } from './decisions/plan.ts';
import type { TriageVerdict } from './decisions/triage.ts';
import type { CiResult, Feedback, ReviewResult, SyncResult } from './decisions/verify.ts';
import type { JevReply } from './failure/jev.ts';
import type { TriageChoice } from './failure/types.ts';

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
  /**
   * Claude 订阅池的组织类型（pools.org_kind：拼车、独享，共用一个会话用户）：额度用满时不原地睡到清零（失败分流 QT1
   * 的 orgLadder）。别的池、老历史里没有。
   */
  orgKind?: OrgKind;
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
   * 照调度台的先后。给了空数组 = 这一步没配模型，派不出。不给 = 照调度台（需求工作流、子任务不给）。
   */
  models?: string[];
  /**
   * 给开 PR 前验证留一家（0003 第 5 条「验证只派别家」）：Fusion 规划完、开 PR 之前，选副手、Lead 换路由这类会给这张单
   * 加一个写手族的步骤带上。只派加上它的族之后验证那一步还派得出别家的（接上、在线、不犯禁令、不同族，等得来的也算）；
   * 写这张单的族现从库里查（和验证查作者同一个查询），查不到明确报错。一家都留不下就当场报警「这张单做完没人能验」
   * （no-verifier:<任务>），不等干完几小时走到验证那一步才挂起；之后验证留得下了、验证派出去了自动撤。
   * 不给 = 不管（规划、验证本身、开了 PR 之后、需求工作流、子任务；这张单不验的也不给）。
   */
  keepVerifier?: KeepVerifierRequest;
}

/** PickRouteInput.keepVerifier：验证那一步怎么派（流程配置、界面类），留不下时怎么办。 */
export interface KeepVerifierRequest {
  /** 验证这一步的模型顺序（流程配置，0003 第 9 条）；不给照调度台。 */
  models?: string[];
  /** 验证算不算界面类的活（规划完就知道：任务简报碰没碰页面代码）：GPT 不验。 */
  uiWork: boolean;
  /**
   * 平时先避开、别家的都会让验证没人可派才派的族：副手避开 Lead 那一族（Claude 额度留给 Lead，0002 第 5 条「优先」）。
   * 它们本来就在写这张单，派它不多加一族；别家只是没额度、连不上的照旧避开（副手派不出由 Lead 自己干，0003 第 7 条）。
   */
  spare?: string[];
  /**
   * 能给验证留一家的都派不出时：none 交派不出（副手：Lead 自己干，写手族不变）；any 照常选、报警（Lead：非派不可）。
   */
  otherwise: 'none' | 'any';
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
  /** 第二意见：审哪个 PR 的哪个头；开 PR 前验证：验哪个头（完整提交号，推上去的那个）。 */
  prNumber?: number;
  head?: string;
  /** 开 PR 前验证要交代的（只有 verify 阶段给）。 */
  verify?: VerifyBrief;
  /** Fusion 的主导模型（Lead）这一步做什么、看什么（只有 Lead 的会话给；会话端口按它交代、按它读交回的东西）。 */
  lead?: LeadBrief;
  /** Fusion 的任务简报（core 的 Brief）：副手照它干，Lead 验收、自己接手时对照它。 */
  task?: Brief;
}

/**
 * Lead 的几步（一张单一个 Lead 会话，按步续用，0003 第 6 条）。plan = 读需求文档和代码、写方案和任务简报；accept = 验收副手
 * 这一轮交回的；rebut = 看验证挡住的几条、有证据就驳回；fix-brief = 开了 PR 之后要改（CI 红、合并前退回）写修复简报；
 * review = CI 绿了做最终审查、写结果；pr-text = 开 PR 时正文被卫生检查拦下，重写方案摘要和做了什么；takeover = 自己写码
 * （副手打回两次还没做好、副手派不出、单模型模式）。
 */
export type LeadStep = 'plan' | 'accept' | 'rebut' | 'fix-brief' | 'review' | 'pr-text' | 'takeover';

export interface LeadBrief {
  step: LeadStep;
  /** fusion = 带副手；single = 单模型模式（没有副手，Lead 自己写）。 */
  mode: 'fusion' | 'single';
  /** 需求文档、方案、结果在仓里的路径（specs/<号>-<短名>/…，随 PR 进仓）。 */
  docs: { requirement: string; plan: string; result: string };
  /**
   * accept：副手这一轮交回的（改了哪些文件由引擎从提交里读）。base = 上一次推上去的头：base..head 是这一块副手的全部改动
   * （打回过的几轮连在一起）。
   */
  delivery?: { head: string; summary: string; changedFiles: string[]; testsPassed: boolean; base?: string };
  /** rebut：验证挡住的几条，原文照抄（驳回时 target 照抄；只差格式的由 core 的 decideVerdict 按 criterionKey 认）。 */
  blocking?: Rebuttable[];
  /** rebut、review：验证的备注（看不出的、建议）。 */
  notes?: string[];
  /** takeover：为什么 Lead 自己写。 */
  why?: string;
  /**
   * plan：这张单还没有需求文档、正文写全了需求（#295，引擎开的后续单、巡检单）：引擎照正文写好的需求文档全文，Lead 原样
   * 写进 docs.requirement、和方案一起提交（随 PR 进主线）。
   */
  requirementText?: string;
}

/** 开 PR 前验证交代给别家的材料（起会话前整份提示词过一遍卫生检查，过不了不发）。 */
export interface VerifyBrief {
  /** 这张单的「怎么算做完」逐条原文，从需求文档读的。 */
  criteria: string[];
  /** 那份需求文档（specs/<号>-<短名>/需求.md），提示词里写明出处。 */
  specPath: string;
  /** 方案摘要（Lead 写的）。 */
  planSummary: string;
  /** 这次改了哪些文件（相对主线）。 */
  changedFiles: string[];
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
  /**
   * 执行体自己的会话编号（续会话用）。cursor 开新会话的号是它在 init 帧里自己起的，事先定不了：这里先给一个一眼看得出
   * 不是 UUID 的临时号（cursor-pending:<runId>），看守拿它对会话；真号由结束时的 SessionEnd.sessionId 给。
   */
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
  /**
   * 会话只在本地提交；head 是工作树里最新的提交，changedFiles 是 baseHead 之后这一步自己改了哪些文件（交付对账用；
   * 会话并进来的主线不算，real/user-git.ts 的 ownSpan）。
   */
  | { kind: 'delivery'; head: string; summary: string; testsPassed: boolean; changedFiles?: string[] }
  | { kind: 'review'; review: ReviewResult }
  /**
   * 开 PR 前验证交回的结论文件（.fleet-out/verify.json）。真端口读的时候已经拿 core 的 checkReport 挡过一道（认不出、
   * 审错了头、漏答多答的退回会话重写；只差格式的 criterion 换成了清单原文）；定论照样由工作流经 decide 调 core 的
   * decideVerdict 判，不信这一道。
   */
  | { kind: 'verify'; report: VerifyReport }
  // ---- Fusion 的 Lead（brief.lead 给了哪一步就交哪一种）。形状由工作流经 decide 调 core 判（checkLeadPlan、checkBrief、
  // checkLeadReview），会话端口读的时候先按同一个形状挡一道，交错了退回会话照原因重写。
  /** plan：方案.md 写好提交了（head、这一步改到的文件），方案摘要、任务简报、大小、风险、会碰的人闸。 */
  | {
      kind: 'lead-plan';
      head: string;
      changedFiles: string[];
      summary: string;
      brief: unknown;
      small: boolean;
      highRisk: boolean;
      holds: string[];
    }
  /** accept：收不收副手这一轮交回的，带理由。 */
  | { kind: 'lead-verdict'; verdict: 'accept' | 'reject'; why: string }
  /** rebut：拿证据驳回的（没有就空数组，照挡的理由改）。 */
  | { kind: 'lead-rebut'; rebuttals: Rebuttal[] }
  /** fix-brief：给副手的修复简报。 */
  | { kind: 'lead-brief'; brief: unknown }
  /** review：最终审查。过了写结果.md 提交（head、改到的文件），做了什么、还欠什么；要改给修复简报。 */
  | {
      kind: 'lead-review';
      verdict: 'pass' | 'fix';
      why: string;
      did: string[];
      owed: string[];
      head: string;
      changedFiles: string[];
      brief?: unknown;
    }
  /** pr-text：重写的方案摘要和做了什么（PR 正文被卫生检查拦下时）。 */
  | { kind: 'lead-text'; summary: string; did: string[] };

export interface SessionEnd {
  /**
   * 执行体自己的会话号，下次续会话就拿它。cursor 开新会话、还没报出号就结束了的是空串：工作流保留上一个（没有就开新会话）。
   * 工人重启、接不上（SESSION_LOST）时回的是开工时那个号，可能是临时号：拿它续时会话端口认得出不是 UUID，开新会话带接力任务书。
   */
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
    /**
     * 看守活动问过 Jev 才有（规则认不出的失败）：工作流的失败分流带着它判，不在工作流里再问。
     * 只记不拦、把握不够、没判出来的，分流照兜底梯走，只在原因里写一句。
     */
    jev?: JevReply<TriageChoice>;
  };
  /**
   * 这一次会话的 token（执行体终帧报的就是这一次的；Claude、cursor 都报缓存读写）。读不到的字段不给，不记成 0。
   * 缓存读写进库、折成额度当量归 #216。
   */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
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
  /** 「按推荐先做了」：问创始人的岔路里没等他回、按推荐先做了的（core 的 assumedLines，#259）；空 = 无。 */
  assumed?: string[];
  /**
   * 需求文档的目录（specs/<号>-<短名>/）：「specs」一栏照写；「对应计划」一栏由端口开 PR 时现读这个目录下需求.md 的
   * 「对应计划：」那一行（读不到、没填就明确报错，不填空的）。
   */
  specs: string;
  /**
   * 需求文档跟着这个 PR 才进主线（正文写全了需求、收单时照正文写的，#295）：主线上还没有它，「对应计划」一栏照单子此刻挂的
   * 版本写（没挂写「未排期」），不读主线。
   */
  planFromIssue?: boolean;
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
  /** 没给（还没开 PR）：并主线的提交说明少写一句，不影响并不并（跟着 github 包的 SyncMainlineInput）。 */
  prNumber?: number | undefined;
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
  /** 需求文档目录和文档：不给就不动库里的（Fusion 认出单子正文指的需求文档之前，写空的会冲掉上一轮记下的）。 */
  specDir?: string;
  docs?: { requirement?: string; plan?: string; result?: string };
  lastProblem: string | null;
  /** 这一轮用的流程配置读自仓里还是全组织默认（驾驶舱要标出后者）：Fusion 开工前判完配置才有，旧的需求工作流不给。 */
  flowSource?: 'project' | 'org_default';
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

// ---- 开 PR 前验证（docs/decisions/0003-fusion-flow.md 第 5 条第 5 步）

export interface ReadCriteriaInput extends Scope {
  repo: Repo;
  /** 需求文档目录（specs/<号>-<短名>）：单子正文里指的那个（core 的 specDirOf 认出来的），不按标题拼。 */
  specDir: string;
}

export interface Criteria {
  /** 读的是哪份：默认分支上的 specs/<号>-<短名>/需求.md。 */
  path: string;
  /** 「怎么算做完」逐条原文（core 的 criteriaOf），至少一条。 */
  criteria: string[];
}

/** 一轮验证的记录（库里 verify_rounds 一行，同一个 id 整行覆盖）。 */
export interface VerificationRecord extends Scope {
  id: string;
  round: number;
  /** 送检的头。 */
  head: string;
  /** 验证会话（session_runs.id）和它的路由、族。 */
  runId: string;
  routeId: string;
  family: string;
  authorFamilies: string[];
  criteria: string[];
  /** 验证模型交回的原样。 */
  report: unknown;
  /** decideVerdict 判的，驳回之前。 */
  verdict: 'pass' | 'block' | 'invalid';
  invalidWhy?: string;
  /** Lead 拿证据驳回的。 */
  rebuttals: Rebuttal[];
  /** 驳回之后的结论（没驳回就是 verdict）；作废的不给。 */
  finalVerdict?: 'pass' | 'block';
  /** 驳回之后还挡着的，和写进 PR「还欠什么」的备注（看不出的、建议）。 */
  reasons: string[];
  notes: string[];
}

// ---- Fusion 开工前要读的（docs/decisions/0003-fusion-flow.md 第 9 条；specs/214-Fusion工作流/）

/** 这张单现在的标题和正文（库里 tasks 那一行，GitHub 上改了单子正文由接活跟着改）：认需求文档目录用。 */
export interface TaskRequest {
  title: string;
  /** 单子正文去掉进度段（正文空就是标题）。 */
  rawRequest: string;
}

// ---- 人、报警、计时

export interface AskHumanInput extends Scope {
  /** 工作流给的提问编号（库里 asks.id，UUID）：幂等键，同一个编号只发一张卡；人回答时带回来。 */
  askId: string;
  question: string;
  options?: string[];
  /** 会话里问的就带上是哪一次会话。 */
  runId?: string;
  /**
   * 引擎自己问、带了推荐的（分诊说不清，#259）：按推荐先做、不等回答，库里记成这张单范围内的岔路（scope = task），
   * 卡片写「已按推荐先做」。推荐的要在 options 里（库约束兜底）。不给就是老样子：发卡等回答。
   */
  recommended?: string;
}

/** 照改完：这几条提问记上 applied_at（#259：他晚到、改选了别的回答，存档点交给 Lead 照改完了）。 */
export interface MarkAsksAppliedInput extends Scope {
  askIds: string[];
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
  /**
   * changedFiles：推上去的头相对主线的净改动（推之前刚并了最新主线，git diff 主线...头）。老版端口推的没有（重放在途任务
   * 的历史里就是这样），工作流照旧按会话交的累计算。
   */
  pushBranch(input: PushBranchInput, ctx: PortContext): Promise<{ head: string; changedFiles?: string[] }>;
  runTests(input: RunTestsInput, ctx: PortContext): Promise<TestResult>;
  openPr(input: OpenPrInput, ctx: PortContext): Promise<PullRequestRef>;
  waitCi(input: WaitCiInput, ctx: PortContext): Promise<CiResult>;
  syncMainline(input: SyncMainlineInput, ctx: PortContext): Promise<SyncResult>;
  mergePr(input: MergePrInput, ctx: PortContext): Promise<MergeOutcome>;
  updateIssueProgress(input: UpdateIssueProgressInput, ctx: PortContext): Promise<void>;
  saveTaskState(input: TaskStateSnapshot, ctx: PortContext): Promise<void>;
  closeIssue(input: CloseIssueInput, ctx: PortContext): Promise<void>;
  writeSpecDoc(input: WriteSpecDocInput, ctx: PortContext): Promise<SpecDocRef>;
  /** 开 PR 前验证：读这张单的「怎么算做完」。文档不在、没有这一节，明确报错（SPEC_DOC_MISSING / CRITERIA_MISSING，不可重试）。 */
  readCriteria(input: ReadCriteriaInput, ctx: PortContext): Promise<Criteria>;
  /** 写这张单的会话用过的路由的族（验证只派别家）。一个都查不到明确报错（AUTHORS_UNKNOWN，不可重试），不回空的。 */
  authorFamilies(input: Scope, ctx: PortContext): Promise<{ families: string[] }>;
  /** 一轮验证写进库（同一个 id 整行覆盖，重试幂等）。 */
  recordVerification(input: VerificationRecord, ctx: PortContext): Promise<void>;
  /**
   * 这张单所在仓的流程配置副本（库里 repos 的 flow_* 列）：原样交回，能不能用由工作流经 decide 调 core 判。
   * 任务不在明确报错（TASK_NOT_FOUND，不可重试），不交空的。
   */
  flowConfig(input: Scope, ctx: PortContext): Promise<FlowConfigRead>;
  /** 这张单现在的标题和正文（单子正文里改了需求文档那一行，人点「继续」后重认）。任务不在明确报错（TASK_NOT_FOUND）。 */
  taskRequest(input: Scope, ctx: PortContext): Promise<TaskRequest>;
  askHuman(input: AskHumanInput, ctx: PortContext): Promise<void>;
  /**
   * 这张单的全部提问（库里 asks，按提问先后）：存档点看他晚到的回答、开 PR 写「按推荐先做了」、关单记数（#259）。
   * 任务不在明确报错（TASK_NOT_FOUND，不可重试），不拿「一条都没问过」顶。
   */
  taskAsks(input: Scope, ctx: PortContext): Promise<TaskAsk[]>;
  /** 照改完记 applied_at：只记这张单的、回答了的、没记过的（重试幂等）。 */
  markAsksApplied(input: MarkAsksAppliedInput, ctx: PortContext): Promise<void>;
  requestApproval(input: RequestApprovalInput, ctx: PortContext): Promise<void>;
  raiseAlert(input: RaiseAlertInput, ctx: PortContext): Promise<{ alertId: string }>;
  recordTiming(input: TimingEntry, ctx: PortContext): Promise<void>;
}

export type PortName = keyof EnginePorts;
