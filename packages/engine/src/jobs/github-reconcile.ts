// 定时对账补漏（#43，specs/43-接活入口/方案-对账调度.md）：一轮 = 记下开始 → 调后端的 reconcileGitHub（重投、轮询 PR、
// 重放）→ 每小时一次的单子打标挂版本（issue-groom.ts，#448）→ 把结局记进 schedule_runs。各仓的流程配置副本不再同步
// （没有每仓流程配置了，#556）；每天一次的关单对账（#241）#654 删了：关单不再要结果.md，那四种判法的前提都没了。
// 没跑成、一个仓都没查成、只查了一部分，都照实记成 failed / unscanned / partial，不记成 ok（没跑成 ≠ 没问题）；
// 驾驶舱「定时任务」页和看门狗按 scheduled_jobs 登记的 expect_every_minutes 看它新不新鲜。

import type { ScheduleResult } from '@fleet-dao/db';
import { errMessage } from '@fleet-dao/shared/util';
import type { GitHubReconcileResult } from '@fleet-dao/store';
import type { GitHubReconcileRun } from '../contract.ts';
import { type IssueGroomResult, issueGroomDue } from './issue-groom.ts';

/** 登记进 scheduled_jobs 的那一行：一次都没跑过也列得出来（看门狗按登记表查，不按跑过的记录查）。 */
export const GITHUB_RECONCILE_JOB = {
  id: 'github-reconcile',
  name: 'GitHub 对账补漏',
  schedule: '每 15 分钟',
  // 连着两轮没跑成就过期：多给一轮余量，偶尔一轮慢不报。
  expectEveryMinutes: 45,
} as const;

export const GITHUB_RECONCILE_EVERY_MINUTES = 15;
/**
 * 没有「上一次成功跑完」的记录时，往回看多久。有记录时从那次跑完的时刻起看，不用这条。
 * 比间隔长，漏了一两轮也还在窗口里；重叠的部分由去重账认出。
 */
export const GITHUB_RECONCILE_LOOKBACK_MS = 2 * 60 * 60_000;
/**
 * 回看最早到多久以前。再早的投递 GitHub 已经不留，重投也补不回来：官方文档写明 webhook 投递只留最近 3 天，
 * 这 3 天里才能查看和请求重投（https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/viewing-webhook-deliveries
 * 「from the past 3 days」；保留期改成 3 天见
 * https://github.blog/changelog/2023-10-17-webhook-delivery-logs-will-only-be-retained-for-3-days/ ，
 * GitHub Enterprise Server 仍是 7 天，这里按 github.com）。超过这条就截到上限，日志写明超出上限、可能有漏。
 */
export const GITHUB_RECONCILE_LOOKBACK_CAP_MS = 3 * 24 * 60 * 60_000;

/** schedule_runs 的读写（真实现是 @fleet-dao/db 的 startScheduleRun / finishScheduleRun / closeInterruptedScheduleRuns）。 */
export interface ScheduleRunLog {
  start(job: string, at: Date): Promise<number>;
  finish(id: number, result: ScheduleResult, at: Date): Promise<void>;
  /**
   * 超过 startedBefore 还没结束的补记成 failed（和引擎起来时同一份 closeInterruptedScheduleRuns）。
   * 写库失败照抛。没装这个入口时，巡检补记会记一条没补上，不当成补上了。
   */
  closeInterrupted?(input: { job: string; startedBefore: Date; why: string; at: Date }): Promise<number[]>;
}

export interface GitHubReconcileJobDeps {
  /** 后端的 reconcileGitHub（按受管的仓串起重投、轮询 PR、重放）。 */
  reconcile(options: { since: Date }): Promise<GitHubReconcileResult>;
  /** 单子进门自动打标挂版本（issue-groom.ts 的 sweepIssueGroom，#448）：只在 issueGroomDue 说到点的那一轮调。 */
  issueGroom(): Promise<IssueGroomResult>;
  /** 这一轮跑不跑单子打标挂版本；不给就是 issueGroomDue（每小时一次）。测试换掉它，免得按真钟跑出不一样的结果。 */
  issueGroomDue?: ((at: Date) => boolean) | undefined;
  runs: ScheduleRunLog;
  /**
   * 上一次这一轮跑成的时刻：schedule_runs 里本任务 outcome = ok 的 ended_at（不认 partial，没查全的那一轮不能把窗口往前推）。
   * 没有记录回 null。读库失败要抛，这一轮按没有记录退回 2 小时，不把读不到当成时刻 0。不给这个入口同样按没有记录。
   */
  lastSuccessAt?: () => Promise<Date | null>;
  now: () => Date;
  log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

/** 这一轮往回看到哪。null、无效时刻、在这一轮之后、时刻 0 都退回 2 小时；早于上限的截到上限。 */
export function githubReconcileSince(
  now: Date,
  lastSuccessAt: Date | null,
): { since: Date; capped: boolean } {
  const fallback = new Date(now.getTime() - GITHUB_RECONCILE_LOOKBACK_MS);
  const earliest = new Date(now.getTime() - GITHUB_RECONCILE_LOOKBACK_CAP_MS);
  const ms = lastSuccessAt?.getTime();
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0 || ms > now.getTime()) {
    return { since: fallback, capped: false };
  }
  if (ms < earliest.getTime()) return { since: earliest, capped: true };
  return { since: new Date(ms), capped: false };
}

/**
 * 读上一次成功。抛错、空、时刻 0、无效时刻都当成没有记录（回 null），并在真读失败或时刻不能用时写日志。
 * 不给入口就是没有记录，不写日志（测试和第一次跑都是这样）。
 */
