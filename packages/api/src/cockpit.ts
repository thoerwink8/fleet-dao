// 驾驶舱接口（/api）：看板、任务、步骤、调度台、账号池与额度、定时任务、通知、操作记录、设置、实时推送、发给工作流的信号。
// 读一律从数据库读（不直接查 GitHub）；每个写操作都留操作记录。路径取自 shared/web-api.ts 的 WebRoutes。
import {
  AnswerAskRequest,
  AnswerAskResponse,
  AuditQuery,
  AuditResponse,
  BoardResponse,
  HARD_BANS,
  JobsResponse,
  MeResponse,
  NotificationsQuery,
  NotificationsResponse,
  type NotWired,
  PageQuery,
  PoolsResponse,
  ReposResponse,
  ResolveNotificationResponse,
  RoutingResponse,
  RunStepsResponse,
  SETTING_SCHEMAS,
  type SettingKey,
  SettingsResponse,
  StageKindSchema,
  type StagePolicy,
  TaskActionRequest,
  TaskActionResponse,
  TaskDetailResponse,
  TimelineResponse,
  UpdateChannelRequest,
  UpdateChannelResponse,
  UpdateSettingRequest,
  UpdateSettingResponse,
  UpdateStagePolicyRequest,
  UpdateStagePolicyResponse,
  WebRoutes,
} from '@fleet-dao/shared';
import { type Context, Hono } from 'hono';
import type { z } from 'zod';
import { answerAsk } from './answer-ask.ts';
import { meBody } from './auth.ts';
import type { AskWaiters } from './changes.ts';
import { registerCredentialRoutes } from './credentials.ts';
import { registerDemoRoutes } from './demo.ts';
import type { Deps, NotWiredMark } from './deps.ts';
import { ApiError, readJson, readQuery, reply } from './http.ts';
import {
  type Actor,
  type NewAuditEntry,
  type Store,
  type TaskSignal,
  WorkflowGoneError,
  WorkflowUnavailableError,
} from './ports.ts';
import { type CockpitEnv, checkGatewayTaskAction, requireSession } from './session.ts';
import { eventsHandler, type SseRelay } from './sse.ts';
import { requirementWorkflowIdForTask } from './temporal.ts';
import {
  buildBoard,
  buildPools,
  describeTimeline,
  isTaskFinished,
  jobView,
  notificationView,
  routeLookup,
  routeProblem,
  runView,
  subtaskViews,
} from './views.ts';

const ACTION_WORDS = { pause: '暂停', resume: '继续', stop: '叫停', reroute: '换路由' } as const;

