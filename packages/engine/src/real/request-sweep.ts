// 需求整理（#2049）的真装配：读写同一个库（db 的 sweepRequests），跑记录写 schedule_runs。
import { type Db, finishScheduleRun, startScheduleRun, sweepRequests } from '@fleet-dao/db';
import type { RequestSweepJobDeps } from '../jobs/request-sweep.ts';

export function requestSweepJob(w: {
  db: Db;
  now?: () => Date;
  log?: RequestSweepJobDeps['log'];
}): () => RequestSweepJobDeps {
  const now = w.now ?? (() => new Date());
  const log: RequestSweepJobDeps['log'] =
    w.log ?? ((level, text, fields) => console[level === 'info' ? 'info' : level](text, fields ?? {}));
  return () => ({
    sweep: (at) => sweepRequests(w.db, at),
    runs: {
      start: (job, at) => startScheduleRun(w.db, job, at),
      finish: (id, result, at) => finishScheduleRun(w.db, id, result, at),
    },
    now,
    log,
  });
}
