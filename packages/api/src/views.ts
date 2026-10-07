// 把库里的记录拼成驾驶舱要的样子。纯函数，不碰数据库，测试直接喂数据。

import { poolDataTimes, quotaReadOverdue } from '@fleet-dao/db';
import {
  type ActivitySchema,
  type Ban,
  type BillingKind,
  type BoardResponse,
  type BoardSubtaskSchema,
  type BoardTaskSchema,
  type Channel,
  flowStages,
  type HomeDecisionSchema,
  type HomeDoneSchema,
  type HomeHealthSchema,
  type HomeResponseSchema,
  type HomeRunningSchema,
  type HostId,
  hardBanFor,
  type JobViewSchema,
  type Model,
  type NotificationSchema,
  type Pool,
  type PoolViewSchema,
  type ProgressSchema,
  type Repo,
  type Route,
  type RunSchema,
  readSegmentRun,
  type SegmentRunView,
  type SessionRun,
  type StageKind,
  type Subtask,
  summarizeUsage,
  type Task,
  type TaskUsage,
  taskFlow,
} from '@fleet-dao/shared';
import type { z } from 'zod';
import type {
  JobRecord,
  NotificationRecord,
  PullRequestRecord,
  QuotaWindowRecord,
  RunPlan,
  SegmentRunRecord,
} from './ports.ts';

type Activity = z.input<typeof ActivitySchema>;
type Progress = z.input<typeof ProgressSchema>;

export const STAGE_WORDS: Record<StageKind, string> = {
  triage: '分诊',
  spec: '写需求文档',
  plan: '写方案',
  execute: '写码',
  ui: '写界面',
  review: '审查',
  verify: '开 PR 前验证',
  research: '调研',
  judge: '判断',
};

const TERMINAL_TASK_STATES = new Set(['done', 'stopped', 'failed']);

export function isTaskFinished(task: Task): boolean {
  return TERMINAL_TASK_STATES.has(task.state);
}

export interface RouteInfo {
  modelName: string;
  hostId?: HostId | undefined;
  route?: Route | undefined;
  model?: Model | undefined;
  /** 路由所在渠道的计费方式；没传渠道表、渠道查不到就没有——任务详情照「分不清」显示，不猜成套餐内。 */
  billing?: BillingKind | undefined;
}

/** channels 只有要分清按量、套餐内的地方（任务详情的花费）才传。 */
export function routeLookup(
  routes: Route[],
  models: Model[],
  channels: Channel[] = [],
): (routeId: string) => RouteInfo {
  const routeById = new Map(routes.map((r) => [r.id, r]));
  const modelById = new Map(models.map((m) => [m.id, m]));
  const channelById = new Map(channels.map((c) => [c.id, c]));
  return (routeId) => {
    const route = routeById.get(routeId);
    const model = route ? modelById.get(route.modelId) : undefined;
    const billing = route ? channelById.get(route.channelId)?.billing : undefined;
    return { modelName: model?.displayName ?? '未知模型', hostId: route?.hostId, route, model, billing };
  };
}

export function progressOf(plan: RunPlan | undefined): Progress | undefined {
  if (!plan || plan.steps.length === 0) return undefined;
  return { done: plan.steps.filter((s) => s.state === 'done').length, total: plan.steps.length };
}

export function activityOf(run: SessionRun, plan: RunPlan | undefined, info: RouteInfo): Activity {
  const queued = !run.startedAt;
  const step = plan?.steps.find((s) => s.state === 'in_progress')?.title;
  const doing = queued ? '排队中' : `正在${(step ?? STAGE_WORDS[run.stage]).replace(/^正在/, '')}`;
  return {
    runId: run.id,
    stage: run.stage,
    routeId: run.routeId,
    modelName: info.modelName,
    hostId: info.hostId,
    queued,
    since: run.startedAt ?? run.queuedAt,
    step,
    text: `${info.modelName} ${doing}`,
  };
}

