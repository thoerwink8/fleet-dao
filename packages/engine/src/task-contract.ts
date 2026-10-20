// 任务工作流（#632 S2-4；specs/632-三段总调度/方案.md §五）对外的约定：输入输出、信号、查询、新增活动的入参和结果。
// 驾驶舱后端（发「继续」「放弃」、读状态）和引擎共用这一份；工作流和活动都从这里拿类型。
// 这里是工作流代码也会引入的文件：运行时只引 @temporalio/workflow 的消息定义函数，别的一律只写类型。
// 输入进了工作流历史：以后只许加可选字段，不许改老字段的意思。

import type { FlowMode, FlowSource, Repo, RepoWithProfile, RunCause } from '@fleet-dao/shared';
import {
  type AbandonCommand,
  type ContinueCommand,
  type PauseCommand,
  type RepinCommand,
  type RouteWakeCommand,
  TASK_SIGNAL_NAMES,
} from '@fleet-dao/shared/task-signals';
import { defineQuery, defineSignal, defineUpdate } from '@temporalio/workflow';
import type { FailureEvidence } from './failure/types.ts';
import type { RouteChoice } from './ports.ts';
import type { PushHandbackReceipt, PushHandbackRequest } from './push-handback.ts';
import type { RequirementContract, TaskBrief } from './runner/task-brief.ts';
import type { TierDecision } from './runner/tier.ts';

/** 动手最多几轮（CI 红了、没交付、验收没过都回动手重来一轮）。这个数不随「继续」改变。 */
export const MAX_IMPLEMENT_ROUNDS = 3;
/** 验收最多几轮（默认 1 轮，最多 2 轮，specs/555）。这个数不随「继续」改变。 */
export const MAX_VERIFY_ROUNDS = 2;
/**
 * 动手或验收轮数用尽后点「继续」，最多自动把两轮计数清零几次（#1404）。
 * 超过就停下交给指挥官，不再清零。同一次继续之内仍受上面两个上限约束。
 */
export const MAX_ROUND_RESETS = 3;
/**
 * 全程模式（#2826）一张单最多交付几次：CI 红、冲突、冷验收被拒都续同一个会话、不算新的一轮，这个数兜底。
 * 每回到动手一次算一次（推上去的、交活没提交被打回的都算），到了停下等人。冷验收被拒的上限仍是 MAX_VERIFY_ROUNDS。
 */
export const MAX_FULL_PUSHES = 6;

/** 定这张单走三段还是全程（#2826）：第一次选路之后、第一段动手之前问一次，结果进历史，重放不再读配置。 */
export interface DecideFlowModeInput {
  schemaVersion: 1;
  taskId: string;
  repo: Repo;
  issueNumber: number;
  /**
   * 第一次选中的路由的模型 id（目录 id sonnet-5.5 / opus-5.5，或上游名字 claude-sonnet-5-5）。
   * 第一期只有 Claude 5.5（Sonnet 或 Opus）才可能进全程（决定 0105）。
   */
  modelId: string;
  /** 单子「已知的模块」每一项的原文：碰到迁移、合并闸、凭据、权限、任务工作流、发布脚本的一律三段。 */
  touches: string[];
  /** 分层（档位）：split 在同一档位里按单号哈希分组。 */
  stratum: string;
}

export interface DecideFlowModeResult {
  mode: FlowMode;
  source: FlowSource;
  /** 退回三段的原因（写进 task_flow_assignments.reason）；别的是 null。 */
  reason: string | null;
}
/** 一轮动手的会话最长多少分钟（one-shot 默认也是 60）。 */
export const SEGMENT_MINUTES = 60;
/** 等合并时每次长轮询多少分钟（工作流一直轮到合并、关闭或人放弃）。 */
export const MERGE_POLL_MINUTES = 15;
/**
 * 等合并时读到必过检查红了，隔这么多秒再读一次再决定返工（刚读到的红可能是旧的，和等 CI 确认红一样是 20 秒）。
 * 写死：不是上面那一轮 15 分钟，也不是一直等。
 */
export const MERGE_RED_CONFIRM_SECONDS = 20;
/**
 * 挂自动合并时 GitHub 说已经是 clean，但这个精确头上还有检查在跑（正文改成 Refs 会把 merge-gate 重新打进队列）：
 * 最多等这么多分钟（按工作流时间算的截止时刻，挂合并活动的排队、重试、状态落库、休眠都在里面），每隔 ARM_PENDING_POLL_SECONDS
 * 再走一次正常的挂自动合并。到点还没跑完就停下。不是按次数，不是无限重试，也不把 ci_not_green 这句原文当成「还在跑」。
 */
export const ARM_PENDING_CHECKS_MINUTES = 15;
/** 上面那段有界等待里，隔这么多秒再挂一次。写死，和等合并确认红一样是 20 秒。 */
export const ARM_PENDING_POLL_SECONDS = 20;

/** 同一张 PR 每段最多自动同步主线几次；耗尽后停下，只有对应停法的新「继续」才能续下一段，免得主线一直在动就一直转。 */
export const MAX_MAIN_SYNCS = 3;
/** 没有可用路由、或额度没读成时隔多久再选一次（秒）。 */
export const ROUTE_RETRY_SECONDS = 60;
/**
 * 强制 CI、停在等 CI（没配检查、超时、读失败）时，隔多久再读一次这个仓的 CI 模式（秒）。
 * 切成不强制就自己接着合并，不用人点「继续」。
 */
export const CI_POLICY_POLL_SECONDS = 30;

/**
 * 三段里经选路的那几段各按哪个用途选。定义在 shared 的 flow-purposes.ts：动手按 execute，验收按页面上叫「验收」的那一格
 * （verify）。选路的战绩按它把 runs 里这一段的结局算到这个用途上（real/store-ports.ts）：引擎和路由页读同一份，改一处两边一起变。
 * 对题不经选路，不在这里。界面活按 UI_PURPOSE（ui）。
 */
export { SEGMENT_STAGE, UI_PURPOSE } from '@fleet-dao/shared/flow-purposes';

