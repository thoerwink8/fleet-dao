// 每小时对账的核对（design 第六节第 4 层，specs/293-对账三处核对）：合了的 PR 都记了账。
// 额度读数新鲜度（第三处，不超过 30 分钟）搬去看门狗了（jobs/watchdog-quota.ts，决定 0093）：它每 5 分钟一轮，比这一小时一轮更早看得见。
// 各返回一个 SweepPart，由 hourly-reconcile 的 combineParts 并进这一轮。提醒自己报、自己撤，不进 alert-sweep 的判法表。
// 记账对不上只报、不补：补账要从会话记录重算，不在这里猜。
// 「开着的单都有着落」那一处（一张单一个需求工作流，要补拉接活）随 Fusion 一起删了（#556）：三段流程的单是任务工作流，
// 状态只在 Temporal 一份，不靠这一处查；它留下的旧提醒由 retireWorkflowAlerts 撤掉。

import { LOCAL_LABEL } from '@fleet-dao/conventions';
import type { LedgerSession, LocalOrphan, MergedPrLedger } from '@fleet-dao/db';
import {
  isEngineCiTimingsPr,
  type MergedPrAuditReport,
  type MergedPrFinding,
  type RepoRef,
} from '@fleet-dao/github';
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
 * 例外：引擎自己的耗时表 PR（isEngineCiTimingsPr）本来就不走队列，不报；已经开着的下一轮撤掉。
 * 例外：合并人是「引擎」、合并记录后来记上了的（cleanPrs：自动合并是 GitHub 合的，记录要等任务工作流看到合并才写，
 * 对账赶在中间看见就报了，#2813），撤掉；为复查它，回看窗口往回延到最老那条开着的提醒，最多 7 天。
 * （#445 删过、#440 又办回来：合并队列其实已开，删掉的判断「没开」不准。）
 */
export const PR_ALERT_PREFIX = 'reconcile:pr:';
/** 撤耗时表误报时写的原因（处理人是对账，RECONCILE_ACTOR）。 */
export const CI_TIMINGS_SKIP_WHY = '引擎自己的耗时表 PR，不走合并队列';
/** 撤「合并记录晚记」那种时写的原因。 */
export const MERGE_RECORD_LANDED_WHY =
  '合并人是「引擎」，账上已经有合并记录：合并后记账晚了一步，条件不再成立';
/**
 * 已经开着、下一轮可能已经出了 26 小时回看的误报：对账按键撤，不靠再看见那张 PR。
 * #2175 是引擎机器人自己开、自己合的耗时表。
 */
const KNOWN_CI_TIMINGS_FALSE_ALARMS = ['reconcile:pr:thoerwink8/fleet-dao#2175'] as const;
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

function findingIsEngineCiTimings(f: MergedPrFinding): boolean {
  return isEngineCiTimingsPr({
    headRef: f.headRef ?? '',
    openedByEngine: f.openedByEngine === true,
    mergedByEngine: f.mergedByEngine === true,
  });
}

/**
 * 按 PR 归拢要报的两种（合并人不是「引擎」、没有合并记录）。
 * 耗时表（isEngineCiTimingsPr）不归进要报的，号记在 timings 里，调用方撤掉已经开着的。
 */
function prProblems(findings: readonly MergedPrFinding[]): {
  problems: Map<number, string[]>;
  timings: number[];
} {
  const problems = new Map<number, string[]>();
  const timings = new Set<number>();
  for (const f of findings) {
    if (f.kind !== 'not_merged_by_engine' && f.kind !== 'no_merge_record') continue;
    if (findingIsEngineCiTimings(f)) {
      timings.add(f.number);
      continue;
    }
    problems.set(f.number, [...(problems.get(f.number) ?? []), f.text]);
  }
  return { problems, timings: [...timings] };
}

/** 开着才撤。读不到记没查成，不当成已经撤了。 */
async function retireOpenCiTimingsAlert(deps: ReconcileCheckDeps, part: SweepPart, dedupeKey: string) {
  let row: Awaited<ReturnType<ReconcileCheckDeps['alerts']['byKey']>>;
  try {
    row = await deps.alerts.byKey(dedupeKey);
  } catch (err) {
    part.unchecked.push(`提醒 ${dedupeKey} 没读成，这一轮不撤：${errMessage(err)}`);
    return;
  }
  if (!row || row.resolvedAt !== null) return;
  await resolveOne(deps, part, dedupeKey, CI_TIMINGS_SKIP_WHY);
}

/**
 * 开着的 reconcile:pr 提醒，按仓分：PR 号 → 开的时刻。列不出、列不全照实记没查成，这一轮只按 26 小时回看、不撤看不到的。
 */
