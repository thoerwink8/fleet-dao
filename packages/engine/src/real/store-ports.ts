// 引擎端口 → 库（packages/db）：选路、提问、人闸、报警、计时、任务快照。
// 选路：调度台的顺序和候选事实（routeFactsForStage）+ 熔断（近 7 天的会话结局现算，failure/breaker.ts）+ 这个阶段的战绩
// + 被暂停的账号池（pool-hold:<池> 那条没处理的「要人拍」提醒，见 sessions.ts）交给纯函数 chooseRoute，三种结果原样换成
// 端口的三种。点名的路由先试，用不了照常选并写明；续同一个会话的路由暂时派不了就等它，用不了（下线、被禁）才照常选；
// 账号池暂停着时，续会话的那一单照样放过去——它就是看人修好了没有的试探。Fusion 带了流程配置里这一步的模型顺序（models）
// 就只派这几个模型的路由、先按配置的先后排（onlyModels），一条都没有明说；人点名的路由不受它限制。
// Claude 订阅池只派会话用户此刻真挂着的那个组织的（real/session-org.ts 现读 reclaude org list，不假定）；读不到、认不出，
// 带组织类型的池一律不派、写明原因，别的池照常派；还没读完（reclaude 首跑同步配置）就过一会儿再选。
// 失败一律明确：库没查成照常抛，事实对不上（RoutingInputError）抛 ROUTING_INPUT，不当成「没有路由」。

import type { TaskAsk } from '@fleet-dao/core';
import {
  authorFamiliesOfTask,
  type Db,
  finishSessionRun,
  listTaskAsks,
  markAsksApplied as markAsksAppliedInDb,
  openAlertsByPrefix,
  openApproval,
  openEngineAsk,
  openSessionRuns,
  recordStepTiming,
  routeFactsForStage,
  routeOutcomesSince,
  saveTaskSnapshot,
  saveVerifyRound,
  type TaskAskRow,
  taskContext,
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
  STAGE_NAMES,
} from '../routing/index.ts';
import { WIRED_HOSTS as WIRED_HOST_IDS } from './hosts.ts';
import type { SessionOrgReader } from './session-org.ts';

/** 账号池整池暂停（设备被撤销、封号、登录失效、欠费：要人修）的提醒：dedupe_key = pool-hold:<池>。 */
export const POOL_HOLD_PREFIX = 'pool-hold:';
export const poolHoldKey = (poolId: string) => `${POOL_HOLD_PREFIX}${poolId}`;

/**
 * 接上的执行方式（会话端口的驱动清单，real/hosts.ts）：Claude Code（经 reclaude）、cursor-agent。别的执行方式的路由不派，
 * 派不出时理由里写明。
 */
export const WIRED_HOSTS: readonly HostId[] = WIRED_HOST_IDS;

/** 战绩和熔断看最近几天的会话结局。 */
export const RECORD_DAYS = 7;
/** 选路要等时，最多隔这么久再选一次（等额度清零可能要几天：中途人点名换路由、额度提前清零要看得见）。 */
export const MAX_ROUTE_WAIT_SECONDS = 600;
/** 选路读会话用户挂的组织最多等多久：选路这一步（quick 一档）一次尝试只有 30 秒，还要查库。 */
export const ORG_READ_WAIT_MS = 15_000;
/** 组织还没读出来时隔多久再选：平时一读 0.3 秒，慢的是 reclaude 首跑同步配置（上百秒），读在后台接着跑。 */
export const ORG_READ_RETRY_SECONDS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StorePortsDeps {
  db: Db;
  /**
   * 会话用户此刻挂的 reclaude 组织（real/session-org.ts，design 第九节）：带组织类型的池（Claude 订阅）只派和它一样的。
   * 候选里有这种池才读；读不到、认不出，这些池一律不派（写明原因），不拿拼车顶；还没读完就过一会儿再选。
   */
  sessionOrg: SessionOrgReader;
  now?: () => Date;
  /** [0, 1) 的随机数，试探用（调度策略开了试探才用得上）。 */
  draw?: () => number;
  wiredHosts?: readonly HostId[];
  routingPolicy?: Partial<RoutingPolicy>;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  /** 选路读组织最多等多久（默认 ORG_READ_WAIT_MS），测试用。 */
  orgReadWaitMs?: number;
}

