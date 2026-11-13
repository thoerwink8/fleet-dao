// 本机容量（单 #2731，决定 0094）：派写码工人前、收轮前对账时由代码判「本机还接得下一个工人吗」，不再靠一段文字。
// 判法只有两条，不设任何个数上限：空闲内存不少于 MIN_FREE_BYTES（4G）；1 分钟负载不超过核数 × LOAD_PER_CORE（0.8）。
// 读数：Windows 用 node 的 os.freemem() 和 os.cpus() 隔 250 毫秒两次采样的忙比例，折成「负载 = 忙的比例 × 核数」
// （Windows 没有 loadavg；不起 PowerShell，见 realCim）；Linux 读 /proc/meminfo 的 MemAvailable 和 /proc/loadavg 的第一个数；macOS 读 vm_stat 的
// 空闲 + 不活跃 + 预读 + 可清除页（和 Linux 的 MemAvailable 同一个意思：不用换出就能给新进程的），负载用 os.loadavg()。
// 别的平台、读不到、认不出一律 { ok: false, why }——调用方要明说「没查成」，不当成够。
// 纯 node、不起常驻进程；agents-sync 原样装到 ~/.fleet-dao/hooks/，pretool.mjs 和 queue-stop.mjs 引它。
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { availableParallelism, cpus, freemem, loadavg } from 'node:os';

/** 空闲内存至少这么多（字节）才派新工人 */
export const MIN_FREE_BYTES = 4 * 1024 ** 3;
/** 1 分钟负载不超过核数 × 这个数才派新工人 */
export const LOAD_PER_CORE = 0.8;
/** 读 vm_stat 最多等多久（毫秒） */
export const VM_STAT_TIMEOUT_MS = 3000;

/** @typedef {{ ok: true, freeBytes: number, load1: number, cores: number, how: string } | { ok: false, why: string }} Reading 一次读数 */
/**
 * @typedef {{
 *   platform?: NodeJS.Platform,
 *   cores?: number,
 *   runCim?: () => { status: number | null, stdout: string, stderr: string, error?: Error | undefined },
 *   readText?: (path: string) => string,
 *   runVmStat?: () => { status: number | null, stdout: string, stderr: string, error?: Error | undefined },
 *   loadavg?: () => number[],
 * }} ReadDeps 测试换掉读数的那几下
 */

/** Windows 隔多久采第二次 CPU 时间（毫秒）：两次之差折成「忙的比例」 */
export const CPU_SAMPLE_MS = 250;

/**
 * os.cpus() 两次采样之间 CPU 忙的百分比
 * @param {import('node:os').CpuInfo['times'][]} t0
 * @param {import('node:os').CpuInfo['times'][]} t1
 * @returns {number}
 */
function busyPercent(t0, t1) {
  let busy = 0;
  let total = 0;
  t1.forEach((b, i) => {
    const a = t0[i];
    if (!a) return;
    const all = b.user + b.nice + b.sys + b.irq + b.idle - (a.user + a.nice + a.sys + a.irq + a.idle);
    total += all;
    busy += all - (b.idle - a.idle);
  });
  return total > 0 ? (100 * busy) / total : 0;
}

/**
 * 输出照 CIM 的样子写成「空闲KB 忙%」一行，readCapacity 的解析和测试不用变
 * @param {number} pct
 */
const cimLine = (pct) => ({
  status: 0,
  stdout: `${Math.floor(freemem() / 1024)} ${pct.toFixed(1)}`,
  stderr: '',
  error: undefined,
});

/**
 * Windows 读一次空闲内存（KB）和 CPU 忙的百分比。
 * 以前起 PowerShell 读 CIM，单次 2～8 秒，同一轮派几个 Agent 时叠过钩子 10 秒上限、整批超时被拦（2026-11-04、11-05 实测）；
 * 改用 node 自带的 os.freemem()、os.cpus() 两次采样，不起子进程。
 */
function realCim() {
  try {
    const t0 = cpus().map((c) => c.times);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, CPU_SAMPLE_MS);
    return cimLine(
      busyPercent(
        t0,
        cpus().map((c) => c.times),
      ),
    );
  } catch (e) {
    return { status: null, stdout: '', stderr: '', error: e instanceof Error ? e : new Error(String(e)) };
  }
}

