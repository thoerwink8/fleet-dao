// 排序与微调：按人排的顺序取；钉住的行原地不动；没钉住的在各自模型内按三条微调重排，填回该模型剩下的位置（不跨模型）。
// 微调（设计 §九 选路第 3 条）：
//   ① 快清零还没用完的往前提（清零早的在前）；② 战绩明显差的往后放，样本少不动；
//   ③ 额度未知的排在读到了的后面。
// （原先还有一条「备池排在主池后面」：两个会话用户同时跑时拼车号是备池，法国只留一个会话用户后作废，#59 删掉。）
// 模型之间默认严格按用途里排的先后（#1089）。例外是动手（policy.trackScore.stages，PLAN 3f，决定 0093）：拿到了各模型的动手战绩时，
// 打了分的模型按每单期望成本在它们自己占的位置之间重排（要明显更省才挪到人排的前面），一轮做成率明显差的挪到最后、由 choose.ts
// 挡在动手外面（别的都派不了时兜底）；样本不够的模型留在人排的位置。有钉住的行时整段不动。

import { duration, percent, remaining, windowName } from './names.ts';
import type { RoutingPolicy } from './policy.ts';
import type { ModelTrackFacts, Nudge, RouteFacts, RouteWindow, StageRouteEntry } from './types.ts';

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
  /** 打了分、一轮做成率低于线：不进这个用途（choose.ts 兜底时除外）。 */
  poor: boolean;
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

/** 「近 7 天 16 单成 13、一轮成 1（6%）、均 2.4 段，每单约 95 分钟」。 */
export function trackText(s: ModelScore): string {
  const t = s.track;
  const avg = t.tasks > 0 ? (t.segments / t.tasks).toFixed(1) : '0';
  const cost = Number.isFinite(s.expectedMinutes)
    ? `每单约 ${Math.round(s.expectedMinutes)} 分钟`
    : '一单没做成';
  return `近 7 天 ${t.tasks} 单成 ${t.done}、一轮成 ${t.oneRound}（${Math.round(s.oneRoundRate * 100)}%）、均 ${avg} 段，${cost}`;
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

export interface Ranked {
  route: RouteFacts;
  entry: StageRouteEntry;
  /** 人排的位置（0 起）。 */
  humanIndex: number;
  pinned: boolean;
  nudges: { kind: Nudge; text: string }[];
  fast: FastResetHit | null;
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
): Ranked[] {
  const items: Ranked[] = rows.map(({ route, entry }, humanIndex) => {
    const pinned = stagePinned || entry.pinned;
    const nudges: Ranked['nudges'] = [];
    const fast = pinned ? null : fastResetHit(route, policy, now);
    if (!pinned) {
      if (fast) {
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
    return { route, entry, humanIndex, pinned, nudges, fast };
  });

  const has = (it: Ranked, kind: Nudge) => it.nudges.some((n) => n.kind === kind);
  const key = (it: Ranked): number[] => [
    has(it, 'quota-unknown') ? 1 : 0,
    it.fast ? 0 : 1,
    it.fast ? it.fast.resetAt : 0,
    has(it, 'poor-record') ? 1 : 0,
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
  const byScore = scores && scores.size > 0 && !items.some((it) => it.pinned) ? scores : null;
  const humanModels = [...new Set(items.map((it) => it.route.modelId))];
  const models = byScore ? modelOrder(humanModels, byScore, policy) : humanModels;
  if (byScore) {
    for (const it of items) {
      const s = byScore.get(it.route.modelId);
      if (!s) continue;
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

  // 微调只在同一个模型的几个渠道之间排：模型之间严格按用途里排的先后，后面模型的渠道不能插到前面模型前面。
  // 钉住的留在原位，每个模型里没钉住的按微调后的先后填回这个模型自己剩下的位置。
  const movableByModel = new Map<string, Ranked[]>();
  for (const it of items) {
    if (it.pinned) continue;
    const list = movableByModel.get(it.route.modelId) ?? [];
    list.push(it);
    movableByModel.set(it.route.modelId, list);
  }
  for (const list of movableByModel.values()) list.sort(cmp);
  if (byScore) return models.flatMap((m) => movableByModel.get(m) ?? []);
  return items.map((it) => (it.pinned ? it : (movableByModel.get(it.route.modelId)?.shift() as Ranked)));
}
