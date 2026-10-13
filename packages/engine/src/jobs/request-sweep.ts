// 需求整理（#2049，母单 #2047 第 A 片）：每小时一轮，删了满 30 天的需求连消息一起硬删（写操作记录），已结案·不做的、
// 已结案·做且单子上线或关掉满 3 天的自动归档。判据和 SQL 在 @fleet-dao/db 的 queries/requests.ts（判据本身在 shared 的 request-rules.ts）。
// 改这里之前必须知道：
// - 不拉单、不起会话：不标 needsMaster（总开关每次发版都会关，标了删除就会拖过 30 天）。
// - 读不了库、写不进：这一轮记 failed 再抛，不记成功；表里一条需求都没有记 unscanned 并写明，不拿「0 个问题」冒充查过。
import type { RequestSweepResult, ScheduleResult } from '@fleet-dao/db';
import { errMessage } from '@fleet-dao/shared/util';
import type { ScheduleRunLog } from './github-reconcile.ts';

export const REQUEST_SWEEP_EVERY_MINUTES = 60;
/** 和别的每小时任务错开。 */
export const REQUEST_SWEEP_OFFSET_MINUTES = 23;

export const REQUEST_SWEEP_JOB = {
  id: 'request-sweep',
  name: '需求整理（30 天硬删、自动归档）',
  schedule: '每小时（23 分起）',
  // 连着三轮没跑成才算过期。
  expectEveryMinutes: 180,
} as const;

export interface RequestSweepJobDeps {
  sweep(now: Date): Promise<RequestSweepResult>;
  runs: ScheduleRunLog;
  now: () => Date;
  log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

export class RequestSweepFailedError extends Error {
  readonly runId: number;
  constructor(runId: number, message: string) {
    super(message);
    this.name = 'RequestSweepFailedError';
    this.runId = runId;
  }
}

/** 跑一轮。记开始就失败（库连不上）原样抛；没跑成记 failed 再抛 RequestSweepFailedError。 */
export async function runRequestSweepJob(deps: RequestSweepJobDeps): Promise<ScheduleResult> {
  const runId = await deps.runs.start(REQUEST_SWEEP_JOB.id, deps.now());
  let result: ScheduleResult;
  let swept: RequestSweepResult | undefined;
  try {
    swept = await deps.sweep(deps.now());
    const found = swept.purged.length + swept.archived.length;
    result =
      swept.scanned === 0
        ? { outcome: 'unscanned', why: '需求表里还没有需求，没有可整理的' }
        : {
            outcome: 'ok',
            scanned: swept.scanned,
            found,
            why: `硬删 ${swept.purged.length} 条、自动归档 ${swept.archived.length} 条`,
          };
  } catch (err) {
    result = { outcome: 'failed', why: `需求整理没跑成：${errMessage(err)}` };
  }
  await deps.runs.finish(runId, result, deps.now());
  if (result.outcome === 'failed') {
    deps.log('error', '需求整理这一轮没跑成', { runId, why: result.why });
    throw new RequestSweepFailedError(runId, result.why);
  }
  deps.log('info', '需求整理跑完', {
    runId,
    purged: swept?.purged ?? [],
    archived: swept?.archived ?? [],
  });
  return result;
}
