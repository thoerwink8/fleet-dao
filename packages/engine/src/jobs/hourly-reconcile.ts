// 每小时对账（design 第六节「断链怎么被发现」第 4 层）：一轮 = 记下开始 → 工作树（jobs/worktree-sweep.ts：没有在跑的任务
// 在用的树，什么都不剩的删掉，剩着没推的东西的报要人拍）→ 核对（jobs/reconcile-checks.ts：合了的
// PR 都记了账、贴了「本机做」超过 24 小时又没租约的写成一份名单、撤掉随 Fusion 删了的那一处核对留下的旧提醒；额度读数那处等 #76）→ 提醒（jobs/alert-sweep.ts：条件没了的撤掉、卡住报警超过 24 小时没人处理的再推一次、同一条立案）
// → 单已关且停着等人、或已在检查点软暂停且没有开着会话的，发放弃信号并撤挂起提醒（jobs/closed-issue-tasks.ts，#1198 / #1816 / #3002）
// → GitHub 两个机器人的权限自检（jobs/github-app-check.ts：缺的、没查成的报提醒，好了自己撤）
// → 整池暂停到期的飞书（jobs/pool-hold-push.ts：没配、没推成记没查成，不当成推过；不给 poolHoldPush 的单测这一项跳过）
// → 主线红的飞书（jobs/main-red-push.ts：变红推一次、转绿推已恢复；没配、没推成、运行列表读不到记没查成，不当成推过；不给 mainRedPush 的单测这一项跳过）
// → 结局记进 schedule_runs。
// 核对在提醒之前：它新报的提醒这一轮还不满 24 小时，不会被再推；权限自检放最后：它新报、撤的提醒这一轮提醒那部分不再碰。
// scanned = 看了几个对象（树、探针目录、审到的合并 PR、对上单的合并 PR、没处理的提醒、
// 机器人 × 仓），found = 处理了几个问题（删掉的树、改成要人拍的树、合并 PR 对上的问题、记账不全的
// PR、撤掉的过时提醒、再推的提醒、立的单、权限不对的和撤掉的权限提醒）。一部分没跑成、只查了一部分，照实记 failed / partial，
// 写明哪里没查成；不记成 ok（没跑成 ≠ 没问题）。
// 每个必经子步骤经现有 deps.log 记同一轮 runId、稳定步骤名、开始/结束/失败和耗时。还在等的那一步只有开始、
// 没有结束，最后一条就能对上卡在哪；不另起探针、轮询、告警或落库。这只补在途证据，不表示现机超时已经恢复。

import type { AlertRow, LocalOrphan, ScheduleResult } from '@fleet-dao/db';
import type { WorktreeInventory } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { HourlyReconcileRun } from '../contract.ts';
import { type AlertSweepDeps, sweepAlerts } from './alert-sweep.ts';
import { type AutoMergeCheckDeps, checkAutoMerges } from './auto-merge-check.ts';
import {
  abandonClosedIssueTasks,
  type ClosedIssueTaskDeps,
  settleIdleClosedIssueRows,
} from './closed-issue-tasks.ts';
import {
  checkGitHubApps,
  type GitHubAppCheckDeps,
  reposKnownNotInstalled,
  skippedReposNote,
} from './github-app-check.ts';
import type { ScheduleRunLog, ScheduleRunProgressPhase } from './github-reconcile.ts';
import { type MergedTaskClosureDeps, settleMergedTasks } from './merged-task-closure.ts';
import {
  checkLedgers,
  checkLocalOrphans,
  checkMergedPrs,
  type LocalLabeledIssue,
  type ReconcileCheckDeps,
  retireHistoricalFactAlerts,
  retireWorkflowAlerts,
} from './reconcile-checks.ts';
import { clip, type SweepPart } from './reconcile-common.ts';
import { inventoryOf } from './worktree-cleanup.ts';
import { sweepWorktrees, type WorktreeSweepDeps } from './worktree-sweep.ts';

