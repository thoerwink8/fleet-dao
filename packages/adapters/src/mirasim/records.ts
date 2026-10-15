// 没等到 accepted 时，按工作目录和起针时间去 ~/.mirasim/sessions/<agent>/<id>/record.json 对账（MS-18）。
// 对上唯一一条就把它的会话号交回去，调用方按正常会话订阅，不重发 prompt。多条、没有、读不了都交回「没查成」。
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { rec, str } from '../stream-kit.ts';
import type { LedgerFs } from './ledger.ts';

/**
 * 读会话档案怎么做：默认直接读本机文件。档案在会话用户家里、引擎进不去时换成这个（和账本同一份 as-user 读法）。
 * readdir 找不到目录要抛 code 为 ENOENT 的错，否则「还没有这个执行体的会话」和「列不了」分不开。
 */
export type SessionsFs = LedgerFs;

const nodeSessionsFs: SessionsFs = {
  readdir: (dir) => readdir(dir),
  readFile: (path) => readFile(path, 'utf8'),
};

/**
 * 下沿比起针早这么多。账本核对已经用这份余量（run.ts 读账本 since = t0 - 5 秒）：服务端写 createdAt 的钟
 * 和引擎的钟差过这点，刚起的会话就会落在窗外，被看成「不是这一针」。
 */
export const LAUNCH_MATCH_SKEW_MS = 5_000;

/**
 * 上沿比起会话预算再多这么多。法国 #2181（2026-10-14 23:05Z）：插头 23:05:48 收了，会话 23:05:52 才写上，晚 4 秒。
 * MS-15 状态翻面大约 3 秒。15 秒盖住「应答帧没到、记录晚几秒才落盘」，又短到不会把人紧接着手起的下一条卷进来。
 * 服务被堵、会话要过几十秒才起（MS-08 实测 40–58 秒，MS-31 那次 34 秒）已经算在起会话预算 startupMs 里，不在这 15 秒里。
 */
export const LAUNCH_RECORD_LAG_MS = 15_000;

/** 两次去翻档案隔这么久。#2181 的记录晚 4 秒才出现，一秒看一次赶得上，也不把会话用户家里扫太勤。 */
const LAUNCH_SCAN_MS = 1_000;

/** 目录名要是账本认得的那种 uuid，会话号才拼得出来（`<agent>:<uuid>`，ledger.ts 同一条）。 */
const SESSION_UUID = /^[0-9a-f-]{36}$/i;

export type LaunchMatch =
  | { kind: 'unique'; sessionKey: string; taskId?: string }
  | { kind: 'none'; detail: string }
  | { kind: 'many'; detail: string }
  | { kind: 'unreadable'; detail: string };

