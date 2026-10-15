// 驾驶舱的所有读写都经过 FleetApi：方法和 shared/web-api.ts 的 WebRoutes 一一对应，形状全用那份定义。
// 实现有两个：http.ts（真后端，带 CSRF 头、SSE 推送）和 mock/（假数据，开发和测试用），在 api/index.ts 里选。

import { REALTIME_TABLES, type RealtimeTable, type ReleaseRecoverKind } from '@fleet-dao/shared';
import {
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { brand } from '#brand';
import type { HomeData, HomeState } from '../components/home/types';
import type {
  AddPurposeModelBody,
  AnswerNotificationBody,
  AnswerNotificationResult,
  Audit,
  AuthConfig,
  Board,
  CliToolsResponse,
  CreateRequestBody,
  Credentials,
  EnvResponse,
  FrancePreflightResponse,
  FranceReleaseState,
  GroomNowBody,
  GroomNowResult,
  GroomStatus,
  HomeResponse,
  ImportableRepos,
  ImportRepoBody,
  ImportRepoResult,
  InstallAppResult,
  Jobs,
  LiveEvent,
  LocalSessions,
  ManualModelBody,
  ManualModelResult,
  Me,
  MovedPurposeModel,
  MovePurposeModelBody,
  NodeDetail,
  Nodes,
  Notifications,
  PoolHolds,
  Pools,
  PurposeMembership,
  ReleaseCard,
  ReleasedCommits,
  ReleaseRecoverResult,
  ReleaseRequestResult,
  RemovePurposeModelBody,
  RemoveRepoResult,
  Repo,
  RepoCiPolicy,
  RepoDispatch,
  RequestActionBody,
  RequestChatStreamEvent,
  RequestDetail,
  RequestIssueOpening,
  RequestList,
  RequestListQueryBody,
  RequestReviewVerdict,
  RouteProbeHistory,
  RouteProbeNowBody,
  RouteProbeNowResult,
  RouteProbeStatus,
  Routing,
  RoutingEfforts,
  RoutingLayers,
  RunTranscript,
  RunTranscriptQuery,
  SendRequestMessageBody,
  SetChannelEnabledBody,
  SetChannelEnabledResult,
  SetModelEnabledBody,
  SetModelEnabledResult,
  SetPurposeModelEffortBody,
  Setting,
  SettingKey,
  Settings,
  TaskActionBody,
  TaskDetail,
  TaskList,
  TaskListFilter,
  TaskRoutePin,
  UpdateCredentialsBody,
  UpdatedModelRoute,
  UpdatedRepoCiPolicy,
  UpdatedRepoDispatch,
  UpdatedRouteEffort,
  UpdateModelRouteBody,
  UpdateRepoCiPolicyBody,
  UpdateRepoDispatchBody,
  UpdateRequestDraftBody,
  UpdateRouteEffortBody,
  UpdateSettingBody,
  UpdateTaskRoutePinBody,
  WorktreeCleanupAck,
  WorktreeCleanupBody,
  Worktrees,
} from './types';

export type LiveStatus = 'connecting' | 'open' | 'down';

export interface FleetApi {
  /** 数据来自哪里：真后端，还是假数据（本机 --mode mock）。界面上要写明。 */
  readonly source: 'http' | 'mock';
  authConfig(): Promise<AuthConfig>;
  devLogin(userId: string): Promise<Me>;
  feishuAccess(code: string): Promise<Me>;
  /**
   * 账密登录（#120）：后端成功回 204 + 会话 Cookie，这里随后读一次 /api/me 取 CSRF 令牌，返回登录的人。
   * 失败抛 ApiError：401 bad_credentials（一律这一句，不区分账号在不在）、429 locked（details.until）。
   */
  passwordLogin(username: string, password: string): Promise<Me>;
  /** 设置页「账密登录」一节：设过没有、用户名、上次改密码的时间、能不能不带当前密码设第一次。 */
  credentials(): Promise<Credentials>;
  /** 设 / 改用户名、密码；成功没有返回值。错误的 details.field 指明是哪一栏（见 shared 的 UpdateCredentialsRequest）。 */
  updateCredentials(body: UpdateCredentialsBody): Promise<void>;
  logout(): Promise<void>;
  me(): Promise<Me>;
  repos(): Promise<{ repos: Repo[] }>;
  /** 每个项目的「让 AI 接活」现在开还是关、什么时候开的（设置页「仓库」一节）。 */
  repoDispatch(): Promise<{ repos: RepoDispatch[] }>;
  /** 开、关一个项目的「让 AI 接活」（写操作记录）；本来就是那个状态时 changed=false。没有这个项目 404。 */
  updateRepoDispatch(repoId: string, body: UpdateRepoDispatchBody): Promise<UpdatedRepoDispatch>;
  /** 每个项目现在是强制 CI 还是不强制，以及最近几次切换（设置页「仓库」一节）。 */
  repoCiPolicy(): Promise<{ repos: RepoCiPolicy[] }>;
  /** 切换一个项目的 CI 模式（写操作记录）；本来就是这个模式时 changed=false。没有这个项目 404。 */
  updateRepoCiPolicy(repoId: string, body: UpdateRepoCiPolicyBody): Promise<UpdatedRepoCiPolicy>;
  /** 设置页「导入仓库」（#1989）：我 GitHub 上看得见的仓 + 我这份授权现在怎样。没连 GitHub 时 repos 空、auth.connected=false。 */
  importableRepos(): Promise<ImportableRepos>;
  /** 把一个仓接进驾驶舱；created=false 表示本来就在（没重复建）。 */
  importRepo(body: ImportRepoBody): Promise<ImportRepoResult>;
  /** 把一个仓移出驾驶舱；还挂着没结束的单时 removed=false 带原因。 */
  removeRepo(repoId: string): Promise<RemoveRepoResult>;
  /** 把两个 App 装到某个仓（一键授权那一步）；组织仓要组织批准，装不上时 reason 写原因。 */
  installAppOnRepo(body: { githubId: number }): Promise<InstallAppResult>;
  /** 断开本人 GitHub 授权。 */
  disconnectGitHub(): Promise<{ disconnected: boolean }>;
  /** 这个仓的「指挥官整理待办」：今日剩余、最近几次、有没有一次在排队或在做。没有这个项目 404。 */
  groomStatus(repoId: string): Promise<GroomStatus>;
  /**
   * 叫一次临时指挥官整理待办。原因可空。
   * 拒的情况都把后端的话抛出来：引擎没开 409、已经有一次在做 409、今天次数用完 429、记录读不到 503。
   */
  groomNow(repoId: string, body: GroomNowBody): Promise<GroomNowResult>;
  /** 新主页（/）的一屏三块 + 持续状态条（#589）。 */
  home(): Promise<HomeResponse>;
  /**
   * 环境页（#820 片 1）：这一台环境现在怎样，一项一个「查成了 / 没查成 + 原因」。
   * 只读、不跨环境：读的是本后端自己库里的现成读法（和主页、额度页、/healthz 同一份）。
   */
  env(): Promise<EnvResponse>;
  /** 看板多机：本台（名字、引擎）加每个远程环境的新鲜度。 */
  nodes(): Promise<Nodes>;
  /** 一个远程环境最近一次推来的主页、环境页快照加新鲜度（只读展示用）；没推过 404（node_never_reported）。 */
  node(nodeId: string): Promise<NodeDetail>;
  /** 本机会话（#1991）：每台推过的机器此刻在跑、刚停、超过阈值没动的会话；推不来的写 stale / never（页面写「没上报」）。 */
  localSessions(): Promise<LocalSessions>;
  /** 法国的工作树（#1993）：引擎最近一份清单加最近几次一键清理。 */
  worktrees(): Promise<Worktrees>;
  /** 叫一次「清理没用的工作树」：引擎没开 409/503、已经有一次在排队 409，把后端的话抛出来。 */
  worktreeCleanup(body: WorktreeCleanupBody): Promise<WorktreeCleanupAck>;
  board(repoId: string): Promise<Board>;
  /** 任务列表页（#1639）：所有仓、所有状态，最近更新在前，游标翻页，带各状态的数。 */
  tasks(query?: TaskListFilter & { cursor?: string | undefined; limit?: number }): Promise<TaskList>;
  task(taskId: string): Promise<TaskDetail>;
  /**
   * 一段会话的过程记录（#1640），按序号增量读：after 不给从头，给了回序号更大的；在跑的段拿上次回的 nextAfter 接着读。
   * 读不到（库不通、没接上）抛 ApiError（503），这一段跑在记录之前是 noRecord:true，两者分开。
   */
  runTranscript(taskId: string, runId: string, query?: RunTranscriptQuery): Promise<RunTranscript>;
  taskAction(taskId: string, body: TaskActionBody): Promise<void>;
  /** 给这张单的一段（动手、验收）指定模型或清掉（引擎下一次给这一段选路就照它）。 */
  updateTaskRoutePin(taskId: string, body: UpdateTaskRoutePinBody): Promise<TaskRoutePin>;
  routing(): Promise<Routing>;
  /** 路由两层每一层现在活着吗（#574）：用途 → 模型 → 路由，读的时候现算。 */
  routingLayers(): Promise<RoutingLayers>;
  /** 立即探测的现状：最近点过的、引擎接没接、每条的结论，加上引擎此刻在不在。 */
  routeProbeStatus(): Promise<RouteProbeStatus>;
  /** 立即探测：routeIds 不给 = 全部路由。引擎关着 409、没连上 503（消息写明是哪样）。 */
  routeProbeNow(body: RouteProbeNowBody): Promise<RouteProbeNowResult>;
  /** 探针真历史（#1139）。引擎关着也读得到；库读不到 state=unreadable，why 写没查成。 */
  routeProbeHistory(): Promise<RouteProbeHistory>;
  /** 每个模型下每条路由起会话的思考档位（#470）。 */
  routingEfforts(): Promise<RoutingEfforts>;
  /** 改一条路由的思考档位：effort 写 null = 回到没配（默认档）；expected 是改之前看到的，对不上 409。 */
  updateRouteEffort(
    modelId: string,
    routeId: string,
    body: UpdateRouteEffortBody,
  ): Promise<UpdatedRouteEffort>;
  /** 用途下的一个模型上移 / 下移一位（母单 #1089）：expected 是改之前看到的模型先后，对不上 409，已在最上 / 最下 422。 */
  movePurposeModel(purpose: string, modelId: string, body: MovePurposeModelBody): Promise<MovedPurposeModel>;
  /** 把目录里的一个模型加进用途。已经在里面 409，硬禁令 422，版本对不上 409。 */
  addPurposeModel(purpose: string, body: AddPurposeModelBody): Promise<PurposeMembership>;
  /** 把模型移出用途。用途可以变空。版本对不上 409。 */
  removePurposeModel(
    purpose: string,
    modelId: string,
    body: RemovePurposeModelBody,
  ): Promise<PurposeMembership>;
  /** 改这个用途下这个模型的档位。effort 为 null = 不另配。模型不认这一档 422。 */
  setPurposeModelEffort(
    purpose: string,
    modelId: string,
    body: SetPurposeModelEffortBody,
  ): Promise<PurposeMembership>;
  /** 模型下的一条渠道上移 / 下移一位、拖到新先后，或开 / 关（母单 #1089）：同样带看到的旧值。 */
  updateModelRoute(modelId: string, routeId: string, body: UpdateModelRouteBody): Promise<UpdatedModelRoute>;
  /** 模型级开关：开则下面的路由全开，关则全关。expectedEnabled 是改之前开着的路由编号。 */
  setModelEnabled(modelId: string, body: SetModelEnabledBody): Promise<SetModelEnabledResult>;
  /** 渠道级开关（channels.enabled）。expected 是改之前看到的开关。 */
  setChannelEnabled(channelId: string, body: SetChannelEnabledBody): Promise<SetChannelEnabledResult>;
  /** 没有名册的渠道：登记一个模型串。有名册命令的渠道 422，重复登记 409。 */
  registerChannelModel(channelId: string, body: ManualModelBody): Promise<ManualModelResult>;
  /** 撤掉手工登记的模型串。不删目录里的路由。没登记过 404。 */
  revokeChannelModel(channelId: string, body: ManualModelBody): Promise<ManualModelResult>;
  pools(): Promise<Pools>;
  /** 整池暂停现状（#746）：开关（到期标红）、认不出的、还靠旧提醒顶着的。新建、撤回走 updateSetting('engine.poolHolds')。 */
  poolHolds(): Promise<PoolHolds>;
  jobs(): Promise<Jobs>;
  notifications(query?: {
    status?: 'open' | 'all';
    cursor?: string | undefined;
    limit?: number;
  }): Promise<Notifications>;
  resolveNotification(id: string): Promise<void>;
  /** 回答「要你拍」（#1915）：点选项或自己输入；回答案和交给指挥官那一步成没成。 */
  answerNotification(id: string, body: AnswerNotificationBody): Promise<AnswerNotificationResult>;
  audit(query?: { target?: string | undefined; cursor?: string | undefined; limit?: number }): Promise<Audit>;
  settings(): Promise<Settings>;
  updateSetting(key: SettingKey, body: UpdateSettingBody): Promise<Setting>;
  /** /france 页发版一键（#618）：release-train 此刻在走 / 暂停 / 没在走 / 读不到。 */
  franceReleaseState(): Promise<FranceReleaseState>;
  /** /france 页「发版」卡（#1231）：主线最新提交和 CI、法国在用的提交、差几个、最近做完的一个任务，每行各自带没查成的原因。 */
  franceReleaseCard(): Promise<ReleaseCard>;
  /** /changelog 页「已发布的提交」（#1255）：法国发布历史里切上去的几条，每条提交号、标题、发于何时；读不到写没查成和原因。 */
  franceReleasedCommits(): Promise<ReleasedCommits>;
  /** /france 页「发布到法国」按钮（#1232）：只收提交号，后端核它等于此刻主线头、写请求文件，法国上 root 的单元接活。 */
  franceRelease(sha: string): Promise<ReleaseRequestResult>;
  /** /france 页发版卡卡住、失败后的三个按钮（#2027）：重试、恢复引擎开关、撤掉暂停；只收种类，后端按进度记录核能不能点。 */
  franceReleaseRecover(kind: ReleaseRecoverKind): Promise<ReleaseRecoverResult>;
  /** /france 页「发版预检」：后端进程内读七项事实，不起子进程、不收参数。 */
  francePreflight(): Promise<FrancePreflightResponse>;
  /** /france 页「命令行工具」（#1969、#1971）：在用版本、官方最新、落后，升过的带上次升级时间和升上去的版本。只读。 */
  franceCliTools(): Promise<CliToolsResponse>;
  /**
   * 提需求（#2049 接口、#2062 页面）：进行中 / 已归档 / 最近删除，三个筛选，按标题、原话、单号搜。
   * 后端没接上需求表时回 unavailable 写原因（不拿空列表冒充没有）。
   */
  requests(query: RequestListQueryBody): Promise<RequestList>;
  /** 一条需求的详情：消息、草稿、每个动作能不能做和为什么不能。没有这条 404。 */
  request(seq: number): Promise<RequestDetail>;
  /** 提一条新需求（先说一句）；只能给已导入的项目提。回新需求的详情。 */
  createRequest(body: CreateRequestBody): Promise<RequestDetail>;
  /** 发一条消息（说话人取登录会话）；结案后 409。回详情。 */
  sendRequestMessage(seq: number, body: SendRequestMessageBody): Promise<RequestDetail>;
  /** 改草稿栏：带看到的版本，别人先改了 409。回详情。 */
  updateRequestDraft(seq: number, body: UpdateRequestDraftBody): Promise<RequestDetail>;
  /** 提交拍板、确定、拍板、撤回、放下、归档、删除、恢复、置顶、改名。不合法 409 + 中文原因。回详情。 */
  requestAction(seq: number, body: RequestActionBody): Promise<RequestDetail>;
  /** 我读到这一条（只往前走）。 */
  markRequestRead(seq: number, messageId: number): Promise<{ lastReadMessageId: number | null }>;
  /** 「需求号 + 草稿版本号」这一键开没开成单（#2060）：确定、同意做超时了用它回显，不让人重点。 */
  requestIssueOpening(seq: number, draftVersion: number): Promise<RequestIssueOpening>;
  /** 回答引擎的提问：答复写回那条 GitHub 评论；写失败 502，同一个接口再调就是重试。回详情。 */
  answerEngineAsk(seq: number, messageId: number, text: string): Promise<RequestDetail>;
  /** 「让指挥官接着问」（#2061）。超了限额、引擎关着回 409「指挥官暂停了：原因」。回详情。 */
  nudgeCommander(seq: number): Promise<RequestDetail>;
  /** 停下正在回话的指挥官。回详情。 */
  stopCommander(seq: number): Promise<RequestDetail>;
  /** 只给这一条需求换指挥官模型；null = 回到「提需求」用途的默认。回详情。 */
  setCommanderModel(seq: number, modelId: string | null): Promise<RequestDetail>;
  /** 「让别家挑错」：排一次别家模型挑草稿的错。回详情。 */
  requestReview(seq: number): Promise<RequestDetail>;
  /** 别家意见的一条标采用或不用。回详情。 */
  markReviewItem(
    seq: number,
    messageId: number,
    body: { index: number; verdict: RequestReviewVerdict },
  ): Promise<RequestDetail>;
  /** 指挥官回话的流（SSE）：返回关掉的函数。回完推 done、断了推 error（写原因）。 */
  commanderStream(seq: number, listener: (e: CommanderStreamMessage) => void): () => void;
  /** 订阅实时推送，返回取消订阅的函数。onStatus 报连接状态（给顶栏的「实时」小灯）。 */
  subscribe(listener: (event: LiveEvent) => void, onStatus?: (status: LiveStatus) => void): () => void;
}

/** 指挥官回话流里的一条：写到哪了、回完了、断了。 */
export type CommanderStreamMessage =
  | { type: 'commander'; event: RequestChatStreamEvent }
  | { type: 'done' }
  | { type: 'error'; why: string };

/** 后端的错误：code 给程序判断，message 是给人看的白话（直接显示）。 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  /** 给人看的 message 之外的原文（网络报错、对不上的字段）。页面收在「详情」里，不摊在主文案上。 */
  readonly raw?: string;
  constructor(status: number, code: string, message: string, details?: unknown, raw?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    if (raw !== undefined) this.raw = raw;
  }
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * 门口没把请求送到法国，或浏览器根本没连上。登录页和外壳多给一个 /health/ 链接。
 * 502/504 几乎都是门口（超时、隧道断）。503 后端自己也用来表示「这一项没接上」，那种带着自己的 code，不算。
 * code gateway 是 nginx 固定 JSON，或 http.ts 把不是 JSON 的 502/503/504 收成的那一类。
 */
export function isGatewayError(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false;
  if (e.code === 'gateway' || e.code === 'network') return true;
  return e.status === 502 || e.status === 504;
}

const ApiContext = createContext<FleetApi | null>(null);

export function ApiProvider({ api, children }: { api: FleetApi; children: ReactNode }) {
  return <ApiContext value={api}>{children}</ApiContext>;
}

export function useApi(): FleetApi {
  const api = useContext(ApiContext);
  if (!api) throw new Error('缺少 ApiProvider');
  return api;
}

export const keys = {
  me: ['me'] as const,
  authConfig: ['auth-config'] as const,
  credentials: ['credentials'] as const,
  repos: ['repos'] as const,
  repoDispatch: ['repo-dispatch'] as const,
  repoCiPolicy: ['repo-ci-policy'] as const,
  importableRepos: ['importable-repos'] as const,
  groomStatus: (repoId: string) => ['groom-status', repoId] as const,
  localSessions: ['local-sessions'] as const,
  worktrees: ['worktrees'] as const,
  board: (repoId: string) => ['board', repoId] as const,
  task: (taskId: string) => ['task', taskId] as const,
  taskList: (filter: TaskListFilter) =>
    ['task-list', filter.status ?? '', filter.repoId ?? '', filter.q ?? ''] as const,
  runTranscript: (taskId: string, runId: string) => ['run-transcript', taskId, runId] as const,
  routing: ['routing'] as const,
  routingLayers: ['routing-layers'] as const,
  routingEfforts: ['routing-efforts'] as const,
  routeProbe: ['route-probe'] as const,
  probeHistory: ['probe-history'] as const,
  pools: ['pools'] as const,
  poolHolds: ['pool-holds'] as const,
  jobs: ['jobs'] as const,
  notifications: (status: 'open' | 'all') => ['notifications', status] as const,
  audit: (target: string) => ['audit', target] as const,
  settings: ['settings'] as const,
  franceReleaseState: ['france-release-state'] as const,
  franceCliTools: ['france-cli-tools'] as const,
  franceReleaseCard: ['france-release-card'] as const,
  franceReleasedCommits: ['france-released-commits'] as const,
  env: ['env'] as const,
  home: ['home'] as const,
  nodes: ['nodes'] as const,
  node: (nodeId: string) => ['node', nodeId] as const,
  requests: (q: RequestListQueryBody) => ['requests', q.view, q.filter, q.q ?? ''] as const,
  request: (seq: number) => ['request', String(seq)] as const,
};

// ---------- 兜底轮询（#1799） ----------

/** 主页的兜底轮询：推送正常时 30 秒。 */
export const HOME_POLL_MS = 30_000;
/** 其余读页（任务列表、通知、渠道状态、额度）的兜底轮询：推送正常时 60 秒。 */
export const READ_POLL_MS = 60_000;
/** 推送不是 open（连接中、断了）时所有读页都缩到 10 秒：推送靠不住，轮询顶上。 */
export const DOWN_POLL_MS = 10_000;

/**
 * 推送为主、轮询兜底：推送只覆盖部分表，也可能被网关缓冲、悄悄断开。可见时按 openMs 重拉；推送不是 open 就 10 秒；
 * 页面在后台不拉，切回窗口重拉一次（根上全局关了窗口焦点重拉，这里按查询单开）。
 * 间隔取自推送状态的值而不是函数，状态一变观察者当场换定时器，不用等上一个 openMs 走完。
 */
export function useLivePoll(openMs: number) {
  const { status } = useLiveState();
  return {
    refetchInterval: status === 'open' ? openMs : DOWN_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  } as const;
}

// ---------- 读 ----------

export function useMe() {
  const api = useApi();
  return useQuery({ queryKey: keys.me, queryFn: () => api.me(), staleTime: 60_000, retry: false });
}

export function useAuthConfig() {
  const api = useApi();
  return useQuery({ queryKey: keys.authConfig, queryFn: () => api.authConfig(), retry: false });
}

/** 账密登录的现状。不重试、不缓存：每次进设置页都现读（「10 分钟内飞书登录过」这条随时间变）。 */
export function useCredentials({ enabled = true }: { enabled?: boolean } = {}) {
  const api = useApi();
  return useQuery({
    queryKey: keys.credentials,
    queryFn: () => api.credentials(),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    enabled,
  });
}

export function useRepos() {
  const api = useApi();
  return useQuery({ queryKey: keys.repos, queryFn: () => api.repos(), staleTime: 60_000 });
}

/**
 * 每个项目的「让 AI 接活」开关。命令行 fleet-api dispatch 也能改它、没有推送，所以每 30 秒重拉；
 * 点开关的那一下自己重拉（useUpdateRepoDispatch）。
 */
export function useRepoDispatch() {
  const api = useApi();
  return useQuery({
    queryKey: keys.repoDispatch,
    queryFn: () => api.repoDispatch(),
    refetchInterval: 30_000,
  });
}

/**
 * 每个项目的 CI 模式。命令行和别的会话也能改、没有单独推送，所以每 30 秒重拉；
 * 点切换的那一下自己重拉（useUpdateRepoCiPolicy）。
 */
export function useRepoCiPolicy() {
  const api = useApi();
  return useQuery({
    queryKey: keys.repoCiPolicy,
    queryFn: () => api.repoCiPolicy(),
    refetchInterval: 30_000,
  });
}

/**
 * 一个仓的「指挥官整理待办」。现状从操作记录现算，操作记录一变会重拉（见下面 audit_log）；
 * 推送漏了也每 30 秒自己看一眼，整理中才会变成结果。
 */
export function useGroomStatus(repoId: string) {
  const api = useApi();
  return useQuery({
    queryKey: keys.groomStatus(repoId),
    queryFn: () => api.groomStatus(repoId),
    refetchInterval: 30_000,
  });
}

/** 本机会话（#1991）：本机每 2 分钟推一次，这里每 30 秒看一眼，够「刚停」「超过阈值没动」跟上。 */
export function useLocalSessions() {
  const api = useApi();
  return useQuery({
    queryKey: keys.localSessions,
    queryFn: () => api.localSessions(),
    refetchInterval: 30_000,
  });
}

/** 法国的工作树清单和最近几次清理：有一次在排队或在做时每 5 秒看一眼，平时每分钟。 */
export function useWorktrees() {
  const api = useApi();
  return useQuery({
    queryKey: keys.worktrees,
    queryFn: () => api.worktrees(),
    refetchInterval: (q) =>
      q.state.data?.cleanups.some((c) => c.status === 'queued' || c.status === 'running') ? 5_000 : 60_000,
  });
}

/** 「清理没用的工作树」按钮：成了重拉清单；拒的话（409 / 503）原样交给页面写出来。 */
export function useWorktreeCleanup() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: WorktreeCleanupBody) => api.worktreeCleanup(body),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.worktrees }),
  });
}

