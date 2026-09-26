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
import { canSee, canSeeDetail } from '../demo/access';
import type {
  Audit,
  AuthConfig,
  Board,
  CreateDemoLinkBody,
  CreatedDemoLink,
  DemoLinks,
  DemoScopeView,
  Jobs,
  LiveEvent,
  Me,
  Notifications,
  Pools,
  Repo,
  Routing,
  RunSteps,
  Setting,
  SettingKey,
  Settings,
  StageKind,
  StagePolicy,
  TaskActionBody,
  TaskDetail,
  Timeline,
  UpdateChannelBody,
  UpdateDemoDefaultBody,
  UpdateSettingBody,
  UpdateStagePolicyBody,
} from './types';

export type LiveStatus = 'connecting' | 'open' | 'down';

export interface FleetApi {
  /** 数据来自哪里：真后端、假数据，还是演示版（假数据 + 可见范围）。界面上要写明。 */
  readonly source: 'http' | 'mock' | 'demo';
  authConfig(): Promise<AuthConfig>;
  devLogin(userId: string): Promise<Me>;
  feishuAccess(code: string): Promise<Me>;
  logout(): Promise<void>;
  me(): Promise<Me>;
  repos(): Promise<{ repos: Repo[] }>;
  board(repoId: string): Promise<Board>;
  task(taskId: string): Promise<TaskDetail>;
  timeline(taskId: string, page?: { cursor?: string | undefined; limit?: number }): Promise<Timeline>;
  runSteps(runId: string): Promise<RunSteps>;
  taskAction(taskId: string, body: TaskActionBody): Promise<void>;
  answerAsk(askId: string, answer: string): Promise<void>;
  routing(): Promise<Routing>;
  updateStagePolicy(stage: StageKind, body: UpdateStagePolicyBody): Promise<StagePolicy>;
  updateChannel(channelId: string, body: UpdateChannelBody): Promise<void>;
  pools(): Promise<Pools>;
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
  repos: ['repos'] as const,
  board: (repoId: string) => ['board', repoId] as const,
  task: (taskId: string) => ['task', taskId] as const,
  timeline: (taskId: string) => ['timeline', taskId] as const,
  runSteps: (runId: string) => ['run-steps', runId] as const,
  routing: ['routing'] as const,
  pools: ['pools'] as const,
  jobs: ['jobs'] as const,
  notifications: (status: 'open' | 'all') => ['notifications', status] as const,
  audit: (target: string) => ['audit', target] as const,
  settings: ['settings'] as const,
  demoLinks: ['demo-links'] as const,
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

export function useRepos() {
  const api = useApi();
  return useQuery({ queryKey: keys.repos, queryFn: () => api.repos(), staleTime: 60_000 });
}

export function useBoard(repoId: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: keys.board(repoId ?? ''),
    queryFn: () => api.board(repoId ?? ''),
    enabled: Boolean(repoId),
    placeholderData: (prev) => prev,
  });
}

/**
 * 全部仓的看板（总览、任务清单、⌘K 用）。后端没有「全部任务」接口，按仓各拉一份。
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

/** 时间线按新到旧分页；fetchNextPage 往前翻更早的。 */
export function useTimeline(taskId: string | undefined) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: keys.timeline(taskId ?? ''),
    queryFn: ({ pageParam }) => api.timeline(taskId ?? '', { cursor: pageParam, limit: 100 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    // 演示版细节不到「过程」这一级就不读（页面上另说「没开放」）。
    enabled: Boolean(taskId) && canSeeDetail('process'),
  });
}

export function useRunSteps(runId: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: keys.runSteps(runId ?? ''),
    queryFn: () => api.runSteps(runId ?? ''),
    enabled: Boolean(runId) && canSeeDetail('process'),
  });
}

