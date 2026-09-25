// 三条工作流共用的零件：活动代理、判断入口（判断出错也不判死）、命令受理、暂停门、等待记账（含墙钟预算的停表）、
// 挂起报警、跑一个阶段的会话（含兜底梯）。
// 这里是工作流代码，会被重放：改调度顺序（多调、少调、换顺序调活动或 decide）要用 patched()，见 test/replay.test.ts。
// 编号（runId、askId、批准编号、subtasks.id）一律经 decide('newIds') 生成、记进历史；工作流里不许用 uuid4（structure.test.ts 盯着）。

import type { RunOutcome, StageKind } from '@fleet-dao/shared';
import {
  ActivityFailure,
  ApplicationFailure,
  CancellationScope,
  ChildWorkflowFailure,
  condition,
  isCancellation,
  log,
  patched,
  proxyActivities,
  proxyLocalActivities,
  setDefaultSignalHandler,
  setHandler,
  sleep,
  TemporalFailure,
  TimeoutFailure,
  workflowInfo,
} from '@temporalio/workflow';
import {
  ACTIVITY_PROFILE,
  type ActivityName,
  activityOptions,
  type EngineActivities,
} from '../activity-options.ts';
import {
  AGENT_EVENT_WAKE_KINDS,
  type AgentEventSeen,
  type AnswerCommand,
  type ApprovalCommand,
  agentEventSignal,
  answerSignal,
  approveSignal,
  type CommandMeta,
  type CommandReceipt,
  pauseSignal,
  type RequireApprovalCommand,
  type RerouteCommand,
  type RouteOverrides,
  rejectSignal,
  requireApprovalSignal,
  rerouteSignal,
  resumeSignal,
  stopSignal,
  type Waiting,
} from '../contract.ts';
import type { FailureContext, FailureInfo, LadderCounters, NextAction } from '../decisions/failure.ts';
import type { Decide, DecisionKind, DecisionMap } from '../decisions/index.ts';
import type { Feedback } from '../decisions/verify.ts';
import { historyAlertLine, type Limits } from '../limits.ts';
import type {
  RouteChoice,
  Scope,
  SessionBrief,
  SessionEnd,
  SessionHandle,
  SessionOutput,
  Usage,
  WaitKind,
} from '../ports.ts';
import { costOfRun } from '../usage.ts';

/** 流程判断：本地活动，结果进历史，重放时不重算。自己带几次重试；再不行由 judge 按兜底梯走，不判死。 */
const { decide } = proxyLocalActivities<{ decide: Decide }>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 3, initialInterval: '500 milliseconds', backoffCoefficient: 2 },
});

type In<K extends DecisionKind> = DecisionMap[K]['input'];
type Out<K extends DecisionKind> = DecisionMap[K]['output'];

/** 判断出错后的退避：15 秒起翻倍，封顶 10 分钟（和兜底梯的重试一样）。 */
function backoffSeconds(failuresSoFar: number): number {
  return Math.min(15 * 2 ** failuresSoFar, 600);
}

/**
 * 没有暂停、挂起可用的地方（开头解析上限、合并队列）调判断：出错就退避着一直试；连着出错到第 alertAfter 次时报一次警。
 * 判断出错多半是代码错了：修好换上新工人，下一次就接着走。
 */
export async function judgeRetrying<K extends DecisionKind>(
  kind: K,
  input: In<K>,
  stuck: { alertAfter: number; alert(message: string): Promise<void> } | null = null,
): Promise<Out<K>> {
  for (let failures = 0; ; failures += 1) {
    try {
      return await decide(kind, input);
    } catch (error) {
      if (isCancellation(error)) throw error;
      const message = failureOf(error, `decide:${kind}`).message;
      log.error('判断出错，退避后重试', { kind, failures: failures + 1, error: message });
      if (stuck && failures + 1 === stuck.alertAfter) await stuck.alert(message);
      await sleep(`${backoffSeconds(failures)} seconds`);
    }
  }
}

/** 开头解析上限（还没有上限，没法按兜底梯走）。resolveLimits 自己不会出错，出错只能是工人配错了。 */
export function limitsFor(partial: Partial<Limits> | undefined): Promise<Limits> {
  return judgeRetrying('limits', partial ?? {});
}