/**
 * 全部仓的看板（顶栏切换仓的计数、审计页用）。后端没有「全部任务」接口，按仓各拉一份。
 * 有仓没读成时 error 有值、failed 列出是哪几个仓：用的地方要把它说出来，不能把「少了一个仓」当成「没有需求」。
 */
export function useAllBoards(): { boards: Board[]; isLoading: boolean; error: unknown; failed: Repo[] } {
  const api = useApi();
  const repos = useRepos();
  const list = repos.data?.repos ?? [];
  const results = useQueries({
    queries: list.map((r) => ({ queryKey: keys.board(r.id), queryFn: () => api.board(r.id) })),
  });
  return {
    boards: results.flatMap((q) => (q.data ? [q.data] : [])),
    isLoading: repos.isLoading || results.some((q) => q.isLoading),
    error: repos.error ?? results.find((q) => q.error)?.error,
    failed: list.filter((_, i) => Boolean(results[i]?.error)),
  };
}

/** 后端说没有这个东西（404）：不是没读成，是真没有；重试也不会有。 */
export function isNotFound(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

/**
 * 按编号读一份详情（一张单、一个远程环境）：404 不重试，重试也不会有。别的失败照全局默认重试一次
 * （root.tsx 的 retry: 1；failureCount 从 0 起，只有第一次失败时才再试）。
 * 页面还要记住上一次的失败（lib/shown-error.ts）：没读到过数据的查询一被实时推送叫去重读，React Query 会把
 * error 清空、退回 pending，不记住就从「没有这个……」跳回加载骨架。
 */
function retryUnlessMissing(failures: number, err: unknown): boolean {
  return !isNotFound(err) && failures < 1;
}

/** 一张单的详情。404 不重试、页面记住失败，见 retryUnlessMissing。 */
export function useTaskDetail(taskId: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: keys.task(taskId ?? ''),
    queryFn: () => api.task(taskId ?? ''),
    enabled: Boolean(taskId),
    retry: retryUnlessMissing,
  });
}

