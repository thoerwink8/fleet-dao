// 全流程巡检的真装配：巡检仓按引擎配置 FLEET_CANARY_REPO（owner/name，写在 /etc/fleet-dao/engine.env，期望在 deploy/<档>/desired-config.json；
// 法国和本机档不许是同一个仓，#777）；
// 开单（同时挂上当前版本）、读单子、关单都是「引擎」机器人（@fleet-dao/github），巡检单的需求写全在正文里（#295）；
// 这张单在库里的事实、每一轮的记录、报警是同一个库（@fleet-dao/db）；任务工作流在不在跑、走到哪一步问这次活动的 Temporal
// 客户端（taskStatus 查询），收前几轮留下的单发的是驾驶舱「放弃」同一个信号（taskAbandon）；「驾驶舱显示」读的是驾驶舱后端的
// Store（主页「做完的」那一栏读的同一份：任务行、PR 镜像）。

import {
  canaryDbFacts,
  canaryPullRequestNumber,
  concludeAbandonedCanaryRuns,
  type Db,
  finishCanaryRun,
  finishScheduleRun,
  leftoverCanaryRuns,
  markCanaryCleaned,
  resolveAlertWithReason,
  saveCanaryProgress,
  startCanaryRun,
  startScheduleRun,
  upsertAlert,
} from '@fleet-dao/db';
import type { GitHub } from '@fleet-dao/github';
import { createPgStore } from '@fleet-dao/store';
import { type Client, WorkflowNotFoundError } from '@temporalio/client';
import {
  CANARY_ACTOR,
  CANARY_ALERT_KEY,
  CANARY_CLEANUP_LIMIT,
  type CanaryDeps,
  type CanaryView,
} from '../jobs/canary.ts';
import { INTAKE_JOB } from '../jobs/intake.ts';
import { taskAbandonSignal, taskStatusQuery } from '../task-contract.ts';
import { temporalWorkflows } from './hourly-reconcile.ts';

/** 巡检仓的写法：owner/name（GitHub 的用户名、仓名只有字母、数字、- _ .）。 */
const REPO_SLUG = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/;

/** 发「放弃」信号最多等多久（毫秒）：到点由连接取消调用，不在本地空等（空等可能让信号晚到、重发成两次）。 */
const SIGNAL_TIMEOUT_MS = 5_000;

/** FLEET_CANARY_REPO 读成巡检仓；没配、认不出都回 error（这一轮没跑成，写明缺什么），不拿别的仓顶。 */
export function canaryRepoFrom(raw: string | undefined): { owner: string; name: string } | { error: string } {
  const value = raw?.trim() ?? '';
  if (!value)
    return {
      error: '没配巡检仓：引擎配置 /etc/fleet-dao/engine.env 里没有 FLEET_CANARY_REPO（写 owner/name）',
    };
  const m = REPO_SLUG.exec(value);
  if (!m?.[1] || !m[2]) return { error: '引擎配置 FLEET_CANARY_REPO 认不出：要写成 owner/name' };
  return { owner: m[1], name: m[2] };
}

const asRecord = (x: unknown): Record<string, unknown> | null =>
  x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null;

const isCount = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0;

/**
 * 在跑的任务工作流 taskStatus 查询回的东西（task-contract.ts 的 TaskStatus）→ 巡检要的几样。认不出照抛（这一回没查成），
 * 不当成「没停下」。
 */
export function canaryViewOf(raw: unknown, workflowId: string): CanaryView {
  const r = asRecord(raw);
  if (
    !r ||
    typeof r.phase !== 'string' ||
    typeof r.doing !== 'string' ||
    !isCount(r.round) ||
    !isCount(r.verifyRound)
  ) {
    throw new Error(
      `${workflowId} 的 taskStatus 查询回的东西认不出（不是任务工作流？没有 phase、doing、round、verifyRound）`,
    );
  }
  let waiting: CanaryView['waiting'] = null;
  if (r.waiting !== null && r.waiting !== undefined) {
    const w = asRecord(r.waiting);
    if (!w || typeof w.kind !== 'string' || typeof w.detail !== 'string') {
      throw new Error(`${workflowId} 的 taskStatus 查询里 waiting 认不出`);
    }
    waiting = { kind: w.kind, detail: w.detail };
  }
  const prNumber = r.prNumber;
  if (prNumber !== null && prNumber !== undefined && !(isCount(prNumber) && prNumber > 0)) {
    throw new Error(`${workflowId} 的 taskStatus 查询里 prNumber 认不出`);
  }
  const lastProblem = typeof r.lastProblem === 'string' ? r.lastProblem : null;
  return {
    phase: r.phase,
    doing: r.doing,
    parked: r.phase === 'parked' || waiting?.kind === 'human',
    waiting,
    prNumber: prNumber ?? null,
    lastProblem,
    round: r.round,
    verifyRound: r.verifyRound,
  };
}

