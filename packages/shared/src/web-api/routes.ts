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
import { PageQuery } from './common.ts';
import {
  CreateDemoLinkRequest,
  CreateDemoLinkResponse,
  DemoLinksResponse,
  RevokeDemoLinkResponse,
  UpdateDemoDefaultRequest,
  UpdateDemoDefaultResponse,
} from './demo.ts';
import { HomeResponseSchema } from './home.ts';
import { JobsResponse } from './jobs.ts';
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
  RoutingEffortsResponse,
  RoutingLayersResponse,
  RoutingResponse,
  UpdateChannelRequest,
  UpdateChannelResponse,
  UpdateRouteEffortRequest,
  UpdateRouteEffortResponse,
} from './routing.ts';
import { SettingsResponse, UpdateSettingRequest, UpdateSettingResponse } from './settings.ts';
import {
  AnswerAskRequest,
  AnswerAskResponse,
  RunStepsResponse,
  TaskActionRequest,
  TaskActionResponse,
  TaskDetailResponse,
  TimelineResponse,
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
  board: { method: 'GET', path: '/repos/:repoId/board', response: BoardResponse },
  task: { method: 'GET', path: '/tasks/:taskId', response: TaskDetailResponse },
  timeline: { method: 'GET', path: '/tasks/:taskId/timeline', query: PageQuery, response: TimelineResponse },
  taskAction: {
    method: 'POST',
    path: '/tasks/:taskId/actions',
    request: TaskActionRequest,
    response: TaskActionResponse,
  },
  runSteps: { method: 'GET', path: '/runs/:runId/steps', response: RunStepsResponse },
  answerAsk: {
    method: 'POST',
    path: '/asks/:askId/answer',
    request: AnswerAskRequest,
    response: AnswerAskResponse,
  },
  routing: { method: 'GET', path: '/routing', response: RoutingResponse },
  routingLayers: { method: 'GET', path: '/routing/layers', response: RoutingLayersResponse },
  routingEfforts: { method: 'GET', path: '/routing/efforts', response: RoutingEffortsResponse },
  updateRouteEffort: {
    method: 'PUT',
    path: '/routing/efforts/:modelId/:routeId',
    request: UpdateRouteEffortRequest,
    response: UpdateRouteEffortResponse,
  },
  updateChannel: {
    method: 'PATCH',
    path: '/routing/channels/:channelId',
    request: UpdateChannelRequest,
    response: UpdateChannelResponse,
  },
  pools: { method: 'GET', path: '/pools', response: PoolsResponse },
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
