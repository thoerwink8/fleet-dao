// 驾驶舱的所有读写都经过 FleetApi：方法和 shared/web-api.ts 的 WebRoutes 一一对应，形状全用那份定义。
// 实现有两个：http.ts（真后端，带 CSRF 头、SSE 推送）和 mock/（假数据，开发和测试用），在 api/index.ts 里选。

import { REALTIME_TABLES, type RealtimeTable } from '@fleet-dao/shared';
import {
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { createContext, type ReactNode, useContext, useEffect, useRef, useSyncExternalStore } from 'react';
import { brand } from '#brand';
import type { HomeData, HomeState } from '../components/home/types';
import type {
  AddPurposeModelBody,
  Audit,
  AuthConfig,
  Board,
  Credentials,
  EnvResponse,
  FrancePreflightResponse,
  FranceReleaseState,
  GroomNowBody,
  GroomNowResult,
  GroomStatus,
  HomeResponse,
  Jobs,
  LiveEvent,
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
  ReleaseRequestResult,
  RemovePurposeModelBody,
  Repo,
  RepoDispatch,
  RouteProbeHistory,
  RouteProbeNowBody,
  RouteProbeNowResult,
  RouteProbeStatus,
  Routing,
  RoutingEfforts,
  RoutingLayers,
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
  UpdatedRepoDispatch,
  UpdatedRouteEffort,
  UpdateModelRouteBody,
  UpdateRepoDispatchBody,
  UpdateRouteEffortBody,
  UpdateSettingBody,
  UpdateTaskRoutePinBody,
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
  board(repoId: string): Promise<Board>;
  /** 任务列表页（#1639）：所有仓、所有状态，最近更新在前，游标翻页，带各状态的数。 */
  tasks(query?: TaskListFilter & { cursor?: string | undefined; limit?: number }): Promise<TaskList>;
  task(taskId: string): Promise<TaskDetail>;
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
  /** /france 页「发版预检」按钮：点下让后端起 pnpm release:onekey preflight，命令写死、不收参数。 */
  francePreflight(): Promise<FrancePreflightResponse>;
  /** 订阅实时推送，返回取消订阅的函数。onStatus 报连接状态（给顶栏的「实时」小灯）。 */
  subscribe(listener: (event: LiveEvent) => void, onStatus?: (status: LiveStatus) => void): () => void;
}

/** 后端的错误：code 给程序判断，message 是给人看的白话（直接显示）。 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
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
  groomStatus: (repoId: string) => ['groom-status', repoId] as const,
  board: (repoId: string) => ['board', repoId] as const,
  task: (taskId: string) => ['task', taskId] as const,
  taskList: (filter: TaskListFilter) =>
    ['task-list', filter.status ?? '', filter.repoId ?? '', filter.q ?? ''] as const,
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
  franceReleaseCard: ['france-release-card'] as const,
  franceReleasedCommits: ['france-released-commits'] as const,
  env: ['env'] as const,
  home: ['home'] as const,
  nodes: ['nodes'] as const,
  node: (nodeId: string) => ['node', nodeId] as const,
};

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
  });
}

/**
 * 路由的在线状态由探针写、不推送，所以定时重拉。探针 15 分钟一轮，但驾驶舱「渠道状态」要看半分钟内的新读数
 * （#1087），这里 30 秒拉一次（和定时任务、主页近况同档），多页共用同一份缓存。
 */
export function useRouting({ enabled = true }: { enabled?: boolean } = {}) {
  const api = useApi();
  return useQuery({ queryKey: keys.routing, queryFn: () => api.routing(), refetchInterval: 30_000, enabled });
}

/**
 * 路由两层每一层现在活着吗（#574）。活不活由探针、额度、禁令现算：探针的结论不推送，所以和 useRouting 一样每 30 秒重拉
 * （路由页顶部的渠道状态两份一起读，#1087）；额度、渠道变了另由推送叫它重拉（下面 TABLE_KEYS）。
 * enabled 为假时不读。
 */
export function useRoutingLayers({ enabled = true }: { enabled?: boolean } = {}) {
  const api = useApi();
  return useQuery({
    queryKey: keys.routingLayers,
    queryFn: () => api.routingLayers(),
    refetchInterval: 30_000,
    enabled,
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
  return useQuery({ queryKey: keys.pools, queryFn: () => api.pools(), enabled });
}

/** 整池暂停现状（#746）：到期是按日期现算的，不靠推送，每分钟重拉；改设置、改提醒时另外作废（useUpdateSetting）。 */
export function usePoolHolds() {
  const api = useApi();
  return useQuery({ queryKey: keys.poolHolds, queryFn: () => api.poolHolds(), refetchInterval: 60_000 });
}

/** 定时任务不在推送名单里，每 30 秒重拉一次。 */
export function useJobs() {
  const api = useApi();
  return useQuery({
    queryKey: keys.jobs,
    queryFn: () => api.jobs(),
    refetchInterval: 30_000,
  });
}

export function useNotifications(status: 'open' | 'all' = 'open') {
  const api = useApi();
  return useQuery({
    queryKey: keys.notifications(status),
    queryFn: () => api.notifications({ status, limit: 200 }),
  });
}

/** 操作记录按新到旧分页。target 是后端的对象编号，例如 stage:execute。 */
export function useAudit(target?: string) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: keys.audit(target ?? ''),
    queryFn: ({ pageParam }) => api.audit({ target, cursor: pageParam, limit: 100 }),
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
 * 30 秒重拉一次：release-train 自己跑起来这一步没人推，靠轮。读不到后端也照实显示「没查成」。
 */
export function useFranceReleaseState() {
  const api = useApi();
  return useQuery({
    queryKey: keys.franceReleaseState,
    queryFn: () => api.franceReleaseState(),
    refetchInterval: 30_000,
  });
}

/**
 * /france 页「发版」卡（#1231）：1 分钟重拉一次（主线头、CI 在变；GitHub 现读，不要拉太勤）。读不到后端也照实显示「没查成」。
 */
export function useFranceReleaseCard() {
  const api = useApi();
  return useQuery({
    queryKey: keys.franceReleaseCard,
    queryFn: () => api.franceReleaseCard(),
    refetchInterval: 60_000,
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
 * /france 页「发版预检」按钮（#618）：点下让后端起 pnpm release:onekey preflight。
 * 命令后端写死、不收参数；最长 60 秒（后端 timeout），前端用 useMutation 不缓存、不作废读。
 */
export function useFrancePreflight() {
  const api = useApi();
  return useMutation({ mutationFn: () => api.francePreflight() });
}

/**
 * 环境页的读取（#820 片 1）：这一台环境现在怎样。顶栏徽标不用它（名字跟着 /me 带回），只有开着环境页时才拉。
 * 只读、不跨环境。每分钟重拉一次——健康、在跑的会话这些没有实时推送。
 */
export function useEnv({ enabled = true }: { enabled?: boolean } = {}) {
  const api = useApi();
  return useQuery({
    queryKey: keys.env,
    queryFn: () => api.env(),
    refetchInterval: 60_000,
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
  const query = useQuery({ queryKey: keys.home, queryFn: () => api.home(), enabled });
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
 * 新鲜度按时间变（推送停了没有事件），所以每 30 秒也重拉一次。
 */
export function useNodes() {
  const api = useApi();
  return useQuery({
    queryKey: keys.nodes,
    queryFn: () => api.nodes(),
    refetchInterval: 30_000,
  });
}

/**
 * 一个远程环境最近一次推来的快照（主页 ?node=、环境页的远程列）。nodeId 为空（选的是本台）时不读。
 * 没有这个环境是 404，不重试（retryUnlessMissing）；页面自己记住失败，推送重读不跳回骨架。
 */
export function useNode(nodeId: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: keys.node(nodeId ?? ''),
    queryFn: () => api.node(nodeId ?? ''),
    refetchInterval: 30_000,
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
      refetchInterval: 30_000,
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
 * 单子页给一段指定模型、或清掉（驾驶舱改版 2026-10-07）。不先改缓存：要等后端核过（模型不在目录、路由不是这个模型的 422，
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
 * 主页（keys.home）一份读取聚齐了需求、通知、在跑的会话、三段流水、额度和渠道：这几张表哪张变了都要作废它——主页不定时重拉、
 * 切回窗口也不重拉（root.tsx），漏写一张，那一块就停在打开页面时的样子。
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
  audit_log: [['audit'], ['groom-status']],
  // 引擎总开关（设置 engine.master，#1086）的状态在环境快照里，顶栏常驻显示它：设置一变，环境也跟着重拉
  settings: [['settings'], keys.env],
  // 别的环境推来了新快照：顶栏切换器和环境页的列表、选中的那个环境的主页和环境页都重拉。
  node_reports: [keys.nodes, ['node']],
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
