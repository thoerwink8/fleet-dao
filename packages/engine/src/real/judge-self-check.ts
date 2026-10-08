// 判断题自检的生产装配：现找判断后端（和 issue 归类、/healthz 的 judge 项同一个 resolveJevBackend），运行记录进 schedule_runs。
import { type Db, finishScheduleRun, startScheduleRun } from '@fleet-dao/db';
import { jevConfigLocation, resolveJevBackend } from '@fleet-dao/jev';
import type { JudgeSelfCheckJobDeps } from '../jobs/judge-self-check.ts';

export interface JudgeSelfCheckWiring {
  db: Db;
  env: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
  log?: JudgeSelfCheckJobDeps['log'];
}

/** 给 EngineJobs.judgeSelfCheck 用的工厂。 */
export function judgeSelfCheckJob(w: JudgeSelfCheckWiring): () => JudgeSelfCheckJobDeps {
  const now = w.now ?? (() => new Date());
  const log: JudgeSelfCheckJobDeps['log'] =
    w.log ?? ((level, text, fields) => console[level === 'info' ? 'info' : level](text, fields ?? {}));
  return () => ({
    db: w.db,
    resolve: () => resolveJevBackend(w.db, { ...jevConfigLocation(w.env), now }),
    runs: {
      start: (job, at) => startScheduleRun(w.db, job, at),
      finish: (id, result, at) => finishScheduleRun(w.db, id, result, at),
    },
    now,
    log,
  });
}
