// 引擎端口 → 库（packages/db）：选路、提问、人闸、报警、计时、任务快照。
// 选路：路由两层的顺序和候选事实（routeFactsForPurpose，#574：先按这个用途的模型顺序、再按模型下的路由顺序，摊平成一串；
// 不读旧的阶段平铺表 stage_policy_routes）+ 熔断（近 7 天的会话结局现算，failure/breaker.ts）+ 这个阶段的战绩
// （熔断、战绩、半开时在途的试探都是两种会话并起来算：Fusion 的会话和三段的一次性会话，db 的 pool-runs.ts，#758；三段的那一段按
// 它选路的用途算战绩，task-contract.ts 的 SEGMENT_STAGE）
// + 被暂停的账号池（开关 engine.poolHolds，人拍的；加 pool-hold:<池> 那条没处理的「要人拍」提醒，见 real/pool-holds.ts）交给纯函数
// chooseRoute，三种结果原样换成
// 端口的三种：判「死」的（不在线、渠道关了、犯禁令、开关关着……）挡掉、写明原因；额度未知的在同一个模型的渠道里排在读到了的后面、不跨模型（routing/rank.ts，#1089）；
// 一条都派不出、又等不来，明说派不出（带每条为什么），不拿空的、默认的顶。两层里没有「钉住」，一律按没钉住算。
// 点名的路由先试，用不了照常选并写明；续同一个会话的路由暂时派不了就等它，用不了（下线、被禁）才照常选；
// 账号池被提醒顶着暂停（等人修）时，续会话的那一单照样放过去——它就是看人修好了没有的试探；开关暂停的池一个都不放。Fusion 带了流程配置里这一步的模型顺序（models）
// 就只派这几个模型的路由、先按配置的先后排（onlyModels），一条都没有明说；人点名的路由不受它限制。
// Claude 订阅池只派会话用户此刻真挂着的那个组织的（real/session-org.ts 现读 reclaude org list，不假定）；读不到、认不出，
// 带组织类型的池一律不派、写明原因，别的池照常派；还没读完（reclaude 首跑同步配置）、这会儿定不下来（读数刚变、引擎没切过
// 号，#335）就过一会儿再选。不是挂着的那个组织的池：引擎打算切过去的（real/org-plan.ts，和切号同一个判法）算等得来——
// 等切号，任务不挂起；续会话的那条只差切号就不等它，照常选到挂着的那个池（换池 fork 续上，#59）。
// 引擎在停（收到停机信号在排空，drain.ts）时一条都不派，回「过一会儿再选」：派出去的会话会被停机截断。
// 三段的一段来选路（input.reserve，#757）：派出去那一刻给它预占一个池的名额（db 的 reservePoolSlot，锁住池再数再占），交回的
// 路由带 reservationId；读事实到预占之间池被别的单占满了，按新的事实重选（最多 RESERVE_RACE_ROUNDS 次，再不行回「过一会儿再
// 选」），不硬塞。池上占着的名额（在跑的、选定了还没开工的、预占着的）都进没空位的判断（routing/filter.ts 按 inFlight +
// reserved 判）；三段的一段预占着的也算熔断半开时在途的试探（已经派出去了）。
// 失败一律明确：库没查成照常抛，事实对不上（RoutingInputError）抛 ROUTING_INPUT，不当成「没有路由」。
// 全熔断判不判得了另有 stageAllOpen：和选路同一份事实、同一套熔断判定，不写库、不报警（每小时对账用来撤
// routing:all-open）。组织还没读完、库读失败照抛，不返回「解了」。

