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
import { createContext, type ReactNode, useContext, useEffect, useSyncExternalStore } from 'react';
import { brand } from '#brand';
import type { HomeState } from '../components/home/types';
import { canSee, isDemo } from '../demo/access';
import type {
  Audit,
  AuthConfig,
  Board,
  CreateDemoLinkBody,
  CreatedDemoLink,
  Credentials,
  DemoLinks,
  DemoScopeView,
  EnvResponse,
  HomeResponse,
  Jobs,
  LegacyAsks,
  LiveEvent,
  Me,
  Notifications,
  PoolHolds,
  Pools,
  ReleaseVersion,
  Repo,
  RepoDispatch,
  Routing,
  RoutingEfforts,
  RoutingLayers,
  Setting,
  SettingKey,
  Settings,
  TaskActionBody,
  TaskDetail,
  UpdateCredentialsBody,
  UpdateDemoDefaultBody,
  UpdatedRepoDispatch,
  UpdatedRouteEffort,
  UpdateRepoDispatchBody,
  UpdateRouteEffortBody,
  UpdateSettingBody,
} from './types';

export type LiveStatus = 'connecting' | 'open' | 'down';

export interface FleetApi {
  /** 数据来自哪里：真后端、假数据，还是演示版（假数据 + 可见范围）。界面上要写明。 */
  readonly source: 'http' | 'mock' | 'demo';
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
  /** 开、关一个项目的「让 AI 接活」（写操作记录）；本来就是那个状态时 changed=false。没有这个项目 404。演示版只读：直接拒。 */
  updateRepoDispatch(repoId: string, body: UpdateRepoDispatchBody): Promise<UpdatedRepoDispatch>;
  /** 新主页（/）的一屏三块 + 持续状态条（#589）。 */
  home(): Promise<HomeResponse>;
  /**
   * 环境页（#820 片 1）：这一台环境现在怎样，一项一个「查成了 / 没查成 + 原因」。
   * 只读、不跨环境：读的是本后端自己库里的现成读法（和主页、额度页、/healthz 同一份）。
   */
  env(): Promise<EnvResponse>;
  board(repoId: string): Promise<Board>;
  task(taskId: string): Promise<TaskDetail>;
  taskAction(taskId: string, body: TaskActionBody): Promise<void>;
  /** 旧会话留下的、还没处理的追问（通知中心只读展示，#928）。 */
  legacyAsks(): Promise<LegacyAsks>;
  /** 把一条旧追问标成已处理（落库、进操作记录）；没有「回答」：新流程没有收追问回答的地方。 */
  closeAsk(askId: string): Promise<void>;
  routing(): Promise<Routing>;
  /** 路由两层每一层现在活着吗（#574）：用途 → 模型 → 路由，读的时候现算。 */
  routingLayers(): Promise<RoutingLayers>;
  /** 每个模型下每条路由起会话的思考档位（#470）。 */
  routingEfforts(): Promise<RoutingEfforts>;
  /** 改一条路由的思考档位：effort 写 null = 回到没配（默认档）；expected 是改之前看到的，对不上 409。 */
  updateRouteEffort(
    modelId: string,
    routeId: string,
    body: UpdateRouteEffortBody,
  ): Promise<UpdatedRouteEffort>;
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
  /** /changelog 页「发布 v<N>」的版本号（#725）：后端现读 GitHub 里程碑，和 pnpm publish:pr 同一份判法。 */
  releaseVersion(): Promise<ReleaseVersion>;
  /** 演示链接：发、作废、默认范围（设计文档第十四节）。只有正式驾驶舱用。 */
  demoLinks(): Promise<DemoLinks>;
  createDemoLink(body: CreateDemoLinkBody): Promise<CreatedDemoLink>;
  revokeDemoLink(linkId: string): Promise<void>;
  updateDemoDefault(body: UpdateDemoDefaultBody): Promise<DemoScopeView>;
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
  board: (repoId: string) => ['board', repoId] as const,
  task: (taskId: string) => ['task', taskId] as const,
  legacyAsks: ['legacy-asks'] as const,
  routing: ['routing'] as const,
  routingLayers: ['routing-layers'] as const,
  routingEfforts: ['routing-efforts'] as const,
  pools: ['pools'] as const,
  poolHolds: ['pool-holds'] as const,
  jobs: ['jobs'] as const,
  notifications: (status: 'open' | 'all') => ['notifications', status] as const,
  audit: (target: string) => ['audit', target] as const,
  settings: ['settings'] as const,
  releaseVersion: ['release-version'] as const,
  demoLinks: ['demo-links'] as const,
  env: ['env'] as const,
  home: ['home'] as const,
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

export function useTaskDetail(taskId: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: keys.task(taskId ?? ''),
    queryFn: () => api.task(taskId ?? ''),
    enabled: Boolean(taskId),
  });
}

/** 路由的在线状态由探针写、不推送，所以每分钟重拉一次。 */
export function useRouting({ enabled = true }: { enabled?: boolean } = {}) {
  const api = useApi();
  return useQuery({ queryKey: keys.routing, queryFn: () => api.routing(), refetchInterval: 60_000, enabled });
}

/**
 * 路由两层每一层现在活着吗（#574）。活不活由探针、额度、禁令现算：探针的结论不推送，所以和 useRouting 一样每分钟重拉；
 * 额度、渠道变了另由推送叫它重拉（下面 TABLE_KEYS）。enabled 为假时不读（比如换模型的对话框没打开）。
 */
