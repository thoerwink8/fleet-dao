// 定时对账补漏（#43，specs/43-接活入口/方案-对账调度.md）：一轮 = 记下开始 → 同步各仓的流程配置副本（flow-config.ts）→
// 调后端的 reconcileGitHub → 给问创始人的提问另开单（ask-issues.ts，#259）→ 把结局记进 schedule_runs。副本先同步：同一轮里
// 重放「等着」的投递时，接活看到的就是新副本。
// 没跑成、一个仓都没查成、只查了一部分，都照实记成 failed / unscanned / partial，不记成 ok（没跑成 ≠ 没问题）；
// 驾驶舱「定时任务」页和看门狗按 scheduled_jobs 登记的 expect_every_minutes 看它新不新鲜。
import type { GitHubReconcileResult } from '@fleet-dao/api';
import type { ScheduleResult } from '@fleet-dao/db';
import type { GitHubReconcileRun } from '../contract.ts';
import type { AskIssuesResult } from './ask-issues.ts';
import type { FlowSyncResult } from './flow-config.ts';

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
  /** 各仓的流程配置副本从仓里同步一遍（flow-config.ts 的 syncFlowConfigs）。 */
  syncFlowConfigs(): Promise<FlowSyncResult>;
  /** 后端的 reconcileGitHub（按受管的仓串起重投、轮询、查开放 issue、重放）。 */
  reconcile(options: { since: Date }): Promise<GitHubReconcileResult>;
  /** 给问创始人的提问另开单、把回答写上去（ask-issues.ts 的 openAskIssues，#259）。 */
  askIssues(): Promise<AskIssuesResult>;
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

/**
 * 流程配置这一步并进这一轮的结局：有仓没查成（或整步没跑成）这一轮就不算查全（ok 降成 partial）；认不出的仓算发现的
 * 问题（found 加一，要人改仓里的文件）。原因都写进 why。副本本身、停派、提醒已经由 syncFlowConfigs 写好。
 */
export function withFlowSync(
  r: GitHubReconcileResult,
  flow: FlowSyncResult | { failed: string },
): GitHubReconcileResult {
  const notes: string[] = [];
  let found = r.found;
  let unchecked = false;
  if ('failed' in flow) {
    unchecked = true;
    notes.push(`流程配置没同步成：${flow.failed}`);
  } else {
    for (const repo of flow.repos) {
      const why = repo.why ?? '没带原因';
      if (repo.outcome === 'unread') {
        unchecked = true;
        notes.push(`流程配置 ${repo.repo} 没查成（${why}）${repo.blocked ? '，副本不能用、停派' : ''}`);
      } else if (repo.outcome === 'invalid') {
        found += 1;
        notes.push(`流程配置 ${repo.repo} 认不出、停派（${why}）`);
      }
    }
  }
  if (notes.length === 0) return r;
  return {
    ...r,
    outcome: unchecked && r.outcome === 'ok' ? 'partial' : r.outcome,
    found,
    why: [r.why, ...notes].filter(Boolean).join('；'),
  };
}

/**
 * 另开单这一步并进这一轮的结局（#259）：开出的单、写上的回答算处理了的（found 加上）；有没开成、没写成的（或整步没跑成）
 * 这一轮就不算查全（ok 降成 partial），一条一句写进 why——没开成不当成开了。
 */
export function withAskIssues(
  r: GitHubReconcileResult,
  asks: AskIssuesResult | { failed: string },
): GitHubReconcileResult {
  if ('failed' in asks) {
    return {
      ...r,
      outcome: r.outcome === 'ok' ? 'partial' : r.outcome,
      why: [r.why, `给提问另开单没跑成：${asks.failed}`].filter(Boolean).join('；'),
    };
  }
  const found = r.found + asks.found;
  const n = asks.unchecked.length;
  if (n === 0) return { ...r, found };
  // 每条的详情在提醒里（一条提问一条）：这里只写前几条，免得一轮的原因越积越长
  const shown = asks.unchecked.slice(0, ASK_WHY_LINES);
  if (n > ASK_WHY_LINES) {
    shown.push(
      `另有 ${n - ASK_WHY_LINES} 条提问没开成单或没写成回答（提醒中心 ask-issue:、ask-answer: 开头的）`,
    );
  }
  return {
    ...r,
    outcome: r.outcome === 'ok' ? 'partial' : r.outcome,
    found,
    why: [r.why, ...shown].filter(Boolean).join('；'),
  };
}

/** 一轮的原因里最多写几条没开成、没写成的提问。 */
const ASK_WHY_LINES = 3;

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
    // 流程配置没同步成不挡对账本身（照样补收、重放）；这一轮记成没查全，原因写进去
    let flow: FlowSyncResult | { failed: string };
    try {
      flow = await deps.syncFlowConfigs();
    } catch (err) {
      flow = { failed: message(err) };
    }
    const since = new Date(startedAt.getTime() - GITHUB_RECONCILE_LOOKBACK_MS);
    const reconciled = withFlowSync(await deps.reconcile({ since }), flow);
    // 另开单没跑成不挡对账本身：这一轮记成没查全，原因写进去；下一轮再开（按提问编号幂等）
    let asks: AskIssuesResult | { failed: string };
    try {
      asks = await deps.askIssues();
    } catch (err) {
      asks = { failed: message(err) };
    }
    result = toScheduleResult(withAskIssues(reconciled, asks));
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
