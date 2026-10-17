// 看门狗的「在用的账号池额度读数不超过 30 分钟」（#76；决定 0093 从每小时对账搬到这里，对账只管和 GitHub 对账）。
// Grok 访问令牌过期但 refresh_token 还在时，不在这里加宽限：宽限只少报「没按期跑成」，读数仍旧，选路照样把池排后面。
// 续期在读数过期前由引擎跑一次 grok models（real/index.ts 的 refreshGrokLogin）。真超过 30 分钟仍按过期报。
// 纯库检查：读额度表（db 的 quotaTable）、读额度配置里写明不读的池，报、撤提醒，不碰 GitHub。看门狗每 5 分钟一轮，比原来对账一小时
// 一轮早看得见。定时读额度（jobs/quota-read.ts）自己对「连着两轮没读成」报警，这里是兜底——它没在跑、跑了没写库、上游数冻住，
// 读数照样会旧，只有按「库里最近读成时刻」查才看得见。
// 改这里之前必须知道：
// - 在用 = 渠道开着、有路由挂在它上面、没过期；关掉的、没路由用的、过期了的池读不到是应该的，不报。有效额度配置 notRead
//   里的池（没有这种数据或已退役）不查：开着的旧提醒撤掉。
// - 键还是 reconcile:quota:<池>（驾驶舱 packages/web/src/lib/pool-problems.ts 认这个前缀；搬家前开着的卡照样有人撤）。
// - 正文不带「N 分钟前」这种每轮都变的话：只写上次读成的时刻；开着的、标题正文都没变就不改卡（看门狗 5 分钟一轮，飞书免费版每月
//   1 万次接口调用）。处理过的照旧重新打开（和搬家前对账的做法一样：读数还旧就还要人看）。
// - 读不到额度表、不读名单：这一轮这一步记没查成，开着的一条都不撤（不当成都新鲜）。
import { QUOTA_STALE_AFTER_MS, type QuotaTablePool } from '@fleet-dao/db';
import { errMessage } from '@fleet-dao/shared/util';
import { clip, stamp } from './reconcile-common.ts';

/** 额度读数过期（从没读成、超过 30 分钟没读成、上游数冻住）。后面是池编号；读新了自己撤。 */
export const QUOTA_ALERT_PREFIX = 'reconcile:quota:';

export function quotaAlertKey(poolId: string): string {
  return `${QUOTA_ALERT_PREFIX}${poolId}`;
}

