// 主页的机器资源怎么读给人看（#1973）：顶栏的整机内存 / CPU 两格、画布上每张卡片自己占的内存和 CPU。
// 数据是后端在本机读的（/proc、会话 scope 的 cgroup，见 packages/api/src/host-resources.ts），经主页接口和推送带来。
//
// 改这里之前必须知道：
// - 读不到（cgroup 不在、内容认不出、这台不是 Linux、后端没给、那台没推过）一律是 unread + 原因，页面写「没读到」，不拿 0 顶。
// - 这一刻没有会话在跑的单（排队、等人、等验）是 idle，卡片写「没在占用」，不画 0。
// - 一张单同时几个会话（runIds 不止一个）按单合计：内存（memory.current）相加，CPU 相加（100% = 占满一个核），
//   峰值是各会话 memory.peak 之和——各会话的峰值不一定同时出现，这是上界，悬停里照这个口径写。
// - 有一个会话没读到，整张单就写没读到，不拿另一个会话的数冒充整张单的数。
// - 整机两格写具体数值再写百分比：内存「已用 / 总量」（都由 totalMb、availableMb 算），CPU「忙的核数 / 总核数」（busyCores
//   是后端和 percent 同一对差算的）。数值缺了写没读到，不拿百分比 × 核数在前端编。
// - 紧：内存已用 ≥ 85%、CPU ≥ 90%，画提示黄（stall，见 machine-meter.tsx），不画失败红——机器忙不是坏了（health-strip.tsx 头注释的规矩）。
import type { HomeResources, HomeRunning } from './types';

/** 内存已用到这个比例算紧。 */
export const MEMORY_TIGHT_PERCENT = 85;
/** CPU 忙到这个比例算紧。 */
export const CPU_TIGHT_PERCENT = 90;
/** 本台超过几个采样间隔没来新读数算旧了（推送断了、后端停了采样）。 */
export const STALE_INTERVALS = 3;

export type TicketUsage =
  | { kind: 'idle' }
  | { kind: 'ok'; sessions: number; memoryMb: number; peakMb?: number; cpuPercent?: number }
  | { kind: 'unread'; why: string };

export interface ResourceOptions {
  /** 看的是别的环境推来的快照。 */
  remote?: boolean;
}

/** 后端压根没给资源读数时的原因：本台是后端没接，远程是那台没推过。 */
export function missingWhy(opts: ResourceOptions = {}): string {
  return opts.remote ? '那台没推过资源读数（那台的版本还没有这一项）' : '这台后端没给资源读数';
}

/** 一张单此刻占的内存、CPU。口径见文件头。 */
export function ticketUsage(
  item: HomeRunning,
  resources: HomeResources | undefined,
  opts: ResourceOptions = {},
): TicketUsage {
  const runIds = item.runIds;
  if (runIds === undefined) {
    // 老后端没给会话编号：没人在做就是没在占用；有人在做却对不上号，照实写没读到
    if (item.worker === undefined) return { kind: 'idle' };
    return {
      kind: 'unread',
      why: opts.remote
        ? '那台推来的快照里没有会话编号（那台的版本还没有这一项）'
        : '后端没给这张单的会话编号',
    };
  }
  if (runIds.length === 0) return { kind: 'idle' };
  if (!resources) return { kind: 'unread', why: missingWhy(opts) };
  if (resources.sessions.state === 'unread') return { kind: 'unread', why: resources.sessions.why };
  let memoryMb = 0;
  let peakMb: number | undefined = 0;
  let cpuPercent: number | undefined = 0;
  for (const id of runIds) {
    const u = resources.sessions.byRun[id];
    if (!u) {
      return {
        kind: 'unread',
        why: `会话 ${id} 的 scope 不在这一回读数里（刚起来、刚收场，或没在会话资源池下）`,
      };
    }
    if (u.state === 'unread') return { kind: 'unread', why: u.why };
    memoryMb += u.memoryMb;
    peakMb = peakMb === undefined || u.memoryPeakMb === undefined ? undefined : peakMb + u.memoryPeakMb;
    cpuPercent =
      cpuPercent === undefined || u.cpuPercent === undefined ? undefined : cpuPercent + u.cpuPercent;
  }
  return {
    kind: 'ok',
    sessions: runIds.length,
    memoryMb,
    ...(peakMb === undefined ? {} : { peakMb }),
    ...(cpuPercent === undefined ? {} : { cpuPercent: Math.round(cpuPercent * 10) / 10 }),
  };
}