function latest(runs: SessionRun[]): SessionRun | undefined {
  let best: SessionRun | undefined;
  for (const r of runs) {
    if (!best || (r.startedAt ?? r.queuedAt) > (best.startedAt ?? best.queuedAt)) best = r;
  }
  return best;
}

export function runView(run: SessionRun, info: RouteInfo): z.input<typeof RunSchema> {
  return {
    id: run.id,
    subtaskId: run.subtaskId,
    stage: run.stage,
    routeId: run.routeId,
    modelName: info.modelName,
    hostId: info.hostId,
    whyRoute: run.whyRoute,
    queuedAt: run.queuedAt,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    outcome: run.outcome,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    cacheReadTokens: run.cacheReadTokens,
    cacheWriteTokens: run.cacheWriteTokens,
    costUsd: run.costUsd,
    billing: info.billing,
  };
}

/**
 * 任务详情的用量汇总：记在路由上的模型名下（和 Fusion 关单评论「各模型额度」一个口径），算法在 shared 的 usage.ts。
 * 花费按渠道的计费方式分按量、套餐内：route 要用带渠道表的 routeLookup，不然全记成分不清。
 * segments 是三段读好的流水（segmentRunViews 的结果）：合计、按模型里一起算，另出按段一组。
 */
export function usageView(
  runs: readonly SessionRun[],
  route: (routeId: string) => RouteInfo,
  segments: readonly SegmentRunView[] = [],
): TaskUsage {
  return summarizeUsage(
    runs.map((r) => {
      const info = route(r.routeId);
      return {
        ...r,
        model: info.route?.modelId ?? r.routeId,
        modelName: info.modelName,
        billing: info.billing,
      };
    }),
    segments,
  );
}

/**
 * 三段流水读给任务详情：模型名查模型目录（查不到照写模型编号），计费方式查渠道表（渠道查不到就不给，花费记进分不清）。
 * 认段名、算起止、点名没读到的在 shared 的 segment-runs.ts；单子已经结束时，开着的那一段算没收尾、不算在跑。
 */
export function segmentRunViews(
  records: readonly SegmentRunRecord[],
  ctx: { models: readonly Model[]; channels: readonly Channel[]; taskFinished: boolean },
): SegmentRunView[] {
  const modelById = new Map(ctx.models.map((m) => [m.id, m]));
  const channelById = new Map(ctx.channels.map((c) => [c.id, c]));
  return records.map((r) =>
    readSegmentRun(
      {
        ...r,
        modelName: modelById.get(r.model)?.displayName ?? r.model,
        billing: r.channel === undefined ? undefined : channelById.get(r.channel)?.billing,
      },
      { taskFinished: ctx.taskFinished },
    ),
  );
}

export interface BoardInput {
  tasks: Task[];
  subtasks: Subtask[];
  /** 只放没结束的会话。 */
  activeRuns: SessionRun[];
  plans: Map<string, RunPlan>;
  route: (routeId: string) => RouteInfo;
}

export function subtaskViews(taskId: string, input: BoardInput): z.input<typeof BoardSubtaskSchema>[] {
  return input.subtasks
    .filter((s) => s.taskId === taskId)
    .sort((a, b) => a.index - b.index)
    .map((s) => {
      const run = latest(input.activeRuns.filter((r) => r.subtaskId === s.id));
      const plan = run ? input.plans.get(run.id) : undefined;
      return {
        id: s.id,
        index: s.index,
        title: s.title,
        state: s.state,
        prNumber: s.prNumber,
        dependsOn: s.dependsOn,
        touches: s.touches,
        progress: progressOf(plan),
        activity: run ? activityOf(run, plan, input.route(run.routeId)) : undefined,
      };
    });
}

export function taskActivity(taskId: string, input: BoardInput): Activity | undefined {
  const run = latest(input.activeRuns.filter((r) => r.taskId === taskId && !r.subtaskId));
  return run ? activityOf(run, input.plans.get(run.id), input.route(run.routeId)) : undefined;
}

