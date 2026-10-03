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
import { type Db, finishScheduleRun, resolveAlertWithReason, startScheduleRun } from '@fleet-dao/db';
import type { GitHub } from '@fleet-dao/github';
import type { Client } from '@temporalio/client';
import type { GitHubReconcileJobDeps } from '../jobs/github-reconcile.ts';
import { sweepIssueGroom } from '../jobs/issue-groom.ts';
import { type GroomGitHub, type IssueGroomWiring, issueGroomJob } from './issue-groom.ts';

export interface GitHubReconcileWiring {
  db: Db;
  gh: Pick<GitHub, 'eventSink' | 'reconciler' | 'commentIssue'> & GroomGitHub;
  /** 单子打标挂版本问 Jev（#448，issue-kind-jev.ts 的 createIssueKindAsker）。 */
  askIssueKind: IssueGroomWiring['askKind'];
  /** 闲置清理的天数（#448，不给用默认 30/14）。 */
  issueGroomIdlePolicy?: IssueGroomWiring['idlePolicy'];
  /** 测试用：这一轮跑不跑单子打标挂版本（不给就是 jobs/issue-groom.ts 的 issueGroomDue：每小时一次）。 */
  issueGroomDue?: (at: Date) => boolean;
  log?: Logger;
  now?: () => Date;
}

/** 关单对账（#241）留在库里的四种提醒的键后缀。 */
const LEGACY_CLOSE_SWEEP_KINDS = ['due', 'mother', 'merged', 'no-result'] as const;

/**
 * 关单对账 #654 删了（关单不再要结果.md，那四种判法的前提都没了）：它以前每个仓每种一条、日报级，写在库里的提醒没人再维护，
 * 不撤的话驾驶舱上永远挂着。这里一次性撤掉（撤的是 resolvedAt，不删行；本来就没有、已经撤了都不算错），撤了几条回几。
 * 引擎重开跑过一轮之后这段就没用了，到时整个删（#654 的进度清单里记着）。
 */
export async function retireCloseSweepAlerts(
  w: Pick<GitHubReconcileWiring, 'db'>,
  repos: readonly { owner: string; name: string }[],
  now: () => Date,
): Promise<number> {
  let retired = 0;
  for (const repo of repos) {
    for (const kind of LEGACY_CLOSE_SWEEP_KINDS) {
      const done = await resolveAlertWithReason(w.db, {
        dedupeKey: `close-sweep:${repo.owner}/${repo.name}:${kind}`,
        by: 'engine:github-reconcile',
        why: '关单对账已删（#654）：关单不再要结果.md，这类提醒没人再维护',
        at: now(),
      });
      if (done === 'ok') retired += 1;
    }
  }
  return retired;
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
  // 旧的关单对账提醒只撤一次（每个引擎进程第一轮）；撤不成不挡对账本身，下一轮再试
  let legacyAlertsRetired = false;
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
      reconcile: async (options) => {
        if (!legacyAlertsRetired) {
          try {
            const repos = (await store.listRepos()).map((r) => ({ owner: r.owner, name: r.name }));
            const n = await retireCloseSweepAlerts(w, repos, now);
            legacyAlertsRetired = true;
            if (n > 0) log.info('撤了关单对账留在库里的旧提醒', { retired: n });
          } catch (err) {
            log.warn('撤关单对账的旧提醒没成，下一轮再试', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        return reconcileGitHub({ store, intake, reconciler, log, now }, options);
      },
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
