// 估算：官方接口和网页接口都读不到时，按我们自己的用量记录估「用了多少」。
// 输入是用量记录（以后由引擎从库里给；现在也能读旧系统 Jev 的日账），输出是标了 estimated 的窗口读数。
import { join } from 'node:path';
import type { Reader, ReaderContext } from '../context.ts';
import type {
  DailyTokenFilesSource,
  EstimateConfig,
  EstimateWindowSpec,
  QuotaReading,
  UsageRecord,
  UsageSource,
} from '../types.ts';
import { QuotaReadError } from '../types.ts';
import { expandHome, isRecord, num, pruned } from '../util.ts';
import { type ModelRef, windowAppliesTo } from '../windows.ts';

const SOURCE = 'estimate';
const HOUR_MS = 3_600_000;

interface Span {
  start: number;
  /** 固定窗才有：下一次清零。 */
  end?: number;
}

/** 这个窗口此刻覆盖的时间段。固定窗从 anchor 起每 periodHours 一格；滚动窗往回看 periodHours。 */
export function windowSpan(spec: EstimateWindowSpec, now: Date): Span {
  const period = spec.periodHours * HOUR_MS;
  const t = now.getTime();
  if (spec.anchor === undefined) return { start: t - period };
  const anchor = Date.parse(spec.anchor);
  const k = Math.floor((t - anchor) / period);
  const start = anchor + k * period;
  return { start, end: start + period };
}

/**
 * 按用量记录估每个窗口的已用量。记录缺金额（或点数）的不硬算，只在 notes 里点数——估出来的是下限。
 * 模型组窗口只算本组模型的记录；记录没写模型的算不进任何模型组。
 */
export function estimateWindows(
  specs: readonly EstimateWindowSpec[],
  records: readonly UsageRecord[],
  ctx: { poolId: string; now: Date },
): { windows: QuotaReading[]; notes: string[] } {
  const windows: QuotaReading[] = [];
  const notes: string[] = [];
  const t = ctx.now.getTime();
  for (const spec of specs) {
    const span = windowSpan(spec, ctx.now);
    let used = 0;
    let missing = 0;
    let unattributed = 0;
    for (const r of records) {
      const at = Date.parse(r.at);
      if (!Number.isFinite(at) || at < span.start || at > t) continue;
      if (spec.scope) {
        if (r.modelId === undefined && r.family === undefined) {
          unattributed++;
          continue;
        }
        const ref: ModelRef =
          r.family === undefined ? { id: r.modelId ?? '' } : { id: r.modelId ?? '', family: r.family };
        if (!windowAppliesTo({ scope: spec.scope }, ref)) continue;
      }
      const v = spec.unit === 'usd' ? r.costUsd : r.points;
      if (v === undefined || !Number.isFinite(v)) {
        missing++;
        continue;
      }
      used += v;
    }
    if (missing)
      notes.push(
        `${spec.label}：${missing} 条记录没有${spec.unit === 'usd' ? '金额' : '点数'}，没算进去（估出来的是下限）`,
      );
    if (unattributed) notes.push(`${spec.label}：${unattributed} 条记录没写模型，算不进 ${spec.scope} 组`);
    windows.push(
      pruned<QuotaReading>({
        poolId: ctx.poolId,
        window: spec.window,
        scope: spec.scope,
        label: spec.label,
        unit: spec.unit,
        used,
        limit: spec.limit,
        utilization: spec.limit !== undefined && spec.limit > 0 ? used / spec.limit : undefined,
        resetsAt: span.end === undefined ? undefined : new Date(span.end).toISOString(),
        reading: 'estimated',
        readAt: ctx.now.toISOString(),
        source: SOURCE,
      }),
    );
  }
  return { windows, notes };
}

/** 旧系统 Jev 日账 → 用量记录：每个 UTC 日一条，金额 = tokens × 每百万单价。 */
export function dailyTokenFilesSource(
  source: DailyTokenFilesSource,
  io: Pick<ReaderContext, 'readFile' | 'listDir' | 'homeDir'>,
  poolId: string,
): UsageSource {
  const dir = expandHome(source.dir, io.homeDir);
  return async ({ since, until }) => {
    const firstDay = since.toISOString().slice(0, 10);
    const lastDay = until.toISOString().slice(0, 10);
    let names: string[];
    try {
      names = await io.listDir(dir);
    } catch (e) {
      // 目录不在 ≠ 没用量：路径写错或目录被搬走时，要是按 $0 算，每日上限就永远不会触发。
      const code = (e as NodeJS.ErrnoException).code ?? 'ERR';
      const why = code === 'ENOENT' ? '不存在（路径写错，或日账搬走了）' : `读不了（${code}）`;
      throw new QuotaReadError('no_usage_source', `日账目录 ${dir} ${why}`);
    }
    const out: UsageRecord[] = [];
    for (const name of names) {
      const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(name);
      const day = m?.[1];
      if (!day || day < firstDay || day > lastDay) continue;
      let doc: unknown;
      try {
        doc = JSON.parse(await io.readFile(join(dir, name)));
      } catch {
        throw new QuotaReadError('bad_response', `日账 ${name} 读不了或不是 JSON`);
      }
      const tokens = isRecord(doc) ? num(doc.tokens) : undefined;
      if (tokens === undefined) throw new QuotaReadError('bad_response', `日账 ${name} 里没有 tokens`);
      out.push({
        poolId,
        at: `${day}T00:00:00.000Z`,
        inputTokens: tokens,
        costUsd: (tokens * source.usdPerMTok) / 1e6,
      });
    }
    return out;
  };
}

export const readEstimate: Reader = async (ctx) => {
  const pool = ctx.pool as EstimateConfig;
  const usage = pool.usage ? dailyTokenFilesSource(pool.usage, ctx, pool.poolId) : ctx.usageRecords;
  if (!usage) {
    throw new QuotaReadError(
      'no_usage_source',
      '这个池只能估算，但没有用量记录的来源（引擎接上库之前读不到）',
    );
  }
  const now = ctx.now();
  const since = new Date(Math.min(...pool.windows.map((w) => windowSpan(w, now).start)));
  const records = await usage({ poolId: pool.poolId, since, until: now });
  const out = estimateWindows(pool.windows, records, { poolId: pool.poolId, now });
  const notes = [...out.notes];
  if (pool.usage) notes.push('用量来自旧系统的日账（按 UTC 日合计），不是上游账单');
  if (records.length === 0) {
    notes.push('这段时间一条用量记录都没有：要么真没用，要么记账没在写——估出来的 0 只是下限');
  }
  return { windows: out.windows, notes };
};
