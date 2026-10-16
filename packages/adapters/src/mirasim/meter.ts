// 按会话读 Mirasim 的用量账本（中转计量），一次会话的输入、输出、缓存读、缓存写、花费（#1935）。
//
// 改这里之前必须知道（Mirasim 服务端 0.0.466 的 server.cjs 查实，函数名是混淆后的）：
// - 账本在会话用户家里的 ~/.mirasim/insights/usage-<年-月>.ndjson，一次上游调用一行：id 是 <会话 uuid>:<callId>，有 sessionId、
//   ts（调用发出的时刻）、leg（relay 走中转 / direct 直连 / local 本地回的）、viaRelay、status、input、output、cacheRead、
//   cacheWrite。input 是没命中缓存的那部分（和 runs.input_tokens 同一个口径；法国 codex 会话两边逐笔对得上）。
// - 走中转的调用，当时先写一行四样全 0 的占位。服务端过 90 秒（OJo）以后、每 3 分钟（C5i 的 180000）问一次中转的 /usage/calls，
//   回填那一行（原地改，写临时文件再换名，不另起一行），填好的带 relayMetered: true；中转说没有这次调用、过了一天的
//   记 noRelayRecord: true（Jzn / HJo）。中转回包带 usd 才有 relayUsd（0.0.466 时法国一行都没有）。
// - 哪些行服务端不再问中转（Wzn）：不是 2xx 的、已经 relayMetered / noRelayRecord 的、已经有用量且不是 usageSource: 'agent'
//   的。这里照同一条判法认「填好了」，其余走中转的 2xx 一律是「还没回填」——全 0 的占位不当成 0。
// - 不计费的不算：本地回的（leg: local、answeredLocally）、上游没回 2xx 的。
// - 一次会话里有一次调用还没回填，整次算「还没齐」，不给部分数：部分数写进库会被当成全的。
// - 月度文件几十 MB：读法（MeterFs）只取含会话 uuid 的行（生产以会话用户 grep -F），这里再按 sessionId 精确认一遍。
// - 用量账本里这一笔一次计费调用都没有，分不出「没花钱」还是「漏记」（#2675，法国 10-14 到 10-16 的 19 笔查实）：要再看
//   流量记录 ~/.mirasim/traffic/<会话 uuid>/index-*.ndjson（每次上游调用一行，有 ts、status，没有 token 数）。
//   流量里这段时间一次都没有（会话起不来、codex app-server initialize 超时、桥接连不上、同一会话的调用都在前后几笔里）、
//   或上游都回了 4xx/5xx 的，是真没有计费调用，读成 none（用量记 0）；流量里有 2xx、用量账本里却没有这几行的（Mirasim 没记进
//   用量账本）、只有没等到回应就断了的（状态码 0），是没对上，照旧读不成，原因里写清是哪一种。
// - 这一笔的起点放宽 METER_EARLY_MS 算：账本行比这一笔起点早几秒、同一会话的算进来；但不越过同一会话上一笔的终点
//   （MeterWindow.notBefore），不把上一笔的调用算两遍。

import { readdir, readFile } from 'node:fs/promises';
// 路径照会话用户那台机器（Linux）拼：生产经 exec 以会话用户读，Windows 上的 node 也认斜杠
import { posix } from 'node:path';
import { num, rec, str } from '../stream-kit.ts';

/**
 * 读账本用的文件访问。生产经 fleet-agent-scope 以会话用户读（engine 的 real/index.ts）。readdir 找不到目录要抛 code 是
 * 'ENOENT' 的错；linesWith 读不了要抛（不回空串冒充「没有这个会话的行」），一行都没对上回空串。
 */
export interface MeterFs {
  readdir(dir: string): Promise<string[]>;
  /** 这几份文件里含任一个 needle 的行（原文，换行分隔）。 */
  linesWith(needles: readonly string[], paths: readonly string[]): Promise<string>;
}

