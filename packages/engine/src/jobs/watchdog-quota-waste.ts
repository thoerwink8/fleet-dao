// 看门狗的「额度快作废」（#2737）：会作废的窗口 48 小时内清零、照现速清零时预计剩不少于 30%，推一条提醒，列出这个池上
// 接得住的路由（关着的也列，人打开它就能接）。算法是 shared 的 quotaPressure（速度按最近 24 小时的额度历史，不够按本期平均）。
// 改这里之前必须知道：
// - 只看读数新、上游还在报的窗口；5 小时窗不算（只挡不排、天天清零）。额度配置 notRead 里的、过期的、没有路由挂着的池不查。
// - 一个池一条：多个窗口都中，取预计剩得最多的那个写。读新了、不再中的自己撤。
// - 正文不带每轮都变的细数：剩多少按 10% 取整，清零时刻写钟点；标题正文都没变就不改卡（看门狗 5 分钟一轮，飞书免费版有调用上限）。
// - 读不到额度表、历史、路由：这一轮这一步记没查成，开着的一条都不撤（不当成都不会作废）。
import type { QuotaSampleRow, QuotaTablePool } from '@fleet-dao/db';
import { type QuotaPressure, quotaPressure } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import { clip, stamp } from './reconcile-common.ts';

/** 额度快作废的提醒前缀，后面是池编号。 */
export const QUOTA_WASTE_PREFIX = 'watchdog:quota-waste:';
/** 多久之内清零才报。 */
export const QUOTA_WASTE_WITHIN_MS = 48 * 3_600_000;
/** 预计作废不少于这么多才报。 */
export const QUOTA_WASTE_MIN_LEFT = 0.3;
/** 算速度看多久的历史（和 shared 的 PRESSURE_RATE_LOOKBACK_MS 一样）。 */
const SAMPLE_LOOKBACK_MS = 24 * 3_600_000;

export function quotaWasteKey(poolId: string): string {
  return `${QUOTA_WASTE_PREFIX}${poolId}`;
}

/** 挂在池上的一条路由：编号、模型、路由两层的开关开没开、探针说活没活。 */
export interface PoolRouteFact {
  routeId: string;
  poolId: string;
  modelId: string;
  enabled: boolean;
  alive: boolean;
}

export interface QuotaWasteDeps {
  quotaPools(now: Date): Promise<QuotaTablePool[]>;
  quotaNotRead?: () => Promise<readonly string[]>;
  /** since 之后的额度历史（db 的 quotaSamplesSince）。读不到照抛。 */
  quotaSamples(since: Date): Promise<QuotaSampleRow[]>;
  /** 所有路由挂在哪个池、开关开没开（db 的 poolRouteFacts）。读不到照抛。 */
  poolRoutes(): Promise<PoolRouteFact[]>;
  alerts: {
    openByPrefix(prefix: string): Promise<{ dedupeKey: string; title: string; body: string }[]>;
    raise(input: { dedupeKey: string; title: string; body: string; link: string }): Promise<void>;
    resolve(input: { dedupeKey: string; why: string }): Promise<'ok' | 'already_resolved' | 'not_found'>;
  };
  log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

export interface QuotaWasteResult {
  scanned: number;
  found: number;
  problems: string[];
}

type Hit = { window: QuotaTablePool['windows'][number]; pressure: QuotaPressure };

/** 一个池里 48 小时内清零、预计作废不少于 30% 的窗口里剩得最多的那个；没有为空（纯函数）。 */
export function wasteHit(pool: QuotaTablePool, samples: readonly QuotaSampleRow[], now: Date): Hit | null {
  let best: Hit | null = null;
  for (const w of pool.windows) {
    if (w.window === '5h' || w.staleSince !== null || w.state === 'stale' || w.state === 'reset') continue;
    const pressure = quotaPressure(
      {
        window: w.window,
        label: w.label,
        used: w.utilization,
        resetsAt: w.resetsAt?.toISOString() ?? null,
        readAt: w.readAt.toISOString(),
      },
      now.getTime(),
      samples
        .filter((s) => s.poolId === pool.poolId && s.label === w.label && s.utilization !== null)
        .map((s) => ({
          readAt: s.readAt.toISOString(),
          used: s.utilization as number,
          resetsAt: s.resetsAt?.toISOString() ?? null,
        })),
    );
    if (!pressure) continue;
    if (pressure.hoursToReset * 3_600_000 > QUOTA_WASTE_WITHIN_MS) continue;
    if (pressure.leftAtReset < QUOTA_WASTE_MIN_LEFT - 1e-9) continue;
    if (!best || pressure.leftAtReset > best.pressure.leftAtReset) best = { window: w, pressure };
  }
  return best;
}

/** 提醒的标题和正文（纯函数；不带每轮会变的细数）。 */
export function quotaWasteAlert(
  pool: QuotaTablePool,
  hit: Hit,
  routes: readonly PoolRouteFact[],
): { title: string; body: string } {
  const left = Math.floor(hit.pressure.leftAtReset * 10) * 10;
  const reset = hit.window.resetsAt ? stamp(hit.window.resetsAt) : '清零时刻不知道';
  const mine = routes
    .filter((r) => r.poolId === pool.poolId)
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.routeId.localeCompare(b.routeId));
  const list =
    mine.length === 0
      ? '这个池上没有路由。'
      : mine
          .map(
            (r) =>
              `- ${r.routeId}（${r.modelId}，${r.enabled ? '开着' : '关着：去路由页打开就能接'}${r.alive ? '' : '，探针说不通'}）`,
          )
          .join('\n');
  return {
    title: clip(`额度快作废：${pool.poolId} ${hit.window.label} ${reset} 清零，预计剩 ${left}% 以上`, 300),
    body: [
      `${pool.poolId}（渠道 ${pool.channelName}）的 ${hit.window.label} 窗口 ${reset} 清零，照现在的速度清零时还剩 ${left}% 以上，这部分会作废。`,
      '接得住的路由（关着的也列出来）：',
      list,
      '想多用它：把关着的路由打开，或在路由页把这些路由的模型往前排；用上去了这条自己撤。',
    ].join('\n'),
  };
}

