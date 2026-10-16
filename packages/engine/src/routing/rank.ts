// 排序与微调：按人排的顺序取；钉住的行原地不动；没钉住的在各自模型内按三条微调重排，填回该模型剩下的位置（不跨模型）。
// 微调（设计 §九 选路第 3 条）：
//   ① 按消耗进度（#2363，policy.pace 开着时）：落后不少于 margin 的往前提（清零早的在前），超前不少于 margin 的往后放，
//      其余照人排；5 小时窗不参与排序、只挡。pace 关着时退回老的「快清零还没用完的往前提」；
//   ② 战绩明显差的往后放，样本少不动；③ 额度未知的排在读到了的后面。
// （原先还有一条「备池排在主池后面」：两个会话用户同时跑时拼车号是备池，法国只留一个会话用户后作废，#59 删掉。）
// 强弱档（决定 0099，policy.strength）：重活先给强档（强档池超前时间进度 30% 以上的模型让位）、按单号探索样本少的强档模型、
// 任何用途里强弱档相同又挨着的模型合成一组按池子消耗进度一起排。模型先后改在 models 那条线上，同一模型几个渠道之间的微调不变。
// 模型之间默认严格按用途里排的先后（#1089）。例外是动手（policy.trackScore.stages，PLAN 3f，决定 0093、0095、0098）：
// 拿到了这一档的第一段战绩、又开着 byTier 时，按收缩后的质量下界在它们自己占的位置之间重排（要比前一个高 qualityMargin
// 才往前挪），分钟只在质量分打平手时才比；这一档没有行的留在人排的位置。不再把一轮做成率差的挪到最后。
// byTier 关掉时仍按每单期望成本重排（要明显更省才挪到人排的前面），一轮做成率明显差的挪到最后、由 choose.ts 挡在动手外面
// （别的都派不了时兜底）；样本不够的模型留在人排的位置。有钉住的行时整段不动。

import {
  type ModelStrength,
  type QuotaPace,
  quotaPace,
  tierQuality as sharedTierQuality,
} from '@fleet-dao/shared';
import { duration, percent, remaining, windowName } from './names.ts';
import type { RoutingPolicy } from './policy.ts';
import type {
  ModelTierTrackFacts,
  ModelTrackFacts,
  Nudge,
  RouteFacts,
  RouteTier,
  RouteWindow,
  StageRouteEntry,
} from './types.ts';

/** 按消耗进度判出的一条路由：behind = 落后够多往前提，ahead = 超前够多往后放。 */
export interface PaceHit {
  side: 'behind' | 'ahead';
  window: RouteWindow;
  pace: QuotaPace;
  resetAt: number;
}

/** 参与按进度排的窗口：扣这条路由、读成了、上游这次报了、有已用和清零时刻；5 小时窗不算（只挡不排）。 */
function paceOf(w: RouteWindow, now: number): QuotaPace | null {
  if (w.window === '5h' || w.applies !== 'yes' || w.state !== 'ok' || w.staleSince !== null) return null;
  return quotaPace(w, now);
}

/**
 * 按消耗进度判这条路由（policy.pace 开着时用）：额度读成了（ok）才判。
 * - 有一个窗口超前不少于 margin：往后放（取超前最多的那个写理由）——照这个速度它清零前就会用完，哪怕别的窗口落后。
 * - 否则有窗口落后不少于 margin、且其余适用窗口（含 5 小时窗）都读成了、都还剩不少于 othersMinRemaining：往前提，
 *   命中几个取清零最早的。5 小时窗快满的池不因此被顶到最前（派过去也跑不完）。
 * - 都不是：null，照人排的。
 */