/** 一格的具体数值（内存「已用 / 总量」、CPU「忙的核数 / 总核数」）；读不到写没读到带原因，不拿百分比反推。 */
export type Amount = { kind: 'ok'; text: string } | { kind: 'unread'; why: string };

export type Meter =
  | { kind: 'ok'; percent: number; tight: boolean; text: string; amount: Amount; detail: string }
  | { kind: 'unread'; why: string };

export interface HostMeters {
  /** 整块没有读数（后端没给、那台没推过）的原因。 */
  missing?: string;
  memory: Meter;
  cpu: Meter;
  /** 本台的读数旧了（超过 STALE_INTERVALS 个间隔没来新的）。 */
  stale: boolean;
}

/** 内存写法：三位数以内写 M，四位数起写一位小数的 G（1000–1023M 也写 G，不出现「1006M」这种又长又难读的）。 */
export function formatMb(mb: number): string {
  return Math.round(mb) < 1000 ? `${Math.round(mb)}M` : `${(mb / 1024).toFixed(1)}G`;
}

/** CPU 写法：取整的百分比。 */
export function formatCpu(percent: number): string {
  return `${Math.round(percent)}%`;
}

/** 顶栏两格：内存、CPU 各一格。 */
export function hostMeters(
  resources: HomeResources | undefined,
  now: number,
  opts: ResourceOptions = {},
): HostMeters {
  if (!resources) {
    const why = missingWhy(opts);
    return { missing: why, memory: { kind: 'unread', why }, cpu: { kind: 'unread', why }, stale: false };
  }
  const m = resources.memory;
  const memory: Meter =
    m.state === 'unread'
      ? { kind: 'unread', why: m.why }
      : (() => {
          const used = m.totalMb - m.availableMb;
          const percent = Math.round((used / m.totalMb) * 100);
          return {
            kind: 'ok' as const,
            percent,
            tight: percent >= MEMORY_TIGHT_PERCENT,
            text: `${percent}%`,
            // 和百分比同一对数（总量、可用）算出来
            amount: { kind: 'ok' as const, text: `${formatMb(used)} / ${formatMb(m.totalMb)}` },
            detail: `已用 ${formatMb(used)} / 共 ${formatMb(m.totalMb)}，可用 ${formatMb(m.availableMb)}`,
          };
        })();
  const c = resources.cpu;
  const cpu: Meter =
    c.state === 'unread'
      ? { kind: 'unread', why: c.why }
      : {
          kind: 'ok',
          percent: Math.round(c.percent),
          tight: c.percent >= CPU_TIGHT_PERCENT,
          text: formatCpu(c.percent),
          // 忙的核数是后端拿同一对差算的；老快照没有就写没读到，不拿百分比 × 核数在这里编
          amount:
            c.busyCores === undefined
              ? {
                  kind: 'unread',
                  why: opts.remote
                    ? '那台推来的读数里没有忙的核数（那台的版本还没有这一项）'
                    : '后端没给忙的核数',
                }
              : { kind: 'ok', text: `${c.busyCores.toFixed(1)} 核 / ${c.cores} 核` },
          detail: `${c.busyCores === undefined ? '' : `忙 ${c.busyCores.toFixed(1)} 核，`}${c.cores} 核合计忙 ${formatCpu(c.percent)}${
            c.load1 === undefined ? '' : `，1 分钟负载 ${c.load1.toFixed(2)}`
          }`,
        };
  const age = now - Date.parse(resources.at);
  // 远程快照本来就是隔一阵推一回，新鲜度由快照横幅说，这里不另判
  const stale = !opts.remote && age > resources.everyMs * STALE_INTERVALS;
  return { memory, cpu, stale };
}