/** 这一步要的读和写（看门狗那一轮接上；提醒的读写和看门狗别的那几条同一份）。 */
export interface QuotaWatchDeps {
  /** 额度表（db 的 quotaTable，按 now 判过期）。读不到照抛。 */
  quotaPools(now: Date): Promise<QuotaTablePool[]>;
  /**
   * 额度配置写明不读的池（deploy/quota.json 的 notRead）。不查、不报；开着的旧提醒撤掉。
   * 不给就当没有。读不到要抛，不许回空列表冒充「这些池都要读」。
   */
  quotaNotRead?: () => Promise<readonly string[]>;
  alerts: {
    openByPrefix(prefix: string): Promise<{ dedupeKey: string; title: string; body: string }[]>;
    raise(input: { dedupeKey: string; title: string; body: string; link: string }): Promise<void>;
    resolve(input: { dedupeKey: string; why: string }): Promise<'ok' | 'already_resolved' | 'not_found'>;
  };
  log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

/** 提醒点进去看驾驶舱的额度页。 */
export const QUOTA_ALERT_LINK = '/quota';

/** 一轮下来：看了几个在用的池、报了或撤了几条；problems 是没做成的，一条一句（看门狗这一轮记没跑成）。 */
export interface QuotaWatchResult {
  scanned: number;
  found: number;
  problems: string[];
}

/** 一个过期的池该报的标题、正文（纯函数；不带每轮会变的数）。 */
export function quotaAlert(p: QuotaTablePool, now: Date): { title: string; body: string } {
  const last = p.lastReadOkAt ? `最近一次读成是 ${stamp(p.lastReadOkAt)}` : '从没读成过';
  const frozen =
    p.lastReadOkAt && p.dataAt && now.getTime() - p.dataAt.getTime() > QUOTA_STALE_AFTER_MS
      ? `；读是读成了，但上游数据本身停在 ${stamp(p.dataAt)}`
      : '';
  return {
    title: clip(`账号池额度读数过期：${p.poolId}`, 300),
    body: [
      `${p.poolId}（渠道 ${p.channelName}）${last}${frozen}，超过 30 分钟，调度不会把它当「还够」。`,
      '先看引擎的 quota-read 定时任务有没有在跑、这个池最近一次为什么没读成；读新了这条自己撤。',
    ].join('\n'),
  };
}

/** 跑这一步：报该报的、撤不用再报的。不抛，没做成的记进 problems。 */
export async function watchQuotaFreshness(deps: QuotaWatchDeps, now: Date): Promise<QuotaWatchResult> {
  const out: QuotaWatchResult = { scanned: 0, found: 0, problems: [] };
  let notRead = new Set<string>();
  if (deps.quotaNotRead) {
    try {
      notRead = new Set(await deps.quotaNotRead());
    } catch (err) {
      out.problems.push(`读额度配置里不读的池没成，额度读数这一轮不查也不撤：${errMessage(err)}`);
      return out;
    }
  }
  let pools: QuotaTablePool[];
  try {
    pools = await deps.quotaPools(now);
  } catch (err) {
    out.problems.push(`读额度表没成，额度读数新不新鲜这一轮没查：${errMessage(err)}`);
    return out;
  }
  let open: Map<string, { title: string; body: string }> | null = null;
  try {
    open = new Map(
      (await deps.alerts.openByPrefix(QUOTA_ALERT_PREFIX)).map((a) => [a.dedupeKey, a] as const),
    );
  } catch (err) {
    out.problems.push(`列不了额度读数开着的提醒（读新了的这一轮撤不了）：${errMessage(err)}`);
  }

  const overdue = new Set<string>();
  for (const p of pools) {
    if (notRead.has(p.poolId)) continue;
    if (!p.channelEnabled || p.routeCount === 0) continue;
    if (p.expiresAt !== null && p.expiresAt.getTime() <= now.getTime()) continue;
    out.scanned += 1;
    if (!p.readOverdue) continue;
    const dedupeKey = quotaAlertKey(p.poolId);
    overdue.add(dedupeKey);
    out.found += 1;
    const want = quotaAlert(p, now);
    const was = open?.get(dedupeKey);
    if (was && was.title === want.title && was.body === want.body) continue;
    try {
      await deps.alerts.raise({ dedupeKey, ...want, link: QUOTA_ALERT_LINK });
      deps.log('warn', '看门狗：账号池额度读数过期', { poolId: p.poolId, lastReadOkAt: p.lastReadOkAt });
    } catch (err) {
      out.problems.push(`${dedupeKey} 额度读数过期，报提醒没报成：${errMessage(err)}`);
    }
  }
  for (const dedupeKey of open?.keys() ?? []) {
    if (overdue.has(dedupeKey)) continue;
    const poolId = dedupeKey.slice(QUOTA_ALERT_PREFIX.length);
    const why = notRead.has(poolId)
      ? '额度配置写明不读这个池（没有这种数据），不再报读数过期'
      : '读新了，或这个池不再在用';
    try {
      if ((await deps.alerts.resolve({ dedupeKey, why })) === 'ok') {
        deps.log('info', '看门狗：撤了一条', { dedupeKey, why });
      }
    } catch (err) {
      out.problems.push(`提醒 ${dedupeKey} 没撤掉：${errMessage(err)}`);
    }
  }
  return out;
}