export interface ReconcileLaunchOptions {
  /** ~/.mirasim/sessions（不是下面的 <agent> 那一层）。 */
  sessionsDir: string;
  agent: string;
  /** 这一针 prompt 帧里的 workdir。档案里的 workdir 对得上它才算。 */
  cwd: string;
  /** 起针时刻（毫秒）。窗是 [t0 - 钟差, t0 + startupMs + 落盘余量]。 */
  t0: number;
  startupMs: number;
  /** 不给就直接读本机文件。生产以会话用户的身份读（和 run 的 sessionsFs 同一个字段）。 */
  sessionsFs?: SessionsFs;
  clock?: () => number;
  pause?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

interface Hit {
  sessionKey: string;
  taskId?: string;
}

/**
 * 起针时间窗里、这个工作目录上的会话。
 * 只认 record.json 的 createdAt（会话出生）。runStartedAt 会在旧会话被下一轮刷新，拿它来对就会接到别人正在跑的那条上。
 * 没到上沿就看到恰好一条先按住：再等落盘余量，余量里冒出第二条就挂起。余量走完还是一条才接上——#2181 的记录比收手晚 4 秒，
 * 提前接上会在第二条还没写出来时认错。一条都没有就一直看到上沿（连接提前断了，服务可能还堵着，会话马上写出来）。
 * 到了上沿还是一条也接上，不再空等。列不了、某条档案认不出：马上交「读不了」，不当成没有（半截 JSON 也是；Linux 上正常是写完再改名）。
 */
export async function reconcileLaunchSession(options: ReconcileLaunchOptions): Promise<LaunchMatch> {
  const fs = options.sessionsFs ?? nodeSessionsFs;
  const clock = options.clock ?? Date.now;
  const pause = options.pause ?? sleep;
  const start = options.t0 - LAUNCH_MATCH_SKEW_MS;
  const end = options.t0 + options.startupMs + LAUNCH_RECORD_LAG_MS;
  const folder = join(options.sessionsDir, options.agent);
  const cwd = normDir(options.cwd);
  /** 已经能排除的目录（别的工作目录、出生时刻在窗外）：下一圈不再读。 */
  const skipped = new Set<string>();
  let sole: Hit | undefined;
  let soleSince = 0;

  for (;;) {
    const scanned = await scanSessions(fs, folder, options.agent, cwd, start, end, skipped);
    if (scanned.kind === 'unreadable') {
      return { kind: 'unreadable', detail: `会话记录读不了：${scanned.detail}（不当成没起）` };
    }
    if (scanned.hits.length >= 2) {
      const keys = scanned.hits.map((h) => h.sessionKey).sort();
      return {
        kind: 'many',
        detail: `对过账对上了 ${keys.length} 条（${keys.join('、')}），分不清是哪一条`,
      };
    }
    const now = clock();
    if (scanned.hits.length === 1) {
      const hit = scanned.hits[0] as Hit;
      if (!sole || sole.sessionKey !== hit.sessionKey) {
        sole = hit;
        soleSince = now;
      }
      if (now - soleSince >= LAUNCH_RECORD_LAG_MS || now >= end) return unique(hit);
    } else {
      sole = undefined;
    }
    if (now >= end) {
      return {
        kind: 'none',
        detail: `对过账，${cwd} 在起针时间窗（${iso(start)} 至 ${iso(end)}）里没有会话`,
      };
    }
    if (options.signal?.aborted) {
      if (sole && scanned.hits.length === 1) return unique(sole);
      return { kind: 'none', detail: '对账被叫停，时间窗没看完' };
    }
    const step = Math.min(LAUNCH_SCAN_MS, end - now);
    const before = clock();
    await pause(step);
    // pause 没把 clock 往前拨（测试只换了一个）就真睡，免得空转卡死
    if (clock() <= before) await sleep(step);
  }
}

function unique(hit: Hit): LaunchMatch {
  return { kind: 'unique', sessionKey: hit.sessionKey, ...(hit.taskId ? { taskId: hit.taskId } : {}) };
}

type Scan = { kind: 'ok'; hits: Hit[] } | { kind: 'unreadable'; detail: string };

async function scanSessions(
  fs: SessionsFs,
  folder: string,
  agent: string,
  cwd: string,
  start: number,
  end: number,
  skipped: Set<string>,
): Promise<Scan> {
  let names: string[];
  try {
    names = await fs.readdir(folder);
  } catch (err) {
    if (errno(err) === 'ENOENT') return { kind: 'ok', hits: [] };
    return { kind: 'unreadable', detail: `列不了 ${folder}：${errno(err) ?? (err as Error).message}` };
  }
  const hits: Hit[] = [];
  for (const name of names) {
    if (!SESSION_UUID.test(name)) continue;
    if (skipped.has(name)) continue;
    const file = join(folder, name, 'record.json');
    let text: string;
    try {
      text = await fs.readFile(file);
    } catch (err) {
      if (errno(err) === 'ENOENT') continue;
      return { kind: 'unreadable', detail: `读不了 ${file}：${errno(err) ?? (err as Error).message}` };
    }
    const parsed = parseRecord(text);
    if (parsed.kind === 'bad') return { kind: 'unreadable', detail: `${file} 认不出` };
    const placed = place(parsed.record, cwd, start, end);
    if (placed === 'skip') {
      skipped.add(name);
      continue;
    }
    if (placed === 'unreadable')
      return { kind: 'unreadable', detail: `${file} 对不上工作目录或出生时刻，排除不了` };
    hits.push({
      sessionKey: `${agent}:${name}`,
      ...(placed.taskId ? { taskId: placed.taskId } : {}),
    });
  }
  return { kind: 'ok', hits };
}

function parseRecord(text: string): { kind: 'ok'; record: Record<string, unknown> } | { kind: 'bad' } {
  try {
    const record = rec(JSON.parse(text));
    return record ? { kind: 'ok', record } : { kind: 'bad' };
  } catch {
    return { kind: 'bad' };
  }
}

/** 不是这条：别的目录，或出生时刻在窗外。排除不了：工作目录对上了但时刻认不出。 */
function place(
  record: Record<string, unknown>,
  cwd: string,
  start: number,
  end: number,
): 'skip' | 'unreadable' | { taskId?: string } {
  const dir = str(record.workdir) ?? str(record.workspacePath);
  if (dir === undefined || normDir(dir) !== cwd) return 'skip';
  const born = parseTime(record.createdAt);
  if (born === undefined) return 'unreadable';
  if (born < start || born > end) return 'skip';
  const taskId = str(record.taskId);
  return taskId ? { taskId } : {};
}

function parseTime(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return epochMs(value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
    const asNum = Number(value);
    if (Number.isFinite(asNum)) return epochMs(asNum);
  }
  return undefined;
}

/** 13 位左右是毫秒；10 位左右是秒（档案两种都见过）。 */
function epochMs(n: number): number {
  return n < 1e12 ? n * 1000 : n;
}

function normDir(path: string): string {
  const s = path.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return s.length > 0 ? s : '/';
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function errno(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === 'string' ? code : undefined;
}
