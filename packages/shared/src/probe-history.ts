// 渠道状态页的近 60 次格子（#1139）：把各条路由的探针历史按时间收成一条条带。
// 条带只留最近 60 次（本渠道所有路由合在一起，旧的在左）。没探的不进可用率，也不把没量到的耗时当成 0。
// 点路由行要看的是那条路由自己最近一次，哪怕它已经挤出这 60 格。

/** 渠道卡上的格子数，也是每条路由在库里留下的条数（db 的 ROUTE_PROBE_HISTORY_KEEP 用同一个数）。 */
export const PROBE_HISTORY_SLOTS = 60;

export const PROBE_HISTORY_RESULTS = ['passed', 'failed', 'not_probed'] as const;
export type ProbeHistoryResult = (typeof PROBE_HISTORY_RESULTS)[number];

/** 一次探针。probedAt 是带时区的时刻（ISO）。耗时、失败原因、原文没有就是 null，不当 0 或空串。 */
export interface ProbeHistoryCell {
  id: number;
  routeId: string;
  channelId: string;
  probedAt: string;
  result: ProbeHistoryResult;
  durationMs: number | null;
  failureReason: string | null;
  requestText: string | null;
  responseText: string | null;
}

/** 一个渠道的条带：cells 从旧到新，最多 60 格。可用率的分母是真探过的（通过 + 不通）。 */
export interface ProbeHistoryChannel {
  channelId: string;
  cells: ProbeHistoryCell[];
  /** 这 60 格里量到了耗时的那些的平均（毫秒，四舍五入）。一个都没有是 null。 */
  avgDurationMs: number | null;
  passed: number;
  /** 通过 + 不通。没探的不进。一条真探都没有是 0，页面不写成 0% 或 100%。 */
  attempted: number;
}

/** 正数 = a 比 b 新（时刻靠后；同一时刻 id 大的是后写入的）。 */
function compareAge(a: ProbeHistoryCell, b: ProbeHistoryCell): number {
  const ta = Date.parse(a.probedAt);
  const tb = Date.parse(b.probedAt);
  if (ta !== tb) return ta - tb;
  return a.id - b.id;
}

function averageDuration(cells: readonly ProbeHistoryCell[]): number | null {
  let sum = 0;
  let n = 0;
  for (const cell of cells) {
    if (cell.durationMs === null) continue;
    sum += cell.durationMs;
    n += 1;
  }
  if (n === 0) return null;
  return Math.round(sum / n);
}

function counts(cells: readonly ProbeHistoryCell[]): { passed: number; attempted: number } {
  let passed = 0;
  let attempted = 0;
  for (const cell of cells) {
    if (cell.result === 'not_probed') continue;
    attempted += 1;
    if (cell.result === 'passed') passed += 1;
  }
  return { passed, attempted };
}

/**
 * 按渠道收成条带，并给出每条路由自己的最近一次。
 * 输入不要求有序。一个渠道超过 60 次只留最近的，均耗时和可用率只算留下的这些。
 * 没有行：两个数组都空。不补假格子。
 */
export function probeHistoryStrips(rows: readonly ProbeHistoryCell[]): {
  channels: ProbeHistoryChannel[];
  latestByRoute: ProbeHistoryCell[];
} {
  const byChannel = new Map<string, ProbeHistoryCell[]>();
  const byRoute = new Map<string, ProbeHistoryCell>();
  for (const row of rows) {
    const list = byChannel.get(row.channelId);
    if (list) list.push(row);
    else byChannel.set(row.channelId, [row]);
    const prev = byRoute.get(row.routeId);
    if (!prev || compareAge(row, prev) > 0) byRoute.set(row.routeId, row);
  }

  const channels: ProbeHistoryChannel[] = [];
  for (const [channelId, list] of byChannel) {
    const ordered = [...list].sort(compareAge);
    const cells = ordered.slice(-PROBE_HISTORY_SLOTS);
    const { passed, attempted } = counts(cells);
    channels.push({
      channelId,
      cells,
      avgDurationMs: averageDuration(cells),
      passed,
      attempted,
    });
  }
  channels.sort((a, b) => (a.channelId < b.channelId ? -1 : a.channelId > b.channelId ? 1 : 0));

  const latestByRoute = [...byRoute.values()].sort((a, b) =>
    a.routeId < b.routeId ? -1 : a.routeId > b.routeId ? 1 : 0,
  );
  return { channels, latestByRoute };
}
