// 引擎的定时任务（design 第四节；#921 起多一个每天刷新耗时表，#1365 起多一个判断题自检，#1935 起多一个用量补记，#1969 起多一个命令行工具版本，#1971 起多一个命令行工具升级）：每个任务的钟点格子、补跑窗口、一轮怎么跑，出处在这里；
// 每天刷新耗时表和判断题自检的格子在 jobs/schedules.ts（单子点名登记在那里），这里只把它们装进来。
// 调度本身在 jobs/timers.ts。任务编号 = 登记表（real/jobs.ts 的 ENGINE_JOBS）上的编号。原来 8 个的格子是 Temporal Schedule 的
// interval + offset，没改；耗时表是新的，周一 06:00（北京时间）。#1078 起不再建 Temporal Schedule，进程内定时器按这些格子跑。
// 引擎总开关（#1086）关着时只有标了 needsMaster 的拉单不跑（全流程巡检随决定 0093 删了）。看家检查关着照跑。每天刷新耗时表也不标：它不拉单、
// 不起会话，而总开关每次发版都会关，标了就几乎刷不上。
import type { Client } from '@temporalio/client';
import type { EngineJobs } from '../activities.ts';
import {
  CARPOOL_WATCH_EVERY_MINUTES,
  CARPOOL_WATCH_JOB,
  runCarpoolWatchUnlessPaused,
} from './carpool-watch.ts';
import { runChangelogJob } from './changelog.ts';
import { runCiTimingsJob } from './ci-timings.ts';
import {
  CLI_UPGRADE_EVERY_MINUTES,
  CLI_UPGRADE_JOB,
  CLI_UPGRADE_OFFSET_MINUTES,
  runCliUpgradeJob,
} from './cli-upgrade.ts';
import {
  CLI_VERSIONS_EVERY_MINUTES,
  CLI_VERSIONS_JOB,
  CLI_VERSIONS_OFFSET_MINUTES,
  runCliVersionsJob,
} from './cli-versions.ts';
import {
  DAILY_BRIEF_EVERY_MINUTES,
  DAILY_BRIEF_JOB,
  DAILY_BRIEF_OFFSET_MINUTES,
  runDailyBriefJob,
} from './daily-brief.ts';
import {
  E2E_QUARANTINE_EVERY_MINUTES,
  E2E_QUARANTINE_JOB,
  E2E_QUARANTINE_OFFSET_MINUTES,
  runE2eQuarantineJob,
} from './e2e-quarantine.ts';
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
import { runJudgeSelfCheckJob } from './judge-self-check.ts';
import {
  PARKED_RETRY_EVERY_MINUTES,
  PARKED_RETRY_JOB,
  PARKED_RETRY_OFFSET_MINUTES,
  runParkedRetryJob,
} from './parked-retry.ts';
import {
  QUOTA_READ_EVERY_MINUTES,
  QUOTA_READ_JOB,
  QUOTA_READ_OFFSET_MINUTES,
  runQuotaReadJob,
} from './quota-read.ts';
import {
  REQUEST_SWEEP_EVERY_MINUTES,
  REQUEST_SWEEP_JOB,
  REQUEST_SWEEP_OFFSET_MINUTES,
  runRequestSweepJob,
} from './request-sweep.ts';
import {
  ROUTE_PROBE_EVERY_MINUTES,
  ROUTE_PROBE_JOB,
  ROUTE_PROBE_OFFSET_MINUTES,
  runRouteProbeJob,
} from './route-probe.ts';
import { routeProbeLock } from './route-probe-now.ts';
import { changelogSchedule, ciTimingsSchedule, judgeSelfCheckSchedule } from './schedules.ts';
import type { TimerJob } from './timers.ts';
import {
  runUsageBackfillJob,
  USAGE_BACKFILL_EVERY_MINUTES,
  USAGE_BACKFILL_JOB,
  USAGE_BACKFILL_OFFSET_MINUTES,
} from './usage-backfill.ts';
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
 * 补跑窗口都是「一格」：停机一阵再起来只补最近一轮，每轮都是看当时的库和 GitHub，补旧的没意义。
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
  const judgeSelfCheck = need(jobs, 'judgeSelfCheck');
  const ciTimings = need(jobs, 'ciTimings');
  const changelog = need(jobs, 'changelog');
  const usageBackfill = need(jobs, 'usageBackfill');
  const cliVersions = need(jobs, 'cliVersions');
  const cliUpgrade = need(jobs, 'cliUpgrade');
  const requestSweep = need(jobs, 'requestSweep');
  const dailyBrief = need(jobs, 'dailyBrief');
  const e2eQuarantine = need(jobs, 'e2eQuarantine');
  const parkedRetry = need(jobs, 'parkedRetry');
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
      // 和驾驶舱的立即探测共用一把锁（route-probe-now.ts）：同一时刻最多一轮在探
      run: () => routeProbeLock.run(() => runRouteProbeJob(routeProbe())),
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
      // 拼车额度盯读（#194，给切号用）：每分钟一轮，自己按情况定这一分钟真不真读开放接口；拼车池整池暂停时整个不跑
      id: CARPOOL_WATCH_JOB.id,
      everyMinutes: CARPOOL_WATCH_EVERY_MINUTES,
      catchupMinutes: CARPOOL_WATCH_EVERY_MINUTES,
      overdueMinutes: OVERDUE_MINUTES,
      run: () => runCarpoolWatchUnlessPaused(carpoolWatch()),
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
    // 判断题自检（#1365）。格子在 jobs/schedules.ts。不标 needsMaster：总开关关着也要能把红灯探回来。
    judgeSelfCheckSchedule(() => runJudgeSelfCheckJob(judgeSelfCheck())),
    // 每天刷新 CI 测试耗时表（#921）。格子在 jobs/schedules.ts。不标 needsMaster：见文件头。
    ciTimingsSchedule(() => runCiTimingsJob(ciTimings())),
    changelogSchedule(() => runChangelogJob(changelog())),
    {
      // 用量补记（#1935）：经 Mirasim 起的会话按中转计量补齐用量。不拉单、不起会话，不标 needsMaster
      id: USAGE_BACKFILL_JOB.id,
      everyMinutes: USAGE_BACKFILL_EVERY_MINUTES,
      offsetMinutes: USAGE_BACKFILL_OFFSET_MINUTES,
      catchupMinutes: USAGE_BACKFILL_EVERY_MINUTES,
      overdueMinutes: OVERDUE_MINUTES,
      run: () => runUsageBackfillJob(usageBackfill()),
    },
    {
      // 命令行工具版本（#1969）：只读在用版本和官方最新。不升级，不标 needsMaster
      id: CLI_VERSIONS_JOB.id,
      everyMinutes: CLI_VERSIONS_EVERY_MINUTES,
      offsetMinutes: CLI_VERSIONS_OFFSET_MINUTES,
      catchupMinutes: CLI_VERSIONS_EVERY_MINUTES,
      overdueMinutes: OVERDUE_MINUTES,
      run: () => runCliVersionsJob(cliVersions()),
    },
    {
      // 命令行工具升级（#1971）：空闲时写请求，root 的单元去装。不拉单、不起会话，不标 needsMaster（总开关关着正是空闲）
      id: CLI_UPGRADE_JOB.id,
      everyMinutes: CLI_UPGRADE_EVERY_MINUTES,
      offsetMinutes: CLI_UPGRADE_OFFSET_MINUTES,
      catchupMinutes: CLI_UPGRADE_EVERY_MINUTES,
      overdueMinutes: OVERDUE_MINUTES,
      run: () => runCliUpgradeJob(cliUpgrade()),
    },
    {
      // 需求整理（#2049）：删了满 30 天的硬删、该归档的归档。只读写库，不标 needsMaster
      id: REQUEST_SWEEP_JOB.id,
      everyMinutes: REQUEST_SWEEP_EVERY_MINUTES,
      offsetMinutes: REQUEST_SWEEP_OFFSET_MINUTES,
      catchupMinutes: REQUEST_SWEEP_EVERY_MINUTES,
      overdueMinutes: OVERDUE_MINUTES,
      run: () => runRequestSweepJob(requestSweep()),
    },
    {
      // 每日简报（决定 0096）：每天 08:30（北京时间）推飞书、在 #1055 发评论。不拉单、不起会话，不标 needsMaster；
      // 停机错过了 08:30，当天起来照样补今天这一条（晚到的简报也比没有好；看门狗 09:00 起已经报了没送到）
      id: DAILY_BRIEF_JOB.id,
      everyMinutes: DAILY_BRIEF_EVERY_MINUTES,
      offsetMinutes: DAILY_BRIEF_OFFSET_MINUTES,
      catchupMinutes: DAILY_BRIEF_EVERY_MINUTES,
      overdueMinutes: OVERDUE_MINUTES,
      run: () => runDailyBriefJob(dailyBrief()),
    },
    {
      // 隔离集进出（决定 0093）：开着的偶发单放进 quarantine.json，连续 7 天全过的移出并关单。不调模型，不标 needsMaster。
      id: E2E_QUARANTINE_JOB.id,
      everyMinutes: E2E_QUARANTINE_EVERY_MINUTES,
      offsetMinutes: E2E_QUARANTINE_OFFSET_MINUTES,
      catchupMinutes: E2E_QUARANTINE_EVERY_MINUTES,
      overdueMinutes: OVERDUE_MINUTES,
      run: () => runE2eQuarantineJob(e2eQuarantine()),
    },
    {
      // 停下等人的单按规则续一次（#3294）：只续「认不出按临时的办」「自动合并没挂上」，发了新版或 PR 已能合才续。
      // 不调模型、不起会话；总开关关着照跑（续了的单要等开着才派得出会话，续本身不起会话），不标 needsMaster
      id: PARKED_RETRY_JOB.id,
      everyMinutes: PARKED_RETRY_EVERY_MINUTES,
      offsetMinutes: PARKED_RETRY_OFFSET_MINUTES,
      catchupMinutes: PARKED_RETRY_EVERY_MINUTES,
      overdueMinutes: OVERDUE_MINUTES,
      run: () => runParkedRetryJob(parkedRetry()),
    },
  ];
}