export function buildBoard(repo: Repo, input: BoardInput, now: Date): z.input<typeof BoardResponse> {
  const tasks = [...input.tasks].sort(
    (a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt),
  );
  const titleOf = new Map(tasks.map((t) => [t.id, t.title]));
  const boardTasks: z.input<typeof BoardTaskSchema>[] = tasks.map((t) => {
    const subtasks = subtaskViews(t.id, input);
    return {
      id: t.id,
      issueNumber: t.issueNumber,
      title: t.title,
      state: t.state,
      priority: t.priority,
      requestedBy: t.requestedBy,
      createdAt: t.createdAt,
      progress: { done: subtasks.filter((s) => s.state === 'merged').length, total: subtasks.length },
      activity: taskActivity(t.id, input),
      subtasks,
    };
  });
  const now_ = input.activeRuns
    // 不属于任何需求的会话（帅位、考新模型）不上仓的看板。
    .filter((r): r is SessionRun & { taskId: string } => r.taskId !== undefined && titleOf.has(r.taskId))
    .map((r) => ({
      ...activityOf(r, input.plans.get(r.id), input.route(r.routeId)),
      taskId: r.taskId,
      taskTitle: titleOf.get(r.taskId) ?? '',
      subtaskId: r.subtaskId,
    }));
  return {
    repo: { id: repo.id, owner: repo.owner, name: repo.name, defaultBranch: repo.defaultBranch },
    tasks: boardTasks,
    now: now_,
    asOf: now.toISOString(),
  };
}

// —— 调度台 ——

/** 这个模型在这个阶段犯不犯禁令（禁令至少要写族或模型之一，只写阶段的不算）。 */
export function findBan(model: Model, stage: StageKind | undefined, bans: Ban[]): Ban | undefined {
  return bans.find((b) => {
    if (b.family === undefined && b.modelId === undefined) return false;
    if (b.family !== undefined && b.family.toLowerCase() !== model.family.toLowerCase()) return false;
    if (b.modelId !== undefined && b.modelId !== model.id) return false;
    if (b.stage !== undefined && b.stage !== stage) return false;
    return true;
  });
}

/**
 * 一条路由能不能挂到这个阶段；能就返回 null，不能就返回白话原因。
 * 先过写死的硬禁令（shared/bans.ts），再过库里配的 bans——库里的表空了，硬禁令照样拦。
 */
export function routeProblem(
  routeId: string,
  stage: StageKind | undefined,
  ctx: { route: (id: string) => RouteInfo; bans: Ban[]; now: Date },
): string | null {
  const info = ctx.route(routeId);
  if (!info.route) return `路由 ${routeId} 不存在`;
  if (!info.model) return `路由 ${routeId} 用的模型 ${info.route.modelId} 不在模型目录里`;
  const where = stage ? `「${STAGE_WORDS[stage]}」` : '这里';
  const hard = hardBanFor(
    {
      ...info.model,
      upstreamModel: info.route.upstreamModel,
      upstreamAliases: info.route.upstreamAliases,
    },
    stage,
  );
  if (hard) return `${info.model.displayName} 不能用在${where}：${hard.reason}`;
  const ban = findBan(info.model, stage, ctx.bans);
  if (ban) return `${info.model.displayName} 不能用在${where}：${ban.reason}`;
  if (info.model.retiredAt && info.model.retiredAt <= ctx.now.toISOString()) {
    return `${info.model.displayName} 已下架`;
  }
  return null;
}

// —— 账号池与额度 ——

