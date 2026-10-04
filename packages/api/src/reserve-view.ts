// 驾驶舱额度页顶上说独享的额度留量线现状（#194 方案 4.8）：独享到了线、线的设置认不出、配了线却读不到对应的读数，各说一句；
// 没到线、也没有要说的就没有（返回 undefined）。判法是 shared 的那一份（选路、切号读同一份），这里只把额度页已经算好的池视图喂给它。
import {
  evaluateReserve,
  type PoolViewSchema,
  RESERVE_NOT_LOADED,
  type ReserveReading,
  reserveHitText,
  reserveUnknownText,
  resolvePoolReserve,
  type SoloReserveViewSchema,
  usedRatioOf,
} from '@fleet-dao/shared';
import type { z } from 'zod';

type PoolView = z.input<typeof PoolViewSchema>;
export type SoloReserveView = z.input<typeof SoloReserveViewSchema>;

/** setting：设置里的原值，没设过 undefined。now：判「已过清零时刻」用。 */
export function soloReserveView(
  pools: readonly PoolView[],
  setting: unknown,
  now: Date,
): SoloReserveView | undefined {
  const solos = pools.filter((p) => p.orgKind === 'solo');
  // 库里没有这一行 = 种子没装上：不是不限，明说（只在有独享池的时候说，开发环境的内存版没有独享池）
  if (solos.length > 0 && setting === undefined) {
    return { state: 'unreadable', why: `${RESERVE_NOT_LOADED}；引擎不派、不切独享` };
  }
  const reached: string[] = [];
  const unknown: string[] = [];
  for (const pool of solos) {
    const resolved = resolvePoolReserve(setting, { poolId: pool.id });
    if (!resolved.ok)
      return { state: 'unreadable', why: `${resolved.why}，引擎不派、不切独享（不当成不限）` };
    const readings: ReserveReading[] = pool.windows.map((w) => {
      const resetPassed = w.resetsAt !== undefined && Date.parse(w.resetsAt) <= now.getTime();
      const used = usedRatioOf(w);
      const full = w.upstreamStatus === 'limit_reached' || (used !== null && used >= 1);
      return {
        label: w.label,
        window: w.window,
        scope: w.scope ?? null,
        state: resetPassed ? 'reset' : full ? 'exhausted' : w.stale ? 'stale' : 'ok',
        used,
        resetsAt: w.resetsAt ?? null,
      };
    });
    const verdict = evaluateReserve(resolved.lines, readings);
    reached.push(...verdict.hits.map(reserveHitText));
    unknown.push(...verdict.unknown.map(reserveUnknownText));
  }
  if (reached.length > 0) return { state: 'reached', why: reached.join('、') };
  if (unknown.length > 0) return { state: 'unknown', why: unknown.join('；') };
  return undefined;
}