export { taskBranch } from './task-branch.ts';

export interface TaskWorkflowInput {
  schemaVersion: 1;
  /** 库里的 tasks.id。 */
  taskId: string;
  repo: RepoWithProfile;
  issueNumber: number;
  title: string;
}

export type TaskPhase =
  | 'brief'
  | 'implement'
  | 'ci'
  | 'verify'
  | 'merge'
  | 'parked'
  | 'paused'
  | 'done'
  | 'abandoned';

/** 在等什么（驾驶舱「在跑的」每张单显示卡在哪一环、在等谁）。 */
export interface TaskWait {
  kind: 'human' | 'slot' | 'quota' | 'ci' | 'merge' | 'retry' | 'paused';
  detail: string;
  /** ISO 时刻。 */
  since: string;
}

/**
 * 停下等人的停法类别（#3294，patched('park-kind')）：引擎续停（jobs/parked-retry.ts）按它判续不续。
 * transient＝失败分流认不出、按临时的办；unarmed＝自动合并没挂上；rounds＝轮数用尽；quota＝token 额度超预算；
 * size＝改动体量超预算；standard＝改标准等人闸；other＝别的（不续）。
 */
export type ParkKind = 'transient' | 'unarmed' | 'rounds' | 'quota' | 'size' | 'standard' | 'other';

/** 引擎会自己续一次的停法：别的（预算、人闸、轮数用尽……）一律不续。 */
export const AUTO_RETRY_PARK_KINDS: readonly ParkKind[] = ['transient', 'unarmed'];

/** 引擎续停发「继续」时的 by（操作记录、工作流认引擎续的都看它）。 */
export const PARKED_RETRY_ACTOR = 'engine:parked-retry';

/** 正停着的这一次停下（#3294）：只在 patched('park-kind') 的新历史里有，老历史一直没有。 */
export interface TaskParkInfo {
  kind: ParkKind;
  /** 第几次停下（TaskRuntime.parks）：引擎续停的「继续」带上它，对不上的不认。 */
  seq: number;
  /** 停下的时刻（ISO，工作流时钟）。 */
  at: string;
  title: string;
  /** 停下时的 PR 头；没有 PR 是 null。 */
  head: string | null;
  /** 同一原文（停法 + 标题 + 原因）引擎已经续过一次：这次不再续。 */
  retriedBefore: boolean;
}

export interface TaskStatus {
  /** 最近一次安全边界核实的正式合同；没有＝旧历史/尚未核实。 */
  contract?: RequirementContract;
  phase: TaskPhase;
  /** 白话：正在做什么。 */
  doing: string;
  /** 动手第几轮、验收第几轮（0＝还没到）。 */
  round: number;
  verifyRound: number;
  prNumber: number | null;
  waiting: TaskWait | null;
  /** 最近一次卡住的原因；顺利推进时是 null。 */
  lastProblem: string | null;
  tier: TierDecision | null;
  /** 正停着的这一次停下（#3294）；没在停、老历史是缺省。 */
  park?: TaskParkInfo;
  /** 关单收尾能力。旧 worker 缺此字段，调用方必须保留未核实，不能回退无条件放弃。 */
  closedIssueClose?: { version: 1; token: ClosedIssueHoldToken | null };
  /**
   * 体量关口重评（#3249）：只有此刻确实停在体量预算停点、没有活动在跑、没人在重评时 identity 才非空。旧 worker 缺此字段＝不支持，
   * 调用方不能凭自由文本的停下原因猜身份。resumed 是最近一次可信重评放行绑定的停点、头和 base（放行后停点身份清空，
   * 同一请求重发凭它拿幂等回执；它不放行任何别的头）。
   */
  lineBudgetPark?: {
    version: 1;
    identity: LineBudgetParkIdentity | null;
    resumed?: { identity: LineBudgetParkIdentity; head: string; base: string } | null;
  };
  /** Separate from closed-issue abandonment: real merged PR, even when acceptance keeps its issue open. */
  mergedTaskClose?: {
    version: 1;
    token: ClosedIssueHoldToken | null;
    repo: { owner: string; name: string };
    prNumber: number | null;
    head: string | null;
  };
}

/** 只在这一 run 的这一次停法有效；继续信号收到时立即失效，不等公开 phase 回写。 */
export interface ClosedIssueHoldToken {
  version: 1;
  runId: string;
  kind: 'parked' | 'paused';
  generation: number;
  continued: number;
}

export type ClosedIssueCloseResult = 'accepted' | 'stale' | 'busy';
export interface ClosedIssueCloseCommand {
  token: ClosedIssueHoldToken;
  command: AbandonCommand;
}

/** 同步处理并回执：发请求成功不能冒充工作流已经消费。 */
export const taskCloseClosedIssueUpdate = defineUpdate<ClosedIssueCloseResult, [ClosedIssueCloseCommand]>(
  'taskCloseClosedIssue',
);

export const taskHandbackPermissionPushUpdate = defineUpdate<PushHandbackReceipt, [PushHandbackRequest]>(
  'taskHandbackPermissionPush',
);

/** Temporal 私有只读查询；check 不写历史，execute 仍需 Activity 重新核验。 */
export const taskPushHandbackQuery = defineQuery<
  import('./push-handback.ts').PushHandbackPreflightInput | null
>('taskPushHandback');

export interface MergedTaskReceipt {
  repo: { owner: string; name: string };
  prNumber: number;
  head: string;
  mergeCommit: string;
}

export interface ReadMergedTaskInput {
  schemaVersion: 1;
  repo: { owner: string; name: string };
  prNumber: number;
  expectedHead: string;
  expectedMergeCommit?: string;
  /** Merged settlement rechecks detached sessions. The closed-issue entry also requires idle for open PRs. */
  idle?: { issueNumber: number; workflowId: string; includeOpen?: true };
}

export const taskSettleMergedUpdate = defineUpdate<
  ClosedIssueCloseResult,
  [{ token: ClosedIssueHoldToken; receipt: MergedTaskReceipt }]