/** 登记进 scheduled_jobs 的那一行：一次都没跑过也列得出来。 */
export const HOURLY_RECONCILE_JOB = {
  id: 'hourly-reconcile',
  name: '每小时对账（工作树、PR 记账、提醒、GitHub 机器人权限）',
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

/**
 * 一轮实际往下走的子步骤，顺序就是执行顺序（和最后 combineParts 的数组顺序不是同一件事）。
 * 名字稳定，只出现在在途日志里，不随说明文案改。
 */
export const HOURLY_RECONCILE_STEPS = [
  'alerts-before-worktrees',
  'worktrees',
  'pending-cleanup',
  'save-inventory',
  'retire-workflow-alerts',
  'known-not-installed',
  'merged-prs',
  'ledgers',
  'local-orphans',
  'historical-facts',
  'auto-merges',
  'merged-tasks',
  'closed-issue-tasks',
  'idle-closed-rows',
  'open-alerts',
  'alert-sweep',
  'github-apps',
  'pool-hold-push',
  'main-red-push',
] as const;

export type HourlyReconcileStep = (typeof HOURLY_RECONCILE_STEPS)[number];

/** 没把依赖接上就整步跳过（单测外壳可以不给；真装配会给）。跳过只记一笔，不算开始，也不算跑完。 */
export const HOURLY_RECONCILE_OPTIONAL_STEPS = [
  'pending-cleanup',
  'save-inventory',
  'pool-hold-push',
  'main-red-push',
] as const satisfies readonly HourlyReconcileStep[];

export type HourlyReconcileJobDeps = WorktreeSweepDeps &
  AlertSweepDeps &
  ReconcileCheckDeps &
  AutoMergeCheckDeps &
  ClosedIssueTaskDeps &
  MergedTaskClosureDeps &
  Pick<GitHubAppCheckDeps, 'apps'> & {
    runs: ScheduleRunLog;
    /**
     * 整池暂停到了复查日期就往飞书推一条。不给 = 这一轮不推（单测外壳）；真装配总会给。
     * 没推成由它自己记进 unchecked，不许记成推过。
     */
    poolHoldPush?: () => Promise<SweepPart>;
    /**
     * 主线 ci.yml 变红就往飞书推一条，转绿推「已恢复」。不给 = 这一轮不推（单测外壳）；真装配总会给。
     * 没推成由它自己记进 unchecked，不许记成推过。
     */
    mainRedPush?: () => Promise<SweepPart>;
    /**
     * 工作树这一部分看完存一份清单（#1993，资源页「仓库」一段读它）。不给 = 这一轮不存（单测外壳）；真装配总会给。
     * 存不进记进 unchecked，不许当成存了。
     */
    saveInventory?: (inventory: WorktreeInventory) => Promise<void>;
    pendingCleanup?: () => Promise<Record<string, unknown>[]>;
    /**
     * 贴着「本机做」的开着的单（含标签时间线和评论）。三个都给才核；一个都不给就跳过（单测外壳）。
     * 只给了一部分记没查成，不当成「没有没人领的」。
     */
    localLabeled?: () => Promise<LocalLabeledIssue[]>;
    /** 还没到期的本机租约，键是 `owner/name#单号`。 */
    activeLeases?: () => Promise<Set<string>>;
    /** 把没人领的名单整份换上。读不到单就不许调它。 */
    saveLocalOrphans?: (items: readonly LocalOrphan[]) => Promise<void>;
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
  const info = parts.flatMap((p) => p.notes ?? []);
  const why = clip(
    [`${notes.length > 1 ? `${notes.length} 处没查成：` : ''}${notes.join('；')}`, ...info]
      .filter(Boolean)
      .join('；'),
    WHY_MAX,
  );
  if (failed.length > 0 && (failed.length === parts.length || scanned === 0)) {
    return { outcome: 'failed', why, scanned, found };
  }
  if (notes.length > 0) return { outcome: 'partial', why, scanned, found };
  if (scanned === 0) {
    return {
      outcome: 'unscanned',
      why: '工作树的根下什么都没有，没有要审的合并 PR，没有没处理的提醒，也没有受管的仓',
    };
  }
  return info.length > 0 ? { outcome: 'ok', scanned, found, why } : { outcome: 'ok', scanned, found };
}

async function listOpen(deps: HourlyReconcileJobDeps): Promise<{ alerts: AlertRow[]; truncated: boolean }> {
  return deps.alerts.listOpen(OPEN_ALERT_LIMIT);
}

/** 只跳过「明确没装」这一种：列仓或读提醒出错，一个都不跳（照旧去读、读不成照旧记没查成）。 */
async function knownNotInstalled(deps: HourlyReconcileJobDeps): Promise<{ slugs: Set<string> }> {
  try {
    const repos = await deps.apps.repos();
    return { slugs: await reposKnownNotInstalled(repos, (key) => deps.alerts.byKey(key)) };
  } catch (err) {
    deps.log('warn', '每小时对账：查不出哪些仓已知没装机器人，这一轮一个都不跳', { error: errMessage(err) });
    return { slugs: new Set() };
  }
}

/** 三个口子齐了才核没人领的「本机做」；一个都没接就跳过；只接了一部分记没查成。 */
async function localOrphanPart(deps: HourlyReconcileJobDeps): Promise<SweepPart> {
  const wired = [deps.localLabeled, deps.activeLeases, deps.saveLocalOrphans].filter(Boolean).length;
  if (wired === 0) return { scanned: 0, found: 0, unchecked: [] };
  if (wired < 3 || !deps.localLabeled || !deps.activeLeases || !deps.saveLocalOrphans) {
    return {
      scanned: 0,
      found: 0,
      unchecked: ['本机没人领的核对没接全（读单、租约、写名单要一起给）'],
    };
  }
  return checkLocalOrphans({
    now: deps.now,
    log: deps.log,
    localLabeled: deps.localLabeled,
    activeLeases: deps.activeLeases,
    saveLocalOrphans: deps.saveLocalOrphans,
  });
}

function skipRepos<T extends { owner: string; name: string }>(
  repos: () => Promise<T[]>,
  skip: ReadonlySet<string>,
): () => Promise<T[]> {
  return async () => (await repos()).filter((r) => !skip.has(`${r.owner}/${r.name}`));
}

type StepPhase = 'start' | 'end' | 'failed' | 'skip';

/** 只认本文件这些步骤回的失败部分。别的返回值（列提醒、跳过的仓）没有 failed，不算这一步失败。 */
function returnedFailure(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.failed === 'string' &&
    row.failed !== '' &&
    Array.isArray(row.unchecked) &&
    typeof row.scanned === 'number'
  );
}