/** 任务列表每次读多少行。 */
export const TASK_LIST_PAGE_SIZE = 30;

/** 任务列表按筛选条件翻页（往下滚或点「加载更多」读下一页）。任务一变（tasks 表的推送）就整份重拉。 */
export function useTaskList(filter: TaskListFilter) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: keys.taskList(filter),
    queryFn: ({ pageParam }) => api.tasks({ ...filter, cursor: pageParam, limit: TASK_LIST_PAGE_SIZE }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    ...useLivePoll(READ_POLL_MS),
  });
}

/**
 * 路由的在线状态由探针写、不推送，所以定时重拉。探针 15 分钟一轮，但驾驶舱「渠道状态」要看半分钟内的新读数
 * （#1087），这里 30 秒拉一次（和定时任务、主页近况同档），多页共用同一份缓存。
 */
export function useRouting({ enabled = true }: { enabled?: boolean } = {}) {
  const api = useApi();
  const poll = useLivePoll(30_000);
  return useQuery({ queryKey: keys.routing, queryFn: () => api.routing(), ...poll, enabled });
}

/**
 * 路由两层每一层现在活着吗（#574）。活不活由探针、额度、禁令现算：探针的结论不推送，所以和 useRouting 一样每 30 秒重拉
 * （路由页顶部的渠道状态两份一起读，#1087）；额度、渠道变了另由推送叫它重拉（下面 TABLE_KEYS）。
 * enabled 为假时不读。
 */
