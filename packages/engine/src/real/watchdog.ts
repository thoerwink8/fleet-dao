// 看门狗的真装配（#203）：登记表和跑记录、提醒、这一轮的结局都是同一个库（@fleet-dao/db）；新不新鲜的判法就是驾驶舱
// 「定时任务」页读的那份 scheduleHealth，这里不另写。提醒写进 notifications，飞书照现有的推送发（网关从后端取「待推送」）。
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
    health: (at) => scheduleHealth(w.db, at),
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
