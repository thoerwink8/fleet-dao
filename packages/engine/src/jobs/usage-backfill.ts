// 用量补记（#1935）：经 Mirasim 起的会话，会话结束那一刻引擎只看得到订阅快照（claude、dsh、pi、kimi 只有本轮输出，codex 没有缓存写），
// 每次上游调用的真用量在 Mirasim 自己的用量账本里、靠中转计量事后回填（过 90 秒以后每 3 分钟一轮）。这个定时任务每 5 分钟
// 把近 24 小时结束的、四样 token 有缺的那几笔按会话号到账本补读：读齐了整套写回 runs，没齐写明为什么（runs.usage_note）。
//
// 改这里之前必须知道：
// - 一笔的计费窗口不是收到 ended_at。会话被叫停后 Mirasim 那边的请求还在跑完，那些调用落在 ended_at 之后。终点取「同一会话
//   下一笔的起点」和「ended_at + 2 分钟」里更早的那个（adapters 的 meterWindowUntil）；下一笔的起点归下一笔。宽限还没走完
//   （下一笔又还没把窗口封上）先不读，免得刚发出的调用还没落进账本就定案。
// - 只认读齐了的（adapters 的 mirasim/meter.ts：全 0 的占位算「还在等」，不当成 0）。写回只改四样还有缺的行，并写上
//   「叫停后的调用已补」记号（db 的 fillRunUsageFromMeter）。重复跑、两轮叠着跑都只写一次。
// - 已经按旧窗口补齐的近 14 天老行（四样齐、还没这个记号）按新窗口把终点之后的尾巴补上一次（fillRunMeterTail）。记号写上之后
//   不再收。尾巴还在等回填的先不写记号，下一轮再看；账本认不出的写「没读成」记号、不改已经记上的数，也不再重试。
// - 读不齐的不写数：还在等回填写「还在等」；会话结束过了 METER_LATE_MS 还没齐，原因里写「迟迟没回填」；中转没有记录、行认不出、
//   一次计费调用都对不上的照实写读不成的原因。过了回看窗口的不再补，原因留着（任务详情、巡检照它写）。
// - 读不成（账本里没有这一笔的计费调用、行认不出）的退避着读、读 UNREAD_MAX_ATTEMPTS 次定案不再补（见 UNREAD_BACKOFF_MS）；
//   定案的数仍留空，不写成 0，原因留在 usage_note。
// - 账本整个读不了（目录列不出、筛行失败）是这一轮没跑成，记 failed、看门狗报；单笔读不成是那一笔的事，这一轮记 partial。
// - 不标 needsMaster：它不拉单、不起会话，总开关关着也要把已经跑完的会话的账补齐。

import {
  METER_NO_CALLS_DETAIL,
  METER_TAIL_GRACE_MS,
  type MeterReading,
  type MeterWindow,
  meterWindowUntil,
} from '@fleet-dao/adapters';
import {
  type MeterPendingRun,
  type MeterTailRun,
  type MeterUsageWrite,
  type ScheduleResult,
  USAGE_GAVE_UP_PREFIX,
  USAGE_TAIL_MARKER,
  USAGE_TAIL_PREFIX,
} from '@fleet-dao/db';
import { errMessage } from '@fleet-dao/shared/util';
import type { ScheduleRunLog } from './github-reconcile.ts';

export const USAGE_BACKFILL_EVERY_MINUTES = 5;
/** 和拉单（每 5 分钟、错开 0 分）、巡检看一回错开。 */
export const USAGE_BACKFILL_OFFSET_MINUTES = 2;
/** 补多久以内结束的会话：Mirasim 自己最多回填 14 天，引擎这边一天还没齐就不再问了（原因留着）。 */
export const USAGE_BACKFILL_LOOKBACK_MS = 24 * 60 * 60_000;
/** 已补齐的老行重读尾巴的回看：和 Mirasim 自己最多回填的天数一样，再早的账本不再问。 */
export const USAGE_TAIL_LOOKBACK_MS = 14 * 24 * 60 * 60_000;
/** 一轮最多补多少笔（先结束的先补）：一次 ls、一次筛行，量大了下一轮接着补。 */
export const USAGE_BACKFILL_BATCH = 50;
/** 会话结束过了这么久还没回填齐，原因里写「迟迟没回填」（正常几分钟就齐）。 */
export const METER_LATE_MS = 30 * 60_000;

