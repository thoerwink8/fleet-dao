// Postgres 版 Store：用 @fleet-dao/db 的表和查询实现 ports.ts 的 Store。和 memory-store.ts 过同一套契约测试。
// 约定：
// - 这个 Store 自己写的时间一律用传进来的时钟（和后端其余部分同一个钟）；库自己记的（状态变化等）用库的钟。
// - 按编号查的方法：编号不是 uuid 就当「没有」，不让它变成 SQL 报错（编号来自网址）。
// - 「改数据 + 写操作记录」放在同一个事务里：操作记录写不进，改动一起回滚。
// - 翻页游标是 `时刻|编号`（ids.ts 判读，看不懂抛 InvalidCursorError）；库里的时刻比毫秒精细，比较时截到毫秒，
//   和游标的精度一致，翻页不漏同一毫秒里的几条。

import {
  asks,
  auditLog,
  bans,
  channels,
  type Db,
  githubEvents,
  githubEventVersions,
  idempotencyKeys,
  models,
  notificationDeliveries,
  notifications,
  pools,
  progressEvents,
  pullRequests,
  quotaWindows,
  repos,
  routes,
  runs,
  runsOfTask,
  scheduleHealth,
  searchSpecs,
  sessionRuns,
  settings,
  stateChanges,
  subtaskDeps,
  subtasks,
  tasks,
  toBan,
  toChannel,
  toModel,
  toPool,
  toQuotaWindow,
  toRepo,
  toRoute,
  toSegmentRun,
  toSessionRun,
  toSubtask,
  toTask,
  users,
} from '@fleet-dao/db';
import { type ProgressKind, taskWorkflowId } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import { and, asc, countDistinct, desc, eq, gt, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import {
  claimedCommandResult,
  commandKey,
  commandTarget,
  judgeExistingCommand,
  tookOverResult,
} from './command-logic.ts';
import {
  ATTEMPT_FREE_STATUS,
  claimedResult,
  judgeCarriers,
  outcomeFields,
  RECLAIMABLE_STATUSES,
  reclaimMissStatus,
} from './delivery-logic.ts';
import { testRunOf } from './done-check.ts';
import { isSerial, isUuid, parseCursor } from './ids.ts';
import { nextCursorOf } from './paging.ts';
import { planSteps } from './plan-logic.ts';
import type {
  AskRecord,
  AuditRecord,
  AutoDispatchChange,
  CommandClaim,
  GitHubDelivery,
  GitHubObjectVersion,
  JobRecord,
  NewAuditEntry,
  NotificationRecord,
  Page,
  PasswordCredentials,
  PullRequestRecord,
  RunPlan,
  SettingRecord,
  Store,
  User,
} from './ports.ts';
import {
  autoDispatchAudit,
  autoDispatchChanged,
  autoDispatchUnchanged,
  boardCutoffMs,
  isAutoDispatchUnchanged,
  isTerminalTaskState,
  keepOnBoard,
} from './task-logic.ts';

export interface PgStoreOptions {
  now?: () => Date;
}

const opt = <V>(v: V | null): V | undefined => v ?? undefined;
const iso = (d: Date) => d.toISOString();
const isoOpt = (d: Date | null) => (d ? d.toISOString() : undefined);

type UserRow = typeof users.$inferSelect;
type AskRow = typeof asks.$inferSelect;
type AuditRow = typeof auditLog.$inferSelect;

function toUser(r: UserRow): User {
  return {
    id: r.id,
    displayName: r.displayName,
    role: r.role,
    active: r.active,
    avatarUrl: opt(r.avatarUrl),
    feishuOpenId: opt(r.feishuOpenId),
    feishuUnionId: opt(r.feishuUnionId),
    githubLogin: opt(r.githubLogin),
    githubId: opt(r.githubId),
    sessionVersion: r.sessionVersion,
  };
}

function toCredentials(r: UserRow): PasswordCredentials {
  return {
    userId: r.id,
    username: opt(r.username),
    passwordHash: opt(r.passwordHash),
    passwordChangedAt: isoOpt(r.passwordChangedAt),
    failedLogins: r.failedLogins,
    lockedUntil: isoOpt(r.lockedUntil),
  };
}

function toAsk(r: AskRow): AskRecord {
  return {
    id: r.id,
    taskId: r.taskId,
    runId: opt(r.runId),
    question: r.question,
    options: r.options,
    askedAt: iso(r.askedAt),
    answer: opt(r.answer),
    answeredBy: opt(r.answeredBy),
    answeredAt: isoOpt(r.answeredAt),
    scope: opt(r.scope),
    recommended: opt(r.recommended),
    hold: opt(r.hold),
    followUpIssue: opt(r.followUpIssue),
    appliedAt: isoOpt(r.appliedAt),
  };
}

function toPullRequest(r: typeof pullRequests.$inferSelect): PullRequestRecord {
  return {
    repoId: r.repoId,
    number: r.number,
    state: r.state,
    headRef: r.headRef,
    headSha: r.headSha,
    checks: r.checks,
    updatedAt: iso(r.updatedAt),
    openedAt: isoOpt(r.openedAt),
    mergedAt: isoOpt(r.mergedAt),
    issueRefs: r.issueRefs,
  };
}

function toAudit(r: AuditRow): AuditRecord {
  return {
    id: String(r.id),
    at: iso(r.at),
    actor: { kind: r.actorKind, id: r.actorId },
    action: r.action,
    target: r.target,
    before: r.before ?? undefined,
    after: r.after ?? undefined,
    reason: opt(r.reason),
    via: r.via,
    ok: r.ok,
    error: opt(r.error),
  };
}

export function createPgStore(db: Db, options: PgStoreOptions = {}): Store {
  const now = options.now ?? (() => new Date());

  async function insertAudit(tx: Db, entry: NewAuditEntry): Promise<string> {
    const [row] = await tx
      .insert(auditLog)
      .values({
        at: now(),
        actorKind: entry.actor.kind,
        actorId: entry.actor.id,
        action: entry.action,
        target: entry.target,
        before: entry.before ?? null,
        after: entry.after ?? null,
        reason: entry.reason ?? null,
        via: entry.via,
        ok: entry.ok,
        error: entry.error ?? null,
      })
      .returning({ id: auditLog.id });
    if (!row) throw new Error('操作记录没写进去');
    return String(row.id);
  }

  async function insertProgress(runId: string, kind: ProgressKind, payload: unknown): Promise<void> {
    await db.insert(progressEvents).values({ runId, at: now(), kind, payload: payload ?? null });
  }

  /** 这几条投递带着的对象版本，按投递编号分好；每条里按对象排（和内存版一样）。 */
  async function versionsOf(ids: readonly string[]): Promise<Map<string, GitHubObjectVersion[]>> {
    const out = new Map<string, GitHubObjectVersion[]>();
    if (ids.length === 0) return out;
    const rows = await db
      .select()
      .from(githubEventVersions)
      .where(inArray(githubEventVersions.deliveryId, [...ids]))
      // 按字节排（collate "C"），和内存版按字面比的结果一样，不随库的排序规则变
      .orderBy(asc(githubEventVersions.deliveryId), sql`${githubEventVersions.object} collate "C"`);
    for (const r of rows) {
      const list = out.get(r.deliveryId) ?? [];
      list.push({ object: r.object, version: iso(r.version), state: opt(r.state) });
      out.set(r.deliveryId, list);
    }
    return out;
  }

  /** 还没做完、而且还是这张凭据占着的那一行。 */
  const heldBy = (key: string, token: string) =>
    and(
      eq(idempotencyKeys.key, key),
      isNull(idempotencyKeys.completedAt),
      eq(idempotencyKeys.claimedAt, new Date(token)),
    );

  return {
    // —— 人 ——
    async getUser(id) {
      if (!isUuid(id)) return null;
      const [row] = await db.select().from(users).where(eq(users.id, id));
      return row ? toUser(row) : null;
    },
    async findUserByFeishu({ openId, unionId }) {
      const [row] = await db
        .select()
        .from(users)
        .where(or(eq(users.feishuOpenId, openId), unionId ? eq(users.feishuUnionId, unionId) : undefined))
        .limit(1);
      return row ? toUser(row) : null;
    },
    async listUsers() {
      return (await db.select().from(users).orderBy(asc(users.createdAt), asc(users.id))).map(toUser);
    },
    async findUserByUsername(username) {
      const [row] = await db
        .select()
        .from(users)
        .where(sql`lower(${users.username}) = lower(${username})`)
        .limit(1);
      return row ? toUser(row) : null;
    },
    async getPasswordCredentials(userId) {
      if (!isUuid(userId)) return null;
      const [row] = await db.select().from(users).where(eq(users.id, userId));
      return row ? toCredentials(row) : null;
    },
    async setPasswordCredentials({ userId, username, passwordHash, at }, entry) {
      if (!isUuid(userId)) return 'not_found';
      try {
        return await db.transaction(async (tx) => {
          const updated = await tx
            .update(users)
            .set({
              ...(username !== undefined && { username }),
              ...(passwordHash !== undefined && {
                passwordHash,
                passwordChangedAt: at,
                sessionVersion: sql`${users.sessionVersion} + 1`,
              }),
              failedLogins: 0,
              lockedUntil: null,
            })
            .where(eq(users.id, userId))
            .returning({ id: users.id });
          if (updated.length === 0) return 'not_found' as const;
          await insertAudit(tx, entry);
          return 'ok' as const;
        });
      } catch (err) {
        // 23505 = 唯一约束：只有用户名那一个会在这里撞（lower(username) 的唯一索引）
        if (sqlState(err) === '23505') return 'username_taken';
        throw err;
      }
    },
    async recordPasswordFailure({ userId, at, maxFails, lockMs }) {
      if (!isUuid(userId)) return null;
      const atIso = at.toISOString();
      const until = new Date(at.getTime() + lockMs).toISOString();
      const lockedNow = sql`(${users.lockedUntil} is not null and ${users.lockedUntil} > ${atIso}::timestamptz)`;
      const expired = sql`(${users.lockedUntil} is not null and ${users.lockedUntil} <= ${atIso}::timestamptz)`;
      const count = sql`((case when ${expired} then 0 else ${users.failedLogins} end) + 1)`;
      const [row] = await db
        .update(users)
        .set({
          failedLogins: sql`case when ${lockedNow} then ${users.failedLogins} when ${count} >= ${maxFails}::int then 0 else ${count} end`,
          lockedUntil: sql`case when ${lockedNow} then ${users.lockedUntil} when ${count} >= ${maxFails}::int then ${until}::timestamptz else null end`,
        })
        .where(eq(users.id, userId))
        .returning({ lockedUntil: users.lockedUntil });
      return row ? { lockedUntil: isoOpt(row.lockedUntil) } : null;
    },
    async bumpSessionVersion(userId) {
      if (!isUuid(userId)) return false;
      const updated = await db
        .update(users)
        .set({ sessionVersion: sql`${users.sessionVersion} + 1` })
        .where(eq(users.id, userId))
        .returning({ id: users.id });
      return updated.length > 0;
    },
    async recordPasswordSuccess(userId) {
      if (!isUuid(userId)) return;
      await db.update(users).set({ failedLogins: 0, lockedUntil: null }).where(eq(users.id, userId));
    },

    // —— 看板 ——
    async listRepos() {
      return (await db.select().from(repos).orderBy(asc(repos.owner), asc(repos.name))).map(toRepo);
    },
    async getRepo(id) {
      if (!isUuid(id)) return null;
      const [row] = await db.select().from(repos).where(eq(repos.id, id));
      return row ? toRepo(row) : null;
    },
    async listBoardTasks(repoId) {
      if (!isUuid(repoId)) return [];
      const rows = await db
        .select()
        .from(tasks)
        .where(eq(tasks.repoId, repoId))
        .orderBy(asc(tasks.priority), asc(tasks.createdAt));
      const finished = rows.filter((t) => isTerminalTaskState(t.state)).map((t) => t.id);
      const since =
        finished.length === 0
          ? new Map<string, Date>()
          : new Map(
              (
                await db
                  .selectDistinctOn([stateChanges.entityId], {
                    entityId: stateChanges.entityId,
                    at: stateChanges.at,
                  })
                  .from(stateChanges)
                  .where(inArray(stateChanges.entityId, finished))
                  .orderBy(stateChanges.entityId, desc(stateChanges.id))
              ).map((r) => [r.entityId, r.at]),
            );
      const cutoff = boardCutoffMs(now().getTime());
      return rows
        .filter((t) => keepOnBoard(t.state, (since.get(t.id) ?? t.createdAt).getTime(), cutoff))
        .map(toTask);
    },
    async getTask(id) {
      if (!isUuid(id)) return null;
      const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
      return row ? toTask(row) : null;
    },
    async listSubtasks(taskIds) {
      const ids = taskIds.filter(isUuid);
      if (ids.length === 0) return [];
      const [rows, deps] = await Promise.all([
        db
          .select()
          .from(subtasks)
          .where(inArray(subtasks.taskId, ids))
          .orderBy(asc(subtasks.taskId), asc(subtasks.index)),
        db.select().from(subtaskDeps).where(inArray(subtaskDeps.taskId, ids)),
      ]);
      return rows.map((r) =>
        toSubtask(
          r,
          deps.filter((d) => d.subtaskId === r.id).map((d) => d.dependsOnId),
        ),
      );
    },
    async listRuns({ taskIds, active }) {
      const ids = taskIds?.filter(isUuid);
      if (ids !== undefined && ids.length === 0) return [];
      const rows = await db
        .select()
        .from(sessionRuns)
        .where(
          and(
            ids ? inArray(sessionRuns.taskId, ids) : undefined,
            active ? isNull(sessionRuns.endedAt) : undefined,
          ),
        )
        .orderBy(asc(sessionRuns.queuedAt), asc(sessionRuns.id));
      return rows.map(toSessionRun);
    },
    async getRun(id) {
      if (!isUuid(id)) return null;
      const [row] = await db.select().from(sessionRuns).where(eq(sessionRuns.id, id));
      return row ? toSessionRun(row) : null;
    },
    async listSegmentRuns(taskId) {
      if (!isUuid(taskId)) return [];
      const [task] = await db
        .select({ issueNumber: tasks.issueNumber, owner: repos.owner, name: repos.name })
        .from(tasks)
        .innerJoin(repos, eq(repos.id, tasks.repoId))
        .where(eq(tasks.id, taskId));
      if (!task) return [];
      const rows = await runsOfTask(db, {
        id: taskId,
        issueNumber: task.issueNumber,
        workflowId: taskWorkflowId(task, task.issueNumber),
      });
      return rows.map((r) => ({
        ...toSegmentRun(r),
        matchedBy: r.taskId === taskId ? ('task' as const) : ('issueNumber' as const),
      }));
    },
    async listSegmentRunsForTasks(taskIds) {
      const ids = taskIds.filter(isUuid);
      if (ids.length === 0) return [];
      const rows = await db
        .select()
        .from(runs)
        .where(inArray(runs.taskId, ids))
        .orderBy(asc(runs.startedAt), asc(runs.createdAt), asc(runs.id));
      return rows.map((r) => ({ ...toSegmentRun(r), matchedBy: 'task' as const }));
    },
    async getPlans(runIds) {
      const ids = runIds.filter(isUuid);
      const out = new Map<string, RunPlan>();
      if (ids.length === 0) return out;
      const rows = await db
        .selectDistinctOn([progressEvents.runId], {
          runId: progressEvents.runId,
          at: progressEvents.at,
          payload: progressEvents.payload,
        })
        .from(progressEvents)
        .where(and(inArray(progressEvents.runId, ids), eq(progressEvents.kind, 'plan')))
        .orderBy(progressEvents.runId, desc(progressEvents.at), desc(progressEvents.id));
      for (const r of rows) out.set(r.runId, { steps: planSteps(r.payload), updatedAt: iso(r.at) });
      return out;
    },
    async lastSay(runId) {
      if (!isUuid(runId)) return null;
      const [row] = await db
        .select({ at: progressEvents.at, payload: progressEvents.payload })
        .from(progressEvents)
        .where(and(eq(progressEvents.runId, runId), eq(progressEvents.kind, 'say')))
        .orderBy(desc(progressEvents.at), desc(progressEvents.id))
        .limit(1);
      const text = (row?.payload as { text?: unknown } | null | undefined)?.text;
      return row && typeof text === 'string' ? { text, at: iso(row.at) } : null;
    },
    async listAsks(taskId) {
      if (!isUuid(taskId)) return [];
      const rows = await db
        .select()
        .from(asks)
        .where(eq(asks.taskId, taskId))
        .orderBy(asc(asks.askedAt), asc(asks.id));
      return rows.map(toAsk);
    },
    async getAsk(id) {
      if (!isUuid(id)) return null;
      const [row] = await db.select().from(asks).where(eq(asks.id, id));
      return row ? toAsk(row) : null;
    },
    async answerAsk({ askId, answer, by }, entry) {
      if (!isUuid(askId)) return 'not_found';
      return db.transaction(async (tx) => {
        const updated = await tx
          .update(asks)
          .set({ answer, answeredBy: by.id, answeredAt: now() })
          .where(and(eq(asks.id, askId), isNull(asks.answer)))
          .returning({ id: asks.id });
        if (updated.length === 0) {
          const [exists] = await tx.select({ id: asks.id }).from(asks).where(eq(asks.id, askId));
          return exists ? 'already_answered' : 'not_found';
        }
        await insertAudit(tx, entry);
        return 'ok';
      });
    },

    // —— 调度台 ——
    async listChannels() {
      return (await db.select().from(channels).orderBy(asc(channels.id))).map(toChannel);
    },
    async listPools() {
      return (await db.select().from(pools).orderBy(asc(pools.id))).map(toPool);
    },
    async listModels() {
      return (await db.select().from(models).orderBy(asc(models.id))).map(toModel);
    },
    async listRoutes() {
      return (await db.select().from(routes).orderBy(asc(routes.id))).map(toRoute);
    },
    async listBans() {
      return (await db.select().from(bans).orderBy(asc(bans.id))).map(toBan);
    },
    async listQuotaWindows() {
      const rows = await db
        .select()
        .from(quotaWindows)
        .orderBy(asc(quotaWindows.poolId), asc(quotaWindows.label));
      // 原名、单位、读法在库里不可空；领域类型里是可选的，这里按列补上必填的类型。
      return rows.map((r) => ({ ...toQuotaWindow(r), label: r.label, unit: r.unit, source: r.source }));
    },
    async setChannelEnabled({ channelId, enabled }, entry) {
      return db.transaction(async (tx) => {
        const updated = await tx
          .update(channels)
          .set({ enabled })
          .where(eq(channels.id, channelId))
          .returning({ id: channels.id });
        if (updated.length === 0) return 'not_found';
        await insertAudit(tx, entry);
        return 'ok';
      });
    },

    // —— 定时任务、通知、操作记录、设置 ——
    async listJobs() {
      const health = await scheduleHealth(db, now());
      return health.map(
        ({ job, lastRun, lastSuccess }): JobRecord => ({
          id: job.id,
          name: job.name,
          schedule: job.schedule,
          expectEveryMinutes: job.expectEveryMinutes,
          lastRun: lastRun
            ? {
                startedAt: iso(lastRun.startedAt),
                endedAt: isoOpt(lastRun.endedAt),
                outcome: opt(lastRun.outcome),
                scanned: opt(lastRun.scanned),
                found: opt(lastRun.found),
                why: opt(lastRun.why),
              }
            : undefined,
          lastSuccessAt: lastSuccess ? isoOpt(lastSuccess.endedAt) : undefined,
        }),
      );
    },
    async listNotifications({ status, cursor: raw, limit }) {
      const cursor = parseCursor(raw, isUuid);
      const rows = await db
        .select()
        .from(notifications)
        .where(
          and(
            status === 'open' ? isNull(notifications.resolvedAt) : undefined,
            cursor
              ? sql`(date_trunc('milliseconds', ${notifications.createdAt}), ${notifications.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(sql`date_trunc('milliseconds', ${notifications.createdAt}) desc`, desc(notifications.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const deliveries =
        page.length === 0
          ? []
          : await db
              .select()
              .from(notificationDeliveries)
              .where(
                inArray(
                  notificationDeliveries.notificationId,
                  page.map((n) => n.id),
                ),
              )
              .orderBy(asc(notificationDeliveries.id));
      const items = page.map(
        (n): NotificationRecord => ({
          id: n.id,
          level: n.level,
          title: n.title,
          body: n.body,
          link: opt(n.link),
          taskId: opt(n.taskId),
          createdAt: iso(n.createdAt),
          resolvedAt: isoOpt(n.resolvedAt),
          resolvedBy: opt(n.resolvedBy),
          dedupeKey: n.dedupeKey,
          deliveries: deliveries
            .filter((d) => d.notificationId === n.id)
            .map((d) => ({
              channel: d.channel,
              messageId: opt(d.messageId),
              attempts: d.attempts,
              error: opt(d.lastError),
              lastAttemptAt: isoOpt(d.lastAttemptAt),
            })),
        }),
      );
      const last = items.at(-1);
      return {
        items,
        nextCursor: nextCursorOf(last && { at: last.createdAt, id: last.id }, rows.length > limit),
      };
    },
    async resolveNotification({ id, by }, entry) {
      if (!isUuid(id)) return 'not_found';
      return db.transaction(async (tx) => {
        const updated = await tx
          .update(notifications)
          .set({ resolvedAt: now(), resolvedBy: by.id })
          .where(and(eq(notifications.id, id), isNull(notifications.resolvedAt)))
          .returning({ id: notifications.id });
        if (updated.length === 0) {
          const [exists] = await tx
            .select({ id: notifications.id })
            .from(notifications)
            .where(eq(notifications.id, id));
          return exists ? 'already_resolved' : 'not_found';
        }
        await insertAudit(tx, entry);
        return 'ok';
      });
    },
    async appendAudit(entry) {
      return insertAudit(db, entry);
    },
    async listAudit({ target, cursor: raw, limit }): Promise<Page<AuditRecord>> {
      const cursor = parseCursor(raw, isSerial);
      const rows = await db
        .select()
        .from(auditLog)
        .where(
          and(
            target === undefined ? undefined : eq(auditLog.target, target),
            cursor
              ? sql`(date_trunc('milliseconds', ${auditLog.at}), ${auditLog.id}) < (${cursor.at}::timestamptz, ${cursor.id}::bigint)`
              : undefined,
          ),
        )
        .orderBy(sql`date_trunc('milliseconds', ${auditLog.at}) desc`, desc(auditLog.id))
        .limit(limit + 1);
      const items = rows.slice(0, limit).map(toAudit);
      return { items, nextCursor: nextCursorOf(items.at(-1), rows.length > limit) };
    },
    async listSettings() {
      const rows = await db.select().from(settings).orderBy(asc(settings.key));
      return rows.map(
        (r): SettingRecord => ({
          key: r.key,
          value: r.value,
          version: r.version,
          updatedAt: iso(r.updatedAt),
          updatedBy: opt(r.updatedBy),
        }),
      );
    },
    async putSetting({ key, value, expectedVersion, by }, entry) {
      // 值本身可以是 null（例如不设免打扰时段）：写成 jsonb 的 null，不是 SQL 的空值（列不许空）。
      const jsonValue = sql`${JSON.stringify(value ?? null)}::jsonb`;
      return db.transaction(async (tx) => {
        const written =
          expectedVersion === 0
            ? await tx
                .insert(settings)
                .values({ key, value: jsonValue, version: 1, updatedAt: now(), updatedBy: by.id })
                .onConflictDoNothing()
                .returning({ key: settings.key })
            : await tx
                .update(settings)
                .set({
                  value: jsonValue,
                  version: sql`${settings.version} + 1`,
                  updatedAt: now(),
                  updatedBy: by.id,
                })
                .where(and(eq(settings.key, key), eq(settings.version, expectedVersion)))
                .returning({ key: settings.key });
        if (written.length === 0) return 'conflict';
        await insertAudit(tx, entry);
        return 'ok';
      });
    },

    // —— fleet 命令 ——
    async getAgentSession(runId) {
      if (!isUuid(runId)) return null;
      // 测试命令认起会话时记下的那条（session_runs.test_command），不读仓此刻的：开工后仓里改了命令也照旧
      const [row] = await db
        .select({ run: sessionRuns, task: tasks })
        .from(sessionRuns)
        .innerJoin(tasks, eq(tasks.id, sessionRuns.taskId))
        .innerJoin(repos, eq(repos.id, tasks.repoId))
        .where(eq(sessionRuns.id, runId));
      if (!row) return null;
      return {
        runId: row.run.id,
        taskId: row.task.id,
        subtaskId: opt(row.run.subtaskId),
        stage: row.run.stage,
        repoId: row.task.repoId,
        testCommand: opt(row.run.testCommand),
        branch: opt(row.run.branch),
        acceptance: row.task.acceptance,
        endedAt: isoOpt(row.run.endedAt),
      };
    },
    async savePlan(runId, steps) {
      await insertProgress(runId, 'plan', { steps: steps.map(({ title, state }) => ({ title, state })) });
    },
    async appendProgress(runId, kind, payload) {
      await insertProgress(runId, kind, payload);
    },
    async openAsk({ runId, taskId, question, options: choices, scope, recommended, hold }) {
      return db.transaction(async (tx) => {
        // 表上唯一的冲突来源是 (run_id, md5(question)) 这条唯一索引（主键是随机 uuid），所以不写冲突目标。
        const [inserted] = await tx
          .insert(asks)
          .values({
            taskId,
            runId,
            question,
            options: choices,
            askedAt: now(),
            scope,
            recommended,
            ...(hold ? { hold } : {}),
          })
          .onConflictDoNothing()
          .returning();
        if (inserted) {
          // 和追问同一事务：不会有「追问开了、进度没记」的半截（重试走去重，补不回来）。
          await tx
            .insert(progressEvents)
            .values({ runId, at: now(), kind: 'ask', payload: { askId: inserted.id, question } });
          return { ask: toAsk(inserted), created: true };
        }
        const [existing] = await tx
          .select()
          .from(asks)
          .where(and(eq(asks.runId, runId), sql`md5(${asks.question}) = md5(${question})`));
        if (!existing) throw new Error(`追问写不进也读不到（会话 ${runId}）`);
        return { ask: toAsk(existing), created: false };
      });
    },
    async searchHistory({ repoId, query, limit }) {
      if (!isUuid(repoId)) return [];
      return searchSpecs(db, { repoId, query, limit });
    },
    async getPullRequest(repoId, number): Promise<PullRequestRecord | null> {
      if (!isUuid(repoId)) return null;
      const [row] = await db
        .select()
        .from(pullRequests)
        .where(and(eq(pullRequests.repoId, repoId), eq(pullRequests.number, number)));
      return row ? toPullRequest(row) : null;
    },
    async listPendingAsks() {
      const rows = await db
        .select()
        .from(asks)
        .where(isNull(asks.answer))
        .orderBy(asc(asks.askedAt), asc(asks.id));
      return rows.map(toAsk);
    },
    async listPullRequests(input = {}) {
      const limit = input.limit ?? 50;
      const rows = await db
        .select()
        .from(pullRequests)
        .where(input.state === undefined ? undefined : eq(pullRequests.state, input.state))
        // merged 按合并时刻倒序、其余按镜像更新时刻倒序；两个时刻都 NULL 的排最后（不拿它们当「最新」）。
        .orderBy(
          input.state === 'merged'
            ? sql`${pullRequests.mergedAt} DESC NULLS LAST`
            : sql`${pullRequests.updatedAt} DESC`,
          sql`${pullRequests.number} DESC`,
        )
        .limit(limit);
      return rows.map(toPullRequest);
    },
    async listTestRuns(runId) {
      if (!isUuid(runId)) return [];
      const rows = await db
        .select({ at: progressEvents.at, payload: progressEvents.payload })
        .from(progressEvents)
        .where(and(eq(progressEvents.runId, runId), eq(progressEvents.kind, 'test')))
        .orderBy(asc(progressEvents.at), asc(progressEvents.id));
      return rows.map((r) => testRunOf(iso(r.at), r.payload));
    },
    async claimCommand({ runId, key, action, takeOverBefore }): Promise<CommandClaim> {
      const k = commandKey(runId, key);
      const cutoff = new Date(takeOverBefore);
      // 占用凭据就是这次占用的时刻（claimed_at，毫秒，本 Store 写的）：接管会把它改新，旧请求拿着旧凭据放不掉、也记不上。
      // 最多试三轮：占不到、读的时候又刚被放掉，再来一次。
      for (let round = 0; round < 3; round++) {
        const at = now();
        const inserted = await db
          .insert(idempotencyKeys)
          .values({ key: k, action, target: commandTarget(runId), claimedAt: at })
          .onConflictDoNothing()
          .returning({ key: idempotencyKeys.key });
        if (inserted.length > 0) return claimedCommandResult(iso(at));
        const [row] = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, k));
        if (!row) continue;
        const verdict = judgeExistingCommand(
          {
            action: row.action,
            claimedAt: iso(row.claimedAt),
            completed: row.completedAt !== null,
            result: row.result,
          },
          action,
          takeOverBefore,
        );
        if (verdict.status !== 'take-over') return verdict;
        // 条件更新是原子的：两个请求同时来接，后一个等前一个提交后重新判条件，claimed_at 已经变新，接不到。
        const taken = await db
          .update(idempotencyKeys)
          .set({ claimedAt: at })
          .where(
            and(
              eq(idempotencyKeys.key, k),
              isNull(idempotencyKeys.completedAt),
              lt(idempotencyKeys.claimedAt, cutoff),
            ),
          )
          .returning({ key: idempotencyKeys.key });
        if (taken.length > 0) return tookOverResult(iso(at));
      }
      throw new Error(`幂等键 ${key} 反复被别的请求抢占，稍后再试`);
    },
    async completeCommand({ runId, key, token }, result) {
      const written = await db
        .update(idempotencyKeys)
        .set({ completedAt: now(), result })
        .where(heldBy(commandKey(runId, key), token))
        .returning({ key: idempotencyKeys.key });
      return written.length > 0;
    },
    async releaseCommand({ runId, key, token }) {
      await db.delete(idempotencyKeys).where(heldBy(commandKey(runId, key), token));
    },

    // —— GitHub 事件 ——
    async claimDelivery(delivery, { staleBefore, skipIfSeen }) {
      const at = now();
      const attempt = await db.transaction(async (tx) => {
        // 「带没带过这一版」的查和这一条的插必须在同一把锁下：两条带同一版的投递同时来，各自查都查不到对方（对方还没提交）、
        // 就会都收下。锁按（对象，版）加（含这一条自己带的几版，所以 webhook 先到、补收后到也看得见），排好序再加，免得互相等死。
        const lockKeys = new Set(delivery.versions.map((v) => versionLockKey(v)));
        if (skipIfSeen) lockKeys.add(versionLockKey(skipIfSeen));
        for (const key of [...lockKeys].sort())
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
        let seenBefore = false;
        if (skipIfSeen) {
          // 带过这一版的别的投递（同一版一般只有一两条）：有没被门挡掉的就不再做；只有被挡掉的，照样做、回 seenBefore
          const carriers = await tx
            .select({ status: githubEvents.status, reason: githubEvents.reason })
            .from(githubEventVersions)
            .innerJoin(githubEvents, eq(githubEvents.deliveryId, githubEventVersions.deliveryId))
            .where(
              and(
                eq(githubEventVersions.object, skipIfSeen.object),
                eq(githubEventVersions.version, new Date(skipIfSeen.version)),
                ne(githubEventVersions.deliveryId, delivery.id),
              ),
            );
          const verdict = judgeCarriers(carriers);
          if (verdict.duplicate) return undefined;
          seenBefore = verdict.seenBefore;
        }
        const rows = await tx
          .insert(githubEvents)
          .values({
            deliveryId: delivery.id,
            event: delivery.event,
            action: delivery.action ?? null,
            source: delivery.source,
            repo: delivery.repo ?? null,
            // 原文原样存：JSON 的 null、数字也收（认不认得出是门口的事），不让它变成 SQL 的空值
            payload: sql`${JSON.stringify(delivery.payload ?? null)}::jsonb`,
            status: 'processing',
            attempts: 1,
            receivedAt: at,
            claimedAt: at,
          })
          .onConflictDoNothing()
          .returning({ id: githubEvents.deliveryId });
        if (rows.length > 0 && delivery.versions.length > 0) {
          await tx.insert(githubEventVersions).values(
            delivery.versions.map((v) => ({
              deliveryId: delivery.id,
              object: v.object,
              version: new Date(v.version),
              state: v.state ?? null,
            })),
          );
        }
        return { inserted: rows.length > 0, seenBefore };
      });
      if (attempt === undefined) return { status: 'duplicate' };
      if (attempt.inserted) return claimedResult(iso(at), false, attempt.seenBefore);
      // 已经有这一条：条件更新是原子的，两个请求同时来接，只有一个接得到
      const taken = await db
        .update(githubEvents)
        .set(reclaimSet(at))
        .where(and(eq(githubEvents.deliveryId, delivery.id), reclaimableRow(new Date(staleBefore))))
        .returning({ id: githubEvents.deliveryId });
      return taken.length > 0 ? claimedResult(iso(at), true, attempt.seenBefore) : { status: 'duplicate' };
    },
    async reclaimDelivery(id, { staleBefore, force }) {
      const at = now();
      const stale = new Date(staleBefore);
      const [row] = await db
        .update(githubEvents)
        .set(reclaimSet(at))
        .where(
          and(
            eq(githubEvents.deliveryId, id),
            force
              ? or(ne(githubEvents.status, 'processing'), lt(githubEvents.claimedAt, stale))
              : reclaimableRow(stale),
          ),
        )
        .returning();
      if (row) {
        const versions = await versionsOf([row.deliveryId]);
        return { status: 'claimed', token: iso(at), delivery: toDelivery(row, versions) };
      }
      const [existing] = await db
        .select({ status: githubEvents.status })
        .from(githubEvents)
        .where(eq(githubEvents.deliveryId, id));
      return { status: reclaimMissStatus(existing?.status) };
    },
    async finishDelivery(id, token, outcome) {
      const fields = outcomeFields(outcome);
      const rows = await db
        .update(githubEvents)
        .set({
          status: fields.status,
          reason: fields.reason ?? null,
          note: fields.note ?? null,
          finishedAt: now(),
        })
        .where(
          and(
            eq(githubEvents.deliveryId, id),
            eq(githubEvents.status, 'processing'),
            eq(githubEvents.claimedAt, new Date(token)),
          ),
        )
        .returning({ id: githubEvents.deliveryId });
      return rows.length > 0;
    },
    async getDelivery(id) {
      const [row] = await db.select().from(githubEvents).where(eq(githubEvents.deliveryId, id));
      return row ? toDelivery(row, await versionsOf([id])) : null;
    },
    async listUnfinishedDeliveries({ staleBefore, limit }) {
      const rows = await db
        .select()
        .from(githubEvents)
        .where(reclaimableRow(new Date(staleBefore)))
        .orderBy(asc(githubEvents.attempts), asc(githubEvents.receivedAt), asc(githubEvents.deliveryId))
        .limit(limit);
      const versions = await versionsOf(rows.map((r) => r.deliveryId));
      return rows.map((r) => toDelivery(r, versions));
    },
    async existingDeliveryIds(ids) {
      if (ids.length === 0) return new Set();
      const rows = await db
        .select({ id: githubEvents.deliveryId })
        .from(githubEvents)
        .where(inArray(githubEvents.deliveryId, [...ids]));
      return new Set(rows.map((r) => r.id));
    },
    async findSupersedingVersion({ object, version, state, excludeDeliveryId }) {
      const [row] = await db
        .select({
          deliveryId: githubEventVersions.deliveryId,
          version: githubEventVersions.version,
          state: githubEventVersions.state,
        })
        .from(githubEventVersions)
        .innerJoin(githubEvents, eq(githubEvents.deliveryId, githubEventVersions.deliveryId))
        .where(
          and(
            eq(githubEventVersions.object, object),
            gt(githubEventVersions.version, new Date(version)),
            ne(githubEventVersions.state, state),
            ne(githubEventVersions.deliveryId, excludeDeliveryId),
            eq(githubEvents.status, 'accepted'),
          ),
        )
        .orderBy(desc(githubEventVersions.version))
        .limit(1);
      return row?.state ? { deliveryId: row.deliveryId, version: iso(row.version), state: row.state } : null;
    },
    async countStuckDeliveries({ staleBefore, maxAttempts }) {
      const [row] = await db
        .select({
          exhausted: sql<number>`count(*) filter (where ${githubEvents.status} = 'failed' and ${githubEvents.attempts} >= ${maxAttempts})::int`,
          stale: sql<number>`count(*) filter (where ${githubEvents.status} = 'processing' and ${githubEvents.claimedAt} < ${new Date(staleBefore).toISOString()}::timestamptz)::int`,
        })
        .from(githubEvents)
        .where(inArray(githubEvents.status, ['processing', 'failed']));
      // 不分组的 count 总有一行：没有就是查询本身出了问题，不许当成「0 条卡住」
      if (!row) throw new Error('数卡住的 GitHub 投递没读到结果');
      return { exhausted: row.exhausted, stale: row.stale };
    },

    // —— 接活 ——
    async findRepoByName(owner, name) {
      const [row] = await db
        .select()
        .from(repos)
        .where(and(sql`lower(${repos.owner}) = lower(${owner})`, sql`lower(${repos.name}) = lower(${name})`))
        .limit(1);
      if (!row) return null;
      return {
        ...toRepo(row),
        autoDispatchSince: row.autoDispatchSince ? iso(row.autoDispatchSince) : null,
      };
    },
    async findTaskByIssue(repoId, issueNumber) {
      if (!isUuid(repoId)) return null;
      const [row] = await db
        .select()
        .from(tasks)
        .where(and(eq(tasks.repoId, repoId), eq(tasks.issueNumber, issueNumber)));
      return row ? toTask(row) : null;
    },
    async findTasksByIssues(refs) {
      // 看不懂的仓编号直接当对不上（和 findTaskByIssue 一样），不让它把整条查询弄成类型错误
      const usable = refs.filter((r) => isUuid(r.repoId));
      if (usable.length === 0) return [];
      const rows = await db
        .select()
        .from(tasks)
        .where(
          or(...usable.map((r) => and(eq(tasks.repoId, r.repoId), eq(tasks.issueNumber, r.issueNumber)))),
        );
      return rows.map(toTask);
    },
    async createTaskFromIssue(input, entry) {
      return db.transaction(async (tx) => {
        const [created] = await tx
          .insert(tasks)
          .values({
            id: input.id,
            repoId: input.repoId,
            issueNumber: input.issueNumber,
            title: input.title,
            rawRequest: input.rawRequest,
            requestedBy: input.requestedBy,
            // 排在这个仓最后
            priority: sql`(select coalesce(max(${tasks.priority}), 0) + 1 from ${tasks} where ${tasks.repoId} = ${input.repoId})`,
            createdAt: now(),
          })
          .onConflictDoNothing({ target: [tasks.repoId, tasks.issueNumber] })
          .returning();
        if (created) {
          await insertAudit(tx, entry);
          return { task: toTask(created), created: true };
        }
        const [existing] = await tx
          .select()
          .from(tasks)
          .where(and(eq(tasks.repoId, input.repoId), eq(tasks.issueNumber, input.issueNumber)));
        if (!existing) throw new Error(`任务 ${input.repoId}#${input.issueNumber} 建不进去也读不到`);
        return { task: toTask(existing), created: false };
      });
    },
    async updateTaskRequest({ taskId, title, rawRequest }, entry) {
      if (!isUuid(taskId)) return 'not_found';
      return db.transaction(async (tx) => {
        const updated = await tx
          .update(tasks)
          .set({ title, rawRequest })
          .where(
            and(
              eq(tasks.id, taskId),
              or(
                sql`${tasks.title} is distinct from ${title}`,
                sql`${tasks.rawRequest} is distinct from ${rawRequest}`,
              ),
            ),
          )
          .returning({ id: tasks.id });
        if (updated.length === 0) {
          const [exists] = await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId));
          return exists ? 'unchanged' : 'not_found';
        }
        await insertAudit(tx, entry);
        return 'ok';
      });
    },
    async stopQueuedTask(taskId, entry) {
      if (!isUuid(taskId)) return 'not_queued';
      return db.transaction(async (tx) => {
        const stopped = await tx
          .update(tasks)
          .set({ state: 'stopped' })
          .where(and(eq(tasks.id, taskId), eq(tasks.state, 'queued')))
          .returning({ id: tasks.id });
        if (stopped.length === 0) return 'not_queued';
        await insertAudit(tx, entry);
        return 'ok';
      });
    },
    async setAutoDispatch({ repoId, on }, entry) {
      if (!isUuid(repoId)) return 'not_found';
      return db.transaction(async (tx): Promise<AutoDispatchChange | 'not_found'> => {
        // 锁住这一行：同一个仓的开、关排队做，before 就是改之前库里真正的值
        const [row] = await tx
          .select({ since: repos.autoDispatchSince })
          .from(repos)
          .where(eq(repos.id, repoId))
          .for('update');
        if (!row) return 'not_found';
        const before = row.since ? iso(row.since) : null;
        if (isAutoDispatchUnchanged(before, on)) return autoDispatchUnchanged(before);
        const [updated] = await tx
          .update(repos)
          .set({ autoDispatchSince: on ? now() : null })
          .where(eq(repos.id, repoId))
          .returning({ since: repos.autoDispatchSince });
        if (!updated) throw new Error(`仓 ${repoId} 锁住了却没改成`);
        const after = updated.since ? iso(updated.since) : null;
        const auditId = await insertAudit(tx, autoDispatchAudit(entry, before, after));
        return autoDispatchChanged(after, auditId);
      });
    },
  };
}

