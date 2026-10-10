// 每小时对账的核对（design 第六节第 4 层，specs/293-对账三处核对）：合了的 PR 都记了账。
// 第三处（额度读数不超过 30 分钟）随 #76 定时读额度上线做了：checkQuotaFreshness，兜底定时读额度自己没在跑、读了没写库、上游数冻住。
// 各返回一个 SweepPart，由 hourly-reconcile 的 combineParts 并进这一轮。提醒自己报、自己撤，不进 alert-sweep 的判法表。
// 记账对不上只报、不补：补账要从会话记录重算，不在这里猜。
// 「开着的单都有着落」那一处（一张单一个需求工作流，要补拉接活）随 Fusion 一起删了（#556）：三段流程的单是任务工作流，
// 状态只在 Temporal 一份，不靠这一处查；它留下的旧提醒由 retireWorkflowAlerts 撤掉。

import {
  type LedgerSession,
  type MergedPrLedger,
  QUOTA_STALE_AFTER_MS,
  type QuotaTablePool,
} from '@fleet-dao/db';
import type { MergedPrAuditReport, MergedPrFinding, RepoRef } from '@fleet-dao/github';
import type { TaskState } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { AlertSweepDeps } from './alert-sweep.ts';
import { clip, RECONCILE_ACTOR, type SweepPart } from './reconcile-common.ts';

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

/** 随「开着的单都有着落」那一处删掉的旧提醒的键前缀（#556）：不会再有新的，只撤旧的。后面是任务编号。 */
export const WORKFLOW_ALERT_PREFIX = 'reconcile:workflow:';
/** 合了的 PR 对上的单记账不全。后面是 <owner>/<name>#<PR 号>。 */
export const LEDGER_ALERT_PREFIX = 'reconcile:ledger:';
/**
 * 我们机器人开的 PR 合并人不是「引擎」、或账上没有合并队列的合并记录——合并前那几道核对（不落后主线、CI 全绿、人闸）
 * 可能没走。后面是 <owner>/<name>#<PR 号>。条件就是「发生过」，只报一次、不自动撤，要人在驾驶舱点「处理」。
 * （#445 删过、#440 又办回来：合并队列其实已开，删掉的判断「没开」不准。）
 */
export const PR_ALERT_PREFIX = 'reconcile:pr:';
/** PR 合了以后关单那一步（写关单评论、收会话、记做完）要走一会儿：合并这么久之内的不查记账。 */
export const LEDGER_GRACE_MS = 30 * 60_000;
/** 每小时一轮，往回看 26 小时：漏一轮也补得回最近一天里合的。 */
export const MERGED_PR_LOOKBACK_MS = 26 * 60 * 60_000;
/** 和 hourly-reconcile 的 OPEN_ALERT_LIMIT 同一个上限：多出来的照实记没看全，不当成没有。 */
const ALERT_LIST_LIMIT = 500;
/** PR 合并超过这么多天，「没经合并队列合」「记账不全」就是改不了的历史事实：自动收掉，不再复查、不再催。 */
export const HISTORICAL_FACT_DAYS = 7;
const HISTORICAL_FACT_MS = HISTORICAL_FACT_DAYS * 24 * 60 * 60_000;
/** 这两类提醒只对回看窗口里合的 PR 报；提醒开了不到「7 天减回看窗口」的，PR 一定合了不到 7 天，不用读合并时刻。 */
const SURELY_RECENT_ALERT_MS = HISTORICAL_FACT_MS - MERGED_PR_LOOKBACK_MS;

export function prAlertKey(owner: string, name: string, number: number): string {
  return `${PR_ALERT_PREFIX}${owner}/${name}#${number}`;
}

export function ledgerAlertKey(owner: string, name: string, number: number): string {
  return `${LEDGER_ALERT_PREFIX}${owner}/${name}#${number}`;
}

