// 用量补记（#1935）：经 Mirasim 起的会话，会话结束那一刻引擎只看得到订阅快照（claude、dsh、pi、kimi 只有本轮输出，codex 没有缓存写），
// 每次上游调用的真用量在 Mirasim 自己的用量账本里、靠中转计量事后回填（过 90 秒以后每 3 分钟一轮）。这个定时任务每 5 分钟
// 把近 24 小时结束的、四样 token 有缺的那几笔按会话号到账本补读：读齐了整套写回 runs，没齐写明为什么（runs.usage_note）。
//
// 改这里之前必须知道：
// - 只认读齐了的（adapters 的 mirasim/meter.ts：全 0 的占位算「还在等」，不当成 0）；写回只改四样还有缺的行，补齐了的不再碰，
//   重复跑、两轮叠着跑都只写一次（db 的 fillRunUsageFromMeter）。
// - 读不齐的不写数：还在等回填写「还在等」；会话结束过了 METER_LATE_MS 还没齐，原因里写「迟迟没回填」；中转没有记录、行认不出、
//   一次计费调用都对不上的照实写读不成的原因。过了回看窗口的不再补，原因留着（任务详情、巡检照它写）。
// - 账本整个读不了（目录列不出、筛行失败）是这一轮没跑成，记 failed、看门狗报；单笔读不成是那一笔的事，这一轮记 partial。
// - 不标 needsMaster：它不拉单、不起会话，总开关关着也要把已经跑完的会话的账补齐。

import type { MeterReading, MeterWindow } from '@fleet-dao/adapters';
import type { MeterPendingRun, MeterUsageWrite, ScheduleResult } from '@fleet-dao/db';
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
  /** adapters 的 readMirasimMeter（以会话用户读他家里的账本）：和 windows 一一对应。读不了照抛。 */
  readMeter(windows: readonly MeterWindow[]): Promise<MeterReading[]>;
  /** db 的 fillRunUsageFromMeter：写了回 true，已经齐了回 false。 */
  fill(runId: string, usage: MeterUsageWrite, at: Date): Promise<boolean>;
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
  if (reading.state === 'unknown') return `用量没读成：${reading.detail}`;
  const waited = Math.floor((now.getTime() - run.endedAt.getTime()) / 60_000);
  if (now.getTime() - run.endedAt.getTime() > METER_LATE_MS) {
    return `会话结束 ${waited} 分钟了，中转计量还没回填齐（${reading.pending} / ${reading.calls} 次调用没填；正常几分钟就齐）`;
  }
  return `等中转计量回填，补记任务每 5 分钟补一次（${reading.detail}）`;
}

async function round(deps: UsageBackfillJobDeps): Promise<ScheduleResult> {
  const now = deps.now();
  const rows = await deps.pending({
    endedAfter: new Date(now.getTime() - USAGE_BACKFILL_LOOKBACK_MS),
    limit: USAGE_BACKFILL_BATCH,
  });
  // 扫的是近 24 小时那一段 runs：一笔要补的都没有也是扫过了（一次查询算一个），不是「一个都没扫到」
  if (rows.length === 0) return { outcome: 'ok', scanned: 1, found: 0 };
  const readings = await deps.readMeter(
    rows.map((r) => ({ sessionKey: r.sessionId, since: r.startedAt.getTime(), until: r.endedAt.getTime() })),
  );
  if (readings.length !== rows.length) {
    throw new Error(`读账本回的读数（${readings.length}）和要补的笔数（${rows.length}）对不上`);
  }
  let filled = 0;
  let waiting = 0;
  const unread: string[] = [];
  for (const [i, run] of rows.entries()) {
    const reading = readings[i] as MeterReading;
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
    if (reading.state === 'pending') waiting += 1;
    else unread.push(`${run.model}（${run.id}）：${reading.detail}`);
    await deps.note(run.id, meterNote(reading, run, now), now);
  }
  deps.log('info', '用量补记这一轮', { candidates: rows.length, filled, waiting, unread: unread.length });
  if (unread.length > 0) {
    return {
      outcome: 'partial',
      why: `${unread.length} 笔用量读不成（原因已写进这几笔）：${unread.slice(0, 5).join('；')}${unread.length > 5 ? '……' : ''}`,
      scanned: rows.length,
      found: filled,
    };
  }
  return { outcome: 'ok', scanned: rows.length, found: filled };
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
