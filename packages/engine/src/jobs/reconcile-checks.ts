// 每小时对账的三处核对（design 第六节第 4 层）：开着的单都有工作流、合了的 PR 都记了账、额度读数不超过 30 分钟。
// 各返回一个 SweepPart，由 hourly-reconcile 的 combineParts 并进这一轮。提醒自己报、自己撤，不进 alert-sweep 的判法表。
// 不自动重起工作流：重起会和残留的会话、分支撞，要人判。镜像没记成已合并可以补，补了写日志、不报警。
import {
  type ActiveTaskRef,
  QUOTA_STALE_AFTER_MS,
  type ReconcileRepoRef,
  TERMINAL_TASK_STATES,
} from '@fleet-dao/db';
import type { TaskState } from '@fleet-dao/shared';
import { requirementWorkflowId } from '@fleet-dao/shared/workflow-ids';
import { duration } from '../routing/names.ts';
import type { AlertSweepDeps } from './alert-sweep.ts';
import {
  clip,
  message,
  notRunningWords,
  RECONCILE_ACTOR,
  type SweepPart,
  stamp,
  type WorkflowState,
} from './reconcile-common.ts';

/** 和提醒对账里的状态说法同一套（jobs/alert-sweep.ts 的 TASK_STATE_WORDS）。 */
const TASK_STATE_WORDS: Readonly<Record<TaskState, string>> = {
  queued: '排队中',
  triaging: '分诊中',
  asking: '在等人回答',
  planning: '写方案中',
  running: '在干',
  merging: '在合并',
  done: '做完了',
  stopped: '人叫停了',
  failed: '没做完',
  stalled: '停滞',
};

/** 开着的单没有在跑的工作流。后面是任务编号。 */
export const WORKFLOW_ALERT_PREFIX = 'reconcile:workflow:';
/**
 * 工作流刚收尾、库里的状态还没写上的那一下：单在这之内更新过，不报、也不撤旧的。
 * 再短会把正常收尾报出来，再长会把真断了的单多瞒一阵。
 */
export const WORKFLOW_QUIET_MS = 10 * 60_000;
/** 额度读数过期，所有池汇成这一条。 */
export const QUOTA_ALERT_KEY = 'reconcile:quota-stale';
/** 每小时一轮，往回看 26 小时：漏一轮也补得回最近一天里合的。 */
export const MERGED_PR_LOOKBACK_MS = 26 * 60 * 60_000;
/** 和 hourly-reconcile 的 OPEN_ALERT_LIMIT 同一个上限：多出来的照实记没看全，不当成没有。 */
const ALERT_LIST_LIMIT = 500;

export function prAlertKey(owner: string, name: string, number: number): string {
  return `reconcile:pr:${owner}/${name}#${number}`;
}

/** 合并 PR 对账的结果，和 @fleet-dao/github 的 AuditReport 同形（这里不引那个包）。 */
export interface MergedPrAudit {
  outcome: 'ok' | 'partial' | 'unscanned';
  scanned: number;
  found: number;
  fixed: number;
  problems: string[];
  why?: string | undefined;
}

/** 额度表里这一处要的几列（quotaTable 的行多出来的字段不用）。 */
export interface QuotaPoolRead {
  poolId: string;
  channelName: string;
  channelEnabled: boolean;
  lastReadOkAt: Date | null;
  dataAt: Date | null;
  neverRead: boolean;
  readOverdue: boolean;
}

export interface ReconcileCheckDeps
  extends Pick<AlertSweepDeps, 'workflows' | 'taskState' | 'alerts' | 'now' | 'log'> {
  activeTasks(): Promise<ActiveTaskRef[]>;
  repos(): Promise<ReconcileRepoRef[]>;
  auditMergedPrs(repoFullName: string, since: Date): Promise<MergedPrAudit>;
  quotaPools(): Promise<readonly QuotaPoolRead[]>;
}

const empty = (): SweepPart => ({ scanned: 0, found: 0, unchecked: [] });

const terminal = new Set<string>(TERMINAL_TASK_STATES);

function recentlyTouched(updatedAt: Date | null, now: Date): boolean {
  return updatedAt !== null && now.getTime() - updatedAt.getTime() < WORKFLOW_QUIET_MS;
}

function workflowKey(taskId: string): string {
  return `${WORKFLOW_ALERT_PREFIX}${taskId}`;
}