export interface ReconcileCheckDeps extends Pick<AlertSweepDeps, 'alerts' | 'now' | 'log'> {
  /** 受管的仓（库里的 repos 表）。 */
  repos(): Promise<RepoRef[]>;
  /** @fleet-dao/github 的 GitHub.auditMergedPrs。 */
  auditMergedPrs(repoFullName: string, since: Date): Promise<MergedPrAuditReport>;
  /** 额度表（db 的 quotaTable，按 now 判过期）。 */
  quotaPools(now: Date): Promise<QuotaTablePool[]>;
  /**
   * 额度配置写明不读的池（deploy/quota.json 的 notRead）。不查、不报；开着的旧提醒撤掉。
   * 不给就当没有。读不到要抛，不许回空列表冒充「这些池都要读」。
   */
  quotaNotRead?: () => Promise<readonly string[]>;
  /** 一条 PR 的合并时刻（和 alert-sweep 的 prMergedAt 是同一个读法）。读不到照抛；没接上当读不到。 */
  prMergedAt?(repo: { owner: string; name: string }, number: number): Promise<Date>;
  ledgers(input: {
    since: Date;
    prs: { owner: string; name: string; number: number }[];
  }): Promise<MergedPrLedger[]>;
}

const empty = (): SweepPart => ({ scanned: 0, found: 0, unchecked: [] });

/**
 * 撤掉「开着的单都有着落」那一处留下的旧提醒（键以 WORKFLOW_ALERT_PREFIX 开头）：那一处随 Fusion 删了，不会再有人撤它们。
 * 列不出来、列得不全都照实记没查成，不当成「没有」。
 */
export async function retireWorkflowAlerts(deps: ReconcileCheckDeps): Promise<SweepPart> {
  const part = empty();
  let listed: Awaited<ReturnType<ReconcileCheckDeps['alerts']['listOpen']>>;
  try {
    listed = await deps.alerts.listOpen(ALERT_LIST_LIMIT);
  } catch (err) {
    return { ...part, failed: `列没处理的提醒没成，工作流核对留下的旧提醒这一轮不撤：${errMessage(err)}` };
  }
  if (listed.truncated) {
    part.unchecked.push(`没处理的提醒太多，只看了前 ${listed.alerts.length} 条，没看到的旧工作流提醒不撤`);
  }
  for (const alert of listed.alerts) {
    if (!alert.dedupeKey.startsWith(WORKFLOW_ALERT_PREFIX)) continue;
    part.scanned += 1;
    await resolveOne(
      deps,
      part,
      alert.dedupeKey,
      '这一项核对随 Fusion 的「一张单一个需求工作流」一起删了（#556），提醒不会再有人跟',
    );
  }
  return part;
}

async function resolveOne(deps: ReconcileCheckDeps, part: SweepPart, dedupeKey: string, why: string) {
  try {
    const r = await deps.alerts.resolve({ dedupeKey, by: RECONCILE_ACTOR, why });
    if (r === 'ok') {
      part.found += 1;
      deps.log('info', '每小时对账：撤了一条提醒', { dedupeKey, why });
    }
  } catch (err) {
    part.unchecked.push(`提醒 ${dedupeKey} 没撤成：${errMessage(err)}`);
  }
}

/** 按 PR 归拢要报的两种（合并人不是「引擎」、没有合并记录）。 */
function prProblems(findings: readonly MergedPrFinding[]): Map<number, string[]> {
  const byPr = new Map<number, string[]>();
  for (const f of findings) {
    if (f.kind !== 'not_merged_by_engine' && f.kind !== 'no_merge_record') continue;
    byPr.set(f.number, [...(byPr.get(f.number) ?? []), f.text]);
  }
  return byPr;
}

/**
 * 每个受管的仓，最近 26 小时合了的 PR：镜像补上算发现（记账那一部分靠镜像认合了的 PR，放在它前面跑）。我们机器人开的
 * PR 合并人不是「引擎」、或没有合并队列的合并记录按 PR 报一条（#431 就是这么漏的：合并前那几道核对——不落后主线、CI
 * 全绿、人闸——可能没走）。条件就是「发生过」，只报一次、不自动撤，要人在驾驶舱点「处理」。
 */