import {
  authorFamiliesOfTask,
  type Db,
  type EndedPoolRun,
  endedPoolRuns,
  markChannelDisabled,
  openPoolRuns,
  type RunSegment,
  readQuotaReserveSetting,
  readTaskRoutePin,
  recordStepTiming,
  releaseTaskReservation,
  reservePoolSlot,
  routeFactsForPurpose,
  saveTaskSnapshot,
  setChannelFallback,
  type TaskRoutePin,
  upsertAlert,
} from '@fleet-dao/db';
import type { HostId, OrgKind, StageKind } from '@fleet-dao/shared';
import { DRAIN_ROUTE_RETRY_SECONDS, type EngineDrain, stoppingNote } from '../drain.ts';
import { type EngineMasterGate, MASTER_ROUTE_RETRY_SECONDS, masterOffNote } from '../engine-master.ts';
import { routeBreaker } from '../failure/breaker.ts';
import { type EnginePorts, type PickRouteResult, PortError, type RouteChoice } from '../ports.ts';
import {
  type AllOpenCheck,
  type BreakerFacts,
  type CarpoolRegistryView,
  type ChooseRouteInput,
  type ChooseRouteResult,
  chooseRoute,
  stageAllOpen as judgeStageAllOpen,
  type LiveOrgReading,
  type OrgPlanView,
  type RouteFacts,
  type RouteRecord,
  RoutingInputError,
  type RoutingPolicy,
  routeLabel,
  STAGE_NAMES,
} from '../routing/index.ts';
import { SEGMENT_STAGE } from '../task-contract.ts';
import { WIRED_HOSTS as WIRED_HOST_IDS } from './hosts.ts';
import { admitSessionMemory, type MemoryAdmissionDeps } from './memory-admission.ts';
import { orgPlanView } from './org-plan.ts';
import { type HeldPools, loadHeldPools, POOL_HOLD_PREFIX, poolHoldKey } from './pool-holds.ts';
import type { SessionOrgReader } from './session-org.ts';
import { RESERVATION_TTL_MS } from './task-segment.ts';

// 整池暂停：开关（设置 engine.poolHolds）加旧的 pool-hold:<池> 提醒，读法在 real/pool-holds.ts；这里照旧导出提醒的键给老调用方。
export { POOL_HOLD_PREFIX, poolHoldKey };

/**
 * 接上的执行方式（会话端口的驱动清单，real/hosts.ts）：Claude Code（经 reclaude）、cursor-agent。别的执行方式的路由不派，
 * 派不出时理由里写明。
 */
export const WIRED_HOSTS: readonly HostId[] = WIRED_HOST_IDS;

/** 战绩和熔断看最近几天的会话结局。 */
export const RECORD_DAYS = 7;
/**
 * 选路要等时，最多隔这么久再选一次（等额度清零可能要几天：中途人点名换路由、额度提前清零要看得见）。
 * 2 分钟（原来 10 分钟，#194）：现在是兜底——切号切完探通会当场发 taskRouteWake 信号叫醒等路由的活（real/route-wake.ts，方案 4.3），
 * 信号丢了、没发出去也最多再等这么久就重选；选路只是查库，隔 2 分钟再选一次很便宜。
 */
export const MAX_ROUTE_WAIT_SECONDS = 120;
/** 选路读会话用户挂的组织最多等多久：选路这一步（quick 一档）一次尝试只有 30 秒，还要查库。 */
export const ORG_READ_WAIT_MS = 15_000;
/** 组织还没读出来时隔多久再选：平时一读 0.3 秒，慢的是 reclaude 首跑同步配置（上百秒），读在后台接着跑。 */
export const ORG_READ_RETRY_SECONDS = 30;
/** 父节点内存放不下一个新会话时，隔多久再选一次：内核回收、别家收场都不会立刻反映到 memory.current，按轮询间隔。 */
export const MEMORY_ADMISSION_RETRY_SECONDS = 30;
/** 三段的一段预占名额时，选中的池在预占那一下被别的单同时占满：按新事实最多重选几次（#757）。 */
export const RESERVE_RACE_ROUNDS = 3;
/** 连着几次都在预占那一下被抢先：隔多久再选（别的单刚派出去，池马上就看得见满没满，不用等一整个选路间隔）。 */
export const RESERVE_RACE_RETRY_SECONDS = 5;