export function buildPools(
  input: {
    pools: Pool[];
    channels: Channel[];
    windows: QuotaWindowRecord[];
    routes: Route[];
    activeRuns: SessionRun[];
  },
  now: Date,
  staleAfterMs: number,
): z.input<typeof PoolViewSchema>[] {
  const channelById = new Map(input.channels.map((ch) => [ch.id, ch]));
  const poolOfRoute = new Map(input.routes.map((r) => [r.id, r.poolId]));
  const running = new Map<string, number>();
  for (const run of input.activeRuns) {
    const poolId = poolOfRoute.get(run.routeId);
    if (poolId && run.startedAt) running.set(poolId, (running.get(poolId) ?? 0) + 1);
  }
  // 「上游数据本身的时刻」照数据库包的算法（还在报的窗口里最新的读数时刻），不自己另算一份。
  const dataTimes = poolDataTimes(
    input.windows.map((w) => ({
      poolId: w.poolId,
      readAt: new Date(w.readAt),
      staleSince: w.staleSince ? new Date(w.staleSince) : null,
    })),
  );
  const resetKey = (w: QuotaWindowRecord) => (w.resetsAt ? Date.parse(w.resetsAt) : Number.POSITIVE_INFINITY);
  return input.pools.map((p) => {
    const channel = channelById.get(p.channelId);
    const windows = input.windows
      .filter((w) => w.poolId === p.id)
      // 和数据库包的额度表（quotaTable）同一个排法：快清零的在前，同时清零的按原名。
      .sort((a, b) => resetKey(a) - resetKey(b) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
      .map((w) => ({
        label: w.label,
        window: w.window,
        scope: w.scope,
        // 可以大于 1（超额），原样给出，前端画进度条时再截。
        utilization: w.utilization,
        used: w.used,
        limit: w.limit,
        unit: w.unit,
        resetsAt: w.resetsAt,
        upstreamStatus: w.upstreamStatus,
        statusRaw: w.statusRaw,
        reading: w.reading,
        source: w.source,
        readAt: w.readAt,
        staleSince: w.staleSince,
        stale: now.getTime() - Date.parse(w.readAt) > staleAfterMs,
      }));
    const dataAt = dataTimes.get(p.id);
    // 按池判，和每小时对账、选路由同一个判法（数据库包的 quotaReadOverdue），不逐窗口看。
    const overdue = quotaReadOverdue(
      { lastReadOkAt: p.lastReadOkAt ? new Date(p.lastReadOkAt) : null, dataAt: dataAt ?? null },
      now,
      staleAfterMs,
    );
    return {
      id: p.id,
      channelId: p.channelId,
      channelName: channel?.name ?? '未知渠道（库里查不到）',
      billing: channel?.billing ?? null,
      channelEnabled: channel?.enabled ?? false,
      ...(p.orgKind ? { orgKind: p.orgKind } : {}),
      maxConcurrency: p.maxConcurrency,
      running: running.get(p.id) ?? 0,
      expiresAt: p.expiresAt,
      quotaStatus: p.lastReadOkAt === undefined ? 'unread' : overdue ? 'stale' : 'fresh',
      lastReadOkAt: p.lastReadOkAt,
      dataAt: dataAt?.toISOString(),
      windows,
    };
  });
}

// —— 新主页（/，#589）——

type HomeDecision = z.input<typeof HomeDecisionSchema>;
type HomeRunning = z.input<typeof HomeRunningSchema>;
type HomeDone = z.input<typeof HomeDoneSchema>;
type HomeHealth = z.input<typeof HomeHealthSchema>;

/**
 * 「要你拍的」：decision 级未处理通知（approvals 未决在写下那一刻就同步开了这么一条，不另查 approvals 表，
 * 免得一件事显示两回），按时刻新到旧。
 */
export function homeDecisions(input: {
  notifications: NotificationRecord[];
  taskOf: (taskId: string) => { issueNumber: number; title: string } | undefined;
}): HomeDecision[] {
  const items: HomeDecision[] = [];
  for (const n of input.notifications) {
    if (n.level !== 'decision') continue;
    const task = n.taskId ? input.taskOf(n.taskId) : undefined;
    items.push({
      kind: n.dedupeKey?.startsWith('approval:') ? 'approval' : 'notification',
      id: n.id,
      title: n.title,
      ...(task ? { context: `#${task.issueNumber} ${task.title}` } : {}),
      since: n.createdAt,
      link: n.link ?? (n.taskId ? `/tasks/${n.taskId}` : '/notifications'),
    });
  }
  return items.sort((a, b) => b.since.localeCompare(a.since));
}

/** 哪张单有什么在等创始人拍：decision 级未处理通知，每张单取最新的一条。 */
export function pendingDecisionByTask(input: {
  notifications: NotificationRecord[];
}): Map<string, { title: string; since: string }> {
  const out = new Map<string, { title: string; since: string }>();
  const put = (taskId: string | undefined, title: string, since: string) => {
    if (taskId === undefined) return;
    const prev = out.get(taskId);
    if (!prev || since > prev.since) out.set(taskId, { title, since });
  };
  for (const n of input.notifications) if (n.level === 'decision') put(n.taskId, n.title, n.createdAt);
  return out;
}

/**
 * 「在跑的」：没结束的需求（done / stopped / failed 之外）。在哪一段、谁在做、最近一次事件从三段流水推（home-flow.ts 的
 * taskFlow），「还没验」不许按字段猜成失败；一笔流水都没记的老单 segment 是 null。waitingReason：有人在等创始人回答
 * （state=asking，只有旧会话留下的单会是这个状态）→ founder_decision（有 decision 级通知就从它的时刻起算，没有就不给起点）；有 run 排队没开工 → queue；动手收了验收还没起 → verify_round；
 * 在合并 → merge_queue；其余 nothing。额度、内存、CI 这几种等 segment 之外的信号才分得出，分不出时不猜。
 */
export function homeRunning(input: {
  tasks: Task[];
  activeRuns: SessionRun[];
  repoOf: (repoId: string) => { owner: string; name: string } | undefined;
  segmentRunsOf: (taskId: string) => SegmentRunView[];
  decisionOf: (taskId: string) => { title: string; since: string } | undefined;
}): HomeRunning[] {
  const taskIds = new Set(input.tasks.map((t) => t.id));
  const queuedByTask = new Map<string, SessionRun>();
  for (const r of input.activeRuns) {
    if (r.taskId === undefined || !taskIds.has(r.taskId) || r.startedAt !== undefined) continue;
    const prev = queuedByTask.get(r.taskId);
    if (!prev || r.queuedAt < prev.queuedAt) queuedByTask.set(r.taskId, r);
  }
  return [...input.tasks]
    .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt))
    .map((t) => {
      const repo = input.repoOf(t.repoId);
      const queued = queuedByTask.get(t.id);
      const asking = t.state === 'asking';
      const flow = taskFlow(t, input.segmentRunsOf(t.id));
      const decision = input.decisionOf(t.id);
      const waitingReason: HomeRunning['waitingReason'] = asking
        ? 'founder_decision'
        : queued
          ? 'queue'
          : flow.segment === 'verify_pending'
            ? 'verify_round'
            : flow.segment === 'merge'
              ? 'merge_queue'
              : 'nothing';
      const waitingSince = asking
        ? decision?.since
        : queued
          ? queued.queuedAt
          : waitingReason === 'verify_round' || waitingReason === 'merge_queue'
            ? flow.stageSince
            : undefined;
      return {
        issueNumber: t.issueNumber,
        title: t.title,
        repo: repo ? `${repo.owner}/${repo.name}` : '（仓不在库里）',
        segment: flow.segment,
        waitingReason,
        ...(waitingSince ? { waitingSince } : {}),
        taskSince: t.createdAt,
        ...(flow.stageSince ? { stageSince: flow.stageSince } : {}),
        ...(flow.worker ? { worker: flow.worker } : {}),
        ...(decision ? { pendingDecision: decision.title } : {}),
        ...(flow.lastEvent ? { lastEvent: flow.lastEvent } : {}),
        link: `/tasks/${t.id}`,
        taskId: t.id,
      };
    });
}

