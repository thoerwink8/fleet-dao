// 任务工作流的运行底座：一张单的状态（驾驶舱查到的 status、轮数、头、PR 号……）、等待、停下等人、可取消的长活动、
// 失败分流。各阶段（task-session / task-ci / task-verify / task-merge）都拿同一个 TaskRuntime 干活，task.ts 的 TaskFlow 只管顺序。
//
// 改这里之前必须知道：
// - 这是工作流代码，会被重放：不取随机数、不生成编号；时间只用 Date.now()（工作流沙箱里它是确定的）；判断失败怎么办经 judgeRetrying。
//   改调度顺序（多调、少调、换顺序调活动）要用 patched()，见 test/replay.test.ts。
// - 「放弃」「叫停」都要把正在跑的长活动取消掉：长活动一律包在 cancellable() 里。
// - 停下等人 park() 回来＝人点了「继续」；放弃会在 park() 里抛 Abandoned，走不到下一行。

import type { TaskState } from '@fleet-dao/shared';
import { clipCauseSummary, type RunCause } from '@fleet-dao/shared/run-cause';
import {
  CancellationScope,
  condition,
  isCancellation,
  log,
  patched,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import type { EngineActivities } from '../activity-options.ts';
import { COMMANDER_ACTOR, ROUNDS_HANDOFF_TITLE } from '../commander-contract.ts';
import type { FailureContext, LadderCounters, NextAction } from '../decisions/failure.ts';
import type { Limits } from '../limits.ts';
import type { AcceptanceDutyRecord, RouteChoice, Worktree } from '../ports.ts';
import {
  type PushHandbackReceipt,
  type PushHandbackRequest,
  pushHandbackPayload,
  samePushHold,
} from '../push-handback.ts';
import type { TaskBrief } from '../runner/task-brief.ts';
import {
  type AbandonCommand,
  AUTO_RETRY_PARK_KINDS,
  CI_POLICY_POLL_SECONDS,
  type ClosedIssueHoldToken,
  type GuardedPaths,
  MAX_IMPLEMENT_ROUNDS,
  MAX_MAIN_SYNCS,
  MAX_ROUND_RESETS,
  MAX_VERIFY_ROUNDS,
  type MainSyncBudgetExhausted,
  type MergedTaskReceipt,
  PARKED_RETRY_ACTOR,
  PAUSED_BY_HUMAN,
  type ParkKind,
  type PauseCommand,
  type RepinCommand,
  type TaskPhase,
  type TaskStatus,
  type TaskWait,
  type TaskWorkflowInput,
  taskAbandonSignal,
  taskCloseClosedIssueUpdate,
  taskContinueSignal,
  taskHandbackPermissionPushUpdate,
  taskPauseSignal,
  taskPushHandbackQuery,
  taskRepinSignal,
  taskRouteWakeSignal,
  taskSettleMergedUpdate,
  taskStatusQuery,
} from '../task-contract.ts';
import { conflictFilesOf, conflictPendingOf, failureOf, iso, judgeRetrying } from './kit.ts';
import {
  Abandoned,
  AutoEscape,
  type Avoid,
  avoidableFamily,
  bump,
  ConflictHandoff,
  HygieneHandoff,
  infraAvoidScope,
  type LastSession,
  MergedTask,
  NO_AVOID,
  PausedInterrupt,
  RepinInterrupt,
  type ResumeFrom,
  stripUndefined,
  widen,
  withFamily,
  ZERO,
} from './task-support.ts';

export class PermissionPushHandback extends Error {
  readonly feedback: string;
  constructor(feedback: string) {
    super('permission push handed back');
    this.feedback = feedback;
  }
}

export class TaskRuntime {
  private permissionPushPark = false;
  private handbackTerminal = false;
  private pushHandback: {
    request: PushHandbackRequest;
    payload: string;
    state: 'checking' | 'ready' | 'returning' | 'consumed';
    receipt: PushHandbackReceipt | undefined;
  } | null = null;
  private readonly pushHandbackRequests = new Map<
    string,
    { payload: string; result: Promise<PushHandbackReceipt> }
  >();
  readonly input: TaskWorkflowInput;
  readonly acts: EngineActivities;
  readonly limits: Limits;
  readonly status: TaskStatus;
  private continued = 0;
  private routeWakes = 0;
  private abandon: AbandonCommand | null = null;
  /** 停下等人的次数（报警的去重键用；#3140 起 task-session 也读它，认「人点了继续才回来」的那一笔）。 */
  parks = 0;
  /**
   * 引擎已经续过的停下原文（#3294：停法 + 标题 + 原因）。同一原文再停下不再续，交人。只在内存里，由信号重放算得出来。
   */
  private readonly engineRetried = new Set<string>();
  /** 正停着的这一次的原文键（patched('park-kind') 之后才写；没在停是空串）。 */
  private parkKey = '';
  private closeHoldGeneration = 0;
  private closeHold: ClosedIssueHoldToken | null = null;
  private verifiedMerged: MergedTaskReceipt | null = null;
  private settlingMerged = false;
  finishingMerged = false;
  /**
   * 正在跑的长活动的取消钩子。冷验收和等 CI 并行（决定 0093）时同时有好几个（和 CI 同时起的那次验收没被认时让它自己跑完，
   * 可能一直跑到下一轮动手）：放弃要全取消，所以是一组、不是一个。
   */
  private readonly running = new Set<() => void>();
  /** 动手会话那一段的取消钩子：hard 暂停、「现在就换」只取消它，不碰旁边还在跑的验收。 */
  private cancelPausable: (() => void) | null = null;
  /** 正在跑的这个长活动是不是「hard 暂停能取消的」（只有动手会话）。 */
  private runningPausable = false;
  /** 有人要暂停（#820 片 3）：停在下一个检查点（checkpoint），点「继续」才放；已经有一个在了，后来的不覆盖（谁点的、为什么保持第一次）。 */
  private pauseReq: PauseCommand | null = null;
  /** 暂停停着等「继续」的这一段（pauseReq 已经生效）。 */
  private holding = false;
  /** hard 暂停取消了正在跑的动手会话：cancellable 里看到取消时，分得清是暂停取消的还是别的。 */
  private pauseCancelled = false;
  /** 「现在就换」取消了正在跑的动手会话（#1216）：cancellable 里看到取消时，分得清是它取消的。 */
  private repinCancelled = false;
  private repinReq: RepinCommand | null = null;

  // ---- 一张单走到哪了（各阶段读写）
  branch = '';
  worktree: Worktree | null = null;
  /** 动手会话交付检查的起点：第一轮是工作树的起点，之后是上一轮推上去的头。 */
  since = '';
  head: string | null = null;
  prNumber: number | null = null;
  /** 人在哪个头上批过哪些路径（点「继续」那一刻记下）；头换了就作废，新的内容要重新批。 */
  guardApproval: { head: string; paths: GuardedPaths } | null = null;
  /** 这张 PR 本段已自动同步主线几次（落后与等合并冲突共用；上限 MAX_MAIN_SYNCS，耗尽停下后可明确继续续段）。 */
  mainSyncs = 0;
  /** 等合并这一轮已经见过一次必过检查红（#1983）。确认窗口里再红一次才返工；中间变回还在跑就清掉。 */
  mergeRedNoted = false;
  changedFiles: string[] = [];
  feedback: string[] = [];
  /**
   * 最近一次冷验收没过的原话。推上去之后 feedback 会被清掉，验收轮数用尽时通知还要靠它，不能跟着清。
   */
  verifyProblems: string[] = [];
  /**
   * 上一轮验收没过时的头和问题。第 2 轮才写进冷验收入参（patched('verify-recheck')）。
   * 老历史重放不读它：patched() 为假时入参和原来一样。
   */
  verifyRecheck: { head: string; criteria: number[]; problems: string[] } | null = null;
  /**
   * 已经交给工人的正式「要求改」评审（#2991，task-verify.ts；CI 红返工也写这里）：reviewKey → 交出去时的头。
   * 同一条（同 PR、同编号、同完整意见）再读到不再为它多起一轮；CI 红本身的那一轮仍把它当上下文带上。
   */
  readonly reviewsHanded = new Map<string, string>();
  /**
   * 冷验收转给人的验收条（#3037，结论里的 outOfScope）：按 PR + 头各记一份，收尾时一起记进验收责任（活动那边已记过的幂等）。
   * 纯状态，不调活动；老历史的结论里没有 outOfScope，这里一直是空的。
   */
  readonly handedOver: AcceptanceDutyRecord[] = [];
  /** 当前单子正文读出来的交代。点「继续」重读之后换掉，验收用这一份，不用起任务时的旧版。 */
  brief: TaskBrief | null = null;
  /** 首次安全边界核实之后才具备版本身份，旧历史不伪造。 */
  contractVersioned = false;
  contractRevision: { reviews: string[] } | null = null;
  refreshContract: (boundary: string) => Promise<boolean> = async () => false;
  contractGuard() {
    if (!this.contractVersioned) return {};
    const expected = this.brief?.contract;
    if (!expected) throw new Error('正式合同未核实');
    return { contractGuard: { issueNumber: this.input.issueNumber, expected } };
  }
  /** 轮数用尽、人点「继续」之后重读单子。由 TaskFlow 接上。 */
  reloadBrief: () => Promise<void> = async () => {
    throw new Error('重读单子还没接上（工作流自己的状态乱了）');
  };
  readonly families = new Set<string>();
  /**
   * 这张单里，动手会话跑完却没有提交时攒下的避让（#1408）。只活在这次运行里，下张单是新的运行时，不带着走。
   * 轮数用尽后点「继续」清掉。
   */
  commitAvoid: Avoid = NO_AVOID;
  /** 连着多少轮动手会话跑完没有提交。中间有了提交就从 0 再计。 */
  commitMisses = 0;
  /** 最近一轮没提交时用的路由。避让之后没有别的候选，就照旧派它。 */
  commitMissRoute: RouteChoice | null = null;
  /**
   * 超时、起不来已经按路由避开过的模型（#2261）。同一模型再失败就避开模型，不整族避开。
   * 只在 patched('avoid-scope-by-cause') 之后写入，老历史一直是空的。
   */
  private infraRouteModels: string[] = [];
  /** 已经升到「避开模型」的那些模型。再失败不再为它自动重派。 */
  private infraModelIds: string[] = [];
  /**
   * 总时长第二次到顶、已经写了「换路由续」还没派上新会话（#2392）。
   * 只在工作流内存里，不调活动。选路若只剩等，不进 pauseForRoute 的长睡。
   * 派上会话或人点「继续」清掉没提交的避让时清掉。
   */
  landSwitch = false;
  /**
   * 上游 503 说模型暂时不可用、已经写了换路由还没派上新会话。
   * 只在工作流内存里，不调活动。选路若只剩等、或只剩刚才那条，不进 pauseForRoute 的长睡，停下腾出名额。
   * 派上会话或人点「继续」清掉没提交的避让时清掉。
   */
  modelDownLand = false;
  /**
   * 已经在长睡里的老历史被叫醒之后置上（patched('wall-clock-switch-wake')）。
   * 下一轮再选不出就停下，不再睡第二觉。新跑的走 wall-clock-switch-lands，这一位保持假。
   */
  switchWake = false;
  /** 这一轮动手会话实际跑完时用的路由。没跑成的不算。 */
  lastImplementRoute: RouteChoice | null = null;
  /** 这一轮选路时避让把候选滤光了，改派了原来的路由。 */
  fellBackToMissRoute = false;
  /** 上一次因为等路由落库的「在做什么」那一句（#2863，patched('route-wait-mirror')）：同一句不重复写。 */
  lastRouteWaitLine: string | null = null;
  /**
   * 下一次动手会话打算续哪一段（决定 0088，task-session.ts）：判一次就清掉，续不上的不再试。
   * 只在 patched('segment-resume') 之后才会被写上，老历史一直是 null。
   */
  resumeFrom: ResumeFrom | null = null;
  /** 上一次跑成的动手会话（决定 0093）：返工轮续它（task.ts 的 implement，patched('rework-resume')）。 */
  lastSession: LastSession | null = null;
  /**
   * 最近一次跑成的动手会话的最后一条回复（#2723）：开 PR、第 2 轮起改 PR 正文时进「做了什么」。纯状态，没跑成的不覆盖。
   */
  lastAnswer: string | null = null;
  /** 这一轮第一个派上的模型（#2762 流程健康记账）：每轮开头清掉，起第一段会话时记下。纯状态。 */
  roundFirstModel: string | null = null;
  /** 最近一次推上去的头相对主线新增的行数（#2762）；没推过、推分支没数成是 null。 */
  addedLines: number | null = null;
  /** 这条工作流里已经记了几次一轮收场（task_rounds.seq）。只在 patched('round-outcome') 下加。 */
  roundSeq = 0;
  /** 这一轮开始的时刻（#3140，工作流的时钟）：一轮收场时写进 task_rounds.started_at。纯状态。 */
  roundStartedAt: string | null = null;
  /** 连着几次跑成的动手会话是续起来的：到 RESUME_STREAK_LIMIT 下一轮开新会话。 */
  resumeStreak = 0;
  /**
   * 这张单走哪种流程（#2826，patched('flow-mode')，task-flow.ts）：第一次选路之后、第一段动手之前定一次，之后不变。
   * null＝老历史（没定过，按三段）。只来自活动结果（进了历史），重放不再读配置。
   */
  flowMode: 'three' | 'full' | null = null;
  /** 全程的单回到动手几次了（MAX_FULL_PUSHES 兜底）：到了停下，人点「继续」清零。 */
  fullPushes = 0;
  /** 最近一次自测（决定 0093）的精炼输出：交给冷验收当材料（ColdVerifyInput.testOutput）。没跑过、头换了就是 null。 */
  selfCheckOutput: { head: string; text: string } | null = null;
  /** 单任务 token 预算给了几份（决定 0093）：超了停下，点「继续」再给。 */
  budgetGrants = 1;
  /** 指挥官判了不是空转、继续时多放宽的几档额度预算（#3294 第 2 片）：下一次额度停下回来时加进 budgetGrants 就清零。 */
  budgetWiden = 0;
  round = 0;
  verifyRound = 0;
  /**
   * 冷验收这个头从什么时候起一直回「过会儿再验」（#3281，工作流时间，重放算得出）：换了头、验出结论清掉；alerted 是这一段报过警没有。
   */
  verifyWaitSince: { head: string; at: number; alerted: boolean } | null = null;
  /**
   * 停在合并这一步后引擎复核到条件满足、自己醒来的那一次（#3281）：同一个头醒来后又因同一个原因停下，不再报警（第一次停下报过了），
   * 免得条件看着满足、挂合并又不成时每小时报一条。人点「继续」、换头清掉。
   */
  mergeRecheckWoke: { head: string; title: string } | null = null;
  /** 因轮数用尽点过几次「继续」（清零的次数；超过 MAX_ROUND_RESETS 就不再清）。 */
  private roundResets = 0;
  attemptSeq = 0;

  /** 记下一次冷验收转给人的验收条（同一 PR 同一个头只记一份，后来的条目并进去）。 */
  noteHandedOver(prNumber: number, head: string, items: readonly string[]): void {
    const fresh = items.map((i) => i.trim()).filter((i) => i !== '');
    if (fresh.length === 0) return;
    const same = this.handedOver.find((d) => d.prNumber === prNumber && d.head === head);
    if (same) same.items = [...new Set([...same.items, ...fresh])];
    else this.handedOver.push({ prNumber, head, items: [...new Set(fresh)] });
  }

  constructor(input: TaskWorkflowInput, acts: EngineActivities, limits: Limits) {
    this.input = input;
    this.acts = acts;
    this.limits = limits;
    this.status = {
      phase: 'brief',
      doing: '读单子和需求文档',
      round: 0,
      verifyRound: 0,
      prNumber: null,
      waiting: null,
      lastProblem: null,
      tier: null,
    };
    setHandler(taskContinueSignal, (command) => {
      // 引擎续停（#3294）：只认正停着的这一次（编号对得上）、停法是引擎可续的、这一次还没被引擎续过；别的一律不理，不算一次「继续」
      if (command?.by === PARKED_RETRY_ACTOR) {
        const park = this.status.park;
        if (
          !park ||
          park.seq !== command.parkSeq ||
          !AUTO_RETRY_PARK_KINDS.includes(park.kind) ||
          park.retriedBefore ||
          this.engineRetried.has(this.parkKey)
        )
          return;
        this.engineRetried.add(this.parkKey);
        // 查询里也立刻标上：这一次在离开 parked 之前（报警还在发、状态还在落库）下一轮续停读到的就是「已续」，不再发、不再记操作记录
        park.retriedBefore = true;
      }
      // 指挥官（#3294 第 2 片）：同样只认正停着的这一次（编号对得上），晚到的不解开后来的停下。能不能继续由引擎侧的白名单核过，
      // 这里只多认一样：额度停法带 widenBudget 就把预算放宽一档（task-session.ts 的 enforceTokenBudget 读 budgetWiden）。老历史没有这个 by
      if (command?.by === COMMANDER_ACTOR) {
        const park = this.status.park;
        if (!park || park.seq !== command.parkSeq) return;
        if (command.widenBudget === true && park.kind === 'quota') this.budgetWiden += 1;
      }
      this.continued += 1;
      this.closeHold = null;
      // 还没停下（没到检查点）就收到「继续」：撤掉这次暂停请求；已经停着的由 holdPaused 看 continued 放行
      if (!this.holding) this.pauseReq = null;
    });
    setHandler(taskPauseSignal, (command) => {
      if (this.pauseReq) return;
      this.pauseReq = command;
      if (command.mode === 'hard' && this.runningPausable) {
        this.pauseCancelled = true;
        this.cancelPausable?.();
      }
    });
    // 「现在就换」（#1216）：只有正在跑的动手会话能当场停（和 hard 暂停同一条取消的路）；没在跑就不理——新指定已经在库里，下一次选路照它。
    // hard 暂停已经把这一段取消了、或已经在放弃：不抢。
    setHandler(taskRepinSignal, (command) => {
      if (!this.runningPausable || this.pauseCancelled || this.repinCancelled || this.abandon) return;
      this.repinReq = command;
      this.repinCancelled = true;
      this.cancelPausable?.();
    });
    setHandler(taskRouteWakeSignal, () => {
      this.routeWakes += 1;
    });
    setHandler(taskAbandonSignal, (command) => {
      this.abandon ??= command;
      this.cancelAll();
    });
    setHandler(taskHandbackPermissionPushUpdate, (request) => {
      const payload = pushHandbackPayload(request);
      const cached = this.pushHandbackRequests.get(request.requestId);
      if (cached)
        return cached.payload === payload
          ? cached.result
          : Promise.resolve({
              version: 1 as const,
              requestId: request.requestId,
              payload,
              outcome: 'conflict' as const,
            });
      // 固定 JSON 快照，不能在 IO 期间改变请求或让新增字段逃过幂等比较。
      const snapshot = JSON.parse(payload) as PushHandbackRequest;
      const result = this.handlePushHandback(snapshot, payload);
      if (this.pushHandbackRequests.size < 128)
        this.pushHandbackRequests.set(snapshot.requestId, { payload, result });
      return result;
    });
    setHandler(taskPushHandbackQuery, () => {
      const token = this.closeToken();
      if (
        !token ||
        !this.permissionPushPark ||
        this.prNumber !== null ||
        this.running.size !== 0 ||
        this.flowMode === 'full' ||
        this.pauseReq ||
        this.abandon ||
        this.verifiedMerged ||
        !this.brief?.contract ||
        !this.worktree
      )
        return null;
      return {
        version: 1 as const,
        workflowId: workflowInfo().workflowId,
        runId: workflowInfo().runId,
        task: this.input,
        branch: this.branch,
        path: this.worktree.path,
        contract: this.brief.contract,
        token,
        budgetGrants: this.budgetGrants,
        taskTokenBudget: this.limits.taskTokenBudget,
        round: this.round,
        verifyRound: this.verifyRound,
      };
    });
    // 旧历史保留同步关单；新入口先核真实合并身份，不能绕过已合任务的成功收尾。
    setHandler(taskCloseClosedIssueUpdate, async ({ token, command }) => {
      if (this.pushHandback !== null) return 'busy';
      if (typeof command?.by !== 'string' || typeof command.reason !== 'string') return 'busy';
      const current = this.closeToken();
      if (
        !current ||
        token.version !== 1 ||
        token.runId !== current.runId ||
        token.kind !== current.kind ||
        token.generation !== current.generation ||
        token.continued !== current.continued
      )
        return 'stale';
      if (this.abandon !== null || this.running.size > 0) return 'busy';
      if (this.prNumber !== null && patched('settle-merged-task-checkpoint')) {
        if (this.head === null || this.settlingMerged) return 'busy';
        const prNumber = this.prNumber;
        const head = this.head;
        this.settlingMerged = true;
        try {
          const actual = await this.acts.readMergedTask({
            schemaVersion: 1,
            repo: { owner: this.input.repo.owner, name: this.input.repo.name },
            prNumber,
            expectedHead: head,
            idle: {
              issueNumber: this.input.issueNumber,
              workflowId: workflowInfo().workflowId,
              includeOpen: true,
            },
          });
          const after = this.closeToken();
          if (
            !after ||
            this.running.size > 0 ||
            this.prNumber !== prNumber ||
            this.head !== head ||
            after.runId !== token.runId ||
            after.kind !== token.kind ||
            after.generation !== token.generation ||
            after.continued !== token.continued
          )
            return 'stale';
          if (actual) {
            this.verifiedMerged = actual;
            this.closeHold = null;
            // 旧关单调用方只把 accepted 当撤提醒授权；成功收尾未完成，不能给它。
            return 'busy';
          }
        } finally {
          this.settlingMerged = false;
        }
      }
      this.abandon = command;
      this.closeHold = null;
      this.cancelAll();
      return 'accepted';
    });
    setHandler(taskSettleMergedUpdate, async ({ token, receipt }) => {
      if (this.pushHandback !== null) return 'busy';
      if (!this.mergedHoldMatches(token, receipt)) return 'stale';
      if (this.settlingMerged) return 'busy';
      this.settlingMerged = true;
      try {
        const actual = await this.acts.readMergedTask({
          schemaVersion: 1,
          repo: receipt.repo,
          prNumber: receipt.prNumber,
          expectedHead: receipt.head,
          expectedMergeCommit: receipt.mergeCommit,
          idle: { issueNumber: this.input.issueNumber, workflowId: workflowInfo().workflowId },
        });
        // An Update can interleave with continue/repin while awaiting the activity.
        if (!actual || !this.mergedHoldMatches(token, receipt)) return 'stale';
        this.verifiedMerged = actual;
        this.closeHold = null;
        return 'accepted';
      } finally {
        this.settlingMerged = false;
      }
    });
    setHandler(taskStatusQuery, () => ({
      ...this.status,
      waiting: this.status.waiting ? { ...this.status.waiting } : null,
      closedIssueClose: { version: 1, token: this.closeToken() },
      mergedTaskClose: {
        version: 1,
        token: this.running.size === 0 ? this.closeToken() : null,
        repo: { owner: this.input.repo.owner, name: this.input.repo.name },
        prNumber: this.prNumber,
        head: this.head,
      },
    }));
  }

  private pushHoldMatches(request: PushHandbackRequest): boolean {
    return (
      samePushHold(this.closeToken(), request.token) &&
      this.permissionPushPark &&
      this.prNumber === null &&
      this.running.size === 0 &&
      this.pauseReq === null &&
      this.abandon === null &&
      this.verifiedMerged === null &&
      this.flowMode !== 'full'
    );
  }

  private async handlePushHandback(
    request: PushHandbackRequest,
    payload: string,
  ): Promise<PushHandbackReceipt> {
    const receipt = (outcome: PushHandbackReceipt['outcome'], code?: string): PushHandbackReceipt => ({
      version: 1,
      requestId: request.requestId,
      payload,
      outcome,
      ...(code ? { code } : {}),
    });
    if (!patched('permission-push-handback-v1')) return receipt('unknown', 'unsupported_worker');
    // 本协议只接首次自然推送停点。先拒未来代数，不能让伪造 token 悬住 handler。
    if (
      request.token.runId !== workflowInfo().runId ||
      request.token.generation !== 1 ||
      request.token.continued !== 0
    )
      return receipt('stale', 'unsupported_hold');
    if (this.pushHandback || this.pushHandbackRequests.size >= 128) return receipt('busy');
    // 无缓存重放时 Update 可先于原活动结果重建执行。等同一个首次 hold 重建完，
    // 不读 isReplaying、不加 timer，也不占 checking；继续、其他停点或终态均结束等待。
    await condition(
      () =>
        this.handbackTerminal ||
        this.abandon !== null ||
        this.continued !== 0 ||
        this.closeHoldGeneration > 1 ||
        (this.closeHoldGeneration === 1 && (!this.permissionPushPark || this.closeToken() !== null)),
    );
    if (!this.pushHoldMatches(request)) return receipt('stale');
    if (this.pushHandback) return receipt('busy');
    // 不唤醒旧 park，让 exhaustRounds 的自动 reset 分支借道发新预算。
    if (this.round >= MAX_IMPLEMENT_ROUNDS || this.verifyRound >= MAX_VERIFY_ROUNDS)
      return receipt('budget-held', 'round_budget');
    const contract = this.brief?.contract;
    if (!contract || !this.worktree) return receipt('unknown', 'missing_tree_or_contract');
    const slot = {
      request,
      payload,
      state: 'checking' as 'checking' | 'ready' | 'returning' | 'consumed',
      receipt: undefined as PushHandbackReceipt | undefined,
    };
    this.pushHandback = slot;
    try {
      const preflight = await this.acts.readPushHandbackPreflight({
        version: 1,
        workflowId: workflowInfo().workflowId,
        runId: workflowInfo().runId,
        task: this.input,
        branch: this.branch,
        path: this.worktree.path,
        contract,
        token: request.token,
        budgetGrants: this.budgetGrants,
        taskTokenBudget: this.limits.taskTokenBudget,
        round: this.round,
        verifyRound: this.verifyRound,
      });
      if (!this.pushHoldMatches(request)) return receipt('stale');
      if (preflight.outcome !== 'natural-retired') return receipt(preflight.outcome, preflight.code);
      if (this.round >= MAX_IMPLEMENT_ROUNDS || this.verifyRound >= MAX_VERIFY_ROUNDS)
        return receipt('budget-held', 'round_budget');
      slot.state = 'ready';
      // Update 接收/检查成功仍不是成功：只有原 park 同步消费后才给 handed_back。
      await condition(
        () =>
          slot.state === 'consumed' ||
          this.handbackTerminal ||
          this.abandon !== null ||
          this.continued !== request.token.continued ||
          (slot.state !== 'returning' && !this.pushHoldMatches(request)),
      );
      return slot.receipt ?? receipt('stale');
    } catch (error) {
      return receipt('unknown', isCancellation(error) ? 'cancelled' : 'preflight_failed');
    } finally {
      if (this.pushHandback === slot) this.pushHandback = null;
    }
  }

  /** 主循环写完本轮收场并接纳返工；原 park 只交控制权，不能提前签成功回执。 */
  acceptPushHandback(): void {
    const slot = this.pushHandback;
    if (!slot || slot.state !== 'returning') return;
    this.guard();
    const valid = samePushHold(this.closeHold, slot.request.token) && this.pauseReq === null;
    slot.receipt = {
      version: 1,
      requestId: slot.request.requestId,
      payload: slot.payload,
      outcome: valid ? 'handed_back' : 'stale',
    };
    slot.state = 'consumed';
    this.closeHold = null;
  }

  stopPushHandbacks(): void {
    this.handbackTerminal = true;
  }

  private mergedHoldMatches(token: ClosedIssueHoldToken, receipt: MergedTaskReceipt): boolean {
    const current = this.closeToken();
    return (
      !!current &&
      !!token &&
      !!receipt &&
      this.running.size === 0 &&
      token.version === 1 &&
      token.runId === current.runId &&
      token.kind === current.kind &&
      token.generation === current.generation &&
      token.continued === current.continued &&
      receipt.repo?.owner === this.input.repo.owner &&
      receipt.repo.name === this.input.repo.name &&
      receipt.prNumber === this.prNumber &&
      receipt.head === this.head &&
      /^[0-9a-f]{40}$/.test(receipt.mergeCommit)
    );
  }

  private enterCloseHold(kind: ClosedIssueHoldToken['kind']): void {
    this.closeHold = {
      version: 1,
      runId: workflowInfo().runId,
      kind,
      generation: ++this.closeHoldGeneration,
      continued: this.continued,
    };
  }

  private closeToken(): ClosedIssueHoldToken | null {
    const token = this.closeHold;
    if (
      !token ||
      this.abandon !== null ||
      token.continued !== this.continued ||
      token.kind !== this.status.phase ||
      this.status.waiting?.kind !== (token.kind === 'paused' ? 'paused' : 'human')
    )
      return null;
    return { ...token };
  }

  // ---- 状态、等待、停下等人

  /**
   * 这一笔会话要记进 runs 的起因和所属回合（#3140，只记账，会话看不到）。标记 run-cause-fields 在新历史里才为真：老历史重放
   * 不带这几个字段，活动入参和原来一样（只是入参多几个可选字段，不改步序）。回合号＝这一轮收场时 task_rounds 的 seq
   * （已经记了几次收场 + 1，和 endRound 同一个算法）。标记在 patched('round-outcome') 之后才有意义，所以两个都为真才带回合号。
   */
  runStamp(
    cause: RunCause,
    causeSummary?: string,
  ): { cause?: RunCause; causeSummary?: string; roundSeq?: number } {
    if (!patched('run-cause-fields')) return {};
    const summary = causeSummary?.trim() ? clipCauseSummary(causeSummary) : undefined;
    return {
      cause,
      ...(summary ? { causeSummary: summary } : {}),
      ...(patched('round-outcome') ? { roundSeq: this.roundSeq + 1 } : {}),
    };
  }

  /** 冷验收这一笔所属的回合（#3140）：同 runStamp 的回合号。 */
  verifyStamp(): { roundSeq?: number } {
    return patched('run-cause-fields') && patched('round-outcome') ? { roundSeq: this.roundSeq + 1 } : {};
  }

  set(phase: TaskPhase, doing: string): void {
    this.status.phase = phase;
    this.status.doing = doing;
    this.status.round = this.round;
    this.status.verifyRound = this.verifyRound;
    this.status.prNumber = this.prNumber;
  }

  /**
   * 换阶段：写内存状态，并把阶段落库（running）。只用 set() 的话库里的 phase/doing 停在开头那一句，
   * 驾驶舱和法国巡查看着像「卡在对题」，其实已经在动手、等 CI 了（#1150 过夜那次）。
   * 老历史重放时没有这个标记：patched() 为假，不多调那一步活动。
   */
  async advance(phase: TaskPhase, doing: string): Promise<void> {
    this.set(phase, doing);
    if (patched('mirror-phase')) await this.mirror('running');
  }

  private cancelAll(): void {
    for (const cancel of [...this.running]) cancel();
  }

  /**
   * 自动处理了一次、不停下等人（决定 0093）：在任务进度里写一行（库里的 doing），阶段不变。
   */
  async note(line: string): Promise<void> {
    await this.advance(this.status.phase, line);
  }

  guard(): void {
    if (this.abandon) throw new Abandoned(this.abandon);
    if (this.verifiedMerged && !this.finishingMerged) throw new MergedTask(this.verifiedMerged);
  }

  /**
   * 检查点：放弃了就抛 Abandoned；有人要暂停（#820 片 3）就停在这里等「继续」，回来的时候已经继续了。
   * 起新会话、选路、起新一步之前都过这里：暂停之后不再起新会话（soft 手上这一段做完；hard 动手会话当场停，见 cancellable）。
   * 老历史重放走不到暂停那一支（没有 taskPause 信号），所以平时不多调任何活动。
   */
  async checkpoint(): Promise<void> {
    this.guard();
    if (
      !this.finishingMerged &&
      this.prNumber !== null &&
      this.head !== null &&
      this.running.size === 0 &&
      patched('settle-merged-task-checkpoint')
    ) {
      for (;;) {
        let merged: MergedTaskReceipt | null;
        try {
          merged = await this.acts.readMergedTask({
            schemaVersion: 1,
            repo: { owner: this.input.repo.owner, name: this.input.repo.name },
            prNumber: this.prNumber,
            expectedHead: this.head,
            idle: { issueNumber: this.input.issueNumber, workflowId: workflowInfo().workflowId },
          });
        } catch (error) {
          if (isCancellation(error)) throw error;
          await this.park('PR 是否已合并没核实，保留现场', String(error));
          continue;
        }
        this.guard();
        if (merged) {
          this.verifiedMerged = merged;
          throw new MergedTask(merged);
        }
        break;
      }
    }
    if (!this.finishingMerged && this.pauseReq !== null) await this.holdPaused(this.pauseReq);
  }

  /** 暂停的原因怎么写给人看：谁、为什么（没写原因就只写谁）。 */
  pauseNote(command: PauseCommand): string {
    return `${PAUSED_BY_HUMAN}（${command.by}）${command.reason ? `：${command.reason}` : ''}`;
  }

  /** 「现在就换」停下的这一段重跑时，提示词里写的话：谁、为什么（没写原因就只写谁）。 */
  repinNote(command: RepinCommand): string {
    return `被人要求现在就换模型（${command.by}）${command.reason ? `：${command.reason}` : ''}`;
  }

  /** 停着等「继续」或「放弃」：库里 phase=paused、state 仍是 running，不报警（不是出了问题），继续后回到原来的阶段。 */
  private async holdPaused(command: PauseCommand): Promise<void> {
    // 老历史里没有这一支：patched() 为假就当没有（走不到：老历史没有 taskPause 信号）
    if (!patched('task-pause')) return;
    const before = this.continued;
    const previous = { phase: this.status.phase, doing: this.status.doing, waiting: this.status.waiting };
    this.holding = true;
    this.status.phase = 'paused';
    this.status.doing = `已暂停：${this.pauseNote(command)}`;
    // 状态和等待一起落下（驾驶舱、巡检一读就是完整的「已暂停，在等继续」），再写库
    this.status.waiting = {
      kind: 'paused',
      detail: `已暂停（等「继续」或「放弃」）：${this.pauseNote(command)}`,
      since: iso(Date.now()),
    };
    this.enterCloseHold('paused');
    try {
      await this.mirror('running');
      await condition(() => this.continued > before || this.abandon !== null || this.verifiedMerged !== null);
    } finally {
      this.holding = false;
      this.closeHold = null;
    }
    this.pauseReq = null;
    this.guard();
    this.status.phase = previous.phase;
    this.status.doing = previous.doing;
    this.status.waiting = previous.waiting;
    await this.mirror('running');
  }

  /** 把此刻的样子写给驾驶舱（读库的那一侧）。写不进去只记日志：驾驶舱晚一会儿看到，不挡干活。 */
  async mirror(state: TaskState): Promise<void> {
    try {
      await CancellationScope.nonCancellable(() =>
        this.acts.saveTaskState({
          taskId: this.input.taskId,
          repoId: this.input.repo.id,
          issueNumber: this.input.issueNumber,
          state,
          phase: this.status.phase,
          doing: this.status.doing,
          lastProblem: this.status.lastProblem,
          subtasks: [],
        }),
      );
    } catch (error) {
      log.warn('任务状态没写进库（驾驶舱晚一会儿才看到）', { error: String(error) });
    }
  }

  async waiting<T>(kind: TaskWait['kind'], detail: string, fn: () => Promise<T>): Promise<T> {
    this.status.waiting = { kind, detail, since: iso(Date.now()) };
    try {
      return await fn();
    } finally {
      this.status.waiting = null;
    }
  }

  /** 睡 seconds 秒；放弃了马上醒、抛 Abandoned。 */
  async pause(kind: TaskWait['kind'], detail: string, seconds: number): Promise<void> {
    await this.waiting(kind, detail, () =>
      condition(() => this.abandon !== null || this.pauseReq !== null, `${seconds} seconds`),
    );
    await this.checkpoint();
  }

  /**
   * 叫醒信号收到过几次（#194 方案 4.3）。等路由的那一步在**问选路之前**取一个记号，问完要等时交给 pauseForRoute：
   * 问的那一刻到睡下之间到的叫醒不丢（那次选路读的是切号完成之前的事实，得再选一次）。
   */
  routeWakeMark(): number {
    return this.routeWakes;
  }

  /**
   * 选路回要等时，睡之前把原因落库（#2863，patched('route-wait-mirror')）：waiting() 只改内存，
   * 库里 doing / updated_at 会冻在上一次动手那句。原因取 detail 第一个「（」之前那一句（最多 120 字）；
   * 和上一次落库的同一句（且 doing 还是它）就不重复写。记的那一句只在内存里，重放时照样算得出来；
   * 选到路由起会话时 advance 把 doing 换回动手那句（并落库）。
   */
  async mirrorRouteWait(detail: string): Promise<void> {
    if (!patched('route-wait-mirror')) return;
    const line = `等路由：${detail.split('（')[0]?.slice(0, 120) ?? ''}`;
    if (line === this.lastRouteWaitLine && this.status.doing === line) return;
    this.status.doing = line;
    this.lastRouteWaitLine = line;
    await this.mirror('running');
  }

  /**
   * 等路由：睡 seconds 秒，但路由那边变了（叫醒信号，记号之后到过一次就算）当场醒、放弃了马上醒（抛 Abandoned）。
   * 返回是不是被叫醒的（日志、测试看）；醒了调用方照旧重新选一次，选不到会拿新记号再来等，不空转。
   * 「继续」（taskContinue）不加进这个条件：在途的等待重放时谓词必须和记下来的一样。命令行和驾驶舱的「继续」
   * 会再发一发 taskRouteWake，这一条本来就在看它（#2392，换路由续之后睡在这里、任务行冻住的那一觉）。
   * 多张单同时等这里时，测试不要对未收场的工作流 await result()：TimeSkippingWorkflowClient.result
   * 会全局 unlockTimeSkipping，另一张若仍停在本条件上等 taskRouteWake、或活动尚在工人手里，时钟一跳即判 START_TO_CLOSE（#1764）。
   */
  async pauseForRoute(
    kind: TaskWait['kind'],
    detail: string,
    seconds: number,
    mark: number,
  ): Promise<'woken' | 'timeout'> {
    const woken = await this.waiting(kind, detail, () =>
      condition(
        () => this.abandon !== null || this.pauseReq !== null || this.routeWakes > mark,
        `${seconds} seconds`,
      ),
    );
    await this.checkpoint();
    return woken ? 'woken' : 'timeout';
  }

  /**
   * 等路由等太久（#3281）：任务行写成 stalled，让出在跑名额（intake 不数 stalled 的），别的单照常接；alert 为真时报一次警。
   * 路由那边变了（叫醒信号，记号之后到过一次就算）、到 seconds 秒、人点「继续」都醒，醒了写回 running，调用方再试一次。
   * 不改阶段、不进关单保持（不是停下等人，到点自己会再试）。放弃抛 Abandoned。
   */
  async stallForRoute(
    title: string,
    detail: string,
    seconds: number,
    mark: number,
    alert: boolean,
  ): Promise<'woken' | 'timeout'> {
    this.guard();
    const before = this.continued;
    this.status.lastProblem = title;
    this.status.doing = `让出名额等路由：${title}`;
    await this.mirror('stalled');
    if (alert) {
      this.parks += 1;
      try {
        await CancellationScope.nonCancellable(() =>
          this.acts.raiseAlert({
            taskId: this.input.taskId,
            level: 'stuck',
            title,
            detail,
            dedupeKey: `${workflowInfo().workflowId}:park:${this.parks}`,
          }),
        );
      } catch (error) {
        log.warn('报警没发出去，照样让出名额等路由', { title, error: String(error) });
      }
    }
    const woken = await this.waiting('retry', `${title}（路由恢复、到点或「继续」就再试）`, () =>
      condition(
        () =>
          this.abandon !== null ||
          this.continued > before ||
          this.routeWakes > mark ||
          this.verifiedMerged !== null,
        `${seconds} seconds`,
      ),
    );
    this.guard();
    this.status.lastProblem = null;
    await this.mirror('running');
    return woken ? 'woken' : 'timeout';
  }

  /** 把一段长活动放进可取消的范围：放弃的信号一到就取消它（活动心跳，收得到），结果抛 Abandoned。 */
  async cancellable<T>(fn: () => Promise<T>, options: { pausable?: boolean } = {}): Promise<T> {
    // 放弃的信号可能在上一个 await（比如换阶段落库）期间就到了：那时还没有可取消的范围，running 里没有它，
    // 信号只记了下来；这里不先看一眼，长活动就照常起、再没人去取消它，一直跑到它自己的限时（#706）。
    // 老历史里这一步没有这道检查：patched() 为假就照旧。
    if (patched('cancellable-guard')) this.guard();
    // hard 暂停的信号在这一段起之前就到了（前面落库那一步期间）：不起，当场按被暂停处理
    if (options.pausable && this.pauseReq?.mode === 'hard') throw new PausedInterrupt(this.pauseReq);
    const scope = new CancellationScope({ cancellable: true });
    const cancel = () => scope.cancel();
    const pausable = options.pausable === true;
    this.running.add(cancel);
    // 只有动手会话那一段动这几样：旁边自己跑完的验收收场时不能把它们清掉
    if (pausable) {
      this.cancelPausable = cancel;
      this.runningPausable = true;
    }
    try {
      return await scope.run(fn);
    } catch (error) {
      if (this.abandon && isCancellation(error)) throw new Abandoned(this.abandon);
      if (this.pauseCancelled && this.pauseReq && isCancellation(error)) {
        throw new PausedInterrupt(this.pauseReq);
      }
      // 老历史里没有这一支：patched() 为假就当没有（走不到：老历史没有 taskRepin 信号）
      if (this.repinCancelled && this.repinReq && isCancellation(error) && patched('task-repin')) {
        throw new RepinInterrupt(this.repinReq);
      }
      throw error;
    } finally {
      this.running.delete(cancel);
      if (pausable) {
        this.cancelPausable = null;
        this.runningPausable = false;
        this.pauseCancelled = false;
        this.repinCancelled = false;
        this.repinReq = null;
      }
    }
  }

  /** 脱开的仍是原活会话：接回等待期间也算在跑，不授权收树；不增加取消范围或杀会话。 */
  async reattachExisting<T>(fn: () => Promise<T>): Promise<T> {
    const existing = () => {};
    this.running.add(existing);
    try {
      return await fn();
    } finally {
      this.running.delete(existing);
    }
  }

  /**
   * 轮数用尽。这张单头一回用尽（patched('auto-continue-rounds')，决定 0093）：不停下，自动换一条路由（避开最近动手的那个模型）
   * 带上意见续一次，进度里写一行，回 auto；调用方直接起动手，不先重走 CI 和验收。之后用尽才停下等人：点了「继续」，累计不超过
   * MAX_ROUND_RESETS 次（自动那一次也算）就把动手和验收轮数都清零并重读单子；超过就停住，写明交给指挥官，不再清零。
   * 同一次继续里原来的上限仍在。老历史没有 continue-resets-rounds：返回 legacy，调用方只把用尽的那一个计数清掉，不多读单子。
   */
  async exhaustRounds(
    title: string,
    legacyDetail: string,
    detail: string,
    level: 'stuck' | 'decision' = 'stuck',
  ): Promise<'legacy' | 'reset' | 'auto'> {
    const reset = patched('continue-resets-rounds');
    if (reset && this.roundResets === 0 && patched('auto-continue-rounds')) {
      this.roundResets += 1;
      const avoided = this.avoidLastModel();
      this.resetRounds();
      await this.reloadBrief();
      await this.note(
        `${title}：自动换一条路由${avoided ? `（避开 ${avoided}）` : ''}带上意见再做一次，不停下等人（再用完才停）`,
      );
      return 'auto';
    }
    await this.park(title, reset ? detail : legacyDetail, level, 'rounds');
    // 点「继续」清掉没提交攒下的避让，和轮数清零同一处（#1408）。老历史没有这个标记，不碰。
    if (patched('avoid-empty-commit-route')) this.clearCommitAvoid();
    if (!reset) return 'legacy';
    this.roundResets += 1;
    if (this.roundResets > MAX_ROUND_RESETS) {
      const handoff = ROUNDS_HANDOFF_TITLE;
      for (;;) {
        await this.park(handoff, handoff, 'stuck', 'rounds');
      }
    }
    this.resetRounds();
    await this.reloadBrief();
    return 'reset';
  }

  /** 两轮计数清零；单子可能改了：重读之后开新会话，不续带着旧交代的那个。 */
  private resetRounds(): void {
    this.round = 0;
    this.verifyRound = 0;
    this.lastSession = null;
    this.resumeStreak = 0;
  }

  /**
   * 自动续那一次换路由：把最近动手的那个模型记进这张单的避让。还没动过手回 null。
   */
  private avoidLastModel(): string | null {
    const last = this.lastImplementRoute;
    if (!last) return null;
    this.avoidModel(last);
    return last.modelId;
  }

  /**
   * 轮数用完换路由（决定 0093）：把这个模型记进这张单的避让（和没提交的避让同一处，pickRoute 读它）；认得出族的连这一族一起避开
   * （patched('avoid-model-family')：同族换个模型多半重蹈覆辙）。别的族派不出时选路退回只避开模型，还没有别的候选就照旧派原来那条
   * （commitMissRoute），不死等。人点「继续」时清掉。老历史没有这个标记，只避开模型。
   * 超时、起不来、中转欠费不走这里（avoidInfra，不整族避开）。
   */
  avoidModel(route: RouteChoice): void {
    this.commitAvoid = widen(this.commitAvoid, route, 'model');
    const family = avoidableFamily(route);
    if (family !== null && patched('avoid-model-family'))
      this.commitAvoid = withFamily(this.commitAvoid, family);
    this.commitMissRoute = route;
  }

  /**
   * 超时、起不来、中转欠费换路由（#2261，patched('avoid-scope-by-cause')）：不整族避开。
   * 超时、起不来只避开这条路由；同一模型已经这样避开过，再避开模型。中转欠费避开那个池。
   */
  avoidInfra(route: RouteChoice, code: string): void {
    const seen = this.infraRouteModels.includes(route.modelId);
    const scope = infraAvoidScope(code, seen);
    if (scope === 'pool') {
      this.commitAvoid = widen(this.commitAvoid, route, 'pool');
    } else if (scope === 'model') {
      this.commitAvoid = widen(this.commitAvoid, route, 'route');
      this.commitAvoid = widen(this.commitAvoid, route, 'model');
      if (!this.infraModelIds.includes(route.modelId)) this.infraModelIds.push(route.modelId);
    } else {
      this.commitAvoid = widen(this.commitAvoid, route, 'route');
      if (!seen) this.infraRouteModels.push(route.modelId);
    }
    this.commitMissRoute = route;
  }

  /** 同一模型的超时、起不来已经避开过路由、还没升到避开模型：可以再自动重派一次。 */
  infraCanEscalate(route: RouteChoice, code: string): boolean {
    if (this.infraModelIds.includes(route.modelId)) return false;
    return infraAvoidScope(code, this.infraRouteModels.includes(route.modelId)) === 'model';
  }

  /** 「继续」之后，没提交攒下的避让不再带到后面的轮。 */
  private clearCommitAvoid(): void {
    this.commitAvoid = NO_AVOID;
    this.commitMisses = 0;
    this.commitMissRoute = null;
    this.fellBackToMissRoute = false;
    this.infraRouteModels = [];
    this.infraModelIds = [];
    this.landSwitch = false;
    this.switchWake = false;
    this.modelDownLand = false;
  }

  /**
   * 停下等人：报警、写库、等「继续」或「放弃」。继续了回来，调用方从头再试这一步。
   * level 默认 stuck（提醒）。等合并检查红了、返工轮数用完传 decision，进「要你拍的」。
   */
  async park(
    title: string,
    detail: string,
    level: 'stuck' | 'decision' = 'stuck',
    kind: ParkKind = 'other',
  ): Promise<void> {
    this.guard();
    this.parks += 1;
    this.notePark(kind, title, detail);
    const before = this.continued;
    const previous = this.status.phase;
    this.status.lastProblem = title;
    this.status.phase = 'parked';
    this.enterCloseHold('parked');
    this.status.doing = `停下等人：${title}`;
    await this.mirror('stalled');
    try {
      await CancellationScope.nonCancellable(() =>
        this.acts.raiseAlert({
          taskId: this.input.taskId,
          level,
          title,
          detail,
          dedupeKey: `${workflowInfo().workflowId}:park:${this.parks}`,
        }),
      );
    } catch (error) {
      log.warn('报警没发出去，照样停下等人', { title, error: String(error) });
    }
    try {
      await this.waiting('human', `${title}（等「继续」或「放弃」）`, () =>
        condition(
          () =>
            this.continued > before ||
            this.abandon !== null ||
            this.verifiedMerged !== null ||
            this.pushHandback?.state === 'ready',
        ),
      );
      const handback = this.pushHandback;
      // waiting() 的 finally 已清等待展示；这里核原始 hold，不再调用要求展示仍为 human 的 closeToken()。
      if (
        handback?.state === 'ready' &&
        samePushHold(this.closeHold, handback.request.token) &&
        this.permissionPushPark &&
        this.continued === before &&
        this.pauseReq === null &&
        this.abandon === null &&
        this.verifiedMerged === null &&
        this.running.size === 0 &&
        this.prNumber === null
      ) {
        handback.state = 'returning';
        this.status.phase = previous;
        this.status.lastProblem = null;
        throw new PermissionPushHandback(handback.request.feedback);
      }
    } finally {
      this.leavePark();
    }
    this.guard();
    this.closeHold = null;
    this.status.phase = previous;
    this.status.lastProblem = null;
    await this.mirror('running');
  }

  /**
   * 记下正停着的这一次（#3294）：停法类别、第几次、几点、停在哪个头，同一原文引擎续过没有。纯状态，只给查询看（引擎续停读它）。
   * 老历史没有这个标记：patched() 为假就不记，引擎续停看不到停法，一律不续。
   */
  private notePark(kind: ParkKind, title: string, detail: string): void {
    if (!patched('park-kind')) return;
    this.parkKey = `${kind}\n${title}\n${detail}`;
    this.status.park = {
      kind,
      seq: this.parks,
      at: iso(Date.now()),
      title,
      head: this.head,
      retriedBefore: this.engineRetried.has(this.parkKey),
    };
  }

  /** 这一次停下结束了（继续、放弃、自己醒）：查询里不再挂着它。 */
  private leavePark(): void {
    delete this.status.park;
    this.parkKey = '';
  }

  /** 只在这个精确头的预算耗尽停下、再收到新「继续」后，续一段 MAX_MAIN_SYNCS 次；普通信号不预存预算。 */
  async parkMainSyncBudget(
    exhausted: MainSyncBudgetExhausted | undefined,
    detail: string,
    title = '主线同步预算已用完',
  ): Promise<boolean> {
    if (
      !exhausted ||
      exhausted.prNumber !== this.prNumber ||
      exhausted.headSha !== this.head ||
      exhausted.used !== this.mainSyncs ||
      exhausted.used < MAX_MAIN_SYNCS ||
      !Number.isInteger(exhausted.used) ||
      !patched('main-sync-budget-continue')
    )
      return false;
    await this.park(
      title,
      `${detail}。点「继续」只再允许 ${MAX_MAIN_SYNCS} 次同步；每个新头仍按仓的 CI 模式重走检查和验收。`,
    );
    if (
      exhausted.prNumber === this.prNumber &&
      exhausted.headSha === this.head &&
      exhausted.used === this.mainSyncs
    )
      this.mainSyncs = 0;
    return true;
  }

  /**
   * 停下等人，但每 CI_POLICY_POLL_SECONDS 秒（或 opts.pollSeconds）问一次 leave。leave 回 true：恢复运行并回 left（仓已切成不强制 CI）。
   * 人点「继续」回 stayed。放弃抛 Abandoned。还没离开就继续等，不每轮再报警。
   * 只给 patched('repo-ci-policy')、patched('merge-park-recheck') 的新路径用；老的 park() 仍是无限等。
   * opts 不给就是仓 CI 模式那一套（每 CI_POLICY_POLL_SECONDS 秒、等待那一行写「或仓改成不强制 CI」）；
   * 停在合并这一步的传自己的间隔和说法（#3281）；alert 为 false 时不报警（同一原因已经报过）。
   */
  async parkUnless(
    title: string,
    detail: string,
    leave: () => Promise<boolean>,
    opts?: { pollSeconds: number; until: string; alert?: boolean; kind?: ParkKind },
  ): Promise<'left' | 'stayed'> {
    const pollSeconds = opts?.pollSeconds ?? CI_POLICY_POLL_SECONDS;
    const until = opts?.until ?? '或仓改成不强制 CI';
    this.guard();
    this.parks += 1;
    this.notePark(opts?.kind ?? 'other', title, detail);
    const before = this.continued;
    const previous = this.status.phase;
    this.status.lastProblem = title;
    this.status.phase = 'parked';
    this.enterCloseHold('parked');
    this.status.doing = `停下等人：${title}`;
    await this.mirror('stalled');
    if (opts?.alert !== false) {
      try {
        await CancellationScope.nonCancellable(() =>
          this.acts.raiseAlert({
            taskId: this.input.taskId,
            level: 'stuck',
            title,
            detail,
            dedupeKey: `${workflowInfo().workflowId}:park:${this.parks}`,
          }),
        );
      } catch (error) {
        log.warn('报警没发出去，照样停下等人', { title, error: String(error) });
      }
    }
    for (;;) {
      let woken: boolean;
      try {
        woken = await this.waiting('human', `${title}（等「继续」或「放弃」，${until}）`, () =>
          condition(
            () => this.continued > before || this.abandon !== null || this.verifiedMerged !== null,
            `${pollSeconds} seconds`,
          ),
        );
        this.guard();
      } catch (error) {
        this.leavePark();
        throw error;
      }
      if (woken && this.continued > before) {
        this.leavePark();
        this.closeHold = null;
        this.status.phase = previous;
        this.status.lastProblem = null;
        await this.mirror('running');
        return 'stayed';
      }
      if (await leave()) {
        this.leavePark();
        this.closeHold = null;
        this.status.phase = previous;
        this.status.lastProblem = null;
        await this.mirror('running');
        return 'left';
      }
    }
  }

  // ---- 失败分流

  /**
   * 一步：活动自己的重试用完还失败，按失败分流走——有界重试（退避，或等上游给的时间）；再不行停下等人，「继续」之后从头再试。
   * 不绑路由的步骤用它；动手会话在 task-session.ts 里自己带换路由、换模型。
   * autoCodes：判了停下等人、码（小写）在这里面的，不停下，抛 AutoEscape 交给调用方先自动处理一次。
   */
  async step<T>(source: string, fn: () => Promise<T>, autoCodes: readonly string[] = []): Promise<T> {
    let counters = ZERO;
    let previousMessage: string | undefined;
    for (;;) {
      await this.checkpoint();
      try {
        return await fn();
      } catch (error) {
        if (error instanceof Abandoned || error instanceof MergedTask) throw error;
        if (isCancellation(error)) throw error;
        const failure = failureOf(error, source, this.limits);
        // 合并冲突不在这一步里原地重试：第二次原文必一字不差，会直接挂起，会话根本看不到冲突。
        // 老历史没有这个标记，照旧交给失败分流（重试这一步，再不行挂起）。
        if (failure.code.toLowerCase() === 'merge_conflict' && patched('conflict-handoff-keeps-tree')) {
          // 合并还没开始（没跟踪的文件挡着）没有冲突标记：原反馈里有要并的提交，不能改写成「树里留着冲突标记」。
          const pending = conflictPendingOf(error, failure.message);
          throw new ConflictHandoff(conflictFilesOf(error, failure.message), {
            pending,
            instruction: pending ? null : failure.message,
          });
        }
        // 工作树有没推的提交、本地又并不上：停下时把报错原文写进原因（里面有工作树路径和提交号）。
        // 看板「停下等人」读 lastProblem；失败分流的标题只有规则名，装不下这些。
        // 老历史没有这个标记，照旧交给失败分流（原因是规则标题那一句）。
        if (failure.code.toLowerCase() === 'worktree_diverged' && patched('worktree-diverged-note')) {
          await this.park(failure.message, failure.message);
          counters = ZERO;
          previousMessage = undefined;
          continue;
        }
        // 卫生检查拦下推分支：不在这一步里原地重推。第二次原文必一字不差，会直接挂起，会话看不到命中处。
        // 老历史没有这个标记，照旧交给失败分流（马上重推，再一字不差就挂起）。
        if (
          source === 'pushBranch' &&
          failure.code.toLowerCase() === 'hygiene_blocked' &&
          patched('hygiene-blocked-handoff')
        ) {
          throw new HygieneHandoff(failure.message);
        }
        const next = await this.classify(failure, counters, false, { previousMessage });
        previousMessage = failure.message;
        this.status.lastProblem = next.reason;
        if (next.action === 'retry') {
          counters = bump(counters, next);
          await this.pause(next.wait === 'quota' ? 'quota' : 'retry', next.reason, next.delaySeconds);
        } else {
          // 调用方说这个码先自动处理一次（决定 0093）：不停下，交给调用方。老历史没有这个标记，照旧停下。
          if (autoCodes.includes(failure.code.toLowerCase()) && patched('auto-before-park')) {
            throw new AutoEscape(failure.code, failure.message);
          }
          this.permissionPushPark =
            source === 'pushBranch' && failure.code.toLowerCase() === 'workflows_permission';
          try {
            await this.park(
              next.humanFix ? `${next.reason}；要人：${next.humanFix}` : next.reason,
              failure.message,
              'stuck',
              stepParkKind(source, next, failure.code),
            );
          } finally {
            this.permissionPushPark = false;
          }
          counters = ZERO;
          previousMessage = undefined;
        }
      }
    }
  }

  classify(
    failure: {
      source: string;
      code: string;
      message: string;
      retryable: boolean | null;
      activity?: string | undefined;
      startToCloseSeconds?: number | undefined;
      engineStartedAt?: string | undefined;
      currentEngineStartedAt?: string | undefined;
      engineRestarted?: boolean | undefined;
    },
    counters: LadderCounters,
    routeBound: boolean,
    context: FailureContext,
  ): Promise<NextAction> {
    return judgeRetrying('failure', {
      failure,
      counters,
      limits: this.limits,
      routeBound,
      context: { now: iso(Date.now()), ...stripUndefined(context) },
    });
  }
}

/**
 * 挂合并、直接合并这两步里，发了新版也治不好的认证和权限（#3294 返工）。
 * 规则：登录失效 AU2、没有权限 PM1（这两条没写 humanFix，以前被源步骤一刀切成 unarmed）。
 * 码：规则表没单列、分流会落到「认不出」的 GitHub 401（AUTH_FAILED）和 403（FORBIDDEN），以及已经能对上规则的那几个码。
 */
const MERGE_CREDENTIAL_RULES = new Set(['AU2', 'PM1']);
const MERGE_CREDENTIAL_CODES = new Set([
  'auth_failed',
  'auth_required',
  'forbidden',
  'permission_denied',
  'workflows_permission',
  'workflow_permission',
]);

function mergeCredentialStop(rule: string | undefined, failureCode: string | undefined): boolean {
  if (rule !== undefined && MERGE_CREDENTIAL_RULES.has(rule)) return true;
  const code = failureCode?.trim().toLowerCase();
  return code !== undefined && MERGE_CREDENTIAL_CODES.has(code);
}

/**
 * 失败分流判了停下的那一次算哪一类（#3294）：要人修的（有 humanFix）不续；挂合并、直接合并这两步算「自动合并没挂上」；
 * 认不出走兜底梯（FB）的算「按临时的办」；别的不续。
 * 认证、权限即使出在这两步也不算「没挂上」：令牌失效、没有权限，法国发了新版也续不上。
 */
export function stepParkKind(
  source: string,
  next: Pick<NextAction, 'humanFix' | 'rule'>,
  failureCode?: string,
): ParkKind {
  if (next.humanFix) return 'other';
  const mergeStep = source === 'armAutoMerge' || source === 'mergeNow';
  if (mergeStep && mergeCredentialStop(next.rule, failureCode)) return 'other';
  if (mergeStep) return 'unarmed';
  return next.rule === 'FB' ? 'transient' : 'other';
}
