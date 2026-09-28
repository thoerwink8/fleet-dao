// 对账补漏的真装配：后端的 Store（同一个库）、GitHubIntake（同一道门、同一本投递账）、@fleet-dao/github 的真轮询，
// 记账用 @fleet-dao/db 的 schedule_runs。发信号、拉起一张单的工作流（后端的 createTemporalRequirementWorkflows，和 webhook
// 那条同一份实现，起的都是 Fusion）用这次活动自己的 Temporal 客户端，起在这个工人取活的任务队列上。
// 每轮先同步各仓的流程配置副本（jobs/flow-config.ts）：「引擎」机器人读默认分支头上的 .fleet/flow.json，全组织默认读这份
// 代码里带的 packages/core/flow.default.json，写库、报提醒都是同一个库。重放、补收拉起前判「挂没挂在当前版本」，也经这个机器人现读。
// 对账之后给问创始人的提问另开单（jobs/ask-issues.ts，#259）：读库里的提问，「引擎」机器人现读原单、开单、写评论，单号回写库里。
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import {
  type ClaimAlerts,
  createClaimStatus,
  createGitHubIntake,
  createIssueIntake,
  createPgStore,
  createTemporalRequirementWorkflows,
  createTemporalWorkflowControl,
  type GitHubIntake,
  githubIssuePlans,
  jsonLogger,
  type Logger,
  type RequirementWorkflows,
  reconcileGitHub,
  reconcilerOptions,
  type Store,
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
import { ownReleaseSha } from '../drain-control.ts';
import { type AskIssueJobDeps, openAskIssues } from '../jobs/ask-issues.ts';
import { type CloseSweepJobDeps, sweepClosing } from '../jobs/close-sweep.ts';
import { type FlowConfigJobDeps, syncFlowConfigs } from '../jobs/flow-config.ts';
import type { GitHubReconcileJobDeps } from '../jobs/github-reconcile.ts';
import { toTaskAsk } from './store-ports.ts';

export interface GitHubReconcileWiring {
  db: Db;
  gh: Pick<
    GitHub,
    | 'eventSink'
    | 'reconciler'
    | 'readRepoFile'
    | 'readIssuePlan'
    | 'openIssue'
    | 'commentIssue'
    | 'readCloseFacts'
    | 'claims'
    | 'commitContains'
  >;
  /** 测试用：换掉「引擎自己在跑哪个提交」（不给就是 drain-control.ts 的 ownReleaseSha，开发机/测试认不出是 null）。 */
  ownCommit?: () => string | null;
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
    async notice(key, title, body) {
      await upsertAlert(w.db, { dedupeKey: key, level: 'daily', taskId: null, title, body });
    },
    async resolve(key) {
      await resolveAlertByKey(w.db, { dedupeKey: key, by: 'engine:github-reconcile' });
    },
    ownCommit: w.ownCommit ?? ownReleaseSha,
    newerThanOwn: (repo, commit, own) => w.gh.commitContains({ repo, base: own, head: commit }),
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

/**
 * 接活那道门要的 GitHub：写镜像（PR、CI 事件）、现读 issue 挂在哪个版本、是不是母单子单；PR 事件按库里的认领贴
 * 「认领对得上」（#348，claims）。
 */
export type IntakeGitHub = Pick<GitHub, 'eventSink' | 'readIssuePlan' | 'claims'>;

/**
 * 接活那道门的几样依赖（和 webhook 同一份判法、同一个拉起实现）：对账补漏的重放、补收、补起认领，每小时对账给排队的单
 * 补拉，都用这一份。拉起工作流用这次活动的 Temporal 客户端，起在 taskQueue 上。
 */
export function intakeDepsFor(
  w: { gh: IntakeGitHub; requirements?: RequirementWorkflows | undefined },
  parts: { store: Store; log: Logger; now: () => Date },
  client: Client,
  taskQueue: string,
) {
  return {
    store: parts.store,
    workflows: createTemporalWorkflowControl(client),
    requirements: w.requirements ?? createTemporalRequirementWorkflows(client, taskQueue),
    // 只派当前版本的独立单：挂在哪、当前版本是哪个、是不是母单子单，拉起前经「引擎」机器人现读（和后端 webhook 那条同一份判法）
    plans: githubIssuePlans(w.gh),
    // 补收、重放的 PR 事件照样贴「认领对得上」（#348，和后端 webhook 那条同一份实现）
    claims: createClaimStatus({ store: parts.store, github: w.gh.claims, log: parts.log }),
    log: parts.log,
    now: parts.now,
  };
}

/** 「认领对得上」对账那一轮没处理成的报「要人看」提醒、好了撤（#348）：进同一个库。 */
export function claimAlerts(db: Db, now: () => Date): ClaimAlerts {
  return {
    async raise(key, title, body) {
      await upsertAlert(db, { dedupeKey: key, level: 'alert', taskId: null, title, body });
    },
    async resolve(key, why) {
      await resolveAlertWithReason(db, { dedupeKey: key, by: 'engine:github-reconcile', why, at: now() });
    },
  };
}

/** 接活那道门（createGitHubIntake）：每小时对账给排队的单补拉经它重放投递，和对账补漏同一份依赖。 */
export function reconcileIntake(
  w: { gh: IntakeGitHub; requirements?: RequirementWorkflows | undefined },
  parts: { store: Store; log: Logger; now: () => Date },
  client: Client,
  taskQueue: string,
): GitHubIntake {
  return createGitHubIntake({
    ...intakeDepsFor(w, parts, client, taskQueue),
    // 引擎等 CI 靠活动自己轮询，PR、CI 事件只写镜像，不按事件叫醒（和后端 main.ts 一样）
    github: w.gh.eventSink({ async wake() {} }),
  });
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
    const intakeDeps = intakeDepsFor(w, { store, log, now }, client, taskQueue);
    const intake = createGitHubIntake({ ...intakeDeps, github });
    // 补起待起的认领（#299）：和接活同一套依赖、同一个拉起实现
    const claims = createIssueIntake(intakeDeps);
    // 「认领对得上」（#348）：作废过了宽限期的认领、所有开着的 PR 重判重贴，没处理成的报提醒
    const claimStatus = createClaimStatus({
      store,
      github: w.gh.claims,
      alerts: claimAlerts(w.db, now),
      log,
    });
    const reconciler = w.gh.reconciler(reconcilerOptions({ store, intake }));
    return {
      syncFlowConfigs: () => syncFlowConfigs(flow),
      reconcile: (options) =>
        reconcileGitHub({ store, intake, claims, claimStatus, reconciler, log, now }, options),
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
