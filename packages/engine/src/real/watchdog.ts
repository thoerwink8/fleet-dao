// 看门狗的真装配（#203）：登记表和跑记录、提醒、这一轮的结局都是同一个库（@fleet-dao/db）；新不新鲜的判法就是驾驶舱
// 「定时任务」页读的那份 scheduleHealth，这里不另写。提醒写进 notifications，飞书照现有的推送发（网关从后端取「待推送」）。
// 看门狗本来就该管 ENGINE_JOBS 以外的登记（备份脚本这类外部注册的），不能按「是不是在 ENGINE_JOBS 里」筛——那样会把
// 这些正常任务也当成「不该看」而漏管。只按名字剔除明确退役了的那几个：退役的任务不会再有新的跑记录，不剔除就会被
// 永远判成「停了」——它不会再跑，也没人能去处理，只会白占一条卡住报警。
import {
  alertByKey,
  type Db,
  finishScheduleRun,
  latestAlertByPrefix,
  openAlertsByPrefix,
  resolveAlertWithReason,
  scheduleHealth,
  startScheduleRun,
  upsertAlert,
} from '@fleet-dao/db';
import { WATCHDOG_ACTOR, type WatchdogDeps } from '../jobs/watchdog.ts';

/** 退役了的定时任务 id：登记表上的行还在，但不会再有新的跑记录了（#445 把「提醒派单」整层删掉）。 */
const RETIRED_JOBS = new Set<string>(['alert-dispatch']);

export interface WatchdogWiring {
  db: Db;
  now?: () => Date;
  log?: WatchdogDeps['log'];
}

/** 给 EngineJobs.watchdog 用的工厂。 */
export function watchdogJob(w: WatchdogWiring): () => WatchdogDeps {
  const now = w.now ?? (() => new Date());
  const log: WatchdogDeps['log'] =
    w.log ?? ((level, text, fields) => console[level === 'info' ? 'info' : level](text, fields ?? {}));
  return () => ({
    health: async (at) => (await scheduleHealth(w.db, at)).filter((h) => !RETIRED_JOBS.has(h.job.id)),
    alerts: {
      openByPrefix: async (prefix) =>
        (await openAlertsByPrefix(w.db, prefix)).map((a) => ({
          dedupeKey: a.dedupeKey,
          title: a.title,
          body: a.body,
        })),
      latestByPrefix: (prefix) => latestAlertByPrefix(w.db, prefix),
      byKey: (key) => alertByKey(w.db, key),
      async raise(x) {
        await upsertAlert(w.db, {
          dedupeKey: x.dedupeKey,
          level: 'alert',
          taskId: null,
          title: x.title,
          body: x.body,
          link: x.link,
        });
      },
      resolve: (x) =>
        resolveAlertWithReason(w.db, { dedupeKey: x.dedupeKey, by: WATCHDOG_ACTOR, why: x.why, at: now() }),
    },
    runs: {
      start: (job, at) => startScheduleRun(w.db, job, at),
      finish: (id, result, at) => finishScheduleRun(w.db, id, result, at),
    },
    now,
    log,
  });
}
