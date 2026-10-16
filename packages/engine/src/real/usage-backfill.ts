// 用量补记的真接线（#1935）：库里找要补的几笔（db 的 runsAwaitingMeter），以会话用户读他家里的 Mirasim 用量账本
// （~/.mirasim/insights，经 mirasimDepsFor 的 meterFs：ls、grep -F 都以会话用户跑，引擎自己的进程进不去他的家），
// 读齐了写回（fillRunUsageFromMeter），没齐写原因（noteRunUsage）。Mirasim 路由只跑在唯一的会话用户下（hosts.ts 的
// mirasimDriver：userFrom 'sole'），所以账本只看这一个人的。用量账本里没有计费调用的，再以同一个读法看他的流量记录
// （~/.mirasim/traffic，mirasimDepsFor 的 ledgerDir）分没调用和没对上（#2675）；改读法之前定案不再补的老行经
// runsGaveUpAwaitingReread 按新读法再读一次。
import { type MeterFs, readMirasimMeter, type SessionUser } from '@fleet-dao/adapters';
import {
  type Db,
  fillRunMeterTail,
  fillRunUsageFromMeter,
  finishScheduleRun,
  noteRunUsage,
  runsAwaitingMeter,
  runsAwaitingMeterTail,
  runsGaveUpAwaitingReread,
  startScheduleRun,
} from '@fleet-dao/db';
import type { UsageBackfillJobDeps } from '../jobs/usage-backfill.ts';

export interface UsageBackfillWiring {
  db: Db;
  user: SessionUser;
  /** 这个会话用户的用量账本目录（mirasimDepsFor 的 meterDir）。 */
  meterDir(user: SessionUser): string;
  /**
   * 这个会话用户的流量记录目录（mirasimDepsFor 的 ledgerDir，~/.mirasim/traffic）：用量账本里没有计费调用的那几笔拿它核
   * 是真没调用还是没对上（#2675）。读法和用量账本同一个 meterFs。
   */
  trafficDir(user: SessionUser): string;
  /** 以这个会话用户读账本（mirasimDepsFor 的 meterFs）。 */
  meterFs(user: SessionUser): MeterFs;
  now?: () => Date;
  log?: UsageBackfillJobDeps['log'];
}

/** 给 EngineJobs.usageBackfill 用的工厂。 */
export function usageBackfillJob(w: UsageBackfillWiring): () => UsageBackfillJobDeps {
  const now = w.now ?? (() => new Date());
  const log: UsageBackfillJobDeps['log'] =
    w.log ?? ((level, text, fields) => console[level === 'info' ? 'info' : level](text, fields ?? {}));
  return () => ({
    pending: (input) => runsAwaitingMeter(w.db, input),
    tails: (input) => runsAwaitingMeterTail(w.db, input),
    rereads: (input) => runsGaveUpAwaitingReread(w.db, input),
    readMeter: (windows) =>
      readMirasimMeter(w.meterDir(w.user), windows, w.meterFs(w.user), w.trafficDir(w.user)),
    fill: (runId, usage, at, note) =>
      fillRunUsageFromMeter(w.db, { runId, usage, at, ...(note !== undefined ? { note } : {}) }),
    fillTail: (runId, add, note, at) => fillRunMeterTail(w.db, { runId, at, note, ...(add ? { add } : {}) }),
    note: (runId, note, at) => noteRunUsage(w.db, { runId, note, at }),
    runs: {
      start: (job, at) => startScheduleRun(w.db, job, at),
      finish: (id, result, at) => finishScheduleRun(w.db, id, result, at),
    },
    now,
    log,
  });
}
