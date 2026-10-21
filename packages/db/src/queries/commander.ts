// 法国指挥官会话（engine/src/jobs/park-triage.ts，#3294 第 2 片）读库的那几样。写操作记录经 recordEngineAudit（queries/session-org.ts）。
// 都是只读；读不到原样抛，调用方记没查成，不当成空。
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import {
  acceptanceCandidateGroups,
  auditLog,
  notifications,
  pullRequests,
  repos,
  routingPurposeModels,
  runs,
  settings,
  taskRounds,
  tasks,
} from '../schema/index.ts';
import {
  acceptanceCandidatesUnknown,
  acceptanceGroupDutiesQuery,
  assertAcceptanceCandidatesReady,
} from './acceptance-candidates.ts';
import type { AcceptanceDutyRow } from './acceptance-duties.ts';
import { allSettledOrThrow } from './all-settled.ts';

/** 指挥官会话的操作记录都记在这个 target 下（和 groom 一样一个 target 一类事）。 */
export const COMMANDER_AUDIT_TARGET = 'commander';

export interface CommanderAuditRow {
  at: Date;
  action: string;
  actorId: string;
  after: unknown;
  ok: boolean;
}

/** since 之后（含）target=commander 的全部操作记录。 */
export async function commanderAuditRows(db: Db, since: Date): Promise<CommanderAuditRow[]> {
  return db
    .select({
      at: auditLog.at,
      action: auditLog.action,
      actorId: auditLog.actorId,
      after: auditLog.after,
      ok: auditLog.ok,
    })
    .from(auditLog)
    .where(and(eq(auditLog.target, COMMANDER_AUDIT_TARGET), gte(auditLog.at, since)))
    .orderBy(asc(auditLog.at));
}

/** 设置里某一行的原始值。没设过回 null（和值是 JSON null 分开：这里没有行才是 null，行里的 null 回 `{ value: null }`）。 */
export async function readSettingValue(db: Db, key: string): Promise<{ value: unknown } | null> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
  return row ? { value: row.value } : null;
}

/** 这个用途下配了几个模型。0 就是「没配模型」。 */
export async function countPurposeModels(
  db: Db,
  purpose: (typeof routingPurposeModels.$inferSelect)['purpose'],
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(routingPurposeModels)
    .where(eq(routingPurposeModels.purpose, purpose));
  return row?.n ?? 0;
}

export interface CommanderRoundRow {
  seq: number;
  outcome: string;
  addedLines: number | null;
  reworkSummary: string | null;
}

/** 这张单最近 limit 个回合收场（旧的在前）。 */
export async function readTaskRoundsForSpin(db: Db, taskId: string, limit = 8): Promise<CommanderRoundRow[]> {
  const rows = await db
    .select({
      seq: taskRounds.seq,
      outcome: taskRounds.outcome,
      addedLines: taskRounds.addedLines,
      reworkSummary: taskRounds.reworkSummary,
    })
    .from(taskRounds)
    .where(eq(taskRounds.taskId, taskId))
    .orderBy(desc(taskRounds.endedAt), desc(taskRounds.id))
    .limit(limit);
  return rows.reverse();
}

/** 停下那一次的提醒正文（工作流报的 <工作流编号>:park:<第几次>）。没有、没读到内容回 null。 */
export async function readParkAlertBody(db: Db, dedupeKey: string): Promise<string | null> {
  const [row] = await db
    .select({ title: notifications.title, body: notifications.body })
    .from(notifications)
    .where(eq(notifications.dedupeKey, dedupeKey));
  if (!row) return null;
  const body = row.body.trim();
  return body === '' ? null : body;
}

export interface OpenParkAlertRow {
  seq: number;
  title: string;
  body: string | null;
  at: Date;
}

/**
 * 这个工作流还开着的、最新的一条停下提醒（键 <工作流编号>:park:<第几次>，#3423）。老历史的查询里没有停法和停下编号，
 * 指挥官从这里认停在哪一次、为什么停。没有开着的回 null。
 */
export async function readOpenParkAlert(db: Db, workflowId: string): Promise<OpenParkAlertRow | null> {
  const prefix = `${workflowId}:park:`;
  const rows = await db
    .select({
      dedupeKey: notifications.dedupeKey,
      title: notifications.title,
      body: notifications.body,
      raisedAt: notifications.raisedAt,
    })
    .from(notifications)
    .where(
      and(
        isNull(notifications.resolvedAt),
        sql`left(${notifications.dedupeKey}, ${prefix.length}) = ${prefix}`,
      ),
    );
  let best: OpenParkAlertRow | null = null;
  for (const row of rows) {
    const rest = row.dedupeKey.slice(prefix.length);
    if (!/^[1-9]\d*$/.test(rest)) continue;
    const seq = Number(rest);
    if (!Number.isSafeInteger(seq) || (best && best.seq >= seq)) continue;
    const body = row.body.trim();
    best = { seq, title: row.title, body: body === '' ? null : body, at: row.raisedAt };
  }
  return best;
}

