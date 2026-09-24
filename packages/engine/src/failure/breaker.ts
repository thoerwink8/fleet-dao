// 路由熔断：输入这条路由最近的结果序列，输出路由状态。纯函数、不存状态：每次从结果现算，不会留下没人解除的熔断。
// 标准断路器：closed —连续失败或失败率到线→ open（冷却）—到点→ half_open（只放一个试探）—成→ closed，败→ open（冷却翻倍）。
// 按真实流量算，不只算探针（windsurf-dao#1342：探针绿的时候真实流量可以 2 成 6 败）：
// - 失败率只数真实流量；
// - 探针失败和真实流量失败一样计连败，探针成功不清零真实流量的连败；
// - 半开时只有真实流量的试探成功才关上、才清零熔断次数；探针成功不算恢复（探针只能拦，不能放）；
// - neutral（我们自己停的、断流、账号池的事、任务自己的问题）不进分母（#1386：断流进了分母，一条真干出活的路由被判死）。

import { type Bound, count, fraction, positive, resolvePolicy } from './policy.ts';
import { parseTime } from './scan.ts';

export interface RouteOutcome {
  /** 这一次结束的时刻，ISO。 */
  at: string;
  result: 'ok' | 'fail' | 'neutral';
  /** 不给 = 真实流量。 */
  source?: 'traffic' | 'probe';
}

export interface BreakerPolicy {
  /** 连续失败几次就熔断。 */
  consecutiveFailures: number;
  /** 算失败率的窗口；至少几次真实流量才算、失败率到多少熔断（#1342：好路由 0–30%、坏路由 52–75%）。 */
  windowMinutes: number;
  minSamples: number;
  failureRate: number;
  /** 第一次熔断冷却多久，之后每次试探失败翻倍，封顶 maxCooldownMinutes（起步 10 分钟取自盲设计题 Grok 臂）。 */
  cooldownMinutes: number;
  maxCooldownMinutes: number;
  /** 冷却按路由编号确定性地错开 ±这个比例：同一次事件里一批路由一起熔断，解冻时刻不挤在一起（windsurf-dao#1230）。 */
  jitterRatio: number;
}

const RESULTS: readonly RouteOutcome['result'][] = ['ok', 'fail', 'neutral'];

export const DEFAULT_BREAKER_POLICY: Readonly<BreakerPolicy> = Object.freeze({
  consecutiveFailures: 3,
  windowMinutes: 360,
  minSamples: 8,
  failureRate: 0.6,
  cooldownMinutes: 10,
  maxCooldownMinutes: 120,
  jitterRatio: 0.1,
});

export interface RouteBreakerState {
  state: 'closed' | 'open' | 'half_open';
  /** all = 照常派；trial = 放一个试探；none = 不派（开着，或半开但已经有一个试探在跑）。 */
  admit: 'all' | 'trial' | 'none';
  reason: string;
  /** 这一轮熔断开始的时刻。 */
  openedAt?: string;
  /** 几点起放试探。 */
  probeAt?: string;
  /** 连着熔断了几次（试探失败再开一次算一次）；只在真实流量试探成功、关上时清零。 */
  trips: number;
  consecutiveFailures: number;
  /** 窗口内的真实流量（不含探针、不含 neutral）。 */
  window: { samples: number; failures: number; failureRate: number | null };
}

export interface RouteBreakerOptions {
  now: string;
  /** 这条路由此刻在途的会话数。半开时在途的就是试探：已经有一个在跑，就不再放。 */
  inFlight: number;
  routeId?: string;
  policy?: Partial<BreakerPolicy>;
}