function durationMs(deps: HourlyReconcileJobDeps, started: number): number | undefined {
  const ms = deps.now().getTime() - started;
  return Number.isSafeInteger(ms) && ms >= 0 ? ms : undefined;
}

/**
 * 在途证据只带运行编号、步骤名、阶段和耗时。不写命令行、环境、令牌、凭据路径，也不把原始返回值塞进日志。
 * 开始在 await 之前记：这一步还不回来时，最后一条就是它，后面的步骤还没有开始。
 */
async function markStep(
  deps: HourlyReconcileJobDeps,
  runId: number,
  step: string,
  phase: StepPhase,
  ms?: number,
  persistOnly = false,
): Promise<void> {
  // 见证只是诊断：写不进不能让这一步（或它真正的报错）变样，记一条日志；这一行的见证停在上一笔，不假装更新过
  try {
    await deps.runs.progress?.(runId, { step, phase: phase as ScheduleRunProgressPhase }, deps.now());
  } catch (err) {
    deps.log('warn', `每小时对账：子步骤 ${step} 的持久阶段见证没写进 schedule_runs`, {
      runId,
      step,
      phase,
      error: errMessage(err),
    });
  }
  // 工作树里的子调用只写持久见证：控制台那条步骤轨迹（上面的必经步骤）保持原样，不被每棵树每条命令灌满
  if (persistOnly) return;
  const word =
    phase === 'start' ? '开始' : phase === 'end' ? '结束' : phase === 'failed' ? '失败' : '缺省跳过';
  const fields: Record<string, unknown> = { runId, step, phase };
  if (ms !== undefined) fields.ms = ms;
  deps.log(phase === 'failed' ? 'error' : 'info', `每小时对账：子步骤 ${step} ${word}`, fields);
}

async function runStep<T>(
  deps: HourlyReconcileJobDeps,
  runId: number,
  step: string,
  fn: () => Promise<T>,
  persistOnly = false,
): Promise<T> {
  await markStep(deps, runId, step, 'start', undefined, persistOnly);
  const started = deps.now().getTime();
  try {
    const value = await fn();
    await markStep(
      deps,
      runId,
      step,
      returnedFailure(value) ? 'failed' : 'end',
      durationMs(deps, started),
      persistOnly,
    );
    return value;
  } catch (err) {
    await markStep(deps, runId, step, 'failed', durationMs(deps, started), persistOnly);
    throw err;
  }
}

async function skipStep(
  deps: HourlyReconcileJobDeps,
  runId: number,
  step: HourlyReconcileStep,
): Promise<void> {
  await markStep(deps, runId, step, 'skip');
}