type StorePorts = Pick<
  EnginePorts,
  | 'pickRoute'
  | 'askHuman'
  | 'taskAsks'
  | 'markAsksApplied'
  | 'requestApproval'
  | 'raiseAlert'
  | 'recordTiming'
  | 'saveTaskState'
  | 'authorFamilies'
  | 'recordVerification'
  | 'flowConfig'
  | 'taskRequest'
>;

/** 库里的一条提问 → core 的 TaskAsk（存档点、PR 正文、关单记数、对账开单都按它判）：空的列不给，不拿空串、0 顶。 */
export function toTaskAsk(r: TaskAskRow): TaskAsk {
  return {
    id: r.id,
    question: r.question,
    options: r.options,
    applied: r.appliedAt !== null,
    ...(r.scope === null ? {} : { scope: r.scope }),
    ...(r.recommended === null ? {} : { recommended: r.recommended }),
    ...(r.hold === null ? {} : { hold: r.hold }),
    ...(r.answer === null ? {} : { answer: r.answer }),
    ...(r.followUpIssue === null ? {} : { followUpIssue: r.followUpIssue }),
  };
}

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

/**
 * 流程配置里这一步的模型顺序（0003 第 9 条）：只留这几个模型的路由，先按配置里的先后、同一个模型的照调度台的先后排，
 * 位置从 0 重新数（选路按位置排、也按它写「第几条」）。额度、战绩这些微调照常在它上面做（「再打分：配置顺序、战绩」）。
 */
