// 按目录量磁盘占用（法国，root；fleet-footprint.timer 每 10 分钟拉起一轮，#3456）：对登记表里每个目录各跑一次
// `du -s -B1 -x`（C 写的，比 node 逐个 lstat 快一个量级；root 看得见会话用户 700 的工作树、会话用户的家、daihuo 的 750 目录），
// 各带各的超时，把「数」原子写进 /var/lib/fleet-footprint/sizes.json（644，fleet 用户读，驾驶舱后端按它画资源页）。
//
// 改这里之前必须知道：
// - 只写数字：路径（登记表里的）、字节数、测于何时、耗时、没读到的处数、没测成的原因（固定的几句话）。不写任何文件名、内容；
//   du 的 stderr 里有文件名，只数行数、不落盘、不进日志。所以不用给驾驶舱读内容的权限。
// - 目录清单只认 /usr/local/lib/fleet-dao/footprint/dirs.json：root:root 644，由 france.sh（自动档）从仓里 deploy/france/footprint/dirs.json
//   换上，和 packages/api/src/vps-apps.ts 的登记表一样（packages/api/test/disk-footprint.test.ts 核对）。fleet 用户碰不到它，
//   所以 fleet 没法让 root 去量任意路径。这里还会再验一遍：绝对路径、无 ..、无结尾 /，不是 /。
// - 口径和资源页原来的一样：占的块（不是文件名义大小，du -B1 不带 --apparent-size），硬链接同一次只算一次，不过挂载点（-x），不跟符号链接。
// - 每个目录各自一个超时（DIR_TIMEOUT_MS），顺序量、不并发，不把磁盘顶满；一个没量完不拖累别的。没量成的目录保留上次量成的数和
//   「测于」，并写原因（error）：后端据此显示旧数 + 测于何时 + 为什么没更新，不显示没有信息量的下限。
// - 这一轮没量成的原因写进 error，上次量成的 bytes/measuredAt 原样带着；从没量成过 bytes 是 null。读不到清单、写不出文件
//   才让这一轮退出码非 0（单元红）；单个目录量不成是数据，不是单元失败。
// - 顺带读定时任务（清单里的 timers）：oneshot 跑完 cgroup 就没了，资源页 5 秒一采抓不到，所以从 journalctl -u <服务> --since -24h
//   里数 systemd 每回结束打的「Consumed X CPU time, Y memory peak」，汇总成近 24 小时的次数、CPU 秒、单次内存峰值（只有数字）。
//   每个单元各带超时，读不到写原因（{ unit, why }），不当成 0。
// - 单元（fleet-footprint.service）以 root 跑但只留 CAP_DAC_READ_SEARCH、Nice、IO 空闲，每 10 分钟一轮不顶满机器。
import { execFile } from 'node:child_process';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const SCHEMA = 1;
export const SIZES_DIR = '/var/lib/fleet-footprint';
export const SIZES_FILE = `${SIZES_DIR}/sizes.json`;
export const DIRS_FILE = '/usr/local/lib/fleet-dao/footprint/dirs.json';
/** 两轮之间隔多久（和 fleet-footprint.timer 的 OnUnitInactiveSec 一样；后端按它判「旧了」）。 */
export const EVERY_MS = 10 * 60_000;
/** 一个目录最多量多久。 */
export const DIR_TIMEOUT_MS = 5 * 60_000;
/** 一个定时任务读一回日志最多多久。 */
export const JOURNAL_TIMEOUT_MS = 60_000;

/** 带 .timer 的应用的服务单元（oneshot，跑完 cgroup 就没了，资源页 5 秒一采抓不到）：名字只许这几种字符、以 .service 结尾、不以 - 开头。 */
const TIMER_UNIT = /^[A-Za-z0-9][A-Za-z0-9@:._-]*\.service$/;

/** 清单：{ schema: 1, dirs: [绝对路径…], timers?: [服务单元名…] }。不合规矩的整份拒绝（抛），不量一半。 */
export function parseDirs(text) {
  return parseManifest(text).dirs;
}