/**
 * 读不成（账本里没有这一笔的计费调用、行认不出）的退避：第 n 次读不成之后等 UNREAD_BACKOFF_MS[n-1] 再读；读了 UNREAD_MAX_ATTEMPTS 次
 * 还不成就定案不再补（USAGE_GAVE_UP_PREFIX）。「还在等回填」不算读不成，不走这套，照旧每轮看一次直到过了回看窗口。
 * 过去同一笔读不成的每 5 分钟读一次、两天 288 次，每次都记一条 partial，看门狗和人都分不出新旧。
 */
export const UNREAD_BACKOFF_MS: readonly number[] = [10, 20, 40, 80, 160].map((m) => m * 60_000);
export const UNREAD_MAX_ATTEMPTS = UNREAD_BACKOFF_MS.length + 1;

/** 这一笔 usage_note 里记着的「已经读不成几次」；不是读不成的原因（等回填、没写过）是 0，没带次数的老写法算 1。 */
export function unreadAttempts(note: string | null): number {
  const m = /^用量没读成(?:（第 (\d+) 次[^）]*）)?：/.exec(note ?? '');
  return m ? Number(m[1] ?? 1) : 0;
}

/** 这一笔此刻该不该读：读不成过的要等够退避。 */
export function dueForRead(run: MeterPendingRun, now: Date): boolean {
  const tried = unreadAttempts(run.usageNote);
  if (tried === 0) return true;
  const wait = UNREAD_BACKOFF_MS[Math.min(tried, UNREAD_BACKOFF_MS.length) - 1] ?? 0;
  return now.getTime() - run.updatedAt.getTime() >= wait;
}

export const USAGE_BACKFILL_JOB = {
  id: 'usage-backfill',
  name: '用量补记（经 Mirasim 起的会话，按中转计量补输入、缓存、花费）',
  schedule: '每 5 分钟（2 分起）',
  // 漏几轮不报：连着半小时没跑成才算过期
  expectEveryMinutes: 30,
} as const;

/** 写进 usage_note 的记号：计费窗口已经按放宽后的终点算过。 */
export function meterWindowNote(): string {
  const minutes = METER_TAIL_GRACE_MS / 60_000;
  return `${USAGE_TAIL_MARKER}：计费窗口终点是同一会话下一笔的起点和结束后 ${minutes} 分钟里更早的那个`;
}

/** 宽限走完了，或者下一笔已经把窗口封上（终点落在现在之前）。还开着的窗口先不读。 */
function meterWindowClosed(run: { endedAt: Date; nextStartedAt: Date | null }, now: Date): boolean {
  return now.getTime() > meterWindowUntil(run.endedAt.getTime(), run.nextStartedAt?.getTime() ?? null);
}

function meterWindowFor(
  run: { sessionId: string; startedAt: Date; endedAt: Date; nextStartedAt: Date | null },
  kind: 'full' | 'tail',
): MeterWindow | null {
  const until = meterWindowUntil(run.endedAt.getTime(), run.nextStartedAt?.getTime() ?? null);
  const since = kind === 'full' ? run.startedAt.getTime() : run.endedAt.getTime() + 1;
  if (since > until) return null;
  return { sessionKey: run.sessionId, since, until };
}