async function openPrAlertsByRepo(
  deps: ReconcileCheckDeps,
  part: SweepPart,
): Promise<Map<string, Map<number, Date>>> {
  const byRepo = new Map<string, Map<number, Date>>();
  let listed: Awaited<ReturnType<ReconcileCheckDeps['alerts']['listOpen']>>;
  try {
    listed = await deps.alerts.listOpen(ALERT_LIST_LIMIT);
  } catch (err) {
    part.unchecked.push(
      `列没处理的提醒没成，合并记录后来记上了的 reconcile:pr 这一轮不撤：${errMessage(err)}`,
    );
    return byRepo;
  }
  if (listed.truncated) {
    part.unchecked.push(`没处理的提醒太多，只看了前 ${listed.alerts.length} 条，没看到的 reconcile:pr 不撤`);
  }
  for (const alert of listed.alerts) {
    if (!alert.dedupeKey.startsWith(PR_ALERT_PREFIX)) continue;
    const pr = parsePrKey(alert.dedupeKey, PR_ALERT_PREFIX);
    if (!pr) continue;
    const slug = `${pr.owner}/${pr.name}`;
    const numbers = byRepo.get(slug) ?? new Map<number, Date>();
    numbers.set(pr.number, alert.createdAt);
    byRepo.set(slug, numbers);
  }
  return byRepo;
}

/**
 * 每个受管的仓，最近 26 小时合了的 PR：镜像补上算发现（记账那一部分靠镜像认合了的 PR，放在它前面跑）。我们机器人开的
 * PR 合并人不是「引擎」、或没有合并队列的合并记录按 PR 报一条（#431 就是这么漏的：合并前那几道核对——不落后主线、CI
 * 全绿、人闸——可能没走）。条件就是「发生过」，只报一次、不自动撤，要人在驾驶舱点「处理」。
 * 引擎自己的耗时表 PR 不报；这一轮看见的、以及已经开着的 #2175，撤掉。
 * 「引擎」合的、合并记录后来记上了的（cleanPrs），开着的撤掉；回看窗口往回延到这个仓最老那条开着的提醒，好复查到它。
 */
export async function checkMergedPrs(deps: ReconcileCheckDeps): Promise<SweepPart> {
  const part = empty();
  for (const dedupeKey of KNOWN_CI_TIMINGS_FALSE_ALARMS) {
    await retireOpenCiTimingsAlert(deps, part, dedupeKey);
  }
  let repos: RepoRef[];
  try {
    repos = await deps.repos();
  } catch (err) {
    return { ...part, failed: `列受管的仓没成：${errMessage(err)}` };
  }
  const now = deps.now().getTime();
  const baseSince = now - MERGED_PR_LOOKBACK_MS;
  const openPrAlerts = await openPrAlertsByRepo(deps, part);
  for (const repo of repos) {
    const slug = `${repo.owner}/${repo.name}`;
    const open = openPrAlerts.get(slug) ?? new Map<number, Date>();
    // 提醒是 PR 还在回看窗口里时开的：从它开的时刻再往回一个窗口，一定看得见那张 PR。合并超过 7 天的由历史事实那一处收。
    let sinceMs = baseSince;
    for (const createdAt of open.values()) {
      sinceMs = Math.min(
        sinceMs,
        Math.max(createdAt.getTime() - MERGED_PR_LOOKBACK_MS, now - HISTORICAL_FACT_MS),
      );
    }
    const since = new Date(sinceMs);
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
    const planned = prProblems(report.findings);
    const timingsNumbers = new Set([...(report.engineCiTimingsPrs ?? []), ...planned.timings]);
    for (const number of timingsNumbers) {
      await retireOpenCiTimingsAlert(deps, part, prAlertKey(repo.owner, repo.name, number));
    }
    for (const number of new Set(report.cleanPrs ?? [])) {
      if (!open.has(number) || planned.problems.has(number) || timingsNumbers.has(number)) continue;
      await resolveOne(deps, part, prAlertKey(repo.owner, repo.name, number), MERGE_RECORD_LANDED_WHY);
    }
    for (const [number, lines] of planned.problems) {
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
              'CI 全绿、人闸）可能没走。「引擎」合的、合并记录后来记上了，对账自己撤；别的不会自己撤，看过点「处理」。',
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
  return s.outcome === 'done' && recorded && (s.inputTokens ?? 0) + (s.outputTokens ?? 0) === 0;
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

/** 贴了「本机做」超过这么久、又没有还没到期的本机租约，才算没人领。刚好 24 小时不算。 */
export const LOCAL_ORPHAN_MS = 24 * 60 * 60_000;

/** 一张贴着「本机做」的开着的单，加上标签时间线和评论（对账读来的，这里不自己去 GitHub）。 */
export interface LocalLabeledIssue {
  repo: { owner: string; name: string };
  issue: number;
  events: readonly { label: string; action: 'labeled' | 'unlabeled'; at: string; actor?: string | null }[];
  comments: readonly { body: string; at: string }[];
}

/** 还没到期的本机租约用这个键对上单：`owner/name#单号`，仓名大小写不计。 */
export function localLeaseKey(owner: string, name: string, issue: number): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}#${issue}`;
}

/**
 * 时间线里「本机做」现在还贴着的那一次（摘过再贴，认最后一次还贴着的）。
 * 当前没贴着回 null。时刻认不出抛错，不当成没贴。
 */
export function localLabelApplied(
  events: readonly { label: string; action: 'labeled' | 'unlabeled'; at: string; actor?: string | null }[],
): { at: Date; actor: string | null } | null {
  let applied: { at: Date; actor: string | null } | null = null;
  for (const e of events) {
    if (e.label !== LOCAL_LABEL) continue;
    const at = new Date(e.at);
    if (!Number.isFinite(at.getTime())) throw new Error(`「${LOCAL_LABEL}」的标签时刻认不出（${e.at}）`);
    applied = e.action === 'labeled' ? { at, actor: e.actor ?? null } : null;
  }
  return applied;
}

function clipReason(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= 300 ? t : `${t.slice(0, 300)}…`;
}

/** 贴上时刻前 60 秒起、正文里有「本机做」的最后一条评论。没有回 null。时刻认不出的那条跳过。 */
export function localReasonComment(
  comments: readonly { body: string; at: string }[],
  labeledAt: Date,
): string | null {
  const from = labeledAt.getTime() - 60_000;
  let hit: { at: number; body: string } | null = null;
  for (const c of comments) {
    if (!c.body.includes(LOCAL_LABEL)) continue;
    const at = Date.parse(c.at);
    if (!Number.isFinite(at) || at < from) continue;
    if (!hit || at >= hit.at) hit = { at, body: c.body };
  }
  return hit ? clipReason(hit.body) : null;
}

/** 谁贴的，以及留下的原因，合成巡检那一栏的一句话。 */
export function localOrphanReason(actor: string | null, comment: string | null): string {
  const who = actor?.trim() ? actor.trim() : '没认出发起人';
  if (!comment) return `${who} 贴了「${LOCAL_LABEL}」，没有留下原因`;
  return `${who}：${comment}`;
}

/** 贴上多久，给人看的说法。不到 48 小时按小时；再长按天，零头的小时也写上。 */
export function labeledForText(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 48) return `${hours} 小时`;
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest === 0 ? `${days} 天` : `${days} 天 ${rest} 小时`;
}

