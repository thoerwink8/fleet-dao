// 定时对账补漏（#43，specs/43-接活入口/方案-对账调度.md）：一轮 = 记下开始 → 同步各仓的流程配置副本（flow-config.ts）→
// 调后端的 reconcileGitHub → 给问创始人的提问另开单（ask-issues.ts，#259）→ 每天一次的关单对账（close-sweep.ts，#241，
// 只在北京时间 9:00 起的那一轮）→ 把结局记进 schedule_runs。副本先同步：同一轮里重放「等着」的投递时，接活看到的就是新副本。
// 没跑成、一个仓都没查成、只查了一部分，都照实记成 failed / unscanned / partial，不记成 ok（没跑成 ≠ 没问题）；
// 驾驶舱「定时任务」页和看门狗按 scheduled_jobs 登记的 expect_every_minutes 看它新不新鲜。
import type { GitHubReconcileResult } from '@fleet-dao/api';
import type { ScheduleResult } from '@fleet-dao/db';
import type { GitHubReconcileRun } from '../contract.ts';
import type { AskIssuesResult } from './ask-issues.ts';
import { type CloseSweepResult, closeSweepDue } from './close-sweep.ts';
import type { FlowSyncResult } from './flow-config.ts';
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
  /** 关单对账（close-sweep.ts 的 sweepClosing，#241）：只在 closeSweepDue 说到点的那一轮调。 */
  closeSweep(): Promise<CloseSweepResult>;
  /** 这一轮跑不跑关单对账；不给就是 closeSweepDue（北京时间 9:00 起的那一轮）。测试换掉它，免得按真钟跑出不一样的结果。 */
  closeSweepDue?: ((at: Date) => boolean) | undefined;
  /** 单子进门自动打标挂版本（issue-groom.ts 的 sweepIssueGroom，#448）：只在 issueGroomDue 说到点的那一轮调。 */
  issueGroom(): Promise<IssueGroomResult>;
  /** 这一轮跑不跑单子打标挂版本；不给就是 issueGroomDue（每小时一次）。测试换掉它，免得按真钟跑出不一样的结果。 */
  issueGroomDue?: ((at: Date) => boolean) | undefined;
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

/**
 * 关单对账这一步并进这一轮的结局（#241）：没到点（null）原样；新留的言算处理了的（found 加上）；整步没跑成、有仓没查成、
 * 留言提醒没写成的，这一轮不算查全（ok 降成 partial），前几条写进 why——没查成不当成齐了。
 */
export function withCloseSweep(
  r: GitHubReconcileResult,
  close: CloseSweepResult | { failed: string } | null,
): GitHubReconcileResult {
  if (close === null) return r;
  if ('failed' in close) {
    return {
      ...r,
      outcome: r.outcome === 'ok' ? 'partial' : r.outcome,
      why: [r.why, `关单对账没跑成：${close.failed}`].filter(Boolean).join('；'),
    };
  }
  const found = r.found + close.found;
  const n = close.unchecked.length;
  if (n === 0) return { ...r, found };
  const shown = close.unchecked.slice(0, CLOSE_WHY_LINES);
  if (n > CLOSE_WHY_LINES) shown.push(`关单对账另有 ${n - CLOSE_WHY_LINES} 条没查成、没写成（看引擎日志）`);
  return {
    ...r,
    outcome: r.outcome === 'ok' ? 'partial' : r.outcome,
    found,
    why: [r.why, ...shown].filter(Boolean).join('；'),
  };
}

/** 一轮的原因里最多写几条关单对账没查成的。 */
const CLOSE_WHY_LINES = 3;

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
    // 关单对账一天一次（#241）；没跑成不挡对账本身：这一轮记成没查全，第二天再来（留言、提醒都按键认，重跑不重复）
    let close: CloseSweepResult | { failed: string } | null = null;
    if ((deps.closeSweepDue ?? closeSweepDue)(startedAt)) {
      try {
        close = await deps.closeSweep();
      } catch (err) {
        close = { failed: message(err) };
      }
    }
    // 单子打标挂版本每小时一次（#448）；没跑成不挡对账本身：这一轮记成没查全，下个整点再来（贴标签、挂里程碑都是幂等的）
    let groom: IssueGroomResult | { failed: string } | null = null;
    if ((deps.issueGroomDue ?? issueGroomDue)(startedAt)) {
      try {
        groom = await deps.issueGroom();
      } catch (err) {
        groom = { failed: message(err) };
      }
    }
    result = toScheduleResult(withIssueGroom(withCloseSweep(withAskIssues(reconciled, asks), close), groom));
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