export interface UsageBackfillJobDeps {
  /** db 的 runsAwaitingMeter。 */
  pending(input: { endedAfter: Date; limit: number }): Promise<MeterPendingRun[]>;
  /** db 的 runsAwaitingMeterTail：四样已经齐、还没按新窗口补过尾巴的。 */
  tails(input: { endedAfter: Date; limit: number }): Promise<MeterTailRun[]>;
  /** adapters 的 readMirasimMeter（以会话用户读他家里的账本）：和 windows 一一对应。读不了照抛。 */
  readMeter(windows: readonly MeterWindow[]): Promise<MeterReading[]>;
  /** db 的 fillRunUsageFromMeter：写了回 true，已经齐了回 false。 */
  fill(runId: string, usage: MeterUsageWrite, at: Date): Promise<boolean>;
  /** db 的 fillRunMeterTail：补上终点之后的调用，或只写记号。写了回 true，已经带记号的回 false。 */
  fillTail(runId: string, add: MeterUsageWrite | null, note: string, at: Date): Promise<boolean>;
  /** db 的 noteRunUsage。 */
  note(runId: string, note: string, at: Date): Promise<boolean>;
  runs: ScheduleRunLog;
  now: () => Date;
  log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

/** 这一轮没跑成：结局已经记进 schedule_runs，再抛出去，调用方不会把它当成跑成了。 */
export class UsageBackfillFailedError extends Error {
  readonly runId: number;
  constructor(runId: number, message: string) {
    super(message);
    this.name = 'UsageBackfillFailedError';
    this.runId = runId;
  }
}

/** 没读齐的那一笔该写的原因。 */
export function meterNote(
  reading: Exclude<MeterReading, { state: 'settled' }>,
  run: MeterPendingRun,
  now: Date,
): string {
  if (reading.state === 'unknown') {
    const n = unreadAttempts(run.usageNote) + 1;
    if (n >= UNREAD_MAX_ATTEMPTS) {
      return `${USAGE_GAVE_UP_PREFIX}查了 ${n} 次都读不成，不再补；这一笔的用量留空（不是 0）：${reading.detail}`;
    }
    return `用量没读成（第 ${n} 次，还会再读）：${reading.detail}`;
  }
  const waited = Math.floor((now.getTime() - run.endedAt.getTime()) / 60_000);
  if (now.getTime() - run.endedAt.getTime() > METER_LATE_MS) {
    return `会话结束 ${waited} 分钟了，中转计量还没回填齐（${reading.pending} / ${reading.calls} 次调用没填；正常几分钟就齐）`;
  }
  return `等中转计量回填，补记任务每 5 分钟补一次（${reading.detail}）`;
}

type MeterWork =
  | { kind: 'pending'; run: MeterPendingRun; window: MeterWindow | null }
  | { kind: 'tail'; run: MeterTailRun; window: MeterWindow | null };

function tailAdd(run: MeterTailRun, usage: MeterReading & { state: 'settled' }): MeterUsageWrite {
  const u = usage.usage;
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadTokens: u.cacheReadTokens,
    cacheWriteTokens: u.cacheWriteTokens,
    // 原来没记花费时，不拿尾巴上的花费冒充整笔（那会把没定价的前半段写成 0）
    ...(run.costUsd !== null && u.costUsd !== undefined ? { costUsd: u.costUsd } : {}),
  };
}

