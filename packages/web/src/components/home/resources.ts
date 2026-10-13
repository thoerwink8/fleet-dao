// 主页的机器资源怎么读给人看（#1973）：顶栏的整机内存 / CPU 两格、画布上每张卡片自己占的内存和 CPU。
// 数据是后端在本机读的（/proc、会话 scope 的 cgroup，见 packages/api/src/host-resources.ts），经主页接口和推送带来。
//
// 改这里之前必须知道：
// - 读不到（cgroup 不在、内容认不出、这台不是 Linux、后端没给、那台没推过）一律是 unread + 原因，页面写「没读到」，不拿 0 顶。
// - 这一刻没有会话在跑的单（排队、等人、等验）：没有上一次会话是 idle，卡片写「没在占用」；有上一次收场的会话写
//   「上次动手峰值 3.5G · CPU 12 分钟」（内存是那次的 memory.peak，CPU 是那次 cpu.stat 的 usage_usec 折成的秒数）。
//   CPU 没记写「CPU 没读到」，内存没记写「上次峰值没读到」。都不画 0。
// - 一张单同时几个会话（runIds 不止一个）按单合计：内存（memory.current）相加，CPU 相加（100% = 占满一个核），
//   峰值是各会话 memory.peak 之和——各会话的峰值不一定同时出现，这是上界，悬停里照这个口径写。
// - 有一个会话没读到，整张单就写没读到，不拿另一个会话的数冒充整张单的数。
// - 整机两格写具体数值再写百分比：内存「已用 / 总量」（都由 totalMb、availableMb 算），CPU「忙的核数 / 总核数」（busyCores
//   是后端和 percent 同一对差算的）。数值缺了写没读到，不拿百分比 × 核数在前端编。
// - 紧：内存已用 ≥ 85%、CPU ≥ 90%、磁盘已用 ≥ 90%，画提示黄（stall，见 machine-meter.tsx），不画失败红——机器忙不是坏了（health-strip.tsx 头注释的规矩）。
// - 整机磁盘（#1985）写「已用 / 总量」和百分比，由同一回 statfs 的 usedBytes、totalBytes 算；剩余（普通用户还写得进的）写在细节里。
import type { HomeResources, HomeRunning } from './types';

/** 内存已用到这个比例算紧。 */
export const MEMORY_TIGHT_PERCENT = 85;
/** CPU 忙到这个比例算紧。 */
export const CPU_TIGHT_PERCENT = 90;
/** 磁盘已用到这个比例算紧（#1985）：和内存、CPU 一样画提示黄，不画红。 */
export const DISK_TIGHT_PERCENT = 90;
/** 本台超过几个采样间隔没来新读数算旧了（推送断了、后端停了采样）。 */
export const STALE_INTERVALS = 3;

export type TicketUsage =
  | { kind: 'idle' }
  /** 没在跑，但上一次会话记过占用。text 是卡片上的那一行。 */
  | { kind: 'last'; text: string; title: string }
  | { kind: 'ok'; sessions: number; memoryMb: number; peakMb?: number; cpuPercent?: number }
  /** 这张单的会话 scope 都还在、但里面没进程（memory.current 是 0，#1992）：写「空 scope」，不写 0M / 0%。 */
  | { kind: 'empty'; why: string }
  | { kind: 'unread'; why: string };

export interface ResourceOptions {
  /** 看的是别的环境推来的快照。 */
  remote?: boolean;
}

/** 后端压根没给资源读数时的原因：本台是后端没接，远程是那台没推过。 */
export function missingWhy(opts: ResourceOptions = {}): string {
  return opts.remote ? '那台没推过资源读数（那台的版本还没有这一项）' : '这台后端没给资源读数';
}

/** 没在跑：有上一次会话就写它的峰值和 CPU，没有就写没在占用。 */
function idleUsage(item: HomeRunning): TicketUsage {
  if (!item.lastSession) return { kind: 'idle' };
  return {
    kind: 'last',
    text: lastSessionLine(item.lastSession),
    title: lastSessionTitle(item.lastSession),
  };
}

/** 一张单此刻占的内存、CPU。口径见文件头。 */
export function ticketUsage(
  item: HomeRunning,
  resources: HomeResources | undefined,
  opts: ResourceOptions = {},
): TicketUsage {
  const runIds = item.runIds;
  if (runIds === undefined) {
    // 老后端没给会话编号：没人在做就是没在占用（有上一次会话则写上次）；有人在做却对不上号，照实写没读到
    if (item.worker === undefined) return idleUsage(item);
    return {
      kind: 'unread',
      why: opts.remote
        ? '那台推来的快照里没有会话编号（那台的版本还没有这一项）'
        : '后端没给这张单的会话编号',
    };
  }
  if (runIds.length === 0) return idleUsage(item);
  if (!resources) return { kind: 'unread', why: missingWhy(opts) };
  if (resources.sessions.state === 'unread') return { kind: 'unread', why: resources.sessions.why };
  let memoryMb = 0;
  let peakMb: number | undefined = 0;
  let cpuPercent: number | undefined = 0;
  let live = 0;
  let emptyWhy: string | undefined;
  for (const id of runIds) {
    const u = resources.sessions.byRun[id];
    if (!u) {
      return {
        kind: 'unread',
        why: `会话 ${id} 的 scope 不在这一回读数里（刚起来、刚收场，或没在会话资源池下）`,
      };
    }
    if (u.state === 'unread') return { kind: 'unread', why: u.why };
    // 空 scope（里面没进程）不算在跑、不进合计（#1992）
    if (u.state === 'empty') {
      emptyWhy ??= u.why;
      continue;
    }
    live += 1;
    memoryMb += u.memoryMb;
    peakMb = peakMb === undefined || u.memoryPeakMb === undefined ? undefined : peakMb + u.memoryPeakMb;
    cpuPercent =
      cpuPercent === undefined || u.cpuPercent === undefined ? undefined : cpuPercent + u.cpuPercent;
  }
  if (live === 0 && emptyWhy !== undefined) return { kind: 'empty', why: emptyWhy };
  return {
    kind: 'ok',
    sessions: live,
    memoryMb,
    ...(peakMb === undefined ? {} : { peakMb }),
    ...(cpuPercent === undefined ? {} : { cpuPercent: Math.round(cpuPercent * 10) / 10 }),
  };
}