export function cockpitRoutes(deps: Deps, waiters: AskWaiters, relay: SseRelay): Hono<CockpitEnv> {
  const { config, store } = deps;
  const app = new Hono<CockpitEnv>();
  app.use('*', requireSession(config, store, deps.now));

  const actorOf = (c: Context<CockpitEnv>): Actor => ({ kind: 'user', id: c.get('user').id });

  /**
   * 先记后做：操作记录写不进就抛错，信号不发。命令按任务发给需求工作流，编号查库拼（requirementWorkflowIdForTask）。
   * 信号没发成再追加一条 ok=false 的记录（工作流不在了 409、Temporal 没接上或连不上 503、别的 502）；
   * 这一条也写不进时只能留日志，但不改变返回给人的结果。
   */
  async function signalAndAudit(taskId: string, signal: TaskSignal, audit: NewAuditEntry): Promise<void> {
    await store.appendAudit(audit);
    try {
      const workflowId = await requirementWorkflowIdForTask(store, taskId);
      await deps.workflows.signal(workflowId, signal);
    } catch (err) {
      const gone = err instanceof WorkflowGoneError;
      const unavailable = err instanceof WorkflowUnavailableError;
      const error = gone ? 'workflow_gone' : unavailable ? 'workflow_unavailable' : String(err);
      try {
        await store.appendAudit({ ...audit, ok: false, error });
      } catch (auditErr) {
        deps.log.error('信号没发成，这条失败记录也没写进去', { taskId, error, auditError: String(auditErr) });
      }
      if (gone) throw new ApiError(409, 'workflow_gone', '这个任务的工作流已经结束或不存在');
      deps.log.error('发信号失败', { taskId, signal: signal.name, error: String(err) });
      if (unavailable) throw new ApiError(503, 'workflow_unavailable', '工作流服务暂时连不上，稍后再试');
      throw new ApiError(502, 'workflow_unreachable', '发给工作流的信号没发出去，稍后再试');
    }
  }

  app.get(WebRoutes.me.path, (c) => reply(c, MeResponse, meBody(config, c.get('user'), c.get('session'))));

  app.get(WebRoutes.events.path, eventsHandler(deps, relay));

  app.get(WebRoutes.repos.path, async (c) => {
    const repos = await store.listRepos();
    return reply(c, ReposResponse, { repos });
  });

  app.get(WebRoutes.board.path, async (c) => {
    const repo = await store.getRepo(c.req.param('repoId'));
    if (!repo) throw new ApiError(404, 'repo_not_found', '没有这个仓');
    const tasks = await store.listBoardTasks(repo.id);
    const taskIds = tasks.map((t) => t.id);
    const [subtasks, activeRuns, routes, models] = await Promise.all([
      store.listSubtasks(taskIds),
      store.listRuns({ taskIds, active: true }),
      store.listRoutes(),
      store.listModels(),
    ]);
    const plans = await store.getPlans(activeRuns.map((r) => r.id));
    const route = routeLookup(routes, models);
    return reply(
      c,
      BoardResponse,
      buildBoard(repo, { tasks, subtasks, activeRuns, plans, route }, deps.now()),
    );
  });

  app.get(WebRoutes.task.path, async (c) => {
    const task = await store.getTask(c.req.param('taskId'));
    if (!task) throw new ApiError(404, 'task_not_found', '没有这个任务');
    const [repo, subtasks, runs, asks, routes, models] = await Promise.all([
      store.getRepo(task.repoId),
      store.listSubtasks([task.id]),
      store.listRuns({ taskIds: [task.id] }),
      store.listAsks(task.id),
      store.listRoutes(),
      store.listModels(),
    ]);
    if (!repo) throw new ApiError(500, 'repo_missing', `任务 ${task.id} 所在的仓不在库里`);
    const activeRuns = runs.filter((r) => !r.endedAt);
    const plans = await store.getPlans(activeRuns.map((r) => r.id));
    const route = routeLookup(routes, models);
    return reply(c, TaskDetailResponse, {
      task,
      repo,
      subtasks: subtaskViews(task.id, { tasks: [task], subtasks, activeRuns, plans, route }),
      runs: runs.map((r) => runView(r, route(r.routeId))),
      asks: asks.map((a) => ({
        id: a.id,
        runId: a.runId,
        question: a.question,
        options: a.options,
        askedAt: a.askedAt,
        status: a.answer === undefined ? ('pending' as const) : ('answered' as const),
        answer: a.answer,
        answeredBy: a.answeredBy,
        answeredAt: a.answeredAt,
      })),
    });
  });

  app.get(WebRoutes.timeline.path, async (c) => {
    const taskId = c.req.param('taskId');
    const page = readQuery(c, PageQuery);
    if (!(await store.getTask(taskId))) throw new ApiError(404, 'task_not_found', '没有这个任务');
    const { items, nextCursor } = await store.listTimeline(taskId, page);
    return reply(c, TimelineResponse, {
      items: items.map((rec) => ({
        id: rec.id,
        at: rec.at,
        source: rec.source,
        kind: rec.kind,
        runId: rec.runId,
        subtaskId: rec.subtaskId,
        text: describeTimeline(rec),
        detail: rec.payload,
      })),
      nextCursor,
    });
  });

  app.post(WebRoutes.taskAction.path, async (c) => {
    const taskId = c.req.param('taskId');
    const body = await readJson(c, TaskActionRequest);
    checkGatewayTaskAction(c, body.action);
    const task = await store.getTask(taskId);
    if (!task) throw new ApiError(404, 'task_not_found', '没有这个任务');
    if (isTaskFinished(task)) {
      throw new ApiError(
        409,
        'task_finished',
        `任务已经结束（${task.state}），不能再${ACTION_WORDS[body.action]}`,
      );
    }
    const by = c.get('user').id;
    let signal: TaskSignal;
    switch (body.action) {
      case 'pause':
        signal = { name: 'pause', by, reason: body.reason };
        break;
      case 'resume':
        signal = { name: 'resume', by };
        break;
      case 'stop':
        signal = { name: 'stop', by, reason: body.reason };
        break;
      case 'reroute': {
        const running = (await store.listRuns({ taskIds: [taskId], active: true })).filter(
          (r) => body.subtaskId === undefined || r.subtaskId === body.subtaskId,
        );
        const target = running.sort((a, b) =>
          (b.startedAt ?? b.queuedAt).localeCompare(a.startedAt ?? a.queuedAt),
        )[0];
        if (!target) throw new ApiError(409, 'no_active_run', '这个任务现在没有在跑的会话，没法换路由');
        const [routes, models, bans] = await Promise.all([
          store.listRoutes(),
          store.listModels(),
          store.listBans(),
        ]);
        const route = routeLookup(routes, models);
        const problem = routeProblem(body.routeId, target.stage, { route, bans, now: deps.now() });
        if (problem) throw new ApiError(422, 'route_not_allowed', problem);
        if (!route(body.routeId).route?.alive) throw new ApiError(422, 'route_offline', '这条路由现在不在线');
        signal = {
          name: 'reroute',
          by,
          routeId: body.routeId,
          subtaskId: target.subtaskId,
          reason: body.reason,
        };
        break;
      }
    }
    const { name: _name, by: _by, ...detail } = signal;
    await signalAndAudit(taskId, signal, {
      actor: actorOf(c),
      action: `task.${body.action}`,
      target: `task:${taskId}`,
      after: detail,
      reason: 'reason' in body ? body.reason : undefined,
      via: c.get('via'),
      ok: true,
    });
    return reply(c, TaskActionResponse, { ok: true });
  });

  app.get(WebRoutes.runSteps.path, async (c) => {
    const run = await store.getRun(c.req.param('runId'));
    if (!run) throw new ApiError(404, 'run_not_found', '没有这个会话');
    const [plans, lastSay] = await Promise.all([store.getPlans([run.id]), store.lastSay(run.id)]);
    const plan = plans.get(run.id);
    return reply(c, RunStepsResponse, {
      runId: run.id,
      steps: plan?.steps ?? [],
      updatedAt: plan?.updatedAt,
      lastSay: lastSay ?? undefined,
    });
  });

  app.post(WebRoutes.answerAsk.path, async (c) => {
    const askId = c.req.param('askId');
    const { answer } = await readJson(c, AnswerAskRequest);
    const ask = await store.getAsk(askId);
    if (!ask) throw new ApiError(404, 'ask_not_found', '没有这条追问');
    const result = await answerAsk(deps, waiters, {
      askId,
      taskId: ask.taskId,
      answer,
      by: actorOf(c),
      via: c.get('via'),
    });
    if (result === 'not_found') throw new ApiError(404, 'ask_not_found', '没有这条追问');
    if (result === 'already_answered') throw new ApiError(409, 'already_answered', '这条追问已经有人回答了');
    return reply(c, AnswerAskResponse, { ok: true });
  });

  app.get(WebRoutes.routing.path, async (c) => {
    const [channels, pools, models, routes, policies, bans] = await Promise.all([
      store.listChannels(),
      store.listPools(),
      store.listModels(),
      store.listRoutes(),
      store.listStagePolicies(),
      store.listBans(),
    ]);
    const byStage = new Map(policies.map((p) => [p.stage, p]));
    const stages: StagePolicy[] = StageKindSchema.options.map(
      (stage) => byStage.get(stage) ?? { stage, routeIds: [], pinned: false },
    );
    const hardBans = HARD_BANS.map(({ id, reason }) => ({ id, reason }));
    // 路由在线状态就是库里探针的结论（routes.alive、probe_*，#129），原样给驾驶舱
    return reply(c, RoutingResponse, { channels, pools, models, routes, stages, hardBans, bans });
  });

  app.put(WebRoutes.updateStagePolicy.path, async (c) => {
    const stage = StageKindSchema.safeParse(c.req.param('stage'));
    if (!stage.success) throw new ApiError(404, 'stage_not_found', '没有这个阶段类型');
    const body = await readJson(c, UpdateStagePolicyRequest);
    const [routes, models, bans] = await Promise.all([
      store.listRoutes(),
      store.listModels(),
      store.listBans(),
    ]);
    const route = routeLookup(routes, models);
    const problems = body.routeIds
      .map((id) => routeProblem(id, stage.data, { route, bans, now: deps.now() }))
      .filter((p): p is string => p !== null);
    if (problems.length > 0) {
      throw new ApiError(422, 'route_not_allowed', problems.join('；'), { problems });
    }
    const next = { routeIds: body.routeIds, pinned: body.pinned };
    const result = await store.updateStagePolicy(
      { stage: stage.data, expected: body.expected, next },
      {
        actor: actorOf(c),
        action: 'stage_policy.update',
        target: `stage:${stage.data}`,
        before: body.expected,
        after: next,
        reason: body.reason,
        via: c.get('via'),
        ok: true,
      },
    );
    if (result === 'conflict') {
      const current = (await store.listStagePolicies()).find((p) => p.stage === stage.data);
      throw new ApiError(409, 'conflict', '这个阶段刚被别人改过，刷新后再改', { current });
    }
    return reply(c, UpdateStagePolicyResponse, { stage: { stage: stage.data, ...next } });
  });

  app.patch(WebRoutes.updateChannel.path, async (c) => {
    const channelId = c.req.param('channelId');
    const body = await readJson(c, UpdateChannelRequest);
    const result = await store.setChannelEnabled(
      { channelId, enabled: body.enabled },
      {
        actor: actorOf(c),
        action: body.enabled ? 'channel.enable' : 'channel.disable',
        target: `channel:${channelId}`,
        after: { enabled: body.enabled },
        reason: body.reason,
        via: c.get('via'),
        ok: true,
      },
    );
    if (result === 'not_found') throw new ApiError(404, 'channel_not_found', '没有这个渠道');
    return reply(c, UpdateChannelResponse, { ok: true });
  });

  app.get(WebRoutes.pools.path, async (c) => {
    const [pools, channels, windows, routes, activeRuns] = await Promise.all([
      store.listPools(),
      store.listChannels(),
      store.listQuotaWindows(),
      store.listRoutes(),
      store.listRuns({ active: true }),
    ]);
    const now = deps.now();
    const quotaNotWired = await notWiredView(store, deps.notWired?.quota);
    return reply(c, PoolsResponse, {
      pools: buildPools({ pools, channels, windows, routes, activeRuns }, now, config.quotaStaleAfterMs),
      ...(quotaNotWired ? { quotaNotWired } : {}),
      staleAfterMinutes: Math.round(config.quotaStaleAfterMs / 60_000),
      asOf: now.toISOString(),
    });
  });

  app.get(WebRoutes.jobs.path, async (c) => {
    const now = deps.now();
    const jobs = await store.listJobs();
    return reply(c, JobsResponse, { jobs: jobs.map((j) => jobView(j, now)), asOf: now.toISOString() });
  });

  app.get(WebRoutes.notifications.path, async (c) => {
    const query = readQuery(c, NotificationsQuery);
    const page = await store.listNotifications(query);
    return reply(c, NotificationsResponse, {
      items: page.items.map(notificationView),
      nextCursor: page.nextCursor,
    });
  });

  app.post(WebRoutes.resolveNotification.path, async (c) => {
    const id = c.req.param('notificationId');
    const actor = actorOf(c);
    const result = await store.resolveNotification(
      { id, by: actor },
      { actor, action: 'notification.resolve', target: `notification:${id}`, via: c.get('via'), ok: true },
    );
    if (result === 'not_found') throw new ApiError(404, 'notification_not_found', '没有这条通知');
    return reply(c, ResolveNotificationResponse, { ok: true });
  });

  app.get(WebRoutes.audit.path, async (c) => {
    const query = readQuery(c, AuditQuery);
    const page = await store.listAudit(query);
    return reply(c, AuditResponse, page);
  });

  app.get(WebRoutes.settings.path, async (c) =>
    reply(c, SettingsResponse, { settings: await settingsView() }),
  );

  app.put(WebRoutes.updateSetting.path, async (c) => {
    const key = c.req.param('key');
    if (!Object.hasOwn(SETTING_SCHEMAS, key)) throw new ApiError(404, 'setting_not_found', '没有这项设置');
    const body = await readJson(c, UpdateSettingRequest);
    const valueSchema: z.ZodType = SETTING_SCHEMAS[key as SettingKey];
    const value = valueSchema.safeParse(body.value);
    if (!value.success) throw new ApiError(400, 'invalid_request', '设置的值不符合约定', value.error.issues);
    const before = (await settingsView()).find((s) => s.key === key);
    const actor = actorOf(c);
    const result = await store.putSetting(
      { key, value: value.data, expectedVersion: body.version, by: actor },
      {
        actor,
        action: 'setting.update',
        target: `setting:${key}`,
        before: before?.value,
        after: value.data,
        reason: body.reason,
        via: c.get('via'),
        ok: true,
      },
    );
    if (result === 'conflict') throw new ApiError(409, 'conflict', '这项设置刚被别人改过，刷新后再改');
    const setting = (await settingsView()).find((s) => s.key === key);
    if (!setting) throw new ApiError(500, 'setting_missing', '设置写完读不回来');
    return reply(c, UpdateSettingResponse, { setting });
  });

  registerCredentialRoutes(app, deps);
  registerDemoRoutes(app, deps, actorOf);

  /** 表里每一项都返回；没设过的 version=0、value=null。 */
  async function settingsView() {
    const saved = new Map((await store.listSettings()).map((s) => [s.key, s]));
    return Object.keys(SETTING_SCHEMAS).map((key) => {
      const s = saved.get(key);
      return {
        key,
        value: s?.value ?? null,
        version: s?.version ?? 0,
        updatedAt: s?.updatedAt,
        updatedBy: s?.updatedBy,
      };
    });
  }

  return app;
}

/** 这些单开在 fleet-dao 自己这个仓：在受管的仓里按名字找它，找到了驾驶舱才链得过去（找不到只显示单号）。 */
const SELF_REPO_NAME = 'fleet-dao';

async function notWiredView(store: Store, mark: NotWiredMark | undefined): Promise<NotWired | undefined> {
  if (!mark) return undefined;
  const self = (await store.listRepos()).find((r) => r.name === SELF_REPO_NAME);
  return { ...mark, ...(self ? { issueRepo: { owner: self.owner, name: self.name } } : {}) };
}