>('taskSettleMerged');

/**
 * 体量预算停点身份（#3249）：只在这一 run 的这一次停下有效。继续信号、再次停下、放弃、换代都会让它对不上。
 * parks / generation / continued 三个数一起定「第几次停」；head 是被停下的那份交付的头。
 */
export interface LineBudgetParkIdentity {
  version: 1;
  runId: string;
  parks: number;
  generation: number;
  continued: number;
  prNumber: number | null;
  head: string;
  /** 停下时 readDelivery 的原始新增行、按预算判的行（可信折扣之后），预算是停下时这张单的 prLineBudget。 */
  rawAddedLines: number;
  chargeableAddedLines: number;
  budget: number;
  /**
   * 停下时原始新增行实际按的固定 base（readDelivery 的 addedLinesBase，与 lineBudgetMeasurement.base 互相印证）。
   * 重评只认这个 base，不能换另一个同 raw 的旧祖先改测量范围；老版本停下的没记（null），重评明确拒绝。
   */
  base: string | null;
}

/** 预检用 check（只测不放行）；执行用 resume（测过且不超原预算才放行这一份交付）。 */
export interface RemeasureLineBudgetCommand {
  version: 1;
  mode: 'check' | 'resume';
  identity: LineBudgetParkIdentity;
  repo: { owner: string; name: string };
  taskId: string;
  workflowId: string;
  /** 精确的头和固定的测量 base：必须等于停点身份里停下时记的 base，且仍是头相对树里钉的主线的 merge-base。 */
  head: string;
  base: string;
  by: string;
}

export interface LineBudgetRemeasureReceipt {
  identity: LineBudgetParkIdentity;
  base: string;
  head: string;
  rawAddedLines: number;
  verifiedGeneratedLines: number;
  chargeableAddedLines: number;
  budget: number;
  reason: string;
}

export type LineBudgetRefusal =
  | 'unsupported' // 旧 worker / 活动没按重评口径回答
  | 'identity' // repo / task / workflow / 参数形状对不上
  | 'stale' // 不在这个停点（旧停点、换代、已继续、放弃、已结束）
  | 'busy' // 别的重评或在跑的活动
  | 'unknown' // 读失败、超时、取消：未知，不当 0 或 ok
  | 'changed' // 头、基线、工作树干净程度变化
  | 'unverified' // 没有可信完整测量
  | 'over_budget'; // 实际计量仍超原预算

export type RemeasureLineBudgetResult =
  | { outcome: 'eligible' | 'resumed' | 'already_resumed'; receipt: LineBudgetRemeasureReceipt }
  | { outcome: 'refused'; reason: LineBudgetRefusal; detail: string };

/** 同步处理并回执：发请求成功不能冒充工作流已经放行。 */
export const taskRemeasureLineBudgetUpdate = defineUpdate<
  RemeasureLineBudgetResult,
  [RemeasureLineBudgetCommand]
>('taskRemeasureLineBudget');

export interface TaskRun {
  outcome: 'merged' | 'abandoned';
  prNumber: number | null;
  head: string | null;
  rounds: number;
  verifyRounds: number;
  /** 合了、可验收责任还开着几条（#3037）：单子没关，等最终验收完成。没有开着的不带这个字段。 */
  acceptanceOpen?: number;
}

// 信号的名字和参数形状在 shared/task-signals.ts：驾驶舱后端发信号也从那里拿，两边不各拼一遍（#901）。
// 路由叫醒（RouteWakeCommand）：切号完成由引擎发（real/route-wake.ts）；「继续」也带一发（#2392），
// 因为等选路的那一觉不看 taskContinue。信号丢了：等空位、熔断最多再等
// MAX_ROUTE_WAIT_SECONDS；等额度且清零时刻明确按 until 睡，不超过 QUOTA_ROUTE_WAIT_CAP_SECONDS（real/store-ports.ts）。
export type { AbandonCommand, ContinueCommand, PauseCommand, RepinCommand, RouteWakeCommand };

export const taskContinueSignal = defineSignal<[ContinueCommand]>(TASK_SIGNAL_NAMES.continue);
export const taskAbandonSignal = defineSignal<[AbandonCommand]>(TASK_SIGNAL_NAMES.abandon);
export const taskRouteWakeSignal = defineSignal<[RouteWakeCommand]>(TASK_SIGNAL_NAMES.routeWake);
export const taskPauseSignal = defineSignal<[PauseCommand]>(TASK_SIGNAL_NAMES.pause);
export const taskRepinSignal = defineSignal<[RepinCommand]>(TASK_SIGNAL_NAMES.repin);
export const taskStatusQuery = defineQuery<TaskStatus>('taskStatus');

// ---- 新增的活动（EngineActivities 里的「任务」一组）

export interface ReadTaskBriefInput {
  /** 安全边界读取；旧历史缺此字段，不能伪造已核当前合同。 */
  checkContract?: true;
  schemaVersion: 1;
  repo: Pick<Repo, 'owner' | 'name'>;
  issueNumber: number;
  /** 安全边界读取：过期或读取失败必须先阻合；旧输入没有。 */
  contractGuard?: { prNumber: number; expected?: RequirementContract };
}