async function readLastSuccessAt(deps: GitHubReconcileJobDeps, now: Date): Promise<Date | null> {
  if (!deps.lastSuccessAt) return null;
  let raw: Date | null;
  try {
    raw = (await deps.lastSuccessAt()) ?? null;
  } catch (err) {
    deps.log('warn', '读不到上一次 GitHub 对账成功的时刻，按没有记录处理', { error: errMessage(err) });
    return null;
  }
  const ms = raw?.getTime();
  if (raw === null) return null;
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0 || ms > now.getTime()) {
    deps.log('warn', '上一次 GitHub 对账成功的时刻不能用，按没有记录处理', {
      lastSuccessAt: ms !== undefined && Number.isFinite(ms) ? new Date(ms).toISOString() : String(raw),
    });
    return null;
  }
  return raw;
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

/**
 * 单子打标挂版本这一步并进这一轮的结局（#448）：没到点（null）原样；贴的类别标签、挂的里程碑、交接挪的、闲置清理的
 * 都算处理了的（found 加上）；整步没跑成、有单没查成、写不成的，这一轮不算查全（ok 降成 partial），前几条写进
 * why——没查成不当成齐了。日报级的活动摘要已经在 sweepIssueGroom 里写进对应仓的提醒，这里不重复。
 */
export function withIssueGroom(
  r: GitHubReconcileResult,
  groom: IssueGroomResult | { failed: string } | null,
): GitHubReconcileResult {
  if (groom === null) return r;
  if ('failed' in groom) {
    return {
      ...r,
      outcome: r.outcome === 'ok' ? 'partial' : r.outcome,
      why: [r.why, `单子打标挂版本没跑成：${groom.failed}`].filter(Boolean).join('；'),
    };
  }
  const found = r.found + groom.found;
  const n = groom.unchecked.length;
  if (n === 0) return { ...r, found };
  const shown = groom.unchecked.slice(0, GROOM_WHY_LINES);
  if (n > GROOM_WHY_LINES)
    shown.push(`单子打标挂版本另有 ${n - GROOM_WHY_LINES} 条没查成、没写成（看引擎日志）`);
  return {
    ...r,
    outcome: r.outcome === 'ok' ? 'partial' : r.outcome,
    found,
    why: [r.why, ...shown].filter(Boolean).join('；'),
  };
}

/** 一轮的原因里最多写几条单子打标挂版本没查成的。 */
const GROOM_WHY_LINES = 3;

/** 对账的结局换成 schedule_runs 的写法：ok 必须真查了东西，其余都要写原因。 */
export function toScheduleResult(r: GitHubReconcileResult): ScheduleResult {
  switch (r.outcome) {
    case 'ok':
      // reconcileGitHub 只在查成了每个受管的仓时回 ok；万一 scanned 是 0，按「一个都没查」记，不冒充查过
      return r.scanned > 0
        ? { outcome: 'ok', scanned: r.scanned, found: r.found, ...(r.why ? { why: r.why } : {}) }
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
  let since = new Date(startedAt.getTime() - GITHUB_RECONCILE_LOOKBACK_MS);
  try {
    const lastSuccessAt = await readLastSuccessAt(deps, startedAt);
    const lookback = githubReconcileSince(startedAt, lastSuccessAt);
    since = lookback.since;
    if (lookback.capped && lastSuccessAt) {
      deps.log(
        'warn',
        `GitHub 对账补漏回看超出上限，可能有漏：上一次成功是 ${lastSuccessAt.toISOString()}，只回看到 ${since.toISOString()}`,
        {
          lastSuccessAt: lastSuccessAt.toISOString(),
          since: since.toISOString(),
          capMs: GITHUB_RECONCILE_LOOKBACK_CAP_MS,
        },
      );
    }
    const reconciled = await deps.reconcile({ since });
    // 单子打标挂版本每小时一次（#448）；没跑成不挡对账本身：这一轮记成没查全，下个整点再来（贴标签、挂里程碑都是幂等的）
    let groom: IssueGroomResult | { failed: string } | null = null;
    if ((deps.issueGroomDue ?? issueGroomDue)(startedAt)) {
      try {
        groom = await deps.issueGroom();
      } catch (err) {
        groom = { failed: errMessage(err) };
      }
    }
    result = toScheduleResult(withIssueGroom(reconciled, groom));
  } catch (err) {
    result = { outcome: 'failed', why: `对账没跑成：${errMessage(err)}` };
  }
  await deps.runs.finish(runId, result, deps.now());
  const run: GitHubReconcileRun = {
    runId,
    outcome: result.outcome,
    scanned: result.outcome === 'unscanned' ? 0 : (result.scanned ?? 0),
    found: result.outcome === 'unscanned' ? 0 : (result.found ?? 0),
    ...('why' in result ? { why: result.why } : {}),
  };
  const fields = {
    runId,
    outcome: run.outcome,
    scanned: run.scanned,
    found: run.found,
    why: run.why,
    since: since.toISOString(),
  };
  if (run.outcome === 'failed') {
    deps.log('error', 'GitHub 对账补漏这一轮没跑成', fields);
    throw new GitHubReconcileFailedError(runId, run.why ?? '对账没跑成');
  }
  if (run.outcome === 'ok') deps.log('info', 'GitHub 对账补漏跑完了', fields);
  else deps.log('warn', 'GitHub 对账补漏这一轮没查全', fields);
  return run;
}
