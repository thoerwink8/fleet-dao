// 三条工作流共用的零件：活动代理、判断入口、命令受理、暂停门、等待记账、挂起报警、跑一个阶段的会话（含兜底梯）。
// 这里是工作流代码，会被重放：改调度顺序（多调、少调、换顺序调活动）要用 patched()，见 test/replay.test.ts。

import type { RunOutcome, StageKind } from '@fleet-dao/shared';
import {
  ActivityFailure,
  ApplicationFailure,
  CancellationScope,
  ChildWorkflowFailure,
  condition,
  isCancellation,
  log,
  proxyActivities,
  proxyLocalActivities,
  setDefaultSignalHandler,
  setHandler,
  sleep,
  TemporalFailure,
  TimeoutFailure,
  uuid4,
  workflowInfo,
} from '@temporalio/workflow';
import {
  ACTIVITY_PROFILE,
  type ActivityName,
  type EngineActivities,
  type Profile,
  profileOptions,
} from '../activity-options.ts';
import {
  type AgentEventCommand,
  type AgentEventSeen,
  type AnswerCommand,
  agentEventSignal,
  answerSignal,
  type CommandMeta,
  type CommandReceipt,
  pauseSignal,
  type RerouteCommand,
  type RouteOverrides,
  rerouteSignal,
  resumeSignal,
  stopSignal,
  type Waiting,
} from '../contract.ts';
import type { FailureInfo, LadderCounters } from '../decisions/failure.ts';
import type { Decide } from '../decisions/index.ts';
import type { Limits } from '../limits.ts';
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

/** 流程判断：本地活动，结果进历史，重放时不重算。 */
export const { decide } = proxyLocalActivities<{ decide: Decide }>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 3, initialInterval: '1 second' },
});