export function useRoutingLayers({ enabled = true }: { enabled?: boolean } = {}) {
  const api = useApi();
  const poll = useLivePoll(30_000);
  return useQuery({
    queryKey: keys.routingLayers,
    queryFn: () => api.routingLayers(),
    ...poll,
    enabled,
  });
}

/** 在跑的段每隔多久读一次新的会话内容。 */
export const TRANSCRIPT_POLL_MS = 3_000;
/** 一次读多少条：接口单次上限。 */
const TRANSCRIPT_PAGE = 500;

/**
 * 一段的会话内容（#1640）：打开才读（enabled）。每次读都从上次的 nextAfter 往后读，把新的接在已读到的后面，
 * 一页读满就接着读下一页；done 为真就不再读，没 done 的每 3 秒读一次（页面不在前台时 React Query 自己停）。
 * 读失败：已读到的条目留在 data 里，不清空；失败后不再自动轮询，由页面上的「重试」再读。
 */
export function useRunTranscript(taskId: string, runId: string, enabled: boolean) {
  const api = useApi();
  const qc = useQueryClient();
  const key = keys.runTranscript(taskId, runId);
  return useQuery({
    queryKey: key,
    enabled,
    retry: false,
    refetchInterval: (q) =>
      q.state.status === 'error' || q.state.data?.done || q.state.data?.noRecord ? false : TRANSCRIPT_POLL_MS,
    queryFn: async (): Promise<RunTranscript> => {
      const prev = qc.getQueryData<RunTranscript>(key);
      let entries = prev?.entries ?? [];
      let after = prev?.nextAfter ?? undefined;
      for (;;) {
        const page = await api.runTranscript(taskId, runId, {
          ...(after === undefined ? {} : { after }),
          limit: TRANSCRIPT_PAGE,
        });
        const seen = new Set(entries.map((e) => e.seq));
        entries = [...entries, ...page.entries.filter((e) => !seen.has(e.seq))];
        after = page.nextAfter ?? after;
        if (page.entries.length < TRANSCRIPT_PAGE || page.done) {
          return { ...page, entries, nextAfter: page.nextAfter ?? prev?.nextAfter ?? null };
        }
      }
    },
  });
}

/**
 * 立即探测的现状（渠道状态页）：有在排队、在探的，每 3 秒重拉一次，看到探完就把路由目录和路由两层也重拉（探完的结论写在
 * 路由上）；没有在探的每 30 秒一次。
 */
export function useRouteProbeStatus() {
  const api = useApi();
  const qc = useQueryClient();
  const settled = useRef<Set<string> | null>(null);
  const query = useQuery({
    queryKey: keys.routeProbe,
    queryFn: () => api.routeProbeStatus(),
    refetchInterval: (q) =>
      q.state.data?.requests.some((r) => r.state === 'queued' || r.state === 'running') ? 3_000 : 30_000,
  });
  const data = query.data;
  useEffect(() => {
    if (!data) return;
    const finished = new Set(
      data.requests.filter((r) => r.state !== 'queued' && r.state !== 'running').map((r) => r.requestId),
    );
    const before = settled.current;
    settled.current = finished;
    // 第一次拿到时不算「刚探完」；之后多出来的（这一眼才探完的）才叫路由重拉
    if (before && [...finished].some((id) => !before.has(id))) {
      qc.invalidateQueries({ queryKey: keys.routing });
      qc.invalidateQueries({ queryKey: keys.routingLayers });
      qc.invalidateQueries({ queryKey: keys.probeHistory });
    }
  }, [data, qc]);
  return query;
}

/** 探针真历史（#1139）。和路由目录一样 30 秒拉一次：探针不推送，引擎关着这一份照样读。 */
export function useProbeHistory() {
  const api = useApi();
  return useQuery({
    queryKey: keys.probeHistory,
    queryFn: () => api.routeProbeHistory(),
    refetchInterval: 30_000,
  });
}

/** 点「立即探测」：成了马上重拉现状（页面立刻看到排队）；没成的错误原样交给页面（引擎关着、没连上各有一句话）。 */
export function useRouteProbeNow() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RouteProbeNowBody) => api.routeProbeNow(body),
    onSuccess: (result) => {
      qc.setQueryData<RouteProbeStatus>(keys.routeProbe, (old) =>
        old ? { ...old, engine: result.engine, requests: [result.request, ...old.requests] } : old,
      );
      qc.invalidateQueries({ queryKey: keys.routeProbe });
      qc.invalidateQueries({ queryKey: ['audit'] });
    },
  });
}

/** 每条路由的思考档位（#470）。没有推送（routing_catalog 不在推送名单里）：改的那一下自己重拉，别人改的靠定时重拉。 */
export function useRoutingEfforts() {
  const api = useApi();
  return useQuery({
    queryKey: keys.routingEfforts,
    queryFn: () => api.routingEfforts(),
    refetchInterval: 60_000,
  });
}

export function usePools({ enabled = true }: { enabled?: boolean } = {}) {
  const api = useApi();
  const poll = useLivePoll(READ_POLL_MS);
  return useQuery({ queryKey: keys.pools, queryFn: () => api.pools(), ...poll, enabled });
}