/**
 * 贴着「本机做」、超过 24 小时、又没有还没到期的本机租约的单。
 * 有租约的、不到（含刚好）24 小时的不列。单上有标签、时间线里却没有还贴着的那一次：抛错，不把这张丢掉。
 */
export function selectLocalOrphans(
  issues: readonly LocalLabeledIssue[],
  leases: ReadonlySet<string>,
  now: Date,
): LocalOrphan[] {
  const out: LocalOrphan[] = [];
  for (const issue of issues) {
    const applied = localLabelApplied(issue.events);
    if (!applied) {
      throw new Error(
        `${issue.repo.owner}/${issue.repo.name}#${issue.issue} 贴着「${LOCAL_LABEL}」，时间线里却没有还贴着的那一次`,
      );
    }
    if (leases.has(localLeaseKey(issue.repo.owner, issue.repo.name, issue.issue))) continue;
    const labeledForMs = now.getTime() - applied.at.getTime();
    if (!(labeledForMs > LOCAL_ORPHAN_MS)) continue;
    out.push({
      repo: `${issue.repo.owner}/${issue.repo.name}`,
      issue: issue.issue,
      labeledForMs,
      labeledFor: labeledForText(labeledForMs),
      reason: localOrphanReason(applied.actor, localReasonComment(issue.comments, applied.at)),
    });
  }
  return out;
}

/**
 * 读贴着「本机做」的开着的单和还没到期的租约，把没人领的写成一份名单。
 * 读不到、判不出都不写（上一份留着）。写成失败记没查成，found 不加。
 */
export async function checkLocalOrphans(
  deps: Pick<ReconcileCheckDeps, 'now' | 'log'> & {
    localLabeled(): Promise<LocalLabeledIssue[]>;
    activeLeases(): Promise<Set<string>>;
    saveLocalOrphans(items: LocalOrphan[]): Promise<void>;
  },
): Promise<SweepPart> {
  const part = empty();
  let issues: LocalLabeledIssue[];
  let leases: Set<string>;
  try {
    [issues, leases] = await Promise.all([deps.localLabeled(), deps.activeLeases()]);
  } catch (err) {
    return { ...part, failed: `本机没人领的单没读成，上一份名单留着：${errMessage(err)}` };
  }
  part.scanned = issues.length;
  let orphans: LocalOrphan[];
  try {
    orphans = selectLocalOrphans(issues, leases, deps.now());
  } catch (err) {
    return { ...part, failed: `本机没人领的单没判成，上一份名单留着：${errMessage(err)}` };
  }
  try {
    await deps.saveLocalOrphans(orphans);
  } catch (err) {
    part.unchecked.push(`本机没人领的名单没写成，上一份留着：${errMessage(err)}`);
    return part;
  }
  part.found = orphans.length;
  if (orphans.length > 0) {
    deps.log('info', '每小时对账：贴了「本机做」超过 24 小时还没人领', {
      n: orphans.length,
      issues: orphans.slice(0, 8).map((o) => `${o.repo}#${o.issue}`),
    });
  }
  return part;
}
