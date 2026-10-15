// 每日简报（引擎 jobs/daily-brief.ts，每天 08:30 北京时间一条）要读的库：上线的提交对应哪些 PR、开单时刻、开着的要你拍和卡住报警、
// 昨天停下的单；以及看门狗、巡检判「今天的简报送到没」要的事实。只读。
// 改这里之前必须知道：
// - 简报是一行提醒（键 feishu:brief:<北京日期>，日报级），驾驶舱后端照推送规则马上推飞书（feishu-push.ts），送达记在 notification_deliveries。
// - 开单时刻用 tasks.created_at（引擎拉单、本机 issue:new --local 登记时建），PR 正文 Closes 的单（pull_requests.issue_refs）里取最早的；
//   一张单都对不上的 PR 不进「开单→上线」的中位（不拿开 PR 的时刻顶，那会把中位算短）。
// - 读不到照抛，不拿空列表顶。
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import {
  notificationDeliveries,
  notifications,
  pullRequests,
  repos,
  scheduleRuns,
  stateChanges,
  tasks,
} from '../schema/index.ts';
import {
  FEISHU_BRIEF_KEY_PREFIX,
  FEISHU_PUSH_CHANNEL,
  FEISHU_PUSH_TARGET,
  REMIND_KEY_PREFIX,
} from './feishu-push.ts';

/** 定时任务编号（登记表 scheduled_jobs 上的）。 */
export const DAILY_BRIEF_JOB_ID = 'daily-brief';

/** 这一天（北京日期 YYYY-MM-DD）的简报那一行的键。 */
export const dailyBriefKey = (day: string): string => `${FEISHU_BRIEF_KEY_PREFIX}${day}`;

export interface BriefPull {
  number: number;
  title: string | null;
  mergeSha: string;
  /** PR 关的单里最早登记的那张的 tasks.created_at；对不上单是 null。 */
  issueOpenedAt: Date | null;
  /** PR 正文 Closes 的单（pull_requests.issue_refs）；title 是库里登记的单标题，库里没有这张单是 null。没挂单是空数组。 */
  issues: { number: number; title: string | null }[];
}

/** 这些合并提交对应的 PR（同一个仓）。没对上的提交不在结果里。 */
export async function pullsByMergeSha(db: Db, repoId: string, shas: readonly string[]): Promise<BriefPull[]> {
  if (shas.length === 0) return [];
  const rows = await db
    .select({
      number: pullRequests.number,
      title: pullRequests.title,
      mergeSha: pullRequests.mergeSha,
      issueRefs: pullRequests.issueRefs,
      issueOpenedAt: sql<Date | null>`(select min(t.created_at) from tasks t
        where t.repo_id = ${pullRequests.repoId} and t.issue_number = any(${pullRequests.issueRefs}))`.mapWith(
        pullRequests.mergedAt,
      ),
    })
    .from(pullRequests)
    .where(and(eq(pullRequests.repoId, repoId), inArray(pullRequests.mergeSha, [...shas])));
  const refs = [...new Set(rows.flatMap((r) => r.issueRefs))];
  const titles = new Map<number, string>();
  if (refs.length > 0) {
    const ts = await db
      .select({ number: tasks.issueNumber, title: tasks.title })
      .from(tasks)
      .where(and(eq(tasks.repoId, repoId), inArray(tasks.issueNumber, refs)));
    for (const t of ts) titles.set(t.number, t.title);
  }
  return rows
    .filter((r): r is typeof r & { mergeSha: string } => r.mergeSha !== null)
    .map((r) => ({
      number: r.number,
      title: r.title,
      mergeSha: r.mergeSha,
      issueOpenedAt: r.issueOpenedAt,
      issues: [...r.issueRefs]
        .sort((a, b) => a - b)
        .map((n) => ({ number: n, title: titles.get(n) ?? null })),
    }));
}

/** 按名字找受管的仓（fleet-dao 自己）；没有是 null。 */
export async function repoByName(
  db: Db,
  name: string,
): Promise<{ id: string; owner: string; name: string } | null> {
  const [row] = await db
    .select({ id: repos.id, owner: repos.owner, name: repos.name })
    .from(repos)
    .where(eq(repos.name, name))
    .orderBy(asc(repos.owner))
    .limit(2);
  return row ?? null;
}

export interface BriefNote {
  id: string;
  dedupeKey: string;
  title: string;
  link: string | null;
  createdAt: Date;
  /** 挂了任务的：那张单（仓 owner/name、单号）。 */
  issue: { repo: string; number: number } | null;
}

/** 开着的要你拍（decision）、卡住报警（alert，再提醒 remind: 不算）或日报（daily），老的在前。 */
export async function openBriefNotes(db: Db, level: 'decision' | 'alert' | 'daily'): Promise<BriefNote[]> {
  const rows = await db
    .select({
      id: notifications.id,
      dedupeKey: notifications.dedupeKey,
      title: notifications.title,
      link: notifications.link,
      createdAt: notifications.createdAt,
      issueNumber: tasks.issueNumber,
      owner: repos.owner,
      name: repos.name,
    })
    .from(notifications)
    .leftJoin(tasks, eq(tasks.id, notifications.taskId))
    .leftJoin(repos, eq(repos.id, tasks.repoId))
    .where(
      and(
        eq(notifications.level, level),
        isNull(notifications.resolvedAt),
        sql`not starts_with(${notifications.dedupeKey}, ${REMIND_KEY_PREFIX})`,
      ),
    )
    .orderBy(asc(notifications.createdAt), asc(notifications.id));
  return rows.map((r) => ({
    id: r.id,
    dedupeKey: r.dedupeKey,
    title: r.title,
    link: r.link,
    createdAt: r.createdAt,
    issue:
      r.issueNumber !== null && r.owner !== null && r.name !== null
        ? { repo: `${r.owner}/${r.name}`, number: r.issueNumber }
        : null,
  }));
}