/**
 * 工作树这一步里每个会碰外部（子进程、磁盘、库）的调用各留开始/结束/失败的持久见证，步骤名 worktrees.<调用>.<相对根的树>。
 * 33304 这类只停在 worktrees 开始、看不出卡在哪棵树的哪条命令：最后一笔只有开始的，就是还没回来的那一个。
 * 只包一层、不改返回值和报错，也不碰 sweepWorktrees 的判据；步骤名只含相对路径（规整成库里认的字符、截到 128）。
 * 这只补在途证据，不证明原中断根因。
 */
export function witnessWorktreeCalls(deps: HourlyReconcileJobDeps, runId: number): HourlyReconcileJobDeps {
  const name = (op: string, dir?: string): string => {
    const rel =
      dir === undefined ? '' : dir.startsWith(`${deps.root}/`) ? dir.slice(deps.root.length + 1) : dir;
    const tag = rel.replace(/[^A-Za-z0-9._-]+/g, '.').replace(/^\.+/, '');
    return `worktrees.${op}${tag ? `.${tag}` : ''}`.slice(0, 128);
  };
  // 只写持久见证（schedule_runs），不进控制台步骤轨迹
  const witness = <T>(step: string, fn: () => Promise<T>): Promise<T> => runStep(deps, runId, step, fn, true);
  const wrapped: HourlyReconcileJobDeps = {
    ...deps,
    listDir: (dir) => witness(name('list-dir', dir), () => deps.listDir(dir)),
    ownerOf: (dir) => witness(name('owner-of', dir), () => deps.ownerOf(dir)),
    leftovers: (dir, user, known, scratch) =>
      witness(name('leftovers', dir), () => deps.leftovers(dir, user, known, scratch)),
    remove: (dir) => witness(name('remove', dir), () => deps.remove(dir)),
    keepShots: (dir, user, at) => witness(name('keep-shots', dir), () => deps.keepShots(dir, user, at)),
  };
  const { cleanupNamespace, size, lastSessions, mirrorBytes } = deps;
  if (cleanupNamespace) wrapped.cleanupNamespace = () => witness(name('cleanup-namespace'), cleanupNamespace);
  if (size) wrapped.size = (dir, user) => witness(name('size', dir), () => size(dir, user));
  if (lastSessions) wrapped.lastSessions = () => witness(name('last-sessions'), lastSessions);
  if (mirrorBytes)
    wrapped.mirrorBytes = (repo) =>
      witness(name('mirror-bytes', `${repo.owner}_${repo.name}`), () => mirrorBytes(repo));
  return wrapped;
}

