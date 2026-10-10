// 每小时对账的真装配：工作树按目录真列（根和仓这两级归 root、755，引擎自己读得了）、属主和删经 fleet-agent-scope
// （real/worktrees.ts）、树里还剩什么以会话用户的身份看（real/user-git.ts 的 treeLeftovers：仓里跑 git，不是仓的用 find
// 一层层列）；需求、子任务、PR 头、批准、受管的仓、合了的 PR 和会话记账从库里读；合了的 PR 问传进来的
// GitHub（auditMergedPrs，和对账补漏同一个）；工作流在不在跑、挂没挂着问这次活动的 Temporal 客户端；这个
// 阶段派不派得出去问选路（store-ports 的 pickRoute：和任务挂起时用的同一套）；GitHub 两个机器人的权限自检问
// @fleet-dao/github 的 selfCheck（受管的仓从库里的 repos 表列）；提醒的读写、操作记录、结局记账是同一个库。
import { readdir } from 'node:fs/promises';
import { loadQuotaConfig } from '@fleet-dao/adapters/quota';
import {
  alertByKey,
  countAlertFilings,
  type Db,
  finishScheduleRun,
  getApproval,
  insertAlertOnce,
  issueWorkFacts,
  latestAlertByPrefix,
  listManagedRepos,
  listOpenAlerts,
  listOpenTaskRows,
  mergedPrLedgers,
  openAlertsByPrefix,
  openSessionTrees,
  prHeadsOfBranch,
  pullMergedAt,
  quotaTable,
  readPoolHoldsSetting,
  recordAlertFiling,
  resolveAlertWithReason,
  startScheduleRun,
  stopTaskRows,
  subtaskTreeRefs,
  taskContext,
  taskStateOf,
  updateOpenAlert,
  upsertAlert,
} from '@fleet-dao/db';
import { type GitHub, type RepoRef, readCi, readPull, requiredChecksFor } from '@fleet-dao/github';
import { requirementWorkflowId, subtaskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import { deployFacts, handlingOf, pgAlertWork, readDeployLagInput } from '@fleet-dao/store';
import { type Client, WorkflowNotFoundError } from '@temporalio/client';
import { WORKFLOW_TYPES } from '../contract.ts';
import { alertRepoFromText } from '../jobs/alert-sweep.ts';
import type { AutoMergeGitHub } from '../jobs/auto-merge-check.ts';
import { CLOSED_ISSUE_ABANDON_BY } from '../jobs/closed-issue-tasks.ts';
import type { GitHubAppCheckDeps } from '../jobs/github-app-check.ts';
import type { HourlyReconcileJobDeps } from '../jobs/hourly-reconcile.ts';
import {
  MAIN_CI_VERDICT_KEY,
  MAIN_RECOVERED_KEY_PREFIX,
  MAIN_RED_KEY_PREFIX,
  mainCiVerdictTitle,
  pushMainRed,
  storedMainCiVerdict,
} from '../jobs/main-red-push.ts';
import { pushOverduePoolHolds } from '../jobs/pool-hold-push.ts';
import {
  beijingDayStart,
  RECONCILE_ACTOR,
  type WorkflowReader,
  type WorkflowView,
} from '../jobs/reconcile-common.ts';
import type { PortContext } from '../ports.ts';
import type { CarpoolRegistryView } from '../routing/index.ts';
import { taskAbandonSignal, taskStatusQuery } from '../task-contract.ts';
import type { UserExec } from './exec.ts';
import { feishuWebhookSender } from './feishu-webhook.ts';
import { mainCiRuns } from './main-ci-runs.ts';
import { PROBE_DIR } from './route-probe.ts';
import { isWorkflowGone } from './route-wake.ts';
import type { SessionOrgReader } from './session-org.ts';
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

/**
 * 任务工作流的 taskStatus 查询（task-contract.ts 的 TaskStatus）→ 对账要用的几样：停着等人（phase = parked）、在等什么、
 * 在做什么。任务工作流没有「等批准」这一项（approval 恒为 null）。认不出照抛，不当成「没挂着」：对账读错查询名、或工作流
 * 回的东西变了形，都该报「没查成」，不能悄悄当成「已经不挂着了」把提醒撤掉（#901）。
 */
export function taskViewOf(raw: unknown, workflowId: string): WorkflowView {
  const r = asRecord(raw);
  if (!r || typeof r.phase !== 'string') {
    throw new Error(`${workflowId} 的 taskStatus 查询回的东西认不出（没有 phase）`);
  }
  let waiting: WorkflowView['waiting'] = null;
  if (r.waiting !== null && r.waiting !== undefined) {
    const w = asRecord(r.waiting);
    if (!w || typeof w.kind !== 'string' || typeof w.detail !== 'string' || typeof w.since !== 'string') {
      throw new Error(`${workflowId} 的 taskStatus 查询里 waiting 认不出`);
    }
    waiting = { kind: w.kind, detail: w.detail, since: w.since };
  }
  return {
    parked: r.phase === 'parked',
    waiting,
    doing: typeof r.doing === 'string' ? r.doing : '',
    approval: null,
  };
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
      const handle = client.workflow.getHandle(workflowId);
      // 任务工作流（task:）答的是 taskStatus，旧的需求、子任务工作流答的是 status：按编号前缀选，别拿 status 去问任务工作流
      if (workflowId.startsWith('task:')) return taskViewOf(await handle.query(taskStatusQuery), workflowId);
      return workflowViewOf(await handle.query('status'), workflowId);
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

/**
 * 自动合并兜底那部分要的 GitHub：这里只声明它要的形状，真装配在 hourlyReconcileJob 里把
 * createGitHub 拿到的那个 GitHub 接进来。
 */
export interface AutoMergeWiringGitHub {
  claims: GitHub['claims'];
  pullFiles: GitHub['pullFiles'];
  readRepoFile: GitHub['readRepoFile'];
  deps: GitHub['deps'];
  /** 主线上读的改标准路径清单文件名；默认 packages/conventions/standard-paths.json（#242）。*/
  standardPathsFile?: string;
}
/** 默认的改标准路径清单（自动合并兜底按这份判 #242）。 */
export const STANDARD_PATHS_FILE = 'packages/conventions/standard-paths.json';

export interface HourlyReconcileWiring {
  db: Db;
  /** 和对账补漏同一个：审最近合了的 PR（镜像、合并人、合并记录）；补拉经接活那道门时现读挂在哪个版本；自动合并兜底用它列 PR、读文件、挂自动合并。 */
  gh: Pick<GitHub, 'auditMergedPrs' | 'readIssueState' | 'openIssue'> &
    Partial<Pick<GitHub, 'readGroomFacts'>> &
    AutoMergeWiringGitHub;
  trees: WorkTrees;
  exec: UserExec;
  /** 会话用户此刻挂的组织（real/session-org.ts）：判阶段派不派得出去和选路同一套，也要它。 */
  sessionOrg: SessionOrgReader;
  /** 拼车并发登记的现核（real/carpool-cap.ts，#896）：判阶段派不派得出去和选路同一套，拼车池核对不上也不算派得出去。必填，漏接过不了类型检查。 */
  carpoolRegistry: () => Promise<CarpoolRegistryView>;
  /** 这台机器给人看的名字（FLEET_MACHINE_NAME）。 */
  machine: string;
  /** GitHub 两个机器人在这些仓上的权限够不够（生产是 createGitHub 的 selfCheck）。 */
  selfCheck: GitHubAppCheckDeps['apps']['selfCheck'];
  now?: () => Date;
  log?: HourlyReconcileJobDeps['log'];
  /** 以下测试用。 */
  gitBin?: string;
  shBin?: string;
  listDir?: HourlyReconcileJobDeps['listDir'];
  stageRoutable?: HourlyReconcileJobDeps['stageRoutable'];
  /** 测试用：不给就用选路同一份事实的只读判法（store.stageAllOpen）。 */
  stageAllOpen?: HourlyReconcileJobDeps['stageAllOpen'];
  workflows?: WorkflowReader;
  inspectMax?: number;
  /** 测试用：换掉自动合并兜底那部分的 GitHub / 提醒；不给就照 wiring 的 gh 装。 */
  autoMergeGh?: AutoMergeGitHub;
  autoMergeAlerts?: HourlyReconcileJobDeps['autoMergeAlerts'];
  /** 测试用：换掉「单已关就撤任务」那部分的 Temporal / GitHub 口子；不给就用真的（问 Temporal 在跑的任务工作流、现读单状态）。 */
  closedIssueTasks?: HourlyReconcileJobDeps['closedIssueTasks'];
}

/** 发「放弃」信号最多等多久（毫秒）：到点由连接取消调用，不在本地空等。 */
const ABANDON_SIGNAL_TIMEOUT_MS = 5_000;

/**
 * 撤掉这个任务工作流还开着的挂起提醒（task:…:park:N）：标已处理，同一事务写操作记录（reason = why）。
 * 对账「单已关且停下等人」那一支用（#1816）；by 默认 engine:hourly-reconcile。
 */
export async function resolveClosedIssueParkAlerts(
  db: Db,
  workflowId: string,
  why: string,
  opts: { by?: string; at?: Date } = {},
): Promise<number> {
  const by = opts.by ?? CLOSED_ISSUE_ABANDON_BY;
  const at = opts.at ?? new Date();
  let n = 0;
  for (const row of await openAlertsByPrefix(db, `${workflowId}:park:`)) {
    const done = await resolveAlertWithReason(db, {
      dedupeKey: row.dedupeKey,
      by,
      why,
      at,
    });
    if (done === 'ok') n += 1;
  }
  return n;
}

/** 「单已关且停下等人就撤任务」的真口子（#1816）：在跑的问 Temporal，停没停着问 taskStatus，单状态现读，放弃走 taskAbandonSignal，挂起提醒当场撤。 */
function temporalClosedIssueTasks(
  client: Pick<Client, 'workflow' | 'connection'>,
  gh: Pick<GitHub, 'readIssueState'> & Partial<Pick<GitHub, 'readGroomFacts'>>,
  db: Db,
  now: () => Date,
): HourlyReconcileJobDeps['closedIssueTasks'] {
  const { readGroomFacts } = gh;
  return {
    async runningTaskWorkflowIds() {
      const ids: string[] = [];
      for await (const info of client.workflow.list({
        query: `WorkflowType = '${WORKFLOW_TYPES.task}' AND ExecutionStatus = 'Running'`,
      })) {
        ids.push(info.workflowId);
      }
      return ids;
    },
    async isParked(workflowId) {
      const handle = client.workflow.getHandle(workflowId);
      return taskViewOf(await handle.query(taskStatusQuery), workflowId).parked;
    },
    resolveParkAlerts: (workflowId, why) => resolveClosedIssueParkAlerts(db, workflowId, why, { at: now() }),
    openTaskRows: () => listOpenTaskRows(db),
    stopRows: (taskIds, reason) => stopTaskRows(db, taskIds, reason),
    async issueState(repo, issueNumber) {
      return (await gh.readIssueState({ repo, issueNumber })).state;
    },
    ...(readGroomFacts && {
      async openIssueLabels(repo: RepoRef) {
        const facts = await readGroomFacts.call(gh, { repo });
        return new Map(facts.issues.map((i) => [i.number, i.labels] as const));
      },
    }),
    async abandon(workflowId, command) {
      try {
        await client.connection.withDeadline(Date.now() + ABANDON_SIGNAL_TIMEOUT_MS, () =>
          client.workflow.getHandle(workflowId).signal(taskAbandonSignal, command),
        );
        return 'sent';
      } catch (err) {
        if (isWorkflowGone(err)) return 'gone';
        throw err;
      }
    },
  };
}

/** 给 EngineJobs.hourlyReconcile 用的工厂。 */
export function hourlyReconcileJob(
  w: HourlyReconcileWiring,
): (client: Client, taskQueue: string) => HourlyReconcileJobDeps {
  const now = w.now ?? (() => new Date());
  const log: HourlyReconcileJobDeps['log'] =
    w.log ?? ((level, text, fields) => console[level === 'info' ? 'info' : level](text, fields ?? {}));
  const store = createStorePorts({
    db: w.db,
    now,
    sessionOrg: w.sessionOrg,
    carpoolRegistry: w.carpoolRegistry,
  });
  // 和点「继续」以后选路会怎么选是同一套：全熔断时它放一条去试探，也算派得出去。这时它还会顺手把「全熔断」那条提醒
  // 再报一次（条件确实还在）。这条提醒撤不撤不在这里判，走下面的 stageAllOpen（只读，不写库、不报警）。
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
  const stageAllOpen: HourlyReconcileJobDeps['stageAllOpen'] =
    w.stageAllOpen ?? ((stage) => store.stageAllOpen(stage));
  // 受管的仓：两处核对里审合并的 PR、机器人权限自检都按这一份（库里的 repos 表）
  const managedRepos = async () =>
    (await listManagedRepos(w.db)).map((r) => ({ owner: r.owner, name: r.name }));
  // 谁在处理（24 小时再推不给有人在处理、静默了的推）：和驾驶舱同一个口子、同一份判法（原来还有提醒派单，#445 删掉了）
  const alertWork = pgAlertWork(w.db, () => deployFacts(readDeployLagInput()));
  const handling: HourlyReconcileJobDeps['handling'] = async (ids) => {
    const r = await handlingOf(alertWork, ids);
    if (!r.ok) throw new Error(r.why);
    return new Map([...r.byId].map(([id, h]) => [id, { stage: h.stage, line: h.line }]));
  };
  // 立案（#1406）：没人处理超过 24 小时的卡住报警开一张未排期的缺陷单。仓优先用提醒挂着的任务的仓，
  // 没有任务再从键和链接里认；认不出不猜。单状态的关单时刻 GitHub 这个口子不给，关了先记看见的时刻。
  const filing: HourlyReconcileJobDeps['filing'] = {
    async repoOf(alert) {
      if (alert.taskId) {
        const ctx = await taskContext(w.db, alert.taskId);
        if (ctx) return { owner: ctx.repo.owner, name: ctx.repo.name };
      }
      return alertRepoFromText(alert.dedupeKey, alert.link);
    },
    filedToday: (repo) => countAlertFilings(w.db, `${repo.owner}/${repo.name}`, beijingDayStart(now())),
    async issueState(repo, number) {
      const st = await w.gh.readIssueState({ repo, issueNumber: number });
      return { state: st.state, closedAt: null };
    },
    async openIssue(input) {
      const got = await w.gh.openIssue({
        repo: input.repo,
        key: input.key,
        title: input.title,
        body: input.body,
        labels: input.labels,
        milestone: null,
      });
      return { number: got.number };
    },
    recordFiled: (input) =>
      recordAlertFiling(w.db, {
        repo: `${input.repo.owner}/${input.repo.name}`,
        dedupeKey: input.dedupeKey,
        number: input.number,
        actorId: RECONCILE_ACTOR,
        at: now(),
      }),
  };
  // 自动合并兜底（#242）要的 GitHub：列 PR 经 claims.openPulls，把作者是不是机器人、自动合并开没开带过来；
  // 必过检查、CI 判读照和合并闸同一份 readCi / requiredChecksFor；改标准路径的清单照 main 上的 standard-paths.json 读，
  // 判法是 conventions 的 parseStandardPaths / standardFiles（认目录、通配、section）。
  const standardPathsFile = w.gh.standardPathsFile ?? STANDARD_PATHS_FILE;
  const autoMergeGh: AutoMergeGitHub = w.autoMergeGh ?? {
    async listPrs(repo: RepoRef) {
      const pulls = await w.gh.claims.openPulls(repo);
      return pulls.map((p) => ({
        number: p.number,
        nodeId: p.nodeId,
        state: p.state,
        draft: p.draft,
        authorIsBot: w.gh.claims.isAgentBot(p.author),
        autoMerge: p.autoMerge,
        headSha: p.headSha,
        headRef: p.headRef,
      }));
    },
    pullFiles: (repo: RepoRef, prNumber: number) => w.gh.pullFiles({ repo, prNumber }),
    async checksEvaluate(repo: RepoRef, sha: string, required: string[]) {
      const ci = await readCi(w.gh.deps, repo, sha, required);
      return ci.evaluation.overall;
    },
    requiredChecks: (repo: RepoRef) => requiredChecksFor(w.gh.deps, repo),
    async readStandardPathsFile(repo: RepoRef) {
      const r = await w.gh.readRepoFile({ repo, path: standardPathsFile });
      if (r.file.kind !== 'text') {
        throw new Error(
          `读 ${standardPathsFile} 没成（${r.file.kind === 'missing' ? '文件不在' : r.file.why}）`,
        );
      }
      return r.file.text;
    },
    enableAutoMerge: (repo: RepoRef, pull) => w.gh.claims.enableAutoMerge(repo, pull),
  };
  const autoMergeAlerts: HourlyReconcileJobDeps['autoMergeAlerts'] = w.autoMergeAlerts ?? {
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
    async resolve(x) {
      return resolveAlertWithReason(w.db, { dedupeKey: x.dedupeKey, by: x.by, why: x.why, at: now() });
    },
    async listOpenByPrefix(prefix) {
      const rows = await listOpenAlerts(w.db, { limit: 500 });
      return rows.alerts.filter((r) => r.dedupeKey.startsWith(prefix));
    },
  };
  return (client) => {
    return {
      root: w.trees.root,
      gh: autoMergeGh,
      autoMergeAlerts,
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
      repos: managedRepos,
      auditMergedPrs: (repo, since) => w.gh.auditMergedPrs(repo, since),
      quotaPools: (now) => quotaTable(w.db, { now }),
      // 配置写明不读的池（现在是 jev：没有日账）。读不到配置要抛，不许当成「都要读」。
      quotaNotRead: async () => (await loadQuotaConfig()).notRead?.map((p) => p.poolId) ?? [],
      ledgers: (input) => mergedPrLedgers(w.db, input),
      async approval(id) {
        const a = await getApproval(w.db, id);
        if (!a) return null;
        // 子任务发的等子任务工作流；Fusion 发的（没有子任务）等需求工作流（编号和需求工作流同一个）。这两种工作流引擎里都
        // 已经没有了：旧批准提醒查出来是「不在了」就撤，这里要继续拼旧的 req: 编号才撤得掉，不能换成 task:（任务工作流的
        // status 查询形状不同，对账读不了会一直记没查成）。#901 查出来的，随提醒对账那一整套旧读法另开单换。
        let waitingWorkflowId: string | null = a.subtaskId ? subtaskWorkflowId(a.subtaskId) : null;
        if (!a.subtaskId) {
          const task = await taskContext(w.db, a.taskId);
          waitingWorkflowId = task ? requirementWorkflowId(task.repo, task.issueNumber) : null;
        }
        return { decision: a.decision, decidedBy: a.decidedBy, waitingWorkflowId };
      },
      workflows: w.workflows ?? temporalWorkflows(client),
      closedIssueTasks: w.closedIssueTasks ?? temporalClosedIssueTasks(client, w.gh, w.db, now),
      stageRoutable,
      stageAllOpen,
      handling,
      filing,
      // 历史事实类（reconcile:pr、reconcile:ledger）要合并时刻才知道该不该跳过。镜像没写上再问 GitHub；都没有就抛，上面记没查成、不跳过。
      prMergedAt: async (repo, number) => {
        const mirrored = await pullMergedAt(w.db, repo.owner, repo.name, number);
        if (mirrored) return mirrored;
        const pr = await readPull(w.gh.deps, repo, number, 'engine');
        if (!pr.merged_at) throw new Error(`${repo.owner}/${repo.name}#${number} 没有合并时刻`);
        const at = new Date(pr.merged_at);
        if (!Number.isFinite(at.getTime())) {
          throw new Error(`${repo.owner}/${repo.name}#${number} 的合并时刻认不出`);
        }
        return at;
      },
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
      apps: {
        repos: managedRepos,
        selfCheck: (repos) => w.selfCheck(repos),
      },
      runs: {
        start: (job, at) => startScheduleRun(w.db, job, at),
        finish: (id, result, at) => finishScheduleRun(w.db, id, result, at),
      },
      poolHoldPush: () =>
        pushOverduePoolHolds({
          now,
          readSetting: () => readPoolHoldsSetting(w.db),
          sentBody: async (key) => (await alertByKey(w.db, key))?.body ?? null,
          markSent: async (x) => {
            await upsertAlert(w.db, {
              dedupeKey: x.dedupeKey,
              level: 'daily',
              taskId: null,
              title: x.title,
              body: x.body,
              link: x.link,
            });
          },
          send: feishuWebhookSender({ env: process.env }),
        }),
      mainRedPush: () =>
        pushMainRed({
          listPushRuns: mainCiRuns({ client: w.gh.deps.client }),
          previousVerdict: async () => {
            const [stored, red, recovered] = await Promise.all([
              alertByKey(w.db, MAIN_CI_VERDICT_KEY),
              latestAlertByPrefix(w.db, MAIN_RED_KEY_PREFIX),
              latestAlertByPrefix(w.db, MAIN_RECOVERED_KEY_PREFIX),
            ]);
            return storedMainCiVerdict(stored?.body, red, recovered);
          },
          sentBody: async (key) => (await alertByKey(w.db, key))?.body ?? null,
          markSent: async (x) => {
            await upsertAlert(w.db, {
              dedupeKey: x.dedupeKey,
              level: 'daily',
              taskId: null,
              title: x.title,
              body: x.body,
              link: x.link,
            });
          },
          rememberVerdict: async (x) => {
            await upsertAlert(w.db, {
              dedupeKey: MAIN_CI_VERDICT_KEY,
              level: 'daily',
              taskId: null,
              title: mainCiVerdictTitle(x.verdict),
              body: x.verdict,
              link: x.link,
            });
          },
          send: feishuWebhookSender({ env: process.env }),
        }),
      now,
      log,
      ...(w.inspectMax === undefined ? {} : { inspectMax: w.inspectMax }),
    };
  };
}
