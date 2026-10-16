// 本机容量（单 #2731，决定 0094）：派写码工人前、收轮前对账时由代码判「本机还接得下一个工人吗」，不再靠一段文字。
// 判法只有两条，不设任何个数上限：空闲内存不少于 MIN_FREE_BYTES（4G）；1 分钟负载不超过核数 × LOAD_PER_CORE（0.8）。
// 读数：Windows 用 CIM（Win32_OperatingSystem.FreePhysicalMemory，Win32_Processor.LoadPercentage 的平均，折成「负载 = 忙的比例 × 核数」，
// Windows 没有 loadavg）；Linux 读 /proc/meminfo 的 MemAvailable 和 /proc/loadavg 的第一个数。别的平台、读不到、认不出一律
// { ok: false, why }——调用方要明说「没查成」，不当成够。
// 纯 node、不起常驻进程；agents-sync 原样装到 ~/.fleet-dao/hooks/，pretool.mjs 和 queue-stop.mjs 引它。
import { execFile, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';

/** 空闲内存至少这么多（字节）才派新工人 */
export const MIN_FREE_BYTES = 4 * 1024 ** 3;
/** 1 分钟负载不超过核数 × 这个数才派新工人 */
export const LOAD_PER_CORE = 0.8;
/** 读 CIM 的 PowerShell 最多等多久（毫秒）：起 PowerShell 本身就要一两秒；收尾钩子整个只有 10 秒 */
export const CIM_TIMEOUT_MS = 7000;

/** @typedef {{ ok: true, freeBytes: number, load1: number, cores: number, how: string } | { ok: false, why: string }} Reading 一次读数 */
/**
 * @typedef {{
 *   platform?: NodeJS.Platform,
 *   cores?: number,
 *   runCim?: () => { status: number | null, stdout: string, stderr: string, error?: Error | undefined },
 *   readText?: (path: string) => string,
 * }} ReadDeps 测试换掉读数的那几下
 */

const CIM_SCRIPT =
  '$ErrorActionPreference="Stop";' +
  '$o=Get-CimInstance Win32_OperatingSystem;' +
  '$p=(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average;' +
  'Write-Output ("{0} {1}" -f $o.FreePhysicalMemory,$p)';

const CIM_ARGS = ['-NoProfile', '-NonInteractive', '-Command', CIM_SCRIPT];

/** 真的 CIM：Windows PowerShell 读一次空闲内存（KB）和 CPU 忙的百分比 */
function realCim() {
  const r = spawnSync('powershell.exe', CIM_ARGS, {
    encoding: 'utf8',
    timeout: CIM_TIMEOUT_MS,
    windowsHide: true,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

/**
 * 不堵着的读一次（收尾钩子和读队列并行跑，省下起 PowerShell 的一两秒）。Windows 以外照同步的读。
 * @returns {Promise<Reading>}
 */
export function readCapacityAsync() {
  if (process.platform !== 'win32') return Promise.resolve(readCapacity());
  return new Promise((done) => {
    execFile(
      'powershell.exe',
      CIM_ARGS,
      { encoding: 'utf8', timeout: CIM_TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => {
        const code = err && typeof err.code === 'number' ? err.code : err ? null : 0;
        const spawnErr = !err
          ? undefined
          : err.killed
            ? new Error(`${CIM_TIMEOUT_MS} 毫秒没读完，杀掉了`)
            : typeof err.code !== 'number'
              ? err
              : undefined;
        done(
          readCapacity({
            runCim: () => ({ status: code, stdout: stdout ?? '', stderr: stderr ?? '', error: spawnErr }),
          }),
        );
      },
    );
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
} = {}) {
  try {
    if (!Number.isInteger(cores) || cores <= 0) return { ok: false, why: `核数认不出（${cores}）` };
    if (platform === 'win32') {
      const r = runCim();
      if (r.error) return { ok: false, why: `CIM 没读成（PowerShell 没跑起来：${r.error.message}）` };
      if (r.status !== 0) {
        return {
          ok: false,
          why: `CIM 没读成（PowerShell 退出码 ${r.status}：${r.stderr.trim().slice(0, 200)}）`,
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
        how: `CIM：空闲物理内存、CPU 忙 ${Math.round(busy * 100)}%（折成负载）`,
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
    return { ok: false, why: `这个平台（${platform}）不认，只会读 Windows 的 CIM 和 Linux 的 /proc` };
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