export async function checkMergedPrs(deps: ReconcileCheckDeps): Promise<SweepPart> {
  const part = empty();
  let repos: RepoRef[];
  try {
    repos = await deps.repos();
  } catch (err) {
    return { ...part, failed: `列受管的仓没成：${errMessage(err)}` };
  }
  const since = new Date(deps.now().getTime() - MERGED_PR_LOOKBACK_MS);
  for (const repo of repos) {
    const slug = `${repo.owner}/${repo.name}`;
    let report: MergedPrAuditReport;
    try {
      report = await deps.auditMergedPrs(slug, since);
    } catch (err) {
      part.unchecked.push(`${slug} 审合并的 PR 没做成：${errMessage(err)}`);
      continue;
    }
    part.scanned += report.scanned;
    part.found += report.found;
    const fixed = report.findings.filter((f) => f.kind === 'mirror_fixed');
    if (fixed.length > 0) {
      deps.log('info', '每小时对账：合并的 PR 镜像补记成已合并', {
        repo: slug,
        fixed: fixed.length,
        problems: fixed.slice(0, 5).map((f) => f.text),
      });
    }
    const failed = report.findings.filter((f) => f.kind === 'unchecked').map((f) => f.text);
    if (report.outcome === 'unscanned') {
      part.unchecked.push(`${slug}：${report.why ?? '合并的 PR 这次没查成'}`);
    } else if (report.outcome === 'partial' || failed.length > 0) {
      const detail = failed.length > 0 ? failed.join('；') : (report.why ?? '有的没查成');
      part.unchecked.push(`${slug} 合并的 PR 没查全：${detail}`);
    }
    for (const [number, lines] of prProblems(report.findings)) {
      const dedupeKey = prAlertKey(repo.owner, repo.name, number);
      try {
        const { created } = await deps.alerts.insertOnce({
          dedupeKey,
          level: 'alert',
          taskId: null,
          title: clip(`机器人开的 PR 没经合并队列合：${slug}#${number}`, 300),
          body: [
            ...lines,
            '我们机器人开的 PR 该由合并队列以「引擎」机器人合、账上留合并记录；不是这样合的，合并前那几道核对（不落后主线、' +
              'CI 全绿、人闸）可能没走。这条不会自己撤，看过点「处理」。',
          ].join('\n'),
          link: `https://github.com/${slug}/pull/${number}`,
        });
        if (created) deps.log('info', '每小时对账：机器人开的 PR 没经合并队列合', { dedupeKey });
      } catch (err) {
        part.unchecked.push(`${dedupeKey} 没报成：${errMessage(err)}`);
      }
    }
  }
  return part;
}

/**
 * 读到了、却是 0：跑成了的会话一定花了 token，记成 0 就是拿 0 冒充读到了（读不到要留空，关单评论写「没读到」）。
 * 没跑成的（出错、叫停、停滞）可能真的一个 token 都没花（比如刚起就被限流），0 是照实记的，不算缺。
 */
function zeroUsage(s: LedgerSession): boolean {
  const recorded = s.inputTokens !== null || s.outputTokens !== null;
  return s.outcome === 'ok' && recorded && (s.inputTokens ?? 0) + (s.outputTokens ?? 0) === 0;
}

/** 一条合了的 PR 对上的单缺什么；都齐是空的。 */
export function ledgerGaps(l: MergedPrLedger): string[] {
  const gaps: string[] = [];
  const open = l.sessions.filter((s) => s.endedAt === null || s.outcome === null);
  if (open.length > 0) {
    gaps.push(`${open.length} 次会话没有结局（${[...new Set(open.map((s) => s.stage))].join('、')}）`);
  }
  const zero = l.sessions.filter(zeroUsage);
  if (zero.length > 0) {
    gaps.push(`${zero.length} 次跑成了的会话用量记成了 0（读不到要留空、写明没读到，不记 0）`);
  }
  // 0003 第 7 步：合并、关单（关单评论写用量、耗时），收尾时把单记成做完。#252 母单按块合多条 PR 之后，这一条要改成按块认。
  if (l.taskState !== 'done') {
    gaps.push(`合并关单那一步没写完：库里这张单是「${TASK_STATE_WORDS[l.taskState]}」，不是「做完了」`);
  }
  return gaps;
}

