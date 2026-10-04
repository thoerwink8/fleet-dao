// 驾驶舱看到的数据形状：一律从 @fleet-dao/shared 的 web-api.ts（zod）推导，不另写一份。
// 后端对每个返回都按同一份定义校验，前端的 HTTP 层也照它解析——字段增删改 web-api.ts，这里自动跟上。
import type {
  ActivitySchema,
  AskSchema,
  AuditEntrySchema,
  AuditResponse,
  AuthConfigResponse,
  BanSchema,
  BoardResponse,
  BoardSubtaskSchema,
  BoardTaskSchema,
  CarpoolReconcileViewSchema,
  ChangeEventSchema,
  ChannelSchema,
  CreateDemoLinkRequest,
  CreateDemoLinkResponse,
  CredentialsResponse,
  DemoLinkSchema,
  DemoLinksResponse,
  DemoScopeSchema,
  EffortModelSchema,
  HomeResponseSchema,
  JobsResponse,
  JobViewSchema,
  LegacyAsksResponse,
  LivenessFactSchema,
  LivenessVerdictSchema,
  MeResponse,
  ModelSchema,
  NotificationLevelSchema,
  NotificationSchema,
  NotificationsResponse,
  NowItemSchema,
  OrgSwitchViewSchema,
  PoolHoldsView,
  PoolSchema,
  PoolsResponse,
  PoolViewSchema,
  QuotaWindowViewSchema,
  ReleaseVersionResponse,
  RepoSchema,
  RouteEffortSchema,
  RouteSchema,
  RoutingEffortsResponse,
  RoutingLayerModelSchema,
  RoutingLayerPurposeSchema,
  RoutingLayerRouteSchema,
  RoutingLayersResponse,
  RoutingResponse,
  RunSchema,
  SettingSchema,
  SettingsResponse,
  TaskActionRequest,
  TaskDetailResponse,
  UpdateCredentialsRequest,
  UpdateDemoDefaultRequest,
  UpdateRouteEffortRequest,
  UpdateRouteEffortResponse,
  UpdateSettingRequest,
} from '@fleet-dao/shared';
import type { z } from 'zod';

export type {
  BillingKind,
  HostId,
  QuotaWindowKind,
  ReadingKind,
  RunOutcome,
  SessionEffort,
  SettingKey,
  StageKind,
  StepState,
  SubtaskState,
  TaskState,
} from '@fleet-dao/shared';

export type Me = z.infer<typeof MeResponse>;
export type AuthConfig = z.infer<typeof AuthConfigResponse>;
export type Credentials = z.infer<typeof CredentialsResponse>;
export type UpdateCredentialsBody = z.input<typeof UpdateCredentialsRequest>;
export type Repo = z.infer<typeof RepoSchema>;

export type Board = z.infer<typeof BoardResponse>;
export type BoardTask = z.infer<typeof BoardTaskSchema>;
export type BoardSubtask = z.infer<typeof BoardSubtaskSchema>;
export type Activity = z.infer<typeof ActivitySchema>;
export type NowItem = z.infer<typeof NowItemSchema>;

export type TaskDetail = z.infer<typeof TaskDetailResponse>;
export type Run = z.infer<typeof RunSchema>;
export type Ask = z.infer<typeof AskSchema>;
export type LegacyAsks = z.infer<typeof LegacyAsksResponse>;
export type LegacyAsk = LegacyAsks['items'][number];
export type TaskActionBody = z.input<typeof TaskActionRequest>;

export type Routing = z.infer<typeof RoutingResponse>;
export type Channel = z.infer<typeof ChannelSchema>;
export type Model = z.infer<typeof ModelSchema>;
export type Route = z.infer<typeof RouteSchema>;
export type Pool = z.infer<typeof PoolSchema>;
export type Ban = z.infer<typeof BanSchema>;

/** 路由两层每一层现在活着吗（#574）。 */
export type RoutingLayers = z.infer<typeof RoutingLayersResponse>;
export type RoutingLayerPurpose = z.infer<typeof RoutingLayerPurposeSchema>;
export type RoutingLayerModel = z.infer<typeof RoutingLayerModelSchema>;
export type RoutingLayerRoute = z.infer<typeof RoutingLayerRouteSchema>;
export type LivenessVerdict = z.infer<typeof LivenessVerdictSchema>;
export type LivenessFact = z.infer<typeof LivenessFactSchema>;

/** 每个模型下每条路由起会话的思考档位（#470）。 */
export type RoutingEfforts = z.infer<typeof RoutingEffortsResponse>;
export type EffortModel = z.infer<typeof EffortModelSchema>;
export type RouteEffort = z.infer<typeof RouteEffortSchema>;
export type UpdateRouteEffortBody = z.input<typeof UpdateRouteEffortRequest>;
export type UpdatedRouteEffort = z.infer<typeof UpdateRouteEffortResponse>;

/** 整池暂停的现状（#746）：开关、认不出的、旧提醒、到期没复查的。 */
export type PoolHolds = PoolHoldsView;
export type PoolHoldFactView = PoolHoldsView['holds'][number];

export type Pools = z.infer<typeof PoolsResponse>;
export type PoolView = z.infer<typeof PoolViewSchema>;
/** 会话用户切号现状（#194）：额度页顶上一栏。 */
export type OrgSwitchView = z.infer<typeof OrgSwitchViewSchema>;
/** 拼车额度对账（#194 方案 4.7）：本机记到的花费 vs 接口说的已用。 */
export type CarpoolReconcileView = z.infer<typeof CarpoolReconcileViewSchema>;
export type QuotaWindowView = z.infer<typeof QuotaWindowViewSchema>;

export type Jobs = z.infer<typeof JobsResponse>;
export type JobView = z.infer<typeof JobViewSchema>;

/** 新主页一屏三块 + 持续状态条（#589）。 */
export type HomeResponse = z.infer<typeof HomeResponseSchema>;

export type Notifications = z.infer<typeof NotificationsResponse>;
export type Notification = z.infer<typeof NotificationSchema>;
export type NotificationLevel = z.infer<typeof NotificationLevelSchema>;

export type Audit = z.infer<typeof AuditResponse>;
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export type Settings = z.infer<typeof SettingsResponse>;
export type Setting = z.infer<typeof SettingSchema>;
export type UpdateSettingBody = z.input<typeof UpdateSettingRequest>;

/** /changelog 页「发布 v<N>」的版本号（#725）：ok / blocked / unreadable 三种，见 web-api.ts 的 ReleaseVersionResponse。 */
export type ReleaseVersion = z.infer<typeof ReleaseVersionResponse>;

export type DemoLinks = z.infer<typeof DemoLinksResponse>;
export type DemoLink = z.infer<typeof DemoLinkSchema>;
export type DemoScopeView = z.infer<typeof DemoScopeSchema>;
export type CreateDemoLinkBody = z.input<typeof CreateDemoLinkRequest>;
export type CreatedDemoLink = z.infer<typeof CreateDemoLinkResponse>;
export type UpdateDemoDefaultBody = z.input<typeof UpdateDemoDefaultRequest>;

/** 实时推送（SSE，事件名见 SSE_EVENTS）：ready = 连上了，全量重拉一次；change = 某张表某一行变了；resync = 断过，全量重拉。 */
export type LiveEvent =
  | { type: 'ready' }
  | { type: 'resync' }
  | ({ type: 'change' } & z.infer<typeof ChangeEventSchema>);