/** 时刻、结果、在途数认不出就抛错（调用方按「熔断没查成」处理），不会把读坏的记录当成「没有失败」。 */
export function routeBreaker(
  outcomes: readonly RouteOutcome[],
  options: RouteBreakerOptions,
): RouteBreakerState {
  const policy = resolveBreakerPolicy(options.policy);
  const now = parseTime(options.now);
  // 认不出的输入报错，不当成「没有结果 = 正常」：结果读坏了的路由不能显得健康。
  if (now === undefined) throw new Error(`熔断判不了：现在的时刻认不出（${String(options.now)}）`);
  if (!Number.isInteger(options.inFlight) || options.inFlight < 0) {
    throw new Error(`熔断判不了：在途数认不出（${String(options.inFlight)}）`);
  }
  const events = outcomes.map((o, index) => {
    const t = parseTime(o.at);
    if (t === undefined) throw new Error(`熔断判不了：第 ${index + 1} 条结果的时刻认不出（${String(o.at)}）`);
    if (!RESULTS.includes(o.result)) {
      throw new Error(`熔断判不了：第 ${index + 1} 条结果认不出（${String(o.result)}）`);
    }
    return { ...o, t, index };
  });
  events.sort((a, b) => a.t - b.t || a.index - b.index);

  const m: Machine = {
    state: 'closed',
    streak: 0,
    trips: 0,
    openedAt: 0,
    openUntil: 0,
    windowStart: Number.NEGATIVE_INFINITY,
    why: '',
    traffic: [],
  };
  const jitter = 1 + jitterOf(options.routeId, policy.jitterRatio);

  for (const e of events) {
    // 还没发生的（时刻在现在之后）不算。
    if (e.t > now) continue;
    if (m.state === 'open' && e.t >= m.openUntil) m.state = 'half_open';
    if (e.result === 'neutral') continue;
    // 冷却期间结束的，是开闸前就派出去的，不算试探。
    if (m.state === 'open') continue;
    const probe = e.source === 'probe';
    if (m.state === 'half_open') {
      if (e.result === 'fail') {
        trip(m, policy, jitter, e.t, `${probe ? '探针' : '真实流量'}试探又失败`);
      } else if (!probe) {
        m.state = 'closed';
        m.trips = 0;
        m.streak = 0;
        m.windowStart = e.t;
        m.why = `真实流量试探成功，${stamp(e.t)} 恢复`;
      }
      // 探针成功：不算恢复，还是半开，等一次真实流量的试探。
      continue;
    }
    if (!probe) m.traffic.push({ t: e.t, fail: e.result === 'fail' });
    if (e.result === 'fail') m.streak += 1;
    else if (!probe) m.streak = 0;
    if (m.streak >= policy.consecutiveFailures) {
      trip(m, policy, jitter, e.t, `连续失败 ${m.streak} 次`);
      continue;
    }
    const w = windowStats(m, policy, e.t);
    if (!probe && w.samples >= policy.minSamples && w.failures / w.samples >= policy.failureRate) {
      const pct = Math.round((w.failures / w.samples) * 100);
      trip(
        m,
        policy,
        jitter,
        e.t,
        `${hours(policy.windowMinutes)}内真实流量 ${w.samples} 次、失败 ${w.failures} 次（${pct}%）`,
      );
    }
  }
  if (m.state === 'open' && now >= m.openUntil) m.state = 'half_open';

  const w = windowStats(m, policy, now);
  const base = {
    trips: m.trips,
    consecutiveFailures: m.streak,
    window: { ...w, failureRate: w.samples > 0 ? w.failures / w.samples : null },
  };
  if (m.state === 'open') {
    return {
      ...base,
      state: 'open',
      admit: 'none',
      reason: `${m.why}：熔断，${stamp(m.openUntil)} 再放一个试探`,
      openedAt: iso(m.openedAt),
      probeAt: iso(m.openUntil),
    };
  }
  if (m.state === 'half_open') {
    const busy = options.inFlight > 0;
    return {
      ...base,
      state: 'half_open',
      admit: busy ? 'none' : 'trial',
      reason: `${m.why}：冷却到点（${stamp(m.openUntil)}），${
        busy ? `已经有 ${options.inFlight} 个在途当试探，等它的结果` : '放一个真实流量去试探'
      }`,
      openedAt: iso(m.openedAt),
      probeAt: iso(m.openUntil),
    };
  }
  const summary = `${hours(policy.windowMinutes)}内真实流量 ${w.samples} 次、失败 ${w.failures} 次`;
  return {
    ...base,
    state: 'closed',
    admit: 'all',
    reason: m.why ? `正常（${m.why}）：${summary}` : `正常：${summary}`,
  };
}

