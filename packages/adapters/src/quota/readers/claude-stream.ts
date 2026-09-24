// 被动读：真会话过程记录里的 rate_limit_event → 窗口读数，给引擎在会话里顺手记账（零成本，不另起探针）。
// 解析 stream-json 是 Claude Code 插头的事（claude-code/stream.ts 产出 RateLimitReading），这里只做换算，不另写一份解析。
import type { RateLimitReading } from '../../types.ts';
import type { QuotaReading } from '../types.ts';
import { num, pruned } from '../util.ts';
import { classifyLabel, normalizeStatus, type WindowClass } from '../windows.ts';

const SOURCE = 'claude-stream';

const UNIFIED_WINDOW: Record<string, WindowClass> = {
  five_hour: { window: '5h' },
  seven_day: { window: '7d' },
  seven_day_opus: { window: '7d_model', scope: 'opus' },
  seven_day_sonnet: { window: '7d_model', scope: 'sonnet' },
};

const classify = (name: string): WindowClass => UNIFIED_WINDOW[name] ?? classifyLabel(name);

/** 报错正文里的「约 N 分钟后重置」/「resets in N minutes」。 */
function resetFromText(text: string, from: string): string | undefined {
  const m = /约\s*(\d+)\s*分钟后重置|resets? in (?:about )?(\d+) ?min/i.exec(text);
  const minutes = num(m?.[1] ?? m?.[2]);
  if (minutes === undefined) return undefined;
  return new Date(Date.parse(from) + minutes * 60_000).toISOString();
}

/**
 * 一条 RateLimitReading → 窗口读数：
 * - 每个 unifiedWindows 窗口一行（没见过的窗口归 other，原名当 label）；
 * - 顶层 status / rateLimitType 说的是「当前卡着的那个窗口」，状态字只挂到那一行；
 * - 用满那一刻事件里常常只有 {status:"rejected"}、没有窗口：照样记「已用满」——
 *   窗口类型没给就看报错正文（errorText）是不是说「5 小时」，刷新点能从「约 N 分钟后重置」推就推。
 * 既没有利用率、也没有状态字的窗口不收；一条都换不出来就返回 undefined——这次没读到，不是 0%。
 */
export function readingsFromRateLimit(
  reading: RateLimitReading,
  ctx: { poolId: string; errorText?: string },
): QuotaReading[] | undefined {
  const base = {
    poolId: ctx.poolId,
    reading: 'measured' as const,
    readAt: reading.observedAt,
    source: SOURCE,
  };
  const status = normalizeStatus(reading.status);
  const limiting = reading.rateLimitType;
  const usable = reading.windows.filter((w) => w.utilization !== undefined || w.name === limiting);
  const out: QuotaReading[] = usable.map((w) => {
    const cls = classify(w.name);
    return pruned<QuotaReading>({
      ...base,
      window: cls.window,
      scope: cls.scope,
      label: w.name,
      unit: 'percent',
      used: w.utilization === undefined ? undefined : w.utilization * 100,
      limit: w.utilization === undefined ? undefined : 100,
      utilization: w.utilization,
      resetsAt: w.resetsAt,
      ...(w.name === limiting ? status : {}),
    });
  });

  if (reading.exhausted && !out.some((r) => r.upstreamStatus === 'limit_reached')) {
    const text = ctx.errorText ?? '';
    const name =
      limiting ?? (/5\s*小时|5-hour|five.hour|session limit/i.test(text) ? 'five_hour' : undefined);
    const label = name ?? 'rate_limit';
    const resetsAt = reading.resetsAt ?? resetFromText(text, reading.observedAt);
    const existing = out.find((r) => r.label === label);
    const exhausted = { upstreamStatus: 'limit_reached' as const, statusRaw: reading.status };
    if (existing) {
      Object.assign(existing, exhausted, resetsAt && !existing.resetsAt ? { resetsAt } : {});
    } else {
      const cls: WindowClass = name ? classify(name) : { window: 'other' };
      out.push(
        pruned<QuotaReading>({
          ...base,
          window: cls.window,
          scope: cls.scope,
          label,
          unit: 'percent',
          resetsAt,
          ...exhausted,
        }),
      );
    }
  }
  return out.length ? out : undefined;
}
