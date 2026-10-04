// 引擎的定时任务登记（scheduled_jobs）：引擎启动时写进库，一次都没跑过的也在驾驶舱「定时任务」页和看门狗的名单上
// （标 never；登记了超过期望间隔还没跑过，看门狗推提醒）。这里的每一项在 jobs/schedules.ts 里都有一个 Temporal 定时任务，
// 编号一样（测试核对两边对得上）。看门狗自己也登记：它停没停由后端按这一行现算（packages/api 的 watchdog-health.ts）。
import { type Db, registerScheduledJobs } from '@fleet-dao/db';
import { CANARY_JOB } from '../jobs/canary.ts';
import { GITHUB_RECONCILE_JOB } from '../jobs/github-reconcile.ts';
import { HOURLY_RECONCILE_JOB } from '../jobs/hourly-reconcile.ts';
import { INTAKE_JOB } from '../jobs/intake.ts';
import { QUOTA_READ_JOB } from '../jobs/quota-read.ts';
import { ROUTE_PROBE_JOB } from '../jobs/route-probe.ts';
import { WATCHDOG_JOB } from '../jobs/watchdog.ts';

export const ENGINE_JOBS = [
  GITHUB_RECONCILE_JOB,
  ROUTE_PROBE_JOB,
  QUOTA_READ_JOB,
  HOURLY_RECONCILE_JOB,
  CANARY_JOB,
  WATCHDOG_JOB,
  INTAKE_JOB,
] as const;

export async function registerEngineJobs(db: Db): Promise<void> {
  await registerScheduledJobs(db, [...ENGINE_JOBS]);
}
