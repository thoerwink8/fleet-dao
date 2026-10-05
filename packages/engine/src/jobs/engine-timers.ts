// 引擎的 8 个定时任务（design 第四节）：每个任务的钟点格子、补跑窗口、一轮怎么跑，唯一出处在这里；调度本身在 jobs/timers.ts。
// 任务编号 = 登记表（real/jobs.ts 的 ENGINE_JOBS）上的编号；格子是原来 Temporal Schedule 的 interval + offset，没改。
import type { Client } from '@temporalio/client';
import type { EngineJobs } from '../activities.ts';
import { CANARY_EVERY_HOURS, CANARY_JOB, CANARY_OFFSET_MINUTES } from './canary.ts';
import { startCanaryWorkflow } from './canary-start.ts';
import { CARPOOL_WATCH_EVERY_MINUTES, CARPOOL_WATCH_JOB, runCarpoolWatchJob } from './carpool-watch.ts';
import {
  GITHUB_RECONCILE_EVERY_MINUTES,
  GITHUB_RECONCILE_JOB,
  runGitHubReconcileJob,
} from './github-reconcile.ts';
import {
  HOURLY_RECONCILE_EVERY_MINUTES,
  HOURLY_RECONCILE_JOB,
  HOURLY_RECONCILE_OFFSET_MINUTES,
  runHourlyReconcileJob,
} from './hourly-reconcile.ts';
import { INTAKE_EVERY_MINUTES, INTAKE_JOB, INTAKE_OFFSET_MINUTES, runIntakeJob } from './intake.ts';
import {
  QUOTA_READ_EVERY_MINUTES,
  QUOTA_READ_JOB,
  QUOTA_READ_OFFSET_MINUTES,
  runQuotaReadJob,
} from './quota-read.ts';
import {
  ROUTE_PROBE_EVERY_MINUTES,
  ROUTE_PROBE_JOB,
  ROUTE_PROBE_OFFSET_MINUTES,
  runRouteProbeJob,
} from './route-probe.ts';
import type { TimerJob } from './timers.ts';
import { runWatchdogJob, WATCHDOG_EVERY_MINUTES, WATCHDOG_JOB, WATCHDOG_OFFSET_MINUTES } from './watchdog.ts';

/** 一轮超过多久还没回就记一条 error 日志（原来每一轮的 Temporal 工作流限时；现在到了不取消、也不放开不叠着跑，见 timers.ts）。 */
const OVERDUE_MINUTES = 15;

function need<K extends keyof EngineJobs>(jobs: EngineJobs, name: K): NonNullable<EngineJobs[K]> {
  const make = jobs[name];
  if (!make) {
    // 定时任务只由真端口建；真端口没装齐就明说起不来，别让对账、看门狗悄悄没人跑
    throw new Error(`引擎要起定时任务「${name}」，但真端口没装它（real/index.ts 的 jobs 里缺）`);
  }
  return make as NonNullable<EngineJobs[K]>;
}

/**
 * 引擎要有的定时任务。每一轮现装依赖（和原来每个活动一次一装一样：要 Temporal 客户端的几个拿这里给的）。
 * 补跑窗口都是「一格」：停机一阵再起来只补最近一轮，每轮都是看当时的库和 GitHub，补旧的没意义；巡检例外，错过的那一轮一小时内补上。
 */