export const nodeMeterFs: MeterFs = {
  readdir: (dir) => readdir(dir),
  async linesWith(needles, paths) {
    const out: string[] = [];
    for (const path of paths) {
      for (const line of (await readFile(path, 'utf8')).split('\n')) {
        if (needles.some((n) => line.includes(n))) out.push(line);
      }
    }
    return out.join('\n');
  },
};

/**
 * 要读的一次会话：会话号（<执行体>:<uuid>）和这一笔的起止（毫秒，两头都含）。续跑的会话号会在别的笔里再出现，只认这段时间里发出的调用。
 * 终点由调用方定：同一会话下一笔的起点，和这一笔 ended_at 加宽限，取更早的那个（meterWindowUntil）。会话被叫停后还在跑完的调用落在这段里。
 */
export interface MeterWindow {
  sessionKey: string;
  since: number;
  until: number;
  /** 同一会话上一笔的终点（毫秒）：起点往前放宽时不越过它（这之前、含这一刻的调用是上一笔的）。没有上一笔不给。 */
  notBefore?: number;
}

/** 账本行比这一笔起点早这么多以内、同一会话的，算进这一笔（不越过 notBefore）。 */
export const METER_EARLY_MS = 5_000;

/** 这一笔从什么时刻起的调用算它的。 */
function windowStart(window: MeterWindow): number {
  const early = window.since - METER_EARLY_MS;
  return window.notBefore === undefined ? early : Math.max(early, window.notBefore + 1);
}

/** 叫停之后还在跑完的调用，最多再认这么久（没有下一笔把窗口封上时）。 */
export const METER_TAIL_GRACE_MS = 2 * 60_000;

/**
 * 一笔计费窗口的终点（含这一毫秒）：同一会话下一笔的起点，和 endedAt 加宽限，取更早的那个。
 * 下一笔从它的起点算起（含这一毫秒），所以这一笔收到它之前，同一刻不进两笔。没有下一笔、或下一笔比宽限还晚：终点是 endedAt 加宽限。
 */
export function meterWindowUntil(endedAt: number, nextStartedAt: number | null): number {
  const graceEnd = endedAt + METER_TAIL_GRACE_MS;
  if (nextStartedAt === null || !Number.isFinite(nextStartedAt) || nextStartedAt > graceEnd) return graceEnd;
  return nextStartedAt - 1;
}

/** 读齐了的一次会话的用量。 */
export interface MeterUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** 每一次计费调用中转都报了花费才有（relayUsd 之和）；有一次没报就不给，不拿 0 顶。 */
  costUsd?: number;
  /** 算进来的计费调用次数。 */
  calls: number;
}

/**
 * 四态：读齐了 / 还在等回填（过一会儿再读）/ 这一笔没有计费调用（流量记录核实过：一次上游调用都没有，或上游都回了错；用量是 0）/
 * 读不成（中转没有这次调用的记录、行认不出、有调用但用量账本里没对上）。
 * unknown 带 noBilledCalls：用量账本里这段时间一次计费调用都没有、还没拿流量记录核过（meterReadingFrom 只看用量账本）。
 */
export type MeterReading =
  | { state: 'settled'; usage: MeterUsage }
  | { state: 'pending'; pending: number; calls: number; detail: string }
  | { state: 'none'; detail: string }
  | { state: 'unknown'; detail: string; noBilledCalls?: true };

const NO_BILLED_CALLS = 'Mirasim 用量账本里没有这个会话在这一笔起止之间的计费调用';
/** 兼容补记任务对「账本里没有调用」的固定文案引用。 */
export const METER_NO_CALLS_DETAIL = NO_BILLED_CALLS;

const USAGE_FILE = /^usage-(\d{4})-(\d{2})\.ndjson$/;
const UUID = /^[0-9a-f-]{36}$/i;
const DAY_MS = 24 * 60 * 60_000;

