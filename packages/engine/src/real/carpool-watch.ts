// 拼车额度盯读的真接线（#194）：账本读真库（real/org-ledger.ts）、会话用户挂的组织用和选路、切号同一个读法、读接口用 real/carpool-api.ts、
// 判切号交给 real/org-switch.ts 的 orgSwitchRound.now（同一把单飞锁），提醒走 upsertAlert / resolveAlertByKey，结局记进 schedule_runs。
import type { SessionUser } from '@fleet-dao/adapters';
import {
  type Db,
  finishScheduleRun,
  registerScheduledJobs,
  resolveAlertByKey,
  startScheduleRun,
  unregisterScheduledJobs,
  upsertAlert,
} from '@fleet-dao/db';
import type { CarpoolApiRead } from '../jobs/carpool-outage.ts';
import { CARPOOL_WATCH_JOB, type CarpoolWatchDeps } from '../jobs/carpool-watch.ts';
import { OrgLedgerError } from '../jobs/org-ledger.ts';
import type { OrgSwitchRound } from '../jobs/org-switch.ts';
import { loadLedger } from './org-ledger.ts';
import { ORG_LEDGER_ALERT } from './org-switch.ts';
import { carpoolPoolsHeldReason } from './pool-holds.ts';
import type { SessionOrgReader } from './session-org.ts';

export interface CarpoolWatchWiring {
  db: Db;
  user: SessionUser;
  /** 和选路、探针、切号共用的那一个。 */
  sessionOrg: SessionOrgReader;
  /** 切号（real/org-switch.ts）：读到了、有事要判时当场判。 */
  orgSwitch: OrgSwitchRound;
  /** 读一次开放接口（real/carpool-api.ts）。 */
  readApi: () => Promise<CarpoolApiRead>;
  now?: () => Date;
  log?: CarpoolWatchDeps['log'];
}

/** 给 EngineJobs.carpoolWatch 用的工厂。 */
export function carpoolWatchJob(w: CarpoolWatchWiring): () => CarpoolWatchDeps {
  const now = w.now ?? (() => new Date());
  const log: CarpoolWatchDeps['log'] =
    w.log ?? ((level, text, fields) => console[level === 'info' ? 'info' : level](text, fields ?? {}));
  // 登记行现在是不是已摘（进程内记着，起来时不知道 = null，第一轮就写一次对的）。
  // 引擎起来时若池还暂停着，registerEngineJobs 不会把这一行登记回来（那会清掉 removed_at，而这里记着已摘就不再写）。
  let parked: boolean | null = null;
  return () => ({
    // 整池暂停：库里所有拼车池都被暂停（开关或 pool-hold: 提醒）才算；一个拼车池都没有不算（让盯读自己报「找不到」）。
    // 和看门狗、引擎起来时的登记同一句（pool-holds.ts 的 carpoolPoolsHeldReason）。
    pause: {
      heldReason: () => carpoolPoolsHeldReason(w.db, now()),
      park: async (on) => {
        if (parked === on) return;
        if (on) await unregisterScheduledJobs(w.db, [CARPOOL_WATCH_JOB.id]);
        else await registerScheduledJobs(w.db, [CARPOOL_WATCH_JOB]);
        parked = on;
      },
    },
    // 账本认不出：和切号那边同一条提醒（session-org:ledger），盯读这一轮起不来也要让人看见，不只记一条没跑成的记录；读得出了自己撤
    loadLedger: async () => {
      try {
        const ledger = await loadLedger(w.db, w.user);
        await resolveAlertByKey(w.db, { dedupeKey: ORG_LEDGER_ALERT, by: 'engine' });
        return ledger;
      } catch (err) {
        if (err instanceof OrgLedgerError) {
          await upsertAlert(w.db, {
            dedupeKey: ORG_LEDGER_ALERT,
            level: 'alert',
            taskId: null,
            title: '切号账本认不出：引擎不切号',
            body: `${err.message}。拼车盯读这一轮读不了账本，没法判切不切；到会话用户所在机器上看账本（session_org_state）为什么认不出，照 docs/ops.md 第五节「会话用户挂的组织」处理。`,
          });
        }
        throw err;
      }
    },
    liveOrg: () => w.sessionOrg({ by: '拼车盯读' }),
    read: w.readApi,
    switchNow: (trigger) => w.orgSwitch.now(trigger),
    raise: (a) =>
      upsertAlert(w.db, {
        dedupeKey: a.key,
        level: 'alert',
        taskId: null,
        title: a.title,
        body: a.body,
      }).then(() => undefined),
    resolve: (key) => resolveAlertByKey(w.db, { dedupeKey: key, by: 'engine' }).then(() => undefined),
    runs: {
      start: (job, at) => startScheduleRun(w.db, job, at),
      finish: (id, result, at) => finishScheduleRun(w.db, id, result, at),
    },
    now,
    log,
  });
}
