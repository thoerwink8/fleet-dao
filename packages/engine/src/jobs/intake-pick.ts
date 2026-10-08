// 拉单挑单的纯判断（#1336，母单 #1335 第 1 片）：候选多于空位时按什么排、每小时最多起几条、失败多了停拉的熔断。
// 全是纯函数，不读库不读 GitHub：数据由 jobs/intake.ts 经依赖交进来，这里只做判断，所以每条规则都能单独测。
// 规则的出处：docs/design.md 第九节「引擎自己挑单」、决定 0031（创始人 2026-10-08：「让ai自己挑挺好的」「按推荐」）。

import { parseOrder } from '@fleet-dao/conventions';

/** 每小时最多起几条任务（滚动一小时，数已建出的任务行）。 */
export const MAX_STARTS_PER_HOUR = 3;
/** 一张单历史上失败超过这么多次就不再拉（要再做，人看过原因后重做）。 */
export const MAX_ISSUE_FAILURES = 2;
/** 熔断看最近几条已结束的任务。 */
export const BREAKER_WINDOW = 6;
/** 窗口里失败几条算「过半」：6 条里 4 条。 */
export const BREAKER_FAILS = 4;
/** 熔断后冷却多久才放一条试探。 */
export const BREAKER_COOLDOWN_MS = 60 * 60_000;
export const HOUR_MS = 60 * 60_000;

// —— 排序 ——

/** 一张候选单排序要看的东西。 */
export interface PickKey {
  /** 在它挂的版本的先后列表里排第几（从 1 起）；不在列表里或没挂版本是 null。 */
  serial: number | null;
  /** 挂在当前版本上。 */
  current: boolean;
  /** 规模档：0 快、1 中、2 主力。 */
  tierRank: 0 | 1 | 2;
  /** 单子「已知的模块」列的路径数（同档里再比大小）。 */
  moduleCount: number;
  /** 贴了「交给引擎」：同一规模档里靠前。 */
  handed: boolean;
  /** 历史失败次数。 */
  failures: number;
  /** 开单时刻（毫秒）。 */
  createdAtMs: number;
}

/**
 * 排序：版本先后列表里的序号（小的先，没排进去的最后）→ 挂当前版本的 → 规模小 → 同规模里贴了「交给引擎」的 → 历史失败少 → 开单早。
 * 返回负数＝a 排在 b 前面。
 */
export function comparePick(a: PickKey, b: PickKey): number {
  const sa = a.serial ?? Number.POSITIVE_INFINITY;
  const sb = b.serial ?? Number.POSITIVE_INFINITY;
  if (sa !== sb) return sa < sb ? -1 : 1;
  if (a.current !== b.current) return a.current ? -1 : 1;
  if (a.tierRank !== b.tierRank) return a.tierRank - b.tierRank;
  if (a.moduleCount !== b.moduleCount) return a.moduleCount - b.moduleCount;
  if (a.handed !== b.handed) return a.handed ? -1 : 1;
  if (a.failures !== b.failures) return a.failures - b.failures;
  return a.createdAtMs - b.createdAtMs;
}

/** 按 comparePick 排好（不改原数组）；前面都一样时保持原来的先后，结果可复现。 */
export function sortCandidates<T>(items: readonly T[], keyOf: (item: T) => PickKey): T[] {
  return items
    .map((item, i) => ({ item, i, key: keyOf(item) }))
    .sort((x, y) => comparePick(x.key, y.key) || x.i - y.i)
    .map((x) => x.item);
}

/** 每个版本里程碑的先后：里程碑编号 → (单号 → 序号)。 */
export type OrderBook = ReadonlyMap<number, ReadonlyMap<number, number>>;

/**
 * 从还开着的里程碑说明里读各版本的先后（认法是 conventions 的 parseOrder，和 pnpm plan、对账同一份）。
 * 说明里没有先后标记、认不出的版本，这个版本的单一律算「没排进去」，原因记进 problems（调用方写日志，不拦拉单：
 * 先后的对错由每天的 GitHub 对账管）。
 */
