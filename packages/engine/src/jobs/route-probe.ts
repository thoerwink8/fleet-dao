// 路由探针（#129，design 第九节「路由探针」）：一轮 = 记下开始 → 读全部路由 → 会话用户该不该切号（#157，org-switch.ts；
// 切了这一轮探完核对）→ 逐条定探不探 → 该探的真起一次最小会话 → 每条写一条结论（只有 ok 在线，其余一律不在线、
// 写明原因；Claude 订阅池的还记下那时会话用户挂的组织，选路靠它分得清「那一轮挂着别的组织、没探它」和「探了没通」，#335）
// → 结局记进 schedule_runs。按一次的成本放慢的执行方式（cursor-agent、grok），上一次探通了、还没到再探的
// 时候，这一轮不探、不重写，结论照旧（它的过期线也跟着放宽，routeProbeStaleMinutes）。定时这一轮另外两档也省额度
// （#1424，只这一轮，派前探测和人点的立即探测不看）：连着不通按 15、30、60、120、240 分钟退避，封顶 240，探通回到原节奏；
// 已探通、又不在用途顺序前 2 位的，隔 60 分钟再探（本来更久的不改短）。会话用户挂的组织这会儿定不下来
// （读数刚变、引擎没切过号，real/session-org.ts）：Claude 订阅池这一轮也不探、结论照旧，这一轮记 partial、写明为什么。
// 窗口已重置、这一轮没发过探测的组织，用现有探法补发一次最小请求，把下一个窗口开起来（#49）。已探过的不重复发，
// 也不改写路由结论。派前探测和人点的立即探测不补发。
// scanned = 这一轮看过的路由条数（写下结论的，加上结论照旧的），found = 其中不在线的条数（驾驶舱「定时任务」页和调度台的
// 在线数对得上）。没跑成、一条都没写进去、只写进去一部分，照实记 failed / unscanned / partial，不记成 ok（没跑成 ≠ 没问题）。

