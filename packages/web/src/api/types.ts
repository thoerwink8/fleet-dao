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
  ChangeEventSchema,
  ChannelSchema,
  JobsResponse,
  JobViewSchema,
  MeResponse,
  ModelSchema,
  NotificationLevelSchema,
  NotificationSchema,
  NotificationsResponse,
  NowItemSchema,
  PoolSchema,
  PoolsResponse,
  PoolViewSchema,
  QuotaWindowViewSchema,
  RepoSchema,
  RouteSchema,
  RoutingResponse,
  RunSchema,
  RunStepsResponse,
  SettingSchema,
  SettingsResponse,
  StagePolicySchema,
  TaskActionRequest,
  TaskDetailResponse,
  TimelineItemSchema,
  TimelineResponse,
  UpdateChannelRequest,
  UpdateSettingRequest,
  UpdateStagePolicyRequest,
} from '@fleet-dao/shared';
import type { z } from 'zod';

export type {
  BillingKind,
  HostId,
  QuotaWindowKind,
  ReadingKind,
  RunOutcome,
  SettingKey,
  StageKind,
  StepState,
  SubtaskState,
  TaskState,
} from '@fleet-dao/shared';

export type Me = z.infer<typeof MeResponse>;
export type AuthConfig = z.infer<typeof AuthConfigResponse>;
export type Repo = z.infer<typeof RepoSchema>;

export type Board = z.infer<typeof BoardResponse>;
export type BoardTask = z.infer<typeof BoardTaskSchema>;
export type BoardSubtask = z.infer<typeof BoardSubtaskSchema>;
export type Activity = z.infer<typeof ActivitySchema>;
export type NowItem = z.infer<typeof NowItemSchema>;

export type TaskDetail = z.infer<typeof TaskDetailResponse>;
export type Run = z.infer<typeof RunSchema>;
export type Ask = z.infer<typeof AskSchema>;
export type Timeline = z.infer<typeof TimelineResponse>;
export type TimelineItem = z.infer<typeof TimelineItemSchema>;
export type RunSteps = z.infer<typeof RunStepsResponse>;
export type TaskActionBody = z.input<typeof TaskActionRequest>;

export type Routing = z.infer<typeof RoutingResponse>;
export type Channel = z.infer<typeof ChannelSchema>;
export type Model = z.infer<typeof ModelSchema>;
export type Route = z.infer<typeof RouteSchema>;
export type Pool = z.infer<typeof PoolSchema>;
export type StagePolicy = z.infer<typeof StagePolicySchema>;
export type Ban = z.infer<typeof BanSchema>;
export type UpdateStagePolicyBody = z.input<typeof UpdateStagePolicyRequest>;
export type UpdateChannelBody = z.input<typeof UpdateChannelRequest>;

export type Pools = z.infer<typeof PoolsResponse>;
export type PoolView = z.infer<typeof PoolViewSchema>;
export type QuotaWindowView = z.infer<typeof QuotaWindowViewSchema>;

export type Jobs = z.infer<typeof JobsResponse>;
export type JobView = z.infer<typeof JobViewSchema>;

export type Notifications = z.infer<typeof NotificationsResponse>;
export type Notification = z.infer<typeof NotificationSchema>;
export type NotificationLevel = z.infer<typeof NotificationLevelSchema>;

export type Audit = z.infer<typeof AuditResponse>;
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export type Settings = z.infer<typeof SettingsResponse>;
export type Setting = z.infer<typeof SettingSchema>;
export type UpdateSettingBody = z.input<typeof UpdateSettingRequest>;

/** 实时推送（SSE，事件名见 SSE_EVENTS）：ready = 连上了，全量重拉一次；change = 某张表某一行变了；resync = 断过，全量重拉。 */
export type LiveEvent =
  | { type: 'ready' }
  | { type: 'resync' }
  | ({ type: 'change' } & z.infer<typeof ChangeEventSchema>);
