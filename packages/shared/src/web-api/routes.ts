// 驾驶舱接口约定（web-api）：路由表（WebRoutes、AuthRoutes）：前端据此封装请求。
// 入口是 ../web-api.ts（只有 export *），拆分说明见 specs/901-项目瘦身与提速/重构方案.md 第 2 节；内容是从原来一个文件里原样搬来的。

import {
  AuthConfigResponse,
  CredentialsResponse,
  DevLoginRequest,
  FeishuAccessRequest,
  MeResponse,
  PasswordLoginRequest,
  UpdateCredentialsRequest,
} from './auth.ts';
import { BoardResponse, ReposResponse } from './board.ts';
import {
  GroomNowRequest,
  GroomNowResponse,
  GroomStatusResponse,
  RepoDispatchResponse,
  UpdateRepoDispatchRequest,
  UpdateRepoDispatchResponse,
} from './dispatch.ts';
import { EnvResponseSchema } from './env.ts';
import {
  FrancePreflightResponseSchema,
  FranceReleaseStateSchema,
  ReleaseCardSchema,
  ReleasedCommitsSchema,
  ReleaseRequestBody,
  ReleaseRequestResponse,
} from './france-release.ts';
import { HomeResponseSchema } from './home.ts';
import { JobsResponse } from './jobs.ts';
import { NodeDetailResponseSchema, NodesResponseSchema } from './nodes.ts';
import {
  AuditQuery,
  AuditResponse,
  NotificationsQuery,
  NotificationsResponse,
  ResolveNotificationResponse,
} from './notifications.ts';
import { PoolsResponse } from './pools.ts';
import {
  AddPurposeModelRequest,
  ManualModelRequest,
  ManualModelResponse,
  MovePurposeModelRequest,
  MovePurposeModelResponse,
  PurposeMembershipResponse,
  RemovePurposeModelRequest,
  RouteProbeHistoryResponse,
  RouteProbeNowRequest,
  RouteProbeNowResponse,
  RouteProbeStatusResponse,
  RoutingEffortsResponse,
  RoutingLayersResponse,
  RoutingResponse,
  SetChannelEnabledRequest,
  SetChannelEnabledResponse,
  SetModelEnabledRequest,
  SetModelEnabledResponse,
  SetPurposeModelEffortRequest,
  UpdateModelRouteRequest,
  UpdateModelRouteResponse,
  UpdateRouteEffortRequest,
  UpdateRouteEffortResponse,
} from './routing.ts';
import {
  PoolHoldsResponse,
  SettingsResponse,
  UpdateSettingRequest,
  UpdateSettingResponse,
} from './settings.ts';
import {
  TaskActionRequest,
  TaskActionResponse,
  TaskDetailResponse,
  UpdateTaskRoutePinRequest,
  UpdateTaskRoutePinResponse,
} from './task.ts';
import { TaskListQuery, TaskListResponse } from './task-list.ts';

// —— 路由表（前端据此封装请求；路径都在 WEB_API_PREFIX 之下，:xxx 是路径参数）——

