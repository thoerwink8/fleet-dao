// 会话被信号杀掉（SIGKILL、SIGTERM，或退出码 137、143、没有终帧）时按证据说是谁杀的，不猜：
// 1. 那一刻引擎在不在停（收到过停机信号，drain.ts）——在停就是停机把它带走的（发布切版本、人手动重启），顺带写上有没有发布在跑；
//    只是在为发布排空（请求来的，还没收到停机信号）不算：排空到点是引擎自己按切号那一套停，不会走到信号这一步；
// 2. 内存：会话资源池（fleet-agents.slice）的 cgroup memory.events 里 oom_kill 这段时间涨没涨。这个数是分层累计的：会话自己的
//    scope 收掉以后照样留在上一层，内核按 cgroup 上限杀的、整机内存不够杀的都算。涨了、而且这段时间池里只有它，或者它自己
//    的 scope 里记过，就是内存超限；池里同时还有别的会话、自己的 scope 没读到记录，只说「池里有记录、归不到是不是它」；
// 3. 都对不上写「没查到原因」。哪一样没读成照实写没读成，不当成没有。
// 改这里之前必须知道：原来失败分流把 143/SIGTERM 一律写成「多半是内存超限」（KL2 的提示），把「我们自己的发布把它叫停了」盖住了
// ——2026-09-27 19:28:51、20:46:26 两次都是引擎被自动发布重启时 sudo 把 SIGTERM 转给了会话。码交给失败分流：engine_stop（KL3）、
// oom_killed（KL2）、signal_unexplained（KL4），规则见 failure/rules.ts。

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { errMessage } from '@fleet-dao/shared/util';
import type { Cordon } from '../drain.ts';

export const CGROUP_ROOT = '/sys/fs/cgroup';
/** 会话资源池在 cgroup 树里的位置（deploy/france/fleet-agents.slice；名字里的「-」是 systemd 的层级）。 */
export const AGENT_SLICE_PATH = 'fleet.slice/fleet-agents.slice';
export const VMSTAT = '/proc/vmstat';
/** 发布目录（deploy/release.sh 的 RELEASES）：发布锁、自动发布的读数都在这。 */
export const RELEASES_DIR = '/srv/fleet-dao-releases';
/** 停机信号和进程退出的先后差这么多以内算同一刻（systemd 同时发给引擎和 sudo，谁先被看到不一定）。 */
export const SAME_MOMENT_MS = 5_000;

export type KillCode = 'engine_stop' | 'oom_killed' | 'signal_unexplained';

export interface KillCause {
  code: KillCode;
  /** 一句证据，接在失败原文后面。 */
  why: string;
}

export interface OomCounters {
  /** 会话资源池累计按内存杀掉的进程数；undefined = 没读成（why 里有原因）。 */
  slice: number | undefined;
  sliceWhy?: string;
}

export interface KillEvidenceDeps {
  readText(path: string): Promise<string>;
  /** 发布锁此刻有没有人占着：true 占着、false 空着、undefined 没查成。 */
  releaseLockBusy(): Promise<boolean | undefined>;
  cgroupRoot: string;
  slicePath: string;
  releasesDir: string;
}

/**
 * memory.events 里按内存杀进程的累计数那一行；没有、数认不出都抛（调用方记没读成）。
 * 报错和原因里不写那个计数的英文名：失败分流 KL2 按原文认它，写进去会把「没读成」认成内存超限。
 */
export function parseOomKill(text: string): number {
  const m = /^oom_kill\s+(\d+)\s*$/m.exec(text);
  if (!m?.[1]) throw new Error('memory.events 里没有按内存杀进程的计数那一行');
  return Number(m[1]);
}

/** 读一次会话资源池的累计数（起会话时、收场时各读一次比）。 */
export async function oomCounters(deps: KillEvidenceDeps): Promise<OomCounters> {
  const path = join(deps.cgroupRoot, deps.slicePath, 'memory.events');
  try {
    return { slice: parseOomKill(await deps.readText(path)) };
  } catch (err) {
    return { slice: undefined, sliceWhy: `${path} 没读成（${errMessage(err)}）` };
  }
}

/** 会话自己的 scope 里记了几次（scope 还在才读得到）；读不到是 undefined。 */
export async function scopeOomKills(deps: KillEvidenceDeps, scopeUnit: string): Promise<number | undefined> {
  if (!/^[\w.@-]+\.scope$/.test(scopeUnit)) return undefined;
  try {
    return parseOomKill(
      await deps.readText(join(deps.cgroupRoot, deps.slicePath, scopeUnit, 'memory.events')),
    );
  } catch {
    return undefined;
  }
}

/** 进程是被信号杀的吗：有信号就看信号，没有就看 128+信号 的退出码（sh 包着的执行体被杀时交回 137、143）。 */
export function killSignal(
  exitCode: number | null | undefined,
  signal: string | null | undefined,
): string | null {
  const s = signal?.toUpperCase();
  if (s === 'SIGKILL' || s === 'SIGTERM') return s;
  if (s) return null;
  if (exitCode === 137) return 'SIGKILL';
  if (exitCode === 143) return 'SIGTERM';
  return null;
}

