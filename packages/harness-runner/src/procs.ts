// 认一个会话的进程、按会话收（旧坑 A5）：会话 = 带会话标记 FLEET_RUN_ID 的进程，加根进程、它的进程组、它的子孙。
// 从旧 adapters/src/procs.ts 复制改写：记下每个进程的起始时刻，发信号前核对，PID 被别的进程复用了就不碰。
// 只认 Linux 的 /proc；没有 /proc（Windows 本机跑测试）时查不了，调用方照实记「没查成」，不当成收干净了。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

/** 会话标记：每个会话一个值，子孙都继承，内核重启后也能按它认出上一代的进程。 */
export const RUN_MARKER_KEY = 'FLEET_RUN_ID';

export const HAS_PROC = existsSync('/proc/self/stat');

interface ProcStat {
  ppid: number;
  pgid: number;
  /** 进程起始时刻（开机后的时钟滴答数）：同一个 PID 换了进程，这个值一定变。 */
  start: string;
}

/** 僵尸（已死、等父进程收尸）当成不在。 */
function readStat(pid: number): ProcStat | undefined {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // 进程名在括号里、可能带空格和括号：从最后一个右括号往后数字段（状态是第 3 个字段，起始时刻是第 22 个）
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z' || fields[0] === 'X') return undefined;
    return { ppid: Number(fields[1]), pgid: Number(fields[2]), start: fields[19] ?? '' };
  } catch {
    return undefined;
  }
}

function allPids(): number[] {
  return readdirSync('/proc')
    .filter((name) => /^\d+$/.test(name))
    .map(Number);
}

function hasMarker(pid: number, needle: Buffer): boolean {
  let environ: Buffer;
  try {
    environ = readFileSync(`/proc/${pid}/environ`);
  } catch {
    return false; // 别的用户的进程读不了，本来也不归我们管
  }
  // 每条变量以 \0 结尾；要整条匹配，前面必须是开头或上一条的 \0
  for (let at = environ.indexOf(needle); at >= 0; at = environ.indexOf(needle, at + 1)) {
    if (at === 0 || environ[at - 1] === 0) return true;
  }
  return false;
}

/** 一个会话此刻的进程：PID → 起始时刻。 */
export type ProcSnapshot = Map<number, string>;

export function sessionSnapshot(runId: string, rootPid?: number): ProcSnapshot {
  const found: ProcSnapshot = new Map();
  if (!HAS_PROC) return found;
  const needle = Buffer.from(`${RUN_MARKER_KEY}=${runId}\0`);
  const children = new Map<number, number[]>();
  const stats = new Map<number, ProcStat>();
  for (const pid of allPids()) {
    if (pid === process.pid) continue;
    const stat = readStat(pid);
    if (!stat) continue;
    stats.set(pid, stat);
    const siblings = children.get(stat.ppid);
    if (siblings) siblings.push(pid);
    else children.set(stat.ppid, [pid]);
    if (rootPid !== undefined && (pid === rootPid || stat.pgid === rootPid)) found.set(pid, stat.start);
    else if (hasMarker(pid, needle)) found.set(pid, stat.start);
  }
  if (rootPid !== undefined) {
    const queue = [rootPid];
    for (let pid = queue.shift(); pid !== undefined; pid = queue.shift()) {
      for (const child of children.get(pid) ?? []) {
        const stat = stats.get(child);
        if (stat) found.set(child, stat.start);
        queue.push(child);
      }
    }
  }
  return found;
}

/**
 * 给快照里的进程发信号：起始时刻对不上的（PID 被复用了）跳过；连同各自的进程组一起发，自己所在的组、init 的组不碰。
 * 回实际发到的个数。
 */
export function signalSnapshot(snapshot: ProcSnapshot, sig: NodeJS.Signals): number {
  const ownGroup = readStat(process.pid)?.pgid;
  const groups = new Set<number>();
  let sent = 0;
  for (const [pid, start] of snapshot) {
    if (pid === process.pid) continue;
    const now = readStat(pid);
    if (!now || now.start !== start) continue;
    if (now.pgid > 1 && now.pgid !== ownGroup) groups.add(now.pgid);
    try {
      process.kill(pid, sig);
      sent++;
    } catch {
      // 已经没了
    }
  }
  for (const pgid of groups) {
    try {
      process.kill(-pgid, sig);
    } catch {
      // 组已经空了
    }
  }
  return sent;
}

/** 快照里还活着、且确实是原来那个进程的个数。 */
export function stillAlive(snapshot: ProcSnapshot): number {
  let n = 0;
  for (const [pid, start] of snapshot) if (readStat(pid)?.start === start) n++;
  return n;
}

/**
 * 收掉一个会话剩下的进程：先 SIGTERM，等 graceMs 还在就 SIGKILL。回收之前找到几个、收完还剩几个；
 * 没有 /proc 时 leftovers 是 undefined（没查成）。
 */
export async function reapSession(
  runId: string,
  graceMs: number,
  extra: ProcSnapshot = new Map(),
): Promise<{ found: number; leftovers: number | undefined }> {
  if (!HAS_PROC) return { found: 0, leftovers: undefined };
  const snap: ProcSnapshot = new Map([...extra, ...sessionSnapshot(runId)]);
  for (const [pid, start] of [...snap]) if (readStat(pid)?.start !== start) snap.delete(pid);
  const found = snap.size;
  if (found === 0) return { found, leftovers: 0 };
  signalSnapshot(snap, 'SIGTERM');
  const until = Date.now() + graceMs;
  while (Date.now() < until && stillAlive(snap) > 0) await sleep(50);
  if (stillAlive(snap) > 0) signalSnapshot(snap, 'SIGKILL');
  await sleep(50);
  return { found, leftovers: stillAlive(new Map([...snap, ...sessionSnapshot(runId)])) };
}

/** 这个会话还有没有进程在：true / false；没有 /proc 查不了回 undefined（A7：查不了的不当成已经不在）。 */
export function runAlive(runId: string): boolean | undefined {
  if (!HAS_PROC) return undefined;
  return sessionSnapshot(runId).size > 0;
}
