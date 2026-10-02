// 对账补漏的真装配：后端的 Store（同一个库）、GitHubIntake（同一道门、同一本投递账）、@fleet-dao/github 的真轮询，
// 记账用 @fleet-dao/db 的 schedule_runs。
// 每轮先同步各仓的流程配置副本（jobs/flow-config.ts）：「引擎」机器人读默认分支头上的 .fleet/flow.json，全组织默认读这份
// 代码里带的 packages/core/flow.default.json，写库、报提醒都是同一个库。重放、补收拉起前判「挂没挂在当前版本」，也经这个机器人现读。
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createGitHubIntake, createPgStore, jsonLogger, type Logger, reconcileGitHub, reconcilerOptions } from '@fleet-dao/api';
import { PROJECT_CONFIG_PATH, type Source } from '@fleet-dao/core';
import {
  type Db,
  finishScheduleRun,
  listFlowReplicas,
  resolveAlertByKey,
  resolveAlertWithReason,
  startScheduleRun,
  upsertAlert,
  writeFlowReplica,
} from '@fleet-dao/db';
import type { GitHub } from '@fleet-dao/github';
import type { Client } from '@temporalio/client';
import { ownReleaseSha } from '../drain-control.ts';
import { type CloseSweepJobDeps, sweepClosing } from '../jobs/close-sweep.ts';
import { type FlowConfigJobDeps, syncFlowConfigs } from '../jobs/flow-config.ts';
import type { GitHubReconcileJobDeps } from '../jobs/github-reconcile.ts';
import { sweepIssueGroom } from '../jobs/issue-groom.ts';
import { type GroomGitHub, type IssueGroomWiring, issueGroomJob } from './issue-groom.ts';

export interface GitHubReconcileWiring {
  db: Db;
  gh: Pick<
    GitHub,
    | 'eventSink'
    | 'reconciler'
    | 'readRepoFile'
    | 'commentIssue'
    | 'readCloseFacts'
    | 'commitContains'
  > &
    GroomGitHub;
  /** 单子打标挂版本问 Jev（#448，issue-kind-jev.ts 的 createIssueKindAsker）。 */
  askIssueKind: IssueGroomWiring['askKind'];
  /** 闲置清理的天数（#448，不给用默认 30/14）。 */
  issueGroomIdlePolicy?: IssueGroomWiring['idlePolicy'];
  /** 测试用：换掉「引擎自己在跑哪个提交」（不给就是 drain-control.ts 的 ownReleaseSha，开发机/测试认不出是 null）。 */
  ownCommit?: () => string | null;
  /** 测试用：这一轮跑不跑关单对账（不给就是 jobs/close-sweep.ts 的 closeSweepDue，按真钟：北京时间 9:00 起的那一轮）。 */
  closeSweepDue?: (at: Date) => boolean;
  /** 测试用：这一轮跑不跑单子打标挂版本（不给就是 jobs/issue-groom.ts 的 issueGroomDue：每小时一次）。 */
  issueGroomDue?: (at: Date) => boolean;
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
  const flow = flowConfigJob(w, log, now);
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
      syncFlowConfigs: () => syncFlowConfigs(flow),
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
