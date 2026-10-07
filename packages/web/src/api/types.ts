// 驾驶舱看到的数据形状：一律从 @fleet-dao/shared 的 web-api.ts（zod）推导，不另写一份。
// 后端对每个返回都按同一份定义校验，前端的 HTTP 层也照它解析——字段增删改 web-api.ts，这里自动跟上。
import type {
  ActivitySchema,
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
  ChannelStateSchema,
  CreateDemoLinkRequest,
  CreateDemoLinkResponse,
  CredentialsResponse,
  DemoLinkSchema,
  DemoLinksResponse,
  DemoScopeSchema,
  EffortModelSchema,
  EnvEngineSchema,
  EnvFact as EnvFactBase,
  EnvFacts as EnvFactsBase,
  EnvHealthSchema,
  EnvMasterSchema,
  EnvPoolsSchema,
  EnvResponseSchema,
  EnvScheduleSchema,
  EnvSessionsSchema,
  EnvVersionSchema,
  FrancePreflightResponseSchema,
  FranceReleaseStateSchema,
  HomeResponseSchema,
  JobsResponse,
  JobViewSchema,
  LivenessFactSchema,
  LivenessVerdictSchema,
  MeResponse,
  ModelSchema,
  MovePurposeModelRequest,
  MovePurposeModelResponse,
  NodeDetailResponseSchema,
  NodeListItemSchema,
  NodesResponseSchema,
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
  ReleaseCardSchema,
  ReleasedCommitsSchema,
  ReleaseRequestResponse,
  RepoDispatchResponse,
  RepoSchema,
  RouteEffortSchema,
  RouteProbeNowRequest,
  RouteProbeNowResponse,
  RouteProbeRequestSchema,
  RouteProbeResultSchema,
  RouteProbeStatusResponse,
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
  UpdateModelRouteRequest,
  UpdateModelRouteResponse,
  UpdateRepoDispatchRequest,
  UpdateRepoDispatchResponse,
  UpdateRouteEffortRequest,
  UpdateRouteEffortResponse,
  UpdateSettingRequest,
  UpdateTaskRoutePinRequest,
  UpdateTaskRoutePinResponse,
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
/** 设置页「仓库」一节：每个项目的「让 AI 接活」现在开还是关、什么时候开的。 */
export type RepoDispatch = z.infer<typeof RepoDispatchResponse>['repos'][number];
export type UpdateRepoDispatchBody = z.input<typeof UpdateRepoDispatchRequest>;
export type UpdatedRepoDispatch = z.infer<typeof UpdateRepoDispatchResponse>;

export type Board = z.infer<typeof BoardResponse>;
export type BoardTask = z.infer<typeof BoardTaskSchema>;
export type BoardSubtask = z.infer<typeof BoardSubtaskSchema>;
export type Activity = z.infer<typeof ActivitySchema>;
export type NowItem = z.infer<typeof NowItemSchema>;

export type TaskDetail = z.infer<typeof TaskDetailResponse>;
export type Run = z.infer<typeof RunSchema>;
export type TaskActionBody = z.input<typeof TaskActionRequest>;

export type Routing = z.infer<typeof RoutingResponse>;
export type Channel = z.infer<typeof ChannelSchema>;
/** 渠道近态（#1118）：运行中失败被标 disabled 的渠道、为什么、顺到谁。 */
export type ChannelState = z.infer<typeof ChannelStateSchema>;
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

/** 渠道状态页的立即探测（驾驶舱改版 2026-10-07）：最近点过的、引擎接没接、每条的结论。 */
export type RouteProbeStatus = z.infer<typeof RouteProbeStatusResponse>;
export type RouteProbeRequest = z.infer<typeof RouteProbeRequestSchema>;
export type RouteProbeResult = z.infer<typeof RouteProbeResultSchema>;
export type RouteProbeNowBody = z.input<typeof RouteProbeNowRequest>;
export type RouteProbeNowResult = z.infer<typeof RouteProbeNowResponse>;

/** 每个模型下每条路由起会话的思考档位（#470）。 */
export type RoutingEfforts = z.infer<typeof RoutingEffortsResponse>;
export type EffortModel = z.infer<typeof EffortModelSchema>;
export type RouteEffort = z.infer<typeof RouteEffortSchema>;
export type UpdateRouteEffortBody = z.input<typeof UpdateRouteEffortRequest>;
export type UpdatedRouteEffort = z.infer<typeof UpdateRouteEffortResponse>;
/** 单子页给一段指定模型（驾驶舱改版 2026-10-07）。 */
export type UpdateTaskRoutePinBody = z.input<typeof UpdateTaskRoutePinRequest>;
export type TaskRoutePin = z.infer<typeof UpdateTaskRoutePinResponse>;

/** 路由页改先后和开关（母单 #1089）：用途下的模型上移 / 下移、模型下的渠道上移 / 下移和开关。 */
export type MovePurposeModelBody = z.input<typeof MovePurposeModelRequest>;
export type MovedPurposeModel = z.infer<typeof MovePurposeModelResponse>;
export type UpdateModelRouteBody = z.input<typeof UpdateModelRouteRequest>;
export type UpdatedModelRoute = z.infer<typeof UpdateModelRouteResponse>;
export type MoveDirection = MovePurposeModelBody['direction'];

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

/** 环境页（#820 片 1）：这一台环境现在怎样，每一项各自带「查成了 / 没查成 + 原因」。 */
export type EnvResponse = z.infer<typeof EnvResponseSchema>;
/** 一整份环境页事实清单里的每一项（后端拼好、前端逐项画）。 */
export type EnvFacts = EnvFactsBase;
/** 一项的成败：ok 带值，没查成带一句给人的原因（不拿空顶）。 */
export type EnvFact<T> = EnvFactBase<T>;
export type EnvEngine = z.infer<typeof EnvEngineSchema>;
/** 引擎总开关那一格（#1086，设置 engine.master）：开还是关、谁什么时候改的。 */
export type EnvMaster = z.infer<typeof EnvMasterSchema>;
export type EnvVersion = z.infer<typeof EnvVersionSchema>;
export type EnvSessions = z.infer<typeof EnvSessionsSchema>;
export type EnvPools = z.infer<typeof EnvPoolsSchema>;
export type EnvHealth = z.infer<typeof EnvHealthSchema>;
export type EnvSchedule = z.infer<typeof EnvScheduleSchema>;

/** 看板多机：本台加每个远程环境（本机 WSL 等）的新鲜度；远程环境最近一次推来的主页、环境页快照。 */
export type Nodes = z.infer<typeof NodesResponseSchema>;
export type NodeListItem = z.infer<typeof NodeListItemSchema>;
export type NodeDetail = z.infer<typeof NodeDetailResponseSchema>;

export type Notifications = z.infer<typeof NotificationsResponse>;
export type Notification = z.infer<typeof NotificationSchema>;
export type NotificationLevel = z.infer<typeof NotificationLevelSchema>;

export type Audit = z.infer<typeof AuditResponse>;
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export type Settings = z.infer<typeof SettingsResponse>;
export type Setting = z.infer<typeof SettingSchema>;
export type UpdateSettingBody = z.input<typeof UpdateSettingRequest>;

/** /france 页发版一键（#618）：release-train 此刻在走 / 暂停 / 没在走 / 读不到。 */
export type FranceReleaseState = z.infer<typeof FranceReleaseStateSchema>;
/** /france 页「发版」卡（#1231）：四行各自带「查成了 / 没查成 + 原因」。 */
export type ReleaseCard = z.infer<typeof ReleaseCardSchema>;
/** /changelog 页「已发布的提交」（#1255）：读法国发布历史，每条提交号、标题、发于何时；读不到整份是 unreadable + 原因。 */
export type ReleasedCommits = z.infer<typeof ReleasedCommitsSchema>;
/** 点「确认发布」之后后端回的：请求已写下（接活的是法国上 root 的单元，进度看发版卡）。 */
export type ReleaseRequestResult = z.infer<typeof ReleaseRequestResponse>;
/** /france 页「发版预检」一次一回：done 带输出、退出码；起进程都没起来走 unreadable。 */
export type FrancePreflightResponse = z.infer<typeof FrancePreflightResponseSchema>;

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
