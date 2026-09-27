// 全流程巡检的真装配：巡检仓按引擎配置 FLEET_CANARY_REPO（owner/name，写在 /etc/fleet-dao/engine.env，公开仓里不写真值）；
// 开单（同时挂上当前版本）、读单子、关单都是「引擎」机器人（@fleet-dao/github），巡检单的需求写全在正文里（#295）；
// 这张单在库里的事实、每一轮的记录、报警是同一个库（@fleet-dao/db）；工作流在不在跑、走到哪一步问这次活动的 Temporal
// 客户端，叫停前几轮留下的单和驾驶舱叫停同一个信号（后端的 createTemporalWorkflowControl）；「驾驶舱显示」读的是驾驶舱后端的
// Store（看板、任务详情读的同一份）。
import { createPgStore, createTemporalWorkflowControl, WorkflowGoneError } from '@fleet-dao/api';
import {
  canaryDbFacts,
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
import type { Client } from '@temporalio/client';
import {
  CANARY_ACTOR,
  CANARY_ALERT_KEY,
  CANARY_CLEANUP_LIMIT,
  type CanaryDeps,
  type CanaryView,
} from '../jobs/canary.ts';
import { temporalWorkflows } from './hourly-reconcile.ts';

/** 巡检仓的写法：owner/name（GitHub 的用户名、仓名只有字母、数字、- _ .）。 */
const REPO_SLUG = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/;

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

/** 在跑的 Fusion 工作流 status 查询回的东西 → 巡检要的几样。认不出照抛（这一回没查成），不当成「没挂着」。 */
export function canaryViewOf(raw: unknown, workflowId: string): CanaryView {
  const r = asRecord(raw);
  if (!r || typeof r.step !== 'string' || typeof r.parked !== 'boolean') {
    throw new Error(`${workflowId} 的 status 查询回的东西认不出（不是 Fusion 工作流？没有 step、parked）`);
  }
  let waiting: CanaryView['waiting'] = null;
  if (r.waiting !== null && r.waiting !== undefined) {
    const w = asRecord(r.waiting);
    if (!w || typeof w.kind !== 'string' || typeof w.detail !== 'string') {
      throw new Error(`${workflowId} 的 status 查询里 waiting 认不出`);
    }
    waiting = { kind: w.kind, detail: w.detail };
  }
  const prNumber = r.prNumber;
  if (prNumber !== null && prNumber !== undefined && typeof prNumber !== 'number') {
    throw new Error(`${workflowId} 的 status 查询里 prNumber 认不出`);
  }
  const lastProblem = typeof r.lastProblem === 'string' ? r.lastProblem : null;
  return { step: r.step, parked: r.parked, waiting, prNumber: prNumber ?? null, lastProblem };
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
    const control = createTemporalWorkflowControl(client);
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
          // 不贴标签（巡检单不算哪一类活）；开单时就挂上当前版本，接活才派
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
      facts: (issueNumber) => canaryDbFacts(w.db, { ...need(), issueNumber }),
      workflows: {
        state: (workflowId) => workflows.state(workflowId),
        async view(workflowId) {
          return canaryViewOf(await client.workflow.getHandle(workflowId).query('status'), workflowId);
        },
        async stop(workflowId, reason) {
          try {
            await control.signal(workflowId, { name: 'stop', by: CANARY_ACTOR, reason });
            return 'sent';
          } catch (err) {
            if (err instanceof WorkflowGoneError) return 'gone';
            throw err;
          }
        },
      },
      async board(taskId) {
        const task = await store.getTask(taskId);
        const blocks = task ? await store.listSubtasks([taskId]) : [];
        const block = blocks.find((b) => b.taskId === taskId) ?? null;
        return {
          taskState: task?.state ?? null,
          prNumber: block?.prNumber ?? null,
          blockState: block?.state ?? null,
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