/** 整池暂停现状（#746）：到期是按日期现算的，不靠推送，每分钟重拉；改设置、改提醒时另外作废（useUpdateSetting）。 */
export function usePoolHolds() {
  const api = useApi();
  return useQuery({ queryKey: keys.poolHolds, queryFn: () => api.poolHolds(), refetchInterval: 60_000 });
}

/**
 * 法国页上两档刷新。快的：机器、定时任务、发版进度。慢的：环境、发版卡、命令行工具（GitHub 现读，不要拉太勤）。
 * 页面上的「每 N 秒」用这两个数，不要再写死。
 */
export const POLL_FAST_MS = 30_000;
export const POLL_SLOW_MS = 60_000;

/** 定时任务不在推送名单里，按 POLL_FAST_MS 重拉。 */
export function useJobs() {
  const api = useApi();
  return useQuery({
    queryKey: keys.jobs,
    queryFn: () => api.jobs(),
    refetchInterval: POLL_FAST_MS,
  });
}

export const NOTIFICATIONS_PAGE = 200;

/** limit 是这一页最多取几条；总数看返回的 counts，不看 items.length。 */
export function useNotifications(status: 'open' | 'all' = 'open', limit: number = NOTIFICATIONS_PAGE) {
  const api = useApi();
  const poll = useLivePoll(READ_POLL_MS);
  return useQuery({
    queryKey:
      limit === NOTIFICATIONS_PAGE ? keys.notifications(status) : [...keys.notifications(status), limit],
    queryFn: () => api.notifications({ status, limit }),
    ...poll,
    // 只有「多看几条」（同一状态、limit 变大）才留着上一份，切到另一个状态不拿旧列表顶。
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === status ? prev : undefined),
  });
}

/** 操作记录按新到旧分页。target 是后端的对象编号，例如 stage:execute。 */
/** 操作记录一页读几条，「再看 50 条」每点一次再读一页（#1837：一次铺全部，手机端近两万像素）。 */
export const AUDIT_PAGE_SIZE = 50;

export function useAudit(target?: string) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: keys.audit(target ?? ''),
    queryFn: ({ pageParam }) => api.audit({ target, cursor: pageParam, limit: AUDIT_PAGE_SIZE }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function useSettings() {
  const api = useApi();
  return useQuery({ queryKey: keys.settings, queryFn: () => api.settings() });
}

/**
 * /france 页发版一键（#618）：release-train 此刻的状态（在走 / 暂停 / 没在走 / 读不到）。
 * 按 POLL_FAST_MS 重拉：release-train 自己跑起来这一步没人推，靠轮。读不到后端也照实显示「没查成」。
 */
export function useFranceReleaseState() {
  const api = useApi();
  return useQuery({
    queryKey: keys.franceReleaseState,
    queryFn: () => api.franceReleaseState(),
    refetchInterval: POLL_FAST_MS,
  });
}

/**
 * /france 页「发版」卡（#1231）：按 POLL_SLOW_MS 重拉（主线头、CI 在变；GitHub 现读，不要拉太勤）。读不到后端也照实显示「没查成」。
 */
export function useFranceReleaseCard() {
  const api = useApi();
  return useQuery({
    queryKey: keys.franceReleaseCard,
    queryFn: () => api.franceReleaseCard(),
    refetchInterval: POLL_SLOW_MS,
  });
}

/** /france 页「命令行工具」（#1969、#1971）：按 POLL_SLOW_MS 重拉。读不到后端也照实显示。 */
export function useCliTools() {
  const api = useApi();
  return useQuery({
    queryKey: keys.franceCliTools,
    queryFn: () => api.franceCliTools(),
    refetchInterval: POLL_SLOW_MS,
  });
}

/**
 * /changelog 页「已发布的提交」（#1255）：读法国发布历史；发了新版会自己变，页面开着每 5 分钟重拉一次。读不到后端也照实显示「没查成」。
 */
export function useFranceReleasedCommits() {
  const api = useApi();
  return useQuery({
    queryKey: keys.franceReleasedCommits,
    queryFn: () => api.franceReleasedCommits(),
    refetchInterval: 300_000,
  });
}

/**
 * /france 页「发布到法国」按钮（#1232）：点「确认发布」才发，只带提交号；后端回 409 带原因（头换了、CI 不绿、已有发版在走、没装接活单元……）。
 * 做完重拉发版卡和进度，操作记录里也多一条。
 */
export function useFranceRelease() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sha: string) => api.franceRelease(sha),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: keys.franceReleaseCard });
      qc.invalidateQueries({ queryKey: keys.franceReleaseState });
      qc.invalidateQueries({ queryKey: ['audit'] });
    },
  });
}

/**
 * 发版卡卡住、失败后的三个按钮（#2027）：重试、恢复引擎开关、撤掉暂停。写请求，后端回 409 带原因（刚变了、没有可点的、没装接活单元……）。
 * 做完重拉发版卡和进度，操作记录里也多一条。
 */
export function useFranceReleaseRecover() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (kind: ReleaseRecoverKind) => api.franceReleaseRecover(kind),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: keys.franceReleaseCard });
      qc.invalidateQueries({ queryKey: keys.franceReleaseState });
      qc.invalidateQueries({ queryKey: ['audit'] });
    },
  });
}

/**
 * /france 页「发版预检」按钮（#618）：点下让后端在进程内读七项事实。
 * 不收参数；前端用 useMutation 不缓存、不作废读。
 */
export function useFrancePreflight() {
  const api = useApi();
  return useMutation({ mutationFn: () => api.francePreflight() });
}

/**
 * 环境页的读取（#820 片 1）：这一台环境现在怎样。顶栏徽标不用它（名字跟着 /me 带回），只有开着环境页时才拉。
 * 只读、不跨环境。按 POLL_SLOW_MS 重拉——健康、在跑的会话这些没有实时推送。
 */
export function useEnv({ enabled = true }: { enabled?: boolean } = {}) {
  const api = useApi();
  return useQuery({
    queryKey: keys.env,
    queryFn: () => api.env(),
    refetchInterval: POLL_SLOW_MS,
    enabled,
  });
}

/**
 * 新主页（/）的聚合读取：一屏三块（要你拍的 / 在跑的 / 做完的）+ 持续状态条。
 * 后端不发网址（和 alert-work 一个规矩）：done 的跳转链接这里按品牌拼好再给卡片。
 */
export function useHome({ enabled = true }: { enabled?: boolean } = {}): {
  data: HomeState;
  refetch: () => Promise<unknown>;
  isFetching: boolean;
  dataUpdatedAt: number;
} {
  const api = useApi();
  // 推送不覆盖主页读的几样（合并了的 PR 镜像、路由探针结论、引擎健康），所以主页自己兜底轮询（#1799）
  const poll = useLivePoll(HOME_POLL_MS);
  const query = useQuery({ queryKey: keys.home, queryFn: () => api.home(), ...poll, enabled });
  return {
    data: homeStateOf(query),
    refetch: () => query.refetch(),
    isFetching: query.isFetching,
    dataUpdatedAt: query.dataUpdatedAt,
  };
}

/** 一份主页数据（本台现读的、远程快照里的都一样）按品牌拼好「做完的」的链接。 */
function homeDataOf(data: HomeResponse): HomeData {
  return {
    decisions: data.decisions,
    running: data.running,
    done: data.done.map((d) => {
      const cut = d.repo.indexOf('/');
      const repo = { owner: d.repo.slice(0, cut), name: d.repo.slice(cut + 1) };
      return { ...d, link: brand.repoLink(repo, 'pull', d.prNumber) };
    }),
    health: data.health,
    flow: data.flow,
    slots: data.slots,
    resources: data.resources,
  };
}

function homeStateOf(query: {
  isPending: boolean;
  error: unknown;
  data: HomeResponse | undefined;
  refetch: () => unknown;
}): HomeState {
  if (query.error) return { status: 'error', error: query.error, retry: () => void query.refetch() };
  if (query.isPending || !query.data) return { status: 'loading' };
  return { status: 'data', data: homeDataOf(query.data) };
}

/**
 * 看板多机：本台加每个远程环境（本机 WSL）的新鲜度。别的环境推来快照时 node_reports 推送叫它重拉；
 * 新鲜度按时间变（推送停了没有事件），所以按 POLL_FAST_MS 也重拉一次。
 */
export function useNodes() {
  const api = useApi();
  return useQuery({
    queryKey: keys.nodes,
    queryFn: () => api.nodes(),
    refetchInterval: POLL_FAST_MS,
  });
}

