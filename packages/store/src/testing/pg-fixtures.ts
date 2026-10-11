// 把内存版的数据（MemoryData 的形状）原样写进 Postgres，让两个 Store 在同一份数据上过同一套测试。
// 按外键先后写；库自己记的东西（状态变化、自增编号）由库生成，不从这里写。

import {
  auditLog,
  bans,
  channelStates,
  channels,
  type Db,
  families,
  githubEvents,
  githubEventVersions,
  insertSubtasks,
  models,
  nodeReports,
  notificationDeliveries,
  notifications,
  pools,
  progressEvents,
  pullRequests,
  quotaWindows,
  repos,
  routes,
  runs,
  scheduledJobs,
  scheduleRuns,
  sessionRuns,
  settings,
  specs,
  tasks,
  users,
} from '@fleet-dao/db';
import { sql } from 'drizzle-orm';
import type { MemoryData } from '../memory-store.ts';

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
    // 节奏列（#1798 片 6）：domain 里 probeNextAt 是 ISO 串，入库要转成 Date；没写过的不塞。
    await db.insert(routes).values(
      data.routes.map(({ probe, goneAt, probeNextAt, ...r }) => ({
        ...r,
        goneAt: dateOpt(goneAt),
        probeNextAt: dateOpt(probeNextAt),
        probeState: probe?.state ?? null,
        probedAt: probe ? new Date(probe.at) : null,
        probeDetail: probe?.detail ?? null,
      })),
    );
  }
  // 渠道近态引用渠道、路由、模型：这三样都写完才能写
  if (data.channelStates?.length) {
    await db.insert(channelStates).values(
      data.channelStates.map((s) => ({
        channelId: s.channelId,
        status: s.status,
        reason: s.reason ?? null,
        failedRouteId: s.failedRouteId ?? null,
        fallbackChannelId: s.fallbackChannelId ?? null,
        fallbackModelId: s.fallbackModelId ?? null,
        lastProbedAt: dateOpt(s.lastProbedAt),
        flaggedAt: dateOpt(s.flaggedAt),
        updatedAt: date(s.updatedAt),
      })),
    );
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
        // 没给就用库的默认（建库那一刻）；给了就照写，listUsers 的顺序契约要靠它造出不同的创建时刻。
        ...(u.createdAt !== undefined && { createdAt: new Date(u.createdAt) }),
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
        // 暂停的单：引擎写 phase='paused'、doing 是那句话（和 db 的 toTask 读回去一致）
        ...(t.paused === undefined ? {} : { phase: 'paused', doing: t.paused }),
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
        cacheReadTokens: r.cacheReadTokens ?? null,
        cacheWriteTokens: r.cacheWriteTokens ?? null,
        costUsd: r.costUsd ?? null,
        testCommand: r.testCommand ?? null,
      })),
    );
  }
  if (data.segmentRuns?.length) {
    await db.insert(runs).values(
      data.segmentRuns.map((r) => ({
        id: r.id,
        segment: r.segment,
        taskId: r.taskId ?? null,
        issueNumber: r.issueNumber ?? null,
        model: r.model,
        channel: r.channel ?? null,
        tier: r.tier ?? null,
        startedAt: date(r.startedAt),
        endedAt: dateOpt(r.endedAt),
        outcome: r.outcome ?? null,
        inputTokens: r.inputTokens ?? null,
        outputTokens: r.outputTokens ?? null,
        cacheReadTokens: r.cacheReadTokens ?? null,
        cacheWriteTokens: r.cacheWriteTokens ?? null,
        costUsd: r.costUsd ?? null,
        memoryPeakMb: r.memoryPeakMb ?? null,
        failureReason: r.failureReason ?? null,
        prNumber: r.prNumber ?? null,
        branch: r.branch ?? null,
        workflowId: r.workflowId ?? null,
        retryOf: r.retryOf ?? null,
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
  for (const n of data.notifications ?? []) {
    await db.insert(notifications).values({
      id: n.id,
      level: n.level,
      dedupeKey: n.dedupeKey ?? n.id,
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
  if (data.nodeReports?.length) {
    await db.insert(nodeReports).values(
      data.nodeReports.map((r) => ({
        nodeId: r.nodeId,
        displayName: r.displayName,
        schemaVersion: r.schemaVersion,
        codeSha: r.codeSha ?? null,
        reportedAt: date(r.reportedAt),
        receivedAt: date(r.receivedAt),
        payload: r.snapshot,
      })),
    );
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
    await db.insert(pullRequests).values(
      data.pullRequests.map((p) => ({
        repoId: p.repoId,
        number: p.number,
        state: p.state,
        headRef: p.headRef,
        headSha: p.headSha,
        checks: p.checks,
        updatedAt: p.updatedAt ? new Date(p.updatedAt) : new Date('2026-09-25T00:00:00Z'),
        openedAt: dateOpt(p.openedAt),
        mergedAt: dateOpt(p.mergedAt),
        issueRefs: p.issueRefs ?? [],
      })),
    );
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