/** 任务标题（重做起新一代要带）。 */
export async function readTaskTitle(db: Db, taskId: string): Promise<string | null> {
  const [row] = await db.select({ title: tasks.title }).from(tasks).where(eq(tasks.id, taskId));
  return row?.title ?? null;
}

const COMMANDER_CLAIM = 'commander.claim';
const COMMANDER_RETRY = 'commander.retry';
const PARK_KEY = /^(.*):park:([1-9]\d*)$/;

export interface CommanderStalledTask {
  taskId: string;
  owner: string;
  name: string;
  issueNumber: number;
  title: string;
  workflowId: string;
  parkSeq: number;
  stalledAt: Date;
  /** 这一次停下是否已经记过 commander.claim。 */
  commanderSeen: boolean;
  /** 这一次停下最近一条「会话没起成」（commander.retry）：第几次、为什么。没有是 null。 */
  retry: { attempt: number | null; why: string } | null;
}

/**
 * 当前仍停着的引擎任务，以及对应的停下提醒。
 *
 * park 提醒的 raised_at 就是这一次停下的起点；只看当前未处理的提醒，避免把上一代
 * 或已经继续的任务算进来。认领记录要读全历史：一个挂了很久的停点，不能因为超过
 * 24 小时就再次交给指挥官。
 */
export async function listCommanderStalledTasks(db: Db): Promise<CommanderStalledTask[]> {
  const [parks, claims] = await allSettledOrThrow([
    db
      .select({
        taskId: tasks.id,
        owner: repos.owner,
        name: repos.name,
        issueNumber: tasks.issueNumber,
        title: tasks.title,
        dedupeKey: notifications.dedupeKey,
        stalledAt: notifications.raisedAt,
      })
      .from(notifications)
      .innerJoin(tasks, eq(tasks.id, notifications.taskId))
      .innerJoin(repos, eq(repos.id, tasks.repoId))
      .where(
        and(
          isNull(notifications.resolvedAt),
          eq(tasks.state, 'stalled'),
          eq(tasks.executor, 'engine'),
          sql`position(':park:' in ${notifications.dedupeKey}) > 0`,
          // 指挥官自己留给人的提醒（commander:<工作流>:park:<第几次>，park-triage 的 noticeKey）也带 :park:，
          // 它在认领之后才写、raised_at 更新：不排掉的话工作流编号会解成 commander:<工作流>，对不上认领记录，
          // 还会盖掉原来那条工作流报的停下提醒，已认领的停点被算成没看过。
          sql`${notifications.dedupeKey} not like 'commander:%'`,
        ),
      )
      .orderBy(asc(notifications.raisedAt), asc(notifications.id)),
    db
      .select({ action: auditLog.action, after: auditLog.after, error: auditLog.error })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.target, COMMANDER_AUDIT_TARGET),
          inArray(auditLog.action, [COMMANDER_CLAIM, COMMANDER_RETRY]),
        ),
      )
      .orderBy(asc(auditLog.at), asc(auditLog.id)),
  ]);

  // 认领数多于「会话没起成」数才算看过（#3423：没起成的那次认领不消耗这一次停下，下一轮还会再看）
  const tally = new Map<string, number>();
  const lastRetry = new Map<string, { attempt: number | null; why: string }>();
  for (const claim of claims) {
    const after = claim.after;
    if (typeof after !== 'object' || after === null) continue;
    const value = after as { workflowId?: unknown; parkSeq?: unknown; attempt?: unknown };
    if (typeof value.workflowId !== 'string' || typeof value.parkSeq !== 'number') continue;
    const key = `${value.workflowId}#${value.parkSeq}`;
    tally.set(key, (tally.get(key) ?? 0) + (claim.action === COMMANDER_CLAIM ? 1 : -1));
    // 按时间从早到晚读：最后一条没起成的记录留下，看门狗报「没人看」时写出原因
    if (claim.action === COMMANDER_RETRY)
      lastRetry.set(key, {
        attempt: typeof value.attempt === 'number' ? value.attempt : null,
        why: claim.error?.trim() || '没写原因',
      });
  }
  const seen = new Set([...tally].filter(([, n]) => n > 0).map(([key]) => key));

  const byTask = new Map<string, CommanderStalledTask>();
  for (const park of parks) {
    const match = PARK_KEY.exec(park.dedupeKey);
    if (!match || park.stalledAt === null) continue;
    const workflowId = match[1];
    const parkSeq = Number(match[2]);
    if (!Number.isSafeInteger(parkSeq) || workflowId === undefined) continue;
    // 正常情况下一个任务只有一个未撤的 park 提醒；坏数据时取最新的一次，避免一张单
    // 被算成两张，也不让旧停点污染看门狗。
    const item: CommanderStalledTask = {
      taskId: park.taskId,
      owner: park.owner,
      name: park.name,
      issueNumber: park.issueNumber,
      title: park.title,
      workflowId,
      parkSeq,
      stalledAt: park.stalledAt,
      commanderSeen: seen.has(`${workflowId}#${parkSeq}`),
      retry: lastRetry.get(`${workflowId}#${parkSeq}`) ?? null,
    };
    const old = byTask.get(park.taskId);
    if (!old || old.stalledAt.getTime() <= item.stalledAt.getTime()) byTask.set(park.taskId, item);
  }
  return [...byTask.values()].sort(
    (a, b) => a.stalledAt.getTime() - b.stalledAt.getTime() || a.issueNumber - b.issueNumber,
  );
}