/** 收投递时按（对象，版）加的锁名：版本换成毫秒时刻再拼，写法不同（带不带毫秒）的同一时刻锁的是同一把。 */
function versionLockKey(v: Pick<GitHubObjectVersion, 'object' | 'version'>): string {
  return `github-version:${v.object}@${new Date(v.version).toISOString()}`;
}

/** 上次出错的、在等着的、处理中但占用早于 stale 的（那一次多半死了）：可以接过来重做。 */
function reclaimableRow(stale: Date) {
  return or(
    inArray(githubEvents.status, [...RECLAIMABLE_STATUSES]),
    and(eq(githubEvents.status, 'processing'), lt(githubEvents.claimedAt, stale)),
  );
}

/**
 * 接过来：重新记成处理中，次数加一（从等着接回来的不加：等上一轮不占自动重放的次数），凭据换成这次的时刻（旧凭据
 * 记不上结局了）。上次的原因留着，记下新结局时覆盖。SET 里读到的 status 是改之前的。
 */
function reclaimSet(at: Date) {
  return {
    status: 'processing' as const,
    attempts: sql`${githubEvents.attempts} + case when ${githubEvents.status} = ${ATTEMPT_FREE_STATUS} then 0 else 1 end`,
    claimedAt: at,
    finishedAt: null,
  };
}

