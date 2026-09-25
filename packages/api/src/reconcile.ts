// 对账补漏（design 第十四节「收 GitHub 事件」：漏收的靠对账与定时轮询补回）：把几样查法按受管的仓串起来，汇总成一个结局。
// 每一样怎么查在 @fleet-dao/github 的 reconcile.ts；补回来的东西一律走 GitHubIntake（同一道门、同一本投递账）。
// 谁来定时调它、多久一次还没定（specs/43-接活入口/方案.md「谁来定时调对账」）：调用方把返回值原样记进 schedule_runs。
import type { Reconciler } from '@fleet-dao/github';
import type { ScheduleOutcome } from '@fleet-dao/shared';
import { DELIVERY_STALE_MS, type GitHubIntake } from './github.ts';
import type { Logger, Store } from './ports.ts';

/** 自动重放到第几次为止：还不成的多半是代码或数据的问题，重放也没用，报出来等人看。 */
export const MAX_AUTO_REPLAYS = 5;
/** 一轮最多重放几条。 */
const REPLAY_BATCH = 50;

export interface ReconcileStep {
  step: 'redeliver' | 'poll' | 'audit' | 'replay';
  repo?: string | undefined;
  outcome: 'ok' | 'partial' | 'unscanned' | 'failed';
  /** 查了几样（投递、事件、开放 issue、要重放的投递）。 */
  checked: number;
  /** 补回来几样。 */
  recovered: number;
  why?: string | undefined;
}

export interface GitHubReconcileResult {
  /** 写法和 schedule_runs 的四种结局一样：ok 要 scanned > 0；一个仓都没查成是 unscanned；查了一部分是 partial。 */
  outcome: ScheduleOutcome;
  /** 查成了几个仓（轮询和查开放 issue 都查完）。 */
  scanned: number;
  /** 补回来几样（漏收的事件、没任务的 issue、GitHub 重投、重放成的），加上重放到头还不成、要人看的。 */
  found: number;
  why?: string | undefined;
  steps: ReconcileStep[];
}

export interface ReconcileParts {
  store: Pick<Store, 'listRepos' | 'listUnfinishedDeliveries'>;
  intake: Pick<GitHubIntake, 'replay'>;
  /** @fleet-dao/github 的 createGitHub(...).reconciler({ intake, pollDeliveryId })。 */
  reconciler: Pick<Reconciler, 'redeliverFailed' | 'poll' | 'auditOpenIssues'>;
  log: Logger;
  now: () => Date;
}

const why = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** since：轮询、重投往回看到哪一刻（调用方给，比上一轮开始的时刻再早一些，重叠的部分去重账会认出来）。 */
export async function reconcileGitHub(
  parts: ReconcileParts,
  options: { since: Date },
): Promise<GitHubReconcileResult> {
  const { store, reconciler, log } = parts;
  const repos = await store.listRepos();
  if (repos.length === 0) {
    return { outcome: 'unscanned', scanned: 0, found: 0, why: '没有受管的仓（repos 表是空的）', steps: [] };
  }
  const steps: ReconcileStep[] = [];

  const redeliver = await reconciler.redeliverFailed(options.since);
  steps.push({ step: 'redeliver', ...redeliver });

  let scanned = 0;
  for (const repo of repos) {
    const slug = `${repo.owner}/${repo.name}`;
    const poll = await reconciler.poll(slug, options.since);
    steps.push({ step: 'poll', repo: slug, ...poll });
    const audit = await reconciler.auditOpenIssues(slug);
    steps.push({
      step: 'audit',
      repo: slug,
      outcome: audit.outcome,
      checked: audit.scanned,
      recovered: audit.fixed,
      why: [audit.why, ...audit.problems].filter(Boolean).join('；') || undefined,
    });
    if (poll.outcome === 'ok' && audit.outcome === 'ok') scanned += 1;
  }

  // 库里出错、卡住的投递按原文重放：GitHub 的重投只管没送到的，送到了却没处理成的靠这里
  const staleBefore = new Date(parts.now().getTime() - DELIVERY_STALE_MS).toISOString();
  const unfinished = await store.listUnfinishedDeliveries({ staleBefore, limit: REPLAY_BATCH });
  const stuck = unfinished.filter((d) => d.attempts >= MAX_AUTO_REPLAYS);
  let replayed = 0;
  const replayErrors: string[] = [];
  for (const d of unfinished.filter((x) => x.attempts < MAX_AUTO_REPLAYS)) {
    try {
      const result = await parts.intake.replay(d.id);
      if (result.verdict === 'accepted' || result.verdict === 'ignored') replayed += 1;
    } catch (err) {
      replayErrors.push(`${d.id}：${why(err)}`);
    }
  }
  if (stuck.length > 0) {
    log.warn('有 GitHub 投递重放到头还是没处理成，要人看', {
      count: stuck.length,
      deliveries: stuck.slice(0, 5).map((d) => `${d.id}（${d.reason ?? '没记原因'}）`),
    });
  }
  const replayNotes = [
    replayErrors.length > 0
      ? `重放 ${replayErrors.length} 条还是没处理成：${replayErrors.slice(0, 3).join('；')}`
      : '',
    stuck.length > 0
      ? `${stuck.length} 条重放了 ${MAX_AUTO_REPLAYS} 次都没成，不再自动重放：${stuck
          .slice(0, 3)
          .map((d) => d.id)
          .join('、')}`
      : '',
  ].filter(Boolean);
  steps.push({
    step: 'replay',
    outcome: replayErrors.length > 0 ? 'partial' : 'ok',
    checked: unfinished.length,
    recovered: replayed,
    why: replayNotes.join('；') || undefined,
  });

  const found = steps.reduce((n, s) => n + s.recovered, 0) + stuck.length;
  const notOk = steps.filter((s) => s.outcome !== 'ok');
  const notes = notOk.map((s) => `${s.step}${s.repo ? ` ${s.repo}` : ''}：${s.why ?? s.outcome}`);
  if (stuck.length > 0 && !notOk.some((s) => s.step === 'replay')) notes.push(replayNotes.join('；'));
  const text = notes.join('；') || undefined;
  if (scanned === repos.length && notOk.length === 0)
    return { outcome: 'ok', scanned, found, why: text, steps };
  // 一个仓都没查成、也没补回任何东西：这一轮等于没查（和「查了、没发现」分开）
  if (scanned === 0 && found === 0) {
    return { outcome: 'unscanned', scanned: 0, found: 0, why: text ?? '一个仓都没查成', steps };
  }
  return { outcome: 'partial', scanned, found, why: text ?? '有的仓没查完', steps };
}
