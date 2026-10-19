// 引擎的定时任务登记（scheduled_jobs）：引擎启动时写进库，一次都没跑过的也在驾驶舱「定时任务」页和看门狗的名单上
// （标 never；登记了超过期望间隔还没跑过，看门狗推提醒）。ENGINE_JOBS 的每一项在 jobs/engine-timers.ts 里都有一个进程内
// 定时器（#1072 起不再是 Temporal Schedule），编号一样（测试核对两边对得上）。看门狗自己也登记：它停没停由后端按这一行现算
// （packages/api 的 watchdog-health.ts）。
// 真退役的任务（jobs/retired-schedules.ts 名单上不带 moved 的）在这里顺手摘掉登记行（#1140），定时任务页不再看到它们。
import { type Db, registerScheduledJobs, unregisterScheduledJobs } from '@fleet-dao/db';
import { errMessage } from '@fleet-dao/shared/util';
import { CARPOOL_WATCH_JOB } from '../jobs/carpool-watch.ts';
import { CHANGELOG_JOB } from '../jobs/changelog.ts';
import { CI_TIMINGS_JOB } from '../jobs/ci-timings.ts';
import { CLI_UPGRADE_JOB } from '../jobs/cli-upgrade.ts';
import { CLI_VERSIONS_JOB } from '../jobs/cli-versions.ts';
import { DAILY_BRIEF_JOB } from '../jobs/daily-brief.ts';
import { E2E_QUARANTINE_JOB } from '../jobs/e2e-quarantine.ts';
import { GITHUB_RECONCILE_JOB } from '../jobs/github-reconcile.ts';
import { HOURLY_RECONCILE_JOB } from '../jobs/hourly-reconcile.ts';
import { INTAKE_JOB } from '../jobs/intake.ts';
import { JUDGE_SELF_CHECK_JOB } from '../jobs/judge-self-check.ts';
import { PARKED_RETRY_JOB } from '../jobs/parked-retry.ts';
import { QUOTA_READ_JOB } from '../jobs/quota-read.ts';
import { REQUEST_SWEEP_JOB } from '../jobs/request-sweep.ts';
import { RETIRED_SCHEDULE_IDS } from '../jobs/retired-schedules.ts';
import { ROUTE_PROBE_JOB } from '../jobs/route-probe.ts';
import { USAGE_BACKFILL_JOB } from '../jobs/usage-backfill.ts';
import { WATCHDOG_JOB } from '../jobs/watchdog.ts';
import { carpoolPoolsHeldReason } from './pool-holds.ts';

export const ENGINE_JOBS = [
  GITHUB_RECONCILE_JOB,
  ROUTE_PROBE_JOB,
  QUOTA_READ_JOB,
  CARPOOL_WATCH_JOB,
  HOURLY_RECONCILE_JOB,
  WATCHDOG_JOB,
  INTAKE_JOB,
  JUDGE_SELF_CHECK_JOB,
  CI_TIMINGS_JOB,
  CHANGELOG_JOB,
  USAGE_BACKFILL_JOB,
  CLI_VERSIONS_JOB,
  CLI_UPGRADE_JOB,
  REQUEST_SWEEP_JOB,
  DAILY_BRIEF_JOB,
  E2E_QUARANTINE_JOB,
  PARKED_RETRY_JOB,
] as const;

export async function registerEngineJobs(db: Db): Promise<void> {
  // 拼车池整池暂停时不把 carpool-watch 登记回来：registerScheduledJobs 会把 removed_at 清掉，而盯读进程记着
  // 「已经摘过」就不再写，看门狗按还在的登记行报「停了」。读不到暂停不当成暂停，照常登记（宁可多盯）。
  let carpoolPaused = false;
  try {
    carpoolPaused = (await carpoolPoolsHeldReason(db, new Date())) !== null;
  } catch (error) {
    console.warn(`登记定时任务：读不到拼车池是不是暂停，carpool-watch 照常登记（${errMessage(error)}）`);
  }
  const jobs = carpoolPaused ? ENGINE_JOBS.filter((job) => job.id !== CARPOOL_WATCH_JOB.id) : ENGINE_JOBS;
  await registerScheduledJobs(db, [...jobs]);
  if (carpoolPaused) await unregisterScheduledJobs(db, [CARPOOL_WATCH_JOB.id]);
  // 真退役的任务（代码删掉了的，看 retired-schedules.ts 的名单）把登记行也摘掉（#1140）：登记行是期望，
  // 不该再跑的任务不再是期望，不摘的话定时任务页永远标「过期」（#445 删「提醒派单」后 alert-dispatch 就这样挂了
  // 9 天）。外部注册的（备份脚本这类）不在名单上，不动。
  await unregisterScheduledJobs(db, [...RETIRED_SCHEDULE_IDS]);
}
