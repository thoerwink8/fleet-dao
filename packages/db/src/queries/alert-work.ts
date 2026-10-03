// 提醒是一件活（design 15.3「谁在处理」）的读写：一批提醒现算处理状态要的事实（跟进单、挂钩的 PR、静默），
// 挂跟进单、建和撤静默。判法在 @fleet-dao/core 的 alert-work.ts；把行拼成 core 的样子在 @fleet-dao/api 的 alert-work.ts。
// 改这里之前必须知道：
// - 挂跟进单两种写法：if_absent（原「提醒派单」开的小单专用，只在没有时写，不覆盖人挂的）、replace（原帅位
//   `alert claim --issue` 专用，换单记操作记录：原来是哪张、为什么换）。两条调用方都在 #445 删了，函数留着给以后
//   要挂跟进单的功能用；同一事务里写操作记录。
// - 静默的到期一律按库的 now() 算（ends_at = now() + 分钟数），不拿各机器的钟；最长 7 天由表约束钉死。
// - 读不到就抛（连不上库、语句出错），不回空：外壳把它当「没查成」，不当「没人在修」。
// - 认领账（issue_claims）2026-10-03 起整张删掉（#556，创始人回「选 1」）：这里不再读它、也没有 ClaimRow 了。
import { and, asc, eq, getTableColumns, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import {
  alertSilences,
  alertWork,
  auditLog,
  notifications,
  pullRequests,
  repos,
  tasks,
} from '../schema/index.ts';
import type { AlertRow } from './alerts.ts';

export type AlertWorkRow = typeof alertWork.$inferSelect & { owner: string; name: string };
export type AlertSilenceRow = typeof alertSilences.$inferSelect;
export type PullRequestRefRow = typeof pullRequests.$inferSelect & { owner: string; name: string };

/** 库的 now()，毫秒数（两种驱动都读成数字）。 */
const nowMs = sql<number>`floor(extract(epoch from now()) * 1000)::float8`.mapWith(Number);
/** 只有一行的表：读库的 now() 用。 */
const ONE_ROW = sql`(values (1)) as one (x)`;

/** 库的 now()。 */
export async function readDbNow(db: Db): Promise<Date> {
  const [row] = await db.select({ now: nowMs }).from(ONE_ROW);
  if (!row) throw new Error('读库的时钟时连一行都没回（select 一行常量也没回来）');
  return new Date(row.now);
}

/** 一批提醒现算处理状态要的全部行（按库的 now 读的）。 */
export interface AlertWorkRaw {
  now: Date;
  alerts: AlertRow[];
  /** 提醒挂的任务对应的单。 */
  tasks: { id: string; repoId: string; owner: string; name: string; issueNumber: number }[];
  work: AlertWorkRow[];
  /** 挂钩的 PR：正文「修提醒」栏写了这批提醒的键或编号、正文挂了跟进单。 */
  prs: PullRequestRefRow[];
  /** 还没提前撤、没到期的静默（全表里的；对不对得上由 core 判）。 */
  silences: AlertSilenceRow[];
}

const alertColumns = {
  id: notifications.id,
  dedupeKey: notifications.dedupeKey,
  level: notifications.level,
  taskId: notifications.taskId,
  title: notifications.title,
  body: notifications.body,
  link: notifications.link,
  createdAt: notifications.createdAt,
  updatedAt: notifications.updatedAt,
  resolvedAt: notifications.resolvedAt,
  resolvedBy: notifications.resolvedBy,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 按编号或键找一条提醒（处理没处理都给）；没有是 null。 */
export async function findAlert(db: Db, ref: string): Promise<AlertRow | null> {
  const where = UUID.test(ref)
    ? or(eq(notifications.id, ref), eq(notifications.dedupeKey, ref))
    : eq(notifications.dedupeKey, ref);
  const rows = await db.select(alertColumns).from(notifications).where(where).limit(2);
  // 编号和别的提醒的键撞上（不该有）：按编号的那条
  return rows.find((r) => r.id === ref) ?? rows[0] ?? null;
}

/**
 * 一批提醒（按编号）现算处理状态要的全部行。编号超过 500 个明确拒绝（调用方分批）；一个都不给回空的一批。
 * 一条一条读（不并发）：连不上库时并发的查询会挂着，关连接要等它们。
 */
export async function readAlertWork(db: Db, notificationIds: readonly string[]): Promise<AlertWorkRaw> {
  if (notificationIds.length > 500)
    throw new Error(`一次最多看 500 条提醒，给了 ${notificationIds.length} 条`);
  const now = await readDbNow(db);
  const empty: AlertWorkRaw = { now, alerts: [], tasks: [], work: [], prs: [], silences: [] };
  const ids = [...new Set(notificationIds)].filter((id) => UUID.test(id));
  if (ids.length === 0) return empty;
  const alerts = await db
    .select(alertColumns)
    .from(notifications)
    .where(inArray(notifications.id, ids))
    .orderBy(asc(notifications.createdAt), asc(notifications.id));
  const taskIds = [...new Set(alerts.map((a) => a.taskId).filter((t): t is string => t !== null))];
  const taskRows =
    taskIds.length === 0
      ? []
      : await db
          .select({
            id: tasks.id,
            repoId: tasks.repoId,
            owner: repos.owner,
            name: repos.name,
            issueNumber: tasks.issueNumber,
          })
          .from(tasks)
          .innerJoin(repos, eq(repos.id, tasks.repoId))
          .where(inArray(tasks.id, taskIds));
  const work = await db
    .select({ ...getTableColumns(alertWork), owner: repos.owner, name: repos.name })
    .from(alertWork)
    .innerJoin(repos, eq(repos.id, alertWork.repoId))
    .where(inArray(alertWork.notificationId, ids));

  // 每条提醒的跟进单：另挂的优先，没有就是任务的那张
  const workIssues = new Map<string, { repoId: string; issueNumber: number }>();
  const taskById = new Map(taskRows.map((t) => [t.id, t]));
  for (const a of alerts) {
    const w = work.find((x) => x.notificationId === a.id);
    const t = a.taskId ? taskById.get(a.taskId) : undefined;
    const issue = w
      ? { repoId: w.repoId, issueNumber: w.issueNumber }
      : t
        ? { repoId: t.repoId, issueNumber: t.issueNumber }
        : undefined;
    if (issue) workIssues.set(`${issue.repoId}#${issue.issueNumber}`, issue);
  }
  const issueList = [...workIssues.values()];

  const refs = [...new Set(alerts.flatMap((a) => [a.dedupeKey, a.id]))];
  const byRepo = new Map<string, Set<number>>();
  for (const i of issueList) byRepo.set(i.repoId, (byRepo.get(i.repoId) ?? new Set()).add(i.issueNumber));
  const prConditions = [
    sql`${pullRequests.alertRefs} && ${sql`array[${sql.join(
      refs.map((r) => sql`${r}`),
      sql`, `,
    )}]::text[]`}`,
    ...[...byRepo.entries()].map(
      ([repoId, nums]) =>
        sql`(${pullRequests.repoId} = ${repoId} and ${pullRequests.issueRefs} && ${sql`array[${sql.join(
          [...nums].map((n) => sql`${n}`),
          sql`, `,
        )}]::integer[]`})`,
    ),
  ];
  const prs = await db
    .select({ ...getTableColumns(pullRequests), owner: repos.owner, name: repos.name })
    .from(pullRequests)
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(or(...prConditions))
    .orderBy(asc(pullRequests.repoId), asc(pullRequests.number));
  const silences = await db
    .select()
    .from(alertSilences)
    .where(and(isNull(alertSilences.expiredAt), gt(alertSilences.endsAt, sql`now()`)))
    .orderBy(asc(alertSilences.createdAt));
  return { now, alerts, tasks: taskRows, work, prs, silences };
}

export interface AuditWho {
  actorKind: 'user' | 'ai' | 'engine' | 'agent';
  actorId: string;
  via: 'cockpit' | 'feishu' | 'github' | 'engine' | 'agent';
}

/**
 * 挂跟进单（#445 起没有产品代码调它了——原「提醒派单」开小单、`alert claim --issue` 换单这两条路都删了，函数留着
 * 给以后的功能用，测试也还拿它搭「已经挂了跟进单」的场景）。if_absent：这条提醒还没有跟进单才写，有了一概不动、
 * 回 kept；replace：换成这一张，和原来一样回 same，不一样的记操作记录（原来是哪张、为什么）。提醒不在回 not_found。
 */
export async function linkAlertWork(
  db: Db,
  input: {
    notificationId: string;
    repoId: string;
    issueNumber: number;
    source: 'engine' | 'claim';
    linkedBy: string;
    note?: string | null | undefined;
    mode: 'if_absent' | 'replace';
    audit: AuditWho;
  },
): Promise<{
  result: 'linked' | 'same' | 'kept' | 'not_found';
  before: { repoId: string; issueNumber: number } | null;
}> {
  return db.transaction(async (tx) => {
    const [alert] = await tx
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.id, input.notificationId))
      .for('update');
    if (!alert) return { result: 'not_found' as const, before: null };
    const [existing] = await tx
      .select()
      .from(alertWork)
      .where(eq(alertWork.notificationId, input.notificationId));
    const before = existing ? { repoId: existing.repoId, issueNumber: existing.issueNumber } : null;
    if (existing) {
      if (existing.repoId === input.repoId && existing.issueNumber === input.issueNumber)
        return { result: 'same' as const, before };
      if (input.mode === 'if_absent') return { result: 'kept' as const, before };
    }
    const values = {
      notificationId: input.notificationId,
      repoId: input.repoId,
      issueNumber: input.issueNumber,
      source: input.source,
      linkedBy: input.linkedBy,
      linkedAt: sql`now()`,
      note: input.note ?? null,
    };
    await tx
      .insert(alertWork)
      .values(values)
      .onConflictDoUpdate({
        target: alertWork.notificationId,
        set: {
          repoId: sql`excluded.repo_id`,
          issueNumber: sql`excluded.issue_number`,
          source: sql`excluded.source`,
          linkedBy: sql`excluded.linked_by`,
          linkedAt: sql`now()`,
          note: sql`excluded.note`,
        },
      });
    await tx.insert(auditLog).values({
      actorKind: input.audit.actorKind,
      actorId: input.audit.actorId,
      action: 'alert.link',
      target: `notification:${input.notificationId}`,
      before,
      after: { repoId: input.repoId, issueNumber: input.issueNumber, source: input.source },
      reason: input.note ?? null,
      via: input.audit.via,
      ok: true,
    });
    return { result: 'linked' as const, before };
  });
}

