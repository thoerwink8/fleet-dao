// 引擎的定时任务登记（scheduled_jobs）：引擎启动时写进库，一次都没跑过的也在驾驶舱「定时任务」页和看门狗的名单上
// （标 never；登记了超过期望间隔还没跑过，看门狗推提醒）。这里的每一项在 jobs/engine-timers.ts 里都有一个进程内定时器（#1072 起不再是 Temporal Schedule），
// 编号一样（测试核对两边对得上）。看门狗自己也登记：它停没停由后端按这一行现算（packages/api 的 watchdog-health.ts）。
// 真退役的任务（jobs/retired-schedules.ts 名单上不带 moved 的）在这里顺手摘掉登记行（#1140），定时任务页不再看到它们。
import { type Db, registerScheduledJobs, unregisterScheduledJobs } from '@fleet-dao/db';
import { CANARY_JOB } from '../jobs/canary.ts';
import { CARPOOL_WATCH_JOB } from '../jobs/carpool-watch.ts';
import { GITHUB_RECONCILE_JOB } from '../jobs/github-reconcile.ts';
import { HOURLY_RECONCILE_JOB } from '../jobs/hourly-reconcile.ts';
import { INTAKE_JOB } from '../jobs/intake.ts';
import { QUOTA_READ_JOB } from '../jobs/quota-read.ts';
import { RETIRED_SCHEDULE_IDS } from '../jobs/retired-schedules.ts';
import { ROUTE_PROBE_JOB } from '../jobs/route-probe.ts';
import { WATCHDOG_JOB } from '../jobs/watchdog.ts';

export const ENGINE_JOBS = [
  GITHUB_RECONCILE_JOB,
  ROUTE_PROBE_JOB,
  QUOTA_READ_JOB,
  CARPOOL_WATCH_JOB,
  HOURLY_RECONCILE_JOB,
  CANARY_JOB,
  WATCHDOG_JOB,
  INTAKE_JOB,
] as const;

export async function registerEngineJobs(db: Db): Promise<void> {
  await registerScheduledJobs(db, [...ENGINE_JOBS]);
  // 真退役的任务（代码删掉了的，看 retired-schedules.ts 的名单）把登记行也摘掉（#1140）：登记行是期望，
  // 不该再跑的任务不再是期望，不摘的话定时任务页永远标「过期」（#445 删「提醒派单」后 alert-dispatch 就这样挂了
  // 9 天）。外部注册的（备份脚本这类）不在名单上，不动。
  await unregisterScheduledJobs(db, [...RETIRED_SCHEDULE_IDS]);
}
