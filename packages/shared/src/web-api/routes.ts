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
  CreateDemoLinkRequest,
  CreateDemoLinkResponse,
  DemoLinksResponse,
  RevokeDemoLinkResponse,
  UpdateDemoDefaultRequest,
  UpdateDemoDefaultResponse,
} from './demo.ts';
import { RepoDispatchResponse, UpdateRepoDispatchRequest, UpdateRepoDispatchResponse } from './dispatch.ts';
import { EnvResponseSchema } from './env.ts';
import {
  FrancePreflightResponseSchema,
  FranceReleaseStateSchema,
  ReleaseCardSchema,
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
import { ReleaseVersionResponse } from './release.ts';
import {
  MovePurposeModelRequest,
  MovePurposeModelResponse,
  RouteProbeNowRequest,
  RouteProbeNowResponse,
  RouteProbeStatusResponse,
  RoutingEffortsResponse,
  RoutingLayersResponse,
  RoutingResponse,
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
  /** 看板多机：本台加每个远程环境（本机 WSL 等）的新鲜度。收快照的写口（NODE_REPORT_PATH）不在这里：只有别的环境的后端调。 */
  nodes: { method: 'GET', path: '/nodes', response: NodesResponseSchema },
  /** 一个远程环境最近一次推来的主页、环境页快照（只读展示用）；没推过 404。 */
  node: { method: 'GET', path: '/nodes/:nodeId', response: NodeDetailResponseSchema },
  board: { method: 'GET', path: '/repos/:repoId/board', response: BoardResponse },
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
  /** 模型下的一条渠道上移 / 下移一位，或开 / 关（母单 #1089）；同样带看到的旧值。网关通行证不认。 */
  updateModelRoute: {
    method: 'PUT',
    path: '/routing/models/:modelId/routes/:routeId',
    request: UpdateModelRouteRequest,
    response: UpdateModelRouteResponse,
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
  /** /changelog 页「发布 v<N>」的版本号（#725）：现读 GitHub 里程碑，和 pnpm publish:pr 同一份判法。 */
  releaseVersion: { method: 'GET', path: '/release/version', response: ReleaseVersionResponse },
  demoLinks: { method: 'GET', path: '/demo/links', response: DemoLinksResponse },
  createDemoLink: {
    method: 'POST',
    path: '/demo/links',
    request: CreateDemoLinkRequest,
    response: CreateDemoLinkResponse,
  },
  revokeDemoLink: { method: 'DELETE', path: '/demo/links/:linkId', response: RevokeDemoLinkResponse },
  updateDemoDefault: {
    method: 'PUT',
    path: '/demo/default',
    request: UpdateDemoDefaultRequest,
    response: UpdateDemoDefaultResponse,
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