export function paceHit(route: RouteFacts, policy: RoutingPolicy, now: number): PaceHit | null {
  if (route.quota !== 'ok') return null;
  const margin = policy.pace.margin;
  let ahead: PaceHit | null = null;
  let behind: PaceHit | null = null;
  for (const w of route.windows) {
    const pace = paceOf(w, now);
    if (!pace || w.resetsAt === null) continue;
    const resetAt = Date.parse(w.resetsAt);
    if (-pace.behind >= margin - 1e-9) {
      if (!ahead || pace.behind < ahead.pace.behind) ahead = { side: 'ahead', window: w, pace, resetAt };
      continue;
    }
    if (pace.behind < margin - 1e-9) continue;
    const othersOk = route.windows.every((o) => {
      if (o === w) return true;
      const l = remaining(o);
      return o.applies === 'yes' && o.state === 'ok' && l !== null && l >= policy.othersMinRemaining;
    });
    if (othersOk && (!behind || resetAt < behind.resetAt))
      behind = { side: 'behind', window: w, pace, resetAt };
  }
  return ahead ?? behind;
}

/** 「池A周额度按时间该用 62%、实际用了 75%，超前 13%，往后放」。 */
function paceText(route: RouteFacts, hit: PaceHit, now: number): string {
  const { pace, window: w } = hit;
  const est = [
    pace.estimated ? `窗口长度推不出、按 30 天算` : null,
    w.reading === 'estimated' ? '用量是估算' : null,
  ].filter(Boolean);
  const note = est.length > 0 ? `（${est.join('，')}）` : '';
  const head = `${route.poolName}${windowName(w)}按时间该用 ${percent(pace.elapsed)}、实际用了 ${percent(pace.used)}${note}`;
  return hit.side === 'behind'
    ? `${head}，落后 ${percent(pace.behind)}、${duration(hit.resetAt - now)}后清零，往前提`
    : `${head}，超前 ${percent(-pace.behind)}，往后放`;
}

export interface FastResetHit {
  window: RouteWindow;
  resetAt: number;
  left: number;
}

/**
 * 快清零还没用完：某个列在 policy.fastReset 里的窗口离清零不超过 withinHours、还剩不少于 minRemaining；
 * 同时这条路由额度读成了（ok），其余适用窗口都读成了、都还剩不少于 othersMinRemaining——
 * 快用满的池（哪怕周窗快清零）不会因此被顶到前面。命中多个窗口取清零最早的。
 */
export function fastResetHit(route: RouteFacts, policy: RoutingPolicy, now: number): FastResetHit | null {
  if (route.quota !== 'ok') return null;
  let best: FastResetHit | null = null;
  for (const w of route.windows) {
    const rule = policy.fastReset[w.window];
    if (!rule || w.applies !== 'yes' || w.state !== 'ok' || w.resetsAt === null || w.staleSince !== null)
      continue;
    const left = remaining(w);
    const resetAt = Date.parse(w.resetsAt);
    if (left === null || left < rule.minRemaining) continue;
    if (resetAt <= now || resetAt - now > rule.withinHours * 3_600_000) continue;
    const othersOk = route.windows.every((o) => {
      if (o === w) return true;
      const l = remaining(o);
      return o.applies === 'yes' && o.state === 'ok' && l !== null && l >= policy.othersMinRemaining;
    });
    if (!othersOk) continue;
    if (!best || resetAt < best.resetAt) best = { window: w, resetAt, left };
  }
  return best;
}

/** 样本够、成功率低于线：明显差。样本少（或没有）不动。 */
export function poorRecord(route: RouteFacts, policy: RoutingPolicy): boolean {
  const r = route.record;
  return r !== null && r.samples >= policy.minSamples && r.successes / r.samples < policy.poorSuccessRate;
}

/** 一个模型按动手战绩打的分。 */
export interface ModelScore {
  track: ModelTrackFacts;
  /** 样本够（tasks 不少于 minTasks）才算打了分。 */
  scored: boolean;
  /** 一轮做成率（oneRound / tasks）。 */
  oneRoundRate: number;
  /** 每做成一单期望花的分钟：段数 / 做成单数 ×（每段分钟 + 每轮额外分钟）；一单没做成为 Infinity。 */
  expectedMinutes: number;
  /** 打了分、一轮做成率低于线：不进这个用途（choose.ts 兜底时除外）。按档排时一律 false。 */
  poor: boolean;
  /** 按档排时的质量下界。没有 = 走期望成本那条（决定 0095）。 */
  quality?: number;
  /** 按档排时每一段第一段的分钟（minutes / firstSegs）。只在质量分打平手时用来比。 */
  tierMinutes?: number;
  /** 快档 / 中档 / 主力档。按档排的理由里用。 */
  tierLabel?: string;
}

