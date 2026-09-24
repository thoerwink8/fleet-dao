// 把库里的记录拼成驾驶舱要的样子。纯函数，不碰数据库，测试直接喂数据。
import {
  type ActivitySchema,
  type Ban,
  type BoardResponse,
  type BoardSubtaskSchema,
  type BoardTaskSchema,
  type Channel,
  type HostId,
  hardBanFor,
  type JobViewSchema,
  type Model,
  type NotificationSchema,
  type Pool,
  type PoolViewSchema,
  type ProgressSchema,
  type QuotaWindow,
  type Repo,
  type Route,
  type RunSchema,
  type SessionRun,
  type StageKind,
  type Subtask,
  type Task,
} from '@fleet-dao/shared';
import type { z } from 'zod';
import type { JobRecord, NotificationRecord, RunPlan, TimelineRecord } from './ports.ts';

type Activity = z.input<typeof ActivitySchema>;
type Progress = z.input<typeof ProgressSchema>;

export const STAGE_WORDS: Record<StageKind, string> = {
  triage: '分诊',
  spec: '写需求文档',
  plan: '写方案',
  execute: '写码',
  ui: '写界面',
  review: '审查',
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
}

export function routeLookup(routes: Route[], models: Model[]): (routeId: string) => RouteInfo {
  const routeById = new Map(routes.map((r) => [r.id, r]));
  const modelById = new Map(models.map((m) => [m.id, m]));
  return (routeId) => {
    const route = routeById.get(routeId);
    const model = route ? modelById.get(route.modelId) : undefined;
    return { modelName: model?.displayName ?? '未知模型', hostId: route?.hostId, route, model };
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
    costUsd: run.costUsd,
  };
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
    .filter((r) => titleOf.has(r.taskId))
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
  const hard = hardBanFor(info.model, stage);
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
    windows: QuotaWindow[];
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
  return input.pools.map((p) => {
    const channel = channelById.get(p.channelId);
    const windows = input.windows
      .filter((w) => w.poolId === p.id)
      .map((w) => ({
        window: w.window,
        utilization: w.utilization,
        used: w.used,
        limit: w.limit,
        resetsAt: w.resetsAt,
        reading: w.reading,
        readAt: w.readAt,
        stale: now.getTime() - Date.parse(w.readAt) > staleAfterMs,
      }));
    const quotaStatus: 'fresh' | 'stale' | 'unread' =
      windows.length === 0 ? 'unread' : windows.some((w) => w.stale) ? 'stale' : 'fresh';
    return {
      id: p.id,
      channelId: p.channelId,
      channelName: channel?.name ?? '未知渠道（库里查不到）',
      billing: channel?.billing ?? null,
      channelEnabled: channel?.enabled ?? false,
      maxConcurrency: p.maxConcurrency,
      running: running.get(p.id) ?? 0,
      expiresAt: p.expiresAt,
      quotaStatus,
      windows,
    };
  });
}

// —— 定时任务 ——

/** 允许错过一次：超过两个周期还没成功才算 overdue。 */
export function jobView(job: JobRecord, now: Date): z.input<typeof JobViewSchema> {
  let status: 'fresh' | 'overdue' | 'never' = 'never';
  if (job.lastSuccessAt) {
    const age = now.getTime() - Date.parse(job.lastSuccessAt);
    status = age > 2 * job.expectEveryMinutes * 60_000 ? 'overdue' : 'fresh';
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

// —— 时间线 ——

function field(payload: unknown, key: string): unknown {
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>)[key] : undefined;
}

function text(payload: unknown, key: string): string | undefined {
  const v = field(payload, key);
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

const ACTION_WORDS: Record<string, string> = {
  pause: '暂停',
  resume: '继续',
  stop: '叫停',
  reroute: '换路由',
};

/** 一行白话。会话被动读出来的 file/test/tool 的载荷由插头决定，这里只认常见字段，认不出就只写种类。 */
export function describeTimeline(rec: TimelineRecord): string {
  const p = rec.payload;
  switch (rec.kind) {
    case 'say':
      return text(p, 'text') ?? '报了一句进度';
    case 'plan': {
      const steps = field(p, 'steps');
      if (!Array.isArray(steps)) return '更新了步骤清单';
      const done = steps.filter((s) => field(s, 'state') === 'done').length;
      const current = steps.find((s) => field(s, 'state') === 'in_progress');
      const now = current ? text(current, 'title') : undefined;
      return `步骤清单：完成 ${done}/${steps.length}${now ? `，正在${now.replace(/^正在/, '')}` : ''}`;
    }
    case 'ask':
      return `问：${text(p, 'question') ?? '（没带问题原文）'}`;
    case 'done':
      return `交活：${text(p, 'summary') ?? '（没带说明）'}`;
    case 'blocked':
      return `卡住：${text(p, 'reason') ?? '（没带原因）'}`;
    case 'test': {
      const passed = field(p, 'passed');
      const cmd = text(p, 'command');
      const verdict = passed === true ? '通过' : passed === false ? '没过' : '结果没读到';
      return `跑测试${cmd ? `（${cmd}）` : ''}：${verdict}`;
    }
    case 'file':
      return `改文件：${text(p, 'path') ?? '（没带路径）'}`;
    case 'tool':
      return `用工具：${text(p, 'name') ?? '（没带名字）'}`;
    case 'state':
      return `状态：${text(p, 'from') ?? '?'} → ${text(p, 'to') ?? '?'}`;
    case 'answer':
      return `回答追问：${text(p, 'answer') ?? '（没带回答原文）'}`;
    case 'done_rejected': {
      const reasons = field(p, 'reasons');
      const why = Array.isArray(reasons) ? reasons.filter((r) => typeof r === 'string').join('；') : '';
      const head = field(p, 'code') === 'not_verifiable_yet' ? '交活暂时核实不了' : '交活被退回';
      return why ? `${head}：${why}` : head;
    }
    default: {
      const word = ACTION_WORDS[rec.kind];
      if (!word) return rec.kind;
      // 先记后做：没做成的那一条（ok=false）单独写明。
      if (field(p, 'ok') === false) return `${word}没做成：${text(p, 'error') ?? '原因没记下'}`;
      const reason = text(p, 'reason');
      return reason ? `${word}：${reason}` : word;
    }
  }
}
