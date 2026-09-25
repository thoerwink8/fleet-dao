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
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { PublicHealthError } from './health.ts';
import { isSerial, isUuid, parseCursor } from './ids.ts';
import {
  type AskRecord,
  type AuditRecord,
  type CommandClaim,
  type GitHubDelivery,
  type GitHubObjectVersion,
  type JobRecord,
  type NewAuditEntry,
  type NotificationRecord,
  type Page,
  type PullRequestRecord,
  REPO_NOT_MANAGED,
  type RunPlan,
  type SettingRecord,
  type Store,
  type TestRunRecord,
  type TimelineRecord,
  type User,
} from './ports.ts';

export interface PgStoreOptions {
  now?: () => Date;
}

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

  const commandKey = (runId: string, key: string) => `fleet:${runId}:${key}`;
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
      const cursor = parseCursor(page.cursor);
      if (!isUuid(taskId)) return { items: [] };
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
      return rows.map((r) => {
        const mine = links.filter((l) => l.stage === r.stage);
        return toStagePolicy(
          r,
          mine.map((l) => l.routeId),
          mine.filter((l) => !l.enabled).map((l) => l.routeId),
        );
      });
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
        const current = await tx
          .select({ routeId: stagePolicyRoutes.routeId, enabled: stagePolicyRoutes.enabled })
          .from(stagePolicyRoutes)
          .where(eq(stagePolicyRoutes.stage, stage))
          .orderBy(asc(stagePolicyRoutes.position));
        const currentIds = current.map((r) => r.routeId);
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
        // 排序是删掉重插：每条路由的开关照原样带回去（关着的仍关着）；这次新挂进来的开着。
        const enabledBefore = new Map(current.map((r) => [r.routeId, r.enabled]));
        await tx.delete(stagePolicyRoutes).where(eq(stagePolicyRoutes.stage, stage));
        if (next.routeIds.length > 0) {
          await tx.insert(stagePolicyRoutes).values(
            next.routeIds.map((routeId, position) => ({
              stage,
              routeId,
              position,
              enabled: enabledBefore.get(routeId) ?? true,
            })),
          );
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
      return db.transaction(async (tx) => {
        // 表上唯一的冲突来源是 (run_id, md5(question)) 这条唯一索引（主键是随机 uuid），所以不写冲突目标。
        const [inserted] = await tx
          .insert(asks)
          .values({ taskId, runId, question, options: choices, askedAt: now() })
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
      const cutoff = new Date(takeOverBefore);
      // 占用凭据就是这次占用的时刻（claimed_at，毫秒，本 Store 写的）：接管会把它改新，旧请求拿着旧凭据放不掉、也记不上。
      // 最多试三轮：占不到、读的时候又刚被放掉，再来一次。
      for (let round = 0; round < 3; round++) {
        const at = now();
        const inserted = await db
          .insert(idempotencyKeys)
          .values({ key: k, action, target: `run:${runId}`, claimedAt: at })
          .onConflictDoNothing()
          .returning({ key: idempotencyKeys.key });
        if (inserted.length > 0) return { status: 'claimed', token: iso(at) };
        const [row] = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, k));
        if (!row) continue;
        if (row.action !== action) return { status: 'other-action', action: row.action };
        if (row.completedAt !== null) return { status: 'done', result: row.result };
        if (!(row.claimedAt < cutoff)) return { status: 'in-flight', claimedAt: iso(row.claimedAt) };
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
        if (taken.length > 0) return { status: 'claimed', token: iso(at), tookOver: true };
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
      let seenBefore = false;
      if (skipIfSeen) {
        // 带过这一版的别的投递（同一版一般只有一两条）：有没被门挡掉的就不再做；只有被挡掉的，照样做、回 seenBefore
        const carriers = await db
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
        if (carriers.some((c) => c.status !== 'ignored')) return { status: 'duplicate' };
        seenBefore = carriers.some((c) => c.reason !== REPO_NOT_MANAGED);
      }
      const seen = seenBefore ? { seenBefore } : {};
      const at = now();
      const inserted = await db.transaction(async (tx) => {
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
        return rows;
      });
      if (inserted.length > 0) return { status: 'claimed', token: iso(at), retry: false, ...seen };
      // 已经有这一条：条件更新是原子的，两个请求同时来接，只有一个接得到
      const taken = await db
        .update(githubEvents)
        .set(reclaimSet(at))
        .where(and(eq(githubEvents.deliveryId, delivery.id), reclaimableRow(new Date(staleBefore))))
        .returning({ id: githubEvents.deliveryId });
      return taken.length > 0
        ? { status: 'claimed', token: iso(at), retry: true, ...seen }
        : { status: 'duplicate' };
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
      if (!existing) return { status: 'not_found' };
      return { status: existing.status === 'processing' ? 'in_flight' : 'finished' };
    },
    async finishDelivery(id, token, outcome) {
      const rows = await db
        .update(githubEvents)
        .set({
          status: outcome.status,
          reason: outcome.status === 'accepted' ? null : outcome.reason,
          note: outcome.status === 'accepted' ? (outcome.note ?? null) : null,
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
          stale: sql<number>`count(*) filter (where ${githubEvents.status} = 'processing' and ${githubEvents.claimedAt} < ${new Date(staleBefore)})::int`,
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
      return row
        ? { ...toRepo(row), autoDispatchSince: row.autoDispatchSince ? iso(row.autoDispatchSince) : null }
        : null;
    },
    async findTaskByIssue(repoId, issueNumber) {
      if (!isUuid(repoId)) return null;
      const [row] = await db
        .select()
        .from(tasks)
        .where(and(eq(tasks.repoId, repoId), eq(tasks.issueNumber, issueNumber)));
      return row ? toTask(row) : null;
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
  };
}

/** 上次出错的、在等着的、处理中但占用早于 stale 的（那一次多半死了）：可以接过来重做。 */
function reclaimableRow(stale: Date) {
  return or(
    inArray(githubEvents.status, ['failed', 'waiting']),
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
    attempts: sql`${githubEvents.attempts} + case when ${githubEvents.status} = 'waiting' then 0 else 1 end`,
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

/** 健康检查探库的上限：比单项上限（health.ts 的 3 秒）早到点，报出来的是「查库超时」而不是笼统的超时。 */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * 健康检查用：真去读登录和首页要用的表（users、repos、tasks），本事务里等锁和跑语句都限时，到点报红。
 * 只 select 1 查不出「表被锁住」：锁表时它照样秒回，接口却全卡住。
 */
export async function probeDb(db: Db, timeoutMs = PROBE_TIMEOUT_MS): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      const ms = String(timeoutMs);
      await tx.execute(
        sql`select set_config('lock_timeout', ${ms}, true), set_config('statement_timeout', ${ms}, true)`,
      );
      await tx.execute(
        sql`select (select 1 from ${users} limit 1), (select 1 from ${repos} limit 1), (select 1 from ${tasks} limit 1)`,
      );
    });
  } catch (err) {
    const code = sqlState(err);
    // 57014 = 语句超时，55P03 = 等锁超时。
    if (code === '57014' || code === '55P03') {
      throw new PublicHealthError('timeout', `查库超过 ${timeoutMs / 1000} 秒没回来（多半有表被锁住）`);
    }
    throw err;
  }
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