export function scoreOf(track: ModelTrackFacts, policy: RoutingPolicy): ModelScore {
  const ts = policy.trackScore;
  const scored = track.tasks >= ts.minTasks && track.segments > 0;
  const oneRoundRate = track.tasks > 0 ? track.oneRound / track.tasks : 0;
  const perSegment = track.segments > 0 ? track.segmentMinutes / track.segments : 0;
  const expectedMinutes =
    track.done > 0
      ? (track.segments / track.done) * (perSegment + ts.roundOverheadMinutes)
      : Number.POSITIVE_INFINITY;
  return { track, scored, oneRoundRate, expectedMinutes, poor: scored && oneRoundRate < ts.poorOneRoundRate };
}

/** 「近 14 天 16 单成 13、一轮成 1（6%）、均 2.4 段，每单约 95 分钟」。 */
export function trackText(s: ModelScore): string {
  const t = s.track;
  const avg = t.tasks > 0 ? (t.segments / t.tasks).toFixed(1) : '0';
  const cost = Number.isFinite(s.expectedMinutes)
    ? `每单约 ${Math.round(s.expectedMinutes)} 分钟`
    : '一单没做成';
  return `近 14 天 ${t.tasks} 单成 ${t.done}、一轮成 ${t.oneRound}（${Math.round(s.oneRoundRate * 100)}%）、均 ${avg} 段，${cost}`;
}

const TIER_LABEL: Record<string, string> = { fast: '快档', medium: '中档', heavyweight: '主力档' };

/**
 * 收缩后的质量下界。m = (一段过 + prior × 本档平均) / (单数 + prior)，分 = m − √(m(1−m)/(单数+prior))。
 * 本档平均由调用方按这一档全部模型的一段过之和 / 第一段之和算好。
 */
export function tierQuality(onePass: number, tasks: number, average: number, prior: number): number {
  return sharedTierQuality(onePass, tasks, average, prior);
}

/**
 * 同一档的几行打成质量下界。本档平均是一段过之和 / 第一段之和（不是各模型做成率的简单平均）。
 * 没有第一段的行跳过。调用方要先滤成同一档。
 */
export function tierScores(
  rows: readonly ModelTierTrackFacts[],
  policy: RoutingPolicy,
): Map<string, ModelScore> {
  const prior = policy.trackScore.priorTasks;
  let totalPass = 0;
  let total = 0;
  for (const r of rows) {
    totalPass += r.onePass;
    total += r.firstSegs;
  }
  const average = total > 0 ? totalPass / total : 0;
  const out = new Map<string, ModelScore>();
  for (const r of rows) {
    if (r.firstSegs <= 0) continue;
    const quality = tierQuality(r.onePass, r.firstSegs, average, prior);
    out.set(r.modelId, {
      track: {
        modelId: r.modelId,
        tasks: r.firstSegs,
        done: r.onePass,
        oneRound: r.onePass,
        segments: r.firstSegs,
        segmentMinutes: r.minutes,
      },
      scored: true,
      oneRoundRate: r.onePass / r.firstSegs,
      expectedMinutes: r.minutes / r.firstSegs,
      poor: false,
      quality,
      tierMinutes: r.minutes / r.firstSegs,
      tierLabel: TIER_LABEL[r.tier] ?? r.tier,
    });
  }
  return out;
}

