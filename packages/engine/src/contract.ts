// 工作流的对外约定：类型名、输入输出。驾驶舱后端和引擎共用这一份。
// 输入带 schemaVersion；以后加字段只许可选、读时给默认值，不许改老字段的含义（在途任务的输入是老样子）。
// 任务工作流（#632）自己的约定在 task-contract.ts。Fusion 时代的需求 / 子任务 / 合并队列工作流的输入输出、信号、查询
// 随那几条工作流一起删了（#556）；对账、路由探针、读额度、拼车盯读、每小时对账、看门狗、拉单七个定时任务的工作流外壳和输入输出
// 随它们摘出 Temporal 一起删了（#1072，改成引擎进程里的定时器，见 jobs/engine-timers.ts）；一轮的结局（*Run）留着，各任务自己记进 schedule_runs 的就是它。

import type { ScheduleOutcome } from '@fleet-dao/shared';
import { TASK_WORKFLOW_TYPE } from '@fleet-dao/shared/workflow-ids';

export const WORKFLOW_TYPES = {
  /** P0 验收（deploy/hello.sh）：跑一次就知道引擎工人在接活。 */
  hello: 'helloWorkflow',
  /** 全流程巡检（#223）：引擎的定时器每 6 小时起一条（jobs/canary-start.ts），开一张巡检单一路看到有结论，见 jobs/canary.ts。 */
  canary: 'canaryWorkflow',
  /** 任务（#632）：拉单（jobs/intake.ts）起的，一张单一条，编号 taskWorkflowId（shared/workflow-ids.ts），见 task-contract.ts。 */
  task: TASK_WORKFLOW_TYPE,
} as const;

/** 全流程巡检一轮的输入：巡检哪个仓、几点开单，都由活动按引擎配置和当时的时刻定（工作流里不取时刻）。 */
export interface CanaryInput {
  schemaVersion: 1;
}

/** 巡检开单以后每隔多久看一回（秒）。工作流和活动共用这一个数。 */
export const CANARY_POLL_SECONDS = 120;
/**
 * 连着这么多回没查成，这一轮算巡检自己没跑成：活动里读不到库、问不了 Temporal 的，由活动记成没跑成；活动本身连着失败
 * （工人丢了、记结论没成）的，工作流停下，这一轮在库里停在「在跑」，登记表上过期、看门狗照样看得见。
 */
export const CANARY_CHECK_FAILURE_LIMIT = 10;

/** 看门狗一轮的结局：和记进 schedule_runs 的同一份。scanned = 看了几个定时任务（不算它自己），found = 几个没跑成或不新鲜。 */
export interface WatchdogRun {
  runId: number;
  outcome: ScheduleOutcome;
  scanned: number;
  found: number;
  why?: string | undefined;
}

/** 拉单一轮的结局：和记进 schedule_runs 的同一份。scanned = 受管的仓数，found = 起了几条任务加留了几条言。 */
export interface IntakeRun {
  runId: number;
  outcome: ScheduleOutcome;
  scanned: number;
  found: number;
  why?: string | undefined;
}

/** 对账补漏一轮的结局：和记进 schedule_runs 的是同一份（runId 是那一行的编号）。 */
export interface GitHubReconcileRun {
  runId: number;
  outcome: ScheduleOutcome;
  scanned: number;
  found: number;
  why?: string | undefined;
}

/** 路由探针一轮的结局：和记进 schedule_runs 的同一份。scanned = 看了几条路由，found = 这一轮之后几条不在线。 */
export interface RouteProbeRun {
  runId: number;
  outcome: ScheduleOutcome;
  scanned: number;
  found: number;
  /** 这一轮之后在线的路由。 */
  online: string[];
  why?: string | undefined;
}

/** 定时读额度一轮的结局：和记进 schedule_runs 的同一份。scanned = 配置里几个池，found = 这一轮要报的池数。 */
export interface QuotaReadRun {
  runId: number;
  outcome: ScheduleOutcome;
  scanned: number;
  found: number;
  why?: string | undefined;
}

/** 拼车盯读一轮的结局：和记进 schedule_runs 的同一份。scanned = 1，found = 这一轮要报的提醒数。 */
export interface CarpoolWatchRun {
  runId: number;
  outcome: ScheduleOutcome;
  scanned: number;
  found: number;
  why?: string | undefined;
}

/** 每小时对账一轮的结局：和记进 schedule_runs 的同一份。scanned = 看了几个对象，found = 处理了几个问题。 */
export interface HourlyReconcileRun {
  runId: number;
  outcome: ScheduleOutcome;
  scanned: number;
  found: number;
  why?: string | undefined;
}

/**
 * 判断题自检一轮的结局：和记进 schedule_runs 的同一份。
 * scanned = 看过最近一次调用（有没有都算看过），found = 自检没通过或判断题起不来。sent = 这一轮真发出去了。
 */
export interface JudgeSelfCheckRun {
  runId: number;
  outcome: ScheduleOutcome;
  scanned: number;
  found: number;
  sent: boolean;
  why?: string | undefined;
}

/** 子任务的分支名：fleet/<单号>-<键>。每小时对账认树（jobs/worktree-sweep.ts）还按这个拼法认老的树。 */
export function subtaskBranch(issueNumber: number, key: string): string {
  return `fleet/${issueNumber}-${key}`;
}
