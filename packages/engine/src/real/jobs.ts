// 引擎的定时任务登记（scheduled_jobs）：引擎启动时写进库，一次都没跑过的也在驾驶舱「定时任务」页和看门狗的名单上
// （标 never）。这里的每一项在 jobs/schedules.ts 里都有一个 Temporal 定时任务，编号一样（测试核对两边对得上）。
import { type Db, registerScheduledJobs } from '@fleet-dao/db';
import { GITHUB_RECONCILE_JOB } from '../jobs/github-reconcile.ts';
import { ROUTE_PROBE_JOB } from '../jobs/route-probe.ts';

export const ENGINE_JOBS = [GITHUB_RECONCILE_JOB, ROUTE_PROBE_JOB] as const;

export async function registerEngineJobs(db: Db): Promise<void> {
  await registerScheduledJobs(db, [...ENGINE_JOBS]);
}
