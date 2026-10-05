// 拼车额度烧得多快（#194，方案 v2 4.1）：最近 15 分钟接口读数里本人已用美元涨了多少 → 每分钟花多少 → 照这个速度还能撑几分钟。
// 两头用同一份：引擎的读频率（预计 20 分钟内用满就改成 1 分钟一次，engine 的 jobs/carpool-watch.ts）和驾驶舱额度页
// （「按现在的速度约 N 分钟后用满」，api 的 org-switch-view.ts）——两边不能互相 import，所以放在这里。
//
// 改这里之前必须知道：
// - 算不出就明说「还算不出」并写原因（unknown），不回 0、不回猜的数：读数少于 2 个、两头隔得太近或不合理（时钟倒着、读数在未来）、
//   最近一次读数太旧（读接口停了，「现在的速度」已经不是现在）、窗口里花费出现负数（额度窗口刚清零或上游退了钱，速度没法算）、
//   金额认不出。
// - 「最近没在花」是读得出的事实（known，minutesLeft 为 null），和「算不出」分开：前者说明短时间内用不满，后者什么都不能说。
// - 回包头 Age 超过上限的缓存读数、服务端 Date 没往前走的同一份读数不算样本（和 engine 的 freshReads 同一个认法）。
// - 上限不写死：剩余用最新一次读数里的上限算（上限会被 reclaude 调，见 engine 的 jobs/carpool-read-notes.ts）。

export interface BurnRead {
  /** 我们发请求的时刻（本机钟）。排序、算间隔都用它：同一台机器的钟前后一致。 */
  requestedAt: Date;
  /** 回包头 Date；只用来认「两次回的是同一份」。没给为 null。 */
  serverDate: Date | null;
  /** 回包头 Age（秒）；有且超过上限说明是缓存。 */
  ageSeconds: number | null;
  usedUsd: number;
  limitUsd: number;
}

export interface BurnPolicy {
  /** 只看最近这么久的读数。 */
  windowMs: number;
  /** 第一条和最后一条至少隔这么久才算得出（隔得太近，几美分的零头就折成每分钟几美元）。 */
  minSpanMs: number;
  /** 最近一次读数离现在超过这么久，不算「现在的速度」。 */
  maxStaleMs: number;
  /** 回包头 Age 超过这么多秒算缓存。 */
  maxAgeSeconds: number;
  /** 读数时刻比现在晚超过这么久，当两边钟对不上。 */
  maxFutureMs: number;
}

export const DEFAULT_BURN_POLICY: Readonly<BurnPolicy> = Object.freeze({
  windowMs: 15 * 60_000,
  minSpanMs: 2 * 60_000,
  maxStaleMs: 10 * 60_000,
  maxAgeSeconds: 60,
  maxFutureMs: 60_000,
});

export type BurnEstimate =
  | {
      state: 'known';
      /** 最近这段时间平均每分钟花多少美元（≥ 0）。 */
      usdPerMinute: number;
      /** 最新一次读数里本人额度还剩多少美元（≥ 0）。 */
      remainingUsd: number;
      /** 照这个速度还能撑几分钟；最近一分钱没花为 null（用不满）；已经用满为 0。 */
      minutesLeft: number | null;
      /** 算这个速度用的两头隔了几分钟、几个读数。 */
      spanMinutes: number;
      samples: number;
    }
  | { state: 'unknown'; why: string };

const unknown = (why: string): BurnEstimate => ({ state: 'unknown', why });

/** 读数里的金额：认不出（非有限、负数、上限不大于 0）为 false。 */
function usable(r: BurnRead): boolean {
  return Number.isFinite(r.usedUsd) && r.usedUsd >= 0 && Number.isFinite(r.limitUsd) && r.limitUsd > 0;
}

/**
 * 按最近的接口读数估烧速。reads 不要求排好序；now 是「现在」（驾驶舱用请求时刻，引擎用本轮时刻）。
 * 取窗口（最近 windowMs）里第一条和最后一条算每分钟花多少；中间任何一步花费变少都算不出（负数）。
 */
export function estimateBurn(
  reads: readonly BurnRead[],
  now: Date,
  policy: BurnPolicy = DEFAULT_BURN_POLICY,
): BurnEstimate {
  const t = now.getTime();
  const inWindow = reads
    .filter((r) => r.requestedAt.getTime() >= t - policy.windowMs)
    .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime());
  if (inWindow.length === 0) return unknown('最近 15 分钟没有读到过拼车额度');
  if (inWindow.some((r) => !usable(r)))
    return unknown('读数里的金额认不出（不是数、是负数、或上限不大于 0）');
  const fresh: BurnRead[] = [];
  for (const r of inWindow) {
    if (r.ageSeconds !== null && r.ageSeconds > policy.maxAgeSeconds) continue;
    const prev = fresh.at(-1);
    if (prev?.serverDate && r.serverDate && r.serverDate.getTime() <= prev.serverDate.getTime()) continue;
    fresh.push(r);
  }
  if (fresh.length < 2) {
    return unknown(`最近 15 分钟里算数的读数只有 ${fresh.length} 个（缓存和重复的不算），至少要 2 个`);
  }
  const first = fresh[0] as BurnRead;
  const last = fresh[fresh.length - 1] as BurnRead;
  if (last.requestedAt.getTime() - t > policy.maxFutureMs) {
    return unknown('读数时刻比现在还晚，读的这边和看的这边钟对不上');
  }
  if (t - last.requestedAt.getTime() > policy.maxStaleMs) {
    return unknown(
      `最近一次读数已经是 ${Math.round((t - last.requestedAt.getTime()) / 60_000)} 分钟前，不算「现在」的速度`,
    );
  }
  const spanMs = last.requestedAt.getTime() - first.requestedAt.getTime();
  if (spanMs < policy.minSpanMs) {
    return unknown(`第一个和最后一个读数只隔 ${Math.round(spanMs / 1000)} 秒，隔得太近算不准`);
  }
  for (let i = 1; i < fresh.length; i++) {
    if ((fresh[i] as BurnRead).usedUsd < (fresh[i - 1] as BurnRead).usedUsd) {
      return unknown('这段时间里已用金额变少了（额度窗口刚清零，或上游退了钱），算出来是负的花费');
    }
  }
  const spanMinutes = spanMs / 60_000;
  const usdPerMinute = (last.usedUsd - first.usedUsd) / spanMinutes;
  const remainingUsd = Math.max(0, last.limitUsd - last.usedUsd);
  const base = { state: 'known' as const, usdPerMinute, remainingUsd, spanMinutes, samples: fresh.length };
  if (remainingUsd === 0) return { ...base, minutesLeft: 0 };
  if (usdPerMinute === 0) return { ...base, minutesLeft: null };
  return { ...base, minutesLeft: remainingUsd / usdPerMinute };
}