/** 预占那一下池被别的单同时占满了（读事实到预占之间）：这一次的结论不作数，按新事实重选。 */
class SlotTaken extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlotTaken';
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StorePortsDeps {
  db: Db;
  /**
   * 会话用户此刻挂的 reclaude 组织（real/session-org.ts，design 第九节）：带组织类型的池（Claude 订阅）只派和它一样的。
   * 候选里有这种池才读；读不到、认不出，这些池一律不派（写明原因），不拿拼车顶；还没读完就过一会儿再选。
   */
  sessionOrg: SessionOrgReader;
  /**
   * 引擎切号的打算（默认 real/org-plan.ts 的 orgPlanView：和切号同一份事实、同一个判法）：候选里有不是挂着的那个组织的池
   * 才问。读不了照抛（选路报没查成，不当成不打算切）。测试可换。
   */
  orgPlan?: (input: { live: OrgKind; held: ReadonlySet<string>; now: Date }) => Promise<OrgPlanView>;
  /**
   * 拼车并发登记的现核（real/carpool-cap.ts 的 carpoolRegistry().view，#896）：候选里有带拼车组织类型的池才问；核对不上（没登记、
   * 对不上、写坏了、库里没有拼车池、核对没读成）选路不往拼车池派、写明原因。生产两处装配（createRealPorts 的 RealPortsDeps、
   * hourlyReconcileJob 的 HourlyReconcileWiring）这一项是必填、漏接过不了类型检查；这里不给 = 没判（单测路由纯函数、不涉及拼车的测试）。
   */
  carpoolRegistry?: () => Promise<CarpoolRegistryView>;
  now?: () => Date;
  /** [0, 1) 的随机数，试探用（调度策略开了试探才用得上）。 */
  draw?: () => number;
  wiredHosts?: readonly HostId[];
  routingPolicy?: Partial<RoutingPolicy>;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  /** 选路读组织最多等多久（默认 ORG_READ_WAIT_MS），测试用。 */
  orgReadWaitMs?: number;
  /**
   * 停机排空（drain.ts）：引擎在停时一条都不派，回「过一会儿再选」（工作流用 Temporal 的定时器睡，引擎重启了照样醒），
   * 新引擎起来再派。不给就不闸。
   */
  drain?: EngineDrain;
  /**
   * 引擎总开关（engine-master.ts，#1086）：关着一条都不派，回「过一会儿再选」（开了以后下一次就选得到）。排在排空之后、
   * 内存准入之前：和排空同一类「现在不该派」的闸。不给就不闸（测试、只起一次的工具）；生产由 real/index.ts 接。
   */
  master?: EngineMasterGate;
  /**
   * 派活时按内存做准入（#219）：读父节点 fleet-agents.slice 的 memory.current 看余量放不放得下一个新会话，放不下就等、
   * 读不出来就不派（明确的失败）。本机开发没有 cgroup：文件不存在就跳过准入、照派。生产由 real/index.ts 接
   * 真路径；不给就不闸（老历史回放、单测路由纯函数时也不用）。
   */
  memoryAdmission?: MemoryAdmissionDeps;
  /** 三段的一段预占的名额占多久（默认 task-segment.ts 的 RESERVATION_TTL_MS），测试用。 */
  reservationTtlMs?: number;
}

type StorePorts = Pick<
  EnginePorts,
  'pickRoute' | 'raiseAlert' | 'recordTiming' | 'saveTaskState' | 'authorFamilies'
> & {
  /**
   * 这个阶段现在是不是全熔断。和 pickRoute 同一个 loadStage、同一套熔断判定；暂停的账号池同样避开。
   * 不带某一步的模型过滤（提醒是整个阶段的），不调 allOpenAlarm、不写任何表。读不了就抛。
   */
  stageAllOpen(stage: StageKind): Promise<AllOpenCheck>;
};

export function poolNameOf(channelName: string, orgKind: OrgKind | null): string {
  if (orgKind === 'solo') return `${channelName} · 独享`;
  if (orgKind === 'carpool') return `${channelName} · 拼车`;
  return channelName;
}

/**
 * 一次结束了的会话按哪个用途算战绩：Fusion 的会话是它选路时的阶段；三段的一次性会话按这一段选路的用途（SEGMENT_STAGE），
 * 不经选路的段（对题）不算哪个用途的。
 */
function stageOf(run: EndedPoolRun): StageKind | null {
  if (run.kind === 'session') return run.stage;
  const stages: Partial<Record<RunSegment, StageKind>> = SEGMENT_STAGE;
  return stages[run.segment] ?? null;
}