/** 库里没结束、也不在排队的单，需求工作流不在跑就报；又在跑、结束、回到排队、库里没了就撤。 */
export async function checkWorkflows(deps: ReconcileCheckDeps): Promise<SweepPart> {
  const part = empty();
  let tasks: ActiveTaskRef[];
  try {
    tasks = await deps.activeTasks();
  } catch (err) {
    return { ...part, failed: `列没结束的单没成：${message(err)}` };
  }
  const now = deps.now();
  /** 这一轮查成了且没事：值是撤的时候写的原因。 */
  const clear = new Map<string, string>();
  /** 报了、问失败、或还在 10 分钟的窗口里：旧提醒留着。 */
  const hold = new Set<string>();

  for (const task of tasks) {
    part.scanned += 1;
    const where = `${task.owner}/${task.name}#${task.issueNumber}`;
    if (task.state === 'queued') {
      clear.set(task.taskId, '这张单在排队，没派是有意的，不要求已经有工作流');
      continue;
    }
    const wf = requirementWorkflowId({ owner: task.owner, name: task.name }, task.issueNumber);
    let st: WorkflowState;
    try {
      st = await deps.workflows.state(wf);
    } catch (err) {
      hold.add(task.taskId);
      part.unchecked.push(`${where} 的工作流没问成：${message(err)}`);
      continue;
    }
    if (st.state === 'running') {
      clear.set(task.taskId, '需求工作流又在跑了');
      continue;
    }
    if (recentlyTouched(task.updatedAt, now)) {
      hold.add(task.taskId);
      continue;
    }
    const dedupeKey = workflowKey(task.taskId);
    const title = clip(`开着的单没有在跑的工作流：${where}`, 300);
    const body = [
      `库里这张单是「${TASK_STATE_WORDS[task.state]}」。${notRunningWords(st)}。`,
      '不自动重起：重起会和残留的会话、分支撞，要人看。',
    ].join('\n');
    try {
      await deps.alerts.raise({
        dedupeKey,
        level: 'alert',
        taskId: task.taskId,
        title,
        body,
        link: `https://github.com/${task.owner}/${task.name}/issues/${task.issueNumber}`,
      });
      part.found += 1;
      deps.log('info', '每小时对账：开着的单没有在跑的工作流', { taskId: task.taskId, issue: where });
    } catch (err) {
      part.unchecked.push(`${where} 没有在跑的工作流，报提醒没报成：${message(err)}`);
    }
    hold.add(task.taskId);
  }

  let open: { dedupeKey: string }[];
  try {
    const listed = await deps.alerts.listOpen(ALERT_LIST_LIMIT);
    open = listed.alerts;
    if (listed.truncated) {
      part.unchecked.push(`没处理的提醒太多，工作流核对这一轮只看了前 ${open.length} 条，没看到的不撤`);
    }
  } catch (err) {
    part.unchecked.push(`列没处理的提醒没成，工作流核对的旧提醒这一轮不撤：${message(err)}`);
    return part;
  }

  const active = new Set(tasks.map((t) => t.taskId));
  for (const alert of open) {
    if (!alert.dedupeKey.startsWith(WORKFLOW_ALERT_PREFIX)) continue;
    const taskId = alert.dedupeKey.slice(WORKFLOW_ALERT_PREFIX.length);
    if (hold.has(taskId)) continue;
    let why = clear.get(taskId);
    if (!why) {
      if (active.has(taskId)) continue;
      try {
        const state = await deps.taskState(taskId);
        if (state !== null && state !== 'queued' && !terminal.has(state)) {
          part.unchecked.push(`提醒 ${alert.dedupeKey} 对上的单还没结束，这一轮的清单里却没有，不撤`);
          continue;
        }
        why =
          state === null
            ? '库里没有这张单了'
            : state === 'queued'
              ? '这张单回到排队了，没派是有意的'
              : `这张单已经结束了（${TASK_STATE_WORDS[state]}）`;
      } catch (err) {
        part.unchecked.push(`提醒 ${alert.dedupeKey} 对上的单读不了，不撤：${message(err)}`);
        continue;
      }
    }
    try {
      const r = await deps.alerts.resolve({ dedupeKey: alert.dedupeKey, by: RECONCILE_ACTOR, why });
      if (r === 'ok') {
        part.found += 1;
        deps.log('info', '每小时对账：撤了一条提醒', { dedupeKey: alert.dedupeKey, why });
      }
    } catch (err) {
      part.unchecked.push(`提醒 ${alert.dedupeKey} 没撤成：${message(err)}`);
    }
  }
  return part;
}

interface Classified {
  fixed: string[];
  failed: string[];
  /** 认不出的句子：不当成没事，写进 unchecked。 */
  odd: string[];
  alerts: Map<number, string[]>;
}

function classifyProblems(problems: readonly string[]): Classified {
  const fixed: string[] = [];
  const failed: string[] = [];
  const odd: string[] = [];
  const alerts = new Map<number, string[]>();
  for (const p of problems) {
    if (p.includes('没查成')) {
      failed.push(p);
      continue;
    }
    if (p.includes('（已补）')) {
      fixed.push(p);
      continue;
    }
    const n = /^#(\d+)\s/.exec(p)?.[1];
    if (!n) {
      odd.push(p);
      continue;
    }
    const number = Number(n);
    const list = alerts.get(number) ?? [];
    list.push(p);
    alerts.set(number, list);
  }
  return { fixed, failed, odd, alerts };
}