/** 起一段动手会话。runId 由活动自己起（每次尝试一个，进 runs 表的主键），工作流里不生成编号。 */
export interface RunSegmentInput {
  /** 新版正式正文必须完整交给续会话，不能走日志反馈的长度截断。 */
  contractRevision?: { reviews: string[] };
  schemaVersion: 1;
  /** 库里的 tasks.id（runs 里这一段挂在这张单上，#216）。 */
  taskId: string;
  repo: Repo;
  issueNumber: number;
  route: RouteChoice;
  /** 这张单的工作树（会话用户的）。 */
  worktreePath: string;
  branch: string;
  /** 工作树从哪个提交起的：判「有没有真提交」用。 */
  baseSha: string;
  brief: TaskBrief;
  tier: TierDecision;
  /** 前几轮留下的返工意见（CI 失败日志、验收问题表、没产生提交），新一轮的会话要照着改。 */
  feedback: string[];
  timeoutMinutes: number;
  /**
   * 这一段上一次跑到一半被停下了（切号，#59）：为什么停的那一句。重跑时写进提示词——树里可能留着上一次的提交和没提交的改动，
   * 新会话接着干、别从头来。没被停过的不给。
   */
  interrupted?: string;
  /**
   * 为什么起这一笔、接着做什么、属于第几个回合（#3140，只记账：runs.cause / cause_summary / round_seq，会话看不到）。
   * 工作流在 patched('run-cause-fields') 之后才给；老历史里没有这几个字段，那几笔记成「老记录没记」。
   */
  cause?: RunCause;
  causeSummary?: string;
  roundSeq?: number;
  /**
   * 判定不续上一段、开新会话的原因（#3140，runs.resume_reason）。新历史直接给它；老历史借 route.why 的内部标记
   * （fleet-resume-new:…）带，runner 仍认，只为在途任务重放。
   */
  resumeReason?: string;
  /**
   * 续哪个会话（决定 0088 第 3 条）：工作流经 planSegmentResume 判定能续才给。给了就用执行体的续会话起（--resume 一类），
   * 提示词只补一句被打断的原因和返工意见，不重述整张单。续起来没跑成的，下一次退回开新会话。老历史里没有这个字段。
   */
  resumeSessionId?: string;
  /**
   * 这张单的 PR：第一轮动手时还没开（引擎在会话交付之后才开），不给；开了以后每一轮都给。只记账（runs.pr_number，#216），
   * 会话不看它。老历史里没有这个字段。
   */
  prNumber?: number;
  /**
   * 接回（#2238）：上一次 runSegment 交回 SEGMENT_DETACHED，会话还在自己的 scope 里跑。给了就不建树、不拼提示词、不起会话，
   * 从收发目录读回已有的输出、等它收场，结局照常记到原来那一行 runs。老历史里没有这个字段。
   */
  attach?: SegmentAttach;
  /**
   * plan＝重活先出方案的那一段（#2755）：提示词照常给交代和规矩，另说这一段只读、不改文件不提交，最后一条回复只回方案 JSON。
   * 不给就是照常动手。老历史里没有这个字段。
   */
  mode?: 'plan';
  /**
   * full＝这张单走全程（#2826）：提示词多一节「这张单到合并都归你」。三段的单、老历史里没有这个字段，提示词一字不变。
   */
  flowMode?: 'full';
}

/**
 * 动手会话被切号停下时的结局和原因码（#59）：失败分流 OS1 认它（不算失败、不记账、马上接着干），工作流切完在原分支上重跑这一段，
 * 提示词里带上 interrupted。和 runner/one-shot.ts 的结局 org_switch 是同一个词。
 */
export const ORG_SWITCH_CODE = 'org_switch';

/**
 * 单任务被人暂停（#820 片 3）：hard 暂停停下的动手会话，原因写这一句，重跑时和切号一样进提示词的 interrupted（树里留着上一次的东西，接着干）。
 * 借 org_switch 的位置：工作流这一侧当切号停下对待（不算失败、不记账、不换模型）；runs 表的结局不新增 paused（要改 CHECK 约束，方案 §要定的 4）。
 */
export const PAUSED_BY_HUMAN = '被人暂停';

/** 动手会话没跑成时给失败分流的证据（字段照 FailureEvidence，工作流补上 routeId 这些再交给分流）。 */
export type SegmentEvidence = Pick<
  FailureEvidence,
  'code' | 'message' | 'exitCode' | 'httpStatus' | 'resetsAt'
> & { quotaExhausted: boolean };

/** 当前活动所在的引擎进程启动时刻，用来核对超时活动是不是被重启丢掉。 */
export interface EngineStartedAt {
  schemaVersion: 1;
  startedAt: string;
}

/**
 * 动手会话脱开引擎跑着、引擎要走了（停机信号：发版切版本、重启）时这一段的结局（#2238）：会话没停，接着在自己的 scope 里跑、往
 * 收发目录写；工作流隔一小会儿带上 attach 再调一次 runSegment，由下一个引擎从文件接回、等它收场。runs 那一行不收、不记账。
 * evidence 的码是 engine_stop（失败分流 KL3：不算失败、不记账、续上），只给认不出 detached 的路兜底。
 */
export const SEGMENT_DETACHED = 'detached';

/** 接回一段脱开引擎跑着的动手会话要的东西：哪一次（runs 编号）、什么时候起的（总时长照原来的起点算）。 */
export interface SegmentAttach {
  runId: string;
  startedAt: string;
}

export type RunSegmentResult =
  | { ok: true; runId: string; answer: string; costUsd?: number; actualModel?: string }
  | {
      ok: false;
      runId: string | null;
      outcome: string;
      evidence: SegmentEvidence;
      /** outcome 是 SEGMENT_DETACHED 时给：带上它再调 runSegment 接回（RunSegmentInput.attach）。 */
      detached?: SegmentAttach;
    };

export interface ReadDeliveryInput {
  schemaVersion: 1;
  taskId: string;
  repo: Repo;
  worktreePath: string;
  baseSha: string;
  /**
   * 体量关口重评（#3249，可选）：不读会话交付，只在这棵树上对精确 head、固定 base 重做可信计量。
   * 老 worker 不认这个字段，回的交付里没有 budgetRemeasure，工作流按不支持处理。
   */
  budgetRemeasure?: { head: string; base: string; rawAddedLines: number };
}

/** 重评的活动回答（DeliveryRead.budgetRemeasure）：拒绝带原因；测量带测量前后核对过的头和干净程度。 */
export type BudgetRemeasureRead =
  | {
      version: 1;
      status: 'measured';
      head: string;
      base: string;
      /** 测量之后重读的头和工作树状态；与入参不同＝测量期间换了。 */
      headAfter: string;
      cleanAfter: boolean;
      measurement: LineBudgetMeasurement;
    }
  | { version: 1; status: 'refused'; reason: 'head' | 'base' | 'dirty' | 'raw'; detail: string };