/**
 * 一个远程环境最近一次推来的快照（主页 ?node=、环境页的远程列）。nodeId 为空（选的是本台）时不读。
 * 没有这个环境是 404，不重试（retryUnlessMissing）；页面自己记住失败，推送重读不跳回骨架。
 */
export function useNode(nodeId: string | null) {
  const api = useApi();
  const poll = useLivePoll(HOME_POLL_MS);
  return useQuery({
    queryKey: keys.node(nodeId ?? ''),
    queryFn: () => api.node(nodeId ?? ''),
    ...poll,
    enabled: nodeId !== null,
    retry: retryUnlessMissing,
  });
}

/** 环境页并排的各列：每个收到过快照的远程环境各读一份。404 同样不重试。 */
export function useNodeSnapshots(ids: readonly string[]) {
  const api = useApi();
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: keys.node(id),
      queryFn: () => api.node(id),
      refetchInterval: POLL_FAST_MS,
      retry: retryUnlessMissing,
    })),
  });
}

/** 选了远程环境时的主页：读那个环境的快照，形状和本台的主页一样。error 是这一次查询的，重读时会被清掉，页面要另记。 */
export function useNodeHome(nodeId: string | null): {
  data: HomeState;
  node: NodeDetail | undefined;
  error: unknown;
  refetch: () => Promise<unknown>;
  isFetching: boolean;
  dataUpdatedAt: number;
} {
  const query = useNode(nodeId);
  return {
    data: homeStateOf({
      isPending: query.isPending,
      error: query.error,
      data: query.data?.home,
      refetch: query.refetch,
    }),
    node: query.data,
    error: query.error,
    refetch: () => query.refetch(),
    isFetching: query.isFetching,
    dataUpdatedAt: query.dataUpdatedAt,
  };
}

// ---------- 提需求（#2062） ----------

/**
 * 需求列表每隔多久重拉：需求表不在推送名单里（动作会记操作记录，那条推送另外叫它重拉），
 * 别人发的话只能靠轮询看到，所以比别的读页勤。指挥官的流式回话是 C 片的事。
 */
export const REQUEST_LIST_POLL_MS = 15_000;
/** 开着的那条对话每隔多久重拉（看对方新说的话）。 */
export const REQUEST_DETAIL_POLL_MS = 5_000;

export function useRequestList(query: RequestListQueryBody, { enabled = true }: { enabled?: boolean } = {}) {
  const api = useApi();
  return useQuery({
    queryKey: keys.requests(query),
    queryFn: () => api.requests(query),
    refetchInterval: REQUEST_LIST_POLL_MS,
    refetchIntervalInBackground: false,
    // 换筛选、换搜索词时留着上一份，不闪成骨架
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === query.view ? prev : undefined),
    enabled,
  });
}

/** 一条需求的详情。404 不重试（retryUnlessMissing），页面另记失败。 */
export function useRequestDetail(seq: number | null) {
  const api = useApi();
  return useQuery({
    queryKey: keys.request(seq ?? 0),
    queryFn: () => api.request(seq ?? 0),
    enabled: seq !== null,
    retry: retryUnlessMissing,
    refetchInterval: REQUEST_DETAIL_POLL_MS,
    refetchIntervalInBackground: false,
  });
}

/** 多选时选中的那几条的详情：菜单和批量操作只看 actions 里能做的，不在前端猜。 */
export function useRequestDetails(seqs: readonly number[]) {
  const api = useApi();
  return useQueries({
    queries: seqs.map((seq) => ({
      queryKey: keys.request(seq),
      queryFn: () => api.request(seq),
      retry: retryUnlessMissing,
    })),
  });
}

/** 「等我的」件数（角标和筛选上的数）：进行中、全部那一份的 counts.todo。后端没接上需求表、读不到时是 undefined，不当 0。 */
export function useRequestTodoCount(): number | undefined {
  const { data } = useRequestList({ view: 'active', filter: 'all' });
  if (!data || data.unavailable !== undefined) return undefined;
  return data.counts.todo;
}

/** 写完把回来的详情直接放进缓存（页面马上是库里现在的样子），列表重拉。 */
function useRequestWrite<V>(run: (api: FleetApi, vars: V) => Promise<RequestDetail>) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: V) => run(api, vars),
    onSuccess: (detail) => {
      qc.setQueryData(keys.request(detail.request.seq), detail);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['requests'] });
    },
  });
}

export function useCreateRequest() {
  return useRequestWrite((api, body: CreateRequestBody) => api.createRequest(body));
}

export function useSendRequestMessage() {
  return useRequestWrite((api, v: { seq: number; body: SendRequestMessageBody }) =>
    api.sendRequestMessage(v.seq, v.body),
  );
}

export function useUpdateRequestDraft() {
  return useRequestWrite((api, v: { seq: number; body: UpdateRequestDraftBody }) =>
    api.updateRequestDraft(v.seq, v.body),
  );
}

export function useRequestAction() {
  return useRequestWrite((api, v: { seq: number; body: RequestActionBody }) =>
    api.requestAction(v.seq, v.body),
  );
}

export function useAnswerEngineAsk() {
  return useRequestWrite((api, v: { seq: number; messageId: number; text: string }) =>
    api.answerEngineAsk(v.seq, v.messageId, v.text),
  );
}

export function useNudgeCommander() {
  return useRequestWrite((api, seq: number) => api.nudgeCommander(seq));
}

export function useStopCommander() {
  return useRequestWrite((api, seq: number) => api.stopCommander(seq));
}

export function useSetCommanderModel() {
  return useRequestWrite((api, v: { seq: number; modelId: string | null }) =>
    api.setCommanderModel(v.seq, v.modelId),
  );
}

export function useRequestReview() {
  return useRequestWrite((api, seq: number) => api.requestReview(seq));
}

export function useMarkReviewItem() {
  return useRequestWrite(
    (api, v: { seq: number; messageId: number; index: number; verdict: RequestReviewVerdict }) =>
      api.markReviewItem(v.seq, v.messageId, { index: v.index, verdict: v.verdict }),
  );
}

/** 查这一版开没开成单（确定、同意做超时以后）：直接调，不进缓存。 */
export function useIssueOpeningLookup(): (seq: number, draftVersion: number) => Promise<RequestIssueOpening> {
  const api = useApi();
  return useCallback(
    (seq: number, draftVersion: number) => api.requestIssueOpening(seq, draftVersion),
    [api],
  );
}

/**
 * 指挥官正在回话时（排着、在跑）开着回话的流：写到哪了、「正在读代码……」；回完或断了关流，并重拉详情。
 * 没在跑不开流（返回 null）。断了照实给出原因，页面写出来，不当成回完了。
 */
export function useCommanderStream(
  seq: number,
  running: boolean,
): { live: RequestChatStreamEvent | null; broken: string | null } {
  const api = useApi();
  const qc = useQueryClient();
  const [live, setLive] = useState<RequestChatStreamEvent | null>(null);
  const [broken, setBroken] = useState<string | null>(null);
  useEffect(() => {
    if (!running) {
      setLive(null);
      return;
    }
    setBroken(null);
    const stop = api.commanderStream(seq, (m) => {
      if (m.type === 'commander') {
        setLive(m.event);
        return;
      }
      if (m.type === 'error') setBroken(m.why);
      setLive(null);
      void qc.invalidateQueries({ queryKey: keys.request(seq) });
      void qc.invalidateQueries({ queryKey: ['requests'] });
    });
    return stop;
  }, [api, qc, seq, running]);
  return { live, broken };
}

/** 读到哪一条：成了列表重拉（未读、等我的跟着变），失败不打扰人（下次进来再记）。 */
export function useMarkRequestRead() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ seq, messageId }: { seq: number; messageId: number }) =>
      api.markRequestRead(seq, messageId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['requests'] }),
  });
}

// ---------- 写 ----------

export function useTaskAction() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, body }: { taskId: string; body: TaskActionBody }) => api.taskAction(taskId, body),
    onSettled: (_d, _e, { taskId }) => {
      qc.invalidateQueries({ queryKey: keys.task(taskId) });
      qc.invalidateQueries({ queryKey: ['board'] });
    },
  });
}

/**
 * 单子页给一段指定模型、或清掉。不先改缓存：要等后端核过（模型不在目录、路由不是这个模型的 422，
 * 单子结束了 409）才算数；不管成没成都重拉这张单，页面上永远是库里现在的指定。
 */
