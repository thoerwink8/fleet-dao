// 对账补漏的真装配：后端的 Store（同一个库）、GitHubIntake（同一道门、同一本投递账）、@fleet-dao/github 的真轮询，
// 记账用 @fleet-dao/db 的 schedule_runs。发信号、拉起一张单的工作流（后端的 createTemporalRequirementWorkflows，和 webhook
// 那条同一份实现，起的都是 Fusion）用这次活动自己的 Temporal 客户端，起在这个工人取活的任务队列上。
// 每轮先同步各仓的流程配置副本（jobs/flow-config.ts）：「引擎」机器人读默认分支头上的 .fleet/flow.json，全组织默认读这份
// 代码里带的 packages/core/flow.default.json，写库、报提醒都是同一个库。重放、补收拉起前判「挂没挂在当前版本」，也经这个机器人现读。
// 对账之后给问创始人的提问另开单（jobs/ask-issues.ts，#259）：读库里的提问，「引擎」机器人现读原单、开单、写评论，单号回写库里。
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import {
  createGitHubIntake,
  createPgStore,
  createTemporalRequirementWorkflows,
  createTemporalWorkflowControl,
  githubIssuePlans,
  jsonLogger,
  type Logger,
  type RequirementWorkflows,
  reconcileGitHub,
  reconcilerOptions,
} from '@fleet-dao/api';
import { PROJECT_CONFIG_PATH, type Source } from '@fleet-dao/core';
import {
  askIssueCandidates,
  type Db,
  finishScheduleRun,
  listFlowReplicas,
  markAsksApplied,
  resolveAlertByKey,
  resolveAlertWithReason,
  setAskFollowUpIssue,
  startScheduleRun,
  upsertAlert,
  writeFlowReplica,
} from '@fleet-dao/db';
import type { GitHub } from '@fleet-dao/github';
import type { Client } from '@temporalio/client';
import { type AskIssueJobDeps, openAskIssues } from '../jobs/ask-issues.ts';
import { type CloseSweepJobDeps, sweepClosing } from '../jobs/close-sweep.ts';
import { type FlowConfigJobDeps, syncFlowConfigs } from '../jobs/flow-config.ts';
import type { GitHubReconcileJobDeps } from '../jobs/github-reconcile.ts';
import { toTaskAsk } from './store-ports.ts';

export interface GitHubReconcileWiring {
  db: Db;
  gh: Pick<
    GitHub,
    'eventSink' | 'reconciler' | 'readRepoFile' | 'readIssuePlan' | 'openIssue' | 'commentIssue' | 'readCloseFacts'
  >;
  /** 测试用：换掉拉起工作流（不给就是真的，经这次活动的 Temporal 客户端起 Fusion）。 */
  requirements?: RequirementWorkflows;
  /** 测试用：这一轮跑不跑关单对账（不给就是 jobs/close-sweep.ts 的 closeSweepDue，按真钟：北京时间 9:00 起的那一轮）。 */
  closeSweepDue?: (at: Date) => boolean;
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

/** 给提问另开单那一步的真装配（#259）。 */
export function askIssueJob(w: GitHubReconcileWiring, log: Logger, now: () => Date): AskIssueJobDeps {
  return {
    async candidates() {
      return (await askIssueCandidates(w.db)).map((c) => ({
        ask: toTaskAsk(c.ask),
        taskId: c.ask.taskId,
        taskState: c.taskState,
        taskTitle: c.taskTitle,
        issueNumber: c.issueNumber,
        repo: c.repo,
      }));
    },
    async original(repo, issueNumber) {
      const plan = await w.gh.readIssuePlan({ repo, issueNumber });
      return { labels: plan.labels, milestone: plan.milestone, openMilestones: plan.openMilestones };
    },
    openIssue: (input) => w.gh.openIssue(input),
    setFollowUp: (askId, issueNumber) => setAskFollowUpIssue(w.db, { askId, issueNumber }),
    comment: (input) => w.gh.commentIssue(input),
    async relayed(c) {
      await markAsksApplied(w.db, { taskId: c.taskId, askIds: [c.ask.id], at: now() });
    },
    async alert(key, taskId, title, body) {
      await upsertAlert(w.db, { dedupeKey: key, level: 'alert', taskId, title, body });
    },
    async resolve(key) {
      await resolveAlertByKey(w.db, { dedupeKey: key, by: 'engine:github-reconcile' });
    },
    log: (level, text, fields) => log[level](text, fields),
  };
}

/** 关单对账那一步的真装配（#241）：受管的仓从库里列，现状、留言经「引擎」机器人，提醒进同一个库（要人拍的那一级）。 */
export function closeSweepJob(
  w: GitHubReconcileWiring,
  repos: () => Promise<{ owner: string; name: string }[]>,
  log: Logger,
  now: () => Date,
): CloseSweepJobDeps {
  return {
    repos,
    facts: (repo, since) => w.gh.readCloseFacts({ repo, since }),
    comment: (input) => w.gh.commentIssue(input),
    async alert(key, title, body, link) {
      await upsertAlert(w.db, { dedupeKey: key, level: 'decision', taskId: null, title, body, link });
    },
    async resolve(key, why) {
      await resolveAlertWithReason(w.db, { dedupeKey: key, by: 'engine:github-reconcile', why, at: now() });
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
  const asks = askIssueJob(w, log, now);
  const close = closeSweepJob(
    w,
    async () => (await store.listRepos()).map((r) => ({ owner: r.owner, name: r.name })),
    log,
    now,
  );
  return (client, taskQueue) => {
    const intake = createGitHubIntake({
      store,
      github,
      workflows: createTemporalWorkflowControl(client),
      requirements: w.requirements ?? createTemporalRequirementWorkflows(client, taskQueue),
      // 只派当前版本的独立单：挂在哪、当前版本是哪个、是不是母单子单，拉起前经「引擎」机器人现读（和后端 webhook 那条同一份判法）
      plans: githubIssuePlans(w.gh),
      log,
      now,
    });
    const reconciler = w.gh.reconciler(reconcilerOptions({ store, intake }));
    return {
      syncFlowConfigs: () => syncFlowConfigs(flow),
      reconcile: (options) => reconcileGitHub({ store, intake, reconciler, log, now }, options),
      askIssues: () => openAskIssues(asks),
      closeSweep: () => sweepClosing(close),
      ...(w.closeSweepDue ? { closeSweepDue: w.closeSweepDue } : {}),
      runs: {
        start: (job, at) => startScheduleRun(w.db, job, at),
        finish: (id, result, at) => finishScheduleRun(w.db, id, result, at),
      },
      now,
      log: (level, message, fields) => log[level](message, fields),
    };
  };
}