export function useRoutingLayers({ enabled = true }: { enabled?: boolean } = {}) {
  const api = useApi();
  return useQuery({
    queryKey: keys.routingLayers,
    queryFn: () => api.routingLayers(),
    refetchInterval: 60_000,
    enabled,
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
    enabled: canSee('schedules'),
  });
}

export function useNotifications(status: 'open' | 'all' = 'open') {
  const api = useApi();
  return useQuery({
    queryKey: keys.notifications(status),
    queryFn: () => api.notifications({ status, limit: 200 }),
    enabled: canSee('notifications'),
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
    enabled: canSee('audit'),
  });
}

export function useSettings() {
  const api = useApi();
  return useQuery({ queryKey: keys.settings, queryFn: () => api.settings(), enabled: canSee('settings') });
}

export function useDemoLinks() {
  const api = useApi();
  return useQuery({ queryKey: keys.demoLinks, queryFn: () => api.demoLinks() });
}

/**
 * /changelog 页「发布 v<N>」的版本号：后端现读 GitHub 里程碑（不在推送名单里）。页面打开时读一次，点「发布」时再核一次
 * （changelog.tsx 调 refetch），不靠定时重拉。
 */
export function useReleaseVersion() {
  const api = useApi();
  return useQuery({ queryKey: keys.releaseVersion, queryFn: () => api.releaseVersion() });
}

/**
 * 环境页的读取（#820 片 1）：这一台环境现在怎样。顶栏徽标不用它（名字跟着 /me 带回），只有开着环境页时才拉。
 * 只读、不跨环境。演示版没有这一页（导航不给 module、路由表也不放），所以这里只在正式驾驶舱里取；
 * 每分钟重拉一次——健康、在跑的会话这些没有实时推送。
 */
export function useEnv({ enabled = true }: { enabled?: boolean } = {}) {
  const api = useApi();
  return useQuery({
    queryKey: keys.env,
    queryFn: () => api.env(),
    refetchInterval: 60_000,
    enabled: enabled && !isDemo(),
  });
}

/**
 * 新主页（/）的聚合读取：一屏三块（要你拍的 / 在跑的 / 做完的）+ 持续状态条。
 * 后端不发网址（和 alert-work 一个规矩）：done 的跳转链接这里按品牌拼好再给卡片。
 */
export function useHome(): { data: HomeState } {
  const api = useApi();
  const query = useQuery({ queryKey: keys.home, queryFn: () => api.home() });
  if (query.isPending) return { data: { status: 'loading' } };
  if (query.error)
    return { data: { status: 'error', error: query.error, retry: () => void query.refetch() } };
  const data = query.data;
  return {
    data: {
      status: 'data',
      data: {
        decisions: data.decisions,
        running: data.running,
        done: data.done.map((d) => {
          const cut = d.repo.indexOf('/');
          const repo = { owner: d.repo.slice(0, cut), name: d.repo.slice(cut + 1) };
          return { ...d, link: brand.repoLink(repo, 'pull', d.prNumber) };
        }),
        health: data.health,
        flow: data.flow,
      },
    },
  };
}

// ---------- 写 ----------

/** 发链接、作废、改默认范围：做完都重拉列表，操作记录里也多一条。 */
function useDemoMutation<V, R>(fn: (api: FleetApi, v: V) => Promise<R>) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: V) => fn(api, v),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: keys.demoLinks });
      qc.invalidateQueries({ queryKey: ['audit'] });
    },
  });
}

export const useCreateDemoLink = () =>
  useDemoMutation((api, body: CreateDemoLinkBody) => api.createDemoLink(body));
export const useRevokeDemoLink = () => useDemoMutation((api, id: string) => api.revokeDemoLink(id));
export const useUpdateDemoDefault = () =>
  useDemoMutation((api, body: UpdateDemoDefaultBody) => api.updateDemoDefault(body));

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

/** 旧会话留下的、还没处理的追问（通知中心用）。 */
export function useLegacyAsks() {
  const api = useApi();
  return useQuery({ queryKey: keys.legacyAsks, queryFn: () => api.legacyAsks() });
}

export function useCloseAsk() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (askId: string) => api.closeAsk(askId),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: keys.legacyAsks });
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

export function useUpdateSetting() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, body }: { key: SettingKey; body: UpdateSettingBody }) => api.updateSetting(key, body),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: keys.settings });
      qc.invalidateQueries({ queryKey: keys.poolHolds });
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
  tasks: [['board'], ['task'], keys.home],
  subtasks: [['board'], ['task']],
  session_runs: [['board'], ['task'], ['pools'], keys.home],
  // 三段流水（scope / manual / verify）：主页的流水线图和任务详情的流水都读它
  runs: [keys.home, ['task']],
  progress_events: [['board'], ['task']],
  asks: [['board'], ['task'], ['legacy-asks']],
  // approvals 还没有专门的页面查询键；按它挂在任务 / 子任务上，先失效这两处，主页「要你拍的」也跟着重拉。
  approvals: [['board'], ['task'], keys.home],
  // 池本身改了（pools 的触发器，0002）也报成 quota_windows，所以 pools 不单列。
  quota_windows: [['pools'], ['routing-layers'], keys.home],
  channels: [['routing'], ['pools'], ['routing-layers'], keys.home],
  notifications: [['notifications'], keys.home],
  audit_log: [['audit']],
  settings: [['settings']],
  // 别的环境推来的快照：看板还没有读它的页面（环境切换器那一片接上 ['nodes']），先不作废任何查询。
  node_reports: [],
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