/** 会话交付的东西：工作树现在的头、比起点多了几个提交、改了哪些文件。读不到抛错，不回空。 */
export interface DeliveryRead {
  head: string;
  commits: number;
  changedFiles: string[];
  /**
   * 工作树里还有没提交的改动（含没加进 git 的新文件，不含 .gitignore 忽略的）。有就不算交付完：只有提交了的才会进 PR。
   * 真实现一定给；老历史里没有这个字段（当作没有）。
   */
  leftover?: string[];
  /**
   * 还没解完的冲突：MERGE_HEAD 还在，或 git diff --check 看到冲突标记。有就不算交活，也不进下一步。
   * 真实现一定给（没有就是空数组）；老历史里没有这个字段（当作没有）。
   */
  conflicts?: string[];
  /**
   * 交的头相对钉住主线的原始新增行数，始终与 GitHub additions 同口径。当前真实读取失败抛错；老历史缺省不判预算。
   */
  addedLines?: number;
  /**
   * addedLines 实际按哪个 base 数的（头相对钉住主线的 merge-base，#3249）。体量停点把它记进停点身份，重评只认它；
   * 老历史缺省＝停下时没记，重评明确拒绝，不拿现在的主线或请求者给的旧祖先顶替。
   */
  addedLinesBase?: string;
  /** #3242：原 addedLines 永远是 raw；此项只供新版本预算判断，缺省沿用原判。 */
  lineBudgetMeasurement?: LineBudgetMeasurement;
  /** 只在 ReadDeliveryInput.budgetRemeasure 给了时才有（#3249）；这时其它交付字段不代表会话交付。 */
  budgetRemeasure?: BudgetRemeasureRead;
}

export interface LineBudgetMeasurement {
  version: 1;
  base: string;
  head: string;
  rawAddedLines: number;
  rawDiffBytes?: number;
  verifiedGeneratedLines: number;
  chargeableAddedLines: number;
  verified: boolean;
  reason: string;
}

export interface ColdVerifyInput {
  contract?: RequirementContract;
  schemaVersion: 1;
  taskId: string;
  repo: Repo;
  issueNumber: number;
  prNumber: number;
  branch: string;
  baseSha: string;
  headSha: string;
  /** 「要什么」原文、「怎么算做完」逐条。 */
  what: string;
  howToFinish: string[];
  /** 验收这一笔属于第几个回合（task_rounds.seq，#3140，只记账：runs.round_seq）；老历史没有。 */
  roundSeq?: number;
  /** 写这张单的会话用过的路由的族（验收换一个不同的族）。 */
  authorFamilies: string[];
  round: 1 | 2;
  /** 引擎在会话收场后自己跑过的测试输出（有才给）：放进验收材料（决定 0093）。老历史里没有这个字段。 */
  testOutput?: string;
  /**
   * 第 2 轮复核（patched('verify-recheck')）。sinceSha 是上一轮验收时的头，这一轮 diff 用 sinceSha..headSha。
   * failedCriteria 是上轮问题里的验收条编号（从 1 起）。priorProblems 是上轮问题原话。老历史没有。
   */
  recheck?: {
    failedCriteria: number[];
    sinceSha: string;
    priorProblems: string[];
  };
  /**
   * 接回（#2848，和动手段的 RunSegmentInput.attach 同一个意思）：上一次 coldVerify 交回 detached，验收会话还在跑。
   * 给了就不选路、不拼提示词、不起会话，接回那一次会话、等它收场，结论照常贴、结局记到原来那一行 runs。老历史里没有这个字段。
   */
  attach?: ColdVerifyAttach;
}

/** 脱开引擎跑着的那一次验收会话（#2848）：接回要的东西。 */
export interface ColdVerifyAttach {
  /** runs 编号（收发目录也按它）。 */
  runId: string;
  /** 起的时刻：接回后总时长照它算，结局记回那一行用同一个起点。 */
  startedAt: string;
  /** 验它的族、模型、路由、池：接回时登记切号、记账照原样。 */
  family: string;
  modelId: string;
  routeId: string;
  poolId: string;
  /** 选路那句「为什么派它」：接回收场那一笔整行覆盖开跑那一行，带上原来的。选路没给就没有。 */
  routeWhy?: string;
  /** 会话的工作目录（验收的空目录，归会话用户）：放手时留着，接回收场后删。 */
  cwd: string;
}

export interface ColdVerifyResult {
  /** 原会话已收场，但正式合同变化，不能认其结论或复用增量验收。 */
  contractChanged?: true;
  /** 验收有结论且通过。 */
  pass: boolean;
  /** 只有三种能挡：没做到验收条、弄坏了原有功能、安全或丢数据。 */
  problems: string[];
  notes?: string;
  round: 1 | 2;
  /**
   * 验收没能做出来（读不到 diff、没有别家的模型能用、冷调用没跑成）：不是「没过」，返工解决不了——有这个字段，
   * 工作流停下报人（等条件好了点「继续」重验），不回去让写代码的会话白改一轮。
   */
  unavailable?: string;
  /**
   * 这会儿验不了、但过一会儿再来就行（没空位、内存放不下、额度要等、引擎在停机发布）：不是没过，也不是做不出来。
   * 工作流隔 afterSeconds 秒再验一次，不算一轮、不停下报人。老历史里没有这个字段，当作没有。
   */
  retry?: { wait: 'slot' | 'quota'; reason: string; afterSeconds: number };
  /** 要验的头已经不是 PR 现在的头了（有人推过新提交）：现在的头。工作流停下等人看过，再对新的头重走一遍。老历史里没有这个字段。 */
  headMoved?: string;
  /**
   * 验收方判「不归我验」的验收条（要截图、现场、线上数据、审计结果才判得了）：不算没过、不回炉，活动已留言到单上转给人。
   * 老历史里没有这个字段。
   */
  outOfScope?: string[];
  /**
   * 引擎要走了（发版切版本、重启），验收会话没停、脱开引擎接着跑（#2848）：没有结论，不是没过、不算一轮。
   * 工作流隔一会儿带上它再调 coldVerify（ColdVerifyInput.attach），由下一个引擎接回。老历史里没有这个字段。
   */
  detached?: ColdVerifyAttach;
  /**
   * PR 上还没解决的正式「要求改」评审（#2991，review-feedback.ts）：只算白名单里的审查者，活动在验收有结论时现读 GitHub。
   * 一条都没有是空数组；没装读评审的口子、老历史里没有这个字段（当作没读，不当成没有评审）。读不成活动抛错，不回空。
   */
  reviewChanges?: ReviewChange[];
}