/** 真的 vm_stat：macOS 读一次页统计 */
function realVmStat() {
  const r = spawnSync('vm_stat', [], { encoding: 'utf8', timeout: VM_STAT_TIMEOUT_MS });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

/** vm_stat 里能马上给新进程用的页：空闲、不活跃、预读、可清除 */
const VM_STAT_AVAILABLE = ['Pages free', 'Pages inactive', 'Pages speculative', 'Pages purgeable'];

/**
 * 不堵着的读一次（收尾钩子和读队列并行跑）：Windows 的两次 CPU 采样用定时器隔开，其余照同步的读。
 * @returns {Promise<Reading>}
 */
export function readCapacityAsync() {
  if (process.platform !== 'win32') return Promise.resolve(readCapacity());
  const t0 = cpus().map((c) => c.times);
  return new Promise((done) => {
    setTimeout(() => {
      const line = cimLine(
        busyPercent(
          t0,
          cpus().map((c) => c.times),
        ),
      );
      done(readCapacity({ runCim: () => line }));
    }, CPU_SAMPLE_MS);
  });
}

/** @param {unknown} e */
const why = (e) => (e instanceof Error ? e.message : String(e));

/**
 * 读一次本机的空闲内存和 1 分钟负载。不抛：读不到返回 { ok: false, why }。
 * @param {ReadDeps} [deps]
 * @returns {Reading}
 */
export function readCapacity({
  platform = process.platform,
  cores = availableParallelism(),
  runCim = realCim,
  readText = (p) => readFileSync(p, 'utf8'),
  runVmStat = realVmStat,
  loadavg: readLoadavg = loadavg,
} = {}) {
  try {
    if (!Number.isInteger(cores) || cores <= 0) return { ok: false, why: `核数认不出（${cores}）` };
    if (platform === 'win32') {
      const r = runCim();
      if (r.error) return { ok: false, why: `CPU 采样没读成（${r.error.message}）` };
      if (r.status !== 0) {
        return {
          ok: false,
          why: `CPU 采样没读成（退出码 ${r.status}：${r.stderr.trim().slice(0, 200)}）`,
        };
      }
      const m = /^\s*(\d+)\s+(\d+(?:\.\d+)?)\s*$/.exec(r.stdout);
      if (!m) return { ok: false, why: `CIM 的输出认不出：${r.stdout.trim().slice(0, 200) || '（空）'}` };
      const busy = Number(m[2]) / 100;
      return {
        ok: true,
        freeBytes: Number(m[1]) * 1024,
        load1: busy * cores,
        cores,
        how: `os.freemem、os.cpus 采样：CPU 忙 ${Math.round(busy * 100)}%（折成负载）`,
      };
    }
    if (platform === 'linux') {
      const mem = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(readText('/proc/meminfo'));
      if (!mem) return { ok: false, why: '/proc/meminfo 里没有 MemAvailable' };
      const load = /^\s*(\d+(?:\.\d+)?)\s/.exec(readText('/proc/loadavg'));
      if (!load) return { ok: false, why: '/proc/loadavg 认不出' };
      return {
        ok: true,
        freeBytes: Number(mem[1]) * 1024,
        load1: Number(load[1]),
        cores,
        how: '/proc/meminfo MemAvailable、/proc/loadavg',
      };
    }
    if (platform === 'darwin') {
      const r = runVmStat();
      if (r.error) return { ok: false, why: `vm_stat 没读成（没跑起来：${r.error.message}）` };
      if (r.status !== 0)
        return { ok: false, why: `vm_stat 没读成（退出码 ${r.status}：${r.stderr.trim().slice(0, 200)}）` };
      const page = /page size of (\d+) bytes/.exec(r.stdout);
      if (!page)
        return { ok: false, why: `vm_stat 的输出认不出页大小：${r.stdout.trim().slice(0, 200) || '（空）'}` };
      let pages = 0;
      for (const name of VM_STAT_AVAILABLE) {
        const m = new RegExp(`^${name}:\\s+(\\d+)\\.?$`, 'm').exec(r.stdout);
        if (!m) return { ok: false, why: `vm_stat 里没有「${name}」` };
        pages += Number(m[1]);
      }
      const load1 = readLoadavg()[0];
      if (typeof load1 !== 'number' || !Number.isFinite(load1))
        return { ok: false, why: `loadavg 认不出（${load1}）` };
      return {
        ok: true,
        freeBytes: pages * Number(page[1]),
        load1,
        cores,
        how: 'vm_stat 空闲 + 不活跃 + 预读 + 可清除页、os.loadavg()',
      };
    }
    return {
      ok: false,
      why: `这个平台（${platform}）不认，只会读 Windows 的 CIM、Linux 的 /proc 和 macOS 的 vm_stat`,
    };
  } catch (e) {
    return { ok: false, why: `读数自己出错了（${why(e)}）` };
  }
}

/** @param {number} bytes */
const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)}G`;

/**
 * 读数一句话：空闲内存 x G，1 分钟负载 y / 核数 z（上限 w）。
 * @param {Extract<Reading, { ok: true }>} r
 */
export function describeReading(r) {
  return `空闲内存 ${gb(r.freeBytes)}（至少 ${gb(MIN_FREE_BYTES)}），1 分钟负载 ${r.load1.toFixed(1)}（核数 ${r.cores} × ${LOAD_PER_CORE} = ${(r.cores * LOAD_PER_CORE).toFixed(1)} 以内）`;
}

/**
 * 判够不够：enough 是 true / false；没查成是 null（调用方明说没查成，不当成够）。text 是带读数的一句话。
 * 只看内存和负载两条，不看在跑几个工人（决定 0094：不设固定个数）。
 * @param {Reading} r
 * @returns {{ enough: boolean | null, text: string }}
 */
export function judgeCapacity(r) {
  if (!r.ok) return { enough: null, text: `本机容量没查成：${r.why}` };
  /** @type {string[]} */
  const short = [];
  if (r.freeBytes < MIN_FREE_BYTES) short.push('空闲内存不够');
  if (r.load1 > r.cores * LOAD_PER_CORE) short.push('负载太高');
  const reading = describeReading(r);
  return short.length === 0
    ? { enough: true, text: `本机容量够：${reading}` }
    : { enough: false, text: `本机容量不够（${short.join('、')}）：${reading}` };
}