/** 没下过结论的（老行、只记流水的那几笔）按不算账读：和 Fusion 的会话没记的一样当 neutral。 */
function breakerOf(
  outcomes: readonly EndedPoolRun[],
  now: Date,
  inFlight: number,
  routeId: string,
): BreakerFacts {
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
function recordOf(outcomes: readonly EndedPoolRun[], stage: StageKind): RouteRecord | null {
  let samples = 0;
  let successes = 0;
  for (const o of outcomes) {
    if (stageOf(o) !== stage || (o.routeOutcome !== 'ok' && o.routeOutcome !== 'fail')) continue;
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
  /** 路由两层的配置缺口（用途没有模型、模型下一条路由都没有）：派不出时写进原因。 */
  problems: string[];
}

/**
 * 流程配置里这一步的模型顺序（0003 第 9 条）：只留这几个模型的路由，先按配置里的先后、同一个模型的照路由两层的先后排，
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

/** 人给这张单这一段指定了模型（task_route_pins，驾驶舱单子页写）：只留这个模型（钉了路由的只留那条）的路由。 */
function onlyPinned(facts: StageFacts, pin: PinnedModel): StageFacts {
  const keep = (r: { routeId: string; modelId: string }) =>
    r.modelId === pin.modelId && (pin.routeId === null || r.routeId === pin.routeId);
  const routes = facts.routes.filter(keep);
  const ids = new Set(routes.map((r) => r.routeId));
  const order = facts.order.filter((e) => ids.has(e.routeId)).map((e, position) => ({ ...e, position }));
  return { ...facts, routes, order };
}

/** 有效的指定（清掉了的不算）。 */
type PinnedModel = { modelId: string; routeId: string | null };

function pinnedOf(pin: TaskRoutePin | null): PinnedModel | null {
  return pin?.modelId ? { modelId: pin.modelId, routeId: pin.routeId } : null;
}

/** 指定在原因里怎么说。 */
function pinLabel(pin: PinnedModel): string {
  return pin.routeId ? `${pin.modelId}（只走 ${pin.routeId}）` : pin.modelId;
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

function judgeAllOpen(input: ChooseRouteInput): AllOpenCheck {
  try {
    return judgeStageAllOpen(input);
  } catch (error) {
    if (error instanceof RoutingInputError) {
      throw new PortError('ROUTING_INPUT', `全熔断判不了：${error.message}`, { retryable: true });
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
  const reservationTtlMs = deps.reservationTtlMs ?? RESERVATION_TTL_MS;

  async function loadStage(stage: StageKind, now: Date): Promise<StageFacts> {
    // 两种会话都读（db 的 pool-runs.ts）：哪张表读不了照抛，不当成没有三段的会话（熔断、战绩、试探数都会算少）
    const [facts, outcomes, open] = await Promise.all([
      routeFactsForPurpose(db, stage, { now }),
      endedPoolRuns(db, new Date(now.getTime() - RECORD_DAYS * DAY_MS)),
      openPoolRuns(db, { now }),
    ]);
    const byRoute = new Map<string, EndedPoolRun[]>();
    for (const o of [...outcomes].sort((a, b) => a.endedAt.getTime() - b.endedAt.getTime())) {
      const list = byRoute.get(o.routeId) ?? [];
      list.push(o);
      byRoute.set(o.routeId, list);
    }
    // 熔断半开时在途的那一个就是试探：按路由数已经派出去、还没结束的会话。三段的一次性会话开跑留的那一行、选定了路由还没开跑
    // 时预占着的名额（#757，过期的 openPoolRuns 已经不给）都算：不算预占的，一批单同时选路会给半开的路由派出好几个试探。
    // Fusion 排着还没开工的不算。
    const running = new Map<string, number>();
    for (const r of open) {
      if (r.startedAt || r.kind === 'oneShot') running.set(r.routeId, (running.get(r.routeId) ?? 0) + 1);
    }

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
      executor: r.executor,
      probedAt: r.probedAt?.toISOString() ?? null,
      probeState: r.probeState,
      probeOrg: r.probeOrg,
      probeDetail: r.probeDetail,
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
      // 路由两层没有「钉住」（#574 的两张表都没这一列）：一律按没钉住算，快清零提前、战绩差往后、额度未知排后照常做（只在同一个模型的渠道之间，模型之间严格按用途里排的先后，#1089）。
      stagePinned: false,
      order: facts.order
        .filter((e) => !unwiredIds.has(e.routeId))
        .map((e) => ({ routeId: e.routeId, position: e.position, enabled: e.enabled, pinned: false })),
      routes: all.filter((r) => !unwiredIds.has(r.routeId)),
      unwired: unwiredRoutes.map((r) => routeLabel(r)),
      unwiredIds,
      problems: facts.problems,
    };
  }

  /** 整池暂停着的池（开关加旧提醒）。开关认不出的按暂停办：这里记一笔，报警由切号那一轮（org-switch）写。库读不了照抛。 */
  async function heldPools(now: Date): Promise<HeldPools> {
    const held = await loadHeldPools(db, now);
    for (const p of held.facts.problems) log('整池暂停的设置认不出，按暂停办', { why: p.why });
    return held;
  }

  /** 设置里各渠道的额度留量线原值（没设过 undefined = 内置默认）；认不认得出由选路按池判（shared 的 resolvePoolReserve）。 */
  async function quotaReserveFor(): Promise<{ setting: unknown }> {
    const r = await readQuotaReserveSetting(db);
    return { setting: r.set ? r.value : undefined };
  }

  /** 拼车并发登记核对的结论（#896）：候选里有拼车池才问；没接 carpoolRegistry 就不给（选路不判这一项）。 */
  async function carpoolRegistryFor(
    routes: readonly RouteFacts[],
  ): Promise<{ carpoolRegistry: CarpoolRegistryView } | Record<string, never>> {
    if (!deps.carpoolRegistry || !routes.some((r) => r.orgKind === 'carpool')) return {};
    return { carpoolRegistry: await deps.carpoolRegistry() };
  }

  const planOf = deps.orgPlan ?? ((input) => orgPlanView(db, input));

  /**
   * 引擎切号的打算：读成了挂的是哪个、候选里又有不是它的组织的池才问（和切号同一个判法）。别的时候不给，选路照老样子。
   */
  async function orgPlanFor(
    routes: readonly RouteFacts[],
    live: LiveOrgReading | null,
    held: ReadonlySet<string>,
    now: Date,
  ): Promise<OrgPlanView | undefined> {
    // 候选里有带组织类型的池就问：不是挂着的那个组织的池要等切号；挂着的这一类也可能在切回的宽限中、或整个渠道不可用（#194）
    if (!live?.ok || !routes.some((r) => r.orgKind)) return undefined;
    return planOf({ live: live.org, held, now });
  }

  /**
   * 给这张单的这一段在选中的路由的池上预占一个名额（#757），交回预占的编号。池在读事实到这一下之间被别的单占满了抛 SlotTaken；
   * 写不进去照常抛（不当成占上了）。顺手收掉的过期预占记一笔：那一段选定路由后这么久还没开跑，多半卡在建树、等内存上。
   */
  async function reserveSlot(
    taskId: string,
    segment: 'manual' | 'verify',
    fact: RouteFacts,
    now: Date,
  ): Promise<string> {
    const got = await reservePoolSlot(db, {
      taskId,
      segment,
      routeId: fact.routeId,
      reservedAt: now,
      expiresAt: new Date(now.getTime() + reservationTtlMs),
    });
    for (const e of got.expired) {
      log('收掉一个过期的预占：那一段选定路由后过了这么久还没开跑（多半卡在建树、等内存），名额让出来', {
        taskId: e.taskId,
        segment: e.segment,
        routeId: e.routeId,
        reservedAt: e.reservedAt.toISOString(),
      });
    }
    if (!got.reserved) {
      throw new SlotTaken(`${routeLabel(fact)}：池刚被别的单占满（${got.occupied}/${got.maxConcurrency}）`);
    }
    return got.reservationId;
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
      // 上一次起会话的渠道运行中失败、失败分流判了该换渠道（#1118）：先标 disabled 写原因，下面选路读到就不再选它；标不成照抛
      if (input.failedChannel) {
        await markChannelDisabled(db, {
          channelId: input.failedChannel.channelId,
          routeId: input.failedChannel.routeId,
          reason: input.failedChannel.reason,
          now: clock(),
        });
      }
      // 引擎在停（发布、重启）：派出去的会话会被停机截断，先不派；排在最前面，不为一次派不出去的选路查库、读组织
      const stopping = deps.drain?.stopping();
      if (stopping) {
        return {
          ok: false,
          waitFor: 'slot',
          detail: stoppingNote(stopping),
          retryAfterSeconds: DRAIN_ROUTE_RETRY_SECONDS,
        };
      }
      // 引擎总开关关着（#1086）：不派，和排空同一种回法；开了以后下一次选路就选得到
      if (deps.master && !deps.master.isOn()) {
        return {
          ok: false,
          waitFor: 'slot',
          detail: masterOffNote(deps.master.state()),
          retryAfterSeconds: MASTER_ROUTE_RETRY_SECONDS,
        };
      }
      // 派活时按内存做准入（#219）：父节点 fleet-agents.slice 余量放不下一个新会话就等、读不出来照抛，不闷头派。
      // 排在选路之前：一道闸的事，不为又一次派不出去的选路查库、读组织。本机开发没有 cgroup 时这一步自己跳过（skip）。
      if (deps.memoryAdmission) {
        const verdict = await admitSessionMemory(deps.memoryAdmission);
        if (verdict.kind === 'wait') {
          return {
            ok: false,
            waitFor: 'slot',
            detail: `在等内存：${verdict.detail}`,
            retryAfterSeconds: MEMORY_ADMISSION_RETRY_SECONDS,
          };
        }
        if (verdict.kind === 'readError') {
          throw new PortError('MEMORY_ADMISSION_UNREADABLE', `按内存做准入没查成：${verdict.detail}`, {
            retryable: true,
          });
        }
      }
      const reserve = input.reserve;
      // 人给这张单这一段指定的模型（task_route_pins）：只有三段的一段来选路（带 reserve）才有；读不到照抛，不当成没指定
      let pin: PinnedModel | null = null;
      /** 读一遍事实、选一次。要预占时，选中的池在预占那一下被别的单占满了抛 SlotTaken（这一次的结论不作数）。 */
      const pickOnce = async (): Promise<PickRouteResult> => {
        const now = clock();
        const loaded = await loadStage(input.stage, now);
        // 指定了模型：候选只剩它的路由，点名的、续会话的、照常选的都在这里面挑；一条都派不出就等或停下等人，不悄悄换别的
        const all = pin ? onlyPinned(loaded, pin) : loaded;
        if (pin && all.routes.length === 0) {
          return {
            ok: false,
            waitFor: 'none',
            detail: `人在驾驶舱给这张单指定了 ${pinLabel(pin)}，可它在${STAGE_NAMES[input.stage]}阶段的路由两层里没有接上的路由（不在这个用途的模型顺序里，或执行方式引擎还没接上）：派不出，不换别的模型；去单子页换一个或清掉指定`,
          };
        }
        // 流程配置里这一步的模型顺序（Fusion，0003 第 9 条）：只派这几个模型的路由。人点名的路由不受它限制（换路由是人的指令）
        const facts = input.models ? onlyModels(all, input.models) : all;
        const holds = await heldPools(now);
        const held = holds.all;
        // 会话用户此刻挂的组织：候选里有带组织类型的池（Claude 订阅）才读。读不到、认不出的原话交给选路，那些池一律不派；
        // 还没读完（reclaude 首跑同步配置）、正在切号（real/org-switch.ts 让选路停下的那十几秒）、读数刚变又没有引擎切号
        // （real/session-org.ts 的起点，#335）不算认不出：过一会儿再选，不悄悄照新读数派，也不挂起等人
        const live = all.routes.some((r) => r.orgKind)
          ? await deps.sessionOrg({ waitMs: deps.orgReadWaitMs ?? ORG_READ_WAIT_MS, by: '选路' })
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
        // 引擎切号的打算：候选里有不是此刻挂着的组织的池才问（和切号同一个判法）
        const orgPlan = await orgPlanFor(all.routes, live, held, now);
        const known = (id: string) => facts.routes.find((r) => r.routeId === id);
        const knownAny = (id: string) => all.routes.find((r) => r.routeId === id);
        // 开 PR 前验证只派别家：写这张单的族整族避开，点名的、续会话的也一样（一条都没有就明说没有别家可验，不拿同族顶）
        const families = (input.avoidFamilies ?? []).filter((f) => f.trim());
        // 续会话的试探只放过「提醒顶着」的池；开关暂停的池（人拍的）一个都不放，续会话的也换池 fork 续上
        const avoid = (exceptPool?: string) => ({
          routeIds: input.avoidRouteIds,
          poolIds: [
            ...new Set([
              ...input.avoidPoolIds,
              ...[...held].filter((p) => p !== exceptPool || holds.switched.has(p)),
            ]),
          ],
          modelIds: input.avoidModelIds,
          ...(families.length > 0 ? { families } : {}),
        });
        const drawn = draw();
        const orgFacts = {
          ...(live?.ok ? { liveOrg: live.org } : {}),
          ...(live && !live.ok ? { liveOrgProblem: live.why } : {}),
          ...(orgPlan ? { orgPlan } : {}),
          // 各渠道的额度留量线（#194 方案 4.8）；库读不了照抛
          quotaReserve: await quotaReserveFor(),
          // 拼车并发登记核对（#896）：核对不上选路不往拼车池派
          ...(await carpoolRegistryFor(all.routes)),
        };
        const policy = deps.routingPolicy ? { policy: deps.routingPolicy } : {};
        const base = {
          stage: input.stage,
          configured: facts.configured,
          stagePinned: facts.stagePinned,
          order: facts.order,
          routes: facts.routes,
          now: now.toISOString(),
          draw: drawn,
          ...orgFacts,
          ...(input.uiWork ? { uiWork: true } : {}),
          ...policy,
        } satisfies Omit<ChooseRouteInput, 'avoid' | 'taskRouteId'>;
        const notes: string[] = [];
        const missing = (id: string, what: string) =>
          all.unwiredIds.has(id)
            ? `${what} ${id} 的执行方式引擎还没接上，照常选`
            : knownAny(id)
              ? `${what} ${id} 的模型不在流程配置这一步的模型里，照常选`
              : `${what} ${id} 不在这个用途的路由两层顺序里，照常选`;

        const dispatched = async (r: Extract<ChooseRouteResult, { kind: 'dispatch' }>, why: string) => {
          const fact = knownAny(r.routeId);
          if (!fact) throw new PortError('ROUTING_INPUT', `选路派给了事实里没有的路由 ${r.routeId}`);
          // 先预占（#757）：占不上（SlotTaken）这一次的结论不作数，下面的全熔断报警也不做，按新事实重选
          const reservationId = reserve
            ? await reserveSlot(input.taskId, reserve.segment, fact, now)
            : undefined;
          if (r.alarm) await allOpenAlarm(input.stage, input.taskId, r.alarm);
          // 顺到谁（#1118）：失败的渠道记下这次派到了哪个渠道、哪个模型（同模型的下一个渠道；这个模型的渠道都用尽才会是别的模型）
          if (input.failedChannel && fact.channelId !== input.failedChannel.channelId) {
            await setChannelFallback(db, {
              channelId: input.failedChannel.channelId,
              fallbackChannelId: fact.channelId,
              fallbackModelId: fact.modelId,
              now,
            });
          }
          const route: RouteChoice = {
            routeId: r.routeId,
            poolId: r.poolId,
            modelId: r.modelId,
            family: r.family,
            hostId: r.hostId,
            channelId: fact.channelId,
            ...(fact.orgKind ? { orgKind: fact.orgKind } : {}),
            ...(reservationId ? { reservationId } : {}),
          };
          return { ok: true as const, route, why };
        };
        const waiting = (
          r: Extract<ChooseRouteResult, { kind: 'wait' }>,
          extra: string[],
        ): PickRouteResult => {
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
            const probing = held.has(stick.poolId) && !holds.switched.has(stick.poolId);
            const r = choose({ ...base, taskRouteId: stick.routeId, avoid: avoid(stick.poolId) });
            if (r.kind === 'dispatch') {
              return dispatched(
                r,
                probing
                  ? `续同一个会话；这个账号池暂停着（等人修），这一单就是看修好了没有：${r.why}`
                  : `续同一个会话：${r.why}`,
              );
            }
            // 暂时派不了（空位、额度、熔断到点）就等它，不换：换了就续不上这个会话。只差切号（会话用户挂的不是它的组织、
            // 或切过来还没探过）不等它：照常选到挂着的那个池，换池 fork 续上（#59），不为等切号把活停着
            const orgWait = r.verdicts.some((v) =>
              v.blocks.some((b) => b.wait === 'org' || b.wait === 'probe'),
            );
            if (r.kind === 'wait' && !orgWait) {
              return waiting(r, ['续同一个会话，等这条路由']);
            }
            notes.push(
              r.kind === 'wait'
                ? `续会话的路由要等切号（${r.reason}），照常选`
                : `续会话的路由用不了了（${r.reason}），照常选`,
            );
          }
        }

        const context = [
          ...notes,
          ...(held.size > 0
            ? [
                `暂停着的账号池：${[...held].map((p) => (holds.switched.has(p) ? `${p}（开关暂停，只有人撤得掉）` : `${p}（等人处理）`)).join('、')}`,
              ]
            : []),
          ...(facts.unwired.length > 0
            ? [`执行方式引擎还没接上、这次没算的：${facts.unwired.join('、')}`]
            : []),
          // 两层配置上的缺口（模型下一条路由都没有这类）照实带上：派不出时人要知道是配置空着，不是路由都坏了
          ...(facts.problems.length > 0 ? [`路由两层的配置缺口：${facts.problems.join('、')}`] : []),
        ];
        const noOther =
          families.length > 0
            ? [`没有别家可验：写这张单的是 ${families.join('、')} 族，这一步只派别家，不拿同族顶`]
            : [];
        // 路由两层排了这个用途、可流程配置里这一步的模型一条路由都没有：明说，不当成「这个用途一条都没配」
        if (input.models && facts.configured && facts.order.length === 0) {
          const models = input.models.length > 0 ? input.models.join('、') : '一个都没配';
          const reason = `流程配置里这一步的模型（${models}）在${STAGE_NAMES[input.stage]}阶段的路由两层顺序里没有接上的路由`;
          return { ok: false, waitFor: 'none', detail: [...noOther, reason, ...context].join('；') };
        }
        const r = choose({ ...base, avoid: avoid() });
        if (r.kind === 'dispatch') return dispatched(r, [r.why, ...notes].join('；'));
        if (r.kind === 'wait') return waiting(r, context);
        return { ok: false, waitFor: 'none', detail: [...noOther, r.reason, ...context].join('；') };
      };

      if (!reserve) return pickOnce();
      if (!UUID.test(input.taskId)) {
        throw new PortError(
          'BAD_INPUT',
          `要给这一段预占池的名额，得有库里的单（tasks.id）：「${input.taskId}」不是`,
          { retryable: false },
        );
      }
      pin = pinnedOf(await readTaskRoutePin(db, input.taskId, reserve.segment));
      const pinned = pin;
      const said = (r: PickRouteResult): PickRouteResult => {
        if (!pinned) return r;
        const note = `按人指定的 ${pinLabel(pinned)}`;
        if (r.ok) return { ...r, why: `${note}：${r.why}` };
        // 派不出、要等：写明是指定的那个模型在等，等的是它、不换别的
        return r.detail.startsWith('人在驾驶舱')
          ? r
          : { ...r, detail: `${note}，只等它、不换别的模型：${r.detail}` };
      };
      // 这一段又来选路，上一次预占的就作废了（没开跑、也没放掉：起会话那一边放不成、选路这一步被重试过）：不让它把池占满、挡了自己
      await releaseTaskReservation(db, { taskId: input.taskId, segment: reserve.segment });
      const lost: string[] = [];
      for (let round = 1; round <= RESERVE_RACE_ROUNDS; round += 1) {
        try {
          return said(await pickOnce());
        } catch (error) {
          if (!(error instanceof SlotTaken)) throw error;
          lost.push(error.message);
        }
      }
      return said({
        ok: false,
        waitFor: 'slot',
        detail: `连着 ${RESERVE_RACE_ROUNDS} 次，选中的池都在预占那一下被别的单同时占满了（${lost.join('；')}），过一会儿再选`,
        retryAfterSeconds: RESERVE_RACE_RETRY_SECONDS,
      });
    },

    async stageAllOpen(stage) {
      const now = clock();
      const facts = await loadStage(stage, now);
      const held = (await heldPools(now)).all;
      // 和选路一样：候选里有带组织类型的池才读。还没读完、这会儿定不下来不是「解了」，抛出去让对账记没查成。
      const live = facts.routes.some((r) => r.orgKind)
        ? await deps.sessionOrg({ waitMs: deps.orgReadWaitMs ?? ORG_READ_WAIT_MS, by: '每小时对账' })
        : null;
      if (live && !live.ok && live.pending) {
        throw new PortError(
          'ORG_UNREAD',
          `会话用户挂的组织还没读出来，判不了${STAGE_NAMES[stage]}阶段是不是全熔断：${live.why}`,
          { retryable: true },
        );
      }
      if (live && !live.ok) log('会话用户挂的组织认不出，Claude 订阅池按认不出挡', { why: live.why });
      const orgPlan = await orgPlanFor(facts.routes, live, held, now);
      return judgeAllOpen({
        stage,
        configured: facts.configured,
        stagePinned: facts.stagePinned,
        order: facts.order,
        routes: facts.routes,
        now: now.toISOString(),
        // 试探开着时校验要一个随机数；这个判断不用它（不抽签）。
        draw: 0,
        avoid: { poolIds: [...held] },
        ...(live?.ok ? { liveOrg: live.org } : {}),
        ...(live && !live.ok ? { liveOrgProblem: live.why } : {}),
        ...(orgPlan ? { orgPlan } : {}),
        quotaReserve: await quotaReserveFor(),
        ...(await carpoolRegistryFor(facts.routes)),
        ...(deps.routingPolicy ? { policy: deps.routingPolicy } : {}),
      });
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