export function useUpdateTaskRoutePin() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, body }: { taskId: string; body: UpdateTaskRoutePinBody }) =>
      api.updateTaskRoutePin(taskId, body),
    onSettled: (_data, _error, { taskId }) => {
      qc.invalidateQueries({ queryKey: keys.task(taskId) });
      qc.invalidateQueries({ queryKey: ['audit'] });
    },
  });
}

/**
 * 改一条路由的思考档位（#470）。不先改缓存：档位要等后端照这条路由的执行方式判过（不认的 422、别人刚改过 409）才算数，
 * 页面在等的那一下标「改着」；不管成没成都重拉一次，页面上永远是库里现在的值。
 */
export function useUpdateRouteEffort() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      modelId,
      routeId,
      body,
    }: {
      modelId: string;
      routeId: string;
      body: UpdateRouteEffortBody;
    }) => api.updateRouteEffort(modelId, routeId, body),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: keys.routingEfforts });
      qc.invalidateQueries({ queryKey: ['audit'] });
    },
  });
}

/**
 * 路由页改先后和开关（母单 #1089）。不先改缓存：顺序要等后端比过「我看到的」（别人先改了 409）才算数，
 * 页面在等的那一下按钮置灰；不管成没成都重拉路由两层，页面上永远是库里现在的顺序。
 */
export function useMovePurposeModel() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      purpose,
      modelId,
      body,
    }: {
      purpose: string;
      modelId: string;
      body: MovePurposeModelBody;
    }) => api.movePurposeModel(purpose, modelId, body),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: keys.routingLayers });
      qc.invalidateQueries({ queryKey: ['audit'] });
    },
  });
}

/**
 * 用途里加模型、移出、改档位（#1380）。不先改缓存：版本对不上、硬禁令、档位不认，都等后端回了才算数。
 * 成没成都重拉路由两层，页面上永远是库里现在的名单。
 */
function usePurposeMembership(
  run: (
    api: FleetApi,
    vars: { purpose: string; modelId?: string; body: unknown },
  ) => Promise<PurposeMembership>,
) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { purpose: string; modelId?: string; body: unknown }) => run(api, vars),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: keys.routingLayers });
      qc.invalidateQueries({ queryKey: ['audit'] });
    },
  });
}

export function useAddPurposeModel() {
  return usePurposeMembership((api, vars) =>
    api.addPurposeModel(vars.purpose, vars.body as AddPurposeModelBody),
  );
}

export function useRemovePurposeModel() {
  return usePurposeMembership((api, vars) =>
    api.removePurposeModel(vars.purpose, vars.modelId ?? '', vars.body as RemovePurposeModelBody),
  );
}

export function useSetPurposeModelEffort() {
  return usePurposeMembership((api, vars) =>
    api.setPurposeModelEffort(vars.purpose, vars.modelId ?? '', vars.body as SetPurposeModelEffortBody),
  );
}

/**
 * 改模型下渠道的先后，以及路由页上的渠道开关（每条路由一个，确认后发 op:'enable'）。
 * #856 第 2 处判定：渠道这一级的总开关（旧的 useUpdateChannel、PATCH /api/routing/channels/:id）是有意撤掉的，
 * 不是漏了入口。#928 把它标成看板删除后没人用的残留，#972 从契约、后端、前端一起删了；
 * packages/api 的 web-routes-contract 测试钉着这条接口保持 404，这里不再导出 useUpdateChannel，也不把它接回来。
 * 路由两层和思考档位页（它也按这个先后列）在写完后一起重拉。
 */
export function useUpdateModelRoute() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      modelId,
      routeId,
      body,
    }: {
      modelId: string;
      routeId: string;
      body: UpdateModelRouteBody;
    }) => api.updateModelRoute(modelId, routeId, body),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: keys.routingLayers });
      qc.invalidateQueries({ queryKey: keys.routingEfforts });
      qc.invalidateQueries({ queryKey: ['audit'] });
    },
  });
}

/** 模型级开关。写完重拉路由两层：页面上每条路由的开关跟着变。 */
export function useSetModelEnabled() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ modelId, body }: { modelId: string; body: SetModelEnabledBody }) =>
      api.setModelEnabled(modelId, body),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: keys.routingLayers });
      qc.invalidateQueries({ queryKey: keys.routingEfforts });
      qc.invalidateQueries({ queryKey: ['audit'] });
    },
  });
}

/** 渠道级开关。渠道目录和路由两层都重拉：关了的渠道，路由上写「渠道已关」。 */
export function useSetChannelEnabled() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ channelId, body }: { channelId: string; body: SetChannelEnabledBody }) =>
      api.setChannelEnabled(channelId, body),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: keys.routing });
      qc.invalidateQueries({ queryKey: keys.routingLayers });
      qc.invalidateQueries({ queryKey: ['audit'] });
    },
  });
}

/** 手工登记、撤掉一个模型串。名册差集和路由目录一起重拉；页面上已登记的名单另由这次的返回维护。 */
function useManualModel(kind: 'register' | 'revoke') {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ channelId, body }: { channelId: string; body: ManualModelBody }) =>
      kind === 'register'
        ? api.registerChannelModel(channelId, body)
        : api.revokeChannelModel(channelId, body),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: keys.routing });
      qc.invalidateQueries({ queryKey: keys.routingLayers });
      qc.invalidateQueries({ queryKey: ['audit'] });
    },
  });
}

export function useRegisterChannelModel() {
  return useManualModel('register');
}

export function useRevokeChannelModel() {
  return useManualModel('revoke');
}

export function useResolveNotification() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.resolveNotification(id),
    onSettled: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
}

/** 回答「要你拍」（#1915）：存下就转已处理，重拉通知列表。 */
export function useAnswerNotification() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: AnswerNotificationBody }) =>
      api.answerNotification(id, body),
    onSettled: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
}

/** 开、关一个项目的「让 AI 接活」：不先改缓存，等后端写完（开关和操作记录同一事务）再重拉，页面上永远是库里现在的值。 */
export function useUpdateRepoDispatch() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ repoId, body }: { repoId: string; body: UpdateRepoDispatchBody }) =>
      api.updateRepoDispatch(repoId, body),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: keys.repoDispatch });
      qc.invalidateQueries({ queryKey: ['audit'] });
    },
  });
}

/** 切换一个项目的 CI 模式：等后端写完（模式和操作记录同一事务）再重拉。 */
export function useUpdateRepoCiPolicy() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ repoId, body }: { repoId: string; body: UpdateRepoCiPolicyBody }) =>
      api.updateRepoCiPolicy(repoId, body),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: keys.repoCiPolicy });
      qc.invalidateQueries({ queryKey: ['audit'] });
    },
  });
}

/**
 * 「导入仓库」列表（#1989）：我 GitHub 上看得见的仓，每个标好装没装、在不在驾驶舱。
 * 不自动轮询：这是「我点一下去 GitHub 装个 App，回来刷新才看得到」的那类，拉得太勤是白问 GitHub。
 */
export function useImportableRepos() {
  const api = useApi();
  return useQuery({
    queryKey: keys.importableRepos,
    queryFn: () => api.importableRepos(),
    retry: false,
  });
}

/** 把一个仓接进/移出驾驶舱：等后端写完再重拉（接了要刷新列表和仓列表、记了操作记录）。 */
export function useImportRepo() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { githubId: number }) => api.importRepo(body),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: keys.importableRepos });
      qc.invalidateQueries({ queryKey: keys.repos });
      qc.invalidateQueries({ queryKey: keys.repoDispatch });
      qc.invalidateQueries({ queryKey: ['audit'] });
    },
  });
}

export function useRemoveRepo() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (repoId: string) => api.removeRepo(repoId),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: keys.importableRepos });
      qc.invalidateQueries({ queryKey: keys.repos });
      qc.invalidateQueries({ queryKey: keys.repoDispatch });
      qc.invalidateQueries({ queryKey: ['audit'] });
    },
  });
}

/** 把两个 App 装到某个仓（一键授权那一步）。 */
export function useInstallAppOnRepo() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { githubId: number }) => api.installAppOnRepo(body),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: keys.importableRepos });
      qc.invalidateQueries({ queryKey: ['audit'] });
    },
  });
}

/** 断开本人 GitHub 授权。 */
export function useDisconnectGitHub() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.disconnectGitHub(),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: keys.importableRepos });
      qc.invalidateQueries({ queryKey: ['audit'] });
    },
  });
}

/**
 * 叫一次整理。锁是全局的：成功或被拒（别人刚占上）都重拉每一个仓的这一块，不拿点击前的次数冒充现在。
 */
export function useGroomNow() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ repoId, body }: { repoId: string; body: GroomNowBody }) => api.groomNow(repoId, body),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['groom-status'] });
      qc.invalidateQueries({ queryKey: ['audit'] });
    },
  });
}