export function readOrderBook(milestones: readonly { number: number; title: string; description: string }[]): {
  book: OrderBook;
  problems: string[];
} {
  const book = new Map<number, ReadonlyMap<number, number>>();
  const problems: string[] = [];
  for (const m of milestones) {
    const parsed = parseOrder(m.description);
    if (!parsed.ok) {
      problems.push(`里程碑「${m.title}」：${parsed.problem}`);
      continue;
    }
    book.set(m.number, new Map(parsed.order.map((issue, i) => [issue, i + 1])));
  }
  return { book, problems };
}

/** 这张单在它挂的版本的先后里排第几；没挂版本、版本没先后、没排进去都是 null。 */
export function serialOf(book: OrderBook, milestone: { number: number } | null, issueNumber: number): number | null {
  if (milestone === null) return null;
  return book.get(milestone.number)?.get(issueNumber) ?? null;
}

// —— 验收条看得见看不见 ——

/**
 * 验收条里有没有「在 diff 里看得见」的结构信号：反引号括起来的东西、路径（带 /）、文件名（名字.扩展名）、「」括起来的界面文字、数字。
 * 只判结构，不判意思：一条都没有信号时回 false，调用方当作「拿不准」只记录、不拦（判意思的事不写关键词大表）。
 */
export function hasVisibleSignal(acceptance: readonly string[]): boolean {
  const signal = /`[^`]+`|[\w.-]+\/[\w./-]+|\b[\w-]+\.[A-Za-z][A-Za-z0-9]{0,7}\b|「[^」]+」|\d/;
  return acceptance.some((line) => signal.test(line));
}

// —— 熔断 ——

/**
 * 熔断此刻的样子（由真依赖从库里拼）：
 * - open 不空：熔断着。since 是进入（或试探失败后重新计冷却）的时刻；trial 是 since 之后建出的第一条任务的结局（没起过是 null）；
 * - open 是 null：正常。recent 是上次恢复之后结束的最近几条（新的在前，done / failed）。
 */
export interface BreakerFacts {
  open: { since: Date; trial: 'running' | 'done' | 'failed' | null } | null;
  recent: readonly { state: 'done' | 'failed' }[];
}

export type BreakerEvent = 'trip' | 'recover' | 'retrip';

export interface BreakerVerdict {
  /** 这一轮最多再起几条（正常时是 Infinity）。 */
  allow: number;
  /** 状态变了要做的事：trip 进入熔断（推通知）、recover 恢复（推通知）、retrip 试探失败重新冷却（不再推）。 */
  event: BreakerEvent | null;
  why: string;
}

/**
 * 熔断：最近 6 条已结束的任务里失败 4 条以上就停拉；冷却 1 小时后只放 1 条试探，试探成功才恢复，试探失败重新冷却一小时。
 * 「叫停」不算成败（读的时候就没取）。
 */
export function decideBreaker(f: BreakerFacts, now: Date): BreakerVerdict {
  if (f.open === null) {
    const window = f.recent.slice(0, BREAKER_WINDOW);
    const fails = window.filter((r) => r.state === 'failed').length;
    if (fails >= BREAKER_FAILS) {
      return {
        allow: 0,
        event: 'trip',
        why: `最近 ${window.length} 条结束的任务里失败了 ${fails} 条，过半：停拉，冷却 1 小时后放 1 条试探`,
      };
    }
    return { allow: Number.POSITIVE_INFINITY, event: null, why: '' };
  }
  const { since, trial } = f.open;
  if (trial === 'done') {
    return { allow: Number.POSITIVE_INFINITY, event: 'recover', why: '试探的那条任务做成了：恢复拉单' };
  }
  if (trial === 'failed') {
    return { allow: 0, event: 'retrip', why: '试探的那条任务也没成：继续停拉，从现在起再冷却 1 小时' };
  }
  if (trial === 'running') return { allow: 0, event: null, why: '熔断中：试探的那条任务还在跑，等它的结局' };
  const readyAt = since.getTime() + BREAKER_COOLDOWN_MS;
  if (now.getTime() < readyAt) {
    return { allow: 0, event: null, why: `熔断中：冷却到 ${new Date(readyAt).toISOString()}，之后只放 1 条试探` };
  }
  return { allow: 1, event: null, why: '熔断冷却完了：这一轮只放 1 条试探，成了才恢复' };
}

/** 每小时限速还剩几个名额。 */
export function hourlyRemaining(startedInLastHour: number, max: number = MAX_STARTS_PER_HOUR): number {
  return Math.max(0, max - startedInLastHour);
}
