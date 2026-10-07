// 引擎的 9 个定时任务（design 第四节；#921 起多一个每周刷新耗时表）：每个任务的钟点格子、补跑窗口、一轮怎么跑，出处在这里；
// 每周刷新耗时表的格子在 jobs/schedules.ts（单子点名登记在那里），这里只把它装进来。
// 调度本身在 jobs/timers.ts。任务编号 = 登记表（real/jobs.ts 的 ENGINE_JOBS）上的编号。原来 8 个的格子是 Temporal Schedule 的
// interval + offset，没改；耗时表是新的，周一 06:00（北京时间）。#1078 起不再建 Temporal Schedule，进程内定时器按这些格子跑。
// 引擎总开关（#1086）关着时只有标了 needsMaster 的两个不跑（拉单、巡检）。看家检查关着照跑。每周刷新耗时表也不标：它不拉单、
// 不起会话，而总开关每次发版都会关，标了就几乎刷不上。
import type { Client } from '@temporalio/client';
import type { EngineJobs } from '../activities.ts';
import { CANARY_EVERY_HOURS, CANARY_JOB, CANARY_OFFSET_MINUTES, sweepCanaryLeftovers } from './canary.ts';
import { startCanaryWorkflow } from './canary-start.ts';
import { CARPOOL_WATCH_EVERY_MINUTES, CARPOOL_WATCH_JOB, runCarpoolWatchJob } from './carpool-watch.ts';
import { runCiTimingsJob } from './ci-timings.ts';
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
import { ciTimingsSchedule } from './schedules.ts';
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
  const ciTimings = need(jobs, 'ciTimings');
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
      // 巡检开一张单、等引擎拉单起任务：总开关关着时拉单不拉，开了单也永远等不到被派，所以关着时这一轮不跑（#1086）
      needsMaster: true,
      run: async () => {
        await startCanaryWorkflow(client, taskQueue);
      },
      // 总开关关着跳过的轮次也把前面断轮留下的单、PR 和报警收掉（#1141）：不然这些只在巡检真跑一轮时收，
      // 关着期间主页一直挂着旧巡检卡、报警一直红。收不掉的记日志、不抛（timers.ts 兼住），下一轮跳过时接着收
      onMasterSkip: async () => {
        await sweepCanaryLeftovers(need(jobs, 'canary')(client));
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
      // 总开关关着不拉单、不起任务（#1086）
      needsMaster: true,
      run: () => runIntakeJob(intake(client, taskQueue)),
    },
    // 每周刷新 CI 测试耗时表（#921）。格子在 jobs/schedules.ts。不标 needsMaster：见文件头。
    ciTimingsSchedule(() => runCiTimingsJob(ciTimings())),
  ];
}