/** 跑这一步：报该报的、撤不用再报的。不抛，没做成的记进 problems。 */
export async function watchQuotaWaste(deps: QuotaWasteDeps, now: Date): Promise<QuotaWasteResult> {
  const out: QuotaWasteResult = { scanned: 0, found: 0, problems: [] };
  let notRead = new Set<string>();
  let pools: QuotaTablePool[];
  let samples: QuotaSampleRow[];
  let routes: PoolRouteFact[];
  try {
    if (deps.quotaNotRead) notRead = new Set(await deps.quotaNotRead());
    pools = await deps.quotaPools(now);
    samples = await deps.quotaSamples(new Date(now.getTime() - SAMPLE_LOOKBACK_MS));
    routes = await deps.poolRoutes();
  } catch (err) {
    out.problems.push(`读额度表、额度历史或路由没成，额度快作废这一轮没查：${errMessage(err)}`);
    return out;
  }
  let open: Map<string, { title: string; body: string }> | null = null;
  try {
    open = new Map(
      (await deps.alerts.openByPrefix(QUOTA_WASTE_PREFIX)).map((a) => [a.dedupeKey, a] as const),
    );
  } catch (err) {
    out.problems.push(`列不了额度快作废开着的提醒（不再中的这一轮撤不了）：${errMessage(err)}`);
  }
  const hits = new Set<string>();
  for (const p of pools) {
    if (notRead.has(p.poolId) || p.routeCount === 0) continue;
    if (p.expiresAt !== null && p.expiresAt.getTime() <= now.getTime()) continue;
    out.scanned += 1;
    const hit = wasteHit(p, samples, now);
    if (!hit) continue;
    const dedupeKey = quotaWasteKey(p.poolId);
    hits.add(dedupeKey);
    out.found += 1;
    const want = quotaWasteAlert(p, hit, routes);
    const was = open?.get(dedupeKey);
    if (was && was.title === want.title && was.body === want.body) continue;
    try {
      await deps.alerts.raise({ dedupeKey, ...want, link: '/quota' });
      deps.log('warn', '看门狗：额度快作废', {
        poolId: p.poolId,
        window: hit.window.label,
        leftAtReset: hit.pressure.leftAtReset,
      });
    } catch (err) {
      out.problems.push(`${dedupeKey} 额度快作废，报提醒没报成：${errMessage(err)}`);
    }
  }
  for (const dedupeKey of open?.keys() ?? []) {
    if (hits.has(dedupeKey)) continue;
    try {
      const why = '用上去了、清零了，或这个池不再在用';
      if ((await deps.alerts.resolve({ dedupeKey, why })) === 'ok') {
        deps.log('info', '看门狗：撤了一条', { dedupeKey, why });
      }
    } catch (err) {
      out.problems.push(`提醒 ${dedupeKey} 没撤掉：${errMessage(err)}`);
    }
  }
  return out;
}
