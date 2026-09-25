// 排序与微调：按人排的顺序取；钉住的行原地不动；没钉住的按四条微调重排，填回剩下的位置。
// 微调（设计 §九 选路第 3 条 + 创始人 2026-09-25 补的主池 / 备池）：
//   ① 快清零还没用完的往前提（清零早的在前）；② 战绩明显差的往后放，样本少不动；
//   ③ 额度未知的排在读到了的后面；④ 备池排在主池后面（快清零提前的备池除外——提前就是为了赶在清零前用掉它）。

import { duration, percent, remaining, windowName } from './names.ts';
import type { RoutingPolicy } from './policy.ts';
import type { Nudge, RouteFacts, RouteWindow, StageRouteEntry } from './types.ts';

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
      if (route.poolRole === 'backup' && !fast) {
        nudges.push({ kind: 'backup-pool', text: `${route.poolName}是备池，排在主池后面` });
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
    has(it, 'backup-pool') ? 1 : 0,
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
  const movable = items.filter((it) => !it.pinned).sort(cmp);
  // 钉住的留在原位，没钉住的按微调后的先后填进其余位置。
  return items.map((it) => (it.pinned ? it : (movable.shift() as Ranked)));
}