export interface CanaryWiring {
  db: Db;
  gh: Pick<GitHub, 'readOpenMilestones' | 'openIssue' | 'readIssueState' | 'closeIssue'>;
  /** 引擎配置 FLEET_CANARY_REPO 的原文。 */
  repo: string | undefined;
  now?: () => Date;
  log?: CanaryDeps['log'];
}

/** 给 EngineJobs.canary 用的工厂。 */
export function canaryJob(w: CanaryWiring): (client: Client) => CanaryDeps {
  const now = w.now ?? (() => new Date());
  const log: CanaryDeps['log'] =
    w.log ?? ((level, text, fields) => console[level === 'info' ? 'info' : level](text, fields ?? {}));
  const repo = canaryRepoFrom(w.repo);
  const store = createPgStore(w.db, { now });
  return (client) => {
    const workflows = temporalWorkflows(client);
    const target = 'error' in repo ? null : repo;
    const need = () => {
      if (!target) throw new Error('没配巡检仓');
      return target;
    };
    return {
      repo,
      runs: {
        start: (job, at) => startScheduleRun(w.db, job, at),
        finish: (id, result, at) => finishScheduleRun(w.db, id, result, at),
      },
      record: {
        start: (input) => startCanaryRun(w.db, input),
        progress: (id, input) => saveCanaryProgress(w.db, id, input),
        finish: (id, input) => finishCanaryRun(w.db, id, input),
        leftovers: async (slug) =>
          (await leftoverCanaryRuns(w.db, { repo: slug, limit: CANARY_CLEANUP_LIMIT })).map((r) => ({
            id: r.id,
            issueNumber: r.issueNumber,
          })),
        cleaned: (id, at) => markCanaryCleaned(w.db, id, at),
        abandon: (input) => concludeAbandonedCanaryRuns(w.db, input),
      },
      github: {
        openMilestones: () => w.gh.readOpenMilestones({ repo: need() }),
        async openIssue(input) {
          // 不贴标签（巡检单不算哪一类活）；开单时就挂上当前版本，拉单才拉
          const r = await w.gh.openIssue({
            repo: need(),
            key: input.dedupe,
            title: input.title,
            body: input.body,
            labels: [],
            milestone: input.milestone,
          });
          return { number: r.number, url: r.url };
        },
        issueState: (issueNumber) => w.gh.readIssueState({ repo: need(), issueNumber }),
        async closeIssue(issueNumber, comment) {
          await w.gh.closeIssue({ repo: need(), issueNumber, reason: 'not_planned', comment });
        },
      },
      facts: ({ issueNumber, since }) =>
        canaryDbFacts(w.db, { ...need(), issueNumber, since, intakeJob: INTAKE_JOB.id }),
      workflows: {
        state: (workflowId) => workflows.state(workflowId),
        async view(workflowId) {
          return canaryViewOf(await client.workflow.getHandle(workflowId).query(taskStatusQuery), workflowId);
        },
        async stop(workflowId, reason) {
          try {
            await client.connection.withDeadline(Date.now() + SIGNAL_TIMEOUT_MS, () =>
              client.workflow.getHandle(workflowId).signal(taskAbandonSignal, { by: CANARY_ACTOR, reason }),
            );
            return 'sent';
          } catch (err) {
            if (err instanceof WorkflowNotFoundError) return 'gone';
            throw err;
          }
        },
      },
      async board(taskId, prNumber) {
        const task = await store.getTask(taskId);
        // 工作流已经不在跑、没拍到过 PR 编号（任务做得快）：从 PR 镜像里按单号找引擎给这张单开的那个 PR，不然这一步永远空着
        const number =
          prNumber ??
          (task
            ? await canaryPullRequestNumber(w.db, { repoId: task.repoId, issueNumber: task.issueNumber })
            : null);
        const pr = task && number !== null ? await store.getPullRequest(task.repoId, number) : null;
        return {
          taskState: task?.state ?? null,
          pr: pr
            ? {
                number: pr.number,
                state: pr.state,
                mergedAt: pr.mergedAt ?? null,
                linkedIssue: pr.issueRefs?.[0] ?? null,
              }
            : null,
        };
      },
      alerts: {
        async raise(input) {
          await upsertAlert(w.db, {
            dedupeKey: CANARY_ALERT_KEY,
            level: 'alert',
            taskId: input.taskId,
            title: input.title,
            body: input.body,
          });
        },
        async resolve(why) {
          await resolveAlertWithReason(w.db, {
            dedupeKey: CANARY_ALERT_KEY,
            by: CANARY_ACTOR,
            why,
            at: now(),
          });
        },
      },
      now,
      log,
    };
  };
}
