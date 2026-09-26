// 把内存版的数据（MemoryData 的形状）原样写进 Postgres，让两个 Store 在同一份数据上过同一套测试。
// 按外键先后写；库自己记的东西（状态变化、自增编号）由库生成，不从这里写。
import {
  asks,
  auditLog,
  bans,
  channels,
  type Db,
  families,
  feishuCards,
  feishuDrafts,
  feishuFollows,
  feishuOutbox,
  githubEvents,
  githubEventVersions,
  insertSubtasks,
  models,
  notificationDeliveries,
  notifications,
  pools,
  progressEvents,
  pullRequests,
  quotaWindows,
  repos,
  routes,
  scheduledJobs,
  scheduleRuns,
  sessionRuns,
  settings,
  specs,
  stagePolicies,
  stagePolicyRoutes,
  tasks,
  users,
} from '@fleet-dao/db';
import { sql } from 'drizzle-orm';
import type { MemoryData } from '../src/memory-store.ts';

const date = (iso: string) => new Date(iso);
const dateOpt = (iso: string | undefined) => (iso === undefined ? null : new Date(iso));

export async function seedPg(db: Db, data: Partial<MemoryData>): Promise<void> {
  const familyIds = [...new Set((data.models ?? []).map((m) => m.family))];
  if (familyIds.length > 0) {
    await db
      .insert(families)
      .values(familyIds.map((id) => ({ id, displayName: id, vendor: '样例' })))
      .onConflictDoNothing();
  }
  if (data.channels?.length) await db.insert(channels).values(data.channels);
  if (data.pools?.length) {
    await db.insert(pools).values(
      data.pools.map((p) => ({
        ...p,
        expiresAt: dateOpt(p.expiresAt),
        lastReadOkAt: dateOpt(p.lastReadOkAt),
      })),
    );
  }
  if (data.models?.length) {
    await db.insert(models).values(data.models.map((m) => ({ ...m, retiredAt: dateOpt(m.retiredAt) })));
  }
  if (data.routes?.length) {
    // 探针的结论在库里是三列（routes.probe_state、probed_at、probe_detail）；在线的路由必须带着 ok 的结论（库里约束）
    await db.insert(routes).values(
      data.routes.map(({ probe, ...r }) => ({
        ...r,
        probeState: probe?.state ?? null,
        probedAt: probe ? new Date(probe.at) : null,
        probeDetail: probe?.detail ?? null,
      })),
    );
  }
  for (const p of data.stagePolicies ?? []) {
    await db.insert(stagePolicies).values({ stage: p.stage, pinned: p.pinned });
    if (p.routeIds.length > 0) {
      await db.insert(stagePolicyRoutes).values(
        p.routeIds.map((routeId, position) => ({
          stage: p.stage,
          routeId,
          position,
          enabled: !p.disabledRouteIds?.includes(routeId),
        })),
      );
    }
  }
  if (data.bans?.length) {
    await db.insert(bans).values(
      data.bans.map((b) => ({
        family: b.family ?? null,
        modelId: b.modelId ?? null,
        stage: b.stage ?? null,
        reason: b.reason,
      })),
    );
  }
  // 额度窗照样例原样写（含「上游不再报」的标记）。库的写入口 savePoolQuota 会按读数现算这些标记，造不出任意现状。
  if (data.quotaWindows?.length) {
    await db.insert(quotaWindows).values(
      data.quotaWindows.map((w) => ({
        poolId: w.poolId,
        label: w.label,
        window: w.window,
        scope: w.scope ?? '',
        utilization: w.utilization ?? null,
        used: w.used ?? null,
        limit: w.limit ?? null,
        unit: w.unit,
        resetsAt: dateOpt(w.resetsAt),
        upstreamStatus: w.upstreamStatus ?? null,
        statusRaw: w.statusRaw ?? null,
        reading: w.reading,
        source: w.source,
        readAt: date(w.readAt),
        staleSince: dateOpt(w.staleSince),
      })),
    );
  }
  if (data.users?.length) {
    await db.insert(users).values(
      data.users.map((u) => ({
        id: u.id,
        displayName: u.displayName,
        role: u.role,
        active: u.active,
        avatarUrl: u.avatarUrl ?? null,
        feishuOpenId: u.feishuOpenId ?? null,
        feishuUnionId: u.feishuUnionId ?? null,
        githubLogin: u.githubLogin ?? null,
        githubId: u.githubId ?? null,
      })),
    );
  }
  if (data.repos?.length) {
    await db
      .insert(repos)
      .values(data.repos.map((r) => ({ ...r, autoDispatchSince: dateOpt(r.autoDispatchSince) })));
  }
  if (data.tasks?.length) {
    await db.insert(tasks).values(
      data.tasks.map((t) => ({
        id: t.id,
        repoId: t.repoId,
        issueNumber: t.issueNumber,
        title: t.title,
        rawRequest: t.rawRequest,
        requestedBy: t.requestedBy,
        state: t.state,
        priority: t.priority,
        specDir: t.specDir ?? null,
        acceptance: t.acceptance ?? [],
        createdAt: date(t.createdAt),
      })),
    );
  }
  for (const taskId of new Set((data.subtasks ?? []).map((s) => s.taskId))) {
    await insertSubtasks(
      db,
      taskId,
      (data.subtasks ?? []).filter((s) => s.taskId === taskId).map(({ taskId: _t, ...s }) => s),
    );
  }
  if (data.runs?.length) {
    await db.insert(sessionRuns).values(
      data.runs.map((r) => ({
        id: r.id,
        taskId: r.taskId ?? null,
        subtaskId: r.subtaskId ?? null,
        stage: r.stage,
        routeId: r.routeId,
        whyRoute: r.whyRoute,
        branch: r.branch ?? null,
        queuedAt: date(r.queuedAt),
        startedAt: dateOpt(r.startedAt),
        endedAt: dateOpt(r.endedAt),
        outcome: r.outcome ?? null,
        actualModel: r.actualModel ?? null,
        inputTokens: r.inputTokens ?? null,
        outputTokens: r.outputTokens ?? null,
        costUsd: r.costUsd ?? null,
      })),
    );
  }
  if (data.progress?.length) {
    await db.insert(progressEvents).values(
      data.progress.map((p) => ({
        runId: p.runId,
        at: date(p.at),
        kind: p.kind,
        payload: p.payload ?? null,
      })),
    );
  }
  if (data.asks?.length) {
    await db.insert(asks).values(
      data.asks.map((a) => ({
        id: a.id,
        taskId: a.taskId,
        runId: a.runId ?? null,
        question: a.question,
        options: a.options,
        askedAt: date(a.askedAt),
        answer: a.answer ?? null,
        answeredBy: a.answeredBy ?? null,
        answeredAt: dateOpt(a.answeredAt),
      })),
    );
  }
  for (const n of data.notifications ?? []) {
    await db.insert(notifications).values({
      id: n.id,
      level: n.level,
      dedupeKey: n.id,
      taskId: n.taskId ?? null,
      title: n.title,
      body: n.body,
      link: n.link ?? null,
      createdAt: date(n.createdAt),
      updatedAt: date(n.createdAt),
      resolvedAt: dateOpt(n.resolvedAt),
      resolvedBy: n.resolvedBy ?? null,
    });
    if (n.deliveries.length > 0) {
      await db.insert(notificationDeliveries).values(
        n.deliveries.map((d, i) => ({
          notificationId: n.id,
          channel: d.channel,
          target: d.target ?? `target-${i}`,
          messageId: d.messageId ?? null,
          attempts: d.attempts,
          lastError: d.error ?? null,
          lastAttemptAt: dateOpt(d.lastAttemptAt),
          deliveredAt: d.messageId ? dateOpt(d.lastAttemptAt) : null,
        })),
      );
    }
  }
  if (data.audit?.length) {
    await db.insert(auditLog).values(
      data.audit.map((a) => ({
        at: date(a.at),
        actorKind: a.actor.kind,
        actorId: a.actor.id,
        action: a.action,
        target: a.target,
        before: a.before ?? null,
        after: a.after ?? null,
        reason: a.reason ?? null,
        via: a.via,
        ok: a.ok,
        error: a.error ?? null,
      })),
    );
  }
  for (const s of data.settings ?? []) {
    await db.insert(settings).values({
      key: s.key,
      value: sql`${JSON.stringify(s.value ?? null)}::jsonb`,
      version: s.version,
      updatedAt: s.updatedAt ? date(s.updatedAt) : new Date(),
      updatedBy: s.updatedBy ?? null,
    });
  }
  if (data.jobs?.length) await db.insert(scheduledJobs).values(data.jobs);
  if (data.scheduleRuns?.length) {
    await db.insert(scheduleRuns).values(
      data.scheduleRuns.map((r) => ({
        job: r.job,
        startedAt: date(r.startedAt),
        endedAt: dateOpt(r.endedAt),
        outcome: r.outcome ?? null,
        scanned: r.scanned ?? null,
        found: r.found ?? null,
        why: r.why ?? null,
      })),
    );
  }
  if (data.pullRequests?.length) {
    await db
      .insert(pullRequests)
      .values(data.pullRequests.map((p) => ({ ...p, updatedAt: new Date('2026-09-25T00:00:00Z') })));
  }
  if (data.specs?.length) {
    await db.insert(specs).values(
      data.specs.map((s) => ({
        taskId: s.taskId,
        summary: s.summary,
        resultSummary: s.resultSummary ?? null,
        mergedAt: dateOpt(s.mergedAt),
      })),
    );
  }
  if (data.feishuDrafts?.length) {
    await db.insert(feishuDrafts).values(
      data.feishuDrafts.map((d) => ({
        ...d,
        repoId: d.repoId ?? null,
        createdAt: date(d.createdAt),
        updatedAt: date(d.updatedAt),
        confirmedBy: d.confirmedBy ?? null,
        confirmedAt: dateOpt(d.confirmedAt),
        taskId: d.taskId ?? null,
        openError: d.openError ?? null,
        openTriedAt: dateOpt(d.openTriedAt),
      })),
    );
  }
  if (data.feishuFollows?.length) {
    await db
      .insert(feishuFollows)
      .values(data.feishuFollows.map((f) => ({ ...f, updatedAt: date(f.updatedAt) })));
  }
  if (data.feishuCards?.length) {
    await db.insert(feishuCards).values(
      data.feishuCards.map((c) => ({
        messageId: c.messageId,
        chatId: c.chatId,
        kind: c.kind,
        taskId: c.ref.taskId ?? null,
        askId: c.ref.askId ?? null,
        draftId: c.ref.draftId ?? null,
        notificationId: c.ref.notificationId ?? null,
        outboxId: c.ref.outboxId ?? null,
        sentAt: date(c.sentAt),
        updatedAt: date(c.updatedAt),
      })),
    );
  }
  if (data.feishuOutbox?.length) {
    await db.insert(feishuOutbox).values(
      data.feishuOutbox.map((o) => ({
        id: o.id,
        revision: o.revision,
        fingerprint: o.fingerprint,
        createdAt: date(o.createdAt),
        updatedAt: date(o.updatedAt),
        ackRevision: o.ackRevision ?? null,
        ackStatus: o.ackStatus ?? null,
        ackReason: o.ackReason ?? null,
        ackedAt: dateOpt(o.ackedAt),
        holdUntil: dateOpt(o.holdUntil),
        failures: o.failures,
        deliveredMessageId: o.deliveredMessageId ?? null,
        deliveredChatId: o.deliveredChatId ?? null,
        deliveredAt: dateOpt(o.deliveredAt),
        deliveredRevision: o.deliveredRevision ?? null,
      })),
    );
  }
  for (const e of data.githubEvents?.values() ?? []) {
    await db.insert(githubEvents).values({
      deliveryId: e.id,
      event: e.event,
      action: e.action ?? null,
      source: e.source,
      repo: e.repo ?? null,
      payload: sql`${JSON.stringify(e.payload ?? null)}::jsonb`,
      status: e.status,
      reason: e.reason ?? null,
      note: e.note ?? null,
      attempts: e.attempts,
      receivedAt: date(e.receivedAt),
      claimedAt: date(e.claimedAt),
      finishedAt: dateOpt(e.finishedAt),
    });
    if (e.versions.length > 0) {
      await db.insert(githubEventVersions).values(
        e.versions.map((v) => ({
          deliveryId: e.id,
          object: v.object,
          version: date(v.version),
          state: v.state ?? null,
        })),
      );
    }
  }
}