export interface KillFacts {
  signal: string;
  /** 进程退出的时刻（毫秒）。 */
  endedAt: number;
  /** 引擎的排空状态（交回时读的）。 */
  stopping: Cordon | null;
  /** 起会话时读的资源池累计数。 */
  before: OomCounters;
  /** 会话在跑的时候它自己的 scope 里见过的最大数（每回看守醒来读一次）；没读到过是 undefined。 */
  scopeSeen: number | undefined;
  /** 这段时间里同时在跑的别的会话有几个（这个工人进程手上的）。 */
  othersRunning: number;
}

/** 发布那一头此刻在干什么：发布锁占着、自动发布在发哪个。读不成的照实写。 */
async function releaseNote(deps: KillEvidenceDeps): Promise<string> {
  const parts: string[] = [];
  const busy = await deps.releaseLockBusy().catch(() => undefined);
  if (busy === true) parts.push('发布锁占着（有发布在跑）');
  else if (busy === undefined) parts.push('发布锁没查成');
  try {
    const st = JSON.parse(await deps.readText(join(deps.releasesDir, '.auto', 'state.json'))) as {
      attempt?: { sha?: unknown; result?: unknown; startedAt?: unknown } | null;
    };
    const a = st.attempt;
    if (a && a.result === 'running' && typeof a.sha === 'string') {
      parts.push(`自动发布在发 ${a.sha.slice(0, 12)}（${String(a.startedAt)} 起）`);
    }
  } catch (err) {
    parts.push(`自动发布的读数没读成（${errMessage(err)}）`);
  }
  return parts.join('，');
}

/** 按证据定是谁杀的。不抛：读不成的写进原因里。 */
export async function explainKill(deps: KillEvidenceDeps, facts: KillFacts): Promise<KillCause> {
  const s = facts.stopping;
  if (s?.source === 'signal') {
    const since = Date.parse(s.since);
    if (Number.isFinite(since) && since <= facts.endedAt + SAME_MOMENT_MS) {
      const release = await releaseNote(deps);
      return {
        code: 'engine_stop',
        why: `引擎停机时被带走（${s.since} ${s.why}${release ? `；${release}` : ''}）`,
      };
    }
  }
  const after = await oomCounters(deps);
  const notes: string[] = [];
  if (facts.scopeSeen !== undefined && facts.scopeSeen > 0) {
    return {
      code: 'oom_killed',
      why: `内存到了会话的上限，被内核杀掉（这个会话的 cgroup 记了 ${facts.scopeSeen} 次按内存杀进程）`,
    };
  }
  if (facts.before.slice !== undefined && after.slice !== undefined) {
    const grew = after.slice - facts.before.slice;
    if (grew > 0 && facts.othersRunning === 0) {
      return {
        code: 'oom_killed',
        why: `内存超限被内核杀掉（会话资源池这段时间记了 ${grew} 次按内存杀进程，那段时间只有它在跑）`,
      };
    }
    if (grew > 0) {
      notes.push(
        `会话资源池这段时间记了 ${grew} 次按内存杀进程，同时还有 ${facts.othersRunning} 个会话在跑，归不到是不是它`,
      );
    } else {
      notes.push('会话资源池这段时间没有按内存杀进程的记录');
    }
  } else {
    notes.push(
      `内存那一项没查成（${[facts.before.sliceWhy, after.sliceWhy].filter(Boolean).join('；') || '起会话时没读到'}）`,
    );
  }
  if (s?.source === 'release')
    notes.push(`那一刻在为发布排空（${s.why}，截止 ${s.until}），引擎还没收到停机信号`);
  const release = await releaseNote(deps);
  return {
    code: 'signal_unexplained',
    why: `没查到是谁杀的（${facts.signal}）：那一刻引擎没在停${release ? `；${release}` : ''}；${notes.join('；')}`,
  };
}

/** 发布锁有没有人占着：以共享锁试一下（flock -n -s，读得到锁文件就能试），占着 true、空着 false，别的都算没查成。 */
function flockProbe(lockFile: string): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('flock', ['-n', '-s', lockFile, 'true'], { stdio: 'ignore' });
    } catch {
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(undefined);
    }, 5_000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? false : code === 1 ? true : undefined);
    });
  });
}

/** 生产用的读法：真文件、真 flock。 */
export function realKillEvidence(overrides: Partial<KillEvidenceDeps> = {}): KillEvidenceDeps {
  const releasesDir = overrides.releasesDir ?? RELEASES_DIR;
  return {
    readText: (path) => readFile(path, 'utf8'),
    releaseLockBusy: () => flockProbe(join(releasesDir, '.lock')),
    cgroupRoot: CGROUP_ROOT,
    slicePath: AGENT_SLICE_PATH,
    releasesDir,
    ...overrides,
  };
}