/** 按质量下界在打了分的位置之间重排。要比前一个高 margin 才往前；分相同才让每段分钟更低的往前。不把谁挪到最后。 */
function orderByTierQuality(
  models: readonly string[],
  scores: ReadonlyMap<string, ModelScore>,
  policy: RoutingPolicy,
): string[] {
  const margin = policy.trackScore.qualityMargin;
  const scored = (m: string) => scores.get(m)?.quality !== undefined && scores.get(m)?.scored === true;
  const slots = models.flatMap((m, i) => (scored(m) ? [i] : []));
  const sorted: string[] = [];
  for (const m of models.filter(scored)) {
    const s = scores.get(m);
    const q = s?.quality ?? 0;
    const mins = s?.tierMinutes ?? Number.POSITIVE_INFINITY;
    let at = sorted.length;
    while (at > 0) {
      const prev = scores.get(sorted[at - 1] as string);
      const pq = prev?.quality ?? 0;
      const pm = prev?.tierMinutes ?? Number.POSITIVE_INFINITY;
      const clearlyBetter = q > pq + margin - 1e-12;
      const tie = Math.abs(q - pq) <= 1e-12 && mins < pm - 1e-9;
      if (clearlyBetter || tie) at -= 1;
      else break;
    }
    sorted.splice(at, 0, m);
  }
  const out = [...models];
  slots.forEach((slot, i) => {
    out[slot] = sorted[i] as string;
  });
  return out;
}

/**
 * 模型之间的先后（只在动手、读到了战绩时）：输入是人排的模型先后。
 * 打了分、不差的模型按期望成本在它们自己占的位置之间重排——比人排在前面的那个明显省（低 promoteMargin 以上）才挪到它前面；
 * 样本不够的留在原位；一轮做成率差的拿出来放到最后（按人排的先后）。
 */
export function modelOrder(
  models: readonly string[],
  scores: ReadonlyMap<string, ModelScore>,
  policy: RoutingPolicy,
): string[] {
  if (policy.trackScore.byTier && [...scores.values()].some((s) => s.quality !== undefined)) {
    return orderByTierQuality(models, scores, policy);
  }
  const margin = policy.trackScore.promoteMargin;
  const good = (m: string) => scores.get(m)?.scored === true && scores.get(m)?.poor !== true;
  const poor = models.filter((m) => scores.get(m)?.poor === true);
  const rest = models.filter((m) => !poor.includes(m));
  const slots = rest.flatMap((m, i) => (good(m) ? [i] : []));
  const sorted: string[] = [];
  for (const m of rest.filter(good)) {
    const cost = scores.get(m)?.expectedMinutes ?? Number.POSITIVE_INFINITY;
    let at = sorted.length;
    while (at > 0) {
      const prev = scores.get(sorted[at - 1] as string)?.expectedMinutes ?? Number.POSITIVE_INFINITY;
      if (cost < prev * (1 - margin)) at -= 1;
      else break;
    }
    sorted.splice(at, 0, m);
  }
  const out = [...rest];
  slots.forEach((slot, i) => {
    out[slot] = sorted[i] as string;
  });
  return [...out, ...poor];
}

/** 派工档在「先给强档」「探索」理由里的叫法。 */
const WORK_LABEL: Record<RouteTier, string> = { heavyweight: '重活', medium: '中档活', fast: '快档活' };
const STRENGTH_LABEL: Record<ModelStrength, string> = { strong: '强档', standard: '标准档', light: '轻档' };

/**
 * 单的编号 → [0, 1) 里的数（FNV-1a 再过一遍 murmur3 的收尾混合）。同一个编号永远同一个数，探索才「同一单重算不变」；
 * 编号挨着的单也散得开（不会连着几单都探或都不探）。
 */
export function seedDraw(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 0x1_0000_0000;
}