function parsePrKey(key: string, prefix: string): { owner: string; name: string; number: number } | null {
  const m = /^([^/]+)\/(.+)#(\d+)$/.exec(key.slice(prefix.length));
  return m?.[1] && m[2] && m[3] ? { owner: m[1], name: m[2], number: Number(m[3]) } : null;
}

function parseLedgerKey(key: string): { owner: string; name: string; number: number } | null {
  return parsePrKey(key, LEDGER_ALERT_PREFIX);
}

/** 这条 PR 合并是不是超过 7 天。读不到（没接上、抛了、时刻认不出）抛错，由调用方决定怎么记。 */
async function mergedOverSevenDays(
  deps: ReconcileCheckDeps,
  pr: { owner: string; name: string; number: number },
): Promise<boolean> {
  if (!deps.prMergedAt) throw new Error('没接上合并时刻的读法');
  const at = await deps.prMergedAt({ owner: pr.owner, name: pr.name }, pr.number);
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw new Error('合并时刻认不出');
  return deps.now().getTime() - at.getTime() > HISTORICAL_FACT_MS;
}

/**
 * 撤掉历史事实类提醒：键以 reconcile:pr:、reconcile:ledger: 开头、对应 PR 合并超过 HISTORICAL_FACT_DAYS 天的。
 * 事实改不了（前者只报一次要人点「处理」，后者老单在记账表之前、永远补不齐），留着只会每天催。
 * 读不到合并时刻的不撤、记没查成；列不出提醒返回 failed，不当成「没有要收的」。
 */
export async function retireHistoricalFactAlerts(deps: ReconcileCheckDeps): Promise<SweepPart> {
  const part = empty();
  let listed: Awaited<ReturnType<ReconcileCheckDeps['alerts']['listOpen']>>;
  try {
    listed = await deps.alerts.listOpen(ALERT_LIST_LIMIT);
  } catch (err) {
    return { ...part, failed: `列没处理的提醒没成，合并超过 7 天的历史提醒这一轮不收：${errMessage(err)}` };
  }
  if (listed.truncated) {
    part.unchecked.push(`没处理的提醒太多，只看了前 ${listed.alerts.length} 条，没看到的历史提醒不收`);
  }
  for (const alert of listed.alerts) {
    const prefix = [PR_ALERT_PREFIX, LEDGER_ALERT_PREFIX].find((p) => alert.dedupeKey.startsWith(p));
    if (!prefix) continue;
    part.scanned += 1;
    const pr = parsePrKey(alert.dedupeKey, prefix);
    if (!pr) {
      part.unchecked.push(`提醒 ${alert.dedupeKey} 认不出是哪条 PR，不收`);
      continue;
    }
    if (deps.now().getTime() - alert.createdAt.getTime() < SURELY_RECENT_ALERT_MS) continue;
    let old: boolean;
    try {
      old = await mergedOverSevenDays(deps, pr);
    } catch (err) {
      part.unchecked.push(`提醒 ${alert.dedupeKey} 的 PR 合并时刻没查成，不收：${errMessage(err)}`);
      continue;
    }
    if (old) {
      await resolveOne(deps, part, alert.dedupeKey, '历史事实：PR 已合并超过 7 天，改不了，自动收');
    }
  }
  return part;
}

/**
 * 合了的 PR 对上的单（引擎开的：PR 头分支上有这张单的会话）：这条分支上的会话都有结局、用量不拿 0 冒充、关单那一步写完
 * （单记成做完）。缺的按 PR 报一条，写明哪张单缺什么；不自动补。都齐了（还开着的提醒复查，出了回看窗口也查）就撤。
 */
