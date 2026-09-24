// Postgres 版 Store：用 @fleet-dao/db 的表和查询实现 ports.ts 的 Store。和 memory-store.ts 过同一套契约测试。
// 约定：
// - 这个 Store 自己写的时间一律用传进来的时钟（和后端其余部分同一个钟）；库自己记的（状态变化等）用库的钟。
// - 按编号查的方法：编号不是 uuid 就当「没有」，不让它变成 SQL 报错（编号来自网址）。
// - 「改数据 + 写操作记录」放在同一个事务里：操作记录写不进，改动一起回滚。
// - 翻页游标是 `时刻|编号`；库里的时刻比毫秒精细，比较时截到毫秒，和游标的精度一致，翻页不漏同一毫秒里的几条。
import {
  asks,
  auditLog,
  bans,
  type ClaimResult,
  channels,
  claimIdempotencyKey,
  completeIdempotencyKey,
  type Db,
  idempotencyKeys,
  models,
  notificationDeliveries,
  notifications,
  pools,
  progressEvents,
  pullRequests,
  quotaWindows,
  releaseIdempotencyKey,
  repos,
  routes,
  scheduleHealth,
  searchSpecs,
  sessionRuns,
  settings,
  stagePolicies,
  stagePolicyRoutes,
  stateChanges,
  subtaskDeps,
  subtasks,
  TERMINAL_TASK_STATES,
  type TimelineEvent,
  tasks,
  taskTimeline,
  toBan,
  toChannel,
  toModel,
  toPool,
  toQuotaWindow,
  toRepo,
  toRoute,
  toSessionRun,
  toStagePolicy,
  toSubtask,
  toTask,
  users,
} from '@fleet-dao/db';
import type { ProgressKind, Step } from '@fleet-dao/shared';
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type {
  AskRecord,
  AuditRecord,
  CommandClaim,
  JobRecord,
  NewAuditEntry,
  NotificationRecord,
  Page,
  PullRequestRecord,
  RunPlan,
  SettingRecord,
  Store,
  TestRunRecord,
  TimelineRecord,
  User,
} from './ports.ts';

export interface PgStoreOptions {
  now?: () => Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string): boolean => UUID.test(s);

const RECENT_TERMINAL_MS = 7 * 24 * 60 * 60_000;
const opt = <V>(v: V | null): V | undefined => v ?? undefined;
const iso = (d: Date) => d.toISOString();
const isoOpt = (d: Date | null) => (d ? d.toISOString() : undefined);
/** 自增编号补零：和 packages/db 时间线事件编号的写法一致（按字面比较就是按数值比较）。 */
const seq15 = (n: number) => String(n).padStart(15, '0');

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

function parseCursor(cursor: string | undefined): { at: string; id: string } | 'bad' | null {
  if (!cursor) return null;
  const sep = cursor.lastIndexOf('|');
  const at = cursor.slice(0, sep);
  if (sep <= 0 || Number.isNaN(Date.parse(at))) return 'bad';
  return { at: new Date(at).toISOString(), id: cursor.slice(sep + 1) };
}

function planSteps(payload: unknown): Step[] {
  const raw =
    typeof payload === 'object' && payload !== null ? (payload as { steps?: unknown }).steps : undefined;
  return (Array.isArray(raw) ? raw : [])
    .filter(
      (s): s is { title: string; state: Step['state'] } =>
        typeof s === 'object' && s !== null && typeof s.title === 'string' && typeof s.state === 'string',
    )
    .map((s, index) => ({ index, title: s.title, state: s.state }));
}

