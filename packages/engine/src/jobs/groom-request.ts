// 叫一次临时指挥官整理待办的入口（母单 #1335 第 3 片，#1338）：引擎拉单一轮自己叫（source=auto）、命令行叫（source=cli）走这里，
// 驾驶舱按钮（source=http）在后端 packages/api/src/groom-routes.ts，判能不能叫的是同一个函数（shared 的 judgeGroomRequest）：
// 总开关关着、已经有一次在排队或在做、这个仓 24 小时内次数用完、（自动叫）距上次不到 6 小时，都明确拒绝并说明。
// 这里只记一条「点了」(groom.request)，真正整理是引擎的 jobs/groom.ts 每几秒看一眼后接手。

import {
  foldGroomRequests,
  GROOM_WINDOW_MS,
  type GroomAuditRow,
  type GroomRefusalReason,
  type GroomSource,
  groomQuota,
  judgeGroomRequest,
} from '@fleet-dao/shared';

export interface GroomRequestDeps {
  /** since 之后 groom 的操作记录（real：@fleet-dao/db 的 groomAuditRows）。读不到照抛：不当成没人叫过。 */
  rows(since: Date): Promise<GroomAuditRow[]>;
  /** 引擎总开关此刻的样子。读不到照抛。 */
  engineMaster(): Promise<{ on: true } | { on: false; why: string }>;
  /** 记一条「点了」。写不进照抛。 */
  record(input: {
    requestId: string;
    repo: string;
    source: GroomSource;
    reason: string;
    at: Date;
  }): Promise<void>;
  now(): Date;
  newId(): string;
}

export type GroomRequestOutcome =
  | { ok: true; requestId: string; used: number; remainingAfter: number }
  | { ok: false; reason: GroomRefusalReason; why: string };

/** 判能不能叫，能就记一条「点了」。拒了不记（页面和日志里只留真排上队的）。 */
export async function requestGroom(
  deps: GroomRequestDeps,
  input: { repo: string; source: Exclude<GroomSource, 'http'>; reason: string },
): Promise<GroomRequestOutcome> {
  const now = deps.now();
  const { requests } = foldGroomRequests(await deps.rows(new Date(now.getTime() - GROOM_WINDOW_MS)), now);
  const verdict = judgeGroomRequest({
    repo: input.repo,
    source: input.source,
    now,
    requests,
    engine: await deps.engineMaster(),
  });
  if (!verdict.ok) return verdict;
  const requestId = deps.newId();
  await deps.record({ requestId, repo: input.repo, source: input.source, reason: input.reason, at: now });
  return { ok: true, requestId, used: verdict.used, remainingAfter: verdict.remainingAfter };
}

/** 一个仓的拉单一轮走完时，和「要不要叫整理」有关的几个数。 */
export interface AutoGroomFacts {
  /** 这个仓的候选走完以后，这一轮还有空位（本轮条数、在跑、每小时、熔断都没用完）。 */
  spare: boolean;
  /** 这一轮在这个仓起了几条任务。 */
  started: number;
  /** 待办里还有候选可整理：缺东西、规模太大、失败过多的单加准入后没起的单。 */
  backlog: number;
  /** 从没整理过的老单（开单早于「让 AI 接活」打开、没贴「整理过」「交给引擎」「待补」「要人拍」）。 */
  ungroomedOld: number;
}

export type AutoGroomWhy = 'ungroomed_old' | 'idle';

/**
 * 拉单一轮的结尾要不要叫一次整理（只判触发条件；6 小时间隔、每日次数、锁、总开关由 requestGroom 判）：
 * - 有从没整理过的老单：叫（它们不整理就进不了候选，不必等空闲，指挥官 2026-10-08 补）；
 * - 否则有空位、这一轮在这个仓一条都没起、待办候选还有：叫。
 */
export function autoGroomWhy(f: AutoGroomFacts): AutoGroomWhy | null {
  if (f.ungroomedOld > 0) return 'ungroomed_old';
  if (f.spare && f.started === 0 && f.backlog > 0) return 'idle';
  return null;
}

export const AUTO_GROOM_TEXT: Record<AutoGroomWhy, string> = {
  ungroomed_old: '待办里有从没整理过的老单，它们不整理就进不了引擎的候选',
  idle: '引擎有空位、挑不出可做的单，待办里还有候选',
};

/** 今天还剩几次（给命令行打印）。 */
export function remainingText(rows: GroomAuditRow[], repo: string, now: Date): string {
  const { requests } = foldGroomRequests(rows, now);
  const q = groomQuota(requests, repo, now);
  return `最近 24 小时已整理 ${q.used} 次，还剩 ${q.remaining} 次（每天最多 ${q.max} 次）`;
}