export const WebRoutes = {
  me: { method: 'GET', path: '/me', response: MeResponse },
  credentials: { method: 'GET', path: '/me/credentials', response: CredentialsResponse },
  /** 成功 204，没有响应体。 */
  updateCredentials: { method: 'PUT', path: '/me/credentials', request: UpdateCredentialsRequest },
  events: { method: 'GET', path: '/events' },
  repos: { method: 'GET', path: '/repos', response: ReposResponse },
  /** 新主页（/）的一屏三块 + 持续状态条，一个往返聚齐（#589）。 */
  home: { method: 'GET', path: '/home', response: HomeResponseSchema },
  /** 环境页（#820 片 1）：这一台环境现在怎样，每一项各自带「查成了 / 没查成 + 原因」。只读、不跨环境。 */
  env: { method: 'GET', path: '/env', response: EnvResponseSchema },
  /** /france 页发版一键（#618）：release-train 此刻的状态（在走、暂停、没在走、读不到）。只读。 */
  franceReleaseState: { method: 'GET', path: '/france/release-state', response: FranceReleaseStateSchema },
  /** /france 页「发版」卡（#1231）：主线最新提交和 CI、法国在用的提交、差几个、最近做完的一个任务。只读，每一行各自带没查成的原因。 */
  franceReleaseCard: { method: 'GET', path: '/france/release-card', response: ReleaseCardSchema },
  /** 更新日志页「已发布的提交」（#1255，决定 0032）：读法国的发布历史，每条写提交号、标题、发于何时。只读，读不到写没查成和原因。 */
  franceReleasedCommits: { method: 'GET', path: '/france/released-commits', response: ReleasedCommitsSchema },
  /** /france 页「发布到法国」按钮（#1232）：只收提交号，核它等于此刻主线头，写请求文件，法国上 root 的单元接活；后端不起任何带 root 的进程。 */
  franceRelease: {
    method: 'POST',
    path: '/france/release',
    request: ReleaseRequestBody,
    response: ReleaseRequestResponse,
  },
  /** /france 页「发版预检」按钮：起子进程跑 pnpm release:onekey preflight，命令写死、不收参数。 */
  francePreflight: { method: 'POST', path: '/france/preflight', response: FrancePreflightResponseSchema },
  /** 设置页「仓库」一节：每个项目的「让 AI 接活」现在开还是关、什么时候开的。 */
  repoDispatch: { method: 'GET', path: '/repos/dispatch', response: RepoDispatchResponse },
  /** 开、关一个项目的「让 AI 接活」（和命令行 fleet-api dispatch 同一个写入口，记操作记录）；没有这个项目 404。 */
  updateRepoDispatch: {
    method: 'PUT',
    path: '/repos/:repoId/dispatch',
    request: UpdateRepoDispatchRequest,
    response: UpdateRepoDispatchResponse,
  },
  /** 「让指挥官整理」按钮的现状（母单 #1335 第 3 片，#1338）：这个项目今日剩余次数、最近几次结果、有没有一次在排队或在做。没有这个项目 404。 */
  groomStatus: { method: 'GET', path: '/repos/:repoId/dispatch/groom', response: GroomStatusResponse },
  /**
   * 叫一次临时指挥官整理待办（和命令行 fleet-api groom、引擎拉单一轮自己叫同一个入口、同一把锁，记 groom.request 操作记录）。
   * 拒的情况都明说：引擎总开关关着 409 engine_off、已经有一次在做 409 groom_busy、24 小时内次数用完 429 groom_daily_cap；没有这个项目 404。
   */
  groomNow: {
    method: 'POST',
    path: '/repos/:repoId/dispatch/groom',
    request: GroomNowRequest,
    response: GroomNowResponse,
  },
  /** 看板多机：本台加每个远程环境（本机 WSL 等）的新鲜度。收快照的写口（NODE_REPORT_PATH）不在这里：只有别的环境的后端调。 */
  nodes: { method: 'GET', path: '/nodes', response: NodesResponseSchema },
  /** 一个远程环境最近一次推来的主页、环境页快照（只读展示用）；没推过 404。 */
  node: { method: 'GET', path: '/nodes/:nodeId', response: NodeDetailResponseSchema },
  board: { method: 'GET', path: '/repos/:repoId/board', response: BoardResponse },
  /** 任务列表页 /tasks（#1639）：按最近更新从新到旧，可按状态、仓、单号或标题筛，游标翻页，带各状态的数。 */
  tasks: { method: 'GET', path: '/tasks', query: TaskListQuery, response: TaskListResponse },
  task: { method: 'GET', path: '/tasks/:taskId', response: TaskDetailResponse },
  taskAction: {
    method: 'POST',
    path: '/tasks/:taskId/actions',
    request: TaskActionRequest,
    response: TaskActionResponse,
  },
  /** 给这张单的一段（动手、验收）指定模型或清掉指定（task_route_pins）；引擎下一次给这一段选路就照它。网关通行证不认。 */
  updateTaskRoutePin: {
    method: 'PUT',
    path: '/tasks/:taskId/route-pin',
    request: UpdateTaskRoutePinRequest,
    response: UpdateTaskRoutePinResponse,
  },
  routing: { method: 'GET', path: '/routing', response: RoutingResponse },
  routingLayers: { method: 'GET', path: '/routing/layers', response: RoutingLayersResponse },
  routingEfforts: { method: 'GET', path: '/routing/efforts', response: RoutingEffortsResponse },
  /** 立即探测的现状（驾驶舱改版 2026-10-07）：最近点过的、引擎接没接、每条的结论，加上引擎此刻在不在。 */
  routeProbeStatus: { method: 'GET', path: '/routing/probe', response: RouteProbeStatusResponse },
  /** 探针真历史（#1139）：每个渠道近 60 次格子、均耗时、可用率。不看引擎开没开。读不到 why 写没查成。 */
  routeProbeHistory: { method: 'GET', path: '/routing/probe-history', response: RouteProbeHistoryResponse },
  /** 立即探测：routeIds 不给 = 全部路由。引擎关着、没连上回 409 / 503 写明是哪样，不记成点过。 */
  routeProbeNow: {
    method: 'POST',
    path: '/routing/probe',
    request: RouteProbeNowRequest,
    response: RouteProbeNowResponse,
  },
  updateRouteEffort: {
    method: 'PUT',
    path: '/routing/efforts/:modelId/:routeId',
    request: UpdateRouteEffortRequest,
    response: UpdateRouteEffortResponse,
  },
  /** 用途下的一个模型上移 / 下移一位（母单 #1089）；带看到的先后，别人先改了回 409，已在最上 / 最下回 422。 */
  movePurposeModel: {
    method: 'PUT',
    path: '/routing/purposes/:purpose/models/:modelId',
    request: MovePurposeModelRequest,
    response: MovePurposeModelResponse,
  },
  /** 把目录里的模型加进用途（末尾或指定位置，可带档位）。带版本号。网关通行证不认。页面还没接（#1354 第五片）。 */
  addPurposeModel: {
    method: 'POST',
    path: '/routing/purposes/:purpose/models',
    request: AddPurposeModelRequest,
    response: PurposeMembershipResponse,
  },
  /** 把模型移出用途。用途可以变空。带版本号。网关通行证不认。 */
  removePurposeModel: {
    method: 'DELETE',
    path: '/routing/purposes/:purpose/models/:modelId',
    request: RemovePurposeModelRequest,
    response: PurposeMembershipResponse,
  },
  /** 改这个用途下这个模型的档位（不影响别的用途，也不改路由上的档）。带版本号。网关通行证不认。 */
  setPurposeModelEffort: {
    method: 'PUT',
    path: '/routing/purposes/:purpose/models/:modelId/effort',
    request: SetPurposeModelEffortRequest,
    response: PurposeMembershipResponse,
  },
  /** 模型下的一条渠道上移 / 下移一位、拖到新先后，或开 / 关（母单 #1089）；同样带看到的旧值。网关通行证不认。 */
  updateModelRoute: {
    method: 'PUT',
    path: '/routing/models/:modelId/routes/:routeId',
    request: UpdateModelRouteRequest,
    response: UpdateModelRouteResponse,
  },
  /** 模型级开关：开则这个模型下的路由全开，关则全关。带看到的、开着的路由编号。网关通行证不认。 */
  setModelEnabled: {
    method: 'PUT',
    path: '/routing/models/:modelId',
    request: SetModelEnabledRequest,
    response: SetModelEnabledResponse,
  },
  /**
   * 渠道级开关（channels.enabled）。不是已删的 PATCH /routing/channels/:id（那条保持 404）。
   * 网关通行证不认。
   */
  setChannelEnabled: {
    method: 'PUT',
    path: '/routing/channels/:channelId',
    request: SetChannelEnabledRequest,
    response: SetChannelEnabledResponse,
  },
  /** 没有名册命令的渠道：登记一个模型串。网关通行证不认。 */
  registerChannelModel: {
    method: 'POST',
    path: '/routing/channels/:channelId/models',
    request: ManualModelRequest,
    response: ManualModelResponse,
  },
  /** 撤掉手工登记的模型串。不删目录里的路由。网关通行证不认。 */
  revokeChannelModel: {
    method: 'DELETE',
    path: '/routing/channels/:channelId/models',
    request: ManualModelRequest,
    response: ManualModelResponse,
  },
  pools: { method: 'GET', path: '/pools', response: PoolsResponse },
  /** 整池暂停现状（#746）：开关、认不出的、旧提醒、到期没复查的；新建、撤回走 PUT /settings/engine.poolHolds。 */
  poolHolds: { method: 'GET', path: '/pool-holds', response: PoolHoldsResponse },
  jobs: { method: 'GET', path: '/jobs', response: JobsResponse },
  notifications: {
    method: 'GET',
    path: '/notifications',
    query: NotificationsQuery,
    response: NotificationsResponse,
  },
  resolveNotification: {
    method: 'POST',
    path: '/notifications/:notificationId/resolve',
    response: ResolveNotificationResponse,
  },
  audit: { method: 'GET', path: '/audit', query: AuditQuery, response: AuditResponse },
  settings: { method: 'GET', path: '/settings', response: SettingsResponse },
  updateSetting: {
    method: 'PUT',
    path: '/settings/:key',
    request: UpdateSettingRequest,
    response: UpdateSettingResponse,
  },
} as const;

/**
 * 登录相关的入口，在 AUTH_PREFIX 之下（不在 /api 之下，因为要被浏览器直接跳转打开）。
 * 浏览器里：跳到 /auth/feishu/login?next=<站内路径>，登录完回到 next。
 * 飞书客户端里：tt.requestAccess 拿 code，POST /auth/feishu/access。
 */
export const AuthRoutes = {
  config: { method: 'GET', path: '/config', response: AuthConfigResponse },
  feishuLogin: { method: 'GET', path: '/feishu/login' },
  feishuCallback: { method: 'GET', path: '/feishu/callback' },
  feishuAccess: {
    method: 'POST',
    path: '/feishu/access',
    request: FeishuAccessRequest,
    response: MeResponse,
  },
  /** 成功 204 + 会话 Cookie，没有响应体。 */
  passwordLogin: { method: 'POST', path: '/password/login', request: PasswordLoginRequest },
  /** 退出 = 这个人所有设备上的会话都作废（之后拿旧 Cookie 请求回 401 session_revoked）。 */
  logout: { method: 'POST', path: '/logout' },
  devLogin: { method: 'POST', path: '/dev-login', request: DevLoginRequest, response: MeResponse },
} as const;