import type { RouteProbeTarget, ScheduleResult } from '@fleet-dao/db';
import {
  type HostId,
  type OrgKind,
  type ProbeCheck,
  probeBackoffMinutes,
  probeBackoffPhrase,
  probeFailStreak,
  ROUTE_PROBE_DEFER_MINUTES,
  ROUTE_PROBE_EVERY_MINUTES,
  ROUTE_PROBE_PRIMARY_COUNT,
  type RouteProbeState,
  routeProbeEveryMinutes,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { RouteProbeRun } from '../contract.ts';
import { hostName, ORG_NAMES } from '../routing/names.ts';
import type { LiveOrgReading } from '../routing/types.ts';
import type { ScheduleRunLog } from './github-reconcile.ts';
import type { OrgSwitchRound, ProbedRoute } from './org-switch.ts';

/** 登记进 scheduled_jobs 的那一行：一次都没跑过也列得出来。 */
export const ROUTE_PROBE_JOB = {
  id: 'route-probe',
  name: '路由探针',
  schedule: '每 15 分钟（每小时 7、22、37、52 分）',
  // 连着三轮没跑成才算过期：一轮探一次 Claude 最长要几分钟，偶尔一轮慢不报。
  expectEveryMinutes: 45,
} as const;

export { ROUTE_PROBE_EVERY_MINUTES };
/** 和对账补漏（整点起每 15 分钟）错开几分钟跑：两样都在整点挤着连库、连 GitHub、起会话。 */
export const ROUTE_PROBE_OFFSET_MINUTES = 7;
/** 没探通、又不是要人修的整池问题：隔这么久在同一轮里再探一次，一次网络抖动不让路由下线。 */
export const ROUTE_PROBE_RETRY_DELAY_MS = 20_000;
/** 同时探几条（每条是一个真会话，占内存）。 */
export const ROUTE_PROBE_CONCURRENCY = 2;
/** 写进库的原因最长多少字：插头的报错原文可能很长，驾驶舱只要能看懂的那一截。 */
export const ROUTE_PROBE_DETAIL_MAX = 600;
/**
 * 派单前：上一次探通的结论还在这么久以内（含刚好到点）就不重复探（#1409）。已经超过才当场探这一条。
 * 按量计费、以及 planProbe 写明不探的（含放慢的执行方式还没到再探的时候）不看这条，照旧不探。
 */
export const DISPATCH_PROBE_FRESH_MS = 5 * 60_000;

/**
 * heldBySwitch：这个池被人拍了整池暂停（开关 engine.poolHolds，值是写在开关里的原因）。探它没有意义——封号、欠费这类要人修的事，
 * 探一次只会再撞一次；人撤了暂停，下一轮自然恢复探。只认开关；引擎自己写的 pool-hold: 提醒不在此列，它要靠探针探通来撤。
 */
export type ProbeTarget = RouteProbeTarget & { heldBySwitch?: string };

/**
 * 真探一次的结果。answered = 答上了；quota = 额度用满被拒——登录、组织、上游都通，额度另有额度那一套挡（选路按额度
 * 等清零），不当成离线（离线在选路里是硬挡，任务会挂起等人点「继续」）；failed = 没探通。
 */
/** 这一次真探量到的东西。没探、或探针没拿到，对应字段不给（写入时按空落库，不当 0、不当空串）。 */
interface ProbeCapture {
  /** 耗时（毫秒）。量到 0 是用时不到 1 毫秒，照给。 */
  durationMs?: number | null;
  /** 发出去的请求原文。 */
  requestText?: string | null;
  /** 响应原文。 */
  responseText?: string | null;
  /** 降智检测（#1637）：这一次问的题和判的结果。没带题（没问到、不是真探）不给。 */
  check?: ProbeCheck | null;
}

export type ProbeAttempt =
  | ({ kind: 'answered'; detail: string } & ProbeCapture)
  | ({ kind: 'quota'; detail: string } & ProbeCapture)
  | ({
      kind: 'failed';
      detail: string;
      /** 要人修的整池问题（登录失效、设备被撤销、封号、欠费）：同一轮里不再试，整池暂停、推「要人拍」。 */
      poolHold?: { title: string; body: string };
    } & ProbeCapture);

/** 一种执行方式的探法：起一次最小会话、问一句。不许抛——抛了按「探针自己出错」记成没探通。 */
export type Prober = (target: ProbeTarget) => Promise<ProbeAttempt>;

export interface RouteProbeJobDeps {
  /** 全部路由和探得了探不了的事实（真实现是 @fleet-dao/db 的 routeProbeTargets）。 */
  targets(): Promise<ProbeTarget[]>;
  /** 执行方式 → 探法；没有的执行方式 = 引擎还没接这种插头。 */
  probers: Partial<Record<HostId, Prober>>;
  /**
   * 会话用户此刻挂的组织（真实现是 real/session-org.ts：以会话用户跑 reclaude org list，认带 * 的那行的类型，按和选路、切号
   * 同一个起点判）。只在探带组织类型的池（Claude 订阅）之前读，一条读一次（读成了的留一会儿），等到读完；不许抛，读不到、
   * 认不出回 ok: false，这会儿定不下来（读数刚变、引擎没切过号）回 pending。
   */
  sessionOrg(): Promise<LiveOrgReading>;
  /**
   * 会话用户切号（#157，真实现 real/org-switch.ts）：每一轮探之前判一次、该切就切（切完这一轮探的就是切过去的组织），
   * 切过了这一轮探完核对切过去的那个池探通了没有。不给就不切。
   */
  orgSwitch?: OrgSwitchRound;
  /**
   * 写一条结论（真实现是 saveRouteProbe）；路由这一轮当中被删了回 route_not_found。org：Claude 订阅池的路由下这个结论时
   * 会话用户挂的组织（读不到、不是 Claude 订阅池为 null）。
   */
  save(write: {
    routeId: string;
    state: RouteProbeState;
    at: Date;
    detail: string;
    org: OrgKind | null;
    /** 没真探、没量到为 null，不当 0。 */
    durationMs: number | null;
    /** 没发出请求为 null。 */
    requestText: string | null;
    /** 没拿到响应为 null。 */
    responseText: string | null;
    /** 降智检测的题和判的结果；没带题为空。 */
    check?: ProbeCheck | null;
  }): Promise<'saved' | 'route_not_found'>;
  /** 一条路由真探完（写库之前）：真实现里接整池暂停的报警和撤销。抛了只记日志，不改结论。 */
  afterProbe?(target: ProbeTarget, attempt: ProbeAttempt): Promise<void>;
  runs: ScheduleRunLog;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
  retryDelayMs?: number;
  concurrency?: number;
  /**
   * 读到窗口已重置的组织（quota-read 写进库的，清零时刻已过、windowState 为 reset）。
   * 不给就不补发：测试和还没接线的进程照旧只探路由。
   */
  resetOrgs?: () => Promise<readonly OrgKind[]>;
  /**
   * 包住补发的那一次最小请求，让它扣到这个组织上。回 false = 这一次没发。
   * 不给就直接发（单测里的探法自己计数）。真装配没挂着这个组织时先切过去、发完切回；切不成、有会话在跑就不发。
   */
  aroundKick?: (org: OrgKind, send: () => Promise<void>) => Promise<boolean>;
}

/** 这一轮没跑成（读不到路由、一条都没写进去）：结局已经记进 schedule_runs，活动照样报失败，Temporal 里也看得见。 */
export class RouteProbeFailedError extends Error {
  readonly runId: number;
  constructor(runId: number, message: string) {
    super(message);
    this.name = 'RouteProbeFailedError';
    this.runId = runId;
  }
}

const clip = (text: string, max = ROUTE_PROBE_DETAIL_MAX) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

export type ProbePlan =
  | { probe: Prober }
  /** failed：该探却探不了（会话用户挂的组织认不出，不知道探这个池扣的是谁）——不是按规矩不探，是出了要人看的毛病。 */
  | { state: 'not_wired' | 'skipped' | 'failed'; detail: string }
  /** 按一次的成本放慢的执行方式，上一次探通了、还没到再探的时候：这一轮不探、不重写，结论照旧（原因只进日志）。 */
  | { kept: string }
  /**
   * 会话用户挂的组织这会儿定不下来（读数刚变、引擎没切过号；切号那几秒）：Claude 订阅池这一轮不探、不重写，结论照旧——
   * 不知道这时探的是哪个组织，也不把没探的写成不在线。这一轮记 partial、写明为什么。
   */
  | { unsettled: string };

/**
 * 这条路由这一轮探不探。先后就是优先级：按量计费 → 插头没接 → 渠道下架 → 模型下架 → 没有阶段在用 → 会话用户挂着别的组织
 * → 放慢的执行方式还没到再探的时候（ROUTE_PROBE_HOST_EVERY_MINUTES：只看上一次探通了的）。
 * 不通的退避、不在前 2 位的放慢不在这里：只定时那一轮（planScheduledProbe）看，派前探测沿用这一份。
 * 按量计费排第一：不管插头接没接都不探（判断阶段的 Jev 就是按量的，它不经会话插头，说「派不了」反而误导）。
 * 不探的一律不在线（写明原因）；要探的交给这种执行方式的探法。live 是会话用户此刻挂的组织（带组织类型的池才用得上，
 * 别的传 null）：读不到、认不出就记没探成（failed），不拿哪个组织顶；这会儿定不下来（pending）就这一轮不探、结论照旧
 * （unsettled），不把没探的写成不在线。
 */
export function planProbe(
  t: ProbeTarget,
  probers: Partial<Record<HostId, Prober>>,
  live: LiveOrgReading | null,
  now: Date,
): ProbePlan {
  if (t.billing === 'metered') {
    return {
      state: 'skipped',
      detail: '按量计费的渠道不自动探：探一次就多一笔账（design 第三节第 21 条）',
    };
  }
  if (t.heldBySwitch !== undefined) {
    return {
      state: 'skipped',
      detail: `账号池 ${t.poolId} 被人拍了整池暂停（${t.heldBySwitch}）：不探，撤了暂停下一轮恢复`,
    };
  }
  const probe = probers[t.hostId];
  if (!probe) {
    const wired = Object.keys(probers).map(hostName).join('、') || '一种都没有';
    return {
      state: 'not_wired',
      detail: `执行方式「${hostName(t.hostId)}」的插头引擎还没接（现在接了 ${wired}）：探不了，派工也派不到它`,
    };
  }
  if (!t.channelEnabled) return { state: 'skipped', detail: `渠道「${t.channelName}」已下架，不探` };
  if (t.modelRetiredAt !== null && t.modelRetiredAt.getTime() <= now.getTime()) {
    return { state: 'skipped', detail: `模型「${t.modelName}」已下架，不探` };
  }
  if (!t.inUse) {
    return {
      state: 'skipped',
      detail: '没有哪个阶段在用这条路由（挂着但关着的不算），不花额度去探；哪个阶段用上它，下一轮就探',
    };
  }
  if (t.orgKind !== null) {
    if (live && !live.ok && live.pending) {
      return {
        unsettled: `会话用户挂的组织这会儿定不下来（${live.why}）：${ORG_NAMES[t.orgKind]}池这一轮不探，结论照旧`,
      };
    }
    if (!live?.ok) {
      return {
        state: 'failed',
        detail: `会话用户挂的组织认不出（${live ? live.why : '没读'}）：不知道这时探${ORG_NAMES[t.orgKind]}池扣的是哪个组织的额度、探的是哪个，不探`,
      };
    }
    if (t.orgKind !== live.org) {
      const name = ORG_NAMES[live.org];
      return {
        state: 'skipped',
        detail: `会话用户现在挂的是${name}组织：这时探${ORG_NAMES[t.orgKind]}池，扣的是${name}的额度、探的也是${name}，不探（拼车用满切独享、恢复了切回，引擎在探针每一轮探之前判）`,
      };
    }
  }
  const every = routeProbeEveryMinutes(t.hostId);
  const last = t.previous;
  if (every > ROUTE_PROBE_EVERY_MINUTES && t.alive && last?.state === 'ok') {
    const age = now.getTime() - last.at.getTime();
    // 每轮开跑的时刻差几秒到几十秒：差半轮以内算到点，不拖到下一轮
    if (age >= 0 && age < (every - ROUTE_PROBE_EVERY_MINUTES / 2) * 60_000) {
      return {
        kept: `${hostName(t.hostId)} 按一次的成本放慢，探通了隔 ${every} 分钟再真探；上一次探通是 ${Math.round(age / 60_000)} 分钟前`,
      };
    }
  }
  return { probe };
}

/** 差半轮以内算到点，不拖到下一轮（和放慢的执行方式同一条）。 */
function stillWaiting(ageMs: number, everyMinutes: number): boolean {
  return ageMs >= 0 && ageMs < (everyMinutes - ROUTE_PROBE_EVERY_MINUTES / 2) * 60_000;
}

/**
 * 定时这一轮还没到再探的时候。回 null = 到期该探。
 * 读不到上一次的时刻（不是有效时间）、时刻在未来：按到期该探，不跳过。
 * 名次没给（读不到排第几）：不当成排在后面，保持原间隔。
 */
function paceWait(t: ProbeTarget, now: Date): { kind: 'backoff' | 'defer'; detail: string } | null {
  const last = t.previous;
  if (!last) return null;
  const at = last.at instanceof Date ? last.at.getTime() : Number.NaN;
  if (!Number.isFinite(at)) return null;
  const age = now.getTime() - at;
  if (age < 0) return null;

  if (last.state === 'failed') {
    // 原文没写次数：算已经不通 1 次（15 分钟），不把「没写」当成可以一直不探
    const streak = probeFailStreak(last.detail) ?? 1;
    const every = probeBackoffMinutes(streak);
    if (!stillWaiting(age, every)) return null;
    const next = new Date(at + every * 60_000);
    return { kind: 'backoff', detail: `${probeBackoffPhrase(next)}（连着不通 ${streak} 次）` };
  }

  if (last.state === 'ok' && t.alive) {
    const rank = t.probeRank;
    if (rank == null || rank <= ROUTE_PROBE_PRIMARY_COUNT) return null;
    const hostEvery = routeProbeEveryMinutes(t.hostId);
    const every = Math.max(hostEvery, ROUTE_PROBE_DEFER_MINUTES);
    // 这种执行方式本来就隔得更久：planProbe 已经按那个间隔放慢，这里不改短
    if (every <= hostEvery) return null;
    if (!stillWaiting(age, every)) return null;
    return {
      kind: 'defer',
      detail: `不在用途顺序前 ${ROUTE_PROBE_PRIMARY_COUNT} 位，探通了隔 ${every} 分钟再真探；上一次探通是 ${Math.round(age / 60_000)} 分钟前`,
    };
  }
  return null;
}

export type ScheduledProbePlan = ProbePlan | { backingOff: string };

/**
 * 定时这一轮探不探。先走 planProbe（按量、没启用、下架、放慢的执行方式），再看退避和前 2 位以外的放慢。
 * 派前探测不走这里。
 */
export function planScheduledProbe(
  t: ProbeTarget,
  probers: Partial<Record<HostId, Prober>>,
  live: LiveOrgReading | null,
  now: Date,
): ScheduledProbePlan {
  const plan = planProbe(t, probers, live, now);
  if (!('probe' in plan)) return plan;
  const wait = paceWait(t, now);
  if (!wait) return plan;
  if (wait.kind === 'backoff') return { backingOff: wait.detail };
  return { kept: wait.detail };
}

/** 这一次没探通之后，下一次定时探针隔多久。上一次不是不通从 1 次数；原文没写次数的不通算已经 1 次。 */
function nextFailureNote(t: ProbeTarget, now: Date): string {
  const prev = t.previous?.state === 'failed' ? (probeFailStreak(t.previous.detail) ?? 1) : 0;
  const streak = prev + 1;
  const next = new Date(now.getTime() + probeBackoffMinutes(streak) * 60_000);
  return `${probeBackoffPhrase(next)}（连着不通 ${streak} 次）`;
}

/** 探通、又不在前 2 位、这种执行方式本来不到 60 分钟一探：结论里写明下次隔 60 分钟。本来更久的不写这句。 */
function deferNote(t: ProbeTarget): string | null {
  if (t.probeRank == null || t.probeRank <= ROUTE_PROBE_PRIMARY_COUNT) return null;
  if (routeProbeEveryMinutes(t.hostId) >= ROUTE_PROBE_DEFER_MINUTES) return null;
  return `不在用途前 ${ROUTE_PROBE_PRIMARY_COUNT} 位，隔 ${ROUTE_PROBE_DEFER_MINUTES} 分钟再探`;
}

/** 原因太长时先截原因，退避那句留在末尾，整段仍不超过 ROUTE_PROBE_DETAIL_MAX。 */
function withNote(detail: string, note: string | null): string {
  if (!note) return clip(detail);
  const tail = `。${note}`;
  const room = ROUTE_PROBE_DETAIL_MAX - tail.length;
  if (room < 1) return clip(note);
  if (detail.length <= room) return `${detail}${tail}`;
  return `${detail.slice(0, room - 1)}…${tail}`;
}

async function attemptOf(probe: Prober, t: ProbeTarget): Promise<ProbeAttempt> {
  try {
    return await probe(t);
  } catch (err) {
    return { kind: 'failed', detail: `探针自己出错，没探成：${errMessage(err)}` };
  }
}

export interface Conclusion {
  target: ProbeTarget;
  state: RouteProbeState;
  detail: string;
  at: Date;
  /** Claude 订阅池的路由下这个结论时会话用户挂的组织（读不到、不是 Claude 订阅池为 null），跟结论一起写进库。 */
  org: OrgKind | null;
  /** 放慢的执行方式、或不在前 2 位还没到再探的时候：不写库，上一次探通的结论照旧（算在线）。 */
  kept?: boolean;
  /** 不通之后还在退避：不写库，上一次的不通结论照旧（算不在线）。detail 里有「退避中，下次约 HH:MM 再探」。 */
  backingOff?: boolean;
  /** 会话用户挂的组织这会儿定不下来：不写库，上一次的结论照旧（在不在线照库里那样算）。 */
  unsettled?: boolean;
  /** 没真探、没量到为 null。同一轮重试只留最终那一次的耗时和原文，第一次的原因已经写进 detail。 */
  durationMs: number | null;
  requestText: string | null;
  responseText: string | null;
  check?: ProbeCheck | null;
}

const NO_CAPTURE = { durationMs: null, requestText: null, responseText: null } as const;

function captureOf(attempt: ProbeAttempt): {
  durationMs: number | null;
  requestText: string | null;
  responseText: string | null;
  check: ProbeCheck | null;
} {
  return {
    durationMs: attempt.durationMs ?? null,
    requestText: attempt.requestText ?? null,
    responseText: attempt.responseText ?? null,
    check: attempt.check ?? null,
  };
}

/** 会话用户此刻挂的组织：读法约好了不抛，万一抛了也按认不出记（写明原因），不让整轮垮掉。 */
async function liveOrgOf(deps: RouteProbeJobDeps): Promise<LiveOrgReading> {
  try {
    return await deps.sessionOrg();
  } catch (err) {
    return { ok: false, why: `读会话用户挂的组织出错：${errMessage(err)}` };
  }
}

export async function conclude(
  deps: RouteProbeJobDeps,
  t: ProbeTarget,
  opts?: { pace?: boolean; bypassPace?: boolean },
): Promise<Conclusion> {
  // 带组织类型的池（Claude 订阅）探之前现读一次（读成了的留一会儿）：一轮要好几分钟，中途切了号也认得出
  const live = t.orgKind === null ? null : await liveOrgOf(deps);
  // 写进库的「那时挂的组织」：读成了才有；读不到、这会儿定不下来都不写（选路就不会把它当成「另一个组织挂着时没探」）
  const org = live?.ok ? live.org : null;
  // 人点的立即探测：节奏上把上一次当没有（放慢、退避都不挡），连着不通的次数还留在 t.previous 上
  const plan =
    opts?.pace && !opts.bypassPace
      ? planScheduledProbe(t, deps.probers, live, deps.now())
      : planProbe(opts?.bypassPace ? { ...t, previous: null } : t, deps.probers, live, deps.now());
  if ('backingOff' in plan) {
    deps.log('info', `路由探针：${plan.backingOff}`, { routeId: t.routeId });
    return {
      target: t,
      state: 'failed',
      detail: plan.backingOff,
      at: deps.now(),
      org,
      backingOff: true,
      ...NO_CAPTURE,
    };
  }
  if ('kept' in plan) {
    deps.log('info', '路由探针：还没到再探的时候，结论照旧', { routeId: t.routeId, detail: plan.kept });
    return { target: t, state: 'ok', detail: plan.kept, at: deps.now(), org, kept: true, ...NO_CAPTURE };
  }
  if ('unsettled' in plan) {
    deps.log('warn', '路由探针：会话用户挂的组织这会儿定不下来，Claude 池这一轮不探、结论照旧', {
      routeId: t.routeId,
      detail: plan.unsettled,
    });
    return {
      target: t,
      state: 'skipped',
      detail: plan.unsettled,
      at: deps.now(),
      org,
      unsettled: true,
      ...NO_CAPTURE,
    };
  }
  if (!('probe' in plan)) {
    return { target: t, state: plan.state, detail: plan.detail, at: deps.now(), org, ...NO_CAPTURE };
  }
  let attempt = await attemptOf(plan.probe, t);
  if (attempt.kind === 'failed' && !attempt.poolHold) {
    const first = attempt.detail;
    deps.log('warn', '路由探针：第一次没探通，隔一会儿再探一次', { routeId: t.routeId, detail: first });
    await deps.sleep(deps.retryDelayMs ?? ROUTE_PROBE_RETRY_DELAY_MS);
    const second = await attemptOf(plan.probe, t);
    attempt =
      second.kind === 'failed'
        ? { ...second, detail: `连探两次都没通：${second.detail}（第一次：${first}）` }
        : { ...second, detail: `${second.detail}（第一次没通：${first}）` };
  }
  if (attempt.kind === 'failed') {
    // 定时、派前、人点的都写上：驾驶舱和通知看的是这条结论，免得退避看起来像探针停了
    attempt = { ...attempt, detail: withNote(attempt.detail, nextFailureNote(t, deps.now())) };
  } else if (opts?.pace) {
    const note = deferNote(t);
    if (note) attempt = { ...attempt, detail: withNote(attempt.detail, note) };
  }
  if (deps.afterProbe) {
    try {
      await deps.afterProbe(t, attempt);
    } catch (err) {
      deps.log('error', '路由探针：整池暂停的报警没写进库（结论照写）', {
        routeId: t.routeId,
        error: errMessage(err),
      });
    }
  }
  return {
    target: t,
    state: attempt.kind === 'failed' ? 'failed' : 'ok',
    detail: clip(attempt.detail),
    at: deps.now(),
    org,
    ...captureOf(attempt),
  };
}

/** 这一轮探之前的切号：约好了不抛，万一抛了只记日志、这一轮不切（探针照探）。 */
async function switchBefore(deps: RouteProbeJobDeps): Promise<OrgKind | null> {
  if (!deps.orgSwitch) return null;
  try {
    return await deps.orgSwitch.before();
  } catch (err) {
    deps.log('error', '路由探针：切号这一步出错，这一轮不切', { error: errMessage(err) });
    return null;
  }
}

/** 最多同时 n 个，结果按输入的顺序。 */
async function mapLimit<T, R>(items: readonly T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return out;
}

/** 这一轮真发出过探测的组织。包一层探法记下，不改结论。 */
function countingProbers(
  probers: Partial<Record<HostId, Prober>>,
  sent: Set<OrgKind>,
): Partial<Record<HostId, Prober>> {
  const out: Partial<Record<HostId, Prober>> = {};
  for (const host of Object.keys(probers) as HostId[]) {
    const probe = probers[host];
    if (!probe) continue;
    out[host] = async (target) => {
      if (target.orgKind) sent.add(target.orgKind);
      return probe(target);
    };
  }
  return out;
}

/** 补发用的一条路由：现有探法发得出去的。在用的优先，同档按路由 id，一个组织只取一条。 */
function kickRoute(
  targets: readonly ProbeTarget[],
  org: OrgKind,
  probers: Partial<Record<HostId, Prober>>,
  now: Date,
): ProbeTarget | null {
  const eligible = targets.filter((t) => {
    if (t.orgKind !== org) return false;
    if (t.billing === 'metered') return false;
    if (t.heldBySwitch !== undefined) return false;
    if (!probers[t.hostId]) return false;
    if (!t.channelEnabled) return false;
    if (t.modelRetiredAt !== null && t.modelRetiredAt.getTime() <= now.getTime()) return false;
    return true;
  });
  eligible.sort((a, b) => {
    if (a.inUse !== b.inUse) return a.inUse ? -1 : 1;
    return a.routeId < b.routeId ? -1 : a.routeId > b.routeId ? 1 : 0;
  });
  return eligible[0] ?? null;
}

/**
 * 窗口已重置、这一轮没发过探测的组织，补发一次最小请求（#49）。已探过的不发。
 * 不写路由结论：这一发是去开下一个窗口，不是这一轮的在线结论。不重试，只要一次。
 * 抛了只记日志，不把已经探完的这一轮改成没跑成。派前探测不走这里。
 */
async function openResetWindows(
  deps: RouteProbeJobDeps,
  targets: readonly ProbeTarget[],
  sent: ReadonlySet<OrgKind>,
): Promise<void> {
  if (!deps.resetOrgs) return;
  try {
    const seen = new Set<OrgKind>();
    for (const org of await deps.resetOrgs()) {
      if (seen.has(org) || sent.has(org)) {
        seen.add(org);
        continue;
      }
      seen.add(org);
      const route = kickRoute(targets, org, deps.probers, deps.now());
      if (!route) {
        deps.log('warn', '路由探针：窗口已重置，没有能补发的路由', { org });
        continue;
      }
      const probe = deps.probers[route.hostId];
      if (!probe) continue;
      const fire = async () => {
        const attempt = await attemptOf(probe, route);
        deps.log(attempt.kind === 'failed' ? 'warn' : 'info', '路由探针：窗口已重置，补发了一次最小请求', {
          org,
          routeId: route.routeId,
          kind: attempt.kind,
        });
        if (!deps.afterProbe) return;
        try {
          await deps.afterProbe(route, attempt);
        } catch (err) {
          deps.log('error', '路由探针：补发之后的整池暂停没写上', { org, error: errMessage(err) });
        }
      };
      if (!deps.aroundKick) {
        await fire();
        continue;
      }
      const placed = await deps.aroundKick(org, fire);
      if (!placed) deps.log('info', '路由探针：窗口已重置，这一轮没补发', { org, routeId: route.routeId });
    }
  } catch (err) {
    deps.log('error', '路由探针：窗口重置后的补发没跑成', { error: errMessage(err) });
  }
}

async function probeRound(deps: RouteProbeJobDeps): Promise<{ result: ScheduleResult; online: string[] }> {
  let targets: ProbeTarget[];
  try {
    targets = await deps.targets();
  } catch (err) {
    return { result: { outcome: 'failed', why: `读路由表没成：${errMessage(err)}` }, online: [] };
  }
  if (targets.length === 0) {
    return {
      result: {
        outcome: 'unscanned',
        why: '库里一条路由都没有（目录还没装进库？见 docs/ops.md「目录配置」）',
      },
      online: [],
    };
  }
  // 切号在探之前：切过去了，这一轮探的就是切过去的组织，探完核对
  const switched = await switchBefore(deps);
  const sentOrgs = new Set<OrgKind>();
  const watching: RouteProbeJobDeps = { ...deps, probers: countingProbers(deps.probers, sentOrgs) };
  const conclusions = await mapLimit(targets, watching.concurrency ?? ROUTE_PROBE_CONCURRENCY, (t) =>
    conclude(watching, t, { pace: true }),
  );
  if (deps.orgSwitch) {
    // 真探了的才算读回（放慢没真探、组织定不下来没探的，结论照旧，都不算）
    const probed = conclusions
      .filter((c) => !c.kept && !c.unsettled && !c.backingOff)
      .map((c) => ({
        routeId: c.target.routeId,
        orgKind: c.target.orgKind,
        state: c.state,
        detail: c.detail,
      }));
    try {
      await deps.orgSwitch.after(switched, probed);
    } catch (err) {
      deps.log('error', '路由探针：切号的核对出错', { error: errMessage(err) });
    }
  }
  const online: string[] = [];
  const unsaved: string[] = [];
  const gone: string[] = [];
  const unsettled: Conclusion[] = [];
  let written = 0;
  let offline = 0;
  let kept = 0;
  let backingOff = 0;
  for (const c of conclusions) {
    if (c.backingOff) {
      // 不重写：上一次的不通结论里已经写着下次大约几点。算看过、算不在线
      backingOff += 1;
      offline += 1;
      continue;
    }
    if (c.kept) {
      kept += 1;
      online.push(c.target.routeId);
      continue;
    }
    if (c.unsettled) {
      // 没探、不写：在不在线照库里上一次的结论算
      unsettled.push(c);
      if (c.target.alive) online.push(c.target.routeId);
      else offline += 1;
      continue;
    }
    let saved: 'saved' | 'route_not_found';
    try {
      saved = await deps.save({
        routeId: c.target.routeId,
        state: c.state,
        at: c.at,
        detail: c.detail,
        org: c.org,
        durationMs: c.durationMs,
        requestText: c.requestText,
        responseText: c.responseText,
        check: c.check ?? null,
      });
    } catch (err) {
      unsaved.push(`${c.target.routeId}：${errMessage(err)}`);
      continue;
    }
    if (saved === 'route_not_found') {
      gone.push(c.target.routeId);
      continue;
    }
    written += 1;
    if (c.state === 'ok') online.push(c.target.routeId);
    else offline += 1;
  }
  // 结论先落库，再补发：补发不改这一轮的在线结论，失败也不把这一轮改成没跑成
  await openResetWindows(deps, targets, sentOrgs);
  const goneNote = gone.length > 0 ? `；探的时候被删掉的路由：${gone.join('、')}` : '';
  if (written === 0 && (kept + backingOff + unsettled.length === 0 || unsaved.length > 0)) {
    return {
      result:
        unsaved.length > 0
          ? { outcome: 'failed', why: `一条结论都没写进库：${unsaved.join('；')}${goneNote}` }
          : { outcome: 'unscanned', why: `要探的路由这一轮当中都被删了${goneNote}` },
      online,
    };
  }
  // 结论照旧的也算看过了（放慢的上一次探通、在线；组织定不下来的照上一次的算），不在线的算进 found
  const scanned = written + kept + backingOff + unsettled.length;
  const problems = [
    ...(unsaved.length > 0
      ? [`${unsaved.length} 条路由的结论没写进库（它们还是上一轮的样子）：${unsaved.join('；')}`]
      : []),
    ...(unsettled.length > 0
      ? [
          `会话用户挂的组织这会儿定不下来，Claude 订阅池的 ${unsettled.length} 条路由这一轮没探、结论照旧（${unsettled.map((c) => c.target.routeId).join('、')}）：${unsettled[0]?.detail ?? ''}`,
        ]
      : []),
  ];
  if (problems.length > 0) {
    return {
      result: { outcome: 'partial', why: `${problems.join('；')}${goneNote}`, scanned, found: offline },
      online,
    };
  }
  return { result: { outcome: 'ok', scanned, found: offline }, online };
}

/**
 * 跑一轮。记开始就失败（库连不上、没登记）：原样抛出，这一轮在库里没有记录——登记表上它会变成过期，看门狗照样看得见。
 * 没跑成（读不到路由、一条都没写进去）：记成 failed 再抛 RouteProbeFailedError。记结局失败：原样抛出。
 */
export async function runRouteProbeJob(deps: RouteProbeJobDeps): Promise<RouteProbeRun> {
  const runId = await deps.runs.start(ROUTE_PROBE_JOB.id, deps.now());
  let round: { result: ScheduleResult; online: string[] };
  try {
    round = await probeRound(deps);
  } catch (err) {
    round = { result: { outcome: 'failed', why: `路由探针没跑成：${errMessage(err)}` }, online: [] };
  }
  const { result } = round;
  await deps.runs.finish(runId, result, deps.now());
  const run: RouteProbeRun = {
    runId,
    outcome: result.outcome,
    scanned: result.outcome === 'unscanned' ? 0 : (result.scanned ?? 0),
    found: result.outcome === 'unscanned' ? 0 : (result.found ?? 0),
    online: round.online,
    ...('why' in result ? { why: result.why } : {}),
  };
  const fields = { runId, outcome: run.outcome, scanned: run.scanned, found: run.found, online: run.online };
  if (run.outcome === 'failed') {
    deps.log('error', '路由探针这一轮没跑成', { ...fields, why: run.why });
    throw new RouteProbeFailedError(runId, run.why ?? '路由探针没跑成');
  }
  if (run.outcome === 'ok') deps.log('info', '路由探针跑完了', fields);
  else deps.log('warn', '路由探针这一轮没探全', { ...fields, why: run.why });
  return run;
}

/**
 * 切号切完当场探一次切过去的那个组织的池（#194 方案 4.3）：只探这一类的路由、各写一条结论，不记 schedule_runs、不再判切号
 * （调用方就是切号本身）。放慢的、这会儿定不下来没探的不算，和一轮探针里的「真探了的才算读回」同一个口径。读不到路由照抛。
 */
export async function probeOrgNow(deps: RouteProbeJobDeps, kind: OrgKind): Promise<ProbedRoute[]> {
  const mine = (await deps.targets()).filter((t) => t.orgKind === kind);
  const conclusions = await mapLimit(mine, deps.concurrency ?? ROUTE_PROBE_CONCURRENCY, (t) =>
    conclude(deps, t),
  );
  const probed: ProbedRoute[] = [];
  for (const c of conclusions) {
    if (c.kept || c.unsettled || c.backingOff) continue;
    try {
      await deps.save({
        routeId: c.target.routeId,
        state: c.state,
        at: c.at,
        detail: c.detail,
        org: c.org,
        durationMs: c.durationMs,
        requestText: c.requestText,
        responseText: c.responseText,
      });
    } catch (err) {
      // 结论没写进库不改探到的结果：核对照探到的算，写不进的下一轮探针会再写
      deps.log('error', '路由探针（切号后当场探）：结论没写进库', {
        routeId: c.target.routeId,
        error: errMessage(err),
      });
    }
    probed.push({ routeId: c.target.routeId, orgKind: c.target.orgKind, state: c.state, detail: c.detail });
  }
  return probed;
}