export async function checkLedgers(deps: ReconcileCheckDeps): Promise<SweepPart> {
  const part = empty();
  const now = deps.now();
  let open: { dedupeKey: string; createdAt: Date }[] | null = null;
  try {
    const listed = await deps.alerts.listOpen(ALERT_LIST_LIMIT);
    open = listed.alerts.filter((a) => a.dedupeKey.startsWith(LEDGER_ALERT_PREFIX));
    if (listed.truncated) {
      part.unchecked.push(
        `没处理的提醒太多，记账核对这一轮只看了前 ${listed.alerts.length} 条，没看到的不撤`,
      );
    }
  } catch (err) {
    part.unchecked.push(`列没处理的提醒没成，记账核对的旧提醒这一轮不复查、不撤：${errMessage(err)}`);
  }
  // 合并超过 7 天的不再复查（交给 retireHistoricalFactAlerts 撤）；读不到合并时刻的照原样复查，没查成由它记
  const historical = new Set<string>();
  for (const a of open ?? []) {
    const pr = parseLedgerKey(a.dedupeKey);
    if (!pr || now.getTime() - a.createdAt.getTime() < SURELY_RECENT_ALERT_MS) continue;
    try {
      if (await mergedOverSevenDays(deps, pr)) historical.add(a.dedupeKey);
    } catch {
      // 不跳过
    }
  }
  const named = (open ?? []).flatMap((a) => {
    const pr = historical.has(a.dedupeKey) ? null : parseLedgerKey(a.dedupeKey);
    return pr ? [pr] : [];
  });
  let ledgers: MergedPrLedger[];
  try {
    ledgers = await deps.ledgers({ since: new Date(now.getTime() - MERGED_PR_LOOKBACK_MS), prs: named });
  } catch (err) {
    return { ...part, failed: `读合了的 PR 和会话记账没成：${errMessage(err)}` };
  }

  const byPr = new Map<string, MergedPrLedger[]>();
  for (const l of ledgers) {
    const key = ledgerAlertKey(l.owner, l.name, l.prNumber);
    byPr.set(key, [...(byPr.get(key) ?? []), l]);
  }
  const hold = new Set<string>();
  const clear = new Set<string>();
  for (const [dedupeKey, list] of byPr) {
    const first = list[0];
    if (!first) continue;
    part.scanned += 1;
    if (now.getTime() - first.prUpdatedAt.getTime() < LEDGER_GRACE_MS) {
      hold.add(dedupeKey);
      continue;
    }
    const slug = `${first.owner}/${first.name}`;
    const lines = list.flatMap((l) => ledgerGaps(l).map((g) => `- 单 #${l.issueNumber}：${g}`));
    if (lines.length === 0) {
      clear.add(dedupeKey);
      continue;
    }
    hold.add(dedupeKey);
    try {
      await deps.alerts.raise({
        dedupeKey,
        level: 'alert',
        taskId: list.length === 1 ? first.taskId : null,
        title: clip(`合了的 PR 记账不全：${slug}#${first.prNumber}`, 300),
        body: [
          `PR 合进去了，对上的单记账不全（不自动补：补账要从会话记录重算）：`,
          ...lines,
          '都补齐了这条自己撤。',
        ].join('\n'),
        link: `https://github.com/${slug}/pull/${first.prNumber}`,
      });
      part.found += 1;
      deps.log('info', '每小时对账：合了的 PR 记账不全', { dedupeKey, gaps: lines });
    } catch (err) {
      part.unchecked.push(`${dedupeKey} 记账不全，报提醒没报成：${errMessage(err)}`);
    }
  }

  for (const alert of open ?? []) {
    if (hold.has(alert.dedupeKey) || historical.has(alert.dedupeKey)) continue;
    if (clear.has(alert.dedupeKey)) {
      await resolveOne(deps, part, alert.dedupeKey, '会话结局、用量、关单都记齐了');
    } else if (!byPr.has(alert.dedupeKey)) {
      if (!parseLedgerKey(alert.dedupeKey)) {
        part.unchecked.push(`提醒 ${alert.dedupeKey} 认不出是哪条 PR，不撤`);
        continue;
      }
      await resolveOne(deps, part, alert.dedupeKey, '镜像里这条 PR 不再是已合并、或对不上单了');
    }
  }
  return part;
}

/** 额度读数过期（从没读成、超过 30 分钟没读成、上游数冻住）。后面是池编号；读新了自己撤。 */
export const QUOTA_ALERT_PREFIX = 'reconcile:quota:';

export function quotaAlertKey(poolId: string): string {
  return `${QUOTA_ALERT_PREFIX}${poolId}`;
}