/** 会话号里的 uuid（<执行体>:<uuid>，没有冒号的整个当 uuid）；认不出是 undefined。 */
export function meterSessionUuid(sessionKey: string): string | undefined {
  const uuid = sessionKey.slice(sessionKey.indexOf(':') + 1);
  return UUID.test(uuid) ? uuid.toLowerCase() : undefined;
}

const count = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;

type CallVerdict =
  | { kind: 'skip' }
  | { kind: 'settled'; input: number; output: number; cacheRead: number; cacheWrite: number; usd?: number }
  | { kind: 'pending' }
  | { kind: 'unknown'; why: string };

/** 一行账本算哪一种（照 Mirasim 服务端 Wzn / rWt 的判法）。 */
function judgeCall(row: Record<string, unknown>): CallVerdict {
  const leg = str(row.leg);
  if (leg === 'local' || row.answeredLocally === true) return { kind: 'skip' };
  const status = num(row.status);
  if (status === undefined) return { kind: 'unknown', why: '有一次调用没记状态码' };
  if (status < 200 || status > 299) return { kind: 'skip' };
  const tokens = {
    input: count(row.input),
    output: count(row.output),
    cacheRead: count(row.cacheRead),
    cacheWrite: count(row.cacheWrite),
  };
  if (Object.values(tokens).some((v) => v === undefined)) {
    return { kind: 'unknown', why: '有一次调用的 token 数认不出' };
  }
  const t = tokens as Record<keyof typeof tokens, number>;
  const usdRaw = row.relayUsd;
  const usd = typeof usdRaw === 'number' && Number.isFinite(usdRaw) && usdRaw >= 0 ? usdRaw : undefined;
  const settled = { kind: 'settled' as const, ...t, ...(usd !== undefined ? { usd } : {}) };
  if (row.noRelayRecord === true) {
    return { kind: 'unknown', why: '中转没有这次调用的计量记录（Mirasim 记了 noRelayRecord）' };
  }
  if (row.relayMetered === true) return settled;
  const any = t.input + t.output + t.cacheRead + t.cacheWrite > 0;
  const relayed = row.viaRelay === true || leg === 'relay';
  if (!relayed) {
    // 直连：用量是 Mirasim 当场从上游回包里读的，没有回填这回事
    return any ? settled : { kind: 'unknown', why: '有一次直连调用没读到用量' };
  }
  // 走中转、还没回填：已经有用量、又不是从执行体自己的记录里抄的，服务端就不再问中转了（Wzn），照它算
  if (any && str(row.model) && row.usageSource !== 'agent') return settled;
  return { kind: 'pending' };
}

/** 这段时间（含前后一天，账本按月分文件、时区说不准）涉及的那几个月的文件名。 */
function monthsBetween(since: number, until: number): Set<string> {
  const names = new Set<string>();
  const from = new Date(since - DAY_MS);
  const to = new Date(until + DAY_MS);
  let y = from.getUTCFullYear();
  let m = from.getUTCMonth();
  while (y < to.getUTCFullYear() || (y === to.getUTCFullYear() && m <= to.getUTCMonth())) {
    names.add(`usage-${y}-${String(m + 1).padStart(2, '0')}.ndjson`);
    m += 1;
    if (m === 12) {
      m = 0;
      y += 1;
    }
  }
  return names;
}