function toDelivery(
  r: typeof githubEvents.$inferSelect,
  versions: Map<string, GitHubObjectVersion[]>,
): GitHubDelivery {
  return {
    id: r.deliveryId,
    event: r.event,
    action: opt(r.action),
    source: r.source,
    repo: opt(r.repo),
    versions: versions.get(r.deliveryId) ?? [],
    payload: r.payload,
    status: r.status,
    reason: opt(r.reason),
    note: opt(r.note),
    attempts: r.attempts,
    receivedAt: iso(r.receivedAt),
    claimedAt: iso(r.claimedAt),
    finishedAt: isoOpt(r.finishedAt),
  };
}

/** 应用的每条查询最多跑这么久（连接参数 statement_timeout）：表被锁住时接口几秒内报错，而不是一直挂着。 */
export const DB_STATEMENT_TIMEOUT_MS = 5_000;

/**
 * 给连接串加上会话默认的语句超时（连接串里已经写了就不动）。postgres.js 把连接串里它自己不认识的参数
 * 原样当启动参数发给库（postgres 包 src/index.js 的 parseOptions），所以池里每条连接、包括 LISTEN 那条，一连上就带着它。
 * 以后 @fleet-dao/db 的 createDb 能直接收连接参数了，改走那里。
 */
export function withStatementTimeout(url: string, ms = DB_STATEMENT_TIMEOUT_MS): string {
  if (/[?&]statement_timeout=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}statement_timeout=${ms}`;
}

/** Postgres 的错误码（SQLSTATE）。drizzle 把驱动的错误包在 cause 里，往里找几层。 */
export function sqlState(err: unknown): string | undefined {
  let e: unknown = err;
  for (let depth = 0; depth < 5 && e !== null && typeof e === 'object'; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}