/** 强弱档那几条要的输入（choose.ts 按用途、派工档、策略算好）。不给 = 只做同档分流（policy.strength.pool 开着时）。 */
export interface StrengthOptions {
  /** 这一单的派工档；只用来写理由。 */
  tier: RouteTier;
  /** 先给强档（派工档在 strongFirstTiers 里、用途在 trackScore.stages 里）。 */
  strongFirst: boolean;
  /**
   * 探索：draw 是按单号算的数，ratio 是这一档的比例；samples 是各模型这一档（或整单）的样本数，没有的算 0。
   * 战绩没读成（不知道谁样本少）为空，不探。
   */
  explore: { draw: number; ratio: number; samples: ReadonlyMap<string, number> } | null;
  /**
   * 硬挡着的路由（人关了、不在这一单能用的执行方式、被避开……，choose.ts 先算好）：判让位时不算它们的进度——
   * 派不出去的渠道「持平」不能拦住能派的渠道让位（#2724）。不给 = 全算。
   */
  hardBlocked?: ReadonlySet<string>;
}

/** 一条路由读成了的窗口里超前最多的那个（5 小时窗、过期的、不扣它的不算）。没有能算进度的窗口为空。 */
function mostAhead(route: RouteFacts, now: number): { window: RouteWindow; pace: QuotaPace } | null {
  let best: { window: RouteWindow; pace: QuotaPace } | null = null;
  for (const w of route.windows) {
    const pace = paceOf(w, now);
    if (pace && (!best || pace.behind < best.pace.behind)) best = { window: w, pace };
  }
  return best;
}

/**
 * 强档的一个模型该不该让位：它额度读成了、能算进度的渠道里，每一条都有窗口超前不少于 yieldAhead。
 * 一条能算的都没有（额度未知、只有 5 小时窗）不让位。命中时返回超前最少的那条（这一档最松的一条也已经超前这么多）。
 */
function yieldHit(
  routes: readonly RouteFacts[],
  policy: RoutingPolicy,
  now: number,
): { route: RouteFacts; window: RouteWindow; pace: QuotaPace } | null {
  let least: { route: RouteFacts; window: RouteWindow; pace: QuotaPace } | null = null;
  for (const route of routes) {
    if (route.quota !== 'ok') continue;
    const hit = mostAhead(route, now);
    if (!hit) continue;
    if (-hit.pace.behind < policy.strength.yieldAhead - 1e-9) return null;
    if (!least || hit.pace.behind > least.pace.behind) least = { route, ...hit };
  }
  return least;
}

/** 同档分流：按模型先后，强弱档相同（都标了）、挨着的模型合成一组。alone 里的（这一单探索的那个）自己一组，不被进度挤下第一。 */
function strengthGroups(
  models: readonly string[],
  strengthOf: ReadonlyMap<string, ModelStrength | null>,
  alone: string | null,
): string[][] {
  const groups: string[][] = [];
  for (const m of models) {
    const s = strengthOf.get(m) ?? null;
    const last = groups[groups.length - 1];
    const lastStrength = last ? (strengthOf.get(last[0] as string) ?? null) : null;
    if (last && s !== null && s === lastStrength && m !== alone && last[0] !== alone) last.push(m);
    else groups.push([m]);
  }
  return groups;
}

export interface Ranked {
  route: RouteFacts;
  entry: StageRouteEntry;
  /** 人排的位置（0 起）。 */
  humanIndex: number;
  pinned: boolean;
  nudges: { kind: Nudge; text: string }[];
  /** 往前提的那一条（pace 开着时是落后够多的窗口，关着时是快清零的窗口）。 */
  fast: FastResetHit | null;
  /** 按进度判出的结果（pace 开着时）。 */
  pace: PaceHit | null;
}