/** 从已经筛出来的账本行里算一次会话的读数（纯函数，测试直接喂行）。 */
export function meterReadingFrom(text: string, window: MeterWindow): MeterReading {
  const uuid = meterSessionUuid(window.sessionKey);
  if (!uuid) return { state: 'unknown', detail: `会话号认不出：${window.sessionKey}` };
  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 };
  let calls = 0;
  let pending = 0;
  let allPriced = true;
  const unknown: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || !line.toLowerCase().includes(uuid)) continue;
    let row: Record<string, unknown> | undefined;
    try {
      row = rec(JSON.parse(line));
    } catch {
      row = undefined;
    }
    if (!row) {
      unknown.push('账本里有一行带这个会话号却认不出（不是 JSON 对象）');
      continue;
    }
    if (str(row.sessionId)?.toLowerCase() !== uuid) continue;
    const at = typeof row.ts === 'string' ? Date.parse(row.ts) : Number.NaN;
    if (!Number.isFinite(at)) {
      unknown.push('有一次调用的时间认不出，判不了是不是这一笔的');
      continue;
    }
    if (at < windowStart(window) || at > window.until) continue;
    const v = judgeCall(row);
    if (v.kind === 'skip') continue;
    if (v.kind === 'unknown') {
      unknown.push(v.why);
      continue;
    }
    calls += 1;
    if (v.kind === 'pending') {
      pending += 1;
      continue;
    }
    sum.input += v.input;
    sum.output += v.output;
    sum.cacheRead += v.cacheRead;
    sum.cacheWrite += v.cacheWrite;
    if (v.usd === undefined) allPriced = false;
    else sum.usd += v.usd;
  }
  if (unknown.length) {
    const kinds = [...new Set(unknown)];
    return {
      state: 'unknown',
      detail: `Mirasim 用量账本读不成（${unknown.length} 处）：${kinds.join('；')}`,
    };
  }
  if (pending > 0) {
    return {
      state: 'pending',
      pending,
      calls,
      detail: `还在等中转计量回填：${calls} 次计费调用里 ${pending} 次还没填（Mirasim 每 3 分钟回填一次）`,
    };
  }
  if (calls === 0) {
    return { state: 'unknown', detail: NO_BILLED_CALLS, noBilledCalls: true };
  }
  return {
    state: 'settled',
    usage: {
      inputTokens: sum.input,
      outputTokens: sum.output,
      cacheReadTokens: sum.cacheRead,
      cacheWriteTokens: sum.cacheWrite,
      // 到小数点后 6 位（和 runs.cost_usd 的精度一样）
      ...(allPriced ? { costUsd: Math.round(sum.usd * 1_000_000) / 1_000_000 } : {}),
      calls,
    },
  };
}

const TRAFFIC_FILE = /^index-.*\.ndjson$/;

/**
 * 用量账本里这一笔一次计费调用都没有时，拿这个会话的流量记录（已经筛出来的行；hasDir 是有没有这个会话的流量目录）判是没有计费
 * 调用（none）还是没对上（unknown）。纯函数，测试直接喂行。
 */
export function trafficVerdict(text: string, window: MeterWindow, hasDir: boolean): MeterReading {
  const uuid = meterSessionUuid(window.sessionKey);
  if (!uuid) return { state: 'unknown', detail: `会话号认不出：${window.sessionKey}` };
  if (!hasDir) {
    return {
      state: 'none',
      detail: '这一笔没有发出过模型调用（Mirasim 没有这个会话的流量记录，会话没走到上游），用量记 0',
    };
  }
  let ok = 0;
  let cut = 0;
  const failed: number[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || !line.toLowerCase().includes(uuid)) continue;
    let row: Record<string, unknown> | undefined;
    try {
      row = rec(JSON.parse(line));
    } catch {
      row = undefined;
    }
    if (!row || str(row.sessionId)?.toLowerCase() !== uuid) continue;
    const at = typeof row.ts === 'string' ? Date.parse(row.ts) : Number.NaN;
    if (!Number.isFinite(at)) {
      return {
        state: 'unknown',
        detail: `${NO_BILLED_CALLS}；流量记录里有一次调用的时间认不出，判不了是不是这一笔的`,
      };
    }
    if (at < windowStart(window) || at > window.until) continue;
    const status = num(row.status);
    if (status !== undefined && status >= 200 && status <= 299) ok += 1;
    else if (status !== undefined && status >= 400) failed.push(status);
    else cut += 1;
  }
  if (ok > 0) {
    return {
      state: 'unknown',
      detail: `没对上：Mirasim 流量记录里这一笔有 ${ok} 次上游调用回了 2xx，用量账本里却没有这几次的计费行（Mirasim 没把它们记进用量账本）`,
    };
  }
  if (cut > 0) {
    return {
      state: 'unknown',
      detail: `没对上：这一笔有 ${cut} 次上游调用没等到回应就断了（状态码 0），中转计没计费查不到`,
    };
  }
  if (failed.length > 0) {
    const codes = [...new Set(failed)].sort((a, b) => a - b).join('、');
    return {
      state: 'none',
      detail: `这一笔没有计费的模型调用：发出的 ${failed.length} 次上游调用都回了错（状态码 ${codes}），用量记 0`,
    };
  }
  return {
    state: 'none',
    detail:
      '这一笔没有发出过模型调用（Mirasim 流量记录里这个会话在这一笔起止之间一次上游调用都没有），用量记 0',
  };
}

