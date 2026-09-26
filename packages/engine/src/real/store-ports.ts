// 引擎端口 → 库（packages/db）：选路、提问、人闸、报警、计时、任务快照。
// 选路：调度台的顺序和候选事实（routeFactsForStage）+ 熔断（近 7 天的会话结局现算，failure/breaker.ts）+ 这个阶段的战绩
// + 被暂停的账号池（pool-hold:<池> 那条没处理的「要人拍」提醒，见 sessions.ts）交给纯函数 chooseRoute，三种结果原样换成
// 端口的三种。点名的路由先试，用不了照常选并写明；续同一个会话的路由暂时派不了就等它，用不了（下线、被禁）才照常选；
// 账号池暂停着时，续会话的那一单照样放过去——它就是看人修好了没有的试探。
// 失败一律明确：库没查成照常抛，事实对不上（RoutingInputError）抛 ROUTING_INPUT，不当成「没有路由」。

import {
  type Db,
  finishSessionRun,
  openAlertsByPrefix,
  openApproval,
  openEngineAsk,
  openSessionRuns,
  recordStepTiming,
  routeFactsForStage,
  routeOutcomesSince,
  saveTaskSnapshot,
  upsertAlert,
} from '@fleet-dao/db';
import type { HostId, OrgKind, StageKind } from '@fleet-dao/shared';
import { routeBreaker } from '../failure/breaker.ts';
import { type EnginePorts, type PickRouteResult, PortError, type RouteChoice } from '../ports.ts';
import {
  type BreakerFacts,
  type ChooseRouteInput,
  type ChooseRouteResult,
  chooseRoute,
  type RouteFacts,
  type RouteRecord,
  RoutingInputError,
  type RoutingPolicy,
  routeLabel,
} from '../routing/index.ts';

/** 账号池整池暂停（设备被撤销、封号、登录失效、欠费：要人修）的提醒：dedupe_key = pool-hold:<池>。 */
export const POOL_HOLD_PREFIX = 'pool-hold:';
export const poolHoldKey = (poolId: string) => `${POOL_HOLD_PREFIX}${poolId}`;

/** 目前接上的执行方式：只有 Claude Code（经 reclaude）。别的执行方式的路由不派，派不出时理由里写明。 */
export const WIRED_HOSTS: readonly HostId[] = ['claude-code'];

/**
 * 会话用户此刻挂的 reclaude 组织（design 第九节）。切号（拼车用满切独享、到点切回）归 #59，还没做：在那之前会话用户
 * 一直挂拼车，独享池的路由按 org-not-live 挡着不派。#59 接上之后改成读真实状态，不再是常量。
 */
export const SESSION_USER_ORG: OrgKind = 'carpool';

/** 战绩和熔断看最近几天的会话结局。 */
export const RECORD_DAYS = 7;
/** 选路要等时，最多隔这么久再选一次（等额度清零可能要几天：中途人点名换路由、额度提前清零要看得见）。 */
export const MAX_ROUTE_WAIT_SECONDS = 600;

