// 用量补记（#1935）：经 Mirasim 起的会话，会话结束那一刻引擎只看得到订阅快照（claude、dsh、pi、kimi 只有本轮输出，codex 没有缓存写），
// 每次上游调用的真用量在 Mirasim 自己的用量账本里、靠中转计量事后回填（过 90 秒以后每 3 分钟一轮）。这个定时任务每 5 分钟
// 把近 24 小时结束的、四样 token 有缺的那几笔按会话号到账本补读：读齐了整套写回 runs，没齐写明为什么（runs.usage_note）。
//
// 改这里之前必须知道：
// - 只认读齐了的（adapters 的 mirasim/meter.ts：全 0 的占位算「还在等」，不当成 0）；写回只改四样还有缺的行，补齐了的不再碰，
//   重复跑、两轮叠着跑都只写一次（db 的 fillRunUsageFromMeter）。
// - 读不齐的不写数：还在等回填写「还在等」；会话结束过了 METER_LATE_MS 还没齐，原因里写「迟迟没回填」；中转没有记录、行认不出、
//   一次计费调用都对不上的照实写读不成的原因。过了回看窗口的不再补，原因留着（任务详情、巡检照它写）。
// - 读不成（账本里没有这一笔的计费调用、行认不出）的退避着读、读 UNREAD_MAX_ATTEMPTS 次定案不再补（见 UNREAD_BACKOFF_MS）；
//   定案的数仍留空，不写成 0，原因留在 usage_note。
// - 账本整个读不了（目录列不出、筛行失败）是这一轮没跑成，记 failed、看门狗报；单笔读不成是那一笔的事，这一轮记 partial。
// - 不标 needsMaster：它不拉单、不起会话，总开关关着也要把已经跑完的会话的账补齐。
// - 「没调用」和「没对上」分开记（#2675）：读法核过流量记录、判成这一笔没有计费调用（none：会话起不来、初始化超时、上游都回了错）
//   的，会话结束过了 NONE_SETTLE_MS 就把四样和花费记 0，usage_note 写明为什么是 0；有调用没对上的照旧留空、退避着读，原因写清
//   是哪种没对上。改读法之前就定案不再补的老行（回看 USAGE_REREAD_LOOKBACK_MS）按新读法再读一次，读完带 USAGE_REREAD_MARK，
//   不再读第二次。

import type { MeterReading, MeterWindow } from '@fleet-dao/adapters';
import {
  type MeterPendingRun,
  type MeterUsageWrite,
  type ScheduleResult,
  USAGE_GAVE_UP_PREFIX,
  USAGE_REREAD_MARK,
} from '@fleet-dao/db';
import { errMessage } from '@fleet-dao/shared/util';
import type { ScheduleRunLog } from './github-reconcile.ts';

export const USAGE_BACKFILL_EVERY_MINUTES = 5;
/** 和拉单（每 5 分钟、错开 0 分）、巡检看一回错开。 */
export const USAGE_BACKFILL_OFFSET_MINUTES = 2;
/** 补多久以内结束的会话：Mirasim 自己最多回填 14 天，引擎这边一天还没齐就不再问了（原因留着）。 */
export const USAGE_BACKFILL_LOOKBACK_MS = 24 * 60 * 60_000;
/** 一轮最多补多少笔（先结束的先补）：一次 ls、一次筛行，量大了下一轮接着补。 */
export const USAGE_BACKFILL_BATCH = 50;
/** 会话结束过了这么久还没回填齐，原因里写「迟迟没回填」（正常几分钟就齐）。 */
export const METER_LATE_MS = 30 * 60_000;
/** 判成没有计费调用的，会话结束过了这么久才记 0：刚结束时流量记录、用量账本可能还没落盘，先等一等。 */
export const NONE_SETTLE_MS = 10 * 60_000;
/** 改读法之前定案不再补的老行，回看多久以内结束的（Mirasim 自己最多回填 14 天，账本按月留着）。 */
export const USAGE_REREAD_LOOKBACK_MS = 14 * 24 * 60 * 60_000;

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