/** 路由的在线状态由探针写、不推送，所以每分钟重拉一次。enabled 为假时不读（比如换模型的对话框没打开）。 */
export function useRouting({ enabled = true }: { enabled?: boolean } = {}) {
  const api = useApi();
  return useQuery({ queryKey: keys.routing, queryFn: () => api.routing(), refetchInterval: 60_000, enabled });
}

export function usePools({ enabled = true }: { enabled?: boolean } = {}) {
  const api = useApi();
  return useQuery({ queryKey: keys.pools, queryFn: () => api.pools(), enabled });
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
    // 调度台的「最近改动」也读它（演示版只开调度台时只给改路由顺序的那几条）。
    enabled: canSee('audit') || canSee('dispatch'),
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
      qc.invalidateQueries({ queryKey: keys.timeline(taskId) });
    },
  });
}

export function useAnswerAsk() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ askId, answer }: { askId: string; answer: string; taskId: string }) =>
      api.answerAsk(askId, answer),
    onSettled: (_d, _e, { taskId }) => {
      qc.invalidateQueries({ queryKey: keys.task(taskId) });
      qc.invalidateQueries({ queryKey: ['board'] });
      qc.invalidateQueries({ queryKey: keys.timeline(taskId) });
    },
  });
}

/** 改一个阶段的路由：先改缓存让拖动跟手；后端说「别人刚改过」（409）就回滚并重拉。 */
export function useUpdateStagePolicy() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ stage, body }: { stage: StageKind; body: UpdateStagePolicyBody }) =>
      api.updateStagePolicy(stage, body),
    onMutate: async ({ stage, body }) => {
      await qc.cancelQueries({ queryKey: keys.routing });
      const prev = qc.getQueryData<Routing>(keys.routing);
      if (prev) {
        qc.setQueryData<Routing>(keys.routing, {
          ...prev,
          stages: prev.stages.map((s) =>
            s.stage === stage ? { stage, routeIds: body.routeIds, pinned: body.pinned } : s,
          ),
        });
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(keys.routing, ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: keys.routing });
      qc.invalidateQueries({ queryKey: ['audit'] });
    },
  });
}

export function useUpdateChannel() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ channelId, body }: { channelId: string; body: UpdateChannelBody }) =>
      api.updateChannel(channelId, body),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: keys.routing });
      qc.invalidateQueries({ queryKey: keys.pools });
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

export function useUpdateSetting() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, body }: { key: SettingKey; body: UpdateSettingBody }) => api.updateSetting(key, body),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.settings }),
  });
}

// ---------- 实时 ----------

/**
 * 推送只说「哪张表的哪一行变了」，前端按表名决定重拉什么。表名单在 shared/realtime.ts：
 * 名单里加了表而这里没写，tsc 当场报错。认不出的表一律全量重拉——宁可多拉一次，也不把「漏收」当成「没变化」。
 * 不在名单里的表（定时任务、路由、模型……）没有推送，对应页面靠定时重拉。
 */
const TABLE_KEYS: Record<RealtimeTable, readonly (readonly string[])[]> = {
  tasks: [['board'], ['task'], ['timeline']],
  subtasks: [['board'], ['task'], ['timeline']],
  session_runs: [['board'], ['task'], ['timeline'], ['run-steps'], ['pools']],
  progress_events: [['board'], ['task'], ['timeline'], ['run-steps']],
  asks: [['board'], ['task'], ['timeline']],
  // approvals 还没有专门的页面查询键；按它和 asks 一样挂在任务 / 子任务上，先失效这三处。
  approvals: [['board'], ['task'], ['timeline']],
  quota_windows: [['pools']],
  channels: [['routing'], ['pools']],
  stage_policies: [['routing']],
  notifications: [['notifications']],
  audit_log: [['audit']],
  settings: [['settings']],
};

function isRealtimeTable(table: string): table is RealtimeTable {
  return (REALTIME_TABLES as readonly string[]).includes(table);
}

export function applyLiveEvent(qc: QueryClient, e: LiveEvent) {
  applyLiveEvents(qc, [e]);
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