/** 输入已按 position 排好。返回微调后的顺序。 */
export function rank(
  rows: readonly { route: RouteFacts; entry: StageRouteEntry }[],
  stagePinned: boolean,
  policy: RoutingPolicy,
  now: number,
  /** 动手按战绩排时给（choose.ts 只在用途在 trackScore.stages 里、拿到了战绩时给）；不给 = 模型之间照人排的。 */
  scores?: ReadonlyMap<string, ModelScore>,
  stageName = '这个用途',
  /** 先给强档、探索（只在动手、给了派工档时由 choose.ts 给）。同档分流不靠它，看 policy.strength.pool。 */
  strength?: StrengthOptions,
): Ranked[] {
  const items: Ranked[] = rows.map(({ route, entry }, humanIndex) => {
    const pinned = stagePinned || entry.pinned;
    const nudges: Ranked['nudges'] = [];
    const pace = pinned || !policy.pace.enabled ? null : paceHit(route, policy, now);
    const fast = pinned
      ? null
      : policy.pace.enabled
        ? pace?.side === 'behind'
          ? { window: pace.window, resetAt: pace.resetAt, left: Math.max(0, 1 - pace.pace.used) }
          : null
        : fastResetHit(route, policy, now);
    if (!pinned) {
      if (pace) {
        nudges.push({
          kind: pace.side === 'behind' ? 'pace-behind' : 'pace-ahead',
          text: paceText(route, pace, now),
        });
      } else if (fast) {
        nudges.push({
          kind: 'fast-reset',
          text: `${route.poolName}${windowName(fast.window)} ${duration(fast.resetAt - now)}后清零、还剩 ${percent(fast.left)}${fast.window.reading === 'estimated' ? '（估算）' : ''}，往前提`,
        });
      }
      if (poorRecord(route, policy) && route.record) {
        nudges.push({
          kind: 'poor-record',
          text: `战绩差（近期 ${route.record.samples} 次成 ${route.record.successes} 次），往后放`,
        });
      }
      if (route.quota === 'unknown') {
        nudges.push({ kind: 'quota-unknown', text: '额度未知（没读成或读数过期），排在读到了的后面' });
      }
    }
    return { route, entry, humanIndex, pinned, nudges, fast, pace };
  });

  const has = (it: Ranked, kind: Nudge) => it.nudges.some((n) => n.kind === kind);
  // 模型的名次在同档分流时才起作用（一组里几个模型的渠道一起排，进度打平手时按模型先后）；同一个模型里是同一个数
  let modelRank = new Map<string, number>();
  const key = (it: Ranked): number[] => [
    has(it, 'quota-unknown') ? 1 : 0,
    it.fast ? 0 : it.pace?.side === 'ahead' ? 2 : 1,
    it.fast ? it.fast.resetAt : 0,
    has(it, 'poor-record') ? 1 : 0,
    modelRank.get(it.route.modelId) ?? 0,
    it.humanIndex,
  ];
  const cmp = (a: Ranked, b: Ranked) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i += 1) {
      const d = (ka[i] ?? 0) - (kb[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  };
  // 动手按战绩排模型（有钉住的行就整段不动：钉住就是人要它在那个位置）
  const anyPinned = items.some((it) => it.pinned);
  const byScore = scores && scores.size > 0 && !anyPinned ? scores : null;
  const humanModels = [...new Set(items.map((it) => it.route.modelId))];
  let models = byScore ? modelOrder(humanModels, byScore, policy) : humanModels;
  if (byScore) {
    for (const it of items) {
      const s = byScore.get(it.route.modelId);
      if (!s) continue;
      if (s.quality !== undefined) {
        const from = humanModels.indexOf(it.route.modelId);
        const to = models.indexOf(it.route.modelId);
        const moved = to !== from ? `，按这一档排第 ${to + 1} 个模型（人排第 ${from + 1} 个）` : '';
        const each = Math.round(s.tierMinutes ?? 0);
        const label = s.tierLabel ?? '这一档';
        it.nudges.push({
          kind: 'track-score',
          text: `动手战绩：${label} ${s.track.tasks} 单一段过 ${s.track.oneRound}（${Math.round(s.oneRoundRate * 100)}%），质量下界 ${s.quality.toFixed(2)}，每段约 ${each} 分钟${moved}`,
        });
        continue;
      }
      if (s.poor) {
        it.nudges.push({
          kind: 'poor-one-round',
          text: `动手战绩：${trackText(s)}；一轮做成率低于 ${Math.round(policy.trackScore.poorOneRoundRate * 100)}%，不进${stageName}（别的模型都派不了、又不只是在等空位时才兜底）`,
        });
        continue;
      }
      const from = humanModels.indexOf(it.route.modelId);
      const to = models.indexOf(it.route.modelId);
      const moved = to !== from ? `，按战绩排第 ${to + 1} 个模型（人排第 ${from + 1} 个）` : '';
      it.nudges.push({
        kind: 'track-score',
        text: s.scored
          ? `动手战绩：${trackText(s)}${moved}`
          : `动手战绩样本不够（${s.track.tasks} 单，少于 ${policy.trackScore.minTasks}），按人排的位置${moved}`,
      });
    }
  }

  // 强弱档（决定 0099）：有钉住的行同样整段不动
  const strengthOf = new Map<string, ModelStrength | null>();
  for (const it of items) {
    if (!strengthOf.has(it.route.modelId)) strengthOf.set(it.route.modelId, it.route.strength ?? null);
  }
  const itemsOf = (m: string) => items.filter((it) => it.route.modelId === m);
  const say = (m: string, kind: Nudge, text: string) => {
    for (const it of itemsOf(m)) it.nudges.push({ kind, text });
  };
  const yielded = new Set<string>();
  let explored: string | null = null;
  if (strength?.strongFirst && !anyPinned) {
    const work = WORK_LABEL[strength.tier];
    const blocked = strength.hardBlocked ?? new Set<string>();
    const strong = models.filter((m) => strengthOf.get(m) === 'strong');
    // 强档分三种：不超前的（先派）、能派的渠道都超前的（让位）、渠道全被硬挡的（派不出，不算「不超前」）。
    // 让位只在强档之间换（#2724）：让位的排在不超前的强档后面、仍在别的档前面；强档都超前时照派强档，不让给标准档
    const lifted: string[] = [];
    const out: string[] = [];
    const hits = new Map<string, NonNullable<ReturnType<typeof yieldHit>>>();
    for (const m of strong) {
      const open = itemsOf(m)
        .map((it) => it.route)
        .filter((r) => !blocked.has(r.routeId));
      if (open.length === 0) {
        out.push(m);
        continue;
      }
      const hit = yieldHit(open, policy, now);
      if (hit) hits.set(m, hit);
      else lifted.push(m);
    }
    const allAhead = lifted.length === 0;
    for (const [m, hit] of hits) {
      yielded.add(m);
      const detail = `${hit.route.poolName}${windowName(hit.window)}按时间该用 ${percent(hit.pace.elapsed)}、实际用了 ${percent(hit.pace.used)}`;
      say(
        m,
        'strength-yield',
        allAhead
          ? `强档都超前，照派：强档池超前 ${percent(-hit.pace.behind)}（${detail}），不让给别的档`
          : `强档池超前 ${percent(-hit.pace.behind)}（${detail}），让给强档 ${lifted[0]}`,
      );
    }
    // 让位的强档之间：超前少的在前（同一个数照原来的先后）
    const yieldedOrder = strong
      .filter((m) => hits.has(m))
      .sort((a, b) => (hits.get(b)?.pace.behind ?? 0) - (hits.get(a)?.pace.behind ?? 0));
    const strongOrder = [...lifted, ...out, ...yieldedOrder];
    const next = [...strongOrder, ...models.filter((m) => !strongOrder.includes(m))];
    next.forEach((m, i) => {
      const was = models.indexOf(m);
      if (strongOrder.includes(m) && i < was) say(m, 'strength-first', `${work}先给强档：${m}`);
      else if (!strongOrder.includes(m) && i > was) {
        const s = strengthOf.get(m);
        say(m, 'strength-first', `${work}先给强档，${s ? STRENGTH_LABEL[s] : '没标档的模型'}排在强档后面`);
      }
    });
    models = next;
  }
  if (strength?.explore && !anyPinned) {
    const { draw, ratio, samples } = strength.explore;
    const min = policy.trackScore.minTasks;
    const thin = models.filter(
      (m) => strengthOf.get(m) === 'strong' && !yielded.has(m) && (samples.get(m) ?? 0) < min,
    );
    if (draw < ratio && thin.length > 0) {
      // draw < ratio 时 draw / ratio 在 [0, 1) 里均匀：同一个数既决定探不探、又决定探哪个
      const pick = thin[Math.min(thin.length - 1, Math.floor((draw / ratio) * thin.length))] as string;
      say(
        pick,
        'explore',
        `探索：${pick} ${WORK_LABEL[strength.tier]}样本 ${samples.get(pick) ?? 0} 单，少于 ${min}，这一单提到第一（约 ${Math.round(ratio * 100)}% 的${WORK_LABEL[strength.tier]}按单号探一次，攒战绩）`,
      );
      models = [pick, ...models.filter((m) => m !== pick)];
      explored = pick;
    }
  }

  // 微调只在同一个模型的几个渠道之间排：模型之间按上面定的先后，后面模型的渠道不能插到前面模型前面。
  // 例外是同档分流：强弱档相同、挨着的几个模型合成一组，组内所有渠道一起按同一套微调排（policy.strength.pool）。
  // 钉住的留在原位，每个模型里没钉住的按微调后的先后填回这个模型自己剩下的位置。
  modelRank = new Map(models.map((m, i) => [m, i]));
  const movableByModel = new Map<string, Ranked[]>();
  for (const it of items) {
    if (it.pinned) continue;
    const list = movableByModel.get(it.route.modelId) ?? [];
    list.push(it);
    movableByModel.set(it.route.modelId, list);
  }
  for (const list of movableByModel.values()) list.sort(cmp);
  const groups =
    policy.strength.pool && !anyPinned
      ? strengthGroups(models, strengthOf, explored)
      : models.map((m) => [m]);
  const reordered = models.some((m, i) => m !== humanModels[i]);
  if (!byScore && !reordered && groups.every((g) => g.length === 1)) {
    return items.map((it) => (it.pinned ? it : (movableByModel.get(it.route.modelId)?.shift() as Ranked)));
  }
  return groups.flatMap((g) => {
    if (g.length === 1) return movableByModel.get(g[0] as string) ?? [];
    const list = g.flatMap((m) => movableByModel.get(m) ?? []).sort(cmp);
    poolNudges(list, modelRank, strengthOf);
    return list;
  });
}

/**
 * 同档分流排完一组后：挪到了同档前面模型的渠道前面的，写一句为什么（「与 X 同档，X 的池超前 Y%，先用这条」）。
 * 只写给第一次越过的那个模型（排得最前的那个）。
 */
function poolNudges(
  list: Ranked[],
  modelRank: ReadonlyMap<string, number>,
  strengthOf: ReadonlyMap<string, ModelStrength | null>,
): void {
  const rankOf = (it: Ranked) => modelRank.get(it.route.modelId) ?? 0;
  list.forEach((it, i) => {
    const passed = list.slice(i + 1).filter((o) => rankOf(o) < rankOf(it));
    if (passed.length === 0) return;
    const first = passed.reduce((a, b) => (rankOf(b) < rankOf(a) ? b : a));
    // 越过的那个模型排得最前的渠道（它自己最好的一条也排到了这条后面）
    const best = list.find((o) => o.route.modelId === first.route.modelId) as Ranked;
    const x = best.route.modelId;
    const label = STRENGTH_LABEL[strengthOf.get(x) as ModelStrength];
    const head = `与 ${x} 同档（${label}）`;
    let why: string;
    if (best.pace?.side === 'ahead') why = `${x} 的池超前 ${percent(-best.pace.pace.behind)}，先用这条`;
    else if (it.pace?.side === 'behind') why = `这条的池落后 ${percent(it.pace.pace.behind)}，先用这条`;
    else if (best.nudges.some((n) => n.kind === 'quota-unknown')) why = `${x} 额度未知，先用这条`;
    else if (it.fast) why = `这条的池快清零还没用完，先用这条`;
    else why = '按池子消耗进度先用这条';
    it.nudges.push({ kind: 'strength-pool', text: `${head}，${why}` });
  });
}