interface Machine {
  state: RouteBreakerState['state'];
  streak: number;
  trips: number;
  openedAt: number;
  openUntil: number;
  /** 恢复之后只数恢复之后的流量：熔断前的失败不再算。 */
  windowStart: number;
  why: string;
  traffic: { t: number; fail: boolean }[];
}

function trip(m: Machine, policy: BreakerPolicy, jitter: number, at: number, because: string): void {
  m.trips += 1;
  const minutes = Math.min(policy.cooldownMinutes * 2 ** (m.trips - 1), policy.maxCooldownMinutes);
  m.state = 'open';
  m.openedAt = at;
  m.openUntil = at + Math.round(minutes * 60_000 * jitter);
  m.streak = 0;
  m.why = because;
}

function windowStats(m: Machine, policy: BreakerPolicy, at: number): { samples: number; failures: number } {
  const from = Math.max(m.windowStart, at - policy.windowMinutes * 60_000);
  const inWindow = m.traffic.filter((s) => s.t > from && s.t <= at);
  return { samples: inWindow.length, failures: inWindow.filter((s) => s.fail).length };
}

/** 一组候选路由各自的熔断状态。 */
export interface RouteBreakerEntry {
  routeId: string;
  breaker: RouteBreakerState;
}

/**
 * 候选路由全都熔断了：多半是共用的一层坏了（本机网络、中转服务），不是每条路由各自坏。
 * 这时不剔空候选（那是零吞吐），放最早到点的一条去试探，并报警点名（windsurf-dao#1386 之后：16 张单全部「健康表红，不派」）。
 */
export function whenAllOpen(
  entries: readonly RouteBreakerEntry[],
): { allOpen: false } | { allOpen: true; trialRouteId: string; reason: string } {
  const first = entries[0];
  if (!first || entries.length < 2 || entries.some((e) => e.breaker.state !== 'open'))
    return { allOpen: false };
  const earliest = entries.reduce((a, b) => (probeMs(b) < probeMs(a) ? b : a), first);
  return {
    allOpen: true,
    trialRouteId: earliest.routeId,
    reason: `${entries.length} 条候选路由同时熔断，多半是共用的一层坏了（本机网络、中转服务）：不剔空候选，先放 ${earliest.routeId} 试探，并报警`,
  };
}

function probeMs(entry: RouteBreakerEntry): number {
  return parseTime(entry.breaker.probeAt) ?? Number.POSITIVE_INFINITY;
}

/** 按路由编号确定性地给一个 [-ratio, ratio] 的偏移（FNV-1a）；没编号就不偏。 */
export function jitterOf(routeId: string | undefined, ratio: number): number {
  if (!routeId || ratio <= 0) return 0;
  let h = 0x811c9dc5;
  for (let i = 0; i < routeId.length; i += 1) {
    h ^= routeId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h / 0x1_0000_0000) * 2 * ratio - ratio;
}

const BREAKER_POLICY_BOUNDS: { readonly [K in keyof BreakerPolicy]: Bound } = {
  consecutiveFailures: count(1),
  windowMinutes: positive,
  minSamples: count(1),
  failureRate: { min: 0, minExclusive: true, max: 1 },
  cooldownMinutes: positive,
  maxCooldownMinutes: positive,
  // 到 1 的话冷却能被错开成 0，等于没熔断。
  jitterRatio: { ...fraction, maxExclusive: true },
};

/** 缺的取默认值，给了但不对的报错。 */
export function resolveBreakerPolicy(partial?: Partial<BreakerPolicy>): BreakerPolicy {
  const policy = resolvePolicy('熔断策略', DEFAULT_BREAKER_POLICY, BREAKER_POLICY_BOUNDS, partial);
  if (policy.maxCooldownMinutes < policy.cooldownMinutes) {
    throw new Error(
      `熔断策略的 maxCooldownMinutes（${policy.maxCooldownMinutes}）不能小于 cooldownMinutes（${policy.cooldownMinutes}）`,
    );
  }
  return policy;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function stamp(ms: number): string {
  return `${iso(ms).slice(0, 16).replace('T', ' ')} UTC`;
}

function hours(minutes: number): string {
  return minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`;
}