export function parseManifest(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`目录清单不是合法的 JSON：${e.message}`);
  }
  if (raw?.schema !== SCHEMA || !Array.isArray(raw.dirs) || raw.dirs.length === 0) {
    throw new Error('目录清单格式不对（要 { schema: 1, dirs: [至少一个路径] }）');
  }
  const seen = new Set();
  for (const d of raw.dirs) {
    if (
      typeof d !== 'string' ||
      !d.startsWith('/') ||
      d === '/' ||
      d.endsWith('/') ||
      d.split('/').includes('..') ||
      d.includes('\n') ||
      d.includes('\0')
    ) {
      throw new Error(`目录清单里的路径不合规矩：${JSON.stringify(d)}`);
    }
    if (seen.has(d)) throw new Error(`目录清单里有重复的路径：${d}`);
    seen.add(d);
  }
  const timers = raw.timers ?? [];
  if (!Array.isArray(timers) || timers.some((u) => typeof u !== 'string' || !TIMER_UNIT.test(u))) {
    throw new Error('目录清单里的 timers 要是服务单元名的数组（xxx.service）');
  }
  if (new Set(timers).size !== timers.length) throw new Error('目录清单里的 timers 有重复');
  return { dirs: raw.dirs, timers };
}

// systemd 每回 oneshot 结束打的一行：「Consumed 1min 3.2s CPU time, 68.2M memory peak, 0B memory swap peak, …」（旧版没有 memory peak）
const CPU_PART = { d: 86400, h: 3600, min: 60, s: 1, ms: 1e-3, us: 1e-6 };
const MEM_UNIT = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

/** 「1min 3.2s」「850ms」→ 秒；认不出回 undefined。 */
export function parseCpuTime(text) {
  const parts = text.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === '') return undefined;
  let total = 0;
  for (const p of parts) {
    const m = /^(\d+(?:\.\d+)?)(d|h|min|ms|us|s)$/.exec(p);
    if (!m) return undefined;
    total += Number(m[1]) * CPU_PART[m[2]];
  }
  return total;
}

/** 「68.2M」→ 字节；认不出回 undefined。 */
export function parseMemory(text) {
  const m = /^(\d+(?:\.\d+)?)([BKMGT])$/.exec(text.trim());
  return m ? Math.round(Number(m[1]) * MEM_UNIT[m[2]]) : undefined;
}

/** journalctl -o cat 的输出 → { runs24h, cpuSeconds24h, peakMemoryBytes }。没有一行「Consumed」回 undefined（由调用方写原因）。 */
export function summarizeJournal(text) {
  let runs = 0;
  let cpu = 0;
  let peak;
  for (const line of String(text).split('\n')) {
    const m = /^Consumed (.+?) CPU time(?:, ([0-9.]+[BKMGT]) memory peak)?/.exec(line.trim());
    if (!m) continue;
    const secs = parseCpuTime(m[1]);
    if (secs === undefined) continue;
    runs += 1;
    cpu += secs;
    const mem = m[2] ? parseMemory(m[2]) : undefined;
    if (mem !== undefined && (peak === undefined || mem > peak)) peak = mem;
  }
  if (runs === 0) return undefined;
  return { runs24h: runs, cpuSeconds24h: Math.round(cpu * 1000) / 1000, peakMemoryBytes: peak ?? null };
}

/** 真的 journalctl：回输出原文；失败抛固定的几句话。 */
export function realJournal(unit, timeoutMs = JOURNAL_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile(
      'journalctl',
      ['-u', unit, '--since', '-24h', '-o', 'cat', '--no-pager', '-q'],
      {
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, LC_ALL: 'C' },
      },
      (err, stdout) => {
        if (err?.killed || err?.signal === 'SIGKILL')
          reject(new Error(`journalctl 超过 ${Math.round(timeoutMs / 1000)} 秒没读完，被停掉`));
        else if (err && typeof err.code === 'string') reject(new Error(`journalctl 没跑起来（${err.code}）`));
        else if (err) reject(new Error(`journalctl 失败（退出码 ${err.code ?? '?'}）`));
        else resolve(String(stdout));
      },
    );
  });
}

/** 每个定时任务近 24 小时的次数、CPU 秒、单次内存峰值；读不到给 { unit, why }。 */
export async function measureTimers({ units, journal }) {
  const out = [];
  for (const unit of units) {
    try {
      const s = summarizeJournal(await journal(unit));
      out.push(
        s
          ? { unit, ...s }
          : { unit, why: '近 24 小时的日志里没有一回「Consumed … CPU time」（没跑过，或日志被清了）' },
      );
    } catch (e) {
      out.push({
        unit,
        why: (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 200),
      });
    }
  }
  return out;
}