async function round(deps: HourlyReconcileJobDeps, runId: number): Promise<ScheduleResult> {
  // 工作树先跑（它撤的「工作树没收掉」，提醒那部分就不再为它再推）；两部分各列一次没处理的提醒
  let before: AlertRow[] | null = null;
  try {
    before = (await runStep(deps, runId, 'alerts-before-worktrees', () => listOpen(deps))).alerts;
  } catch (err) {
    deps.log('warn', '每小时对账：列没处理的提醒没成，工作树照删，和树有关的提醒留到下一轮撤', {
      error: errMessage(err),
    });
  }
  const trees = await runStep(deps, runId, 'worktrees', () =>
    sweepWorktrees(witnessWorktreeCalls(deps, runId), before),
  );
  const pendingCleanup = deps.pendingCleanup;
  if (pendingCleanup) {
    try {
      await runStep(deps, runId, 'pending-cleanup', async () => {
        for (const row of await pendingCleanup()) {
          trees.unchecked.push(`隔离清理待恢复：${JSON.stringify(row)}`);
        }
      });
    } catch (error) {
      trees.unchecked.push(`隔离清理事务未读全：${errMessage(error)}`);
    }
  } else {
    await skipStep(deps, runId, 'pending-cleanup');
  }
  const saveInventory = deps.saveInventory;
  if (saveInventory) {
    try {
      await runStep(deps, runId, 'save-inventory', () =>
        saveInventory(inventoryOf(trees, { trigger: 'hourly', at: deps.now(), root: deps.root })),
      );
    } catch (err) {
      trees.unchecked.push(`工作树清单没存成（资源页上还是上一份）：${errMessage(err)}`);
    }
  } else {
    await skipStep(deps, runId, 'save-inventory');
  }
  // 核对在提醒之前：这一轮新报的还不满 24 小时，提醒那部分不会再推它们
  const retired = await runStep(deps, runId, 'retire-workflow-alerts', () => retireWorkflowAlerts(deps));
  // 已知没装机器人的仓（有开着的 decision 级 github-app:<仓> 提醒）：读不了是意料之中，两处读 PR 的核对跳过，why 里交代一句
  const skip = await runStep(deps, runId, 'known-not-installed', () => knownNotInstalled(deps));
  const skipping = { ...deps, repos: skipRepos(deps.repos, skip.slugs) };
  const skipPart: SweepPart = {
    scanned: 0,
    found: 0,
    unchecked: [],
    ...(skip.slugs.size > 0 ? { notes: [skippedReposNote([...skip.slugs])] } : {}),
  };
  const merged = await runStep(deps, runId, 'merged-prs', () => checkMergedPrs(skipping));
  const ledgers = await runStep(deps, runId, 'ledgers', () => checkLedgers(deps));
  const localOrphans = await runStep(deps, runId, 'local-orphans', () => localOrphanPart(deps));
  const historical = await runStep(deps, runId, 'historical-facts', () => retireHistoricalFactAlerts(deps));
  const autoMerges = await runStep(deps, runId, 'auto-merges', () => checkAutoMerges(skipping));
  // 单已关且停着等人、或已在检查点软暂停且没有开着会话的，撤掉（#1816 / #3002）：当场发放弃并撤挂起提醒；放在提醒清扫之前
  const mergedTasks = await runStep(deps, runId, 'merged-tasks', () => settleMergedTasks(deps));
  const closedTasks = await runStep(deps, runId, 'closed-issue-tasks', () => abandonClosedIssueTasks(deps));
  // 单已关、没有工作流的遗留行也收掉（#1622）：和上面的任务工作流对账合并统计
  const idleClosedRows = await runStep(deps, runId, 'idle-closed-rows', () =>
    settleIdleClosedIssueRows(deps),
  );
  let alerts: SweepPart;
  try {
    const now = await runStep(deps, runId, 'open-alerts', () => listOpen(deps));
    alerts = await runStep(deps, runId, 'alert-sweep', () => sweepAlerts(deps, now.alerts, now.truncated));
  } catch (err) {
    alerts = { failed: `列没处理的提醒没成：${errMessage(err)}`, scanned: 0, found: 0, unchecked: [] };
  }
  // 权限自检放最后：它新报、撤的提醒这一轮提醒那部分不再碰
  const apps = await runStep(deps, runId, 'github-apps', () => checkGitHubApps(deps));
  let poolHoldPart: SweepPart = { scanned: 0, found: 0, unchecked: [] };
  const poolHoldPush = deps.poolHoldPush;
  if (poolHoldPush) {
    try {
      poolHoldPart = await runStep(deps, runId, 'pool-hold-push', () => poolHoldPush());
    } catch (err) {
      poolHoldPart = {
        failed: `整池暂停到期的飞书推送没跑成：${errMessage(err)}`,
        scanned: 0,
        found: 0,
        unchecked: [],
      };
    }
  } else {
    await skipStep(deps, runId, 'pool-hold-push');
  }
  let mainRedPart: SweepPart = { scanned: 0, found: 0, unchecked: [] };
  const mainRedPush = deps.mainRedPush;
  if (mainRedPush) {
    try {
      mainRedPart = await runStep(deps, runId, 'main-red-push', () => mainRedPush());
    } catch (err) {
      mainRedPart = {
        failed: `主线红的飞书推送没跑成：${errMessage(err)}`,
        scanned: 0,
        found: 0,
        unchecked: [],
      };
    }
  } else {
    await skipStep(deps, runId, 'main-red-push');
  }
  return combineParts([
    mergedTasks,
    trees,
    retired,
    merged,
    ledgers,
    localOrphans,
    historical,
    autoMerges,
    closedTasks,
    idleClosedRows,
    alerts,
    apps,
    poolHoldPart,
    mainRedPart,
    skipPart,
  ]);
}

/**
 * 跑一轮。记开始就失败（库连不上、没登记）：原样抛出，这一轮在库里没有记录——登记表上它会过期，看门狗照样看得见。
 * 没跑成：记成 failed 再抛 HourlyReconcileFailedError。记结局失败：原样抛出。
 */
export async function runHourlyReconcileJob(deps: HourlyReconcileJobDeps): Promise<HourlyReconcileRun> {
  const runId = await deps.runs.start(HOURLY_RECONCILE_JOB.id, deps.now());
  let result: ScheduleResult;
  try {
    result = await round(deps, runId);
  } catch (err) {
    result = { outcome: 'failed', why: `每小时对账没跑成：${errMessage(err)}` };
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