/** 按 ACTIVITY_PROFILE 给每个活动配上自己那一档的超时与重试。 */
export function activitiesFor(limits: Limits): EngineActivities {
  const proxies = new Map<Profile, EngineActivities>();
  const out: Partial<Record<ActivityName, unknown>> = {};
  for (const name of Object.keys(ACTIVITY_PROFILE) as ActivityName[]) {
    const profile = ACTIVITY_PROFILE[name];
    let proxy = proxies.get(profile);
    if (!proxy) {
      proxy = proxyActivities<EngineActivities>(profileOptions(profile, limits));
      proxies.set(profile, proxy);
    }
    out[name] = proxy[name];
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

export interface ControlHooks {
  onStop(): void;
  /** 不带阶段的「换路由」落在哪几个阶段上。 */
  mainStages: readonly StageKind[];
  /** 子任务自己的 subtasks.id；「换路由」点名别的子任务时不在自己这层生效。 */
  selfSubtaskId?: string;
  /** 需求把命令转给在跑的子任务；返回转了几个。 */
  forwardPause?(meta: CommandMeta | undefined): number;
  forwardResume?(meta: CommandMeta | undefined): number;
  forwardReroute?(command: RerouteCommand): number;
  forwardAnswer?(command: AnswerCommand): boolean;
  forwardAgentEvent?(command: AgentEventCommand): boolean;
}

const RECEIPTS_KEPT = 20;

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
    receipt('pause', true, '暂停：会话停在干净的点，不再开新步骤', meta);
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
  // fleet 命令每说一句就来一次，不进回执，只记最近一次、叫醒主循环。
  setHandler(agentEventSignal, (event) => {
    if (!event?.runId) return;
    if (hooks.forwardAgentEvent?.(event)) return;
    control.lastAgentEvent = {
      runId: event.runId,
      kind: event.kind,
      ...(event.askId ? { askId: event.askId } : {}),
      at: iso(Date.now()),
    };
    control.version += 1;
  });
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

/** 正在跑的会话：收尾时停它、工人重启后按 handle 找回它。 */
export interface ActiveSession {
  runId: string;
  sessionId: string;
  handle?: SessionHandle;
}

export interface Kit {
  acts: EngineActivities;
  limits: Limits;
  control: Control;
  scope: Scope;
  view: View;
  /** 看得见的状态变了（子任务用它通知需求）。 */
  onChange(): void;
  parkCount: number;
  /** 正在跑的会话（同一时刻可能有写码和第二意见两个）。 */
  active: Record<string, ActiveSession>;
  /** 每个会话（sessionId）上一轮报的累计花费；null = 上一轮没读到。这一次的花费按它求差。 */
  costSeen: Record<string, number | null>;
}

export function newKit(fields: Omit<Kit, 'parkCount' | 'active' | 'costSeen'>): Kit {
  return { ...fields, parkCount: 0, active: {}, costSeen: {} };
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

/** 标明在等什么、等完记一笔等待时长。 */
export async function waitFor<T>(
  kit: Kit,
  kind: WaitKind,
  detail: string,
  fn: () => Promise<T>,
  extra: { on?: string[]; askId?: string } = {},
): Promise<T> {
  const since = Date.now();
  kit.view.waiting = { kind, detail, since: iso(since), ...extra };
  kit.onChange();
  try {
    return await fn();
  } finally {
    kit.view.waiting = null;
    kit.onChange();
    const ended = Date.now();
    if (ended > since) await recordWait(kit, kind, detail, since, ended);
  }
}

/** 暂停门：暂停着就在这里等「继续」。每一步开工前过一次。 */
export async function gate(kit: Kit): Promise<void> {
  if (!kit.control.paused) return;
  await waitFor(kit, 'human', '已暂停，等「继续」', () => condition(() => !kit.control.paused));
}

/** 挂起并报警：兜底梯的最后一级。等「继续」或「换路由」。 */
export async function park(kit: Kit, title: string, detail: string): Promise<void> {
  kit.control.parked = true;
  kit.parkCount += 1;
  kit.view.lastProblem = title;
  try {
    await kit.acts.raiseAlert({
      ...kit.scope,
      level: 'stuck',
      title,
      detail,
      dedupeKey: `${workflowInfo().workflowId}:park:${kit.parkCount}`,
    });
  } catch (error) {
    if (isCancellation(error)) throw error;
    log.warn('报警没发出去，照样挂起等人', { title, error: String(error) });
  }
  await waitFor(kit, 'human', `挂起：${title}（等「继续」或「换路由」）`, () =>
    condition(() => !kit.control.parked),
  );
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

const NO_LADDER: LadderCounters = { retries: 0, routeSwaps: 0, modelSwaps: 0 };

/** 不绑路由的一步（建树、推分支、等 CI……）：活动自己的重试用完后按兜底梯走——有界重试，再不行挂起报警。 */
export async function attempt<T>(kit: Kit, source: string, fn: () => Promise<T>): Promise<T> {
  let counters = NO_LADDER;
  for (;;) {
    await gate(kit);
    try {
      return await fn();
    } catch (error) {
      if (isCancellation(error)) throw error;
      const failure = failureOf(error, source);
      const next = await decide('failure', { failure, counters, limits: kit.limits, routeBound: false });
      kit.view.lastProblem = next.reason;
      kit.onChange();
      if (next.action === 'retry') {
        counters = { ...counters, retries: counters.retries + 1 };
        await waitFor(kit, 'retry', next.reason, () => sleep(`${next.delaySeconds} seconds`));
      } else {
        await park(kit, next.reason, failure.message);
        counters = NO_LADDER;
      }
    }
  }
}

/** 问创始人一句，等回答。 */
export async function askAndWait(
  kit: Kit,
  question: string,
  options?: string[],
  runId?: string,
): Promise<string> {
  const { askId } = await attempt(kit, 'askHuman', () =>
    kit.acts.askHuman({
      ...kit.scope,
      question,
      ...(options && options.length > 0 ? { options } : {}),
      ...(runId ? { runId } : {}),
    }),
  );
  kit.control.pendingAsks = [...kit.control.pendingAsks, askId];
  try {
    await waitFor(kit, 'human', `等回答：${question}`, () => condition(() => askId in kit.control.answers), {
      askId,
    });
    return kit.control.answers[askId]?.answer ?? '';
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

/** 选路由；没空位、没额度就等（记下在等哪个），一条能用的都没有就交回去挂起。 */
async function chooseRoute(
  kit: Kit,
  stage: StageKind,
  avoidRouteIds: string[],
  avoidModelIds: string[],
): Promise<Picked> {
  let since: number | null = null;
  let kind: WaitKind = 'slot';
  let detail = '';
  try {
    for (;;) {
      const preferRouteId = kit.control.routeOverrides[stage];
      const result = await attempt(kit, 'pickRoute', () =>
        kit.acts.pickRoute({
          ...kit.scope,
          stage,
          avoidRouteIds,
          avoidModelIds,
          ...(preferRouteId ? { preferRouteId } : {}),
        }),
      );
      if (result.ok) return { route: result.route, why: result.why };
      if (result.waitFor === 'none') return { none: result.detail };
      if (since === null) since = Date.now();
      kind = result.waitFor;
      detail = result.detail;
      kit.view.waiting = { kind, detail, since: iso(since) };
      kit.onChange();
      await sleep(`${result.retryAfterSeconds ?? kit.limits.routePollSeconds} seconds`);
      await gate(kit);
    }
  } finally {
    if (since !== null) {
      kit.view.waiting = null;
      kit.onChange();
      await recordWait(kit, kind, detail, since, Date.now());
    }
  }
}

/** 等会话结束；中途要暂停或换路由，就请它停在干净的点（做完的先提交）。 */
async function watchSession(
  kit: Kit,
  stage: StageKind,
  session: ActiveSession,
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

/** 收尾（叫停、失败）：把还在跑的会话都停掉。停不掉只记一笔，交给对账。 */
export async function stopActiveSessions(kit: Kit, reason: string): Promise<void> {
  for (const session of Object.values(kit.active)) {
    try {
      await kit.acts.stopSession({
        ...kit.scope,
        runId: session.runId,
        sessionId: session.sessionId,
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
 * 失败：按兜底梯（有界重试 → 换路由 → 换模型 → 挂起并报警），不默认停下等人。
 */
export async function runStage<K extends OutputKind>(
  kit: Kit,
  request: StageRequest<K>,
): Promise<StageResult<K>> {
  const source = `session:${request.stage}`;
  let counters = NO_LADDER;
  let avoidRouteIds: string[] = [];
  let avoidModelIds: string[] = [];
  const answers = [...request.brief.answers];
  let resumeSessionId = request.resumeSessionId;
  for (;;) {
    await gate(kit);
    const queuedAt = iso(Date.now());
    const picked = await chooseRoute(kit, request.stage, avoidRouteIds, avoidModelIds);
    if ('none' in picked) {
      await park(kit, `「${request.stage}」没有能用的路由`, picked.none);
      counters = NO_LADDER;
      avoidRouteIds = [];
      avoidModelIds = [];
      continue;
    }
    kit.view.route = { routeId: picked.route.routeId, modelId: picked.route.modelId, why: picked.why };
    // 每次起会话一个新编号：库里 session_runs 一行、fleet 通行证一张。uuid4 在重放时给出同一个值。
    const runId = uuid4();
    kit.view.runId = runId;
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
      const session: ActiveSession = {
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
    if (end.outcome === 'stopped' && stoppedByUs) continue;
    if (end.outcome === 'blocked') {
      const question = end.blocked?.question ?? end.blocked?.reason ?? '会话说需要人回答';
      const answer = await askAndWait(kit, question, end.blocked?.options, runId);
      answers.push({ question, answer });
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
    const next = await decide('failure', { failure, counters, limits: kit.limits, routeBound: true });
    kit.view.lastProblem = next.reason;
    kit.onChange();
    if (next.action === 'retry') {
      counters = { ...counters, retries: counters.retries + 1 };
      await waitFor(kit, 'retry', next.reason, () => sleep(`${next.delaySeconds} seconds`));
    } else if (next.action === 'swapRoute') {
      counters = { ...counters, routeSwaps: counters.routeSwaps + 1 };
      avoidRouteIds = [...avoidRouteIds, picked.route.routeId];
    } else if (next.action === 'swapModel') {
      counters = { ...counters, modelSwaps: counters.modelSwaps + 1 };
      avoidModelIds = [...avoidModelIds, picked.route.modelId];
    } else {
      await park(kit, next.reason, failure.message);
      counters = NO_LADDER;
      avoidRouteIds = [];
      avoidModelIds = [];
    }
  }
}