const DAY_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StorePortsDeps {
  db: Db;
  now?: () => Date;
  /** [0, 1) 的随机数，试探用（调度策略开了试探才用得上）。 */
  draw?: () => number;
  wiredHosts?: readonly HostId[];
  routingPolicy?: Partial<RoutingPolicy>;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

type StorePorts = Pick<
  EnginePorts,
  'pickRoute' | 'askHuman' | 'requestApproval' | 'raiseAlert' | 'recordTiming' | 'saveTaskState'
>;

/** 给人看的池名：从渠道名拼，独享、拼车按池的组织类型分（两个 Claude 池是同一个会话用户）；不带账号、组织编号。 */
export function poolNameOf(channelName: string, orgKind: OrgKind | null): string {
  if (orgKind === 'solo') return `${channelName} · 独享`;
  if (orgKind === 'carpool') return `${channelName} · 拼车`;
  return channelName;
}

type Outcome = Awaited<ReturnType<typeof routeOutcomesSince>>[number];

function breakerOf(outcomes: readonly Outcome[], now: Date, inFlight: number, routeId: string): BreakerFacts {
  const state = routeBreaker(
    outcomes.map((o) => ({ at: o.endedAt.toISOString(), result: o.routeOutcome ?? 'neutral' })),
    { now: now.toISOString(), inFlight, routeId },
  );
  return {
    state: state.state,
    admit: state.admit,
    reason: state.reason,
    ...(state.probeAt ? { probeAt: state.probeAt } : {}),
  };
}

/** 这条路由在这个阶段上的战绩：只数算路由账的（ok、fail），neutral 和没记的不算。一条都没有 = 没跑过（null）。 */
function recordOf(outcomes: readonly Outcome[], stage: StageKind): RouteRecord | null {
  let samples = 0;
  let successes = 0;
  for (const o of outcomes) {
    if (o.stage !== stage || (o.routeOutcome !== 'ok' && o.routeOutcome !== 'fail')) continue;
    samples += 1;
    if (o.routeOutcome === 'ok') successes += 1;
  }
  return samples === 0 ? null : { samples, successes };
}

interface StageFacts {
  configured: boolean;
  stagePinned: boolean;
  order: ChooseRouteInput['order'];
  routes: RouteFacts[];
  /** 执行方式还没接上、这次不算的路由（给人看的名字）。 */
  unwired: string[];
  unwiredIds: Set<string>;
}

function choose(input: ChooseRouteInput): ChooseRouteResult {
  try {
    return chooseRoute(input);
  } catch (error) {
    if (error instanceof RoutingInputError) {
      throw new PortError('ROUTING_INPUT', `选路没查成：${error.message}`, { retryable: true });
    }
    throw error;
  }
}

export function createStorePorts(deps: StorePortsDeps): StorePorts {
  const { db } = deps;
  const clock = deps.now ?? (() => new Date());
  const draw = deps.draw ?? Math.random;
  const wired = deps.wiredHosts ?? WIRED_HOSTS;
  const log = deps.log ?? ((message, fields) => console.warn(message, fields ?? {}));

  async function loadStage(stage: StageKind, now: Date): Promise<StageFacts> {
    const [facts, outcomes, open] = await Promise.all([
      routeFactsForStage(db, stage, { now }),
      routeOutcomesSince(db, new Date(now.getTime() - RECORD_DAYS * DAY_MS)),
      openSessionRuns(db),
    ]);
    const byRoute = new Map<string, Outcome[]>();
    for (const o of [...outcomes].sort((a, b) => a.endedAt.getTime() - b.endedAt.getTime())) {
      const list = byRoute.get(o.routeId) ?? [];
      list.push(o);
      byRoute.set(o.routeId, list);
    }
    // 熔断半开时在途的那一个就是试探：按路由数已经开工、还没结束的会话。
    const running = new Map<string, number>();
    for (const r of open) if (r.startedAt) running.set(r.routeId, (running.get(r.routeId) ?? 0) + 1);

    const all: RouteFacts[] = facts.routes.map((r) => ({
      routeId: r.routeId,
      channelId: r.channelId,
      poolId: r.poolId,
      poolName: poolNameOf(r.channelName, r.poolOrgKind),
      // 两个 Claude 池合成一个会话用户后不再同时跑，没有备池了（routing/types.ts 的 PoolRole）。
      poolRole: 'primary',
      orgKind: r.poolOrgKind,
      modelId: r.modelId,
      modelName: r.modelName,
      family: r.family,
      hostId: r.hostId,
      upstreamModel: r.upstreamModel,
      upstreamAliases: r.upstreamAliases,
      quota: r.quota,
      windows: r.windows.map((w) => ({
        label: w.label,
        window: w.window,
        scope: w.scope,
        state: w.state,
        applies: w.applies,
        used: w.used,
        resetsAt: w.resetsAt?.toISOString() ?? null,
        reading: w.reading,
        readAt: w.readAt.toISOString(),
        staleSince: w.staleSince?.toISOString() ?? null,
      })),
      inFlight: r.inFlight,
      reserved: r.reserved,
      maxConcurrency: r.maxConcurrency,
      banReasons: r.banReasons,
      blockers: r.blockers,
      breaker: breakerOf(byRoute.get(r.routeId) ?? [], now, running.get(r.routeId) ?? 0, r.routeId),
      record: recordOf(byRoute.get(r.routeId) ?? [], stage),
    }));
    const unwiredRoutes = all.filter((r) => !wired.includes(r.hostId));
    const unwiredIds = new Set(unwiredRoutes.map((r) => r.routeId));
    return {
      configured: facts.configured,
      stagePinned: facts.stagePinned,
      // 单条钉住调度台上还没有（只有整个阶段钉住）：这里一律 false，阶段钉住由 stagePinned 带进去。
      order: facts.order
        .filter((e) => !unwiredIds.has(e.routeId))
        .map((e) => ({ routeId: e.routeId, position: e.position, enabled: e.enabled, pinned: false })),
      routes: all.filter((r) => !unwiredIds.has(r.routeId)),
      unwired: unwiredRoutes.map((r) => routeLabel(r)),
      unwiredIds,
    };
  }

  async function heldPools(): Promise<Set<string>> {
    const alerts = await openAlertsByPrefix(db, POOL_HOLD_PREFIX);
    return new Set(alerts.map((a) => a.dedupeKey.slice(POOL_HOLD_PREFIX.length)).filter(Boolean));
  }

  async function allOpenAlarm(stage: StageKind, taskId: string, alarm: string): Promise<void> {
    try {
      await upsertAlert(db, {
        dedupeKey: `routing:all-open:${stage}`,
        level: 'alert',
        taskId: UUID.test(taskId) ? taskId : null,
        title: `「${stage}」阶段的路由全都熔断了`,
        body: alarm,
      });
    } catch (error) {
      log('选路报警没写进库（照样派出去）', { stage, error: String(error) });
    }
  }

  return {
    async pickRoute(input): Promise<PickRouteResult> {
      const now = clock();
      const facts = await loadStage(input.stage, now);
      const held = await heldPools();
      const known = (id: string) => facts.routes.find((r) => r.routeId === id);
      const avoid = (exceptPool?: string) => ({
        routeIds: input.avoidRouteIds,
        poolIds: [...new Set([...input.avoidPoolIds, ...[...held].filter((p) => p !== exceptPool)])],
        modelIds: input.avoidModelIds,
      });
      const base = {
        stage: input.stage,
        configured: facts.configured,
        stagePinned: facts.stagePinned,
        order: facts.order,
        routes: facts.routes,
        now: now.toISOString(),
        draw: draw(),
        liveOrg: SESSION_USER_ORG,
        ...(deps.routingPolicy ? { policy: deps.routingPolicy } : {}),
      } satisfies Omit<ChooseRouteInput, 'avoid' | 'taskRouteId'>;
      const notes: string[] = [];
      const missing = (id: string, what: string) =>
        facts.unwiredIds.has(id)
          ? `${what} ${id} 的执行方式引擎还没接上，照常选`
          : `${what} ${id} 不在这个阶段的调度台顺序里，照常选`;

      const dispatched = async (r: Extract<ChooseRouteResult, { kind: 'dispatch' }>, why: string) => {
        const fact = known(r.routeId);
        if (!fact) throw new PortError('ROUTING_INPUT', `选路派给了事实里没有的路由 ${r.routeId}`);
        if (r.alarm) await allOpenAlarm(input.stage, input.taskId, r.alarm);
        const route: RouteChoice = {
          routeId: r.routeId,
          poolId: r.poolId,
          modelId: r.modelId,
          family: r.family,
          hostId: r.hostId,
          poolRole: fact.poolRole,
        };
        return { ok: true as const, route, why };
      };
      const waiting = (r: Extract<ChooseRouteResult, { kind: 'wait' }>, extra: string[]): PickRouteResult => {
        const until = r.until ? Date.parse(r.until) : Number.NaN;
        const retryAfterSeconds = Number.isFinite(until)
          ? Math.min(MAX_ROUTE_WAIT_SECONDS, Math.max(1, Math.ceil((until - now.getTime()) / 1000)))
          : undefined;
        return {
          ok: false,
          // 等熔断到点也是「等空位」一类：随时可能好，按间隔再选。
          waitFor: r.waitFor === 'quota' ? 'quota' : 'slot',
          detail: [r.reason, ...extra].join('；'),
          ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
        };
      };

      if (input.preferRouteId) {
        if (!known(input.preferRouteId)) notes.push(missing(input.preferRouteId, '点名的路由'));
        else {
          const r = choose({ ...base, taskRouteId: input.preferRouteId, avoid: avoid() });
          if (r.kind === 'dispatch') return dispatched(r, `点名的路由：${r.why}`);
          notes.push(`点名的路由这次用不了（${r.reason}），照常选`);
        }
      } else if (input.stickRouteId) {
        const stick = known(input.stickRouteId);
        if (!stick) notes.push(missing(input.stickRouteId, '续会话的路由'));
        else {
          const probing = held.has(stick.poolId);
          const r = choose({ ...base, taskRouteId: stick.routeId, avoid: avoid(stick.poolId) });
          if (r.kind === 'dispatch') {
            return dispatched(
              r,
              probing
                ? `续同一个会话；这个账号池暂停着（等人修），这一单就是看修好了没有：${r.why}`
                : `续同一个会话：${r.why}`,
            );
          }
          // 暂时派不了（空位、额度、熔断到点）就等它，不换：换了就续不上这个会话。
          if (r.kind === 'wait') return waiting(r, ['续同一个会话，等这条路由']);
          notes.push(`续会话的路由用不了了（${r.reason}），照常选`);
        }
      }

      const r = choose({ ...base, avoid: avoid() });
      if (r.kind === 'dispatch') return dispatched(r, [r.why, ...notes].join('；'));
      const context = [
        ...notes,
        ...(held.size > 0 ? [`暂停着、等人处理的账号池：${[...held].join('、')}`] : []),
        ...(facts.unwired.length > 0
          ? [`执行方式引擎还没接上、这次没算的：${facts.unwired.join('、')}`]
          : []),
      ];
      if (r.kind === 'wait') return waiting(r, context);
      return { ok: false, waitFor: 'none', detail: [r.reason, ...context].join('；') };
    },

    async askHuman(input) {
      await openEngineAsk(db, {
        id: input.askId,
        taskId: input.taskId,
        runId: input.runId ?? null,
        question: input.question,
        options: input.options ?? [],
      });
    },

    async requestApproval(input) {
      await openApproval(db, {
        id: input.approvalId,
        taskId: input.taskId,
        subtaskId: input.subtaskId ?? null,
        holds: input.holds,
        prNumber: input.prNumber,
        head: input.head,
        title: input.title,
        summary: input.summary,
      });
    },

    async raiseAlert(input) {
      // 引擎的 info 只在封号、事件数到线、全熔断这类要人知道的事上发，量很小：和「卡住了」一样进提醒中心。
      const { id } = await upsertAlert(db, {
        dedupeKey: input.dedupeKey,
        level: 'alert',
        // 合并队列这类不属于某个需求的报警 taskId 是空的：不挂任务。
        taskId: UUID.test(input.taskId) ? input.taskId : null,
        title: input.title.slice(0, 300),
        body: input.detail,
      });
      return { alertId: id };
    },

    async recordTiming(input) {
      if (input.kind === 'session') {
        // 会话看守（sessions.ts）已经把结局写进 session_runs：那边写过的不改（already_finished）。
        // 没起来的会话（起会话就失败了）只有这一笔，由它收尾。
        const r = await finishSessionRun(db, {
          id: input.runId,
          outcome: input.outcome,
          endedAt: new Date(input.endedAt),
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          ...(input.usage.inputTokens === undefined ? {} : { inputTokens: input.usage.inputTokens }),
          ...(input.usage.outputTokens === undefined ? {} : { outputTokens: input.usage.outputTokens }),
          ...(input.usage.costUsd === undefined ? {} : { costUsd: input.usage.costUsd }),
          ...(input.sessionCostUsd === undefined ? {} : { sessionCostUsd: input.sessionCostUsd }),
          ...(input.failureCode ? { failureCode: input.failureCode } : {}),
        });
        if (r === 'not_found') {
          throw new PortError('RUN_NOT_FOUND', `会话 ${input.runId} 在库里没有（起会话之前就失败了）`, {
            retryable: false,
          });
        }
        return;
      }
      const common = {
        workflowId: input.workflowId,
        temporalRunId: input.runId,
        workflowType: input.workflowType,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(input.subtaskId ? { subtaskId: input.subtaskId } : {}),
        ...(input.subtaskKey ? { subtaskKey: input.subtaskKey } : {}),
        startedAt: new Date(input.startedAt),
        endedAt: new Date(input.endedAt),
      };
      if (input.kind === 'activity') {
        await recordStepTiming(db, {
          kind: 'activity',
          ...common,
          activity: input.activity,
          attempt: input.attempt,
          scheduledAt: new Date(input.scheduledAt),
          queueMs: input.queueMs,
          runMs: input.runMs,
          outcome: input.outcome,
          ...(input.errorCode ? { errorCode: input.errorCode } : {}),
        });
        return;
      }
      await recordStepTiming(db, {
        kind: 'wait',
        ...common,
        waitFor: input.waitFor,
        detail: input.detail,
        waitMs: input.waitMs,
      });
    },

    async saveTaskState(input) {
      const r = await saveTaskSnapshot(db, {
        taskId: input.taskId,
        state: input.state,
        phase: input.phase,
        doing: input.doing,
        specDir: input.specDir,
        docs: input.docs,
        lastProblem: input.lastProblem,
        subtasks: input.subtasks,
      });
      if (r === 'task_not_found') {
        throw new PortError('TASK_NOT_FOUND', `任务 ${input.taskId} 在库里没有，写不了快照`, {
          retryable: false,
        });
      }
    },
  };
}