async function round(deps: UsageBackfillJobDeps): Promise<ScheduleResult> {
  const now = deps.now();
  // 读不成过的还在退避里的这一轮不碰（它们的原因已经在 usage_note 里）。宽限还没走完的先不读。
  const pending = (
    await deps.pending({
      endedAfter: new Date(now.getTime() - USAGE_BACKFILL_LOOKBACK_MS),
      limit: USAGE_BACKFILL_BATCH,
    })
  ).filter((r) => dueForRead(r, now) && meterWindowClosed(r, now));
  const tailRows = (
    await deps.tails({
      endedAfter: new Date(now.getTime() - USAGE_TAIL_LOOKBACK_MS),
      limit: USAGE_BACKFILL_BATCH,
    })
  ).filter((r) => meterWindowClosed(r, now));
  const work: MeterWork[] = [
    ...pending.map((run) => ({ kind: 'pending' as const, run, window: meterWindowFor(run, 'full') })),
    ...tailRows.map((run) => ({ kind: 'tail' as const, run, window: meterWindowFor(run, 'tail') })),
  ];
  // 两段查询都空：扫过了（一次查询算一个），不是「一个都没扫到」。四样有缺的窗口可能还开着，滤掉之后也是这样。
  if (work.length === 0) return { outcome: 'ok', scanned: 1, found: 0 };
  const readable = work.filter((item): item is MeterWork & { window: MeterWindow } => item.window !== null);
  const readings = readable.length > 0 ? await deps.readMeter(readable.map((item) => item.window)) : [];
  if (readings.length !== readable.length) {
    throw new Error(`读账本回的读数（${readings.length}）和要补的笔数（${readable.length}）对不上`);
  }
  const readingOf = new Map<string, MeterReading>();
  readable.forEach((item, i) => {
    const reading = readings[i];
    if (reading) readingOf.set(`${item.kind}:${item.run.id}`, reading);
  });
  let filled = 0;
  let waiting = 0;
  const unread: string[] = [];
  for (const item of work) {
    if (item.kind === 'pending') {
      // 窗口是空的（下一笔和这一笔同一刻起）：没有能归到这一笔的调用
      const reading = item.window
        ? readingOf.get(`pending:${item.run.id}`)
        : ({ state: 'unknown', detail: METER_NO_CALLS_DETAIL } as const);
      if (!reading) throw new Error(`没读到这一笔的账本：${item.run.id}`);
      if (reading.state === 'settled') {
        const u = reading.usage;
        if (
          await deps.fill(
            item.run.id,
            {
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens,
              cacheReadTokens: u.cacheReadTokens,
              cacheWriteTokens: u.cacheWriteTokens,
              ...(u.costUsd !== undefined ? { costUsd: u.costUsd } : {}),
            },
            now,
          )
        ) {
          filled += 1;
        }
        continue;
      }
      if (reading.state === 'pending') waiting += 1;
      else unread.push(`${item.run.model}（${item.run.id}）：${reading.detail}`);
      await deps.note(item.run.id, meterNote(reading, item.run, now), now);
      continue;
    }
    const reading = item.window ? readingOf.get(`tail:${item.run.id}`) : undefined;
    if (item.window && !reading) throw new Error(`没读到这一笔的尾巴：${item.run.id}`);
    if (reading?.state === 'pending') {
      waiting += 1;
      continue;
    }
    const add = reading?.state === 'settled' ? tailAdd(item.run, reading) : null;
    const note =
      reading?.state === 'unknown' && reading.detail !== METER_NO_CALLS_DETAIL
        ? `${USAGE_TAIL_PREFIX}没读成：${reading.detail}`
        : meterWindowNote();
    if (await deps.fillTail(item.run.id, add, note, now)) filled += 1;
  }
  deps.log('info', '用量补记这一轮', {
    candidates: pending.length,
    tails: tailRows.length,
    filled,
    waiting,
    unread: unread.length,
  });
  if (unread.length > 0) {
    return {
      outcome: 'partial',
      why: `${unread.length} 笔用量读不成（原因已写进这几笔）：${unread.slice(0, 5).join('；')}${unread.length > 5 ? '……' : ''}`,
      scanned: work.length,
      found: filled,
    };
  }
  return { outcome: 'ok', scanned: work.length, found: filled };
}

/**
 * 跑一轮。记开始就失败（库连不上）：原样抛出，这一轮在库里没有记录。
 * 没跑成（账本读不了、库写不进）：记成 failed 再抛 UsageBackfillFailedError，不记成功。
 */
export async function runUsageBackfillJob(deps: UsageBackfillJobDeps): Promise<ScheduleResult> {
  const runId = await deps.runs.start(USAGE_BACKFILL_JOB.id, deps.now());
  let result: ScheduleResult;
  try {
    result = await round(deps);
  } catch (err) {
    result = { outcome: 'failed', why: `用量补记没跑成：${errMessage(err)}` };
  }
  await deps.runs.finish(runId, result, deps.now());
  if (result.outcome === 'failed') {
    deps.log('error', '用量补记这一轮没跑成', { runId, why: result.why });
    throw new UsageBackfillFailedError(runId, result.why);
  }
  return result;
}