function onlyModels(facts: StageFacts, models: readonly string[]): StageFacts {
  const rankOf = new Map<string, number>();
  for (const [i, m] of models.entries()) if (!rankOf.has(m)) rankOf.set(m, i);
  const routes = facts.routes.filter((r) => rankOf.has(r.modelId));
  const rankOfRoute = new Map(routes.map((r) => [r.routeId, rankOf.get(r.modelId) ?? 0] as const));
  const order = facts.order
    .filter((e) => rankOfRoute.has(e.routeId))
    .sort(
      (a, b) =>
        (rankOfRoute.get(a.routeId) ?? 0) - (rankOfRoute.get(b.routeId) ?? 0) || a.position - b.position,
    )
    .map((e, position) => ({ ...e, position }));
  return { ...facts, routes, order };
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
      orgKind: r.poolOrgKind,
      modelId: r.modelId,
      modelName: r.modelName,
      family: r.family,
      hostId: r.hostId,
      upstreamModel: r.upstreamModel,
      upstreamAliases: r.upstreamAliases,
      probedAt: r.probedAt?.toISOString() ?? null,
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
      const all = await loadStage(input.stage, now);
      // 流程配置里这一步的模型顺序（Fusion，0003 第 9 条）：只派这几个模型的路由。人点名的路由不受它限制（换路由是人的指令）
      const facts = input.models ? onlyModels(all, input.models) : all;
      const held = await heldPools();
      // 会话用户此刻挂的组织：候选里有带组织类型的池（Claude 订阅）才读。读不到、认不出的原话交给选路，那些池一律不派；
      // 还没读完（reclaude 首跑同步配置）、正在切号（real/org-switch.ts 让选路停下的那十几秒）不算认不出：过一会儿再选
      const live = all.routes.some((r) => r.orgKind)
        ? await deps.sessionOrg({ waitMs: deps.orgReadWaitMs ?? ORG_READ_WAIT_MS })
        : null;
      if (live && !live.ok && live.pending) {
        return {
          ok: false,
          waitFor: 'slot',
          detail: `会话用户挂的组织这会儿定不下来，过一会儿再选：${live.why}`,
          retryAfterSeconds: ORG_READ_RETRY_SECONDS,
        };
      }
      if (live && !live.ok) log('会话用户挂的组织认不出，Claude 订阅池这次不派', { why: live.why });
      const known = (id: string) => facts.routes.find((r) => r.routeId === id);
      const knownAny = (id: string) => all.routes.find((r) => r.routeId === id);
      // 开 PR 前验证只派别家：写这张单的族整族避开，点名的、续会话的也一样（一条都没有就明说没有别家可验，不拿同族顶）
      const families = (input.avoidFamilies ?? []).filter((f) => f.trim());
      const avoid = (exceptPool?: string) => ({
        routeIds: input.avoidRouteIds,
        poolIds: [...new Set([...input.avoidPoolIds, ...[...held].filter((p) => p !== exceptPool)])],
        modelIds: input.avoidModelIds,
        ...(families.length > 0 ? { families } : {}),
      });
      const base = {
        stage: input.stage,
        configured: facts.configured,
        stagePinned: facts.stagePinned,
        order: facts.order,
        routes: facts.routes,
        now: now.toISOString(),
        draw: draw(),
        ...(live?.ok ? { liveOrg: live.org } : {}),
        ...(live && !live.ok ? { liveOrgProblem: live.why } : {}),
        ...(input.uiWork ? { uiWork: true } : {}),
        ...(deps.routingPolicy ? { policy: deps.routingPolicy } : {}),
      } satisfies Omit<ChooseRouteInput, 'avoid' | 'taskRouteId'>;
      const notes: string[] = [];
      const missing = (id: string, what: string) =>
        all.unwiredIds.has(id)
          ? `${what} ${id} 的执行方式引擎还没接上，照常选`
          : knownAny(id)
            ? `${what} ${id} 的模型不在流程配置这一步的模型里，照常选`
            : `${what} ${id} 不在这个阶段的调度台顺序里，照常选`;

      const dispatched = async (r: Extract<ChooseRouteResult, { kind: 'dispatch' }>, why: string) => {
        const fact = knownAny(r.routeId);
        if (!fact) throw new PortError('ROUTING_INPUT', `选路派给了事实里没有的路由 ${r.routeId}`);
        if (r.alarm) await allOpenAlarm(input.stage, input.taskId, r.alarm);
        const route: RouteChoice = {
          routeId: r.routeId,
          poolId: r.poolId,
          modelId: r.modelId,
          family: r.family,
          hostId: r.hostId,
          ...(fact.orgKind ? { orgKind: fact.orgKind } : {}),
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
        if (!knownAny(input.preferRouteId)) notes.push(missing(input.preferRouteId, '点名的路由'));
        else {
          const r = choose({
            ...base,
            order: all.order,
            routes: all.routes,
            taskRouteId: input.preferRouteId,
            avoid: avoid(),
          });
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

      const context = [
        ...notes,
        ...(held.size > 0 ? [`暂停着、等人处理的账号池：${[...held].join('、')}`] : []),
        ...(facts.unwired.length > 0
          ? [`执行方式引擎还没接上、这次没算的：${facts.unwired.join('、')}`]
          : []),
      ];
      const noOther =
        families.length > 0
          ? [`没有别家可验：写这张单的是 ${families.join('、')} 族，这一步只派别家，不拿同族顶`]
          : [];
      // 调度台排了这个阶段、可流程配置里这一步的模型一条路由都没有：明说，不当成「这个阶段一条都没配」
      if (input.models && facts.configured && facts.order.length === 0) {
        const models = input.models.length > 0 ? input.models.join('、') : '一个都没配';
        const reason = `流程配置里这一步的模型（${models}）在${STAGE_NAMES[input.stage]}阶段的调度台上没有接上的路由`;
        return { ok: false, waitFor: 'none', detail: [...noOther, reason, ...context].join('；') };
      }
      const r = choose({ ...base, avoid: avoid() });
      if (r.kind === 'dispatch') return dispatched(r, [r.why, ...notes].join('；'));
      if (r.kind === 'wait') return waiting(r, context);
      return { ok: false, waitFor: 'none', detail: [...noOther, r.reason, ...context].join('；') };
    },

    async authorFamilies(input) {
      // 写这张单的会话用过的族：判验证是不是别家就靠它。一个都查不到不回空的（空的等于谁都能验）
      const families = UUID.test(input.taskId) ? await authorFamiliesOfTask(db, input.taskId) : [];
      if (families.length === 0) {
        throw new PortError(
          'AUTHORS_UNKNOWN',
          `任务 ${input.taskId} 一个起过的会话都查不到：不知道写它的是哪一族，判不了验证模型是不是别家，不验`,
          { retryable: false },
        );
      }
      return { families };
    },

    async recordVerification(input) {
      await saveVerifyRound(
        db,
        {
          id: input.id,
          taskId: input.taskId,
          round: input.round,
          head: input.head,
          runId: input.runId,
          routeId: input.routeId,
          family: input.family,
          authorFamilies: input.authorFamilies,
          criteria: input.criteria,
          report: input.report ?? null,
          verdict: input.verdict,
          invalidWhy: input.invalidWhy ?? null,
          rebuttals: input.rebuttals,
          finalVerdict: input.finalVerdict ?? null,
          reasons: input.reasons,
          notes: input.notes,
        },
        clock(),
      );
    },

    async flowConfig(input) {
      // 任务所在仓的流程配置副本原样交出去：能不能派、用哪套由 core 判（Fusion 起步的 setupFusion），这里不补默认值
      const task = UUID.test(input.taskId) ? await taskContext(db, input.taskId) : null;
      if (!task) {
        throw new PortError('TASK_NOT_FOUND', `库里没有任务 ${input.taskId}：读不了它那个仓的流程配置`, {
          retryable: false,
        });
      }
      const { flow } = task.repo;
      return {
        replica: {
          syncedAt: flow.syncedAt ? flow.syncedAt.toISOString() : null,
          error: flow.error,
          unread: flow.unread,
          testCommand: flow.testCommand,
        },
        source: flow.source,
        config: flow.config,
      };
    },

    async taskRequest(input) {
      // 库里这张单的标题和正文：单子在 GitHub 上改了，接活那边（api 的 updateTaskRequest）会跟着改
      const task = UUID.test(input.taskId) ? await taskContext(db, input.taskId) : null;
      if (!task) {
        throw new PortError('TASK_NOT_FOUND', `库里没有任务 ${input.taskId}`, { retryable: false });
      }
      return { title: task.title, rawRequest: task.rawRequest };
    },

    async askHuman(input) {
      await openEngineAsk(db, {
        id: input.askId,
        taskId: input.taskId,
        runId: input.runId ?? null,
        question: input.question,
        options: input.options ?? [],
        // 引擎自己问、带了推荐的（分诊说不清，#259）：按推荐先做了，记成这张单范围内的岔路，卡片写「已按推荐先做」
        ...(input.recommended === undefined
          ? {}
          : { recommended: input.recommended, scope: 'task' as const }),
      });
    },

    async taskAsks(input) {
      const missing = () =>
        new PortError('TASK_NOT_FOUND', `库里没有任务 ${input.taskId}：读不了它问过创始人的`, {
          retryable: false,
        });
      if (!UUID.test(input.taskId)) throw missing();
      const rows = await listTaskAsks(db, input.taskId);
      // 一条都没有时核一下任务在不在：不在是明确的错，不当成「一条都没问过」
      if (rows.length === 0 && !(await taskContext(db, input.taskId))) throw missing();
      return rows.map(toTaskAsk);
    },

    async markAsksApplied(input) {
      if (!UUID.test(input.taskId)) {
        throw new PortError('TASK_NOT_FOUND', `库里没有任务 ${input.taskId}：记不了照改`, {
          retryable: false,
        });
      }
      // 只记这张单的、回答了的、没记过的：重试时已经记过的不动（照改的时刻不往后挪）
      await markAsksAppliedInDb(db, { taskId: input.taskId, askIds: input.askIds, at: clock() });
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
        ...(input.specDir !== undefined ? { specDir: input.specDir } : {}),
        ...(input.docs !== undefined ? { docs: input.docs } : {}),
        lastProblem: input.lastProblem,
        ...(input.flowSource !== undefined ? { flowSource: input.flowSource } : {}),
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