export function engineTimerJobs(o: { jobs: EngineJobs; client: Client; taskQueue: string }): TimerJob[] {
  const { jobs, client, taskQueue } = o;
  const githubReconcile = need(jobs, 'githubReconcile');
  const routeProbe = need(jobs, 'routeProbe');
  const quotaRead = need(jobs, 'quotaRead');
  const carpoolWatch = need(jobs, 'carpoolWatch');
  const hourlyReconcile = need(jobs, 'hourlyReconcile');
  const watchdog = need(jobs, 'watchdog');
  const intake = need(jobs, 'intake');
  // 巡检的活动在工作流里跑，依赖不在这里装；但没装齐要在起的时候就发现，别等到工作流里的活动才报
  need(jobs, 'canary');
  return [
    {
      id: GITHUB_RECONCILE_JOB.id,
      everyMinutes: GITHUB_RECONCILE_EVERY_MINUTES,
      catchupMinutes: GITHUB_RECONCILE_EVERY_MINUTES,
      overdueMinutes: OVERDUE_MINUTES,
      run: () => runGitHubReconcileJob(githubReconcile(client, taskQueue)),
    },
    {
      // 路由探针（#129）：和对账错开几分钟，不在整点挤着起会话
      id: ROUTE_PROBE_JOB.id,
      everyMinutes: ROUTE_PROBE_EVERY_MINUTES,
      offsetMinutes: ROUTE_PROBE_OFFSET_MINUTES,
      catchupMinutes: ROUTE_PROBE_EVERY_MINUTES,
      overdueMinutes: OVERDUE_MINUTES,
      run: () => runRouteProbeJob(routeProbe()),
    },
    {
      // 定时读额度入库（#76）
      id: QUOTA_READ_JOB.id,
      everyMinutes: QUOTA_READ_EVERY_MINUTES,
      offsetMinutes: QUOTA_READ_OFFSET_MINUTES,
      catchupMinutes: QUOTA_READ_EVERY_MINUTES,
      overdueMinutes: OVERDUE_MINUTES,
      run: () => runQuotaReadJob(quotaRead()),
    },
    {
      // 拼车额度盯读（#194，给切号用）：每分钟一轮，自己按情况定这一分钟真不真读开放接口
      id: CARPOOL_WATCH_JOB.id,
      everyMinutes: CARPOOL_WATCH_EVERY_MINUTES,
      catchupMinutes: CARPOOL_WATCH_EVERY_MINUTES,
      overdueMinutes: OVERDUE_MINUTES,
      run: () => runCarpoolWatchJob(carpoolWatch()),
    },
    {
      // 每小时对账（工作树残留、两处核对、提醒按条件撤和再推、GitHub 机器人权限自检）
      id: HOURLY_RECONCILE_JOB.id,
      everyMinutes: HOURLY_RECONCILE_EVERY_MINUTES,
      offsetMinutes: HOURLY_RECONCILE_OFFSET_MINUTES,
      catchupMinutes: HOURLY_RECONCILE_EVERY_MINUTES,
      overdueMinutes: OVERDUE_MINUTES,
      run: () => runHourlyReconcileJob(hourlyReconcile(client, taskQueue)),
    },
    {
      // 全流程巡检（#223）：这里只起工作流（jobs/canary-start.ts）；已经有一轮在跑就跳过这一轮
      id: CANARY_JOB.id,
      everyMinutes: CANARY_EVERY_HOURS * 60,
      offsetMinutes: CANARY_OFFSET_MINUTES,
      catchupMinutes: 60,
      overdueMinutes: OVERDUE_MINUTES,
      run: async () => {
        await startCanaryWorkflow(client, taskQueue);
      },
    },
    {
      // 看门狗（#203）：按登记表看各定时任务新不新鲜
      id: WATCHDOG_JOB.id,
      everyMinutes: WATCHDOG_EVERY_MINUTES,
      offsetMinutes: WATCHDOG_OFFSET_MINUTES,
      catchupMinutes: WATCHDOG_EVERY_MINUTES,
      overdueMinutes: OVERDUE_MINUTES,
      run: () => runWatchdogJob(watchdog()),
    },
    {
      // 拉单（#632）：引擎自己到 GitHub 读该做的单、起任务工作流
      id: INTAKE_JOB.id,
      everyMinutes: INTAKE_EVERY_MINUTES,
      offsetMinutes: INTAKE_OFFSET_MINUTES,
      catchupMinutes: INTAKE_EVERY_MINUTES,
      overdueMinutes: OVERDUE_MINUTES,
      run: () => runIntakeJob(intake(client, taskQueue)),
    },
  ];
}
