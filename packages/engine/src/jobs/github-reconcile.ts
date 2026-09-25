// 定时对账补漏（#43，specs/43-接活入口/方案-对账调度.md）：一轮 = 记下开始 → 调后端的 reconcileGitHub → 把结局记进 schedule_runs。
// 没跑成、一个仓都没查成、只查了一部分，都照实记成 failed / unscanned / partial，不记成 ok（没跑成 ≠ 没问题）；
// 驾驶舱「定时任务」页和看门狗按 scheduled_jobs 登记的 expect_every_minutes 看它新不新鲜。
import type { GitHubReconcileResult } from '@fleet-dao/api';
import type { ScheduleResult } from '@fleet-dao/db';
import type { GitHubReconcileRun } from '../contract.ts';

/** 登记进 scheduled_jobs 的那一行：一次都没跑过也列得出来（看门狗按登记表查，不按跑过的记录查）。 */
export const GITHUB_RECONCILE_JOB = {
  id: 'github-reconcile',
  name: 'GitHub 对账补漏',
  schedule: '每 15 分钟',
  // 连着两轮没跑成就过期：多给一轮余量，偶尔一轮慢不报。
  expectEveryMinutes: 45,
} as const;

export const GITHUB_RECONCILE_EVERY_MINUTES = 15;
/** 每轮往回看多久：比间隔长得多，漏了一两轮（引擎重启、Temporal 停了一会儿）也捞得回来；重叠的部分由去重账认出。 */
export const GITHUB_RECONCILE_LOOKBACK_MS = 2 * 60 * 60_000;

/** schedule_runs 的读写（真实现是 @fleet-dao/db 的 startScheduleRun / finishScheduleRun）。 */
export interface ScheduleRunLog {
  start(job: string, at: Date): Promise<number>;
  finish(id: number, result: ScheduleResult, at: Date): Promise<void>;
}

export interface GitHubReconcileJobDeps {
  /** 后端的 reconcileGitHub（按受管的仓串起重投、轮询、查开放 issue、重放）。 */
  reconcile(options: { since: Date }): Promise<GitHubReconcileResult>;
  runs: ScheduleRunLog;
  now: () => Date;
  log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

/** 这一轮没跑成（对账本身抛错）：结局已经记进 schedule_runs，活动照样报失败，Temporal 里也看得见。 */
export class GitHubReconcileFailedError extends Error {
  readonly runId: number;
  constructor(runId: number, message: string) {
    super(message);
    this.name = 'GitHubReconcileFailedError';
    this.runId = runId;
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 对账的结局换成 schedule_runs 的写法：ok 必须真查了东西，其余都要写原因。 */
export function toScheduleResult(r: GitHubReconcileResult): ScheduleResult {
  switch (r.outcome) {
    case 'ok':
      // reconcileGitHub 只在查成了每个受管的仓时回 ok；万一 scanned 是 0，按「一个都没查」记，不冒充查过
      return r.scanned > 0
        ? { outcome: 'ok', scanned: r.scanned, found: r.found }
        : { outcome: 'unscanned', why: r.why ?? '说是查完了，却一个仓都没查' };
    case 'partial':
      return { outcome: 'partial', why: r.why ?? '有的仓没查完', scanned: r.scanned, found: r.found };
    case 'unscanned':
      return { outcome: 'unscanned', why: r.why ?? '一个仓都没查成' };
    case 'failed':
      return { outcome: 'failed', why: r.why ?? '对账没跑成', scanned: r.scanned, found: r.found };
  }
}

/**
 * 跑一轮。记开始就失败（库连不上）：原样抛出，这一轮在库里没有记录——登记表上它会变成 stale，看门狗照样看得见。
 * 对账本身抛错：记成 failed 再抛 GitHubReconcileFailedError。记结局失败：原样抛出（那一行停在「还在跑」，同样会变 stale）。
 */
export async function runGitHubReconcileJob(deps: GitHubReconcileJobDeps): Promise<GitHubReconcileRun> {
  const startedAt = deps.now();
  const runId = await deps.runs.start(GITHUB_RECONCILE_JOB.id, startedAt);
  let result: ScheduleResult;
  try {
    const since = new Date(startedAt.getTime() - GITHUB_RECONCILE_LOOKBACK_MS);
    result = toScheduleResult(await deps.reconcile({ since }));
  } catch (err) {
    result = { outcome: 'failed', why: `对账没跑成：${message(err)}` };
  }
  await deps.runs.finish(runId, result, deps.now());
  const run: GitHubReconcileRun = {
    runId,
    outcome: result.outcome,
    scanned: result.outcome === 'unscanned' ? 0 : (result.scanned ?? 0),
    found: result.outcome === 'unscanned' ? 0 : (result.found ?? 0),
    ...('why' in result ? { why: result.why } : {}),
  };
  const fields = { runId, outcome: run.outcome, scanned: run.scanned, found: run.found, why: run.why };
  if (run.outcome === 'failed') {
    deps.log('error', 'GitHub 对账补漏这一轮没跑成', fields);
    throw new GitHubReconcileFailedError(runId, run.why ?? '对账没跑成');
  }
  if (run.outcome === 'ok') deps.log('info', 'GitHub 对账补漏跑完了', fields);
  else deps.log('warn', 'GitHub 对账补漏这一轮没查全', fields);
  return run;
}