export function useUpdateSetting() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, body }: { key: SettingKey; body: UpdateSettingBody }) => api.updateSetting(key, body),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: keys.settings });
      qc.invalidateQueries({ queryKey: keys.poolHolds });
      // 引擎总开关（engine.master）的状态在环境快照里：顶栏马上跟着变
      qc.invalidateQueries({ queryKey: keys.env });
    },
  });
}

/**
 * 设 / 改账密：成了操作记录里多一条（credentials.set / credentials.change）。不管成不成，所有查询都重拉一遍：
 * 改密码时页面上在途的读取带的是旧 Cookie、回来是 401（http.ts 已不把它们当登录过期），这些查询要用新 Cookie 再读一次，
 * 不然页面上留着一堆「没读成」。
 */
export function useUpdateCredentials() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateCredentialsBody) => api.updateCredentials(body),
    onSettled: () => qc.invalidateQueries(),
  });
}

// ---------- 实时 ----------

/**
 * 推送只说「哪张表的哪一行变了」，前端按表名决定重拉什么。表名单在 shared/realtime.ts：
 * 名单里加了表而这里没写，tsc 当场报错。认不出的表一律全量重拉——宁可多拉一次，也不把「漏收」当成「没变化」。
 * 不在名单里的表（定时任务、路由、模型……）没有推送，对应页面靠定时重拉。
 * 主页（keys.home）一份读取聚齐了需求、通知、在跑的会话、三段流水、额度和渠道：这几张表哪张变了都要作废它。
 * 漏写一张或推送断了，由 useHome 的兜底轮询（useLivePoll，30 秒 / 断了 10 秒）和切回窗口重拉顶上。
 */
const TABLE_KEYS: Record<RealtimeTable, readonly (readonly string[])[]> = {
  tasks: [['board'], ['task'], ['task-list'], keys.home],
  subtasks: [['board'], ['task']],
  session_runs: [['board'], ['task'], ['task-list'], ['pools'], keys.home],
  // 三段流水（scope / manual / verify）：主页的流水线图、任务详情的流水、任务列表的段和花费都读它
  runs: [keys.home, ['task'], ['task-list']],
  progress_events: [['board'], ['task']],
  // asks 表留着（删表要创始人点头，#939），没有读它的页面：变了不用重拉任何东西
  asks: [],
  // approvals 还没有专门的页面查询键；按它挂在任务 / 子任务上，先失效这两处，主页「要你拍的」也跟着重拉。
  approvals: [['board'], ['task'], keys.home],
  // 池本身改了（pools 的触发器，0002）也报成 quota_windows，所以 pools 不单列。
  quota_windows: [['pools'], ['routing-layers'], keys.home],
  channels: [['routing'], ['pools'], ['routing-layers'], keys.home],
  notifications: [['notifications'], keys.home],
  // 整理待办的现状是从操作记录现算的：点了、接手、做完都记在这张表，各仓这一块跟着变
  // 提需求的每个动作（提交、拍板、归档、删除……）也记一条操作记录：需求列表和详情跟着重拉
  audit_log: [['audit'], ['groom-status'], ['requests'], ['request']],
  // 引擎总开关（设置 engine.master，#1086）的状态在环境快照里，顶栏常驻显示它：设置一变，环境也跟着重拉
  settings: [['settings'], keys.env],
  // 别的环境推来了新快照：顶栏切换器和环境页的列表、选中的那个环境的主页和环境页都重拉。
  node_reports: [keys.nodes, ['node']],
  // 提需求（#2060）：需求一有动静（新消息、进度卡、引擎提问、单子状态）就推，载荷里的 id 是需求号；列表和详情跟着重拉
  requests: [['requests'], ['request']],
};

function isRealtimeTable(table: string): table is RealtimeTable {
  return (REALTIME_TABLES as readonly string[]).includes(table);
}

/** 已经挂上「读完再拉一次」的缓存（同一份只挂一次）。 */
const refetchWhenDone = new WeakSet<object>();

/**
 * 作废并重拉，但不打断正在读的那一次：打断了要从头再等一整轮（香港到法国一趟往返约 0.2 秒）——首屏刚发出去的读取
 * 会被连上推送时的全量重拉打断，推送一密看板就一直读不完。正在读的那一次可能是变化之前读的，所以等它读完再补拉一次。
 */
function refresh(qc: QueryClient, queryKey?: readonly string[]) {
  const cache = qc.getQueryCache();
  for (const query of cache.findAll(queryKey ? { queryKey: [...queryKey] } : {})) {
    if (query.state.fetchStatus !== 'fetching' || refetchWhenDone.has(query)) continue;
    refetchWhenDone.add(query);
    const stop = cache.subscribe((ev) => {
      if (ev.query !== query) return;
      if (ev.type !== 'removed' && query.state.fetchStatus === 'fetching') return;
      stop();
      refetchWhenDone.delete(query);
      if (ev.type !== 'removed') {
        queueMicrotask(() => void qc.invalidateQueries({ queryKey: query.queryKey, exact: true }));
      }
    });
  }
  void qc.invalidateQueries(queryKey ? { queryKey: [...queryKey] } : undefined, { cancelRefetch: false });
}

/** 一批推送一起作废：同一份缓存只作废一次；其中有认不出的、或是重连，就全部作废一次。 */
export function applyLiveEvents(qc: QueryClient, events: readonly LiveEvent[]) {
  const keysToDrop = new Map<string, readonly string[]>();
  for (const e of events) {
    if (e.type === 'resources') {
      // 机器资源（#1973）：读数本身就在推送里，直接换掉本台主页数据里的 resources，不作废、不重拉主页。
      // 还没读到过主页就不造一份（等主页读回来自带最近一回）；一批里有几回，后来的盖掉先来的
      qc.setQueryData<HomeResponse>(keys.home, (old) => (old ? { ...old, resources: e.resources } : old));
      continue;
    }
    const targets = e.type === 'change' && isRealtimeTable(e.table) ? TABLE_KEYS[e.table] : undefined;
    if (!targets) {
      refresh(qc);
      return;
    }
    for (const k of targets) keysToDrop.set(k.join('/'), k);
  }
  for (const queryKey of keysToDrop.values()) refresh(qc, queryKey);
}

/**
 * 推送攒一小会儿再作废缓存：会话每报一步进度就来一条，几十个会话一起跑时每秒好几条；
 * 每条都让看板整份重拉，页面就一直在拉、在比对。攒 wait 毫秒（从第一条算起）一起处理，最多晚这么久。
 */
export function createLiveBatcher(qc: QueryClient, wait = 400) {
  let pending: LiveEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    const batch = pending;
    pending = [];
    if (batch.length) applyLiveEvents(qc, batch);
  };
  return {
    push(e: LiveEvent) {
      pending.push(e);
      timer ??= setTimeout(flush, wait);
    },
    flush,
    stop() {
      clearTimeout(timer);
      timer = undefined;
      pending = [];
    },
  };
}

// 顶栏的「实时」小灯看这里：连接状态和最近一次收到推送的时间。
let liveState: { status: LiveStatus; lastEventAt: number } = { status: 'connecting', lastEventAt: 0 };
const liveListeners = new Set<() => void>();
function setLive(patch: Partial<typeof liveState>) {
  liveState = { ...liveState, ...patch };
  for (const l of liveListeners) l();
}

export function useLiveState() {
  return useSyncExternalStore(
    (cb) => {
      liveListeners.add(cb);
      return () => liveListeners.delete(cb);
    },
    () => liveState,
    () => liveState,
  );
}

/** 把推送接到缓存。整个应用只挂一次（在外壳里）。enabled 为假时先不连（外壳在确认登录之前就挂上了，确认了再连）。 */
export function useLiveSync(enabled = true) {
  const api = useApi();
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const batch = createLiveBatcher(qc);
    const stop = api.subscribe(
      (e) => {
        batch.push(e);
        setLive({ lastEventAt: Date.now() });
      },
      (status) => setLive({ status }),
    );
    return () => {
      stop();
      batch.stop();
    };
  }, [api, qc, enabled]);
}

/**
 * 退出：先取消在飞查询（停掉外壳轮询），再调 api.logout（里头停推送、抬 sessionEpoch，
 * 在飞的 401 不再二次跳登录页），最后清缓存。调用方自己 navigate 到登录页。
 */
export async function logoutAndClear(api: FleetApi, qc: QueryClient): Promise<void> {
  await qc.cancelQueries();
  await api.logout();
  qc.clear();
}
