// 按池压力加权抽签（决定 0104，#2757）：能力下限（floor.ts）硬过滤、挡因过滤之后，在能派的候选里按权重抽一条。
// 权重 = q × min(ρ, rhoCap)²。纯函数、确定性：抽签用的数由调用方给（seedDraw(单号:段:第几次选)），同一单同一段重算不变。
// 改这里之前必须知道：
// - ρ（池压力）= 剩余比例 ÷ 剩余时间比例，取这条路由扣的、5 小时窗以外最紧的那个窗口（最先卡住它的那个）。ρ > 1：照时间均匀用
//   也用不完、清零会作废，多喂它；ρ < 1：快用完了，少喂。读不到（额度未知、读数过期、只有 5 小时窗）按 neutralRho（1，中性），
//   不排到最后。
// - q 是动手这一档的质量下界（rank.ts 的 tierScores，和 legacy 排序同一份）；没打分的按候选里打了分的平均，一个都没打分为 1；
//   不低于 minQuality，乘数不把能派的乘没。非动手用途没有战绩，q 一律 1。
// - 中档单不进 ρ < 1 的强档池：权重记 0、写明为什么（强档快用完了，留给主力档）。权重全是 0 时调用方照人排的先后。
// - 平手（权重都一样）照人排的先后，不抽签：人排的先后只在平手时用。
import { quotaPace } from '@fleet-dao/shared';
import type { AllocatePolicy } from './policy.ts';
import type { ModelScore } from './rank.ts';
import type { RouteFacts, RouteTier } from './types.ts';

export interface RouteRho {
  rho: number;
  /** read：从读数算的；neutral：读不到，按中性。 */
  from: 'read' | 'neutral';
  /** 算 ρ 用的那个窗口（读到了才有）。 */
  label?: string;
}

/** 一条路由的池压力（纯函数）。 */
export function routeRho(route: RouteFacts, policy: AllocatePolicy, now: number): RouteRho {
  if (route.quota !== 'ok') return { rho: policy.neutralRho, from: 'neutral' };
  let best: RouteRho | null = null;
  for (const w of route.windows) {
    if (w.window === '5h' || w.applies !== 'yes' || w.state !== 'ok' || w.staleSince !== null) continue;
    const pace = quotaPace(w, now);
    if (!pace) continue;
    const timeLeft = 1 - pace.elapsed;
    if (timeLeft <= 0) continue;
    const rho = Math.max(0, 1 - pace.used) / Math.min(1, timeLeft);
    if (!best || rho < best.rho) best = { rho, from: 'read', label: w.label };
  }
  return best ?? { rho: policy.neutralRho, from: 'neutral' };
}

export interface Weighted {
  routeId: string;
  q: number;
  qFrom: 'track' | 'neutral' | 'none';
  rho: RouteRho;
  weight: number;
  /** 权重记 0 的原因（中档单不进 ρ<1 的强档池）。 */
  excluded?: string;
}

/**
 * 每条候选的权重（纯函数）。scores 是动手这一档的战绩分（非动手、没读到为空）。
 */
export function allocateWeights(
  routes: readonly RouteFacts[],
  scores: ReadonlyMap<string, ModelScore> | undefined,
  tier: RouteTier | undefined,
  policy: AllocatePolicy,
  now: number,
): Weighted[] {
  const qOf = (r: RouteFacts) => {
    const s = scores?.get(r.modelId);
    return s?.scored && s.quality !== undefined ? s.quality : null;
  };
  const known = routes.map(qOf).filter((q): q is number => q !== null);
  const neutralQ = known.length > 0 ? known.reduce((a, b) => a + b, 0) / known.length : 1;
  return routes.map((r) => {
    const raw = qOf(r);
    const q = Math.max(policy.minQuality, raw ?? neutralQ);
    const qFrom: Weighted['qFrom'] = raw !== null ? 'track' : known.length > 0 ? 'neutral' : 'none';
    const rho = routeRho(r, policy, now);
    if (tier === 'medium' && r.strength === 'strong' && rho.rho < 1) {
      return {
        routeId: r.routeId,
        q,
        qFrom,
        rho,
        weight: 0,
        excluded: `中档单不进 ρ<1 的强档池（ρ ${rho.rho.toFixed(2)}，留给主力档）`,
      };
    }
    const capped = Math.min(rho.rho, policy.rhoCap);
    return { routeId: r.routeId, q, qFrom, rho, weight: q * capped * capped };
  });
}

/**
 * 按权重抽一条：u 是 [0, 1) 里的数。候选按调用方给的先后（人排加微调后的顺序）累加，u × 总权重落在谁那一段就是谁。
 * 权重全是 0 回 null；权重都一样（平手）回第一条（照人排的先后，不抽）。
 */
export function weightedPick(weights: readonly Weighted[], u: number): number | null {
  const positive = weights.filter((w) => w.weight > 0);
  if (positive.length === 0) return null;
  const first = positive[0] as Weighted;
  if (positive.every((w) => Math.abs(w.weight - first.weight) <= 1e-12 * Math.max(1, first.weight))) {
    return weights.indexOf(first);
  }
  const total = positive.reduce((a, w) => a + w.weight, 0);
  let x = Math.min(Math.max(u, 0), 1 - 1e-12) * total;
  for (let i = 0; i < weights.length; i += 1) {
    const w = weights[i] as Weighted;
    if (w.weight <= 0) continue;
    if (x < w.weight) return i;
    x -= w.weight;
  }
  return weights.lastIndexOf(positive[positive.length - 1] as Weighted);
}

/** 理由里一条候选的权重：「grok-4.7 16.00（q 1.00 × min(ρ 6.70, 4)²）」。 */
export function weightText(label: string, w: Weighted, policy: AllocatePolicy): string {
  if (w.excluded) return `${label} 0（${w.excluded}）`;
  const rho = w.rho.from === 'read' ? `ρ ${w.rho.rho.toFixed(2)}` : `ρ 读不到按 ${policy.neutralRho}`;
  const q =
    w.qFrom === 'track'
      ? `q ${w.q.toFixed(2)}`
      : w.qFrom === 'neutral'
        ? `q 没打分按平均 ${w.q.toFixed(2)}`
        : 'q 1';
  return `${label} ${w.weight.toFixed(2)}（${q} × min(${rho}, ${policy.rhoCap})²）`;
}