/**
 * 一次读几次会话（一轮补记一次 ls、一次筛行）。和 windows 一一对应地回读数。目录列不出、筛行失败照抛：整轮没查成，
 * 不回一串「没有调用」。给了 trafficDir（~/.mirasim/traffic）：用量账本里一次计费调用都没有的那几笔再拿流量记录核
 * （trafficVerdict）；没给就照旧读不成，原因里说没核。
 */
export async function readMirasimMeter(
  dir: string,
  windows: readonly MeterWindow[],
  fs: MeterFs = nodeMeterFs,
  trafficDir?: string,
): Promise<MeterReading[]> {
  if (windows.length === 0) return [];
  const uuids = windows.map((w) => meterSessionUuid(w.sessionKey));
  const wanted = new Set<string>();
  for (const w of windows) {
    if (meterSessionUuid(w.sessionKey)) for (const m of monthsBetween(w.since, w.until)) wanted.add(m);
  }
  const needles = [...new Set(uuids.filter((u): u is string => u !== undefined))];
  let text = '';
  if (needles.length > 0) {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new Error(
        code === 'ENOENT'
          ? `没有 Mirasim 用量账本目录 ${dir}（这个会话用户的 Mirasim 服务没装，或账本换了地方）`
          : `列不出 Mirasim 用量账本目录 ${dir}：${(err as Error).message}`,
      );
    }
    const files = names.filter((n) => USAGE_FILE.test(n) && wanted.has(n)).sort();
    if (files.length > 0)
      text = await fs.linesWith(
        needles,
        files.map((n) => posix.join(dir, n)),
      );
  }
  const readings = windows.map((w) => meterReadingFrom(text, w));
  if (trafficDir === undefined) return readings;
  // 用量账本里没有计费调用的那几个会话：各列一次流量目录，含它们 uuid 的行一次筛完
  const empty = [
    ...new Set(
      windows.flatMap((w, i) => {
        const r = readings[i];
        const uuid = meterSessionUuid(w.sessionKey);
        return r?.state === 'unknown' && r.noBilledCalls && uuid ? [uuid] : [];
      }),
    ),
  ];
  if (empty.length === 0) return readings;
  const hasDir = new Set<string>();
  const files: string[] = [];
  for (const uuid of empty) {
    const folder = posix.join(trafficDir, uuid);
    let names: string[];
    try {
      names = await fs.readdir(folder);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error(`列不出 Mirasim 流量记录目录 ${folder}：${(err as Error).message}`);
    }
    hasDir.add(uuid);
    for (const n of names.filter((n) => TRAFFIC_FILE.test(n)).sort()) files.push(posix.join(folder, n));
  }
  const traffic = files.length > 0 ? await fs.linesWith(empty, files) : '';
  return readings.map((r, i) => {
    const w = windows[i] as MeterWindow;
    const uuid = meterSessionUuid(w.sessionKey);
    if (r.state !== 'unknown' || !r.noBilledCalls || !uuid) return r;
    return trafficVerdict(traffic, w, hasDir.has(uuid));
  });
}