/** 库里的时间线事件 → 驾驶舱的时间线记录（操作记录的 after / error 另查补上）。 */
function timelineRecord(e: TimelineEvent, subtaskOfRun: Map<string, string | null>): TimelineRecord {
  const base = { id: e.id, at: iso(e.at) };
  switch (e.type) {
    case 'state':
      return {
        ...base,
        source: 'engine',
        kind: 'state',
        subtaskId: e.entity === 'subtask' ? e.entityId : undefined,
        payload: { entity: e.entity, from: e.from ?? undefined, to: e.to },
      };
    case 'run-queued':
      return {
        ...base,
        source: 'engine',
        kind: 'run_queued',
        runId: e.runId,
        subtaskId: opt(e.subtaskId),
        payload: { stage: e.stage, routeId: e.routeId, whyRoute: e.whyRoute },
      };
    case 'run-started':
      return {
        ...base,
        source: 'engine',
        kind: 'run_started',
        runId: e.runId,
        subtaskId: opt(subtaskOfRun.get(e.runId) ?? null),
        payload: { queueMs: opt(e.queueMs) },
      };
    case 'run-ended':
      return {
        ...base,
        source: 'engine',
        kind: 'run_ended',
        runId: e.runId,
        subtaskId: opt(subtaskOfRun.get(e.runId) ?? null),
        payload: { outcome: e.outcome, runMs: opt(e.runMs) },
      };
    case 'progress':
      return {
        ...base,
        source: 'session',
        kind: e.kind,
        runId: e.runId,
        subtaskId: opt(subtaskOfRun.get(e.runId) ?? null),
        payload: e.payload,
      };
    case 'audit':
      return {
        ...base,
        source: e.actorKind === 'user' ? 'person' : e.actorKind === 'agent' ? 'session' : 'engine',
        kind: e.action.split('.').at(-1) ?? e.action,
        payload: { reason: opt(e.reason), ok: e.ok },
      };
    case 'notification':
      return { ...base, source: 'engine', kind: 'notification', payload: { level: e.level, title: e.title } };
  }
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

  const commandKey = (runId: string, key: string) => `fleet:${runId}:${key}`;

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
      const terminal: readonly string[] = TERMINAL_TASK_STATES;
      const finished = rows.filter((t) => terminal.includes(t.state)).map((t) => t.id);
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
      const cutoff = now().getTime() - RECENT_TERMINAL_MS;
      return rows
        .filter((t) => !terminal.includes(t.state) || (since.get(t.id) ?? t.createdAt).getTime() >= cutoff)
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
    async listTimeline(taskId, page) {
      if (!isUuid(taskId)) return { items: [] };
      const cursor = parseCursor(page.cursor);
      if (cursor === 'bad') return { items: [] };
      const timeline = await taskTimeline(db, taskId);
      if (!timeline) return { items: [] };
      const subtaskOfRun = new Map(timeline.runs.map((r) => [r.id, r.subtaskId]));
      // 库给的是按 (at, id) 正序，倒过来就是倒序。
      const all = timeline.events.map((e) => timelineRecord(e, subtaskOfRun)).reverse();
      let start = 0;
      if (cursor) {
        start = all.findIndex((r) => r.at < cursor.at || (r.at === cursor.at && r.id < cursor.id));
        if (start === -1) start = all.length;
      }
      const items = all.slice(start, start + page.limit);
      // 操作记录的 after（回答原文、交活被退回的原因……）和 error 库里的时间线不带，按这一页里的编号补上。
      const auditIds = items.filter((r) => r.id.startsWith('audit:')).map((r) => Number(r.id.slice(6)));
      if (auditIds.length > 0) {
        const rows = new Map(
          (await db.select().from(auditLog).where(inArray(auditLog.id, auditIds))).map((r) => [
            `audit:${seq15(r.id)}`,
            r,
          ]),
        );
        for (const item of items) {
          const row = rows.get(item.id);
          if (!row) continue;
          item.payload = {
            ...(row.after && typeof row.after === 'object' ? row.after : {}),
            reason: opt(row.reason),
            ok: row.ok,
            error: opt(row.error),
          };
        }
      }
      const last = items.at(-1);
      return {
        items,
        nextCursor: last && start + page.limit < all.length ? `${last.at}|${last.id}` : undefined,
      };
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
    async listStagePolicies() {
      const [rows, links] = await Promise.all([
        db.select().from(stagePolicies).orderBy(asc(stagePolicies.stage)),
        db
          .select()
          .from(stagePolicyRoutes)
          .orderBy(asc(stagePolicyRoutes.stage), asc(stagePolicyRoutes.position)),
      ]);
      return rows.map((r) =>
        toStagePolicy(
          r,
          links.filter((l) => l.stage === r.stage).map((l) => l.routeId),
        ),
      );
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
    async updateStagePolicy({ stage, expected, next }, entry) {
      return db.transaction(async (tx) => {
        // 同一阶段的修改排队做。库里还没有这个阶段的行时，for update 锁不住任何东西，靠这把事务级咨询锁。
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stage_policy:${stage}`}))`);
        const [row] = await tx
          .select()
          .from(stagePolicies)
          .where(eq(stagePolicies.stage, stage))
          .for('update');
        const currentIds = (
          await tx
            .select({ routeId: stagePolicyRoutes.routeId })
            .from(stagePolicyRoutes)
            .where(eq(stagePolicyRoutes.stage, stage))
            .orderBy(asc(stagePolicyRoutes.position))
        ).map((r) => r.routeId);
        const pinned = row?.pinned ?? false;
        const same =
          pinned === expected.pinned &&
          currentIds.length === expected.routeIds.length &&
          currentIds.every((id, i) => id === expected.routeIds[i]);
        if (!same) return 'conflict';
        await tx
          .insert(stagePolicies)
          .values({ stage, pinned: next.pinned })
          .onConflictDoUpdate({ target: stagePolicies.stage, set: { pinned: next.pinned } });
        await tx.delete(stagePolicyRoutes).where(eq(stagePolicyRoutes.stage, stage));
        if (next.routeIds.length > 0) {
          await tx
            .insert(stagePolicyRoutes)
            .values(next.routeIds.map((routeId, position) => ({ stage, routeId, position })));
        }
        await insertAudit(tx, entry);
        return 'ok';
      });
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
      const cursor = parseCursor(raw);
      if (cursor === 'bad' || (cursor && !isUuid(cursor.id))) return { items: [] };
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
      return { items, nextCursor: rows.length > limit && last ? `${last.createdAt}|${last.id}` : undefined };
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
      const cursor = parseCursor(raw);
      if (cursor === 'bad' || (cursor && !/^\d+$/.test(cursor.id))) return { items: [] };
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
      const last = items.at(-1);
      return { items, nextCursor: rows.length > limit && last ? `${last.at}|${last.id}` : undefined };
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
      const [row] = await db
        .select({ run: sessionRuns, task: tasks })
        .from(sessionRuns)
        .innerJoin(tasks, eq(tasks.id, sessionRuns.taskId))
        .where(eq(sessionRuns.id, runId));
      if (!row) return null;
      return {
        runId: row.run.id,
        taskId: row.task.id,
        subtaskId: opt(row.run.subtaskId),
        stage: row.run.stage,
        repoId: row.task.repoId,
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
    async openAsk({ runId, taskId, question, options: choices }) {
      // 表上唯一的冲突来源是 (run_id, md5(question)) 这条唯一索引（主键是随机 uuid），所以不写冲突目标。
      const [inserted] = await db
        .insert(asks)
        .values({ taskId, runId, question, options: choices, askedAt: now() })
        .onConflictDoNothing()
        .returning();
      if (inserted) return { ask: toAsk(inserted), created: true };
      const [existing] = await db
        .select()
        .from(asks)
        .where(and(eq(asks.runId, runId), sql`md5(${asks.question}) = md5(${question})`));
      if (!existing) throw new Error(`追问写不进也读不到（会话 ${runId}）`);
      return { ask: toAsk(existing), created: false };
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
      return row
        ? {
            repoId: row.repoId,
            number: row.number,
            state: row.state,
            headRef: row.headRef,
            headSha: row.headSha,
            checks: row.checks,
          }
        : null;
    },
    async listTestRuns(runId) {
      if (!isUuid(runId)) return [];
      const rows = await db
        .select({ at: progressEvents.at, payload: progressEvents.payload })
        .from(progressEvents)
        .where(and(eq(progressEvents.runId, runId), eq(progressEvents.kind, 'test')))
        .orderBy(asc(progressEvents.at), asc(progressEvents.id));
      return rows.flatMap((r): TestRunRecord[] => {
        const payload = r.payload as { passed?: unknown; command?: unknown } | null;
        if (typeof payload?.passed !== 'boolean') return [];
        return [
          {
            at: iso(r.at),
            passed: payload.passed,
            command: typeof payload.command === 'string' ? payload.command : undefined,
          },
        ];
      });
    },
    async claimCommand({ runId, key, action, takeOverBefore }): Promise<CommandClaim> {
      const k = commandKey(runId, key);
      const input = { key: k, action, target: `run:${runId}` };
      const toClaim = (c: ClaimResult): CommandClaim =>
        c.status === 'claimed'
          ? c
          : c.status === 'done'
            ? { status: 'done', result: c.result }
            : { status: 'in-flight', claimedAt: iso(c.claimedAt) };
      const first = await claimIdempotencyKey(db, input, now());
      const cutoff = new Date(takeOverBefore);
      if (first.status !== 'in-flight' || !(first.claimedAt < cutoff)) return toClaim(first);
      // 条件更新是原子的：两个请求同时来接，后一个等前一个提交后重新判条件，claimed_at 已经变新，接不到。
      const taken = await db
        .update(idempotencyKeys)
        .set({ claimedAt: now(), action })
        .where(
          and(
            eq(idempotencyKeys.key, k),
            isNull(idempotencyKeys.completedAt),
            lt(idempotencyKeys.claimedAt, cutoff),
          ),
        )
        .returning({ key: idempotencyKeys.key });
      if (taken.length > 0) return { status: 'claimed', tookOver: true };
      return toClaim(await claimIdempotencyKey(db, input, now()));
    },
    async completeCommand({ runId, key }, result) {
      await completeIdempotencyKey(db, commandKey(runId, key), result, now());
    },
    async releaseCommand({ runId, key }) {
      await releaseIdempotencyKey(db, commandKey(runId, key));
    },

    // —— GitHub ——
    async claimDelivery({ id, event, source }) {
      const claim = await claimIdempotencyKey(
        db,
        { key: `github-delivery:${id}`, action: `github.${event}`, target: source },
        now(),
      );
      return claim.status === 'claimed' ? 'new' : 'duplicate';
    },
    async releaseDelivery(id) {
      await releaseIdempotencyKey(db, `github-delivery:${id}`);
    },
  };
}

/** 健康检查用：库连得上、能查。 */
export async function pingDb(db: Db): Promise<void> {
  await db.execute(sql`select 1`);
}
