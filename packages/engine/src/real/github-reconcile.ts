// 对账补漏的真装配：后端的 Store（同一个库）、GitHubIntake（同一道门、同一本投递账）、@fleet-dao/github 的真轮询，
// 记账用 @fleet-dao/db 的 schedule_runs。发信号、拉起需求工作流（后端的 createTemporalRequirementWorkflows，和 webhook 那条
// 同一份实现）用这次活动自己的 Temporal 客户端，起在这个工人取活的任务队列上。
// 每轮先同步各仓的流程配置副本（jobs/flow-config.ts）：「引擎」机器人读默认分支头上的 .fleet/flow.json，全组织默认读这份
// 代码里带的 packages/core/flow.default.json，写库、报提醒都是同一个库。
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
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
import { PROJECT_CONFIG_PATH, type Source } from '@fleet-dao/core';
import {
  type Db,
  finishScheduleRun,
  listFlowReplicas,
  resolveAlertByKey,
  startScheduleRun,
  upsertAlert,
  writeFlowReplica,
} from '@fleet-dao/db';
import type { GitHub } from '@fleet-dao/github';
import type { Client } from '@temporalio/client';
import { type FlowConfigJobDeps, syncFlowConfigs } from '../jobs/flow-config.ts';
import type { GitHubReconcileJobDeps } from '../jobs/github-reconcile.ts';

export interface GitHubReconcileWiring {
  db: Db;
  gh: Pick<GitHub, 'eventSink' | 'reconciler' | 'readRepoFile'>;
  /** 测试用：换掉拉起需求工作流（不给就是真的，经这次活动的 Temporal 客户端起）。 */
  requirements?: RequirementWorkflows;
  /** 测试用：换掉全组织默认（不给就读这份代码里带的 packages/core/flow.default.json）。 */
  orgDefault?: () => Promise<Source>;
  log?: Logger;
  now?: () => Date;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 全组织默认：随引擎发布的 @fleet-dao/core/flow.default.json。不在是 missing，别的读不了是 unreadable（都判全部停派）。 */
export async function readOrgDefault(): Promise<Source> {
  let path: string;
  try {
    path = createRequire(import.meta.url).resolve('@fleet-dao/core/flow.default.json');
  } catch (err) {
    return { kind: 'unreadable', error: `找不到 @fleet-dao/core 的 flow.default.json（${message(err)}）` };
  }
  try {
    return { kind: 'text', text: await readFile(path, 'utf8') };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'unreadable', error: message(err) };
  }
}

/** 流程配置副本那一步的真装配。 */
export function flowConfigJob(w: GitHubReconcileWiring, log: Logger, now: () => Date): FlowConfigJobDeps {
  return {
    list: () => listFlowReplicas(w.db),
    orgDefault: w.orgDefault ?? readOrgDefault,
    async read(repo) {
      const got = await w.gh.readRepoFile({ repo, path: PROJECT_CONFIG_PATH });
      // 那个路径上不是能读的文本（目录、子模块、太大）：仓里的东西不对，按认不出算，不是没查成
      const file: Source =
        got.file.kind === 'not_file' ? { kind: 'unreadable', error: got.file.why } : got.file;
      return { commit: got.commit, file };
    },
    write: (repoId, write, at) => writeFlowReplica(w.db, repoId, write, at),
    async alert(key, title, body) {
      await upsertAlert(w.db, { dedupeKey: key, level: 'alert', taskId: null, title, body });
    },
    async resolve(key) {
      await resolveAlertByKey(w.db, { dedupeKey: key, by: 'engine:github-reconcile' });
    },
    now,
    log: (level, text, fields) => log[level](text, fields),
  };
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
  const flow = flowConfigJob(w, log, now);
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
      syncFlowConfigs: () => syncFlowConfigs(flow),
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