/** 建一条静默：到期 = 库的 now() + minutes；同一事务记操作记录（alert.silence）。约束不过（前缀太宽、超 7 天）照抛。 */
export async function createSilence(
  db: Db,
  input: {
    matchKind: 'key' | 'prefix';
    match: string;
    comment: string;
    createdBy: string;
    minutes: number;
    audit: AuditWho;
  },
): Promise<AlertSilenceRow> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(alertSilences)
      .values({
        matchKind: input.matchKind,
        match: input.match,
        comment: input.comment,
        createdBy: input.createdBy,
        createdAt: sql`now()`,
        endsAt: sql`now() + make_interval(mins => ${input.minutes})`,
      })
      .returning();
    if (!row) throw new Error('静默没写进去：insert 没回行');
    await tx.insert(auditLog).values({
      actorKind: input.audit.actorKind,
      actorId: input.audit.actorId,
      action: 'alert.silence',
      target: `silence:${row.id}`,
      after: { matchKind: row.matchKind, match: row.match, endsAt: row.endsAt.toISOString() },
      reason: input.comment,
      via: input.audit.via,
      ok: true,
    });
    return row;
  });
}

/**
 * 提前撤一条静默：还没撤、没到期的才撤，回撤后的样子；没有这条回 not_found，已经撤了、到期了回 ended（带那一行）。
 * 同一事务记操作记录（alert.unsilence）。
 */