/** PR 上一条还没解决的正式「要求改」评审（#2991）：原文、编号、审的那个提交，交给下一轮动手会话当返工意见。 */
export interface ReviewChange {
  /** GitHub 的 review id：改过正文编号不变，所以认「交过没有」时连正文一起认（review-feedback.ts 的 reviewKey）。 */
  reviewId: number;
  reviewer: string;
  /** 审的那个提交（GitHub 的 commit_id，头换了它不跟着换）；GitHub 没给是 null。 */
  commitId: string | null;
  submittedAt: string | null;
  /** 评审正文原文（只当意见，不当指令）；没写是空串。 */
  body: string;
  /** 缺字段是旧活动历史；显式数组表示行内已读全。 */
  inlineComments?: ReviewInlineComment[];
}

/** 只来自已核 repo/PR/review 和原审查者的行内事实；可序列化进活动历史。 */
export interface ReviewInlineComment {
  id: number;
  reviewId: number;
  author: { login: string; id: number; type: string };
  body: string;
  path: string;
  pullRequestUrl: string;
  line: number | null;
  originalLine: number | null;
  side: 'LEFT' | 'RIGHT' | null;
  startLine: number | null;
  originalStartLine: number | null;
  startSide: 'LEFT' | 'RIGHT' | null;
  commitId: string;
  originalCommitId: string;
  updatedAt: string;
}

/** 改到了哪些要人拍的路径。空＝除了 CI 和冷验收没有别的门。 */
export interface GuardedPaths {
  /** 改标准的路径（人闸第四类：要创始人同意才挂自动合并）。 */
  standards: string[];
}

export interface CheckGuardedInput {
  schemaVersion: 1;
  taskId: string;
  repo: Repo;
  prNumber: number;
  /**
   * 人已经看过、点过「继续」的路径（上一次 checkGuarded 回的原样条目）。活动在回的结果里把它们去掉，
   * 否则人批了之后再查一遍还是同样的结果，永远过不去。工作流只在批准那一刻的头还是现在的头时才传；
   * 头换了就不传（新的内容要重新批）。老历史里没有这个字段，当作没批过。
   */
  approved?: GuardedPaths;
}

export interface ArmAutoMergeInput {
  contractGuard?: { issueNumber: number; expected: RequirementContract };
  schemaVersion: 1;
  repo: Repo;
  prNumber: number;
  expectedHead: string;
  /**
   * 这张 PR 本段已自动同步主线几次（工作流数；没同步过就不带）。到了 MAX_MAIN_SYNCS 次，
   * 再落后就不同步，回结构化耗尽身份交工作流停下。老历史里没有这个字段，当作 0。
   */
  syncedBehind?: number;
}

/** 本次精确 PR/头上的同步段已耗尽；只供明确停下后的「继续」续一段有限预算。 */
export interface MainSyncBudgetExhausted {
  prNumber: number;
  headSha: string;
  used: number;
}

export interface ArmAutoMergeResult {
  contractChanged?: true;
  /** 自动合并挂上了（或本来就挂着）。 */
  armed: boolean;
  /** 挂的时候发现已经合了（或本来就满足合并条件、当场合了）。 */
  merged: boolean;
  /** merged 时的合并提交。 */
  mergeCommit?: string;
  why?: string;
  /** 没挂是因为 PR 本身关了、还是草稿（要人处理，引擎续停不续）。老历史没有这个字段。 */
  refused?: 'closed' | 'draft';
  mainSyncBudgetExhausted?: MainSyncBudgetExhausted;
  /** 挂的时候发现 PR 的头已经不是引擎验过、推上去的那个了（有人改过）：现在的头。老历史里没有这个字段。 */
  headMoved?: string;
  /**
   * headMoved 是引擎自己刚把 PR 同步到最新主线造成的（直接合被拒、因为落后主线）：工作流不停下，直接对新头重走 CI 和验收。
   * 老历史里没有这个字段，当作没有（头是别人改的）。
   */
  syncedMain?: true;
  /**
   * 挂之前现读到 PR 上还挂着认可审查者的正式「要求改」（#2991）：没挂（已挂着的撤掉了）、没合，交给工作流转给工人。
   * 老历史里没有这个字段。
   */
  reviewChanges?: ReviewChange[];
  /**
   * clean 之后直接合被拒，现读这个头：必过检查里还有 queued / in_progress，不是红、不是没出现、也不是没查成。
   * 工作流有界等待后重新走挂自动合并。只认这个结构，不认 why 里的「没跑完」。老历史没有这个字段。
   */
  checksPending?: {
    /** 还在跑的检查名。至少一条。 */
    names: string[];
    /** 绑住的头，和这次 expectedHead 同一个。头不是这个就不能接着等。 */
    head: string;
    /** 直接合被拒的原文。等到点了原样留下。 */
    detail: string;
  };
  /**
   * 同一条路上现读到真红。工作流按等合并的确认 / 返工走，不当成还在跑。老历史没有这个字段。
   */
  checksRed?: {
    failedChecks: string[];
    detail: string;
    /** 现读的那个头。和 expectedHead 不是同一个就当头变了，不拿旧头的红或绿往下用。 */
    head: string;
  };
}

/** 现读这个仓现在的 CI 模式。工作流每次走到等 CI 之前读，不在拉单那一刻定死。 */
export interface ReadCiPolicyInput {
  schemaVersion: 1;
  repo: Repo;
}