export interface UsageBackfillJobDeps {
  /** db 的 runsAwaitingMeter。 */
  pending(input: { endedAfter: Date; limit: number }): Promise<MeterPendingRun[]>;
  /** db 的 runsGaveUpAwaitingReread：改读法之前定案不再补、还没按新读法重读过的。 */
  rereads(input: { endedAfter: Date; limit: number }): Promise<MeterPendingRun[]>;
  /** adapters 的 readMirasimMeter（以会话用户读他家里的用量账本、流量记录）：和 windows 一一对应。读不了照抛。 */
  readMeter(windows: readonly MeterWindow[]): Promise<MeterReading[]>;
  /** db 的 fillRunUsageFromMeter：写了回 true，已经齐了回 false。给了 note 一起写进 usage_note（记 0 的写明为什么）。 */
  fill(runId: string, usage: MeterUsageWrite, at: Date, note?: string): Promise<boolean>;
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

/** 没读齐的那一笔该写的原因（none 是还没到记 0 的时候：会话刚结束，等账本落盘）。 */
export function meterNote(
  reading: Exclude<MeterReading, { state: 'settled' }>,
  run: MeterPendingRun,
  now: Date,
): string {
  const waited = Math.floor((now.getTime() - run.endedAt.getTime()) / 60_000);
  if (reading.state === 'none') {
    return `会话结束 ${waited} 分钟，等 Mirasim 账本落盘再定：${reading.detail.replace(/，用量记 0$/, '')}`;
  }
  if (reading.state === 'unknown') {
    const n = unreadAttempts(run.usageNote) + 1;
    if (n >= UNREAD_MAX_ATTEMPTS) {
      return `${USAGE_GAVE_UP_PREFIX}查了 ${n} 次都读不成，不再补；这一笔的用量留空（不是 0）：${reading.detail}${USAGE_REREAD_MARK}`;
    }
    return `用量没读成（第 ${n} 次，还会再读）：${reading.detail}`;
  }
  if (now.getTime() - run.endedAt.getTime() > METER_LATE_MS) {
    return `会话结束 ${waited} 分钟了，中转计量还没回填齐（${reading.pending} / ${reading.calls} 次调用没填；正常几分钟就齐）`;
  }
  return `等中转计量回填，补记任务每 5 分钟补一次（${reading.detail}）`;
}

async function round(deps: UsageBackfillJobDeps): Promise<ScheduleResult> {
  const now = deps.now();
  // 读不成过的还在退避里的这一轮不碰（它们的原因已经在 usage_note 里）
  const fresh = (
    await deps.pending({
      endedAfter: new Date(now.getTime() - USAGE_BACKFILL_LOOKBACK_MS),
      limit: USAGE_BACKFILL_BATCH,
    })
  ).filter((r) => dueForRead(r, now));
  // 改读法之前定案不再补的老行：批里还有空位才捎上，按新读法读一次
  const room = USAGE_BACKFILL_BATCH - fresh.length;
  const rereads =
    room > 0
      ? await deps.rereads({ endedAfter: new Date(now.getTime() - USAGE_REREAD_LOOKBACK_MS), limit: room })
      : [];
  const rereadIds = new Set(rereads.map((r) => r.id));
  // 两边不重：pending 不收定案不再补的，rereads 只收定案不再补的
  const rows = [...fresh, ...rereads];
  // 扫的是近 24 小时那一段 runs：一笔要补的都没有也是扫过了（一次查询算一个），不是「一个都没扫到」
  if (rows.length === 0) return { outcome: 'ok', scanned: 1, found: 0 };
  const readings = await deps.readMeter(
    rows.map((r) => ({
      sessionKey: r.sessionId,
      since: r.startedAt.getTime(),
      until: r.endedAt.getTime(),
      ...(r.previousEndedAt ? { notBefore: r.previousEndedAt.getTime() } : {}),
    })),
  );
  if (readings.length !== rows.length) {
    throw new Error(`读账本回的读数（${readings.length}）和要补的笔数（${rows.length}）对不上`);
  }
  let filled = 0;
  let zeroed = 0;
  let waiting = 0;
  const unread: string[] = [];
  for (const [i, run] of rows.entries()) {
    const reading = readings[i] as MeterReading;
    const reread = rereadIds.has(run.id);
    if (reading.state === 'none' && (reread || now.getTime() - run.endedAt.getTime() >= NONE_SETTLE_MS)) {
      // 核实过一次计费调用都没有：用量是 0，不是没读到
      const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
      if (await deps.fill(run.id, zero, now, reading.detail)) zeroed += 1;
      continue;
    }
    if (reread && reading.state !== 'settled') {
      // 老行按新读法也没读成：再定案一次，带上重读过的记号，不读第二次
      unread.push(`${run.model}（${run.id}）：${reading.detail}`);
      await deps.note(
        run.id,
        `${USAGE_GAVE_UP_PREFIX}改读法之前定案的这一笔按新读法重读了一次，还是读不成，不再补；这一笔的用量留空（不是 0）：${reading.detail}${USAGE_REREAD_MARK}`,
        now,
      );
      continue;
    }
    if (reading.state === 'settled') {
      const u = reading.usage;
      if (
        await deps.fill(
          run.id,
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
    if (reading.state === 'pending' || reading.state === 'none') waiting += 1;
    else unread.push(`${run.model}（${run.id}）：${reading.detail}`);
    await deps.note(run.id, meterNote(reading, run, now), now);
  }
  deps.log('info', '用量补记这一轮', {
    candidates: rows.length,
    rereads: rereadIds.size,
    filled,
    zeroed,
    waiting,
    unread: unread.length,
  });
  if (unread.length > 0) {
    return {
      outcome: 'partial',
      why: `${unread.length} 笔用量读不成（原因已写进这几笔）：${unread.slice(0, 5).join('；')}${unread.length > 5 ? '……' : ''}`,
      scanned: rows.length,
      found: filled + zeroed,
    };
  }
  return { outcome: 'ok', scanned: rows.length, found: filled + zeroed };
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