/** 给每个活动配上它自己的选项（那一档的超时与重试、叫停时等不等它收场），见 activity-options.ts。 */
export function activitiesFor(limits: Limits): EngineActivities {
  const out: Partial<Record<ActivityName, unknown>> = {};
  for (const name of Object.keys(ACTIVITY_PROFILE) as ActivityName[]) {
    out[name] = proxyActivities<EngineActivities>(activityOptions(name, limits))[name];
  }
  return out as EngineActivities;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// ---- 命令受理

export interface Control {
  paused: boolean;
  parked: boolean;
  stopRequested: boolean;
  routeOverrides: RouteOverrides;
  answers: Record<string, AnswerCommand>;
  pendingAsks: string[];
  commands: CommandReceipt[];
  lastAgentEvent: AgentEventSeen | null;
  /** 有东西变了就加一，主循环拿它当唤醒条件。 */
  version: number;
}

/** 一条命令受理没有、为什么。 */
export interface Verdict {
  accepted: boolean;
  note: string;
}

export interface ControlHooks {
  onStop(): void;
  /** 不带阶段的「换路由」落在哪几个阶段上。 */
  mainStages: readonly StageKind[];
  /** 子任务自己的 subtasks.id；「换路由」点名别的子任务时不在自己这层生效。 */
  selfSubtaskId?: string;
  /** 这一次会话是不是这条工作流起的；不是的 fleet 叫醒不理。 */
  ownsRun?(runId: string): boolean;
  /** 需求把命令转给在跑的子任务；返回转了几个。 */
  forwardPause?(meta: CommandMeta | undefined): number;
  forwardResume?(meta: CommandMeta | undefined): number;
  forwardReroute?(command: RerouteCommand): number;
  forwardAnswer?(command: AnswerCommand): boolean;
  /** 人闸：子任务自己受理，需求转给对应的子任务。没挂的就是「这里没有人闸」。 */
  approve?(command: ApprovalCommand): Verdict;
  reject?(command: ApprovalCommand): Verdict;
  requireApproval?(command: RequireApprovalCommand): Verdict;
}

const RECEIPTS_KEPT = 20;
const WAKE_KINDS: readonly string[] = AGENT_EVENT_WAKE_KINDS;

export function installControl(initial: RouteOverrides | undefined, hooks: ControlHooks): Control {
  const control: Control = {
    paused: false,
    parked: false,
    stopRequested: false,
    routeOverrides: { ...(initial ?? {}) },
    answers: {},
    pendingAsks: [],
    commands: [],
    lastAgentEvent: null,
    version: 0,
  };
  const receipt = (command: string, accepted: boolean, note: string, meta?: { by?: string | undefined }) => {
    control.commands.push({
      command,
      at: iso(Date.now()),
      accepted,
      note,
      ...(meta?.by ? { by: meta.by } : {}),
    });
    if (control.commands.length > RECEIPTS_KEPT)
      control.commands.splice(0, control.commands.length - RECEIPTS_KEPT);
    control.version += 1;
  };
  setHandler(pauseSignal, (meta) => {
    if (control.stopRequested) return receipt('pause', false, '已经在叫停', meta);
    const forwarded = hooks.forwardPause?.(meta) ?? 0;
    if (control.paused) {
      return receipt(
        'pause',
        forwarded > 0,
        forwarded > 0 ? `转给 ${forwarded} 个子任务` : '已经是暂停',
        meta,
      );
    }
    control.paused = true;
    receipt('pause', true, '暂停：会话停在干净的点，不再开新步骤，排队没合的撤出来', meta);
  });
  setHandler(resumeSignal, (meta) => {
    if (control.stopRequested) return receipt('resume', false, '已经在叫停', meta);
    const forwarded = hooks.forwardResume?.(meta) ?? 0;
    if (control.paused) {
      control.paused = false;
      return receipt('resume', true, '继续', meta);
    }
    if (control.parked) {
      control.parked = false;
      return receipt('resume', true, '解除挂起，接着干', meta);
    }
    if (forwarded > 0) return receipt('resume', true, `转给 ${forwarded} 个子任务`, meta);
    receipt('resume', false, '没有暂停也没有挂起，忽略', meta);
  });
  setHandler(stopSignal, (meta) => {
    if (control.stopRequested) return receipt('stop', false, '已经在叫停', meta);
    control.stopRequested = true;
    hooks.onStop();
    receipt('stop', true, '叫停：停会话、撤出合并队列、收工作树', meta);
  });
  setHandler(rerouteSignal, (command) => {
    if (!command?.routeId) return receipt('reroute', false, '没给路由', command);
    if (control.stopRequested) return receipt('reroute', false, '已经在叫停', command);
    if (command.subtaskId && command.subtaskId !== hooks.selfSubtaskId) {
      const forwarded = hooks.forwardReroute?.(command) ?? 0;
      return receipt(
        'reroute',
        forwarded > 0,
        forwarded > 0 ? `转给子任务 ${command.subtaskId}` : `没有在跑的子任务 ${command.subtaskId}`,
        command,
      );
    }
    const stages = command.stage ? [command.stage] : hooks.mainStages;
    const next = { ...control.routeOverrides };
    for (const stage of stages) next[stage] = command.routeId;
    control.routeOverrides = next;
    const forwarded = command.subtaskId ? 0 : (hooks.forwardReroute?.(command) ?? 0);
    const unparked = control.parked;
    control.parked = false;
    receipt(
      'reroute',
      true,
      `${stages.join('、')} 改用 ${command.routeId}${unparked ? '，解除挂起' : ''}${forwarded > 0 ? `，转给 ${forwarded} 个子任务` : ''}`,
      command,
    );
  });
  setHandler(answerSignal, (command) => {
    if (!command?.askId) return receipt('answer', false, '没给问题编号', command);
    if (control.pendingAsks.includes(command.askId)) {
      control.answers = { ...control.answers, [command.askId]: command };
      return receipt('answer', true, '收到回答', command);
    }
    if (hooks.forwardAnswer?.(command)) return receipt('answer', true, '转给提问的子任务', command);
    // 会话里 fleet ask 问的由后端直接交给会话；这里先收下，万一是还没开始等的问题也不丢。
    control.answers = { ...control.answers, [command.askId]: command };
    receipt('answer', true, '先收下（这里没有在等这个问题）', command);
  });
  const approval = <C extends { by?: string | undefined }>(
    name: 'approve' | 'reject' | 'requireApproval',
    handle: ((command: C) => Verdict) | undefined,
    command: C | undefined,
  ) => {
    if (!command) return receipt(name, false, '没给内容');
    if (control.stopRequested) return receipt(name, false, '已经在叫停', command);
    const verdict = handle ? handle(command) : { accepted: false, note: '这里没有人闸' };
    receipt(name, verdict.accepted, verdict.note, command);
  };
  setHandler(approveSignal, (command) => approval('approve', hooks.approve, command));
  setHandler(rejectSignal, (command) => approval('reject', hooks.reject, command));
  setHandler(requireApprovalSignal, (command) => approval('requireApproval', hooks.requireApproval, command));
  // fleet 命令的叫醒：只认会改变走向的几类、只认自己起的会话；不进回执，只记最近一次、叫醒主循环。
  setHandler(agentEventSignal, (event) => {
    if (!event?.runId || !WAKE_KINDS.includes(event.kind)) return;
    if (hooks.ownsRun && !hooks.ownsRun(event.runId)) return;
    control.lastAgentEvent = {
      runId: event.runId,
      kind: event.kind,
      ...(event.askId ? { askId: event.askId } : {}),
      at: iso(Date.now()),
    };
    control.version += 1;
  });
  // 兜底处理最后挂：一挂上就会吃掉还没有处理器的缓存信号。
  setDefaultSignalHandler((name) => receipt(name, false, '不认识的命令，忽略'));
  return control;
}

// ---- 跑流程用的工具箱

export interface View {
  waiting: Waiting | null;
  lastProblem: string | null;
  route: { routeId: string; modelId: string; why: string } | null;
  runId: string | null;
  sessionId: string | null;
}

/** 正在起、正在跑的会话：收尾时按 runId 停它（起会话还没返回时只有 runId），工人重启后按 handle 找回它。 */
export interface ActiveSession {
  runId: string;
  sessionId?: string;
  handle?: SessionHandle;
}

type RunningSession = ActiveSession & { sessionId: string };

export interface Kit {
  acts: EngineActivities;
  limits: Limits;
  control: Control;
  scope: Scope;
  view: View;
  /** 看得见的状态变了（子任务用它通知需求）。 */
  onChange(): void;
  parkCount: number;
  /** 正在起、正在跑的会话（同一时刻可能有写码和第二意见两个），按 runId。 */
  active: Record<string, ActiveSession>;
  /** 每个会话（sessionId）上一轮报的累计花费；null = 上一轮没读到。这一次的花费按它求差。 */
  costSeen: Record<string, number | null>;
  /** 墙钟预算的停表：等人、排队时不走。depth 是嵌套着的停表等待有几层（排队时又暂停了只算一段）。 */
  clock: { depth: number; since: number; offMs: number };
  /** 事件数报警报过了（一条执行只报一次）。 */
  historyAlarmed: boolean;
}

export function newKit(
  fields: Omit<Kit, 'parkCount' | 'active' | 'costSeen' | 'clock' | 'historyAlarmed'>,
): Kit {
  return {
    ...fields,
    parkCount: 0,
    active: {},
    costSeen: {},
    clock: { depth: 0, since: 0, offMs: 0 },
    historyAlarmed: false,
  };
}

/** 墙钟预算不算的等待：等人（暂停、挂起、回答、批准）和排队（账号池空位、额度、合并队列）。 */
const OFF_CLOCK: readonly WaitKind[] = ['human', 'slot', 'quota', 'merge-queue'];

/** 停表，返回「开表」。 */
function stopClock(kit: Kit, kind: WaitKind): () => void {
  if (!OFF_CLOCK.includes(kind)) return () => undefined;
  const clock = kit.clock;
  if (clock.depth === 0) clock.since = Date.now();
  clock.depth += 1;
  let restarted = false;
  return () => {
    if (restarted) return;
    restarted = true;
    clock.depth -= 1;
    if (clock.depth === 0) clock.offMs += Date.now() - clock.since;
  };
}

/** 到现在为止停表停了多久（毫秒）。子任务干了多久 = 过去的时间 − 这个。 */
export function offClockMs(kit: Kit): number {
  return kit.clock.offMs + (kit.clock.depth > 0 ? Date.now() - kit.clock.since : 0);
}

export async function recordWait(
  kit: Kit,
  kind: WaitKind,
  detail: string,
  since: number,
  ended: number,
): Promise<void> {
  const info = workflowInfo();
  try {
    await CancellationScope.nonCancellable(() =>
      kit.acts.recordTiming({
        kind: 'wait',
        workflowId: info.workflowId,
        runId: info.runId,
        workflowType: info.workflowType,
        ...kit.scope,
        waitFor: kind,
        detail,
        startedAt: iso(since),
        endedAt: iso(ended),
        waitMs: ended - since,
      }),
    );
  } catch (error) {
    log.warn('记等待时长失败', { error: String(error) });
  }
}

/** 标明在等什么（等完恢复成外层在等的）、等人和排队时停表，等完记一笔等待时长。 */
export async function waitFor<T>(
  kit: Kit,
  kind: WaitKind,
  detail: string,
  fn: () => Promise<T>,
  extra: { on?: string[]; askId?: string; approvalId?: string } = {},
): Promise<T> {
  const since = Date.now();
  const outer = kit.view.waiting;
  kit.view.waiting = { kind, detail, since: iso(since), ...extra };
  kit.onChange();
  const restartClock = stopClock(kit, kind);
  try {
    return await fn();
  } finally {
    restartClock();
    kit.view.waiting = outer;
    kit.onChange();
    const ended = Date.now();
    if (ended > since) await recordWait(kit, kind, detail, since, ended);
  }
}

/** 暂停门：暂停着就在这里等「继续」。每一步开工前过一次，顺带看一眼事件数。 */
export async function gate(kit: Kit): Promise<void> {
  await watchHistory(kit);
  if (!kit.control.paused) return;
  await waitFor(kit, 'human', '已暂停，等「继续」', () => condition(() => !kit.control.paused));
}

/**
 * 工作流事件数报警：到 limits.historyAlertEvents 报一次（一条执行一张卡）。需求、子任务不换历史，事件数一路涨——
 * 撞上 Temporal 的上限后连叫停都发不进去（fleet 叫醒改成只发 ask/done/blocked 之后，正常一个需求远到不了这个数，
 * 到了多半是哪里在刷信号或绕圈）。报警本身失败不挡流程。
 */
export async function watchHistory(kit: Kit): Promise<void> {
  if (kit.historyAlarmed) return;
  const info = workflowInfo();
  const line = historyAlertLine(kit.limits);
  if (info.historyLength < line) return;
  // 接这道报警之前起的执行，重放时这里没有这一步：按老样子不报。
  if (!patched('history-alarm')) return;
  kit.historyAlarmed = true;
  try {
    await kit.acts.raiseAlert({
      ...kit.scope,
      level: 'info',
      title: `工作流事件数到了 ${info.historyLength}（报警线 ${line}）`,
      detail: `${info.workflowType} ${info.workflowId}：事件数一路涨到 Temporal 的上限（每条执行 1 万个信号、5 万多个事件）就连叫停都发不进去。看看是不是有东西在刷信号或会话在绕圈；要接着跑，考虑叫停后重开。`,
      dedupeKey: `${info.workflowId}:history`,
    });
  } catch (error) {
    if (isCancellation(error)) throw error;
    log.warn('事件数报警没发出去', { error: String(error) });
  }
}

/** 挂起并报警：兜底梯的最后一级。等「继续」或「换路由」。挂起和「在等人」同一刻亮出来，报警在等的里面发。 */
export async function park(kit: Kit, title: string, detail: string): Promise<void> {
  kit.control.parked = true;
  kit.parkCount += 1;
  kit.view.lastProblem = title;
  const dedupeKey = `${workflowInfo().workflowId}:park:${kit.parkCount}`;
  await waitFor(kit, 'human', `挂起：${title}（等「继续」或「换路由」）`, async () => {
    try {
      await kit.acts.raiseAlert({ ...kit.scope, level: 'stuck', title, detail, dedupeKey });
    } catch (error) {
      if (isCancellation(error)) throw error;
      log.warn('报警没发出去，照样挂起等人', { title, error: String(error) });
    }
    await condition(() => !kit.control.parked);
  });
}

/**
 * 调判断（decide 本地活动）。它自己的重试用完还出错：不判死，按兜底梯走——有界重试（退避）→ 挂起报警，
 * 人发「继续」后从头再试（修好代码、换上新工人就能接着走）。这一级不再调 decide 判下一步：出错的可能正是它。
 */
export async function judge<K extends DecisionKind>(kit: Kit, kind: K, input: In<K>): Promise<Out<K>> {
  let failures = 0;
  for (;;) {
    try {
      return await decide(kind, input);
    } catch (error) {
      if (isCancellation(error)) throw error;
      const message = failureOf(error, `decide:${kind}`).message;
      if (failures < kit.limits.retryAttempts) {
        const delay = backoffSeconds(failures);
        failures += 1;
        const reason = `判断「${kind}」出错：第 ${failures} 次重试，${delay} 秒后`;
        kit.view.lastProblem = reason;
        kit.onChange();
        await waitFor(kit, 'retry', reason, () => sleep(`${delay} seconds`));
      } else {
        await park(kit, `判断「${kind}」出错，挂起等人`, message);
        failures = 0;
      }
    }
  }
}

/** 要一个新编号（UUID，经 decide 记进历史）。 */
export async function newId(kit: Kit): Promise<string> {
  const [id] = await judge(kit, 'newIds', { count: 1 });
  if (!id) throw new Error('newIds 没给出编号');
  return id;
}

/** 活动失败 → 失败分流要的结构化信息。只做提取，不做判断。 */
export function failureOf(error: unknown, source: string): FailureInfo {
  let cause: unknown = error;
  if ((cause instanceof ActivityFailure || cause instanceof ChildWorkflowFailure) && cause.cause)
    cause = cause.cause;
  if (cause instanceof ApplicationFailure) {
    return { source, code: cause.type ?? 'Error', message: cause.message, retryable: !cause.nonRetryable };
  }
  if (cause instanceof TimeoutFailure) {
    return {
      source,
      code: `TIMEOUT_${cause.timeoutType ?? 'UNKNOWN'}`,
      message: cause.message,
      retryable: true,
    };
  }
  if (cause instanceof TemporalFailure || cause instanceof Error) {
    return { source, code: cause.name, message: cause.message, retryable: null };
  }
  return { source, code: 'UNKNOWN', message: String(cause), retryable: null };
}

const NO_LADDER: LadderCounters = { retries: 0, reworks: 0, routeSwaps: 0, modelSwaps: 0 };

const COUNTER_OF: Readonly<Record<NextAction['action'], keyof LadderCounters | null>> = {
  retry: 'retries',
  swapRoute: 'routeSwaps',
  swapModel: 'modelSwaps',
  park: null,
};

/** 按判断给计数加一：判断带 counter 就听它的（返工另记一本账）；在途任务历史里的老判断没有，按动作推。 */
function bump(counters: LadderCounters, next: NextAction): LadderCounters {
  const key = next.counter === undefined ? COUNTER_OF[next.action] : next.counter;
  return key ? { ...counters, [key]: (counters[key] ?? 0) + 1 } : counters;
}

/** 这一步之后续不续同一个会话：判断写明的听它的；老判断没写，只有重试续。 */
function resumesSame(next: NextAction): boolean {
  return next.resumeSame ?? next.action === 'retry';
}

/** 等上游：等账号池额度清零不算墙钟预算（和排队一样），别的等待照常算。 */
function waitKindOf(next: NextAction): WaitKind {
  return next.wait === 'quota' ? 'quota' : 'retry';
}

/** 不挂起也要报警的（例如封号：换池接着干，但要人知道）。一条执行一条规则一张卡；报不出去不挡流程。 */
async function alertIfNeeded(kit: Kit, next: NextAction, detail: string): Promise<void> {
  if (!next.alert || next.action === 'park') return;
  try {
    await kit.acts.raiseAlert({
      ...kit.scope,
      level: 'info',
      title: next.reason,
      detail,
      dedupeKey: `${workflowInfo().workflowId}:failure:${next.rule ?? next.classifiedAs}`,
    });
  } catch (error) {
    if (isCancellation(error)) throw error;
    log.warn('报警没发出去，接着按判断走', { error: String(error) });
  }
}

/** 挂起的标题：只有人能修、修法确定的（重新登录），把修法写进标题，卡片上一眼看到。 */
function parkTitle(next: NextAction): string {
  return next.humanFix && !next.reason.includes(next.humanFix)
    ? `${next.reason}；要人：${next.humanFix}`
    : next.reason;
}

/** 不绑路由的一步（建树、推分支、等 CI……）：活动自己的重试用完后按失败分流走——有界重试（或等上游），再不行挂起报警。 */
export async function attempt<T>(kit: Kit, source: string, fn: () => Promise<T>): Promise<T> {
  let counters = NO_LADDER;
  let previousMessage: string | undefined;
  for (;;) {
    await gate(kit);
    try {
      return await fn();
    } catch (error) {
      if (isCancellation(error)) throw error;
      const failure = failureOf(error, source);
      const next = await judge(kit, 'failure', {
        failure,
        counters,
        limits: kit.limits,
        routeBound: false,
        context: { now: iso(Date.now()), ...(previousMessage ? { previousMessage } : {}) },
      });
      previousMessage = failure.message;
      kit.view.lastProblem = next.reason;
      kit.onChange();
      await alertIfNeeded(kit, next, failure.message);
      if (next.action === 'retry') {
        counters = bump(counters, next);
        await waitFor(kit, waitKindOf(next), next.reason, () => sleep(`${next.delaySeconds} seconds`));
      } else {
        await park(kit, parkTitle(next), failure.message);
        counters = NO_LADDER;
        previousMessage = undefined;
      }
    }
  }
}

/** 返工账：跨轮次带着（会话改完再交，又走到同一步）。previousMessage = 上一次被拦的原文，一字不差再犯就挂起。 */
export interface ReworkCarry {
  reworks: number;
  previousMessage?: string;
}

export const NO_REWORK: ReworkCarry = { reworks: 0 };

/**
 * 退回会话的原因。rule 是失败分流认出的规则（HY1 卫生检查拦下、MC1 并主线冲突、DL1 交付不对……）：
 * 调用方按它给会话写返工意见，不一律说成卫生检查（说错了会话会去改写本来没问题的提交）。
 */
export interface Rework {
  reason: string;
  message: string;
  rule: string | undefined;
  carry: ReworkCarry;
}

/** 哪一步把活退回会话：推分支、开 PR、写需求文档或方案进主线。 */
export type ReworkStep = 'push' | 'openPr' | 'doc';

const HYGIENE_SUMMARY: Record<ReworkStep, string> = {
  push: '推之前的卫生检查拦下了你交的内容：公开仓推上去就公开了。把这些从提交里拿掉——要改写提交（推上去的是全部提交），不能只加一个删掉它的新提交',
  openPr:
    '开 PR 之前的卫生检查拦下了 PR 的标题或正文（你交活时 fleet done 写的总结就在正文里）：开出去就公开了。代码不用动，改好总结重新 fleet done',
  doc: '写进主线之前的卫生检查拦下了你写的文档：公开仓写上去就公开了。把这些从文档里拿掉再交',
};

/** 退回会话时的返工意见：按认出的规则写（卫生检查、并主线冲突、交付不对各有各的改法），原文原样带上。 */
export function reworkFeedback(
  step: ReworkStep,
  rework: Pick<Rework, 'rule' | 'reason' | 'message'>,
): Feedback {
  const items = [rework.message];
  if (rework.rule === 'HY1') return { kind: 'hygiene', summary: HYGIENE_SUMMARY[step], items };
  if (rework.rule === 'MC1') {
    return {
      kind: 'conflict',
      summary: '推之前把最新主线并进你的树时有冲突：照下面写的在树里 git merge、解掉冲突、提交后再交',
      items,
    };
  }
  return { kind: 'delivery', summary: `交的东西没过核对：${rework.reason}`, items };
}

/**
 * 和 attempt 一样按失败分流走，多一种结局：分流说「返工」（记返工账的那一级，例如推之前的卫生检查拦下了会话交的内容），
 * 这一步不在原地重试——原样再推一次还是被拦——交回调用方退回会话，带上被拦的原文和认出的规则。carry 由调用方跨轮次带着。
 */
export async function attemptOrRework<T>(
  kit: Kit,
  source: string,
  fn: () => Promise<T>,
  carry: ReworkCarry,
): Promise<{ ok: T } | { rework: Rework }> {
  let counters: LadderCounters = { ...NO_LADDER, reworks: carry.reworks };
  let previousMessage = carry.previousMessage;
  for (;;) {
    await gate(kit);
    try {
      return { ok: await fn() };
    } catch (error) {
      if (isCancellation(error)) throw error;
      const failure = failureOf(error, source);
      const next = await judge(kit, 'failure', {
        failure,
        counters,
        limits: kit.limits,
        routeBound: false,
        context: { now: iso(Date.now()), ...(previousMessage ? { previousMessage } : {}) },
      });
      kit.view.lastProblem = next.reason;
      kit.onChange();
      await alertIfNeeded(kit, next, failure.message);
      if (next.action === 'retry' && next.counter === 'reworks') {
        return {
          rework: {
            reason: next.reason,
            message: failure.message,
            rule: next.rule,
            carry: { reworks: counters.reworks + 1, previousMessage: failure.message },
          },
        };
      }
      previousMessage = failure.message;
      if (next.action === 'retry') {
        counters = bump(counters, next);
        await waitFor(kit, waitKindOf(next), next.reason, () => sleep(`${next.delaySeconds} seconds`));
      } else {
        await park(kit, parkTitle(next), failure.message);
        counters = NO_LADDER;
        previousMessage = undefined;
      }
    }
  }
}

/**
 * 问创始人一句，等回答。提问编号由工作流先定好（进历史）再发卡：发卡的活动重试时端口按编号去重，只有一张卡；
 * 编号在发卡前就登记为「在等」，人回答得再快也不会落空。
 */
export async function askAndWait(
  kit: Kit,
  question: string,
  options?: string[],
  runId?: string,
): Promise<string> {
  const askId = await newId(kit);
  kit.control.pendingAsks = [...kit.control.pendingAsks, askId];
  try {
    return await waitFor(
      kit,
      'human',
      `等回答：${question}`,
      async () => {
        await attempt(kit, 'askHuman', () =>
          kit.acts.askHuman({
            ...kit.scope,
            askId,
            question,
            ...(options && options.length > 0 ? { options } : {}),
            ...(runId ? { runId } : {}),
          }),
        );
        await condition(() => askId in kit.control.answers);
        return kit.control.answers[askId]?.answer ?? '';
      },
      { askId },
    );
  } finally {
    kit.control.pendingAsks = kit.control.pendingAsks.filter((q) => q !== askId);
  }
}

// ---- 跑一个阶段的会话

type OutputKind = SessionOutput['kind'];
export type OutputOf<K extends OutputKind> = Extract<SessionOutput, { kind: K }>;

export interface StageRequest<K extends OutputKind> {
  stage: StageKind;
  /** 这一阶段应当交回来的东西；交错了按失败处理。 */
  expect: K;
  brief: SessionBrief;
  resumeSessionId?: string | undefined;
  worktreePath?: string | undefined;
  /** 写码类会话：起会话前分支的头（交付判据用）。 */
  baseHead?: string | undefined;
}

export interface StageResult<K extends OutputKind> {
  sessionId: string;
  runId: string;
  output: OutputOf<K>;
  route: RouteChoice;
}

type Picked = { route: RouteChoice; why: string } | { none: string };

/** 换路时要避开的：路由、整个账号池、模型。 */
interface Avoid {
  routeIds: string[];
  poolIds: string[];
  modelIds: string[];
}

const AVOID_NOTHING: Avoid = { routeIds: [], poolIds: [], modelIds: [] };

/** 选路由；没空位、没额度就等（记下在等哪个、停表），一条能用的都没有就交回去挂起。 */
async function chooseRoute(
  kit: Kit,
  stage: StageKind,
  avoid: Avoid,
  stickRouteId: string | undefined,
): Promise<Picked> {
  const outer = kit.view.waiting;
  let since: number | null = null;
  let restartClock: (() => void) | null = null;
  let kind: WaitKind = 'slot';
  let detail = '';
  try {
    for (;;) {
      const preferRouteId = kit.control.routeOverrides[stage];
      // 人点名的路由压过「续同一个会话」：换路由的命令就是要换。
      const stick = preferRouteId ? undefined : stickRouteId;
      const result = await attempt(kit, 'pickRoute', () =>
        kit.acts.pickRoute({
          ...kit.scope,
          stage,
          avoidRouteIds: avoid.routeIds,
          avoidPoolIds: avoid.poolIds,
          avoidModelIds: avoid.modelIds,
          ...(preferRouteId ? { preferRouteId } : {}),
          ...(stick ? { stickRouteId: stick } : {}),
        }),
      );
      if (result.ok) return { route: result.route, why: result.why };
      if (result.waitFor === 'none') return { none: result.detail };
      if (since === null) {
        since = Date.now();
        restartClock = stopClock(kit, result.waitFor);
      }
      kind = result.waitFor;
      detail = result.detail;
      kit.view.waiting = { kind, detail, since: iso(since) };
      kit.onChange();
      await sleep(`${result.retryAfterSeconds ?? kit.limits.routePollSeconds} seconds`);
      await gate(kit);
    }
  } finally {
    restartClock?.();
    if (since !== null) {
      kit.view.waiting = outer;
      kit.onChange();
      await recordWait(kit, kind, detail, since, Date.now());
    }
  }
}

/** 等会话结束；中途要暂停或换路由，就请它停在干净的点（做完的先提交）。 */
async function watchSession(
  kit: Kit,
  stage: StageKind,
  session: RunningSession,
): Promise<{ end: SessionEnd; stoppedByUs: boolean }> {
  const { runId, sessionId, handle } = session;
  const routeAtStart = kit.control.routeOverrides[stage];
  const wantsStop = () => kit.control.paused || kit.control.routeOverrides[stage] !== routeAtStart;
  const ended = kit.acts.awaitSession({
    ...kit.scope,
    runId,
    sessionId,
    stage,
    ...(handle ? { handle } : {}),
  });
  const first = await Promise.race([ended.then((end) => ({ end })), condition(wantsStop).then(() => null)]);
  if (first) return { end: first.end, stoppedByUs: false };
  const reason = kit.control.paused ? '暂停' : '换路由';
  try {
    await kit.acts.stopSession({
      ...kit.scope,
      runId,
      sessionId,
      ...(handle ? { handle } : {}),
      mode: 'graceful',
      reason,
    });
  } catch (error) {
    if (isCancellation(error)) throw error;
    log.warn('停会话没成功，接着等它自己结束', { sessionId, error: String(error) });
  }
  return { end: await ended, stoppedByUs: true };
}

/** 收尾（叫停、失败）：把正在起、正在跑的会话都按 runId 停掉。停不掉只记一笔，交给对账。 */
export async function stopActiveSessions(kit: Kit, reason: string): Promise<void> {
  for (const session of Object.values(kit.active)) {
    try {
      await kit.acts.stopSession({
        ...kit.scope,
        runId: session.runId,
        ...(session.sessionId ? { sessionId: session.sessionId } : {}),
        ...(session.handle ? { handle: session.handle } : {}),
        mode: 'kill',
        reason,
      });
    } catch (error) {
      log.warn('收尾时停会话失败', { runId: session.runId, error: String(error) });
    }
  }
  kit.active = {};
}

const OUTCOME: Record<SessionEnd['outcome'], RunOutcome> = {
  done: 'ok',
  blocked: 'ok',
  failed: 'failed',
  stalled: 'stalled',
  stopped: 'stopped',
};

/** 一次会话结束：记结局和这一次的用量。尽力而为，记不上不挡流程。 */
async function recordSessionEnd(
  kit: Kit,
  stage: StageKind,
  routeId: string,
  runId: string,
  end: SessionEnd,
): Promise<void> {
  const cost = costOfRun(end.sessionId ? kit.costSeen[end.sessionId] : undefined, end.sessionCostUsd);
  if (end.sessionId) kit.costSeen = { ...kit.costSeen, [end.sessionId]: end.sessionCostUsd ?? null };
  const usage: Usage = { ...end.usage, ...(cost === undefined ? {} : { costUsd: cost }) };
  try {
    await CancellationScope.nonCancellable(() =>
      kit.acts.recordTiming({
        kind: 'session',
        workflowId: workflowInfo().workflowId,
        ...kit.scope,
        runId,
        sessionId: end.sessionId,
        stage,
        routeId,
        outcome: OUTCOME[end.outcome],
        endedAt: iso(Date.now()),
        usage,
        ...(end.sessionCostUsd === undefined ? {} : { sessionCostUsd: end.sessionCostUsd }),
        ...(end.failure?.code ? { failureCode: end.failure.code } : {}),
      }),
    );
  } catch (error) {
    log.warn('会话结局没记上', { runId, error: String(error) });
  }
}

/**
 * 跑一个阶段：选路由 → 起会话（能续就续）→ 等它结束。
 * 暂停、换路由：停在干净的点再按新设置接着干；会话要人回答：问了再续；
 * 失败：按失败分流（failure/classify.ts 的规则表；认不出的走兜底梯：有界重试 → 换路由 → 换模型 → 挂起并报警），
 * 不默认停下等人。会话断了接着干（design 第一节）：重试、等完额度、暂停后继续、人修好机器点「继续」，都续同一个会话、
 * 同一条路由（stick）；换路由、换模型才照常选，跨了会话用户的接续（fork 续 / 接力任务书）由会话端口定。
 */
export async function runStage<K extends OutputKind>(
  kit: Kit,
  request: StageRequest<K>,
): Promise<StageResult<K>> {
  const source = `session:${request.stage}`;
  let counters = NO_LADDER;
  let avoid = AVOID_NOTHING;
  let stick: string | undefined;
  let previousMessage: string | undefined;
  const answers = [...request.brief.answers];
  let resumeSessionId = request.resumeSessionId;
  for (;;) {
    await gate(kit);
    const queuedAt = iso(Date.now());
    const picked = await chooseRoute(kit, request.stage, avoid, stick);
    if ('none' in picked) {
      await park(kit, `「${request.stage}」没有能用的路由`, picked.none);
      counters = NO_LADDER;
      avoid = AVOID_NOTHING;
      stick = undefined;
      continue;
    }
    kit.view.route = { routeId: picked.route.routeId, modelId: picked.route.modelId, why: picked.why };
    // 每次起会话一个新编号：库里 session_runs 一行、fleet 通行证一张、scope 名。
    const runId = await newId(kit);
    kit.view.runId = runId;
    // 先登记再起：起会话还没返回时叫停，收尾照样按 runId 把它停掉（端口按 runId 幂等，停过的 runId 不再起）。
    kit.active = {
      ...kit.active,
      [runId]: { runId, ...(resumeSessionId ? { sessionId: resumeSessionId } : {}) },
    };
    kit.onChange();

    let end: SessionEnd;
    let stoppedByUs = false;
    let sessionId = resumeSessionId ?? '';
    try {
      const started = await kit.acts.startSession({
        ...kit.scope,
        runId,
        stage: request.stage,
        route: picked.route,
        whyRoute: picked.why,
        queuedAt,
        brief: { ...request.brief, answers },
        stallSeconds: kit.limits.stallSeconds,
        sessionMinutes: kit.limits.sessionMinutes,
        resources: {
          memoryHighMb: kit.limits.sessionMemoryHighMb,
          memoryMaxMb: kit.limits.sessionMemoryMaxMb,
          swapMaxMb: 0,
        },
        ...(request.worktreePath ? { worktreePath: request.worktreePath } : {}),
        ...(request.baseHead ? { baseHead: request.baseHead } : {}),
        ...(resumeSessionId ? { resumeSessionId } : {}),
      });
      sessionId = started.sessionId;
      const session: RunningSession = {
        runId,
        sessionId,
        ...(started.handle ? { handle: started.handle } : {}),
      };
      kit.active = { ...kit.active, [runId]: session };
      kit.view.sessionId = sessionId;
      kit.onChange();
      const watched = await watchSession(kit, request.stage, session);
      end = watched.end;
      stoppedByUs = watched.stoppedByUs;
    } catch (error) {
      if (isCancellation(error)) throw error;
      const f = failureOf(error, source);
      end = {
        sessionId,
        outcome: 'failed',
        failure: {
          code: f.code,
          message: f.message,
          ...(f.retryable === null ? {} : { retryable: f.retryable }),
        },
      };
    }
    const { [runId]: _ended, ...stillActive } = kit.active;
    kit.active = stillActive;
    kit.view.sessionId = null;
    kit.view.runId = null;
    await recordSessionEnd(kit, request.stage, picked.route.routeId, runId, end);
    if (end.sessionId) resumeSessionId = end.sessionId;

    if (end.outcome === 'done' && end.output?.kind === request.expect) {
      return { sessionId: end.sessionId, runId, output: end.output as OutputOf<K>, route: picked.route };
    }
    if (end.outcome === 'stopped' && stoppedByUs) {
      // 暂停后继续：续同一个会话；换路由的命令由点名的路由压过（chooseRoute 里）。
      stick = picked.route.routeId;
      continue;
    }
    if (end.outcome === 'blocked') {
      const question = end.blocked?.question ?? end.blocked?.reason ?? '会话说需要人回答';
      const answer = await askAndWait(kit, question, end.blocked?.options, runId);
      answers.push({ question, answer });
      stick = picked.route.routeId;
      continue;
    }

    const failure: FailureInfo =
      end.outcome === 'stalled'
        ? {
            source,
            code: 'SESSION_STALLED',
            message: end.failure?.message ?? '会话没动静了',
            retryable: true,
          }
        : end.outcome === 'stopped'
          ? { source, code: 'SESSION_STOPPED', message: '会话被外面停掉了', retryable: true }
          : end.outcome === 'done'
            ? {
                source,
                code: 'WRONG_OUTPUT',
                message: `要的是 ${request.expect}，交回来的是 ${end.output?.kind ?? '空'}`,
                retryable: true,
              }
            : {
                source,
                code: end.failure?.code ?? 'SESSION_FAILED',
                message: end.failure?.message ?? '',
                retryable: end.failure?.retryable ?? null,
              };
    const next = await judge(kit, 'failure', {
      failure,
      counters,
      limits: kit.limits,
      routeBound: true,
      context: failureContext(request.stage, picked.route, end, previousMessage),
    });
    previousMessage = failure.message;
    kit.view.lastProblem = next.reason;
    kit.onChange();
    await alertIfNeeded(kit, next, failure.message);
    counters = bump(counters, next);
    if (next.action === 'retry') {
      await waitFor(kit, waitKindOf(next), next.reason, () =>
        retryPause(kit, request.stage, next.delaySeconds),
      );
      stick = resumesSame(next) ? picked.route.routeId : undefined;
    } else if (next.action === 'swapRoute') {
      // 账号池的事（封号、额度用满）避开整个池：换到同一个池的别的路由照样撞。
      avoid =
        next.avoid === 'pool'
          ? { ...avoid, poolIds: [...avoid.poolIds, picked.route.poolId] }
          : { ...avoid, routeIds: [...avoid.routeIds, picked.route.routeId] };
      stick = undefined;
    } else if (next.action === 'swapModel') {
      avoid = { ...avoid, modelIds: [...avoid.modelIds, picked.route.modelId] };
      stick = undefined;
    } else {
      await park(kit, parkTitle(next), failure.message);
      counters = NO_LADDER;
      avoid = AVOID_NOTHING;
      previousMessage = undefined;
      // 修的是机器或账号池（例如设备被撤销、人重新登录了）：人点「继续」后续同一个会话。
      stick = resumesSame(next) ? picked.route.routeId : undefined;
    }
  }
}

/**
 * 会话这一步原地再试之前等的那一觉：到点，或人改了这一阶段的路由、点了暂停、叫停了就醒——等额度清零可能要睡
 * 好几个小时，人这时候换了路由不该还干等到点（醒了回到 runStage 开头：暂停门、按新路由选）。
 * 接这道改法之前起的执行，重放时照老样子整觉睡完。
 */
async function retryPause(kit: Kit, stage: StageKind, seconds: number): Promise<void> {
  if (!patched('retry-wait-wakes')) {
    await sleep(`${seconds} seconds`);
    return;
  }
  const routeAtStart = kit.control.routeOverrides[stage];
  await condition(
    () =>
      kit.control.paused || kit.control.stopRequested || kit.control.routeOverrides[stage] !== routeAtStart,
    `${seconds} seconds`,
  );
}

/** 失败分流要的这一步的事实：哪个阶段、哪条路由（主池还是备池）、上游给的等待、会话跑在哪。 */
function failureContext(
  stage: StageKind,
  route: RouteChoice,
  end: SessionEnd,
  previousMessage: string | undefined,
): FailureContext {
  const f = end.failure;
  return {
    stage,
    route: {
      routeId: route.routeId,
      poolId: route.poolId,
      modelId: route.modelId,
      hostId: route.hostId,
      ...(route.poolRole ? { poolRole: route.poolRole } : {}),
    },
    ...(f?.resetsAt ? { resetsAt: f.resetsAt } : {}),
    ...(f?.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: f.retryAfterSeconds }),
    ...(f?.httpStatus === undefined ? {} : { httpStatus: f.httpStatus }),
    ...(f?.exitCode === undefined ? {} : { exitCode: f.exitCode }),
    ...(f?.signal === undefined ? {} : { signal: f.signal }),
    ...(f?.transcriptTail?.length ? { transcriptTail: f.transcriptTail } : {}),
    ...(f?.machine ? { machine: f.machine } : {}),
    ...(f?.runAsUser ? { runAsUser: f.runAsUser } : {}),
    ...(previousMessage ? { previousMessage } : {}),
    now: iso(Date.now()),
  };
}