export interface ReadCiPolicyResult {
  mode: 'force' | 'off';
}

/**
 * CI 红了、回动手之前现读这张 PR 上仍有效的正式评审（patched('ci-red-review-context')）。
 * 读的是 expectedHead；旧头上的评审可以留在结果里，不按 commit 等于当前头过滤。
 */
export interface ReadCiReviewsInput {
  schemaVersion: 1;
  taskId: string;
  repo: Repo;
  branch: string;
  prNumber: number;
  /** CI 红的那个头。读之前或读期间头变了，不把读到的内容当完整快照。 */
  expectedHead: string;
}

/**
 * delivered：这一头的正式评审已经读全（reviews 空数组＝确实没有还有效的要求改）。
 * 没 delivered：没核实完。不能当成没有评审，也不能沿用上一次的快照。headMoved 是当时 PR 的新头。
 */
export type ReadCiReviewsResult =
  | { delivered: true; head: string; reviews: ReviewChange[] }
  | { delivered: false; reason: string; headMoved?: string };

/** 不强制 CI 的仓：开完 PR、查完改标准路径之后由引擎直接合并（不等检查、不挂自动合并）。 */
export interface MergeNowInput {
  contractGuard?: { issueNumber: number; expected: RequirementContract };
  schemaVersion: 1;
  repo: Repo;
  prNumber: number;
  expectedHead: string;
  /** 这张 PR 本段已自动同步主线几次。到了 MAX_MAIN_SYNCS 次就不再同步，回结构化耗尽身份。 */
  syncedBehind?: number;
}

export interface MergeNowResult {
  contractChanged?: true;
  merged: boolean;
  mergeCommit?: string;
  reason?: 'conflict' | 'head_moved' | 'behind_main' | 'closed' | 'review_changes' | 'other';
  detail?: string;
  mainSyncBudgetExhausted?: MainSyncBudgetExhausted;
  /** 头已经不是 expectedHead。syncedMain 为 true 时是引擎自己同步主线换的头。 */
  headMoved?: string;
  syncedMain?: boolean;
  /** 合之前现读到还挂着的正式「要求改」（#2991，reason 是 review_changes）：没合。老历史里没有这个字段。 */
  reviewChanges?: ReviewChange[];
}

export interface WaitMergedInput {
  contractGuard?: { issueNumber: number; expected: RequirementContract };
  schemaVersion: 1;
  repo: Repo;
  prNumber: number;
  expectedHead: string;
  minutes: number;
}

/** 停在合并这一步时现读一次 PR：条件都满足了（#3281）就自己醒来接着合，不等人点「继续」。只读。 */
export interface MergeReadyInput {
  schemaVersion: 1;
  repo: Repo;
  prNumber: number;
  expectedHead: string;
}

export interface MergeReadyResult {
  /** 已合并，或开着、头没变、没有挂着的「要求改」、必过检查（含合并闸、cold-verify）全绿。 */
  ready: boolean;
  /** 为什么能 / 不能，写进等待那一行。 */
  why: string;
}

/** 停在合并这一步（等检查超时、挂合并没成、检查没查成）后多久现读一次 PR，条件满足就自己醒（#3281）。 */
export const MERGE_PARK_RECHECK_SECONDS = 60 * 60;

export type MergeWait =
  | { state: 'contract_changed' }
  | { state: 'merged'; mergeCommit?: string }
  | { state: 'closed' }
  | { state: 'head_moved'; head: string }
  /** 自动合并被撤掉了（人撤的，或 GitHub 因为头变了撤的）：回去重新挂。 */
  | { state: 'unarmed' }
  /**
   * PR 和主线冲突（GitHub 的 mergeable=false / mergeable_state=dirty，自动合并永远等不到）：工作流去并主线
   * （能自动并的并上，并不动交回会话解），不留在等合并的循环里（#1838：#1824 卡了 7 小时 45 分就是这么来的）。
   * 老历史里没有这个状态（那时候冲突只回 waiting）。
   */
  | { state: 'conflict'; detail: string }
  /**
   * 必过检查红了（含合并闸、cold-verify）。和「还在跑」都可能是 mergeable_state=blocked，不能都当 waiting。
   * 老历史里没有这个状态（那时候红了也回 waiting，工作流一直等）。
   */
  | { state: 'checks_red'; failedChecks: string[]; detail: string }
  /**
   * 必过检查没出现，或跑完了却不是在跑、也没有能认的结论。接着轮询不会自己变好。
   * 老历史里没有这个状态（那时候没分开报，一直等到时限回 waiting）。
   */
  | { state: 'checks_unreadable'; detail: string }
  /**
   * 等合并时 PR 上出现了认可审查者的正式「要求改」（#2991）：活动已把自动合并撤掉，交工作流转给工人或停下等审查者。
   * 老历史里没有这个状态。
   */
  | { state: 'review_changes'; reviewChanges: ReviewChange[] }
  | { state: 'waiting'; detail: string };

/** 派单前对选定的这一条路由探一次（#1409）。label 是写进任务状态的名字（模型 id）。 */
export interface ProbeAssignedInput {
  schemaVersion: 1;
  routeId: string;
  label: string;
}

/**
 * pass：可以派。结论已经在 routes 上（这一次写上了，或 15 分钟内刚探通、或规矩写明不探）。probed 为假是没真探。
 * fail：这一条本轮不能派。探通但结论写不进 routes 也算不通，不起会话。counted 为真才占「每轮最多当场探 3 条」的名额（组织认不出、路由被删了不占）。
 */
export type ProbeAssignedResult =
  | { kind: 'pass'; label: string; detail: string; probed: boolean }
  | { kind: 'fail'; label: string; detail: string; counted: boolean };

/** 派前探测不通、这轮不用这条路由：放掉选路时预占的名额（#1409）。没进起会话，不能占着池。 */
/**
 * 动手会话收场后引擎自己跑一遍测试和类型检查（决定 0093）：仓的测试命令（repos.test_command）和 tsc，在会话的树里、以会话用户跑。
 * 有时限，没跑成不挡原流程。
 */
