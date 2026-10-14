// 看门狗的真装配（#203）：登记表和跑记录、提醒、这一轮的结局都是同一个库（@fleet-dao/db）；新不新鲜的判法就是驾驶舱
// 「定时任务」页读的那份 scheduleHealth，这里不另写。提醒写进 notifications，飞书照现有的推送发（网关从后端取「待推送」）。
// 看门狗本来就该管 ENGINE_JOBS 以外的登记（备份脚本这类外部注册的），不能按「是不是在 ENGINE_JOBS 里」筛——那样会把
// 这些正常任务也当成「不该看」而漏管。只按名字剔除明确退役了的那几个（jobs/retired-schedules.ts 的共用名单，引擎起来时
// 删 Temporal 上的 Schedule 用的也是它，见 real/retire-schedules.ts）：退役的任务不会再有新的跑记录，不剔除就会被
// 永远判成「停了」——它不会再跑，也没人能去处理，只会白占一条卡住报警。#1140 起引擎起来时还会把它们的登记行从
// scheduled_jobs 里摘掉（real/jobs.ts），这里的筛选是引擎还没来得及起新版本时的兑底。
// 「主线 N 小时没合 PR」（决定 0093）读同一个库的 mergeStallFacts（PR 镜像、任务、拉单记下的等空位单数）。
// 「在用的账号池额度读数不超过 30 分钟」（决定 0093 从每小时对账搬来）读同一个库的 quotaTable，加额度配置（deploy/quota.json）里写明不读的池。
import { loadQuotaConfig } from '@fleet-dao/adapters/quota';
import {
  alertByKey,
  type Db,
  finishScheduleRun,
  latestAlertByPrefix,
  mergeStallFacts,
  openAlertsByPrefix,
  quotaTable,
  resolveAlertWithReason,
  scheduleHealth,
  startScheduleRun,
  upsertAlert,
} from '@fleet-dao/db';
import { RETIRED_SCHEDULE_IDS } from '../jobs/retired-schedules.ts';
import { WATCHDOG_ACTOR, type WatchdogDeps } from '../jobs/watchdog.ts';

export interface WatchdogWiring {
  db: Db;
  /** 额度配置里写明不读的池；不给就读 deploy/quota.json（loadQuotaConfig）。读不到要抛，不许回空列表。 */
  quotaNotRead?: () => Promise<readonly string[]>;
  now?: () => Date;
  log?: WatchdogDeps['log'];
}

/** 给 EngineJobs.watchdog 用的工厂。 */
export function watchdogJob(w: WatchdogWiring): () => WatchdogDeps {
  const now = w.now ?? (() => new Date());
  const log: WatchdogDeps['log'] =
    w.log ?? ((level, text, fields) => console[level === 'info' ? 'info' : level](text, fields ?? {}));
  return () => ({
    health: async (at) => (await scheduleHealth(w.db, at)).filter((h) => !RETIRED_SCHEDULE_IDS.has(h.job.id)),
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
    mergeStall: () => mergeStallFacts(w.db),
    quota: {
      quotaPools: (at) => quotaTable(w.db, { now: at }),
      // 配置写明不读的池（现在是 jev：没有日账）。读不到配置要抛，不许当成「都要读」。
      quotaNotRead:
        w.quotaNotRead ?? (async () => (await loadQuotaConfig()).notRead?.map((p) => p.poolId) ?? []),
    },
    now,
    log,
  });
}