export interface BriefStoppedTask {
  repo: string;
  number: number;
  title: string;
  state: 'failed' | 'stalled';
  lastProblem: string | null;
}

/** [from, to) 里转成 failed / stalled、现在还是这个状态的单。 */
export async function stoppedTasksBetween(db: Db, from: Date, to: Date): Promise<BriefStoppedTask[]> {
  const rows = await db
    .selectDistinct({
      owner: repos.owner,
      name: repos.name,
      number: tasks.issueNumber,
      title: tasks.title,
      state: tasks.state,
      lastProblem: tasks.lastProblem,
    })
    .from(tasks)
    .innerJoin(repos, eq(repos.id, tasks.repoId))
    .innerJoin(stateChanges, eq(stateChanges.taskId, tasks.id))
    .where(
      and(
        inArray(tasks.state, ['failed', 'stalled']),
        sql`${stateChanges.toState} = ${tasks.state}::text`,
        gte(stateChanges.at, from),
        lt(stateChanges.at, to),
      ),
    )
    .orderBy(asc(repos.name), asc(tasks.issueNumber));
  return rows.map((r) => ({
    repo: `${r.owner}/${r.name}`,
    number: r.number,
    title: r.title,
    state: r.state as 'failed' | 'stalled',
    lastProblem: r.lastProblem,
  }));
}

/** 看门狗、巡检判「今天的简报送到没」要的事实。 */
export interface DailyBriefStatus {
  day: string;
  /** 今天那一行简报；没建是 null。 */
  notification: {
    id: string;
    createdAt: Date;
    deliveredAt: Date | null;
    attempts: number;
    lastError: string | null;
  } | null;
  /** since 之后最近一轮简报定时任务；没跑过是 null。 */
  run: { outcome: string | null; why: string | null; startedAt: Date } | null;
}

export async function dailyBriefStatus(db: Db, day: string, since: Date): Promise<DailyBriefStatus> {
  const [[note], [run]] = await Promise.all([
    db
      .select({
        id: notifications.id,
        createdAt: notifications.createdAt,
        deliveredAt: notificationDeliveries.deliveredAt,
        attempts: sql<number>`coalesce(${notificationDeliveries.attempts}, 0)`,
        lastError: notificationDeliveries.lastError,
      })
      .from(notifications)
      .leftJoin(
        notificationDeliveries,
        and(
          eq(notificationDeliveries.notificationId, notifications.id),
          eq(notificationDeliveries.channel, FEISHU_PUSH_CHANNEL),
          eq(notificationDeliveries.target, FEISHU_PUSH_TARGET),
        ),
      )
      .where(eq(notifications.dedupeKey, dailyBriefKey(day))),
    db
      .select({ outcome: scheduleRuns.outcome, why: scheduleRuns.why, startedAt: scheduleRuns.startedAt })
      .from(scheduleRuns)
      .where(and(eq(scheduleRuns.job, DAILY_BRIEF_JOB_ID), gte(scheduleRuns.startedAt, since)))
      .orderBy(desc(scheduleRuns.startedAt), desc(scheduleRuns.id))
      .limit(1),
  ]);
  return {
    day,
    notification: note ? { ...note, attempts: Number(note.attempts) } : null,
    run: run ?? null,
  };
}

/** 北京时间（UTC+8，不过夏令时）。 */
const BEIJING_MS = 8 * 60 * 60_000;
/** 简报每天几点（北京时间，从零点起的分钟）：08:30。 */
export const DAILY_BRIEF_AT_MINUTES = 8 * 60 + 30;
/** 到点后多久还没送到才算没送到（定时器误差、推送退避的余量）：30 分钟，即 09:00。 */
export const DAILY_BRIEF_GRACE_MINUTES = 30;

/** at 那一刻的北京日期（YYYY-MM-DD）和那一天北京零点（UTC 时刻）。 */
export function beijingDay(at: Date): { day: string; start: Date } {
  const day = new Date(at.getTime() + BEIJING_MS).toISOString().slice(0, 10);
  return { day, start: new Date(Date.parse(`${day}T00:00:00Z`) - BEIJING_MS) };
}

/**
 * 今天的简报送到没（看门狗和指挥官巡检同一份判法；巡检脚本在仓外跑，它的 SQL 照这里写）。没到 09:00 不判；
 * 没跑、没做成、没建、没推到飞书各回一句话；都好了回 null。
 */
export function dailyBriefProblem(s: DailyBriefStatus, now: Date): string | null {
  const { start } = beijingDay(now);
  const due = start.getTime() + (DAILY_BRIEF_AT_MINUTES + DAILY_BRIEF_GRACE_MINUTES) * 60_000;
  if (now.getTime() < due) return null;
  if (!s.run) return `今天（${s.day}）08:30 的每日简报没跑：定时任务 ${DAILY_BRIEF_JOB_ID} 今天一轮都没起`;
  if (s.run.outcome === null) return null;
  if (s.run.outcome === 'failed') return `今天（${s.day}）的每日简报没做成：${s.run.why ?? '没写原因'}`;
  if (!s.notification) return `今天（${s.day}）的每日简报没建出来（键 ${dailyBriefKey(s.day)} 没有）`;
  if (!s.notification.deliveredAt) {
    return `今天（${s.day}）的每日简报没推到飞书：试了 ${s.notification.attempts} 次${
      s.notification.lastError ? `，最近一次：${s.notification.lastError}` : '，一次都没试过'
    }`;
  }
  return null;
}
