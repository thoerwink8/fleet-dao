// 对账补漏的真装配：后端的 Store（同一个库）、GitHubIntake（同一道门、同一本投递账）、@fleet-dao/github 的真轮询，
// 记账用 @fleet-dao/db 的 schedule_runs。发信号、拉起需求工作流（后端的 createTemporalRequirementWorkflows，和 webhook 那条
// 同一份实现）用这次活动自己的 Temporal 客户端，起在这个工人取活的任务队列上。
import {
  createGitHubIntake,
  createPgStore,
  createTemporalRequirementWorkflows,
  createTemporalWorkflowControl,
  jsonLogger,
  type Logger,
  type RequirementWorkflows,
  reconcileGitHub,
  reconcilerOptions,
} from '@fleet-dao/api';
import { type Db, finishScheduleRun, registerScheduledJobs, startScheduleRun } from '@fleet-dao/db';
import type { GitHub } from '@fleet-dao/github';
import type { Client } from '@temporalio/client';
import { GITHUB_RECONCILE_JOB, type GitHubReconcileJobDeps } from '../jobs/github-reconcile.ts';

export interface GitHubReconcileWiring {
  db: Db;
  gh: Pick<GitHub, 'eventSink' | 'reconciler'>;
  /** 测试用：换掉拉起需求工作流（不给就是真的，经这次活动的 Temporal 客户端起）。 */
  requirements?: RequirementWorkflows;
  log?: Logger;
  now?: () => Date;
}

/** 给 EngineJobs.githubReconcile 用的工厂。 */
export function githubReconcileJob(
  w: GitHubReconcileWiring,
): (client: Client, taskQueue: string) => GitHubReconcileJobDeps {
  const now = w.now ?? (() => new Date());
  const log = w.log ?? jsonLogger();
  const store = createPgStore(w.db, { now });
  // 引擎等 CI 靠活动自己轮询，PR、CI 事件只写镜像，不按事件叫醒（和后端 main.ts 一样）
  const github = w.gh.eventSink({ async wake() {} });
  return (client, taskQueue) => {
    const intake = createGitHubIntake({
      store,
      github,
      workflows: createTemporalWorkflowControl(client),
      requirements: w.requirements ?? createTemporalRequirementWorkflows(client, taskQueue),
      log,
      now,
    });
    const reconciler = w.gh.reconciler(reconcilerOptions({ store, intake }));
    return {
      reconcile: (options) => reconcileGitHub({ store, intake, reconciler, log, now }, options),
      runs: {
        start: (job, at) => startScheduleRun(w.db, job, at),
        finish: (id, result, at) => finishScheduleRun(w.db, id, result, at),
      },
      now,
      log: (level, message, fields) => log[level](message, fields),
    };
  };
}

/** 引擎启动时登记定时任务：一次都没跑过的也在驾驶舱「定时任务」页和看门狗的名单上（标 never）。 */
export async function registerEngineJobs(db: Db): Promise<void> {
  await registerScheduledJobs(db, [GITHUB_RECONCILE_JOB]);
}