/** 一格的具体数值（内存「已用 / 总量」、CPU「忙的核数 / 总核数」）；读不到写没读到带原因，不拿百分比反推。 */
export type Amount = { kind: 'ok'; text: string } | { kind: 'unread'; why: string };

export type Meter =
  | {
      kind: 'ok';
      percent: number;
      tight: boolean;
      text: string;
      amount: Amount;
      detail: string;
      /** 资源页大格下面的一句短话（可用多少、几个核、剩余多少）。 */
      brief: string;
    }
  | { kind: 'unread'; why: string };

export interface HostMeters {
  /** 整块没有读数（后端没给、那台没推过）的原因。 */
  missing?: string;
  memory: Meter;
  cpu: Meter;
  /** 整机磁盘（#1985）。 */
  disk: Meter;
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

/** 一次会话的 CPU 秒数：不满一分钟写秒，满一分钟写分钟，满一小时再拆小时。 */
export function formatCpuSeconds(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 60) return `${whole} 秒`;
  const minutes = Math.round(whole / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
}

/** 没在跑时卡片上的那一行。内存、CPU 各自没读到就写明，不拿 0 顶。 */
export function lastSessionLine(last: NonNullable<HomeRunning['lastSession']>): string {
  const memory =
    last.memory.state === 'ok' ? `上次动手峰值 ${formatMb(last.memory.peakMb)}` : '上次峰值没读到';
  const cpu = last.cpu.state === 'ok' ? `CPU ${formatCpuSeconds(last.cpu.seconds)}` : 'CPU 没读到';
  return `${memory} · ${cpu}`;
}

function lastSessionTitle(last: NonNullable<HomeRunning['lastSession']>): string {
  const memory =
    last.memory.state === 'ok'
      ? `内存峰值 ${formatMb(last.memory.peakMb)}（cgroup memory.peak）`
      : `内存峰值没读到：${last.memory.why}`;
  const cpu =
    last.cpu.state === 'ok'
      ? `CPU 累计 ${formatCpuSeconds(last.cpu.seconds)}（cpu.stat 的 usage_usec，100% 占满一个核一分钟是 60 秒）`
      : `CPU 没读到：${last.cpu.why}`;
  return `上一次会话收场时记下的：${memory}；${cpu}。这一刻没有会话在跑。`;
}

/** 顶栏两格：内存、CPU 各一格。 */
export function hostMeters(
  resources: HomeResources | undefined,
  now: number,
  opts: ResourceOptions = {},
): HostMeters {
  if (!resources) {
    const why = missingWhy(opts);
    return {
      missing: why,
      memory: { kind: 'unread', why },
      cpu: { kind: 'unread', why },
      disk: { kind: 'unread', why },
      stale: false,
    };
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
            brief: `可用 ${formatMb(m.availableMb)}`,
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
          brief: c.load1 === undefined ? `${c.cores} 核合计` : `1 分钟负载 ${c.load1.toFixed(2)}`,
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
  return { memory, cpu, disk: diskMeter(resources.disk, opts), stale };
}

/** 整机磁盘一格（#1985）：「已用 / 总量」和百分比都由 usedBytes、totalBytes 算；剩余写在细节里。老后端没给写没读到。 */
export function diskMeter(disk: HomeResources['disk'], opts: ResourceOptions = {}): Meter {
  if (disk === undefined) {
    return {
      kind: 'unread',
      why: opts.remote
        ? '那台推来的读数里没有磁盘（那台的版本还没有这一项）'
        : '后端没给磁盘读数（后端的版本还没有这一项）',
    };
  }
  if (disk.state === 'unread') return { kind: 'unread', why: disk.why };
  const percent = Math.round((disk.usedBytes / disk.totalBytes) * 100);
  return {
    kind: 'ok',
    percent,
    tight: percent >= DISK_TIGHT_PERCENT,
    text: `${percent}%`,
    amount: { kind: 'ok', text: `${formatBytes(disk.usedBytes)} / ${formatBytes(disk.totalBytes)}` },
    detail: `已用 ${formatBytes(disk.usedBytes)} / 共 ${formatBytes(disk.totalBytes)}，剩余 ${formatBytes(disk.availableBytes)}（${disk.path}）`,
    brief: `剩余 ${formatBytes(disk.availableBytes)}`,
  };
}

const KIB = 1024;
const MIB = KIB * 1024;
const GIB = MIB * 1024;
const TIB = GIB * 1024;

/**
 * 字节写法：不到 1M 写「不到 1M」（真量出来的小目录，不写 0），三位数以内写 M，四位数起写一位小数的 G，到 T 写一位小数的 T。
 * 和 formatMb 一个规矩：不出现「1006M」「1003G」这种又长又难读的。
 */
export function formatBytes(bytes: number): string {
  if (bytes < MIB) return bytes === 0 ? '0' : '不到 1M';
  if (Math.round(bytes / MIB) < 1000) return `${Math.round(bytes / MIB)}M`;
  if (Math.round((bytes / GIB) * 10) / 10 < 1000) return `${(bytes / GIB).toFixed(1)}G`;
  return `${(bytes / TIB).toFixed(1)}T`;
}
