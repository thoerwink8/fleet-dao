// 引擎的定时任务登记（scheduled_jobs）：引擎启动时写进库，一次都没跑过的也在驾驶舱「定时任务」页和看门狗的名单上
// （标 never；登记了超过期望间隔还没跑过，看门狗推提醒）。ENGINE_JOBS 的每一项在 jobs/engine-timers.ts 里都有一个进程内
// 定时器（#1072 起不再是 Temporal Schedule），编号一样（测试核对两边对得上）。EXTERNAL_DRIVEN_JOBS 是外部驱动的，没有
// 进程内定时器，那条核对放过这一类、其余仍按编号和顺序严格对。看门狗自己也登记：它停没停由后端按这一行现算
// （packages/api 的 watchdog-health.ts）。
// 真退役的任务（jobs/retired-schedules.ts 名单上不带 moved 的）在这里顺手摘掉登记行（#1140），定时任务页不再看到它们。
// 外部看门狗（#292）只在进程环境配了非空的 FLEET_EDGE_WATCH_ID 时登记；没配或是空的就把库里已有的这一行摘掉，
// 避免 Worker 还没部署就按「登记了还没跑过」误报。
import { type Db, registerScheduledJobs, unregisterScheduledJobs } from '@fleet-dao/db';
import { errMessage } from '@fleet-dao/shared/util';
import { CARPOOL_WATCH_JOB } from '../jobs/carpool-watch.ts';
import { CI_TIMINGS_JOB } from '../jobs/ci-timings.ts';
import { CLI_UPGRADE_JOB } from '../jobs/cli-upgrade.ts';
import { CLI_VERSIONS_JOB } from '../jobs/cli-versions.ts';
import { DAILY_BRIEF_JOB } from '../jobs/daily-brief.ts';
import { EXTERNAL_WATCHDOG_JOB } from '../jobs/external-watchdog.ts';
import { GITHUB_RECONCILE_JOB } from '../jobs/github-reconcile.ts';
import { HOURLY_RECONCILE_JOB } from '../jobs/hourly-reconcile.ts';
import { INTAKE_JOB } from '../jobs/intake.ts';
import { JUDGE_SELF_CHECK_JOB } from '../jobs/judge-self-check.ts';
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
  USAGE_BACKFILL_JOB,
  CLI_VERSIONS_JOB,
  CLI_UPGRADE_JOB,
  REQUEST_SWEEP_JOB,
  DAILY_BRIEF_JOB,
] as const;

/** 外部驱动：没有进程内定时器。登记编号和定时器编号的核对不要求它们对得上。 */
export const EXTERNAL_DRIVEN_JOBS = [EXTERNAL_WATCHDOG_JOB] as const;

/** 非空才算配了。空白不算：没有可用的看门狗编号，登记了会立刻误报。 */
function edgeWatchConfigured(env: Readonly<Record<string, string | undefined>>): boolean {
  const id = env.FLEET_EDGE_WATCH_ID;
  return typeof id === 'string' && id.trim() !== '';
}

export async function registerEngineJobs(
  db: Db,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
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
  // Worker 还没部署时（FLEET_EDGE_WATCH_ID 没配或是空的）不能登记：看门狗会按「登记了超过期望间隔还没跑过」立刻误报。
  // 这种时候把库里已有的这一行摘掉，不留旧行。别的外部登记（备份脚本这类）不在这份清单上，不动。
  if (edgeWatchConfigured(env)) await registerScheduledJobs(db, [EXTERNAL_WATCHDOG_JOB]);
  else await unregisterScheduledJobs(db, [EXTERNAL_WATCHDOG_JOB.id]);
  // 真退役的任务（代码删掉了的，看 retired-schedules.ts 的名单）把登记行也摘掉（#1140）：登记行是期望，
  // 不该再跑的任务不再是期望，不摘的话定时任务页永远标「过期」（#445 删「提醒派单」后 alert-dispatch 就这样挂了
  // 9 天）。外部注册的（备份脚本这类）不在名单上，不动。
  await unregisterScheduledJobs(db, [...RETIRED_SCHEDULE_IDS]);
}