export interface SelfCheckInput {
  schemaVersion: 1;
  taskId: string;
  repo: RepoWithProfile;
  worktreePath: string;
  /** 只由新 patched 历史携带；旧历史保持本机自测。 */
  expectedHead?: string;
  prNumber?: number;
}

/** 规范 CI 对源码测试的覆盖，不能计作本机 PASS。 */
export interface CiTestCoverage {
  repo: 'thoerwink8/fleet-dao';
  pr: number;
  head: string;
  tree: string;
  run: number;
  attempt: number;
  workflow: number;
  contractCommit: string;
  contractHash: string;
  checks: string[];
  ciNodes: string[];
  node: string;
}

/** 一条命令的结果：精炼过的输出（失败的行和末尾一段，不是整份日志）。 */
export interface SelfCheckStep {
  command: string;
  outcome: 'pass' | 'fail' | 'skipped';
  /** 退出码；超时、起不来是 null。 */
  exitCode: number | null;
  /** 精炼过的输出（SELF_CHECK_DIGEST_MAX 以内）；跳过的写为什么跳过。 */
  digest: string;
  /** outcome 仍是 skipped：这条没有在本机实跑。 */
  coveredByCi?: CiTestCoverage;
}

/**
 * green：跑了的都过了（可能有跳过的）。red：至少一条没过。skipped：一条都没跑成（没装依赖、树不在、没有命令……），reason 写为什么。
 * 不抛：没跑成也回 skipped，原流程照旧推 PR 交给 CI。
 */
export type SelfCheckResult =
  | { state: 'green' | 'red'; steps: SelfCheckStep[] }
  | { state: 'skipped'; reason: string; steps: SelfCheckStep[] };

/** 精炼输出最多多少字：喂回会话、交给冷验收都用这一份。 */
export const SELF_CHECK_DIGEST_MAX = 4000;

/**
 * 这张单到现在花掉多少 token（四样相加，动手和验收都算）。读不到的行不算进去，数出有几行没读到。
 * since 只算这一刻之后起的会话（当前这一代的开工时刻）。不给就整张单都算——老历史重放不带这个字段。
 */
export interface TaskSpendInput {
  schemaVersion: 1;
  taskId: string;
  /** ISO 时刻。当前这一代的起算时间；不给就整张单累计。 */
  since?: string;
}

/**
 * 记下这个池这一次只凭 HTTP 401，并回答窗口里是不是已经有过一次（别的任务记的也算）。
 * claim 重试时不变：同一次活动重试不会把自己数成第二次。now 是工作流时间（ISO）。
 */
export interface NoteBare401Input {
  schemaVersion: 1;
  poolId: string;
  now: string;
  claim: string;
}

export interface NoteBare401Result {
  repeated: boolean;
}

/** 单任务 token 预算的默认值见 limits.ts 的 DEFAULT_TASK_TOKEN_BUDGET。 */
export interface TaskSpendResult {
  /** 原始四样相加（老字段，老历史记的结果里只有这个）。 */
  tokens: number;
  runs: number;
  /** 用量还空着的行数（被叫停、超时杀，或中转会话的用量稍后才补）：花掉的只多不少。 */
  unmetered: number;
  /**
   * 那几行估出来的下限（按这张单记到用量的行的每分钟速率乘它们跑过的分钟数；一行记到的都没有是 0）。预算判断把它一起算进去，
   * 页面上写明是估的。
   */
  estimated: number;
  /**
   * #2859：预算按输入当量判。当量只在活动里算（toTaskSpendResult），工作流不重算：下面这几项都是可选的，
   * 新活动结果带全；老历史里记的结果没有它们，工作流退回用 tokens / estimated，重放判法和原来一样。
   */
  /** 原始四样（新输入、输出、缓存读、缓存写），缺的按 0 加。 */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** 输入当量（shared 的 inputEquivalentOf）。预算判超没超看它；四样有读不到的折不成就不给。 */
  inputEquivalent?: number;
  /** estimated 按同一比例折成当量后的数。 */
  inputEquivalentEstimated?: number;
  /**
   * 只读，不再写：#2830 的活动结果记在这两个名下（缓存读乘 0.1 的数）。在途单的历史里还有，重放要照原样读，
   * 所以字段留着；新结果不带。
   */
  weighted?: number;
  weightedEstimated?: number;
}

/**
 * 判这一段能不能续上一段的会话（决定 0088 第 3 条）。上一段用 runId 指名（跑完了的那一次）或 startedAfter（被取消的那一次，
 * 工作流拿不到编号：找这之后起的最近一次动手）。routeId 是这一次选定的路由。
 */
export interface PlanSegmentResumeInput {
  schemaVersion: 1;
  taskId: string;
  routeId: string;
  previous: { runId: string } | { startedAfter: string };
}

/**
 * resume：同一个执行方式、同一个账号池、同一个会话用户，上一段记下了会话号，可以续。
 * new：续不上，reason 是白话原因（写进任务进度），退回原分支原树开新会话。
 */
export type PlanSegmentResumeResult =
  | { kind: 'resume'; sessionId: string; runId: string }
  | { kind: 'new'; reason: string };

/**
 * 重试、重派之前确认上一段真停了（决定 0093，同一张单不并发两段）：从 startedAfter 起这张单最近的动手那一行收场了没有。
 */
export interface SegmentSettledInput {
  schemaVersion: 1;
  taskId: string;
  startedAfter: string;
}

/** settled：收场了，或库里压根没有那一段（没起来）。没收场回那一行的编号。库读不了抛错（工作流按今天的做法接着走）。 */
export type SegmentSettledResult = { settled: true } | { settled: false; runId: string; detail: string };

export interface ReleaseReservationInput {
  schemaVersion: 1;
  reservationId: string;
}

/** released：这一下放完了（本来就已经不在，也算放完）。 */
export interface ReleaseReservationResult {
  released: true;
}