/**
 * 每个在用的账号池额度读数不超过 30 分钟（设计 §6，#76）：定时读额度（jobs/quota-read.ts）自己对「连着两轮没读成」报警，
 * 这里是兜底——它没在跑、跑了没写库、或上游数冻住，读数照样会旧，只有按「库里最近读成时刻」查才看得见。
 * 在用 = 渠道开着、有路由挂在它上面、没过期；关掉的、没路由用的、过期了的池读不到是应该的，不报。
 * 额度配置 notRead 里的池不查（没有这种数据）：开着的旧提醒撤掉，不再报读数过期。
 */
export async function checkQuotaFreshness(deps: ReconcileCheckDeps): Promise<SweepPart> {
  const part = empty();
  const now = deps.now();
  let notRead = new Set<string>();
  if (deps.quotaNotRead) {
    try {
      notRead = new Set(await deps.quotaNotRead());
    } catch (err) {
      return { ...part, failed: `读额度配置里不读的池没成，这一轮不查也不撤：${errMessage(err)}` };
    }
  }
  let pools: Awaited<ReturnType<ReconcileCheckDeps['quotaPools']>>;
  try {
    pools = await deps.quotaPools(now);
  } catch (err) {
    return { ...part, failed: `读额度表没成，额度读数新不新鲜这一轮没查：${errMessage(err)}` };
  }
  let open: Set<string> | null = null;
  try {
    const listed = await deps.alerts.listOpen(ALERT_LIST_LIMIT);
    open = new Set(listed.alerts.map((a) => a.dedupeKey).filter((k) => k.startsWith(QUOTA_ALERT_PREFIX)));
    if (listed.truncated) {
      part.unchecked.push(
        `没处理的提醒太多，额度核对这一轮只看了前 ${listed.alerts.length} 条，没看到的不撤`,
      );
    }
  } catch (err) {
    part.unchecked.push(`列没处理的提醒没成，额度读数的旧提醒这一轮不撤：${errMessage(err)}`);
  }

  const overdue = new Set<string>();
  for (const p of pools) {
    if (notRead.has(p.poolId)) continue;
    if (
      !p.channelEnabled ||
      p.routeCount === 0 ||
      (p.expiresAt !== null && p.expiresAt.getTime() <= now.getTime())
    )
      continue;
    part.scanned += 1;
    if (!p.readOverdue) continue;
    const dedupeKey = quotaAlertKey(p.poolId);
    overdue.add(dedupeKey);
    const last = p.lastReadOkAt
      ? `最近一次读成是 ${p.lastReadOkAt.toISOString()}（${Math.round((now.getTime() - p.lastReadOkAt.getTime()) / 60_000)} 分钟前）`
      : '从没读成过';
    const frozen =
      p.lastReadOkAt && p.dataAt && now.getTime() - p.dataAt.getTime() > QUOTA_STALE_AFTER_MS
        ? `；读是读成了，但上游数据本身停在 ${p.dataAt.toISOString()}`
        : '';
    try {
      await deps.alerts.raise({
        dedupeKey,
        level: 'alert',
        taskId: null,
        title: clip(`账号池额度读数过期：${p.poolId}`, 300),
        body: [
          `${p.poolId}（渠道 ${p.channelName}）${last}${frozen}，超过 30 分钟，调度不会把它当「还够」。`,
          '先看引擎的 quota-read 定时任务有没有在跑、这个池最近一次为什么没读成；读新了这条自己撤。',
        ].join('\n'),
      });
      part.found += 1;
      deps.log('info', '每小时对账：账号池额度读数过期', { poolId: p.poolId, lastReadOkAt: p.lastReadOkAt });
    } catch (err) {
      part.unchecked.push(`${dedupeKey} 额度读数过期，报提醒没报成：${errMessage(err)}`);
    }
  }
  for (const dedupeKey of open ?? []) {
    if (overdue.has(dedupeKey)) continue;
    const poolId = dedupeKey.slice(QUOTA_ALERT_PREFIX.length);
    const why = notRead.has(poolId)
      ? '额度配置写明不读这个池（没有这种数据），不再报读数过期'
      : '读新了，或这个池不再在用';
    await resolveOne(deps, part, dedupeKey, why);
  }
  return part;
}
