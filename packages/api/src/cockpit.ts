// 驾驶舱接口（/api）：看板、任务、调度台、账号池与额度、定时任务、通知、操作记录、设置、实时推送、发给工作流的信号。
// 读一律从数据库读（不直接查 GitHub；唯一的例外是 /changelog 的发布版本号，现读 GitHub 里程碑，见 release-version.ts）；
// 每个写操作都留操作记录。路径取自 shared/web-api.ts 的 WebRoutes。

import {
  AuditQuery,
  AuditResponse,
  BoardResponse,
  DEFAULT_SESSION_EFFORT,
  EnvResponseSchema,
  HARD_BANS,
  HomeResponseSchema,
  JobsResponse,
  type LegacyRead,
  MeResponse,
  NodeDetailResponseSchema,
  NodesResponseSchema,
  NotificationsQuery,
  NotificationsResponse,
  POOL_HOLDS_SETTING,
  PoolHoldsResponse,
  PoolsResponse,
  poolHoldsView,
  QUOTA_RESERVE_SETTING,
  ReposResponse,
  ResolveNotificationResponse,
  RoutingEffortsResponse,
  RoutingLayersResponse,
  RoutingResponse,
  revocationProblem,
  SETTING_SCHEMAS,
  type SettingKey,
  SettingsResponse,
  TASK_SIGNAL_NAMES,
  TaskActionRequest,
  TaskActionResponse,
  TaskDetailResponse,
  UpdateRouteEffortRequest,
  UpdateRouteEffortResponse,
  UpdateSettingRequest,
  UpdateSettingResponse,
  UpdateTaskRoutePinRequest,
  UpdateTaskRoutePinResponse,
  WebRoutes,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import { handlingOf, handlingView, type NotificationRecord } from '@fleet-dao/store';
import { type Context, Hono } from 'hono';
import type { z } from 'zod';
import { meBody } from './auth.ts';
import { CARPOOL_RECONCILE_NOT_HERE, carpoolReconcileView } from './carpool-reconcile-view.ts';
import { registerCredentialRoutes } from './credentials.ts';
import { registerDemoRoutes } from './demo.ts';
import type { Deps } from './deps.ts';
import { registerDispatchRoutes } from './dispatch-routes.ts';
import { registerFranceReleaseRoutes } from './france-release.ts';
import { engineHealthProbe } from './home-engine.ts';
import { ApiError, fullStack, readJson, readQuery, reply } from './http.ts';
import { readNodeDetail, readNodes } from './node-views.ts';
import { ORG_SWITCH_NOT_HERE, orgSwitchView } from './org-switch-view.ts';
import {
  type Actor,
  type NewAuditEntry,
  type TaskSignal,
  WorkflowGoneError,
  WorkflowTargetNotFoundError,
  WorkflowUnavailableError,
} from './ports.ts';
import { registerReleaseCardRoutes } from './release-card.ts';
import { registerReleaseRequestRoutes } from './release-request.ts';
import { registerReleaseRoutes } from './release-version.ts';
import { soloReserveView } from './reserve-view.ts';
import { registerRouteProbeRoutes } from './route-probe-now.ts';
import { ROUTING_EFFORTS_NOT_HERE, type RoutingEffortsPort, routingEffortsView } from './routing-efforts.ts';
import { ROUTING_LAYERS_NOT_HERE, type RoutingLayersPort, routingLayersView } from './routing-layers.ts';
import { registerRoutingOrderRoutes } from './routing-order.ts';
import { type CockpitEnv, checkGatewayTaskAction, requireSession } from './session.ts';
import { readEnvSnapshot, readHomeSnapshot, type SnapshotDeps } from './snapshots.ts';
import { eventsHandler, type SseRelay } from './sse.ts';
import { TASK_ROUTE_PINS_NOT_HERE, taskRoutePinView } from './task-route-pins.ts';
import { taskWorkflowIdForTask } from './temporal.ts';
import {
  buildBoard,
  buildPools,
  isTaskFinished,
  jobView,
  notificationView,
  routeLookup,
  runView,
  segmentRunViews,
  subtaskViews,
  usageView,
} from './views.ts';

/** 读旧 pool-hold 提醒时最多翻几页没处理的提醒（每页 200 条）；翻不完明说没读全，不拿「没有」顶。 */
const LEGACY_ALERT_PAGES = 5;

const ACTION_WORDS = { pause: '暂停', resume: '继续', stop: '叫停', reroute: '换路由' } as const;

/** 叫停没写原因时补的一句话：引擎的放弃信号 reason 必填（task-contract.ts 的 AbandonCommand），工作流拿它写状态。 */
const DEFAULT_STOP_REASON = '驾驶舱上点了叫停';

/** 引擎没有接收处的动作，各自该怎么说（驾驶舱原样显示）。 */
const UNSUPPORTED_ACTION_WHY = {
  reroute: '任务工作流没有「中途换路由」：每一段会话开始前它自己按路由顺序选路。想让它别再做，请用「叫停」',
} as const;

export function cockpitRoutes(deps: Deps, relay: SseRelay): Hono<CockpitEnv> {
  const { config, store } = deps;
  const app = new Hono<CockpitEnv>();
  app.use('*', requireSession(config, store, deps.now));

  const engineProbe = engineHealthProbe({
    health: deps.health,
    engineOff: config.engineOff,
    log: deps.log,
    now: deps.now,
  });

  const actorOf = (c: Context<CockpitEnv>): Actor => ({ kind: 'user', id: c.get('user').id });

  /**
   * 先记后做：操作记录写不进就抛错，信号不发。命令按任务发给任务工作流，编号查库拼（taskWorkflowIdForTask）。
   * 信号没发成再追加一条 ok=false 的记录（工作流不在了 409、拼不出编号 404、Temporal 没接上或连不上 503、别的 502），
   * 每一种都给驾驶舱一句人话原因；这一条也写不进时只能留日志，但不改变返回给人的结果。
   */
  async function signalAndAudit(taskId: string, signal: TaskSignal, audit: NewAuditEntry): Promise<void> {
    await store.appendAudit(audit);
    try {
      const workflowId = await taskWorkflowIdForTask(store, taskId);
      await deps.workflows.signal(workflowId, signal);
    } catch (err) {
      const gone = err instanceof WorkflowGoneError;
      const unavailable = err instanceof WorkflowUnavailableError;
      const notFound = err instanceof WorkflowTargetNotFoundError;
      const error = gone
        ? 'workflow_gone'
        : unavailable
          ? 'workflow_unavailable'
          : notFound
            ? 'workflow_target_not_found'
            : String(err);
      try {
        await store.appendAudit({ ...audit, ok: false, error });
      } catch (auditErr) {
        deps.log.error('信号没发成，这条失败记录也没写进去', { taskId, error, auditError: String(auditErr) });
      }
      if (gone) {
        throw new ApiError(
          409,
          'workflow_gone',
          '这张单的任务工作流已经结束或不存在（做完了、已被叫停，或引擎还没拉起它），没有谁能收到这个操作',
        );
      }
      if (notFound) throw new ApiError(404, 'workflow_target_not_found', err.message);
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

  // 主页、环境页的拼法在 snapshots.ts（以后别的环境推快照也调同一份）；引擎探针在上面建一次、两页共用它的缓存。
  // 每次请求现取 deps（不在装配时拍一份），和原来在处理函数里直接读 deps 一样。
  const snapshotDeps = (): SnapshotDeps => ({ ...deps, engineProbe });

  app.get(WebRoutes.home.path, async (c) =>
    reply(c, HomeResponseSchema, await readHomeSnapshot(snapshotDeps())),
  );

  app.get(WebRoutes.env.path, async (c) =>
    reply(c, EnvResponseSchema, await readEnvSnapshot(snapshotDeps())),
  );

  // 看板多机：本台加每个远程环境（登录门后面；推快照的写口在 node-report.ts，那边只认专用通行证）。
  app.get(WebRoutes.nodes.path, async (c) => {
    const engine = await engineProbe();
    return reply(c, NodesResponseSchema, await readNodes(deps, engine));
  });

  app.get(WebRoutes.node.path, async (c) =>
    reply(c, NodeDetailResponseSchema, await readNodeDetail(deps, c.req.param('nodeId'))),
  );

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
    const [repo, subtasks, runs, segmentRecords, routes, models, channels] = await Promise.all([
      store.getRepo(task.repoId),
      store.listSubtasks([task.id]),
      store.listRuns({ taskIds: [task.id] }),
      store.listSegmentRuns(task.id),
      store.listRoutes(),
      store.listModels(),
      store.listChannels(),
    ]);
    if (!repo) throw new ApiError(500, 'repo_missing', `任务 ${task.id} 所在的仓不在库里`);
    const activeRuns = runs.filter((r) => !r.endedAt);
    const plans = await store.getPlans(activeRuns.map((r) => r.id));
    // 带上渠道表：会话和用量汇总的花费要分清按量、套餐内
    const route = routeLookup(routes, models, channels);
    const segmentRuns = segmentRunViews(segmentRecords, {
      models,
      channels,
      taskFinished: isTaskFinished(task),
    });
    return reply(c, TaskDetailResponse, {
      routePins: await readRoutePins(task.id),
      task,
      repo,
      subtasks: subtaskViews(task.id, { tasks: [task], subtasks, activeRuns, plans, route }),
      runs: runs.map((r) => runView(r, route(r.routeId))),
      segmentRuns,
      usage: usageView(runs, route, segmentRuns),
    });
  });

  /** 这张单每段指定的模型。没接上、没读成都写在 unavailable 里（单子页照样能看用量），不拿空列表冒充「没指定」。 */
  async function readRoutePins(taskId: string) {
    if (!deps.taskRoutePins) return { pins: [], unavailable: TASK_ROUTE_PINS_NOT_HERE };
    try {
      return { pins: (await deps.taskRoutePins.list(taskId)).map(taskRoutePinView) };
    } catch (err) {
      deps.log.error('按单指定的模型没读成', { taskId, error: fullStack(err) });
      return { pins: [], unavailable: `没读成：${(err instanceof Error && err.message) || String(err)}` };
    }
  }

  // 给一张单的一段指定模型、或清掉（驾驶舱改版 2026-10-07）：直接写库，和操作记录同一事务；引擎下一次给这一段选路就照它，
  // 在跑的这一轮不打断。单子结束了、模型目录里没有、路由不是这个模型的都拒，库里一行不动。
  app.put(WebRoutes.updateTaskRoutePin.path, async (c) => {
    const taskId = c.req.param('taskId');
    const body = await readJson(c, UpdateTaskRoutePinRequest);
    if (!deps.taskRoutePins) throw new ApiError(503, 'task_route_pins_not_wired', TASK_ROUTE_PINS_NOT_HERE);
    const task = await store.getTask(taskId);
    if (!task) throw new ApiError(404, 'task_not_found', '没有这个任务');
    if (isTaskFinished(task)) {
      throw new ApiError(409, 'task_finished', `任务已经结束（${task.state}），不用再指定模型`);
    }
    let result: Awaited<ReturnType<NonNullable<Deps['taskRoutePins']>['set']>>;
    try {
      result = await deps.taskRoutePins.set(
        {
          taskId,
          segment: body.segment,
          modelId: body.modelId,
          routeId: body.routeId ?? null,
          setBy: c.get('user').id,
          setAt: deps.now(),
          reason: body.reason,
        },
        {
          actor: actorOf(c),
          action: body.modelId === null ? 'task.routePin.clear' : 'task.routePin.set',
          target: `task:${taskId}`,
          reason: body.reason,
          via: c.get('via'),
          ok: true,
        },
      );
    } catch (err) {
      deps.log.error('按单指定的模型没改成', { taskId, error: fullStack(err) });
      throw new ApiError(
        503,
        'task_route_pin_unwritable',
        (err instanceof Error && err.message) || String(err),
      );
    }
    if (!result.ok) {
      if (result.kind === 'not_found') throw new ApiError(404, 'task_not_found', result.why);
      throw new ApiError(422, 'route_pin_invalid', result.why);
    }
    return reply(c, UpdateTaskRoutePinResponse, taskRoutePinView(result.after));
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
      case 'resume':
        signal = { name: TASK_SIGNAL_NAMES.continue, by };
        break;
      case 'stop':
        signal = { name: TASK_SIGNAL_NAMES.abandon, by, reason: body.reason ?? DEFAULT_STOP_REASON };
        break;
      // 暂停（#820 片 3）：只停这一张单、能继续（继续就是上面的 taskContinue）。已经停着的再点暂停回 409，不重复发信号。
      case 'pause':
        if (task.paused !== undefined) {
          throw new ApiError(409, 'already_paused', `这张单已经暂停了（${task.paused}），点「继续」接着走`);
        }
        signal = {
          name: TASK_SIGNAL_NAMES.pause,
          by,
          mode: body.mode ?? 'soft',
          ...(body.reason ? { reason: body.reason } : {}),
        };
        break;
      // 引擎的任务工作流没有「中途换路由」的接收处（每一段重新选路）：发了也没人收，所以当场回明确的 409，
      // 不记操作、不假装发出去了（#901）。要补就先在引擎里接上、再回这里。
      case 'reroute':
        throw new ApiError(409, 'action_not_supported', UNSUPPORTED_ACTION_WHY[body.action]);
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

  // 路由目录。每个用途的先后不在这里给：那是路由两层（下面 routingLayers），旧的阶段平铺表没人读了（#574）
  app.get(WebRoutes.routing.path, async (c) => {
    const [channels, channelStates, pools, models, routes, bans] = await Promise.all([
      store.listChannels(),
      store.listChannelStates(),
      store.listPools(),
      store.listModels(),
      store.listRoutes(),
      store.listBans(),
    ]);
    const hardBans = HARD_BANS.map(({ id, reason }) => ({ id, reason }));
    // 路由在线状态就是库里探针的结论（routes.alive、probe_*，#129），原样给驾驶舱
    return reply(c, RoutingResponse, { channels, channelStates, pools, models, routes, hardBans, bans });
  });

  // 路由两层每一层现在活着吗（#574）：读的时候现算，不存。读不到回 503 写明没读成；没接上写 unavailable。
  app.get(WebRoutes.routingLayers.path, async (c) => {
    const now = deps.now();
    if (!deps.routingLayers) {
      return reply(c, RoutingLayersResponse, {
        asOf: now.toISOString(),
        purposes: [],
        unavailable: ROUTING_LAYERS_NOT_HERE,
      });
    }
    let layers: Awaited<ReturnType<RoutingLayersPort['read']>>;
    try {
      layers = await deps.routingLayers.read({ now, staleAfterMs: config.quotaStaleAfterMs });
    } catch (err) {
      deps.log.error('路由两层没读成', { error: fullStack(err) });
      // message 只写原因：驾驶舱前面自己加「路由两层没读成：」
      const cause = (err instanceof Error && err.message) || String(err);
      throw new ApiError(503, 'routing_layers_unreadable', cause);
    }
    const [models, channels] = await Promise.all([store.listModels(), store.listChannels()]);
    return reply(c, RoutingLayersResponse, {
      asOf: now.toISOString(),
      purposes: routingLayersView(layers, { models, channels }),
    });
  });

  // 每条路由的思考档位（#470）：读库里现在配的。没接上写 unavailable；读不到回 503 写明没读成。
  app.get(WebRoutes.routingEfforts.path, async (c) => {
    if (!deps.routingEfforts) {
      return reply(c, RoutingEffortsResponse, {
        defaultEffort: DEFAULT_SESSION_EFFORT,
        models: [],
        unavailable: ROUTING_EFFORTS_NOT_HERE,
      });
    }
    let rows: Awaited<ReturnType<RoutingEffortsPort['read']>>;
    try {
      rows = await deps.routingEfforts.read();
    } catch (err) {
      deps.log.error('思考档位没读成', { error: fullStack(err) });
      throw new ApiError(
        503,
        'routing_efforts_unreadable',
        (err instanceof Error && err.message) || String(err),
      );
    }
    return reply(c, RoutingEffortsResponse, {
      defaultEffort: DEFAULT_SESSION_EFFORT,
      models: routingEffortsView(rows),
    });
  });

  // 改一条路由的思考档位（#470）：直接写库（运行时配置，决定 0011 第 7 条），和操作记录同一事务；下一个起的会话就照它。
  // 这条路由的执行方式不认、路由两层里没挂、别人刚改过，都拒，库里一行不动。
  app.put(WebRoutes.updateRouteEffort.path, async (c) => {
    const modelId = c.req.param('modelId');
    const routeId = c.req.param('routeId');
    const body = await readJson(c, UpdateRouteEffortRequest);
    if (!deps.routingEfforts) throw new ApiError(503, 'routing_efforts_not_wired', ROUTING_EFFORTS_NOT_HERE);
    let result: Awaited<ReturnType<RoutingEffortsPort['set']>>;
    try {
      result = await deps.routingEfforts.set(
        { modelId, routeId, effort: body.effort, expected: body.expected },
        {
          actor: actorOf(c),
          action: 'routing.effort.update',
          target: `route:${routeId}`,
          reason: body.reason,
          via: c.get('via'),
          ok: true,
        },
      );
    } catch (err) {
      deps.log.error('思考档位没改成', { modelId, routeId, error: fullStack(err) });
      throw new ApiError(
        503,
        'routing_effort_unwritable',
        (err instanceof Error && err.message) || String(err),
      );
    }
    if (!result.ok) {
      if (result.kind === 'not_found') throw new ApiError(404, 'route_not_found', result.why);
      if (result.kind === 'invalid') throw new ApiError(422, 'effort_not_allowed', result.why);
      throw new ApiError(409, 'conflict', '这条路由的档位刚被别人改过，刷新后再改', {
        current: result.current,
      });
    }
    return reply(c, UpdateRouteEffortResponse, {
      modelId,
      routeId,
      ...(result.after === null ? {} : { effort: result.after }),
    });
  });

  app.get(WebRoutes.pools.path, async (c) => {
    const [pools, channels, windows, routes, activeRuns, savedSettings] = await Promise.all([
      store.listPools(),
      store.listChannels(),
      store.listQuotaWindows(),
      store.listRoutes(),
      store.listRuns({ active: true }),
      store.listSettings(),
    ]);
    const now = deps.now();
    // 切号现状（#194）：读不到不拖垮额度页，但要明说没读成（不拿空冒充没事）
    const soloPaused = savedSettings.find((s) => s.key === 'engine.soloPaused')?.value === true;
    const poolViews = buildPools(
      { pools, channels, windows, routes, activeRuns },
      now,
      config.quotaStaleAfterMs,
    );
    // 独享的额度留量线现状（#194 方案 4.8）：选路、切号用同一份判法（shared 的 evaluateReserve）
    const soloReserve = soloReserveView(
      poolViews,
      savedSettings.find((s) => s.key === QUOTA_RESERVE_SETTING)?.value,
      now,
    );
    const reserve = soloReserve ? { soloReserve } : {};
    let orgSwitch: ReturnType<typeof orgSwitchView>;
    if (!deps.orgSwitch) {
      orgSwitch = { state: 'unavailable', why: ORG_SWITCH_NOT_HERE, soloPaused, ...reserve };
    } else {
      try {
        orgSwitch = orgSwitchView(await deps.orgSwitch.read(), soloPaused, now, soloReserve);
      } catch (error) {
        orgSwitch = {
          state: 'unavailable',
          why: `读切号账本没成：${errMessage(error)}`,
          soloPaused,
          ...reserve,
        };
      }
    }
    // 拼车额度对账（#194 方案 4.7）：读不到不拖垮额度页，明说没读成
    let carpoolReconcile: ReturnType<typeof carpoolReconcileView>;
    if (!deps.carpoolReconcile) {
      carpoolReconcile = { state: 'unavailable', why: CARPOOL_RECONCILE_NOT_HERE };
    } else {
      try {
        carpoolReconcile = carpoolReconcileView(await deps.carpoolReconcile.read(), now);
      } catch (error) {
        carpoolReconcile = {
          state: 'unavailable',
          why: `读拼车对账用的会话花费和额度没成：${errMessage(error)}`,
        };
      }
    }
    return reply(c, PoolsResponse, {
      pools: poolViews,
      staleAfterMinutes: Math.round(config.quotaStaleAfterMs / 60_000),
      orgSwitch,
      carpoolReconcile,
      asOf: now.toISOString(),
    });
  });

  app.get(WebRoutes.poolHolds.path, async (c) => {
    const now = deps.now();
    const setting = (await store.listSettings()).find((s) => s.key === POOL_HOLDS_SETTING);
    // 旧的 pool-hold:<池> 提醒（兼容读法）：读不成明说，不拿「没有旧提醒」顶
    let legacy: LegacyRead;
    try {
      const alerts: NotificationRecord[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < LEGACY_ALERT_PAGES; page += 1) {
        const got = await store.listNotifications({
          status: 'open',
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        alerts.push(...got.items);
        cursor = got.nextCursor;
        if (!cursor) break;
      }
      legacy = cursor
        ? { ok: false, why: `没处理的提醒超过 ${LEGACY_ALERT_PAGES * 200} 条，旧的 pool-hold 提醒没读全` }
        : { ok: true, alerts };
    } catch (error) {
      legacy = {
        ok: false,
        why: `读没处理的提醒没成：${errMessage(error)}`,
      };
    }
    return reply(c, PoolHoldsResponse, poolHoldsView(setting, legacy, now));
  });

  app.get(WebRoutes.jobs.path, async (c) => {
    const now = deps.now();
    const jobs = await store.listJobs();
    return reply(c, JobsResponse, { jobs: jobs.map((j) => jobView(j, now)), asOf: now.toISOString() });
  });

  app.get(WebRoutes.notifications.path, async (c) => {
    const query = readQuery(c, NotificationsQuery);
    const page = await store.listNotifications(query);
    // 谁在处理、修到哪（design 15.3）：读的时候现算；没接上、读不到照实写在 handlingProblem，不拿「没人在修」顶
    const handling = deps.alertWork
      ? await handlingOf(
          deps.alertWork,
          page.items.map((n) => n.id),
        )
      : { ok: false as const, why: '谁在处理没接上：这里没有提醒的认领和 PR 记录（开发环境）' };
    return reply(c, NotificationsResponse, {
      items: page.items.map((n) => {
        const h = handling.ok ? handling.byId.get(n.id) : undefined;
        return { ...notificationView(n), ...(h ? { handling: handlingView(h) } : {}) };
      }),
      nextCursor: page.nextCursor,
      ...(handling.ok ? {} : { handlingProblem: handling.why }),
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
    // 整池暂停：撤回、续期必须写原因（写进操作记录），在落库前这一步拦，不靠页面自觉
    if (key === POOL_HOLDS_SETTING) {
      const missing = revocationProblem(before?.value, value.data, body.reason);
      if (missing) throw new ApiError(400, 'reason_required', missing);
    }
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
  registerDispatchRoutes(app, deps, actorOf);
  registerRoutingOrderRoutes(app, deps, actorOf);
  registerRouteProbeRoutes(app, deps, actorOf, engineProbe);
  registerReleaseRoutes(app, deps);
  registerFranceReleaseRoutes(app, deps);
  registerReleaseCardRoutes(app, deps);
  registerReleaseRequestRoutes(app, deps, actorOf);

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
