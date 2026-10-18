// 看门狗：running + executor=engine + 没有开着的会话（runs.ended_at 为空的是 0）+ 任务行太久没动。
// 引擎自测（selfCheck）那一段本来也没有会话：自测活动限时以内不报。
// 换路由续之后睡在 pauseForRoute 里就是这个样子（#2392）：doing 停在「换一条路由带上进度续一次」，
// updated_at 不再走，工作流仍 Running，拉单把它算进在干活。这里只报警、条件没了自己撤，不替工作流收场
// （收场是工作流自己停下等人，或人点「继续」叫醒之后要么起会话要么停下）。
// 正文不写「已经 N 分钟」：看门狗 5 分钟一轮，每轮变一句就会改卡。

import { IDLE_RUNNING_STALE_MS, isIdleRunningStale } from '@fleet-dao/core/idle-running';

export { IDLE_RUNNING_STALE_MS } from '@fleet-dao/core/idle-running';

import { errMessage } from '@fleet-dao/shared/util';
import { SELF_CHECK_ACTIVITY_MS, SELF_CHECK_DOING } from '../self-check-budget.ts';
import { clip, stamp } from './reconcile-common.ts';

/** 任务行这么久没动，又没有开着的会话，就报。和「单在干活却没有会话 20 分钟没动」同一档。 */

export const IDLE_RUNNING_ALERT_PREFIX = 'watchdog:idle-running:';

/** 提醒点进去看驾驶舱首页（单在画布上）。 */
export const IDLE_RUNNING_LINK = '/';

export function idleRunningAlertKey(taskId: string): string {
  return `${IDLE_RUNNING_ALERT_PREFIX}${taskId}`;
}

export interface IdleRunningFact {
  taskId: string;
  owner: string;
  name: string;
  issueNumber: number;
  /** 调用方只该把 running 的行送进来；不是 running 的判不报。 */
  state: string;
  /** 不是 engine 的不报（本机领的没有开着的 runs 是常态）。 */
  executor: string;
  /** runs.ended_at 为空的行数。 */
  openRuns: number;
  updatedAt: Date | null;
  doing: string | null;
}

export type IdleRunningVerdict = { alert: false } | { alert: true; key: string; title: string; body: string };

/** 进度停在引擎自测（selfCheck）上：这一段本来就没有会话，任务行也不动，直到活动收场。 */
function inSelfCheck(row: IdleRunningFact): boolean {
  return row.doing?.includes(SELF_CHECK_DOING) === true;
}

/**
 * 这条算不算「在干活但没有开着的会话、任务行过旧」。
 * 四条都要：state=running、executor=engine、openRuns=0、updatedAt 空或早于现在减去 IDLE_RUNNING_STALE_MS。
 * updatedAt 空＝从没写过快照，不算刚更新。
 * 进度停在自测上的：自测活动限时（SELF_CHECK_ACTIVITY_MS）以内是正常在排队或跑测试，不报；过了限时还停在那儿才报，正文写明。
 */
export function judgeIdleRunning(
  row: IdleRunningFact,
  now: Date,
  staleMs = IDLE_RUNNING_STALE_MS,
): IdleRunningVerdict {
  if (!isIdleRunningStale(row, now, staleMs)) return { alert: false };
  const selfCheck = inSelfCheck(row);
  const ref = `${row.owner}/${row.name}#${row.issueNumber}`;
  const when = row.updatedAt ? `任务行停在 ${stamp(row.updatedAt)}` : '任务行从没写过更新时刻';
  const doing = row.doing?.trim() ? row.doing.trim() : '（没写在干什么）';
  const hint = selfCheck
    ? `停在引擎自测上，已经过了自测活动的限时（${Math.round(SELF_CHECK_ACTIVITY_MS / 60_000)} 分钟）还没往下走：看 Temporal 上 selfCheck 活动最后一次心跳的阶段（queue / test / tsc）和最后输出时刻。`
    : '先看是不是换路由续之后睡在等选路里。点「继续」或 fleet-api task continue 会叫醒它：选得出就起会话，选不出就停下等人。还这样过了 20 分钟这条还在。';
  return {
    alert: true,
    key: idleRunningAlertKey(row.taskId),
    title: clip(`在干活但没有开着的会话：${ref}`, 300),
    body: [
      `${ref} 状态是 running、执行者是引擎，没有 ended_at 为空的会话。${when}。`,
      `进度：${doing}`,
      hint,
    ].join('\n'),
  };
}

export interface IdleRunningWatchDeps {
  /** state=running 且 executor=engine 的行，带开着的会话数。读不到照抛。 */
  tasks(): Promise<IdleRunningFact[]>;
  alerts: {
    openByPrefix(prefix: string): Promise<{ dedupeKey: string; title: string; body: string }[]>;
    raise(input: { dedupeKey: string; title: string; body: string; link: string }): Promise<void>;
    resolve(input: { dedupeKey: string; why: string }): Promise<'ok' | 'already_resolved' | 'not_found'>;
  };
  log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

export interface IdleRunningWatchResult {
  scanned: number;
  found: number;
  problems: string[];
}

/** 报该报的、条件没了的撤掉。不抛，没做成的记进 problems。 */
export async function watchIdleRunning(
  deps: IdleRunningWatchDeps,
  now: Date,
): Promise<IdleRunningWatchResult> {
  const out: IdleRunningWatchResult = { scanned: 0, found: 0, problems: [] };
  let rows: IdleRunningFact[];
  try {
    rows = await deps.tasks();
  } catch (err) {
    out.problems.push(`读在干活的引擎任务没成，没有开着会话这一轮没查：${errMessage(err)}`);
    return out;
  }
  let open: Map<string, { title: string; body: string }> | null = null;
  try {
    open = new Map(
      (await deps.alerts.openByPrefix(IDLE_RUNNING_ALERT_PREFIX)).map((a) => [a.dedupeKey, a] as const),
    );
  } catch (err) {
    out.problems.push(`列不了「在干活但没有会话」开着的提醒（好了的这一轮撤不了）：${errMessage(err)}`);
  }
  const wanted = new Set<string>();
  for (const row of rows) {
    if (row.state !== 'running' || row.executor !== 'engine') continue;
    out.scanned += 1;
    const verdict = judgeIdleRunning(row, now);
    if (!verdict.alert) continue;
    wanted.add(verdict.key);
    out.found += 1;
    const was = open?.get(verdict.key);
    if (was && was.title === verdict.title && was.body === verdict.body) continue;
    try {
      await deps.alerts.raise({
        dedupeKey: verdict.key,
        title: verdict.title,
        body: verdict.body,
        link: IDLE_RUNNING_LINK,
      });
      deps.log('warn', '看门狗：在干活但没有开着的会话', { taskId: row.taskId, issue: row.issueNumber });
    } catch (err) {
      out.problems.push(`${verdict.key} 报提醒没报成：${errMessage(err)}`);
    }
  }
  for (const dedupeKey of open?.keys() ?? []) {
    if (wanted.has(dedupeKey)) continue;
    const why = '这张单不再是「在干活但没有开着的会话」（有会话了、状态变了，或任务行更新了）';
    try {
      if ((await deps.alerts.resolve({ dedupeKey, why })) === 'ok') {
        deps.log('info', '看门狗：撤了一条', { dedupeKey, why });
      }
    } catch (err) {
      out.problems.push(`提醒 ${dedupeKey} 没撤掉：${errMessage(err)}`);
    }
  }
  return out;
}
