// 每小时对账（design 第六节「断链怎么被发现」第 4 层）：一轮 = 记下开始 → 工作树（jobs/worktree-sweep.ts：没有在跑的任务
// 在用的树，什么都不剩的删掉，剩着没推的东西的报要人拍）→ 两处核对（jobs/reconcile-checks.ts：开着的单都有着落、合了的
// PR 都记了账；额度读数那处等 #76）→ 提醒（jobs/alert-sweep.ts：条件没了的撤掉、卡住报警超过 24 小时没人处理的再推一次）
// → 结局记进 schedule_runs。核对在提醒之前：新报的提醒这一轮还不满 24 小时，不会被再推。
// scanned = 看了几个对象（树、探针目录、接活开着的项目里没结束的单、审到的合并 PR、对上单的合并 PR、没处理的提醒），
// found = 处理了几个问题（删掉的树、改成要人拍的树、补拉的和没着落的单、合并 PR 对上的问题、记账不全的 PR、撤掉的过时
// 提醒、再推的提醒）。一部分没跑成、
// 只查了一部分，照实记 failed / partial，写明哪里没查成；不记成 ok（没跑成 ≠ 没问题）。
import type { AlertRow, ScheduleResult } from '@fleet-dao/db';
import type { HourlyReconcileRun } from '../contract.ts';
import { type AlertSweepDeps, sweepAlerts } from './alert-sweep.ts';
import type { ScheduleRunLog } from './github-reconcile.ts';
import { checkLedgers, checkMergedPrs, checkWorkflows, type ReconcileCheckDeps } from './reconcile-checks.ts';
import { clip, message, type SweepPart } from './reconcile-common.ts';
import { sweepWorktrees, type WorktreeSweepDeps } from './worktree-sweep.ts';

/** 登记进 scheduled_jobs 的那一行：一次都没跑过也列得出来。 */
export const HOURLY_RECONCILE_JOB = {
  id: 'hourly-reconcile',
  name: '每小时对账（工作树、工作流、PR 记账、提醒）',
  schedule: '每小时（41 分）',
  // 漏一轮不报，连着两轮没跑成才算过期。
  expectEveryMinutes: 150,
} as const;

export const HOURLY_RECONCILE_EVERY_MINUTES = 60;
/** 和对账补漏（整点起每 15 分钟）、路由探针（7、22、37、52 分）错开。 */
export const HOURLY_RECONCILE_OFFSET_MINUTES = 41;
/** 一轮最多看多少条没处理的提醒（多出来的照实记没看全）。 */
export const OPEN_ALERT_LIMIT = 500;
/** why 最长多少字：没查成的一条一句，太多了截断（总数照写）。 */
export const WHY_MAX = 1500;

export type HourlyReconcileJobDeps = WorktreeSweepDeps &
  AlertSweepDeps &
  ReconcileCheckDeps & {
    runs: ScheduleRunLog;
  };

/** 这一轮没跑成：结局已经记进 schedule_runs，活动照样报失败，Temporal 里也看得见。 */
export class HourlyReconcileFailedError extends Error {
  readonly runId: number;
  constructor(runId: number, message: string) {
    super(message);
    this.name = 'HourlyReconcileFailedError';
    this.runId = runId;
  }
}

/** 几部分的结局并成这一轮的：都没跑成、或没跑成的那部分之外一个都没看到是 failed；有没跑成、没查成的是 partial。 */
export function combineParts(parts: readonly SweepPart[]): ScheduleResult {
  const failed = parts.flatMap((p) => (p.failed ? [p.failed] : []));
  const unchecked = parts.flatMap((p) => p.unchecked);
  const scanned = parts.reduce((n, p) => n + p.scanned, 0);
  const found = parts.reduce((n, p) => n + p.found, 0);
  const notes = [...failed, ...unchecked];
  const why = clip(`${notes.length > 1 ? `${notes.length} 处没查成：` : ''}${notes.join('；')}`, WHY_MAX);
  if (failed.length > 0 && (failed.length === parts.length || scanned === 0)) {
    return { outcome: 'failed', why, scanned, found };
  }
  if (notes.length > 0) return { outcome: 'partial', why, scanned, found };
  if (scanned === 0) {
    return {
      outcome: 'unscanned',
      why: '工作树的根下什么都没有，接活开着的项目里没有没结束的单，没有要审的合并 PR，也没有没处理的提醒',
    };
  }
  return { outcome: 'ok', scanned, found };
}

async function listOpen(deps: HourlyReconcileJobDeps): Promise<{ alerts: AlertRow[]; truncated: boolean }> {
  return deps.alerts.listOpen(OPEN_ALERT_LIMIT);
}

async function round(deps: HourlyReconcileJobDeps): Promise<ScheduleResult> {
  // 工作树先跑（它撤的「工作树没收掉」，提醒那部分就不再为它再推）；两部分各列一次没处理的提醒
  let before: AlertRow[] | null = null;
  try {
    before = (await listOpen(deps)).alerts;
  } catch (err) {
    deps.log('warn', '每小时对账：列没处理的提醒没成，工作树照删，和树有关的提醒留到下一轮撤', {
      error: message(err),
    });
  }
  const trees = await sweepWorktrees(deps, before);
  // 核对在提醒之前：这一轮新报的还不满 24 小时，提醒那部分不会再推它们
  const workflows = await checkWorkflows(deps);
  const merged = await checkMergedPrs(deps);
  const ledgers = await checkLedgers(deps);
  let alerts: SweepPart;
  try {
    const now = await listOpen(deps);
    alerts = await sweepAlerts(deps, now.alerts, now.truncated);
  } catch (err) {
    alerts = { failed: `列没处理的提醒没成：${message(err)}`, scanned: 0, found: 0, unchecked: [] };
  }
  return combineParts([trees, workflows, merged, ledgers, alerts]);
}

/**
 * 跑一轮。记开始就失败（库连不上、没登记）：原样抛出，这一轮在库里没有记录——登记表上它会过期，看门狗照样看得见。
 * 没跑成：记成 failed 再抛 HourlyReconcileFailedError。记结局失败：原样抛出。
 */
export async function runHourlyReconcileJob(deps: HourlyReconcileJobDeps): Promise<HourlyReconcileRun> {
  const runId = await deps.runs.start(HOURLY_RECONCILE_JOB.id, deps.now());
  let result: ScheduleResult;
  try {
    result = await round(deps);
  } catch (err) {
    result = { outcome: 'failed', why: `每小时对账没跑成：${message(err)}` };
  }
  await deps.runs.finish(runId, result, deps.now());
  const run: HourlyReconcileRun = {
    runId,
    outcome: result.outcome,
    scanned: result.outcome === 'unscanned' ? 0 : (result.scanned ?? 0),
    found: result.outcome === 'unscanned' ? 0 : (result.found ?? 0),
    ...('why' in result ? { why: result.why } : {}),
  };
  const fields = { runId, outcome: run.outcome, scanned: run.scanned, found: run.found, why: run.why };
  if (run.outcome === 'failed') {
    deps.log('error', '每小时对账这一轮没跑成', fields);
    throw new HourlyReconcileFailedError(runId, run.why ?? '每小时对账没跑成');
  }
  if (run.outcome === 'ok') deps.log('info', '每小时对账跑完了', fields);
  else deps.log('warn', '每小时对账这一轮没查全', fields);
  return run;
}