/** 「做完的」：镜像里 merged 的 PR，按合并时刻新到旧；打开/合并时刻没读到过的排不进（listPullRequests 已兜住）。 */
export function homeDone(input: {
  merged: PullRequestRecord[];
  repoOf: (repoId: string) => { owner: string; name: string } | undefined;
  taskOfIssue: (repoId: string, issueNumber: number) => { title: string } | undefined;
}): HomeDone[] {
  const out: HomeDone[] = [];
  for (const p of input.merged) {
    if (!p.mergedAt) continue;
    const repo = input.repoOf(p.repoId);
    // 挂的单反查标题；一篇 PR 挂几张单时取第一张（镜像的认法）。一个都没挂上只显示 PR 号。
    const issue = p.issueRefs?.[0];
    const task = issue === undefined ? undefined : input.taskOfIssue(p.repoId, issue);
    out.push({
      prNumber: p.number,
      title: task?.title ?? `PR #${p.number}`,
      repo: repo ? `${repo.owner}/${repo.name}` : '（仓不在库里）',
      mergedAt: p.mergedAt,
      ...(issue === undefined ? {} : { issueNumber: issue }),
    });
  }
  return out;
}

/**
 * 持续状态条。额度看各池的「读成没有、快清零没有」（unread/stale 是「没查成」不是「没用量」）；
 * 中转看有在线路由没有、有没有探不通的；引擎只看这台机器 release.env 的开关（运行时状态不在这里判）。
 * 有问题都持续显示、不伪装成失败：tight / degraded / off 都不是红。
 */
