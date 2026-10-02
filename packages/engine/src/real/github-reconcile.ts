// 对账补漏的真装配：后端的 Store（同一个库）、GitHubIntake（同一道门、同一本投递账）、@fleet-dao/github 的真轮询，
// 记账用 @fleet-dao/db 的 schedule_runs。
import {
  createGitHubIntake,
  createPgStore,
  jsonLogger,
  type Logger,
  reconcileGitHub,
  reconcilerOptions,
} from '@fleet-dao/api';
import {
  type Db,
  finishScheduleRun,
  resolveAlertWithReason,
  startScheduleRun,
  upsertAlert,
} from '@fleet-dao/db';
import type { GitHub } from '@fleet-dao/github';
import type { Client } from '@temporalio/client';
import { type CloseSweepJobDeps, sweepClosing } from '../jobs/close-sweep.ts';
import type { GitHubReconcileJobDeps } from '../jobs/github-reconcile.ts';
import { sweepIssueGroom } from '../jobs/issue-groom.ts';
import { type GroomGitHub, type IssueGroomWiring, issueGroomJob } from './issue-groom.ts';

export interface GitHubReconcileWiring {
  db: Db;
  gh: Pick<GitHub, 'eventSink' | 'reconciler' | 'commentIssue' | 'readCloseFacts'> & GroomGitHub;
  /** 单子打标挂版本问 Jev（#448，issue-kind-jev.ts 的 createIssueKindAsker）。 */
  askIssueKind: IssueGroomWiring['askKind'];
  /** 闲置清理的天数（#448，不给用默认 30/14）。 */
  issueGroomIdlePolicy?: IssueGroomWiring['idlePolicy'];
  /** 测试用：这一轮跑不跑关单对账（不给就是 jobs/close-sweep.ts 的 closeSweepDue，按真钟：北京时间 9:00 起的那一轮）。 */
  closeSweepDue?: (at: Date) => boolean;
  /** 测试用：这一轮跑不跑单子打标挂版本（不给就是 jobs/issue-groom.ts 的 issueGroomDue：每小时一次）。 */
  issueGroomDue?: (at: Date) => boolean;
  log?: Logger;
  now?: () => Date;
}

/**
 * 关单对账那一步的真装配（#241）：受管的仓从库里列，现状、留言经「引擎」机器人，提醒进同一个库。日报级（#445：这不是要
 * 创始人拍的事——没人拍它也不会自己变好，是要干活的人自己去关、去补结果；正文已经列了是哪几张单，见 close-sweep.ts）。
 */
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
      await upsertAlert(w.db, { dedupeKey: key, level: 'daily', taskId: null, title, body, link });
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
  const close = closeSweepJob(
    w,
    async () => (await store.listRepos()).map((r) => ({ owner: r.owner, name: r.name })),
    log,
    now,
  );
  const groom = issueGroomJob(
    {
      db: w.db,
      gh: w.gh,
      askKind: w.askIssueKind,
      ...(w.issueGroomIdlePolicy ? { idlePolicy: w.issueGroomIdlePolicy } : {}),
      log: (level, text, fields) => log[level](text, fields),
      now,
    },
    async () => (await store.listRepos()).map((r) => ({ owner: r.owner, name: r.name })),
  );
  return () => {
    const intake = createGitHubIntake({ store, github, log, now });
    const reconciler = w.gh.reconciler(reconcilerOptions({ store, intake }));
    return {
      reconcile: (options) => reconcileGitHub({ store, intake, reconciler, log, now }, options),
      closeSweep: () => sweepClosing(close),
      ...(w.closeSweepDue ? { closeSweepDue: w.closeSweepDue } : {}),
      issueGroom: () => sweepIssueGroom(groom),
      ...(w.issueGroomDue ? { issueGroomDue: w.issueGroomDue } : {}),
      runs: {
        start: (job, at) => startScheduleRun(w.db, job, at),
        finish: (id, result, at) => finishScheduleRun(w.db, id, result, at),
      },
      now,
      log: (level, message, fields) => log[level](message, fields),
    };
  };
}