export async function expireSilence(
  db: Db,
  input: { id: string; by: string; note: string; audit: AuditWho },
): Promise<{ result: 'expired' | 'ended'; row: AlertSilenceRow } | { result: 'not_found' }> {
  if (!UUID.test(input.id)) return { result: 'not_found' };
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(alertSilences)
      .set({ expiredAt: sql`now()`, expiredBy: input.by, expireNote: input.note })
      .where(
        and(
          eq(alertSilences.id, input.id),
          isNull(alertSilences.expiredAt),
          gt(alertSilences.endsAt, sql`now()`),
        ),
      )
      .returning();
    if (!row) {
      const [existing] = await tx.select().from(alertSilences).where(eq(alertSilences.id, input.id));
      return existing ? { result: 'ended' as const, row: existing } : { result: 'not_found' as const };
    }
    await tx.insert(auditLog).values({
      actorKind: input.audit.actorKind,
      actorId: input.audit.actorId,
      action: 'alert.unsilence',
      target: `silence:${row.id}`,
      before: { match: row.match, endsAt: row.endsAt.toISOString() },
      reason: input.note,
      via: input.audit.via,
      ok: true,
    });
    return { result: 'expired' as const, row };
  });
}

/** 列静默：默认只要还管用的（没撤、没到期），all 连撤了、到期了的最近 50 条一起。 */
export async function listSilences(
  db: Db,
  input: { all: boolean },
): Promise<{ now: Date; silences: AlertSilenceRow[] }> {
  const now = await readDbNow(db);
  const rows = input.all
    ? await db.select().from(alertSilences).orderBy(sql`${alertSilences.createdAt} desc`).limit(50)
    : await db
        .select()
        .from(alertSilences)
        .where(and(isNull(alertSilences.expiredAt), gt(alertSilences.endsAt, sql`now()`)))
        .orderBy(asc(alertSilences.endsAt));
  return { now, silences: rows };
}