export function homeHealth(input: {
  pools: z.input<typeof PoolViewSchema>[];
  routes: Route[];
  /** 引擎那一格：home-engine.ts 的探针现算好的（开着的才真探），这里原样放进去。 */
  engine: HomeHealth['engine'];
}): HomeHealth {
  const pools = input.pools;
  let quota: HomeHealth['quota'];
  if (pools.length === 0) {
    quota = { state: 'empty', detail: '还没配账号池' };
  } else if (pools.every((p) => p.quotaStatus === 'unread')) {
    quota = { state: 'unknown', detail: '额度一次都还没读成' };
  } else {
    const tight = pools.filter((p) =>
      p.windows.some(
        (w) =>
          !w.stale &&
          ((w.utilization !== undefined && w.utilization >= 0.9) || w.upstreamStatus === 'limit_reached'),
      ),
    );
    const unreadCount = pools.filter((p) => p.quotaStatus === 'unread').length;
    quota =
      tight.length > 0
        ? {
            state: 'tight',
            detail: `${tight.map((p) => p.channelName).join('、')}快清零或已超限`,
          }
        : {
            state: 'ok',
            detail:
              unreadCount > 0
                ? `${pools.length - unreadCount} 块池在限度内；${unreadCount} 块还没读成`
                : `${pools.length} 块池都在限度内`,
          };
  }

  const routes = input.routes;
  let routesHealth: HomeHealth['routes'];
  if (routes.length === 0 || routes.every((r) => r.probe === undefined)) {
    routesHealth = { state: 'unknown', detail: '探针还没出过结论' };
  } else {
    const alive = routes.filter((r) => r.alive).length;
    const failed = routes.filter((r) => r.probe?.state === 'failed');
    routesHealth =
      failed.length > 0 || alive === 0
        ? {
            state: 'degraded',
            detail: failed.length > 0 ? `${failed.length} 条路由探不通；${alive} 条在线` : '没有在线路由',
          }
        : { state: 'ok', detail: `${alive} 条路由在线` };
  }

  return {
    quota,
    routes: routesHealth,
    engine: input.engine,
  };
}

