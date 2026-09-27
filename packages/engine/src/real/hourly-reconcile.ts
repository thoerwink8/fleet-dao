// 每小时对账的真装配：工作树按目录真列（根和仓这两级归 root、755，引擎自己读得了）、属主和删经 fleet-agent-scope
// （real/worktrees.ts）、树里还剩什么以会话用户的身份看（real/user-git.ts 的 treeLeftovers：仓里跑 git，不是仓的用 find
// 一层层列）；需求、子任务、PR 头、批准从库里读；工作流在不在跑、挂没挂着问这次活动的 Temporal 客户端；这个阶段派不派得
// 出去问选路（store-ports 的 pickRoute：和任务挂起时用的同一套）；提醒的读写、操作记录、结局记账是同一个库。
import { readdir } from 'node:fs/promises';
import {
  alertByKey,
  type Db,
  finishScheduleRun,
  getApproval,
  insertAlertOnce,
  issueWorkFacts,
  latestAlertByPrefix,
  listOpenAlerts,
  openSessionTrees,
  prHeadsOfBranch,
  resolveAlertWithReason,
  startScheduleRun,
  subtaskTreeRefs,
  taskContext,
  taskStateOf,
  updateOpenAlert,
  upsertAlert,
} from '@fleet-dao/db';
import { requirementWorkflowId, subtaskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import { type Client, WorkflowNotFoundError } from '@temporalio/client';
import type { HourlyReconcileJobDeps } from '../jobs/hourly-reconcile.ts';
import type { WorkflowReader, WorkflowView } from '../jobs/reconcile-common.ts';
import type { PortContext } from '../ports.ts';
import type { UserExec } from './exec.ts';
import { PROBE_DIR } from './route-probe.ts';
import { createStorePorts } from './store-ports.ts';
import { treeLeftovers } from './user-git.ts';
import { SESSION_TMP_DIR, type WorkTrees } from './worktrees.ts';

/** 列一个目录：只认目录（符号链接不跟，算「不是目录」，没碰）。读不了照抛。 */
export async function listDirEntries(dir: string): Promise<{ name: string; isDir: boolean }[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
}

const asRecord = (x: unknown): Record<string, unknown> | null =>
  x && typeof x === 'object' ? (x as Record<string, unknown>) : null;

/** status 查询回的东西（需求、子任务都有 parked、waiting、doing；子任务还有 approval）→ 要用的几样。认不出照抛，不当成「没挂着」。 */
export function workflowViewOf(raw: unknown, workflowId: string): WorkflowView {
  const r = asRecord(raw);
  if (!r || typeof r.parked !== 'boolean') {
    throw new Error(`${workflowId} 的 status 查询回的东西认不出（没有 parked）`);
  }
  let waiting: WorkflowView['waiting'] = null;
  if (r.waiting !== null && r.waiting !== undefined) {
    const w = asRecord(r.waiting);
    if (!w || typeof w.kind !== 'string' || typeof w.detail !== 'string' || typeof w.since !== 'string') {
      throw new Error(`${workflowId} 的 status 查询里 waiting 认不出`);
    }
    waiting = { kind: w.kind, detail: w.detail, since: w.since };
  }
  let approval: WorkflowView['approval'] = null;
  if (r.approval !== null && r.approval !== undefined) {
    const a = asRecord(r.approval);
    if (!a || typeof a.approvalId !== 'string' || typeof a.state !== 'string') {
      throw new Error(`${workflowId} 的 status 查询里 approval 认不出`);
    }
    approval = { approvalId: a.approvalId, state: a.state };
  }
  return { parked: r.parked, waiting, doing: typeof r.doing === 'string' ? r.doing : '', approval };
}

/** 问 Temporal：没有这条工作流是 missing；别的查不了（连不上、没权限）照抛。 */
export function temporalWorkflows(client: Pick<Client, 'workflow'>): WorkflowReader {
  return {
    async state(workflowId) {
      try {
        const d = await client.workflow.getHandle(workflowId).describe();
        return d.status.name === 'RUNNING'
          ? { state: 'running' }
          : { state: 'closed', status: d.status.name };
      } catch (err) {
        if (err instanceof WorkflowNotFoundError) return { state: 'missing' };
        throw err;
      }
    },
    async view(workflowId) {
      return workflowViewOf(await client.workflow.getHandle(workflowId).query('status'), workflowId);
    },
  };
}

/** 选路这一下不在活动里、不心跳，给一个不会被叫停的上下文。 */
const NO_CTX: PortContext = {
  signal: new AbortController().signal,
  heartbeat() {},
  attempt: 1,
  lastHeartbeat: undefined,
};

export interface HourlyReconcileWiring {
  db: Db;
  trees: WorkTrees;
  exec: UserExec;
  /** 这台机器给人看的名字（FLEET_MACHINE_NAME）。 */
  machine: string;
  now?: () => Date;
  log?: HourlyReconcileJobDeps['log'];
  /** 以下测试用。 */
  gitBin?: string;
  shBin?: string;
  listDir?: HourlyReconcileJobDeps['listDir'];
  stageRoutable?: HourlyReconcileJobDeps['stageRoutable'];
  workflows?: WorkflowReader;
  inspectMax?: number;
}

/** 给 EngineJobs.hourlyReconcile 用的工厂。 */
export function hourlyReconcileJob(
  w: HourlyReconcileWiring,
): (client: Pick<Client, 'workflow'>) => HourlyReconcileJobDeps {
  const now = w.now ?? (() => new Date());
  const log: HourlyReconcileJobDeps['log'] =
    w.log ?? ((level, text, fields) => console[level === 'info' ? 'info' : level](text, fields ?? {}));
  const store = createStorePorts({ db: w.db, now });
  // 和点「继续」以后选路会怎么选是同一套：全熔断时它放一条去试探，也算派得出去——它这时还会顺手把「全熔断」那条提醒
  // 再报一次（条件确实还在）；要一个不写库的判法见 #246。
  const stageRoutable: HourlyReconcileJobDeps['stageRoutable'] =
    w.stageRoutable ??
    (async (stage, taskId) => {
      const r = await store.pickRoute(
        { stage, taskId: taskId ?? '', avoidRouteIds: [], avoidPoolIds: [], avoidModelIds: [] },
        NO_CTX,
      );
      if (r.ok) return { kind: 'dispatch' };
      return r.waitFor === 'none' ? { kind: 'none', detail: r.detail } : { kind: 'wait', detail: r.detail };
    });
  return (client) => ({
    root: w.trees.root,
    probeDir: PROBE_DIR,
    sessionTmpDir: SESSION_TMP_DIR,
    machine: w.machine,
    listDir: w.listDir ?? listDirEntries,
    treeFor: (repo, branch) => w.trees.treeFor(repo, branch),
    ownerOf: (dir) => w.trees.ownerOf(dir),
    remove: (dir) => w.trees.remove(dir),
    leftovers: (dir, user, known, scratch) =>
      treeLeftovers(
        {
          exec: w.exec,
          user,
          dir,
          scopePrefix: 'reconcile',
          ...(w.gitBin ? { git: w.gitBin } : {}),
          ...(w.shBin ? { sh: w.shBin } : {}),
        },
        known,
        { scratch },
      ),
    issue: (ref) => issueWorkFacts(w.db, ref),
    prHeads: (ref) => prHeadsOfBranch(w.db, ref),
    subtaskTrees: (ids) => subtaskTreeRefs(w.db, ids),
    openSessions: () => openSessionTrees(w.db),
    taskState: (taskId) => taskStateOf(w.db, taskId),
    async approval(id) {
      const a = await getApproval(w.db, id);
      if (!a) return null;
      // 子任务发的等子任务工作流；Fusion 发的（没有子任务）等需求工作流（编号和需求工作流同一个）
      let waitingWorkflowId: string | null = a.subtaskId ? subtaskWorkflowId(a.subtaskId) : null;
      if (!a.subtaskId) {
        const task = await taskContext(w.db, a.taskId);
        waitingWorkflowId = task ? requirementWorkflowId(task.repo, task.issueNumber) : null;
      }
      return { decision: a.decision, decidedBy: a.decidedBy, waitingWorkflowId };
    },
    workflows: w.workflows ?? temporalWorkflows(client),
    stageRoutable,
    alerts: {
      listOpen: (limit) => listOpenAlerts(w.db, { limit }),
      byKey: (key) => alertByKey(w.db, key),
      latestByPrefix: (prefix) => latestAlertByPrefix(w.db, prefix),
      resolve: (x) =>
        resolveAlertWithReason(w.db, {
          dedupeKey: x.dedupeKey,
          by: x.by,
          why: x.why,
          at: now(),
          ...(x.auditActor ? { auditActor: x.auditActor } : {}),
        }),
      async raise(x) {
        await upsertAlert(w.db, {
          dedupeKey: x.dedupeKey,
          level: x.level,
          taskId: x.taskId,
          title: x.title,
          body: x.body,
          ...(x.link ? { link: x.link } : {}),
        });
      },
      insertOnce: (x) => insertAlertOnce(w.db, x),
      updateOpen: (x) => updateOpenAlert(w.db, { ...x, at: now() }),
    },
    runs: {
      start: (job, at) => startScheduleRun(w.db, job, at),
      finish: (id, result, at) => finishScheduleRun(w.db, id, result, at),
    },
    now,
    log,
    ...(w.inspectMax === undefined ? {} : { inspectMax: w.inspectMax }),
  });
}
