// 任务工作流（#632 S2-4；specs/632-三段总调度/方案.md §五）对外的约定：输入输出、信号、查询、新增活动的入参和结果。
// 驾驶舱后端（发「继续」「放弃」、读状态）和引擎共用这一份；工作流和活动都从这里拿类型。
// 这里是工作流代码也会引入的文件：运行时只引 @temporalio/workflow 的 defineSignal / defineQuery，别的一律只写类型。
// 输入进了工作流历史：以后只许加可选字段，不许改老字段的意思。

import type { FlowMode, FlowSource, Repo, RepoWithProfile } from '@fleet-dao/shared';
import {
  type AbandonCommand,
  type ContinueCommand,
  type PauseCommand,
  type RepinCommand,
  type RouteWakeCommand,
  TASK_SIGNAL_NAMES,
} from '@fleet-dao/shared/task-signals';
import { defineQuery, defineSignal } from '@temporalio/workflow';
import type { FailureEvidence } from './failure/types.ts';
import type { RouteChoice } from './ports.ts';
import type { TaskBrief } from './runner/task-brief.ts';
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

/** 直接合被拒、因为落后主线：同一个任务对同一张 PR 最多自动同步主线几次（第 N+1 次起停下报人，免得主线一直在动就一直转）。 */
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

export interface TaskStatus {
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
}

export interface TaskRun {
  outcome: 'merged' | 'abandoned';
  prNumber: number | null;
  head: string | null;
  rounds: number;
  verifyRounds: number;
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
  schemaVersion: 1;
  repo: Pick<Repo, 'owner' | 'name'>;
  issueNumber: number;
}

/** 起一段动手会话。runId 由活动自己起（每次尝试一个，进 runs 表的主键），工作流里不生成编号。 */
export interface RunSegmentInput {
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
}

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
   * 交的头相对树里钉住的主线新增了多少行（#2755 体量预算按它判）。没数成、老历史里没有：当作没量到，不判预算。
   */
  addedLines?: number;
}

export interface ColdVerifyInput {
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
  schemaVersion: 1;
  repo: Repo;
  prNumber: number;
  expectedHead: string;
  /**
   * 这张 PR 已经因为落后主线自动同步过几次（工作流数；没同步过就不带）。到了 MAX_MAIN_SYNCS 次，
   * 再落后就不同步了，原样停下报人。老历史里没有这个字段，当作 0。
   */
  syncedBehind?: number;
}

export interface ArmAutoMergeResult {
  /** 自动合并挂上了（或本来就挂着）。 */
  armed: boolean;
  /** 挂的时候发现已经合了（或本来就满足合并条件、当场合了）。 */
  merged: boolean;
  /** merged 时的合并提交。 */
  mergeCommit?: string;
  why?: string;
  /** 挂的时候发现 PR 的头已经不是引擎验过、推上去的那个了（有人改过）：现在的头。老历史里没有这个字段。 */
  headMoved?: string;
  /**
   * headMoved 是引擎自己刚把 PR 同步到最新主线造成的（直接合被拒、因为落后主线）：工作流不停下，直接对新头重走 CI 和验收。
   * 老历史里没有这个字段，当作没有（头是别人改的）。
   */
  syncedMain?: true;
}

/** 现读这个仓现在的 CI 模式。工作流每次走到等 CI 之前读，不在拉单那一刻定死。 */
export interface ReadCiPolicyInput {
  schemaVersion: 1;
  repo: Repo;
}

export interface ReadCiPolicyResult {
  mode: 'force' | 'off';
}

/** 不强制 CI 的仓：开完 PR、查完改标准路径之后由引擎直接合并（不等检查、不挂自动合并）。 */
export interface MergeNowInput {
  schemaVersion: 1;
  repo: Repo;
  prNumber: number;
  expectedHead: string;
  /** 这张 PR 已经因为落后主线自动同步过几次。到了 MAX_MAIN_SYNCS 次就不再同步。 */
  syncedBehind?: number;
}

export interface MergeNowResult {
  merged: boolean;
  mergeCommit?: string;
  reason?: 'conflict' | 'head_moved' | 'behind_main' | 'closed' | 'other';
  detail?: string;
  /** 头已经不是 expectedHead。syncedMain 为 true 时是引擎自己同步主线换的头。 */
  headMoved?: string;
  syncedMain?: boolean;
}

export interface WaitMergedInput {
  schemaVersion: 1;
  repo: Repo;
  prNumber: number;
  expectedHead: string;
  minutes: number;
}

export type MergeWait =
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
}

/** 一条命令的结果：精炼过的输出（失败的行和末尾一段，不是整份日志）。 */
export interface SelfCheckStep {
  command: string;
  outcome: 'pass' | 'fail' | 'skipped';
  /** 退出码；超时、起不来是 null。 */
  exitCode: number | null;
  /** 精炼过的输出（SELF_CHECK_DIGEST_MAX 以内）；跳过的写为什么跳过。 */
  digest: string;
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