export function buildHome(input: {
  notifications: NotificationRecord[];
  tasks: Task[];
  activeRuns: SessionRun[];
  merged: PullRequestRecord[];
  repos: Repo[];
  pools: z.input<typeof PoolViewSchema>[];
  routes: Route[];
  engine: HomeHealth['engine'];
  /** 看板窗口里所有单的三段流水（store.listSegmentRunsForTasks）+ 模型表 / 渠道表（读模型名、计费方式用）。 */
  segmentRuns: SegmentRunRecord[];
  models: Model[];
  channels: Channel[];
  now: Date;
}): z.input<typeof HomeResponseSchema> {
  const taskById = new Map(input.tasks.map((t) => [t.id, t]));
  const taskByIssue = new Map(input.tasks.map((t) => [`${t.repoId}#${t.issueNumber}`, t]));
  const repoById = new Map(input.repos.map((r) => [r.id, r]));
  const finishedTaskIds = new Set(
    input.tasks.filter((t) => TERMINAL_TASK_STATES.has(t.state)).map((t) => t.id),
  );
  // 单子结束与否决定「开着的那一笔」算在跑还是没收尾（readSegmentRun 的 taskFinished），所以按这个分两批读
  const runViews = new Map<string, SegmentRunView[]>();
  const allViews: SegmentRunView[] = [];
  for (const taskFinished of [true, false]) {
    const records = input.segmentRuns.filter(
      (r) => (r.taskId !== undefined && finishedTaskIds.has(r.taskId)) === taskFinished,
    );
    const batch = segmentRunViews(records, { models: input.models, channels: input.channels, taskFinished });
    batch.forEach((view, i) => {
      allViews.push(view);
      const taskId = records[i]?.taskId;
      if (taskId !== undefined) runViews.set(taskId, [...(runViews.get(taskId) ?? []), view]);
    });
  }
  const decisionByTask = pendingDecisionByTask(input);
  // 「要你拍的」「做完的」可能挂到不在 running 那份清单里的单（做完了的）；反查用全量。这里 tasks 由调用方给全量。
  const running = homeRunning({
    tasks: input.tasks.filter((t) => !TERMINAL_TASK_STATES.has(t.state)),
    activeRuns: input.activeRuns,
    repoOf: (repoId) => repoById.get(repoId),
    segmentRunsOf: (taskId) => runViews.get(taskId) ?? [],
    decisionOf: (taskId) => decisionByTask.get(taskId),
  });
  return {
    decisions: homeDecisions({
      notifications: input.notifications,
      taskOf: (taskId) => taskById.get(taskId),
    }),
    running,
    flow: flowStages(allViews, running),
    done: homeDone({
      merged: input.merged,
      repoOf: (repoId) => repoById.get(repoId),
      taskOfIssue: (repoId, issueNumber) => taskByIssue.get(`${repoId}#${issueNumber}`),
    }),
    health: homeHealth({ pools: input.pools, routes: input.routes, engine: input.engine }),
    asOf: input.now.toISOString(),
  };
}

// —— 定时任务 ——

/**
 * 上次跑成（ok / partial）距今超过 expectEveryMinutes 就算过期——这个数登记时已经含了周期、抖动和一轮耗时
 * （packages/db 的 scheduled_jobs 说明），所以不再另加余量。
 */
export function jobView(job: JobRecord, now: Date): z.input<typeof JobViewSchema> {
  let status: 'fresh' | 'overdue' | 'never' = 'never';
  if (job.lastSuccessAt) {
    const age = now.getTime() - Date.parse(job.lastSuccessAt);
    status = age > job.expectEveryMinutes * 60_000 ? 'overdue' : 'fresh';
  }
  return {
    id: job.id,
    name: job.name,
    schedule: job.schedule,
    expectEveryMinutes: job.expectEveryMinutes,
    lastRun: job.lastRun,
    lastSuccessAt: job.lastSuccessAt,
    status,
  };
}

// —— 通知 ——

export function notificationView(n: NotificationRecord): z.input<typeof NotificationSchema> {
  return {
    id: n.id,
    level: n.level,
    title: n.title,
    body: n.body,
    link: n.link,
    taskId: n.taskId,
    createdAt: n.createdAt,
    resolvedAt: n.resolvedAt,
    resolvedBy: n.resolvedBy,
    deliveries: n.deliveries.map((d) => ({
      channel: d.channel,
      delivered: !!d.messageId,
      attempts: d.attempts,
      error: d.error,
      lastAttemptAt: d.lastAttemptAt,
    })),
  };
}