/** 上一轮写的文件：认得出才用，认不出当没有（只影响「保留上次量成的数」，不影响这一轮）。 */
export function parsePrevious(text) {
  try {
    const raw = JSON.parse(text);
    if (raw?.schema !== SCHEMA || !Array.isArray(raw.dirs)) return new Map();
    const out = new Map();
    for (const e of raw.dirs) {
      if (
        typeof e?.path === 'string' &&
        Number.isSafeInteger(e.bytes) &&
        e.bytes >= 0 &&
        typeof e.measuredAt === 'string' &&
        !Number.isNaN(Date.parse(e.measuredAt))
      ) {
        out.set(e.path, { bytes: e.bytes, measuredAt: e.measuredAt });
      }
    }
    return out;
  } catch {
    return new Map();
  }
}

/** 真的 du：回 { bytes, skipped }，失败抛 Error（message 是固定的几句话，不含文件名）。 */
export function realDu(path, timeoutMs = DIR_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile(
      'du',
      ['-s', '-B1', '-x', '--', path],
      {
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, LC_ALL: 'C' },
      },
      (err, stdout, stderr) => {
        if (err?.killed || err?.signal === 'SIGKILL') {
          reject(new Error(`超过 ${Math.round(timeoutMs / 1000)} 秒没量完，被停掉`));
          return;
        }
        if (err?.code === 'ENOENT') {
          reject(new Error('机器上没有 du 命令'));
          return;
        }
        if (err && typeof err.code === 'string') {
          reject(new Error(`du 没跑起来（${err.code}）`));
          return;
        }
        const m = /^(\d+)\t/.exec(String(stdout));
        const lines = String(stderr)
          .split('\n')
          .filter((l) => l.trim() !== '');
        // 量的途中文件没了（会话在删工作树）不算没读到；其余的（权限、IO 错）数个数
        const skipped = lines.filter((l) => !/No such file or directory/.test(l)).length;
        if (!m) {
          reject(
            new Error(
              lines.some((l) => /No such file or directory/.test(l))
                ? '没有这个目录（或这台机器上没有）'
                : `du 没给出大小（退出码 ${err?.code ?? '?'}）`,
            ),
          );
          return;
        }
        resolve({ bytes: Number(m[1]), skipped });
      },
    );
  });
}

/**
 * 量一轮。du(path) 回 { bytes, skipped } 或抛；now() 回 Date。返回要写的对象。
 * previous 是 parsePrevious 的结果：这一轮没量成的目录带上次量成的数。
 */
export async function measureAll({ dirs, previous, du, now }) {
  const started = now();
  const out = [];
  for (const path of dirs) {
    const t0 = now();
    const prev = previous.get(path);
    let entry;
    try {
      const { bytes, skipped } = await du(path);
      entry = { bytes, measuredAt: t0.toISOString(), skipped, error: null };
    } catch (e) {
      const why = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 200);
      entry = {
        bytes: prev?.bytes ?? null,
        measuredAt: prev?.measuredAt ?? null,
        skipped: 0,
        error: why,
      };
    }
    const done = now();
    out.push({
      path,
      attemptedAt: t0.toISOString(),
      tookMs: Math.max(0, done.getTime() - t0.getTime()),
      ...entry,
    });
  }
  const finished = now();
  return {
    schema: SCHEMA,
    measuredAt: finished.toISOString(),
    everyMs: EVERY_MS,
    tookMs: Math.max(0, finished.getTime() - started.getTime()),
    dirs: out,
  };
}

/** 原子写：同目录写临时文件再 rename，读的人要么看到旧的整份、要么看到新的整份。 */
export async function writeSizes(result, file = SIZES_FILE) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(result)}\n`, { mode: 0o644 });
  await chmod(tmp, 0o644);
  await rename(tmp, file);
}

export async function main({
  dirsFile = DIRS_FILE,
  sizesFile = SIZES_FILE,
  du = realDu,
  journal = realJournal,
  now = () => new Date(),
  log = console.log,
} = {}) {
  const { dirs, timers } = parseManifest(await readFile(dirsFile, 'utf8'));
  let previous = new Map();
  try {
    previous = parsePrevious(await readFile(sizesFile, 'utf8'));
  } catch {
    // 第一轮：没有上次的
  }
  const result = await measureAll({ dirs, previous, du, now });
  result.timers = await measureTimers({ units: timers, journal });
  await writeSizes(result, sizesFile);
  const failed = result.dirs.filter((d) => d.error !== null).length;
  log(`量了 ${result.dirs.length} 个目录，${failed} 个没量成，共 ${Math.round(result.tookMs / 1000)} 秒`);
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`按目录量磁盘占用这一轮没成：${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}