/** 每个受管的仓，最近 26 小时合了的 PR：镜像补上算发现；没补上的按 PR 报一条，不自动撤。 */
export async function checkMergedPrs(deps: ReconcileCheckDeps): Promise<SweepPart> {
  const part = empty();
  let repos: ReconcileRepoRef[];
  try {
    repos = await deps.repos();
  } catch (err) {
    return { ...part, failed: `列受管的仓没成：${message(err)}` };
  }
  const since = new Date(deps.now().getTime() - MERGED_PR_LOOKBACK_MS);
  for (const repo of repos) {
    const slug = `${repo.owner}/${repo.name}`;
    let report: MergedPrAudit;
    try {
      report = await deps.auditMergedPrs(slug, since);
    } catch (err) {
      part.unchecked.push(`${slug} 审合并的 PR 没做成：${message(err)}`);
      continue;
    }
    part.scanned += report.scanned;
    part.found += report.found;
    const { fixed, failed, odd, alerts } = classifyProblems(report.problems);
    if (fixed.length > 0) {
      deps.log('info', '每小时对账：合并的 PR 镜像补记成已合并', {
        repo: slug,
        fixed: report.fixed,
        problems: fixed.slice(0, 5),
      });
    }
    if (report.outcome === 'unscanned') {
      part.unchecked.push(`${slug}：${report.why ?? '合并的 PR 这次没查成'}`);
    } else if (report.outcome === 'partial' || failed.length > 0) {
      const detail = failed.length > 0 ? failed.join('；') : (report.why ?? '有的没查成');
      part.unchecked.push(`${slug} 合并的 PR 没查全：${detail}`);
    }
    if (odd.length > 0) part.unchecked.push(`${slug} 有认不出的对账结果：${odd.join('；')}`);
    for (const [number, lines] of alerts) {
      const dedupeKey = prAlertKey(repo.owner, repo.name, number);
      try {
        await deps.alerts.insertOnce({
          dedupeKey,
          level: 'alert',
          taskId: null,
          title: clip(`合并的 PR 记账对不上：${slug}#${number}`, 300),
          body: lines.join('\n'),
          link: `https://github.com/${slug}/pull/${number}`,
        });
        deps.log('info', '每小时对账：合并的 PR 记账对不上', { dedupeKey });
      } catch (err) {
        part.unchecked.push(`${dedupeKey} 没报成：${message(err)}`);
      }
    }
  }
  return part;
}

function poolLine(pool: QuotaPoolRead, now: Date): string {
  const name = `${pool.channelName} / ${pool.poolId}`;
  const frozen =
    pool.dataAt !== null && now.getTime() - pool.dataAt.getTime() > QUOTA_STALE_AFTER_MS
      ? `；上游数据冻住了（数据时刻北京时间 ${stamp(pool.dataAt)}）`
      : '';
  if (pool.neverRead || pool.lastReadOkAt === null) return `${name}：从没读成过${frozen}`;
  const age = duration(now.getTime() - pool.lastReadOkAt.getTime());
  return `${name}：上次读成在北京时间 ${stamp(pool.lastReadOkAt)}（${age}前）${frozen}`;
}

/** 启用渠道下 readOverdue 的池汇成一条；一个都不过期就撤。读不了额度表，这一部分算没跑成。 */
export async function checkQuotas(deps: ReconcileCheckDeps): Promise<SweepPart> {
  const part = empty();
  let pools: readonly QuotaPoolRead[];
  try {
    pools = await deps.quotaPools();
  } catch (err) {
    return { ...part, failed: `读额度表没成：${message(err)}` };
  }
  const now = deps.now();
  const enabled = pools.filter((p) => p.channelEnabled);
  part.scanned = enabled.length;
  const overdue = enabled.filter((p) => p.readOverdue);
  if (overdue.length === 0) {
    try {
      const r = await deps.alerts.resolve({
        dedupeKey: QUOTA_ALERT_KEY,
        by: RECONCILE_ACTOR,
        why: '启用的渠道下，账号池的额度读数都在 30 分钟以内',
      });
      if (r === 'ok') {
        part.found += 1;
        deps.log('info', '每小时对账：撤了一条提醒', { dedupeKey: QUOTA_ALERT_KEY });
      }
    } catch (err) {
      part.unchecked.push(`额度读数都新了，撤提醒没撤成：${message(err)}`);
    }
    return part;
  }
  const body = [
    '启用的渠道下，这些账号池的额度读数过期了（从没读成、上次读成超过 30 分钟，或上游数据 30 分钟没前进）：',
    ...overdue.map((p) => `- ${poolLine(p, now)}`),
    '和驾驶舱、选路用的是同一个判法。都新了这条自己撤。',
  ].join('\n');
  try {
    await deps.alerts.raise({
      dedupeKey: QUOTA_ALERT_KEY,
      level: 'alert',
      taskId: null,
      title: '有账号池的额度读数超过 30 分钟没更新',
      body,
    });
    part.found += overdue.length;
    deps.log('info', '每小时对账：有账号池的额度读数过期了', { pools: overdue.map((p) => p.poolId) });
  } catch (err) {
    part.unchecked.push(`额度读数过期，报提醒没报成：${message(err)}`);
  }
  return part;
}