export interface CommanderStalledSummary {
  stalled: number;
  handled: number;
  forHuman: number;
}

/** attention 和每日简报共用的当前停下任务统计，避免两处各写一套口径。 */
export async function commanderStalledSummary(db: Db): Promise<CommanderStalledSummary> {
  const rows = await listCommanderStalledTasks(db);
  const handled = rows.filter((row) => row.commanderSeen).length;
  return { stalled: rows.length, handled, forHuman: rows.length - handled };
}

/** 「停下 N 张，指挥官处理 M 张，留给人 K 张」：attention 和每日简报打同一句。 */
export function commanderSummaryLine(s: CommanderStalledSummary): string {
  return `停下 ${s.stalled} 张，指挥官处理 ${s.handled} 张，留给人 ${s.forHuman} 张`;
}

export interface CommanderAcceptanceTask {
  taskId: string;
  owner: string;
  name: string;
  issueNumber: number;
  title: string;
  workflowId: string | null;
  prNumber: number;
  head: string;
  mergedAt: Date;
  mergeCommit: string | null;
  duties: AcceptanceDutyRow[];
}

/**
 * PR 镜像已经合并超过 30 分钟、同单仍有 open 验收责任的候选。
 * 责任状态必须用 shared 的统一判法；任务是否仍开着由 GitHub 真装配再核一次。
 */
export function commanderAcceptanceCandidatesQuery(db: Db, mergedBefore: Date) {
  const workflowId = sql<string | null>`(
    select ${runs.workflowId} from ${runs}
    where ${runs.taskId} = ${tasks.id} and ${runs.workflowId} is not null
    order by ${runs.startedAt} desc nulls last, ${runs.createdAt} desc nulls last
    limit 1
  )`;
  return db
    .select({
      taskId: tasks.id,
      owner: repos.owner,
      name: repos.name,
      issueNumber: tasks.issueNumber,
      title: tasks.title,
      workflowId,
      prNumber: pullRequests.number,
      head: pullRequests.headSha,
      mergedAt: pullRequests.mergedAt,
      mergeCommit: pullRequests.mergeSha,
    })
    .from(acceptanceCandidateGroups)
    .innerJoin(tasks, eq(tasks.id, acceptanceCandidateGroups.taskId))
    .innerJoin(repos, eq(repos.id, tasks.repoId))
    .innerJoin(
      pullRequests,
      and(eq(pullRequests.repoId, tasks.repoId), eq(pullRequests.number, acceptanceCandidateGroups.prNumber)),
    )
    .where(
      and(
        sql`${acceptanceCandidateGroups.hasOpen}`,
        eq(pullRequests.state, 'merged'),
        isNotNull(pullRequests.mergedAt),
        lte(pullRequests.mergedAt, mergedBefore),
      ),
    )
    .orderBy(asc(repos.owner), asc(repos.name), asc(tasks.issueNumber), asc(pullRequests.number))
    .limit(4097);
}

/**
 * 纯读：维护由消费者显式调用。readiness、候选、完整上下文在同一只读快照里，
 * 避免检查后 writer 置 dirty 把候选变成假空。4096组/65536责任超限整轮报未读全。
 */
export async function listCommanderAcceptanceTasks(
  db: Db,
  mergedBefore: Date,
): Promise<CommanderAcceptanceTask[]> {
  return db.transaction(
    async (tx) => {
      await assertAcceptanceCandidatesReady(tx);
      const merged = await commanderAcceptanceCandidatesQuery(tx, mergedBefore);
      if (merged.length > 4096) throw acceptanceCandidatesUnknown('候选组超过读取预算');
      const out: CommanderAcceptanceTask[] = [];
      let remaining = 65536;
      for (const row of merged) {
        if (row.mergedAt === null) continue;
        const duties = await acceptanceGroupDutiesQuery(tx, row, remaining + 1);
        if (duties.length > remaining) throw acceptanceCandidatesUnknown('候选完整责任超过读取预算');
        remaining -= duties.length;
        out.push({ ...row, mergedAt: row.mergedAt, duties });
      }
      return out;
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
