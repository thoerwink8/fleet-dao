// 假后端：实现 FleetApi，数据放在内存里，带一个模拟器让盘面「活」起来。
// 每个返回都按 shared/web-api.ts 校验后才交出去（和真后端的 reply 一样），报错的 code 和白话也照真后端。
// 页面上的操作会真的改这里的状态并留下操作记录；刷新页面就回到初始盘面。

import type {
  DiskFootprintSchema,
  HomeResourcesSchema,
  HostAppSchema,
  SessionUsageSchema,
} from '@fleet-dao/shared';
import {
  AddPurposeModelRequest,
  AnswerNotificationRequest,
  AnswerNotificationResponse,
  AUTO_DISPATCH_DISABLE,
  AUTO_DISPATCH_ENABLE,
  AuditResponse,
  AuthConfigResponse,
  acceptPoolHoldsWrite,
  answerResolves,
  BoardResponse,
  CI_POLICY_SET,
  type CiPolicy,
  CliToolsResponseSchema,
  CredentialsResponse,
  DEFAULT_SESSION_EFFORT,
  DisconnectGitHubResponse,
  describeEngineMaster,
  ENGINE_MASTER_SETTING,
  EnvResponseSchema,
  engineMasterOf,
  FrancePreflightResponseSchema,
  FranceReleaseStateSchema,
  flowStages,
  foldRouteProbeRequests,
  founderOnlyDenial,
  GITHUB_INSTALL_REPO,
  GITHUB_OAUTH_DISCONNECT,
  GROOM_ACTION,
  GROOM_TARGET,
  GroomNowRequest,
  GroomNowResponse,
  type GroomRequestView,
  GroomStatusResponse,
  githubInstallLinks,
  groomQuota,
  HARD_BANS,
  HomeResponseSchema,
  type HostId,
  hardBanFor,
  ImportableReposResponse,
  ImportRepoRequest,
  ImportRepoResponse,
  InstallAppRequest,
  InstallAppResponse,
  JobsResponse,
  judgeGroomRequest,
  ManualModelRequest,
  ManualModelResponse,
  MeResponse,
  MovePurposeModelRequest,
  MovePurposeModelResponse,
  NodeDetailResponseSchema,
  NodesResponseSchema,
  NotificationsResponse,
  PASSWORD_MIN_LENGTH,
  POOL_HOLDS_SETTING,
  PoolHoldsResponse,
  PoolsResponse,
  type ProbeHistoryCell,
  PurposeMembershipResponse,
  poolFull,
  poolHoldsView,
  probeHistoryStrips,
  REPO_IMPORT_ADD,
  REPO_IMPORT_REMOVE,
  type RealtimeTable,
  ReleaseCardSchema,
  ReleasedCommitsSchema,
  ReleaseRecoverResponse,
  ReleaseRequestResponse,
  RemovePurposeModelRequest,
  RemoveRepoResponse,
  RepoCiPolicyResponse,
  RepoDispatchResponse,
  ReposResponse,
  ROUTE_PROBE_ACTION,
  ROUTE_PROBE_TARGET,
  ROUTING_PURPOSE_IDS,
  type Route,
  RouteProbeHistoryResponse,
  RouteProbeNowRequest,
  RouteProbeNowResponse,
  type RouteProbeResult,
  RouteProbeStatusResponse,
  RoutingEffortsResponse,
  RoutingLayersResponse,
  RoutingResponse,
  type RunOutcome,
  RunTranscriptResponse,
  readSegmentRun,
  revocationProblem,
  routeEffortChoices,
  routeEffortProblem,
  SETTING_SCHEMAS,
  type SessionEffort,
  type SessionRun,
  SetChannelEnabledRequest,
  SetChannelEnabledResponse,
  SetModelEnabledRequest,
  SetModelEnabledResponse,
  SetPurposeModelEffortRequest,
  type SettingKey,
  SettingsResponse,
  type StageKind,
  StageKindSchema,
  type Step,
  summarizeUsage,
  TaskActionRequest,
  TaskDetailResponse,
  TaskListResponse,
  taskFlow,
  taskListCost,
  taskListGroupOf,
  UpdateCredentialsRequest,
  UpdateModelRouteRequest,
  UpdateModelRouteResponse,
  UpdateRepoCiPolicyRequest,
  UpdateRepoCiPolicyResponse,
  UpdateRepoDispatchRequest,
  UpdateRepoDispatchResponse,
  UpdateRouteEffortRequest,
  UpdateRouteEffortResponse,
  UpdateSettingRequest,
  UpdateSettingResponse,
  UpdateTaskRoutePinRequest,
  UpdateTaskRoutePinResponse,
  windowAppliesTo,
} from '@fleet-dao/shared';
import type { z } from 'zod';
import { ApiError, type FleetApi } from '../client';
import type { AuditEntry, LiveEvent, Worktrees } from '../types';
import type { MLog, MockState, MSubtask, MTask } from './model';
import { createMockRequests, MOCK_PARTNER, type MockRequestsOptions, mockRequestsAs } from './requests';
import { createSeed, fakeAction, fakeUsage } from './seed';
import { LIVE_FIRST_REVEAL, LIVE_REVEAL_STEP, transcriptSeed } from './transcripts';
import { cleanupResultOf, mockLocalSessions, mockWorktrees, seedCleanups } from './worktrees';

export interface MockOptions {
  /** 是否开模拟器；测试里关掉，手动调 tick()。 */
  live?: boolean;
  tickMs?: number;
  /** 每次请求的假延迟（毫秒）。 */
  latencyMs?: number;
  now?: () => number;
  seed?: number;
  /** 这些段的会话内容读不到（503，演示「没读成」）；不给就都读得到。 */
  transcriptFail?: readonly string[];
  /** 给 ch-cursor 多加这么多条没用途在用的路由（演示一个渠道几百条）；不给就不加。 */
  manyRoutes?: number;
  /** 提需求的视角和接没接上（测试用；不给就看地址上的 ?mockAs=、?mockRequests=）。 */
  requests?: Pick<MockRequestsOptions, 'as' | 'mode'>;
}

export interface MockApi extends FleetApi {
  /** 推进一拍模拟。 */
  tick(): void;
  stop(): void;
  /** 测试用：直接看内部状态。 */
  state(): MockState;
}

/** 和真后端 views.ts 的 STAGE_WORDS 一个说法。 */
const STAGE_WORDS: Record<StageKind, string> = {
  triage: '分诊',
  spec: '写需求文档',
  plan: '写方案',
  execute: '写码',
  ui: '写界面',
  review: '审查',
  verify: '开 PR 前验证',
  research: '调研',
  judge: '判断',
  groom: '整理待办',
  'intake-chat': '提需求',
};
/** 假数据里一次做成的结果：开 1、补 2、建议关 1、贴要人拍 1，单号给页面链到 GitHub。 */
const MOCK_GROOM_OK_RESULT = {
  opened: [{ number: 1402, title: '把整理按钮接到设置页' }],
  amended: [1338, 1335],
  groomed: [1338],
  suggestedClose: [900],
  flagged: [901],
  rejected: [],
  summary: '补了两张老单，开了一张。',
};
const ACTION_WORDS = {
  pause: '暂停',
  resume: '继续',
  stop: '叫停',
  reroute: '换路由',
  redo: '重做',
} as const;
const STALE_MS = 30 * 60_000;
/** 路由两层里在它的模型下一开始关着的路由（照仓里默认骨架：中转那条 Opus 关着）；每个假后端各拷一份，页面上点开关改的是拷贝。 */
const MOCK_SWITCHED_OFF_AT_START = new Set(['r-rl-opus']);
const TERMINAL = new Set(['done', 'stopped', 'failed']);

/** 一层合起来（db 的 routing-liveness.ts layerLiveness）：有一条活就活；没有活、有不知道就不知道；全死或空就死。 */
function layerVerdict(children: readonly ('live' | 'dead' | 'unknown')[]): 'live' | 'dead' | 'unknown' {
  if (children.includes('live')) return 'live';
  if (children.includes('unknown')) return 'unknown';
  return 'dead';
}
const GENERIC_STEPS = ['读相关代码', '改代码', '写测试', '跑测试并开 PR'];

/** 可复现的随机数（mulberry32）。 */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isRunning(r: SessionRun): boolean {
  return Boolean(r.startedAt) && !r.endedAt;
}

function latestActive(runs: SessionRun[]): SessionRun | undefined {
  let best: SessionRun | undefined;
  for (const r of runs) {
    if (r.endedAt) continue;
    if (!best || (r.startedAt ?? r.queuedAt) > (best.startedAt ?? best.queuedAt)) best = r;
  }
  return best;
}

function page<T extends { id: string }>(
  items: T[],
  at: (x: T) => string,
  cursor: string | undefined,
  limit: number,
): { items: T[]; nextCursor?: string } {
  const sorted = [...items].sort((a, b) => at(b).localeCompare(at(a)) || b.id.localeCompare(a.id));
  let start = 0;
  if (cursor) {
    const sep = cursor.lastIndexOf('|');
    const cAt = cursor.slice(0, sep);
    const cId = cursor.slice(sep + 1);
    start = sorted.findIndex((x) => at(x) < cAt || (at(x) === cAt && x.id < cId));
    if (start === -1) start = sorted.length;
  }
  const slice = sorted.slice(start, start + limit);
  const last = slice[slice.length - 1];
  return last && start + limit < sorted.length
    ? { items: slice, nextCursor: `${at(last)}|${last.id}` }
    : { items: slice };
}

/**
 * 主页引擎那一格的演示：默认正常；地址上加 ?mockEngine=off / down / unknown 看另外三种（开发看样子用，真后端不读它）。
 * 认不出的值按正常算，不报错：它只影响假数据的样子。
 */
function mockEngine() {
  const v = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('mockEngine');
  switch (v) {
    case 'off':
      return {
        state: 'off' as const,
        detail: '这台机器按配置没开引擎',
      };
    case 'down':
      return { state: 'down' as const, detail: '任务队列上没有在拉活的引擎工人（没起来或卡住了）' };
    case 'unknown':
      return { state: 'unknown' as const, detail: '这台后端没有接引擎探针，没查成' };
    default:
      return { state: 'on' as const };
  }
}

/** 地址上写了 ?mockRoutes=many 就多造一批没用途在用的路由。 */
function mockRoutesMany(): boolean {
  return typeof location !== 'undefined' && new URLSearchParams(location.search).get('mockRoutes') === 'many';
}

/** 看板多机的假环境（wsl）这一次是哪种样子：见 nodes() 的说明；地址上没写就是刚报过（fresh）。 */
/**
 * 机器资源（#1973、#1985）的假数据换哪一种：?mockResources=tight（紧）/ unread（cgroup、/proc、statfs 都读不到）/
 * missing（老后端整块没给）/ old（老后端：有内存、CPU，没有磁盘、上线项目、按目录的占用）/ pending（按目录的还没测完第一回）。
 */
function mockResourcesMode(): 'ok' | 'tight' | 'unread' | 'missing' | 'old' | 'pending' {
  const v =
    typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('mockResources');
  return v === 'tight' || v === 'unread' || v === 'missing' || v === 'old' || v === 'pending' ? v : 'ok';
}

/** 同一个编号每次得到同一个 0–1 之间的数：假数据里每个会话的占用稳定，只在上面加一点随时间的晃动。 */
function seedOf(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (h % 1000) / 1000;
}

/**
 * 假后端的机器资源：形状和真后端（api/src/host-resources.ts）一样，数是编的，按时间轻轻晃动，推送每 5 秒来一回时看得出在动。
 * 第一个会话故意只有一次读数（没有 CPU），演示「CPU 采样中」。
 */
type HomeResources = z.infer<typeof HomeResourcesSchema>;

export function mockResources(runIds: readonly string[], at: Date): HomeResources | undefined {
  const mode = mockResourcesMode();
  if (mode === 'missing') return undefined;
  const t = at.getTime() / 1000;
  const wobble = (seed: number, amp: number) => Math.sin(t / 7 + seed * 6.28) * amp;
  if (mode === 'unread') {
    return {
      at: at.toISOString(),
      everyMs: MOCK_RESOURCES_EVERY_MS,
      memory: { state: 'unread', why: '读不到 /proc/meminfo（这台不是 Linux，或没有 /proc）' },
      cpu: { state: 'unread', why: '读不到 /proc/stat（这台不是 Linux，或没有 /proc）' },
      sessions: {
        state: 'unread',
        why: '这台没有 /sys/fs/cgroup/fleet.slice/fleet-agents.slice（不在法国机器上，或会话资源池没挂）',
      },
      disk: { state: 'unread', why: '/ 的 statfs 没读成：EACCES: permission denied' },
      apps: {
        state: 'unread',
        why: '这台没有 /sys/fs/cgroup/cgroup.controllers（不是 cgroup v2，或不是 Linux）',
      },
      footprint: mockFootprint(at, 'unread'),
    };
  }
  const tight = mode === 'tight';
  const totalMb = 11_980;
  const byRun: Record<string, z.infer<typeof SessionUsageSchema>> = {};
  runIds.forEach((id, i) => {
    const s = seedOf(id);
    const memoryMb = Math.round(220 + s * 900 + wobble(s, 60) + (tight ? 900 : 0));
    byRun[id] =
      i === 0
        ? { state: 'ok', memoryMb, memoryPeakMb: memoryMb + 40 }
        : {
            state: 'ok',
            memoryMb,
            memoryPeakMb: Math.round(memoryMb * 1.35),
            cpuPercent: Math.max(
              0,
              Math.round((8 + s * 70 + wobble(s + 0.3, 9) + (tight ? 60 : 0)) * 10) / 10,
            ),
          };
  });
  // 一个对不上单的会话（路由探针这类）：资源页把它归到「别的会话」
  byRun['probe-route-7f3a'] = { state: 'ok', memoryMb: 186, memoryPeakMb: 240, cpuPercent: 3.1 };
  // 法国真机上见过的（#1992）：会话收场了、scope 没回收，memory.current 是 0——不算在跑，页面写「空 scope」
  byRun['mirasim-liveness-01'] = {
    state: 'empty',
    why: '/sys/fs/cgroup/fleet.slice/fleet-agents.slice/fleet-agent-mirasim-liveness-01.scope 还在，但 memory.current 是 0：里面没有进程（会话已收场、scope 没回收），不算在跑',
  };
  const sessionsMb = Object.values(byRun).reduce((n, u) => n + (u.state === 'ok' ? u.memoryMb : 0), 0);
  const sessionsCpu = Object.values(byRun).reduce(
    (n, u) => n + (u.state === 'ok' && u.cpuPercent !== undefined ? u.cpuPercent : 0),
    0,
  );
  const usedMb = Math.min(totalMb - 200, 1_450 + sessionsMb);
  const cores = 4;
  // 和真后端一样：忙的核数和百分比出自同一个比例
  const percent = Math.min(100, Math.max(0, Math.round((tight ? 93 : 34) + wobble(0.5, 6))));
  const base: HomeResources = {
    at: at.toISOString(),
    everyMs: MOCK_RESOURCES_EVERY_MS,
    memory: { state: 'ok', totalMb, availableMb: totalMb - usedMb },
    cpu: {
      state: 'ok',
      percent,
      busyCores: Math.round((percent / 100) * cores * 10) / 10,
      cores,
      load1: Math.round(((tight ? 5.6 : 1.4) + wobble(0.2, 0.4)) * 100) / 100,
    },
    sessions: { state: 'ok', byRun },
  };
  if (mode === 'old') return base;
  const GIB = 1024 ** 3;
  const totalBytes = Math.round(193.7 * GIB);
  const usedBytes = Math.round((tight ? 181.4 : 61.8) * GIB);
  return {
    ...base,
    disk: {
      state: 'ok',
      path: '/',
      totalBytes,
      usedBytes,
      // 剩余不含给 root 预留的那 5%：已用 + 剩余比总量小一点，和真机一样
      availableBytes: Math.max(0, Math.round(totalBytes * 0.95) - usedBytes),
    },
    apps: { state: 'ok', items: mockApps(t, sessionsMb, sessionsCpu / 100, runIds.length + 1, tight) },
    footprint: mode === 'pending' ? mockFootprint(at, 'pending') : mockFootprint(at, tight ? 'tight' : 'ok'),
  };
}

type HostApp = z.infer<typeof HostAppSchema>;

/** 假的上线项目：和真后端的登记表（packages/api/src/vps-apps.ts）同样几项，数是编的。 */
function mockApps(
  t: number,
  sessionsMb: number,
  sessionsCores: number,
  sessions: number,
  tight: boolean,
): HostApp[] {
  const w = (seed: number, amp: number) => Math.sin(t / 9 + seed * 6.28) * amp;
  const cores = (base: number, seed: number) =>
    Math.max(0, Math.round((base + w(seed, base / 3)) * 100) / 100);
  return [
    {
      id: 'cockpit',
      name: '驾驶舱',
      place: '/srv/fleet-dao-releases/current（后端代码）',
      units: ['fleet-api.service'],
      diskNote: '代码在发布版本目录里，算在「发布版本」；静态页在香港那台',
      usage: { state: 'ok', running: 1, memoryMb: Math.round(214 + w(0.1, 12)), cpuCores: cores(0.06, 0.1) },
    },
    {
      id: 'engine',
      name: '引擎',
      place: '/var/lib/fleet-dao/engine',
      units: ['fleet-engine.service'],
      usage: { state: 'ok', running: 1, memoryMb: Math.round(388 + w(0.2, 20)), cpuCores: cores(0.12, 0.2) },
    },
    {
      id: 'temporal',
      name: 'Temporal',
      place: '/opt/fleet-dao/temporal（程序）',
      units: ['fleet-temporal.service'],
      diskNote: '数据存在数据库里（temporal、temporal_visibility 两个库，算在「数据库」）',
      usage: { state: 'ok', running: 1, memoryMb: Math.round(296 + w(0.3, 10)), cpuCores: cores(0.09, 0.3) },
    },
    {
      id: 'postgres',
      name: '数据库',
      place: '/var/lib/postgresql/16/main（PostgreSQL 16）',
      units: ['postgresql@16-main.service'],
      usage: { state: 'ok', running: 1, memoryMb: Math.round(342 + w(0.4, 30)), cpuCores: cores(0.05, 0.4) },
    },
    {
      id: 'sessions',
      name: 'AI 会话',
      place: '/var/lib/fleet-work（工作树）',
      units: ['fleet-agents.slice'],
      usage: {
        state: 'ok',
        running: Math.max(1, sessions),
        memoryMb: sessionsMb,
        memoryMaxMb: 10_664,
        cpuCores: Math.round(sessionsCores * 100) / 100,
      },
    },
    {
      id: 'mirasim',
      name: '会话用户的 Mirasim',
      place: '/home/fleet-agent-carpool/.mirasim',
      units: ['fleet-mirasim-session.service', 'fleet-mirasim-liveness.service'],
      diskNote: '在会话用户家里，算在「AI 会话」',
      usage: tight
        ? {
            state: 'unread',
            why: '/sys/fs/cgroup/system.slice/fleet-mirasim-session.service/memory.current 的内容认不出（前 80 字节）："abc"',
          }
        : { state: 'ok', running: 1, memoryMb: Math.round(165 + w(0.5, 8)), memoryMaxMb: 4096 },
    },
    {
      id: 'release',
      name: '自动发布',
      place: '/usr/local/lib/fleet-dao',
      units: ['fleet-auto-release.service', 'fleet-release-request.service', 'fleet-cli-upgrade.service'],
      usage: { state: 'idle' },
    },
    {
      id: 'releases',
      name: '发布版本',
      place: '/srv/fleet-dao-releases',
      units: [],
      usage: { state: 'idle', why: '这一项没有进程，只占磁盘' },
    },
    {
      id: 'self-proxy',
      name: 'self-proxy',
      place: '不归本仓管（README「两台机器」）',
      units: ['self-proxy-direct.service', 'self-proxy-exit.service'],
      external: true,
      diskNote: '不归本仓管，没登记目录',
      usage: { state: 'ok', running: 2, memoryMb: Math.round(58 + w(0.6, 3)), cpuCores: cores(0.02, 0.6) },
    },
    {
      id: 'miraquota',
      name: 'MiraQuota 同步',
      place: '不归本仓管（等 miraquota-win#3 发版后停）',
      units: ['miraquota-sync.service'],
      external: true,
      diskNote: '不归本仓管，没登记目录',
      usage: { state: 'ok', running: 1, memoryMb: Math.round(71 + w(0.7, 4)), cpuCores: cores(0.01, 0.7) },
    },
  ];
}

type DiskFootprint = z.infer<typeof DiskFootprintSchema>;

/** 假的按目录占用：会话工作树有几棵读不到（700、归会话用户）演示「不全」；会话用户的家后端看不见演示「没读到」。 */
function mockFootprint(at: Date, mode: 'ok' | 'tight' | 'unread' | 'pending'): DiskFootprint {
  if (mode === 'pending') {
    return { state: 'pending', why: '正在测第一回（要遍历文件，测完就有；之后每 10 分钟测一次）' };
  }
  const GIB = 1024 ** 3;
  const MIB = 1024 ** 2;
  const g = (n: number) => Math.round(n * GIB);
  const big = mode === 'tight' ? 4 : 1;
  const ok = (bytes: number, unreadTrees = 0, unreadSample?: string) => ({
    state: 'ok' as const,
    bytes,
    unreadTrees,
    ...(unreadSample ? { unreadSample } : {}),
  });
  return {
    state: 'ok',
    measuredAt: new Date(at.getTime() - 4 * 60_000).toISOString(),
    everyMs: 10 * 60_000,
    tookMs: 18_400,
    dirs: [
      { path: '/srv/fleet-dao-releases', appId: 'releases', appName: '发布版本', size: ok(g(6.4 * big)) },
      { path: '/srv/fleet-dao', appId: 'releases', appName: '发布版本', size: ok(g(1.2)) },
      {
        path: '/var/lib/fleet-work',
        appId: 'sessions',
        appName: 'AI 会话',
        size:
          mode === 'unread'
            ? { state: 'unread', why: '读不了 /var/lib/fleet-work：EACCES: permission denied' }
            : ok(
                g(0.3),
                7,
                '/var/lib/fleet-work/thoerwink8_fleet-dao/fleet/1979-t3a9c0d1：EACCES: permission denied',
              ),
      },
      { path: '/var/lib/fleet-sessions', appId: 'sessions', appName: 'AI 会话', size: ok(312 * MIB) },
      {
        path: '/home/fleet-agent-carpool',
        appId: 'sessions',
        appName: 'AI 会话',
        size: {
          state: 'unread',
          why: '读不了 /home/fleet-agent-carpool：EACCES: permission denied（后端开了 ProtectHome，看不见 /home）',
        },
      },
      { path: '/var/lib/fleet-dao/engine', appId: 'engine', appName: '引擎', size: ok(g(2.7 * big)) },
      { path: '/var/lib/fleet-dao/github', appId: 'engine', appName: '引擎', size: ok(g(3.9)) },
      { path: '/var/log/fleet-dao', appId: 'engine', appName: '引擎', size: ok(48 * MIB) },
      { path: '/opt/fleet-dao/temporal', appId: 'temporal', appName: 'Temporal', size: ok(412 * MIB) },
      { path: '/usr/local/lib/fleet-dao', appId: 'release', appName: '自动发布', size: ok(2 * MIB) },
    ],
    databases:
      mode === 'unread'
        ? { state: 'unread', why: '这台后端没连数据库（开发用的内存版）' }
        : {
            state: 'ok',
            items: [
              {
                name: 'fleet',
                appId: 'postgres',
                appName: '数据库',
                size: { state: 'ok', bytes: g(1.8 * big) },
              },
              {
                name: 'temporal',
                appId: 'postgres',
                appName: '数据库',
                size: { state: 'ok', bytes: g(3.1) },
              },
              {
                name: 'temporal_visibility',
                appId: 'postgres',
                appName: '数据库',
                size: { state: 'ok', bytes: 640 * MIB },
              },
            ],
          },
  };
}

/** 假后端推机器资源的间隔，和真后端（RESOURCE_SAMPLE_MS）一样。 */
const MOCK_RESOURCES_EVERY_MS = 5_000;

function mockNodeMode(): 'fresh' | 'stale' | 'gone' | 'never' | 'off' {
  const v = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('mockNode');
  return v === 'stale' || v === 'gone' || v === 'never' || v === 'off' ? v : 'fresh';
}

/** 假环境（wsl）离上次上报多久：失联 12 分钟 / 失联 5 天 2 小时 / 刚报过。 */
function mockNodeAgo(mode: ReturnType<typeof mockNodeMode>): number {
  return mode === 'stale' ? 12 * 60_000 : mode === 'gone' ? (5 * 24 + 2) * 60 * 60_000 : 40_000;
}

/** 新先后必须是现在这一串的重排（多了、少了、重复都不算）。 */
function notPermutation(current: readonly string[], order: readonly string[]): boolean {
  if (order.length !== current.length) return true;
  const seen = new Set<string>();
  for (const id of order) {
    if (!current.includes(id) || seen.has(id)) return true;
    seen.add(id);
  }
  return false;
}

/** 整段拖到新先后：没有 404、看到的对不上 409、不是重排 422。顺序没变也返回，调用方自己决定记不记操作记录。 */
function mockReorder(
  list: readonly string[],
  key: string,
  order: readonly string[],
  expected: readonly string[],
  where: string,
  what: string,
  notFoundCode: string,
): { before: string[]; after: string[] } {
  if (!list.includes(key)) throw new ApiError(404, notFoundCode, `${where}下没有${what} ${key}`);
  if (list.length !== expected.length || list.some((x, i) => x !== expected[i])) {
    throw new ApiError(409, 'conflict', '先后刚被别人改过，刷新后再改', { current: [...list] });
  }
  if (notPermutation(list, order)) throw new ApiError(422, 'order_invalid', '新先后必须是现在这一串的重排');
  return { before: [...list], after: [...order] };
}

function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(b);
  return a.every((id) => seen.has(id));
}

/** 在一串编号里把 key 上移 / 下移一位（真后端 db 的 routing-order.ts 的假数据版）：看到的先后对不上 409、已在头尾 422、没有 404。 */
function mockMove(
  list: readonly string[],
  key: string,
  body: { direction: 'up' | 'down'; expected: readonly string[] },
  where: string,
  what: string,
  notFoundCode: string,
): { before: string[]; after: string[] } {
  const index = list.indexOf(key);
  if (index < 0) throw new ApiError(404, notFoundCode, `${where}下没有${what} ${key}`);
  if (list.length !== body.expected.length || list.some((x, i) => x !== body.expected[i])) {
    throw new ApiError(409, 'conflict', '先后刚被别人改过，刷新后再改', { current: [...list] });
  }
  const other = body.direction === 'up' ? index - 1 : index + 1;
  if (other < 0 || other >= list.length) {
    const edge = body.direction === 'up' ? '上' : '下';
    throw new ApiError(422, 'already_at_edge', `${what} ${key} 已经在${where}的最${edge}面，没处${edge}移了`);
  }
  const after = [...list];
  after[index] = list[other] as string;
  after[other] = key;
  return { before: [...list], after };
}

function durationMsFromDetail(detail: string | undefined): number | null {
  const matched = detail?.match(/用时\s*(\d+(?:\.\d+)?)\s*秒/);
  if (!matched?.[1]) return null;
  const ms = Math.round(Number(matched[1]) * 1000);
  if (!Number.isFinite(ms) || ms < 0 || ms > 2_147_483_647) return null;
  return ms;
}

// 身份题那五项；kind / trigger 没写就是不给（#1798 片 6），不拿 null 顶老行。
const NO_CHECK = {
  checkQuestion: null,
  checkExpected: null,
  checkAnswer: null,
  checkPassed: null,
  selfIdentity: null,
} as const;

const MOCK_CHECK_PASSED = {
  checkQuestion: '现任日本首相是谁？答案只写人名。',
  checkExpected: '高市早苗/Takaichi',
  checkOldAnswer: '石破茂/Ishiba/岸田文雄',
  checkAnswer: '高市早苗',
  checkPassed: true,
  selfIdentity: 'gpt-6-sol',
  kind: 'identity' as const,
};

const MOCK_CHECK_MISMATCH = {
  ...MOCK_CHECK_PASSED,
  checkAnswer: '石破茂',
  checkPassed: false,
  selfIdentity: 'GPT-4 级别的通用助手',
};

const MOCK_IDENTITY_REQUEST =
  '第一行只写 pong\n第二行写「答案：」加这道题的答案\n第三行写「模型：」加你的型号\n题目：现任日本首相是谁？答案只写人名。';

/** 假数据里每条路由的最近一次结论收成一条探针历史，页面开发时格子不是空的。 */
function mockProbeHistory(
  routes: readonly {
    id: string;
    channelId: string;
    probe?: { state: string; at: string; detail?: string };
    probeKind?: 'ping' | 'identity';
  }[],
) {
  const cells: ProbeHistoryCell[] = [];
  for (const route of routes) {
    const probe = route.probe;
    if (!probe) continue;
    const result = probe.state === 'ok' ? 'passed' : probe.state === 'failed' ? 'failed' : 'not_probed';
    const reason = probe.detail?.trim() ? probe.detail : '（假数据没写原因）';
    // 身份题的路由：通过的记「对上新答案」，不通的（r-cursor-hi）记「说中了旧答案」
    const identity = route.probeKind === 'identity' && result !== 'not_probed';
    const mismatch = identity && result === 'failed';
    cells.push({
      id: cells.length + 1,
      routeId: route.id,
      channelId: route.channelId,
      probedAt: probe.at,
      result,
      durationMs: result === 'not_probed' ? null : durationMsFromDetail(probe.detail),
      failureReason: result === 'passed' ? null : reason,
      requestText: result === 'not_probed' ? null : identity ? MOCK_IDENTITY_REQUEST : '只回一个词：pong',
      responseText: mismatch
        ? 'pong\n答案：石破茂\n模型：GPT-4 级别的通用助手'
        : identity
          ? 'pong\n答案：高市早苗\n模型：gpt-6-sol'
          : result === 'passed'
            ? 'pong'
            : result === 'failed'
              ? reason
              : null,
      ...(mismatch
        ? MOCK_CHECK_MISMATCH
        : identity
          ? MOCK_CHECK_PASSED
          : result !== 'not_probed'
            ? { ...NO_CHECK, kind: 'ping' as const }
            : NO_CHECK),
      trigger: 'scheduled' as const,
    });
  }
  // 中转站（ch-relay）补几次更早的探测，页面上能看到每种结论：疑似换模型、不通、没探、通过
  const relay = routes.find((r) => r.id === 'r-rl-opus' && r.probe);
  if (relay?.probe) {
    const at = (minutesAgo: number) =>
      new Date(Date.parse(relay.probe?.at ?? '') - minutesAgo * 60_000).toISOString();
    const base = { routeId: relay.id, channelId: relay.channelId };
    cells.push(
      {
        ...base,
        id: cells.length + 1,
        probedAt: at(20),
        result: 'failed',
        durationMs: 8_400,
        failureReason: '疑似换成旧模型：题 现任日本首相是谁？，新答案应为 高市早苗，实答 石破茂',
        requestText: MOCK_IDENTITY_REQUEST,
        responseText: 'pong\n答案：石破茂\n模型：GPT-4 级别的通用助手',
        ...MOCK_CHECK_MISMATCH,
        trigger: 'dispatch',
      },
      {
        ...base,
        id: cells.length + 2,
        probedAt: at(35),
        result: 'failed',
        durationMs: null,
        failureReason: '连探两次都没通：503 容量满，上游没给原文\n（假数据）',
        requestText: '这是连通性测试。不要调用任何工具，不要解释，只回一个词：pong',
        responseText: '503 Service Unavailable\n{"error":{"type":"overloaded","message":"capacity full"}}',
        ...NO_CHECK,
        kind: 'ping',
        trigger: 'break',
      },
      {
        ...base,
        id: cells.length + 3,
        probedAt: at(50),
        result: 'not_probed',
        durationMs: null,
        failureReason: '这一轮没探：账号池整池暂停（假数据）',
        requestText: null,
        responseText: null,
        ...NO_CHECK,
        trigger: 'scheduled',
      },
      {
        ...base,
        id: cells.length + 4,
        probedAt: at(65),
        result: 'passed',
        durationMs: 12_100,
        failureReason: null,
        requestText: MOCK_IDENTITY_REQUEST,
        responseText: 'pong\n答案：高市早苗\n模型：gpt-6-sol',
        ...MOCK_CHECK_PASSED,
        trigger: 'scheduled',
      },
      {
        ...base,
        id: cells.length + 5,
        probedAt: at(80),
        result: 'passed',
        durationMs: 5_300,
        failureReason: null,
        requestText: '这是连通性测试。不要调用任何工具，不要解释，只回一个词：pong',
        responseText: 'pong',
        ...NO_CHECK,
        kind: 'ping',
        trigger: 'manual',
      },
      {
        // 算术题时代的老记录：没有种类、没有触发者，照原样显示，标「旧版降智题」
        ...base,
        id: cells.length + 6,
        probedAt: at(125),
        result: 'failed',
        durationMs: 9_900,
        failureReason: '疑似降智：题 17 乘 23 等于多少？只回数字。，应为 391，实答 381',
        requestText: '第一行只回 OK\n第二行：17 乘 23 等于多少？只回数字。',
        responseText: 'OK\n381',
        checkQuestion: '17 乘 23 等于多少？只回数字。',
        checkExpected: '391',
        checkAnswer: '381',
        checkPassed: false,
        selfIdentity: 'gpt-6-sol',
      },
    );
  }
  // Cursor 的疑似换模型路由：一小时前的身份题还是对的，现在说出了旧答案
  const hi = routes.find((r) => r.id === 'r-cursor-hi' && r.probe);
  if (hi?.probe) {
    cells.push({
      routeId: hi.id,
      channelId: hi.channelId,
      id: cells.length + 1,
      probedAt: new Date(Date.parse(hi.probe.at) - 60 * 60_000).toISOString(),
      result: 'passed',
      durationMs: 9_200,
      failureReason: null,
      requestText: MOCK_IDENTITY_REQUEST,
      responseText: 'pong\n答案：高市早苗\n模型：gpt-6-sol',
      ...MOCK_CHECK_PASSED,
      trigger: 'scheduled',
    });
  }
  return RouteProbeHistoryResponse.parse({ state: 'ok', ...probeHistoryStrips(cells) });
}

export function createMockApi(opts: MockOptions = {}): MockApi {
  const now = opts.now ?? (() => Date.now());
  const rand = rng(opts.seed ?? 20260925);
  const st = createSeed(now());
  // 一个渠道下几百条路由（线上 Cursor 订阅 256 条、213 条没用途在用）：测试给 manyRoutes，点验在地址上加 ?mockRoutes=many。公共种子不带，免得别的页的数对不上。
  const bulk = opts.manyRoutes ?? (mockRoutesMany() ? 213 : 0);
  for (let i = 1; i <= bulk; i++) {
    st.routes.push({
      id: `r-cursor-bulk-${String(i).padStart(3, '0')}`,
      channelId: 'ch-cursor',
      poolId: 'cursor-pro',
      modelId: 'cursor-auto',
      hostId: 'cursor-agent',
      alive: false,
      probe: {
        state: 'skipped',
        at: new Date(now() - 5 * 60_000).toISOString(),
        detail: '没有哪个阶段在用这条路由，不花额度去探',
      },
      probeTier: 'unused',
      probeFailStreak: 0,
    });
  }
  /** 会话内容（#1640）的演示数据；在跑的段每被读一次多放出几条。mockTranscriptFail 里的段读不到（演示「没读成」）。 */
  const transcripts = transcriptSeed((min) => new Date(now() + min * 60_000).toISOString());
  const revealed = new Map<string, number>();
  const mockTranscriptFail = new Set<string>(opts.transcriptFail ?? []);
  /** 引擎总开关那一格（设置 engine.master，#1086）：读设置里的值，和后端同一个读法（shared 的 engineMasterOf）。 */
  const mockMaster = () => {
    const row = st.settings.find((s) => s.key === ENGINE_MASTER_SETTING);
    const state = engineMasterOf(row);
    return {
      on: state.on,
      why: state.on ? ('set' as const) : state.why,
      ...(state.by === undefined ? {} : { by: state.by }),
      ...(state.at === undefined ? {} : { at: state.at }),
      detail: describeEngineMaster(state),
    };
  };
  const listeners = new Set<(e: LiveEvent) => void>();
  /** 最近一次读主页时在跑的流水编号：推送报机器资源时按它编各会话的占用。 */
  let liveRunIds: string[] = [];
  let counter = 0;
  /** 进合并队列的先后。 */
  const queuedAt = new Map<string, number>();
  /** 每条路由配的思考档位（#470）：没有就是没配。种子里一条 Grok 配了 medium，页面上能看到「配过」的样子。 */
  const mockEfforts = new Map<string, SessionEffort>([['r-grok', 'medium']]);
  /** 用途成员的版本和这一用途下另配的档（#1356）。没改过版本是 0，没另配不放进这张表。 */
  const purposeVersion = new Map<string, number>();
  const purposeEffort = new Map<string, SessionEffort>();
  /** 手工登记的模型串。名册接口只回个数，串本身记在这里，撤掉才从这里消失。 */
  const manualKeys = new Map<string, string[]>();
  const slotKey = (purpose: string, modelId: string) => `${purpose}\0${modelId}`;
  /** 在它的模型下关着的路由（母单 #1089 起页面能开关，所以是这个假后端自己的一份）。 */
  const switchedOff = new Set(MOCK_SWITCHED_OFF_AT_START);
  /** 每个项目「让 AI 接活」打开的时刻：没有就是关着。种子里 orbit 开着、另两个关着，页面上两种样子都能看到。 */
  const mockDispatch = new Map<string, string>([['r-orbit', new Date(now() - 3 * 86_400_000).toISOString()]]);
  /** 没写过的仓是强制。切换记录新的在前，最多留 5 条。 */
  const mockCiPolicy = new Map<string, CiPolicy>();
  const mockCiRecent = new Map<string, { at: string; actor: string; from: CiPolicy; to: CiPolicy }[]>();
  const ciModeOf = (repoId: string): CiPolicy => mockCiPolicy.get(repoId) ?? 'force';
  /** 「导入仓库」（#1989）的假数据：连着一份授权，几个仓覆盖个人/组织、已装/未装、已在驾驶舱几种样子。 */
  const mockImportAuth = {
    connected: true,
    login: 'thoerwink8',
    scopes: 'read:org repo',
    connectedAt: new Date(now() - 86_400_000).toISOString(),
  };
  /** 已在驾驶舱的仓：githubId → 驾驶舱里的仓编号。种子里 9003 已导入；导入、移出会改它，列表才跟着变。 */
  const mockImported = new Map<number, string>([[9003, st.repos[0]?.id ?? 'r-orbit']]);
  const mockImportRepos = () =>
    mockImportRepoSeed().map((r) => {
      const reposId = mockImported.get(r.githubId);
      return reposId ? { ...r, inCockpit: true, reposId } : { ...r, inCockpit: false };
    });
  const mockImportRepoSeed = () => [
    {
      githubId: 9001,
      owner: 'thoerwink8',
      name: 'widgets',
      fullName: 'thoerwink8/widgets',
      private: true,
      defaultBranch: 'main',
      ownerType: 'User' as const,
      viewerCanAdmin: true,
      archived: false,
      empty: false,
      agentInstalled: true,
      engineInstalled: true,
      fullyInstalled: true,
      inCockpit: false,
      canInstall: false,
    },
    {
      githubId: 9002,
      owner: 'thoerwink8',
      name: 'notes',
      fullName: 'thoerwink8/notes',
      private: false,
      defaultBranch: 'main',
      ownerType: 'User' as const,
      viewerCanAdmin: true,
      archived: false,
      empty: false,
      agentInstalled: false,
      engineInstalled: false,
      fullyInstalled: false,
      inCockpit: false,
      canInstall: true,
    },
    {
      githubId: 9003,
      owner: 'adfx-studio',
      name: 'daihuo-workbench',
      fullName: 'adfx-studio/daihuo-workbench',
      private: true,
      defaultBranch: 'main',
      ownerType: 'Organization' as const,
      viewerCanAdmin: true,
      archived: false,
      empty: false,
      agentInstalled: true,
      engineInstalled: false,
      fullyInstalled: false,
      inCockpit: true,
      canInstall: true,
    },
    {
      githubId: 9004,
      owner: 'some-org',
      name: 'shared-lib',
      fullName: 'some-org/shared-lib',
      private: false,
      defaultBranch: 'main',
      ownerType: 'Organization' as const,
      viewerCanAdmin: false,
      archived: false,
      empty: false,
      agentInstalled: false,
      engineInstalled: false,
      fullyInstalled: false,
      inCockpit: false,
      canInstall: false,
      installBlockedWhy: '要组织管理员先批准这个 App（你在这个组织里没有 admin）',
    },
  ];
  /**
   * 临时指挥官整理待办的记录（新的在前）。orbit 有一次做成、一次没做成，都在 24 小时内接手过，所以今日剩余 1/3。
   * 没有排队或在做的：按钮能点。点了以后插到最前。
   */
  const agoIso = (minutesAgo: number) => new Date(now() - minutesAgo * 60_000).toISOString();
  /** 一键清理工作树的记录（新的在前），见 mock/worktrees.ts。 */
  let mockCleanups: Worktrees['cleanups'] = seedCleanups(now());
  let mockGroom: GroomRequestView[] = [
    {
      requestId: 'groom-seed-ok',
      repo: 'acme/orbit',
      source: 'http',
      requestedAt: agoIso(90),
      by: 'u-lan',
      state: 'done',
      startedAt: agoIso(89),
      finishedAt: agoIso(50),
      result: MOCK_GROOM_OK_RESULT,
    },
    {
      requestId: 'groom-seed-fail',
      repo: 'acme/orbit',
      source: 'auto',
      requestedAt: agoIso(240),
      by: 'engine:intake',
      state: 'failed',
      startedAt: agoIso(239),
      finishedAt: agoIso(220),
      why: '选不到路由（用途 groom）：没有能用的路由',
      result: {
        opened: [],
        amended: [],
        groomed: [],
        suggestedClose: [],
        flagged: [],
        rejected: [],
        summary: '会话没起来。',
      },
    },
  ];

  /** 假数据里的账密（只在这个模拟器里存明文，真后端只存哈希）：没设过就是空的。 */
  const mockCreds: { username?: string; password?: string; changedAt?: string } = {};

  const iso = () => new Date(now()).toISOString();
  // 「发布到法国」按钮的假状态：默认能点；浏览器里 localStorage 的 mockRelease 写 blocked 就是接活单元没装的样子（截图用）
  // 点了「确认发布」之后：假的九步每 6 秒走一步，走完写一份发后体检（#2026）。localStorage 的 mockRelease 写 running /
  // done-bad 直接画「停在等收尾」「发完但体检没通过」（截图用）。
  const releaseMock: { startedAt: number | null; target: string | null; mode: string | null } = {
    startedAt: null,
    target: null,
    // 点了「重试」「恢复引擎开关」「撤掉暂停」之后盖掉 localStorage 的 mockRelease（卡住、没成、留着标记的演示态就过去了）
    mode: null,
  };
  const mockMode = () =>
    releaseMock.mode ?? (typeof localStorage !== 'undefined' ? localStorage.getItem('mockRelease') : null);
  const MOCK_STEP_MS = 6_000;
  const MOCK_PHASES = ['预检', '暂停本机', '暂停法国', '等收尾', '发版', '等部署', '验证', '恢复', '派清单'];
  const mockLast = () => {
    const mode = mockMode();
    // 卡住（等收尾超时）、没成（恢复那一步）的演示态：截图看「重试」「恢复引擎开关」（#2027）
    if (mode === 'stuck' || mode === 'restore-failed') {
      const phase = mode === 'stuck' ? 3 : 7;
      const started = now() - 35 * 60_000;
      return {
        state: mode === 'stuck' ? 'blocked' : 'failed',
        target: '提交 2005b2909c4f',
        at: iso(),
        why:
          mode === 'stuck'
            ? '等了 30 分钟，法国还有 2 个会话在跑（现场没动：引擎总开关已关、没发版；到驾驶舱点「重试」从这一步接着走）'
            : '恢复没成：发版已经发出去了，但发版前开着的引擎总开关没能开回：数据库连不上。到驾驶舱「法国」页发版卡点「恢复引擎开关」（或环境页点开、fleet-api engine on）',
        phase: `第 ${phase} 步「${MOCK_PHASES[phase]}」`,
        timeline: {
          phase,
          startedAt: new Date(started).toISOString(),
          steps: MOCK_PHASES.map((_, i) =>
            i <= phase ? new Date(started + i * 4 * 60_000).toISOString() : null,
          ),
          waiting: null,
          laggards: mode === 'stuck' ? ['会话 execute(1f3a9c2e)', '会话 verify(7b20d4aa)'] : [],
        },
        check: null,
      };
    }
    const fixed = mode === 'running' || mode === 'done-bad';
    const started = fixed ? now() - 4 * 60_000 : releaseMock.startedAt;
    if (started === null) return { state: 'none', target: null, at: null, why: null, phase: null };
    const target = releaseMock.target ?? '提交 2005b2909c4f';
    const elapsed = now() - started;
    const phase =
      mode === 'running' ? 3 : mode === 'done-bad' ? 8 : Math.min(8, Math.floor(elapsed / MOCK_STEP_MS));
    const done = mode === 'done-bad' || (!fixed && elapsed >= MOCK_PHASES.length * MOCK_STEP_MS);
    const stepMs = fixed ? 25_000 : MOCK_STEP_MS;
    const steps = MOCK_PHASES.map((_, i) =>
      i <= phase ? new Date(started + i * stepMs).toISOString() : null,
    );
    const check = done
      ? {
          ok: mode !== 'done-bad',
          items: [
            { name: '目标提交在用', ok: true, text: '法国在用的就是 2005b2909c4f（演示数据）' },
            { name: '/healthz', ok: true, text: '全好（演示数据）' },
            mode === 'done-bad'
              ? {
                  name: '没有新异常',
                  ok: false,
                  text: '发版后新出现 1 条卡住报警：引擎挂了（svc:fleet-engine:down）（演示数据）',
                }
              : { name: '没有新异常', ok: true, text: '比发版前没有新的卡住报警（演示数据）' },
            { name: '再跑一遍预检', ok: true, text: '已是最新、没有要发的（演示数据）' },
            { name: '引擎总开关和发版前一致', ok: true, text: '发版前开着，现在一样（演示数据）' },
            { name: '各仓接活开关没被动过', ok: true, text: '3 个仓和发版前一样（演示数据）' },
          ],
          at: iso(),
        }
      : null;
    return {
      state: done ? 'done' : 'running',
      target,
      at: iso(),
      why: null,
      phase: `第 ${phase} 步「${MOCK_PHASES[phase]}」`,
      timeline: {
        phase,
        startedAt: new Date(started).toISOString(),
        steps,
        waiting: done
          ? null
          : phase === 3
            ? '等法国在跑的 2 个会话收尾（execute(1f3a9c2e) verify(7b20d4aa)）（演示数据）'
            : null,
        laggards: [],
      },
      check,
    };
  };
  const mockReleaseAction = () => {
    const mode = mockMode();
    const blocked = mode === 'blocked';
    return {
      state: blocked ? 'blocked' : 'ready',
      reasons: blocked ? ['法国还没装发版接活单元（要在法国以管理员身份跑一次整套装机脚本）'] : [],
      installed: !blocked,
      last: mockLast(),
      // 三个按钮（#2027）：卡住给「重试」和「撤掉暂停」，没成在恢复给「恢复引擎开关」，只剩标记（paused）给「撤掉暂停」
      recover: {
        retry:
          mode === 'stuck'
            ? { sha: '2005b2909c4f8e0a1d3e5f7a9b1c3d5e7f9a1b3c', phase: '第 3 步「等收尾」' }
            : null,
        restore: mode === 'restore-failed' ? { target: '提交 2005b2909c4f' } : null,
        abort:
          mode === 'stuck'
            ? {
                outcome: 'reopen' as const,
                text: '还没动手发版：引擎总开关会开回暂停前的样子（开着），清掉暂停标记，这一趟记为撤销。',
              }
            : mode === 'paused'
              ? { outcome: 'clear_marker' as const, text: '只清掉留下来的暂停标记，引擎总开关不动。' }
              : null,
      },
    };
  };
  const nextId = (p: string) => `${p}-${++st.seq}`;
  const wait = () =>
    opts.latencyMs
      ? new Promise<void>((r) => setTimeout(r, (opts.latencyMs ?? 0) * (0.6 + rand() * 0.8)))
      : Promise.resolve();
  /** 提需求（#2062）：内存里一份需求、消息、每人的置顶和读到哪，判法和真后端同一份（shared 的 requestActions）。 */
  const mockRequests = createMockRequests({
    now,
    me: { id: st.me.user.id, name: st.me.user.displayName },
    repos: st.repos.map((r) => ({ id: r.id, slug: `${r.owner}/${r.name}` })),
    latency: wait,
    ...opts.requests,
  });
  // 换成合伙人的视角时，登录的人也是合伙人（页面按 /me 判「我」）
  if (mockRequestsAs(opts.requests?.as) === 'partner') {
    st.me = { ...st.me, user: { id: MOCK_PARTNER.id, displayName: MOCK_PARTNER.name, role: 'founder' } };
  }

  /** 只推 shared/realtime.ts 名单里的表：真后端也只推这些，假数据不多给。 */
  function emit(table: RealtimeTable, id: string) {
    for (const l of listeners) l({ type: 'change', table, id });
  }

  const meActor = () => ({ kind: 'user' as const, id: st.me.user.id, name: st.me.user.displayName });
  const purposeOr404 = (purposeParam: string): StageKind => {
    const purpose = StageKindSchema.safeParse(purposeParam);
    if (!purpose.success) throw new ApiError(404, 'purpose_not_found', `没有这个用途：${purposeParam}`);
    return purpose.data;
  };
  const assertPurposeVersion = (purpose: string, version: number) => {
    const current = purposeVersion.get(purpose) ?? 0;
    if (current !== version) {
      throw new ApiError(409, 'conflict', '这个用途刚被别人改过，刷新后再改', { version: current });
    }
  };
  const bumpPurpose = (purpose: string) => {
    const next = (purposeVersion.get(purpose) ?? 0) + 1;
    purposeVersion.set(purpose, next);
    return next;
  };
  const membershipOrder = (purpose: StageKind) =>
    (st.purposes[purpose] ?? []).map((modelId) => ({
      modelId,
      effort: purposeEffort.get(slotKey(purpose, modelId)) ?? null,
    }));
  const catalogModel = (modelId: string) => {
    const model = st.models.find((m) => m.id === modelId);
    if (!model) throw new ApiError(404, 'model_not_found', `目录里没有模型 ${modelId}`);
    return model;
  };
  const assertFounderCanWrite = (model: { id: string; family: string; displayName: string }) => {
    const why = founderOnlyDenial(
      { id: model.id, family: model.family, displayName: model.displayName },
      { label: st.me.user.displayName, founderInCockpit: st.me.user.role === 'founder' },
    );
    if (why) throw new ApiError(403, 'founder_only', why);
  };
  const assertPurposeEffort = (modelId: string, effort: SessionEffort | null) => {
    if (effort === null) return;
    for (const route of st.routes.filter((r) => r.modelId === modelId)) {
      const why = routeEffortProblem(route.hostId, modelId, effort);
      if (why) throw new ApiError(422, 'effort_invalid', why);
    }
  };
  const handChannel = (channelId: string) => {
    const channel = st.channels.find((c) => c.id === channelId);
    if (!channel) throw new ApiError(404, 'channel_not_found', '没有这个渠道');
    if (channel.id !== 'claude-sub' && channel.name !== 'Claude 订阅') {
      throw new ApiError(422, 'not_manual', '这个渠道有名册命令，不用手工登记');
    }
    return channel;
  };
  const engine = { kind: 'engine' as const, id: 'engine', name: '引擎' };

  function audit(e: Omit<AuditEntry, 'id' | 'at' | 'ok'> & { ok?: boolean }) {
    st.audit.unshift({ id: nextId('a'), at: iso(), ok: true, ...e });
    emit('audit_log', st.audit[0]?.id ?? '');
  }
  /** 立即探测的操作记录（和真后端一样从 audit 里取 routing:probe 的）。 */
  function mockProbeRows() {
    return st.audit
      .filter((a) => a.target === ROUTE_PROBE_TARGET)
      .map((a) => ({
        at: new Date(a.at),
        action: a.action,
        actorId: a.actor.id,
        after: a.after,
        ok: a.ok,
        error: a.error ?? null,
      }));
  }
  /**
   * 假引擎：点了 1.5 秒接手、接手 4 秒探完（真引擎每 5 秒看一眼，探一条要十几秒到几十秒）。结论照真探针的规矩：
   * 按量计费、模型下架、关着的不探（写明为什么），其余照这条路由现在的样子再下一次结论（时刻换成现在）。
   */
  function advanceMockProbes() {
    const t = now();
    const { requests } = foldRouteProbeRequests(mockProbeRows(), new Date(t));
    for (const r of requests) {
      const requestedAt = Date.parse(r.requestedAt);
      if (r.state === 'queued' && t - requestedAt >= 1500) {
        audit({
          actor: engine,
          action: ROUTE_PROBE_ACTION.start,
          target: ROUTE_PROBE_TARGET,
          after: { requestId: r.requestId },
          via: 'engine',
        });
      }
      if (r.state === 'running' && r.startedAt && t - Date.parse(r.startedAt) >= 4000) {
        const ids = r.routeIds ?? st.routes.map((x) => x.id);
        const results = ids.map((id): RouteProbeResult => {
          const route = st.routes.find((x) => x.id === id);
          if (!route)
            return { routeId: id, outcome: 'gone', detail: '库里没有这条路由（可能刚被删了）', at: iso() };
          const channel = st.channels.find((c) => c.id === route.channelId);
          const model = st.models.find((m) => m.id === route.modelId);
          const skip = (detail: string): RouteProbeResult => {
            route.probe = { state: 'skipped', at: iso(), detail };
            route.alive = false;
            return { routeId: id, outcome: 'skipped', detail, at: iso() };
          };
          if (channel?.billing === 'metered') return skip('按量计费的渠道不自动探：探一次就多一笔账');
          if (model?.retiredAt && Date.parse(model.retiredAt) <= t)
            return skip(`模型「${model.displayName}」已下架，不探`);
          if (switchedOff.has(id))
            return skip(
              '没有哪个阶段在用这条路由（挂着但关着的不算），不花额度去探；哪个阶段用上它，下一轮就探',
            );
          const failed = route.probe?.state === 'failed';
          const sec = failed ? 41 : 6 + Math.floor(rand() * 12);
          const detail = failed ? (route.probe?.detail ?? '没探通') : `答上了：OK · 用时 ${sec} 秒`;
          route.probe = { state: failed ? 'failed' : 'ok', at: iso(), detail };
          route.alive = !failed;
          // 探完重写下次时刻：活跃 1 小时、不活跃 1 天，不通的按连着不通几次退避（15、30、60、120、240 分钟）
          route.probeFailStreak = failed ? (route.probeFailStreak ?? 0) + 1 : 0;
          const backoff = [15, 30, 60, 120, 240][Math.min(route.probeFailStreak, 5) - 1];
          const waitMin = failed && backoff ? backoff : route.probeTier === 'idle' ? 24 * 60 : 60;
          if (route.probeTier !== 'unused') route.probeNextAt = new Date(t + waitMin * 60_000).toISOString();
          return {
            routeId: id,
            outcome: failed ? 'failed' : 'ok',
            detail,
            at: iso(),
            durationMs: sec * 1000,
          };
        });
        audit({
          actor: engine,
          action: ROUTE_PROBE_ACTION.done,
          target: ROUTE_PROBE_TARGET,
          after: { requestId: r.requestId, results },
          via: 'engine',
        });
      }
    }
  }
  function log(tv: MTask, entry: Omit<MLog, 'id' | 'at' | 'taskId'>) {
    const l: MLog = { id: nextId('log'), at: iso(), taskId: tv.task.id, ...entry };
    st.logs.push(l);
    if (st.logs.length > 3000) st.logs.splice(0, st.logs.length - 3000);
    emit('subtasks', l.id);
  }

  function findTask(taskId: string): MTask {
    const tv = st.tasks.find((t) => t.task.id === taskId);
    if (!tv) throw new ApiError(404, 'task_not_found', '没有这个任务');
    return tv;
  }
  function allRuns(): SessionRun[] {
    return st.tasks.flatMap((t) => [...t.runs, ...t.subtasks.flatMap((s) => s.runs)]);
  }
  function routeInfo(routeId: string) {
    const route = st.routes.find((r) => r.id === routeId);
    const model = route ? st.models.find((m) => m.id === route.modelId) : undefined;
    const hostId: HostId | undefined = route?.hostId;
    // 和真后端一样从渠道表读计费方式；渠道查不到就没有（不猜成套餐内）
    const billing = route ? st.channels.find((c) => c.id === route.channelId)?.billing : undefined;
    return { route, model, modelName: model?.displayName ?? '未知模型', hostId, billing };
  }
  function poolRunning(poolId: string): number {
    return allRuns().filter((r) => isRunning(r) && routeInfo(r.routeId).route?.poolId === poolId).length;
  }
  /** 已选定还没开跑的（排队中、没结束）：和真后端一样占池的名额（#757 预占）。 */
  function poolReserved(poolId: string): number {
    return allRuns().filter(
      (r) => !r.startedAt && !r.endedAt && routeInfo(r.routeId).route?.poolId === poolId,
    ).length;
  }

  /** 和真后端 routeProblem 同一套判据：先硬禁令，再库里的禁令，再看下架。 */
  function routeProblem(routeId: string, stage: StageKind | undefined): string | null {
    const { route, model } = routeInfo(routeId);
    if (!route) return `路由 ${routeId} 不存在`;
    if (!model) return `路由 ${routeId} 用的模型 ${route.modelId} 不在模型目录里`;
    const where = stage ? `「${STAGE_WORDS[stage]}」` : '这里';
    const hard = hardBanFor(model, stage);
    if (hard) return `${model.displayName} 不能用在${where}：${hard.reason}`;
    const ban = st.bans.find((b) => {
      if (b.family === undefined && b.modelId === undefined) return false;
      if (b.family !== undefined && b.family.toLowerCase() !== model.family.toLowerCase()) return false;
      if (b.modelId !== undefined && b.modelId !== model.id) return false;
      if (b.stage !== undefined && b.stage !== stage) return false;
      return true;
    });
    if (ban) return `${model.displayName} 不能用在${where}：${ban.reason}`;
    if (model.retiredAt && model.retiredAt <= iso()) return `${model.displayName} 已下架`;
    return null;
  }

  /**
   * 一条路由现在活着吗：三件事的说法照 db 的 routing-liveness.ts（真后端的判法只在那里），假数据只照着拼，不另起一套措辞。
   */
  function mockRouteLiveness(r: Route, purpose: StageKind, t: number) {
    const channel = st.channels.find((c) => c.id === r.channelId);
    const pool = st.pools.find((p) => p.id === r.poolId);
    const model = st.models.find((m) => m.id === r.modelId);
    const fact = (verdict: 'live' | 'dead' | 'unknown', reason: string) => ({ verdict, reason });

    let connect: ReturnType<typeof fact>;
    if (!channel?.enabled) connect = fact('dead', '渠道关了');
    else if (pool?.expiresAt && Date.parse(pool.expiresAt) <= t) connect = fact('dead', '账号池订阅过期了');
    else if (model?.retiredAt && Date.parse(model.retiredAt) <= t) connect = fact('dead', '模型已下架');
    else if (r.alive) connect = fact('live', '探针探通了');
    else if (!r.probe) connect = fact('unknown', '探针还没看过这条路由');
    else if (r.probe.state === 'skipped')
      connect = fact('unknown', `探针这一轮没探它（不是探了没通）：${r.probe.detail ?? '探针没写原因'}`);
    else connect = fact('dead', `探针判不在线：${r.probe.detail ?? `探针没写原因（${r.probe.state}）`}`);

    const poolWindows = st.quota.filter((w) => w.poolId === r.poolId);
    const windows = poolWindows.filter(
      (w) =>
        !(w.resetsAt && Date.parse(w.resetsAt) <= t) &&
        windowAppliesTo(w, { id: r.modelId, ...(model ? { family: model.family } : {}) }) !== 'no',
    );
    const full = windows.filter(
      (w) =>
        w.upstreamStatus === 'limit_reached' ||
        (w.utilization !== undefined && w.utilization >= 1) ||
        (w.used !== undefined && w.limit !== undefined && w.used >= w.limit),
    );
    const quota =
      full.length > 0
        ? fact('dead', '适用的额度窗用满了')
        : poolWindows.length === 0 || windows.some((w) => t - Date.parse(w.readAt) > STALE_MS)
          ? fact('unknown', '额度没读成、读数过期，或判不了扣不扣这条路由')
          : fact('live', '额度读数新、窗口有余');

    const hard = model ? hardBanFor(model, purpose) : undefined;
    const banReasons = [
      ...(hard ? [hard.reason] : []),
      ...st.bans
        .filter(
          (b) =>
            (b.stage === undefined || b.stage === purpose) &&
            (b.family === undefined || b.family === model?.family) &&
            (b.modelId === undefined || b.modelId === r.modelId),
        )
        .map((b) => b.reason),
    ];
    const enabled = !switchedOff.has(r.id);
    const ban =
      banReasons.length > 0
        ? fact('dead', `命中禁令：${banReasons.join('；')}`)
        : enabled
          ? fact('live', '没有禁令、开关开着')
          : fact('dead', '开关关着（这条路由在它的模型下关着）');

    const verdicts = [connect.verdict, quota.verdict, ban.verdict];
    return {
      routeId: r.id,
      channelId: r.channelId,
      channelName: channel?.name ?? r.channelId,
      poolId: r.poolId,
      hostId: r.hostId,
      enabled,
      verdict: verdicts.includes('dead') ? 'dead' : verdicts.includes('unknown') ? 'unknown' : 'live',
      connect,
      quota,
      ban,
      ...(r.probe ? { probedAt: r.probe.at } : {}),
      ...(r.probe?.detail ? { probeDetail: r.probe.detail } : {}),
      ...(r.probeTier ? { probeTier: r.probeTier } : {}),
      ...(r.probeNextAt ? { probeNextAt: r.probeNextAt } : {}),
      ...(r.probeFailStreak !== undefined ? { probeFailStreak: r.probeFailStreak } : {}),
      ...(r.probeKind ? { probeKind: r.probeKind } : {}),
      ...(r.suspectedSwap !== undefined ? { suspectedSwap: r.suspectedSwap } : {}),
      ...(r.probeTrigger ? { probeTrigger: r.probeTrigger } : {}),
      exhausted: full.map((w) => ({
        label: w.label ?? w.window,
        ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}),
      })),
      inFlight: poolRunning(r.poolId),
      reserved: poolReserved(r.poolId),
      maxConcurrency: pool?.maxConcurrency ?? 0,
    } as const;
  }

  // ---------- 投影成契约形状 ----------

  function activityOf(run: SessionRun, steps: Step[] | undefined) {
    const info = routeInfo(run.routeId);
    const queued = !run.startedAt;
    const step = steps?.find((s) => s.state === 'in_progress')?.title;
    const doing = queued ? '排队中' : `正在${(step ?? STAGE_WORDS[run.stage]).replace(/^正在/, '')}`;
    return {
      runId: run.id,
      stage: run.stage,
      routeId: run.routeId,
      modelName: info.modelName,
      hostId: info.hostId,
      queued,
      since: run.startedAt ?? run.queuedAt,
      step,
      text: `${info.modelName} ${doing}`,
    };
  }

  function subtaskView(s: MSubtask) {
    const run = latestActive(s.runs);
    // 步骤清单是写码会话报的；第二意见那个会话没报过步骤（和真后端一样，进度跟着当前会话走）。
    const steps = s.steps.length && run && run.stage !== 'review' ? s.steps : undefined;
    return {
      id: s.subtask.id,
      index: s.subtask.index,
      title: s.subtask.title,
      state: s.subtask.state,
      prNumber: s.subtask.prNumber,
      dependsOn: s.subtask.dependsOn,
      touches: s.subtask.touches,
      progress:
        run && steps
          ? { done: steps.filter((x) => x.state === 'done').length, total: steps.length }
          : undefined,
      activity: run ? activityOf(run, steps) : undefined,
    };
  }

  function repoView(repoId: string) {
    const repo = st.repos.find((r) => r.id === repoId);
    if (!repo) throw new ApiError(404, 'repo_not_found', '没有这个仓');
    return { id: repo.id, owner: repo.owner, name: repo.name, defaultBranch: repo.defaultBranch };
  }

  function boardOf(repoId: string) {
    const repo = repoView(repoId);
    const tasks = st.tasks
      .filter((t) => t.task.repoId === repoId)
      .sort((a, b) => a.task.priority - b.task.priority || a.task.createdAt.localeCompare(b.task.createdAt));
    const nowItems = tasks.flatMap((t) => [
      ...t.runs
        .filter((r) => !r.endedAt)
        .map((r) => ({ ...activityOf(r, undefined), taskId: t.task.id, taskTitle: t.task.title })),
      ...t.subtasks.flatMap((s) =>
        s.runs
          .filter((r) => !r.endedAt)
          .map((r) => ({
            ...activityOf(r, s.steps),
            taskId: t.task.id,
            taskTitle: t.task.title,
            subtaskId: s.subtask.id,
          })),
      ),
    ]);
    return BoardResponse.parse({
      repo,
      tasks: tasks.map((t) => {
        const front = latestActive(t.runs);
        return {
          id: t.task.id,
          issueNumber: t.task.issueNumber,
          title: t.task.title,
          state: t.task.state,
          priority: t.task.priority,
          requestedBy: t.task.requestedBy,
          createdAt: t.task.createdAt,
          progress: {
            done: t.subtasks.filter((s) => s.subtask.state === 'merged').length,
            total: t.subtasks.length,
          },
          activity: front ? activityOf(front, undefined) : undefined,
          subtasks: t.subtasks.map(subtaskView),
        };
      }),
      now: nowItems,
      asOf: iso(),
    });
  }

  function runView(r: SessionRun) {
    const info = routeInfo(r.routeId);
    return { ...r, modelName: info.modelName, hostId: info.hostId, billing: info.billing };
  }

  // ---------- 模拟器的小动作 ----------

  function subStage(sv: MSubtask): StageKind {
    const last = [...sv.runs].reverse().find((r) => r.stage === 'execute' || r.stage === 'ui');
    if (last) return last.stage;
    return sv.subtask.touches.some((p) => p.endsWith('.tsx') || p.includes('components/')) ? 'ui' : 'execute';
  }

  /**
   * 一个用途按路由两层摊开的先后（照真后端 routeFactsForPurpose：先用途下模型的先后、再模型下路由的先后）：
   * 关着的、这条用途用不了的都不进（照真后端，开关和禁令在选路那一层判）。
   */
  function routeOrderFor(purpose: StageKind): string[] {
    const modelIds = st.purposes[purpose];
    if (!modelIds) return [];
    return modelIds.flatMap((modelId) =>
      (st.routing[modelId] ?? []).filter(
        (routeId) => !switchedOff.has(routeId) && routeProblem(routeId, purpose) === null,
      ),
    );
  }

  /** 按路由两层的先后选第一条能用的路由：在线、不犯禁令、渠道开着、账号池有空位。 */
  function pickRoute(stage: StageKind, avoid: string[] = []): string | undefined {
    for (const rid of routeOrderFor(stage)) {
      if (avoid.includes(rid)) continue;
      const { route } = routeInfo(rid);
      if (!route?.alive) continue;
      if (!st.channels.find((c) => c.id === route.channelId)?.enabled) continue;
      const pool = st.pools.find((p) => p.id === route.poolId);
      if (
        pool &&
        poolFull({
          inFlight: poolRunning(pool.id),
          reserved: poolReserved(pool.id),
          maxConcurrency: pool.maxConcurrency,
        })
      )
        continue;
      return rid;
    }
    return undefined;
  }

  function startRun(tv: MTask, sv: MSubtask | undefined, stage: StageKind, routeId: string, why: string) {
    const r: SessionRun = {
      id: nextId('run'),
      taskId: tv.task.id,
      stage,
      routeId,
      whyRoute: why,
      queuedAt: iso(),
      startedAt: iso(),
    };
    if (sv) {
      r.subtaskId = sv.subtask.id;
      sv.runs.push(r);
    } else tv.runs.push(r);
    return r;
  }
  function endRun(r: SessionRun, outcome: RunOutcome) {
    if (r.endedAt) return;
    r.endedAt = iso();
    r.outcome = outcome;
    const minutes = Math.max(1, (Date.parse(r.endedAt) - Date.parse(r.startedAt ?? r.queuedAt)) / 60_000);
    r.inputTokens = Math.round(minutes * (7000 + rand() * 4000));
    r.outputTokens = Math.round(minutes * (500 + rand() * 300));
    const info = routeInfo(r.routeId);
    fakeUsage(r, { hostId: info.hostId, modelId: info.route?.modelId, billing: info.billing });
  }
  function setSubState(tv: MTask, sv: MSubtask, to: MSubtask['subtask']['state']) {
    const from = sv.subtask.state;
    if (from === to) return;
    sv.subtask.state = to;
    log(tv, { source: 'engine', kind: 'state', subtaskId: sv.subtask.id, text: `状态：${from} → ${to}` });
    emit('subtasks', sv.subtask.id);
  }
  function setTaskState(tv: MTask, to: MTask['task']['state']) {
    const from = tv.task.state;
    if (from === to) return;
    tv.task.state = to;
    log(tv, { source: 'engine', kind: 'state', text: `状态：${from} → ${to}` });
    emit('tasks', tv.task.id);
  }

  function startSubtask(tv: MTask, sv: MSubtask) {
    const stage = subStage(sv);
    const rid = pickRoute(stage);
    if (!rid) {
      setSubState(tv, sv, 'waiting_slot');
      return;
    }
    if (!sv.steps.length)
      sv.steps = GENERIC_STEPS.map((title, index) => ({ index, title, state: 'pending' }));
    const first = sv.steps.find((s) => s.state !== 'done');
    if (first) first.state = 'in_progress';
    sv.planUpdatedAt = iso();
    const r = startRun(tv, sv, stage, rid, `${STAGE_WORDS[stage]}阶段按顺序第一条有空位的`);
    setSubState(tv, sv, 'running');
    sv.lastSay = { text: `正在${first?.title ?? '干活'}`, at: iso() };
    log(tv, {
      source: 'session',
      kind: 'plan',
      runId: r.id,
      subtaskId: sv.subtask.id,
      text: planText(sv.steps),
    });
    audit({
      actor: engine,
      action: 'run.start',
      target: `task:${tv.task.id}`,
      after: { stage, routeId: rid },
      via: 'engine',
    });
  }

  function planText(steps: Step[]) {
    const done = steps.filter((s) => s.state === 'done').length;
    const cur = steps.find((s) => s.state === 'in_progress');
    return `步骤清单：完成 ${done}/${steps.length}${cur ? `，正在${cur.title.replace(/^正在/, '')}` : ''}`;
  }

  function openReview(tv: MTask, sv: MSubtask) {
    const exec = [...sv.runs].reverse().find((r) => r.stage === 'execute' || r.stage === 'ui');
    const family = exec ? routeInfo(exec.routeId).model?.family : undefined;
    // 第二意见换厂商：跳过和写码同族的路由。
    const avoid = st.routes
      .filter((r) => st.models.find((m) => m.id === r.modelId)?.family === family)
      .map((r) => r.id);
    const rid = pickRoute('review', avoid) ?? pickRoute('review');
    if (rid) startRun(tv, sv, 'review', rid, `第二意见换厂商：${routeInfo(rid).modelName}`);
  }

  function finishExecute(tv: MTask, sv: MSubtask) {
    const active = sv.runs.filter((r) => !r.endedAt && r.stage !== 'review');
    active.forEach((r, i) => {
      endRun(r, i === 0 ? 'ok' : 'stopped');
    });
    if (!sv.subtask.prNumber) {
      sv.subtask.prNumber = st.nextPr++;
      audit({
        actor: engine,
        action: 'pr.open',
        target: `task:${tv.task.id}`,
        after: { prNumber: sv.subtask.prNumber },
        via: 'engine',
      });
    }
    const winner = active[0];
    if (winner) {
      log(tv, {
        source: 'session',
        kind: 'done',
        runId: winner.id,
        subtaskId: sv.subtask.id,
        text: `交活：测试通过，PR #${sv.subtask.prNumber} 已开`,
      });
    }
    sv.lastSay = { text: `PR #${sv.subtask.prNumber} 已开，等第二意见`, at: iso() };
    setSubState(tv, sv, 'verifying');
    openReview(tv, sv);
  }

  function advanceStep(tv: MTask, sv: MSubtask, run: SessionRun) {
    const i = sv.steps.findIndex((s) => s.state === 'in_progress');
    const cur = sv.steps[i];
    if (!cur) {
      finishExecute(tv, sv);
      return;
    }
    cur.state = 'done';
    const next = sv.steps[i + 1];
    sv.planUpdatedAt = iso();
    if (next) {
      next.state = 'in_progress';
      sv.lastSay = { text: `正在${next.title}`, at: iso() };
      log(tv, {
        source: 'session',
        kind: 'plan',
        runId: run.id,
        subtaskId: sv.subtask.id,
        text: planText(sv.steps),
      });
      log(tv, {
        source: 'session',
        kind: 'say',
        runId: run.id,
        subtaskId: sv.subtask.id,
        text: `正在${next.title}`,
      });
      emit('subtasks', sv.subtask.id);
    } else {
      finishExecute(tv, sv);
    }
  }

  function merge(tv: MTask, sv: MSubtask) {
    queuedAt.delete(sv.subtask.id);
    sv.lastSay = { text: `PR #${sv.subtask.prNumber ?? ''} 已合并`, at: iso() };
    setSubState(tv, sv, 'merged');
    audit({
      actor: engine,
      action: 'pr.merge',
      target: `task:${tv.task.id}`,
      after: { prNumber: sv.subtask.prNumber },
      via: 'engine',
    });
    for (const dep of tv.subtasks) {
      if (dep.subtask.state !== 'waiting_deps') continue;
      const ready = dep.subtask.dependsOn.every(
        (d) => tv.subtasks.find((x) => x.subtask.id === d)?.subtask.state === 'merged',
      );
      if (ready) startSubtask(tv, dep);
    }
  }

  function materializePlan(tv: MTask) {
    const plan = st.plans[tv.task.id];
    setTaskState(tv, 'running');
    if (!plan?.length) return;
    delete st.plans[tv.task.id];
    tv.subtasks = plan.map((p, index) => ({
      subtask: {
        id: `${tv.task.id}-${String.fromCharCode(97 + index)}`,
        taskId: tv.task.id,
        index,
        title: p.title,
        touches: p.touches,
        dependsOn: [],
        state: 'pending',
      },
      steps: p.steps.map((title, i) => ({ index: i, title, state: 'pending' }) satisfies Step),
      runs: [],
      paused: false,
    }));
    for (const sv of tv.subtasks) startSubtask(tv, sv);
  }

  function notify(
    level: 'decision' | 'alert' | 'daily',
    title: string,
    body: string,
    link?: string,
    taskId?: string,
  ) {
    const n = {
      id: nextId('n'),
      level,
      title,
      body,
      createdAt: iso(),
      deliveries: [{ channel: 'feishu', delivered: true, attempts: 1, lastAttemptAt: iso() }],
      ...(link ? { link } : {}),
      ...(taskId ? { taskId } : {}),
    };
    st.notifications.unshift(n);
    emit('notifications', n.id);
  }

  // ---------- 模拟一拍 ----------
  let tickNo = 0;
  function tick() {
    tickNo += 1;
    const t = now();

    for (const tv of st.tasks) {
      const state = tv.task.state;
      if (tv.paused || TERMINAL.has(state)) continue;

      // 引擎只写 queued → running（动手会话）→ done/stopped/stalled 这几个状态（不再写 triaging/asking/planning/merging，库里枚举值留着）；
      // 排队的一到点就起会话、按方案拆出子任务。
      if (state === 'queued' && rand() < 0.05) {
        const plan = st.plans[tv.task.id];
        const rid = pickRoute(plan?.[0]?.stage === 'ui' ? 'ui' : 'execute');
        if (rid) {
          if (!tv.task.specDir) tv.task.specDir = `specs/${tv.task.issueNumber}`;
          materializePlan(tv);
          log(tv, { source: 'engine', kind: 'state', text: '引擎起了动手会话，按方案拆出子任务' });
        }
      }

      for (const sv of tv.subtasks) {
        if (sv.paused) continue;
        const s = sv.subtask.state;
        if (s === 'running') {
          const run = latestActive(sv.runs);
          if (!run) continue;
          if (rand() < 0.4) {
            log(tv, {
              source: 'session',
              runId: run.id,
              subtaskId: sv.subtask.id,
              ...fakeAction(sv.subtask.touches, counter++),
            });
          }
          if (rand() < 0.07) advanceStep(tv, sv, run);
        } else if (s === 'verifying') {
          const review = sv.runs.find((r) => r.stage === 'review' && !r.endedAt);
          if (review) {
            if (rand() < 0.25) {
              log(tv, {
                source: 'session',
                runId: review.id,
                subtaskId: sv.subtask.id,
                kind: 'tool',
                text: `用工具：Read ${sv.subtask.touches[0] ?? 'README.md'}`,
              });
            }
            if (rand() < 0.08) {
              endRun(review, 'ok');
              log(tv, {
                source: 'session',
                runId: review.id,
                subtaskId: sv.subtask.id,
                kind: 'done',
                text: '交活：第二意见没有必须改的，2 条小毛病攒着批量修',
              });
              queuedAt.set(sv.subtask.id, t);
              sv.lastSay = { text: '排队合并', at: iso() };
              setSubState(tv, sv, 'in_merge_queue');
            }
          } else if (rand() < 0.15) {
            queuedAt.set(sv.subtask.id, t);
            setSubState(tv, sv, 'in_merge_queue');
          }
        } else if (s === 'waiting_slot' && rand() < 0.03) {
          startSubtask(tv, sv);
        } else if (s === 'pending') {
          startSubtask(tv, sv);
        }
      }

      const subs = tv.subtasks;
      if (subs.length && subs.every((x) => x.subtask.state === 'merged')) {
        setTaskState(tv, 'done');
        audit({
          actor: engine,
          action: 'task.close',
          target: `task:${tv.task.id}`,
          reason: '子任务都已合并，结果文档已写',
          via: 'engine',
        });
        notify('daily', `#${tv.task.issueNumber} 已完成`, tv.task.title, '/home3', tv.task.id);
      }
    }

    // 合并队列：每个仓一次只合一个，先进先合。
    for (const repo of st.repos) {
      const queue = st.tasks
        .filter((x) => x.task.repoId === repo.id && !x.paused)
        .flatMap((x) => x.subtasks.map((s) => ({ tv: x, sv: s })))
        .filter(({ sv }) => sv.subtask.state === 'in_merge_queue')
        .sort((a, b) => (queuedAt.get(a.sv.subtask.id) ?? 0) - (queuedAt.get(b.sv.subtask.id) ?? 0));
      const head = queue[0];
      if (head && rand() < 0.12) merge(head.tv, head.sv);
    }

    // 额度：在跑的账号池慢慢往上走；过了清零时间就清零。
    for (const w of st.quota) {
      const running = poolRunning(w.poolId);
      let changed = false;
      if (w.resetsAt && Date.parse(w.resetsAt) <= t) {
        if (w.utilization !== undefined) w.utilization = 0.02;
        if (w.used !== undefined) w.used = 0;
        const len =
          w.window === '5h' ? 5 * 3_600_000 : w.window.startsWith('7d') ? 7 * 86_400_000 : 30 * 86_400_000;
        w.resetsAt = new Date(Date.parse(w.resetsAt) + len).toISOString();
        changed = true;
      }
      if (running > 0) {
        if (w.utilization !== undefined)
          w.utilization = Math.min(0.995, w.utilization + running * 0.0004 + rand() * 0.0003);
        if (w.used !== undefined) w.used = Math.round((w.used + running * 0.02) * 100) / 100;
        changed = true;
      }
      if (w.reading === 'measured' && tickNo % 8 === 0) {
        w.readAt = new Date(t).toISOString();
        changed = true;
      }
      if (changed) emit('quota_windows', w.poolId);
    }

    // 定时任务：到点就跑。
    for (const j of st.jobs) {
      if (Date.parse(j.nextRunAt) > t) continue;
      const started = new Date(t).toISOString();
      j.nextRunAt = new Date(t + j.expectEveryMinutes * 60_000).toISOString();
      if (j.keepsFailing) {
        j.lastRun = {
          startedAt: started,
          endedAt: started,
          outcome: j.keepsFailing,
          why: j.keepsFailing === 'unscanned' ? 'GitHub 接口限流，这次没查成' : 'ssh 连备份机超时',
        };
      } else {
        j.lastRun = { startedAt: started, endedAt: started, outcome: 'ok', found: 0 };
        j.lastSuccessAt = started;
      }
      // 定时任务的表不在推送名单里（和真后端一样），定时任务页靠定时重拉。
    }
  }

  // ---------- 接口 ----------

  let timer: ReturnType<typeof setInterval> | undefined;
  if (opts.live) timer = setInterval(tick, opts.tickMs ?? 2600);

  const api: MockApi = {
    source: 'mock',
    ...mockRequests,
    tick,
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    state: () => st,

    async authConfig() {
      await wait();
      return AuthConfigResponse.parse({ devLogin: false, passwordLogin: true });
    },
    async devLogin() {
      await wait();
      return MeResponse.parse(st.me);
    },
    async feishuAccess() {
      await wait();
      return MeResponse.parse(st.me);
    },
    async passwordLogin(username, password) {
      await wait();
      const c = mockCreds;
      if (
        c.password === undefined ||
        c.username?.toLowerCase() !== username.toLowerCase() ||
        c.password !== password
      )
        throw new ApiError(401, 'bad_credentials', '用户名或密码不对');
      return MeResponse.parse(st.me);
    },
    async credentials() {
      await wait();
      return CredentialsResponse.parse({
        hasPassword: mockCreds.password !== undefined,
        username: mockCreds.username ?? null,
        passwordChangedAt: mockCreds.changedAt ?? null,
        // 假数据没有「飞书登录过几分钟」：没设过就当可以直接设
        canSetWithoutCurrent: mockCreds.password === undefined,
      });
    },
    async updateCredentials(raw) {
      await wait();
      const { username, newPassword, currentPassword } = UpdateCredentialsRequest.parse(raw);
      // 校验顺序和真后端（api/src/credentials.ts）一致；规则的出处在 api/src/password.ts
      if (username === undefined && newPassword === undefined)
        throw new ApiError(400, 'nothing_to_change', '用户名和新密码至少给一样');
      if (username !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/.test(username))
        throw new ApiError(
          400,
          'invalid_username',
          '用户名 3–32 位，字母或数字开头，只能用字母、数字、点、下划线、连字符',
          {
            field: 'username',
          },
        );
      if (newPassword !== undefined && [...newPassword.normalize('NFKC')].length < PASSWORD_MIN_LENGTH)
        throw new ApiError(400, 'weak_password', `密码至少 ${PASSWORD_MIN_LENGTH} 位`, {
          field: 'newPassword',
        });
      const c = mockCreds;
      if (c.password !== undefined) {
        if (!currentPassword)
          throw new ApiError(400, 'current_password_required', '改之前要输入当前密码', {
            field: 'currentPassword',
          });
        if (currentPassword !== c.password)
          throw new ApiError(401, 'bad_current_password', '当前密码不对', { field: 'currentPassword' });
      }
      if (newPassword !== undefined && username === undefined && c.username === undefined)
        throw new ApiError(400, 'username_required', '第一次设密码要同时设用户名', { field: 'username' });
      const had = c.password !== undefined;
      const before = { username: c.username ?? null, hasPassword: had };
      if (username !== undefined) c.username = username;
      if (newPassword !== undefined) {
        c.password = newPassword;
        c.changedAt = iso();
      }
      audit({
        actor: meActor(),
        action: had ? 'credentials.change' : 'credentials.set',
        target: `user:${st.me.user.id}`,
        before,
        after: { username: c.username ?? null, passwordChanged: newPassword !== undefined },
        via: 'cockpit',
      });
    },
    async logout() {
      await wait();
    },
    async me() {
      await wait();
      return MeResponse.parse(st.me);
    },
    async repos() {
      await wait();
      return ReposResponse.parse({ repos: st.repos });
    },
    async repoDispatch() {
      await wait();
      return RepoDispatchResponse.parse({
        repos: st.repos.map((r) => {
          const since = mockDispatch.get(r.id);
          return {
            repoId: r.id,
            owner: r.owner,
            name: r.name,
            on: since !== undefined,
            ...(since ? { since } : {}),
          };
        }),
      });
    },
    async updateRepoDispatch(repoId, raw) {
      await wait();
      const body = UpdateRepoDispatchRequest.parse(raw);
      const repo = st.repos.find((r) => r.id === repoId);
      if (!repo) throw new ApiError(404, 'repo_not_found', '没有这个项目');
      const before = mockDispatch.get(repoId);
      const changed = (before !== undefined) !== body.on;
      if (changed) {
        const after = body.on ? iso() : undefined;
        if (after) mockDispatch.set(repoId, after);
        else mockDispatch.delete(repoId);
        audit({
          actor: meActor(),
          action: body.on ? AUTO_DISPATCH_ENABLE : AUTO_DISPATCH_DISABLE,
          target: `repo:${repoId}`,
          before: { autoDispatchSince: before ?? null },
          after: { autoDispatchSince: after ?? null },
          via: 'cockpit',
          reason: body.reason ?? `在页面上点了${body.on ? '开启' : '关闭'}「让 AI 接活」`,
        });
      }
      const since = mockDispatch.get(repoId);
      return UpdateRepoDispatchResponse.parse({
        repoId,
        owner: repo.owner,
        name: repo.name,
        on: since !== undefined,
        ...(since ? { since } : {}),
        changed,
      });
    },
    async repoCiPolicy() {
      await wait();
      return RepoCiPolicyResponse.parse({
        repos: st.repos.map((r) => ({
          repoId: r.id,
          owner: r.owner,
          name: r.name,
          mode: ciModeOf(r.id),
          recent: mockCiRecent.get(r.id) ?? [],
        })),
      });
    },
    async updateRepoCiPolicy(repoId, raw) {
      await wait();
      const body = UpdateRepoCiPolicyRequest.parse(raw);
      const repo = st.repos.find((r) => r.id === repoId);
      if (!repo) throw new ApiError(404, 'repo_not_found', '没有这个项目');
      const before = ciModeOf(repoId);
      const changed = before !== body.mode;
      if (changed) {
        mockCiPolicy.set(repoId, body.mode);
        const recent = mockCiRecent.get(repoId) ?? [];
        recent.unshift({
          at: iso(),
          actor: st.me.user.displayName,
          from: before,
          to: body.mode,
        });
        mockCiRecent.set(repoId, recent.slice(0, 5));
        audit({
          actor: meActor(),
          action: CI_POLICY_SET,
          target: `repo:${repoId}`,
          before: { ciPolicy: before },
          after: { ciPolicy: body.mode },
          via: 'cockpit',
          reason: body.reason ?? `在页面上把 CI 模式改成${body.mode === 'force' ? '强制' : '不强制'}`,
        });
      }
      return UpdateRepoCiPolicyResponse.parse({
        repoId,
        owner: repo.owner,
        name: repo.name,
        mode: ciModeOf(repoId),
        recent: mockCiRecent.get(repoId) ?? [],
        changed,
      });
    },
    // 设置页「导入仓库」（#1989）：假数据里造一份「我的 GitHub 仓」清单，含个人仓、组织仓、已装/未装、已在驾驶舱的。
    async importableRepos() {
      await wait();
      return ImportableReposResponse.parse({
        auth: mockImportAuth,
        repos: [...mockImportRepos()],
        ...(mockImportAuth.connected
          ? {}
          : { reason: '这是假数据：点「连接 GitHub」在真后端上会跳 GitHub 授权' }),
      });
    },
    async importRepo(raw) {
      await wait();
      // 机器人装没装：照清单里的标记如实回（没装全就是「未接入」，仍然导入）
      const installFields = (r: {
        owner: string;
        ownerType: 'User' | 'Organization';
        agentInstalled: boolean;
        engineInstalled: boolean;
      }) => {
        const missing = (['agent', 'engine'] as const).filter((k) => !r[`${k}Installed`]);
        return {
          appsInstalled: missing.length === 0,
          agentInstalled: r.agentInstalled,
          engineInstalled: r.engineInstalled,
          installLinks:
            missing.length === 0
              ? []
              : githubInstallLinks({ owner: r.owner, ownerType: r.ownerType, missing }),
        };
      };
      const body = ImportRepoRequest.parse(raw);
      const repo = mockImportRepos().find((r) => r.githubId === body.githubId);
      if (!repo) throw new ApiError(404, 'repo_not_visible', '这个仓不在你 GitHub 账号能看到的范围里');
      const existing = st.repos.find(
        (r) =>
          r.owner.toLowerCase() === repo.owner.toLowerCase() &&
          r.name.toLowerCase() === repo.name.toLowerCase(),
      );
      if (existing) {
        mockImported.set(repo.githubId, existing.id);
        return ImportRepoResponse.parse({
          repoId: existing.id,
          owner: existing.owner,
          name: existing.name,
          created: false,
          ...installFields(repo),
        });
      }
      const created = {
        id: `mock-${body.githubId}`,
        owner: repo.owner,
        name: repo.name,
        defaultBranch: repo.defaultBranch,
        testCommand: 'pnpm check',
      };
      st.repos.push(created);
      mockImported.set(repo.githubId, created.id);
      audit({
        actor: meActor(),
        action: REPO_IMPORT_ADD,
        target: `repo:${repo.fullName.toLowerCase()}`,
        after: { owner: repo.owner, name: repo.name },
        via: 'cockpit',
        reason: `从驾驶舱导入 ${repo.fullName}`,
      });
      return ImportRepoResponse.parse({
        repoId: created.id,
        owner: created.owner,
        name: created.name,
        created: true,
        ...installFields(repo),
      });
    },
    async removeRepo(repoId) {
      await wait();
      const repo = st.repos.find((r) => r.id === repoId);
      if (!repo) throw new ApiError(404, 'repo_not_found', '没有这个项目');
      st.repos.splice(st.repos.indexOf(repo), 1);
      for (const [githubId, id] of mockImported) if (id === repoId) mockImported.delete(githubId);
      audit({
        actor: meActor(),
        action: REPO_IMPORT_REMOVE,
        target: `repo:${repo.owner}/${repo.name}`.toLowerCase(),
        before: { owner: repo.owner, name: repo.name },
        via: 'cockpit',
        reason: `从驾驶舱移出 ${repo.owner}/${repo.name}`,
      });
      return RemoveRepoResponse.parse({ removed: true });
    },
    async installAppOnRepo(raw) {
      await wait();
      const body = InstallAppRequest.parse(raw);
      const repo = mockImportRepos().find((r) => r.githubId === body.githubId);
      if (!repo) throw new ApiError(404, 'repo_not_visible', '这个仓不在你 GitHub 账号能看到的范围里');
      if (repo.ownerType === 'Organization' && !repo.viewerCanAdmin) {
        throw new ApiError(403, 'needs_org_admin', '这是组织的仓，要组织管理员先批准这个 App');
      }
      audit({
        actor: meActor(),
        action: GITHUB_INSTALL_REPO,
        target: `repo:${repo.fullName.toLowerCase()}`,
        via: 'cockpit',
        reason: `把 App 装到 ${repo.fullName}`,
      });
      return InstallAppResponse.parse({ installed: 2, agent: true, engine: true });
    },
    async disconnectGitHub() {
      await wait();
      audit({
        actor: meActor(),
        action: GITHUB_OAUTH_DISCONNECT,
        target: `user:${st.me.user.id}`,
        via: 'cockpit',
        reason: '断开 GitHub 授权',
      });
      return DisconnectGitHubResponse.parse({ disconnected: true });
    },
    async groomStatus(repoId) {
      await wait();
      const repo = st.repos.find((r) => r.id === repoId);
      if (!repo) throw new ApiError(404, 'repo_not_found', '没有这个项目');
      const slug = `${repo.owner}/${repo.name}`;
      const at = new Date(now());
      return GroomStatusResponse.parse({
        asOf: at.toISOString(),
        repoId: repo.id,
        repo: slug,
        quota: groomQuota(mockGroom, slug, at),
        busy: mockGroom.some((r) => r.state === 'queued' || r.state === 'running'),
        recent: mockGroom.filter((r) => r.repo.toLowerCase() === slug.toLowerCase()).slice(0, 5),
        unreadable: 0,
      });
    },
    async groomNow(repoId, raw) {
      await wait();
      const body = GroomNowRequest.parse(raw);
      const repo = st.repos.find((r) => r.id === repoId);
      if (!repo) throw new ApiError(404, 'repo_not_found', '没有这个项目');
      const slug = `${repo.owner}/${repo.name}`;
      const at = new Date(now());
      const master = mockMaster();
      const verdict = judgeGroomRequest({
        repo: slug,
        source: 'http',
        now: at,
        requests: mockGroom,
        engine: master.on ? { on: true } : { on: false, why: master.detail },
      });
      if (!verdict.ok) {
        const status = verdict.reason === 'daily_cap' ? 429 : 409;
        const code =
          verdict.reason === 'engine_off'
            ? 'engine_off'
            : verdict.reason === 'busy'
              ? 'groom_busy'
              : verdict.reason === 'daily_cap'
                ? 'groom_daily_cap'
                : 'groom_too_soon';
        throw new ApiError(status, code, verdict.why);
      }
      const request: GroomRequestView = {
        requestId: `groom-${++counter}`,
        repo: slug,
        source: 'http',
        requestedAt: at.toISOString(),
        by: st.me.user.id,
        state: 'queued',
      };
      mockGroom = [request, ...mockGroom];
      audit({
        actor: meActor(),
        action: GROOM_ACTION.request,
        target: GROOM_TARGET,
        after: { requestId: request.requestId, repo: slug, source: 'http' },
        via: 'cockpit',
        reason: body.reason ?? '驾驶舱上点了「让指挥官整理」',
      });
      return GroomNowResponse.parse({ request, remainingAfter: verdict.remainingAfter });
    },
    async home() {
      await wait();
      // 和真后端 buildHome 一个拼法（少一些数据源：假后端没有 approvals 表、没有 PR 镜像表）：
      // decision = decision 级未处理通知（标题里「等你批/等你点头」的算待批）；
      // done = merged 的子任务里有 prNumber 的（模拟器 merge 时给的号），时刻用它状态变化的时刻（没有就用现在）。
      const repoName = (repoId: string) => {
        const r = st.repos.find((x) => x.id === repoId);
        return r ? `${r.owner}/${r.name}` : '（仓不在库里）';
      };
      const decisions = [
        ...st.notifications
          .filter((n) => !n.resolvedAt && n.level === 'decision')
          .map((n) => {
            const task = n.taskId ? st.tasks.find((t) => t.task.id === n.taskId) : undefined;
            const named = task ? st.repos.find((x) => x.id === task.task.repoId) : undefined;
            const approval = /等你(批|点头)/.test(n.title);
            return {
              kind: approval ? ('approval' as const) : ('notification' as const),
              id: n.id,
              title: n.title,
              ...(task ? { context: `#${task.task.issueNumber} ${task.task.title}` } : {}),
              since: n.createdAt,
              link: n.link ?? '/notifications',
              // 和真后端 homeDecisions 一样：挂得上仓写 owner/name，否则 null（整机的事）
              repo: named ? `${named.owner}/${named.name}` : null,
            };
          }),
      ].sort((a, b) => b.since.localeCompare(a.since));
      const TERMINAL_M = new Set(['done', 'stopped', 'failed']);
      // 三段流水和真后端 buildHome 一个读法：readSegmentRun 读好，再交给 shared 的 taskFlow / flowStages 推
      const viewsOf = (t: (typeof st.tasks)[number]) =>
        (t.segmentRuns ?? []).map((r) =>
          readSegmentRun(
            {
              ...r,
              modelName: st.models.find((m) => m.id === r.model)?.displayName ?? r.model,
              billing: st.channels.find((c) => c.id === r.channel)?.billing,
              matchedBy: 'task',
            },
            { taskFinished: TERMINAL_M.has(t.task.state) },
          ),
        );
      const pendingOf = (t: (typeof st.tasks)[number]) => {
        const asked = st.notifications
          .filter((n) => !n.resolvedAt && n.level === 'decision' && n.taskId === t.task.id)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        return asked ? { title: asked.title, since: asked.createdAt } : undefined;
      };
      const running = st.tasks
        .filter((t) => !TERMINAL_M.has(t.task.state))
        .sort((a, b) => a.task.priority - b.task.priority)
        .map((t) => {
          const queued = [...t.runs, ...t.subtasks.flatMap((s) => s.runs)].find(
            (r) => !r.startedAt && !r.endedAt,
          );
          const views = viewsOf(t);
          const flow = taskFlow(t.task, views);
          const runIds = views.filter((v) => v.running).map((v) => v.id);
          const decision = pendingOf(t);
          const stalled = t.task.state === 'stalled' ? t.task.stalled : undefined;
          const waitingReason = t.task.paused
            ? ('paused' as const)
            : t.task.state === 'stalled'
              ? ('parked' as const)
              : queued
                ? ('queue' as const)
                : flow.segment === 'verify_pending'
                  ? ('verify_round' as const)
                  : flow.segment === 'merge'
                    ? ('merge_queue' as const)
                    : ('nothing' as const);
          const waitingSince = t.task.paused
            ? undefined
            : waitingReason === 'parked'
              ? stalled?.since
              : queued
                ? queued.queuedAt
                : waitingReason === 'verify_round' || waitingReason === 'merge_queue'
                  ? flow.stageSince
                  : undefined;
          return {
            issueNumber: t.task.issueNumber,
            title: t.task.title,
            repo: repoName(t.task.repoId),
            segment: flow.segment,
            waitingReason,
            ...(t.task.paused ? { paused: t.task.paused } : {}),
            ...(waitingReason === 'parked' ? { parked: stalled?.why ?? '引擎没写停下的原因' } : {}),
            ...(waitingSince ? { waitingSince } : {}),
            taskSince: t.task.createdAt,
            ...(flow.stageSince ? { stageSince: flow.stageSince } : {}),
            ...(flow.worker ? { worker: flow.worker } : {}),
            ...(decision ? { pendingDecision: decision.title } : {}),
            ...(flow.segment === 'merge' && t.task.redChecks ? { redChecks: t.task.redChecks } : {}),
            ...(flow.lastEvent ? { lastEvent: flow.lastEvent } : {}),
            ...(flow.lastSession ? { lastSession: flow.lastSession } : {}),
            ...(t.task.executor === undefined ? {} : { executor: t.task.executor }),
            ...(t.task.claimedBy === undefined ? {} : { claimedBy: t.task.claimedBy }),
            ...(t.task.leaseUntil === undefined ? {} : { leaseUntil: t.task.leaseUntil }),
            link: `/tasks/${t.task.id}`,
            taskId: t.task.id,
            state: t.task.state,
            runIds,
          };
        });
      // 推送每 5 秒报一回资源时用这一份编号（下一次读主页再更新）
      liveRunIds = running.flatMap((r) => r.runIds);
      const resources = mockResources(liveRunIds, new Date());
      const flow = flowStages(st.tasks.flatMap(viewsOf), running);
      const taskDone = st.tasks.flatMap((t) =>
        t.subtasks
          .filter((s) => s.subtask.state === 'merged' && s.subtask.prNumber !== undefined)
          .map((s) => ({
            prNumber: s.subtask.prNumber as number,
            title: t.task.title,
            repo: repoName(t.task.repoId),
            // 假后端不记每个子任务合并的时刻：日志里「PR #n 已合并」那条就是它，没有再退回「建单时刻」。
            mergedAt:
              [...st.logs]
                .reverse()
                .find(
                  (l) => l.subtaskId === s.subtask.id && l.kind === 'state' && l.text.endsWith('→ merged'),
                )?.at ?? t.task.createdAt,
            issueNumber: t.task.issueNumber,
          })),
      );
      // 本机做的单（分支 local/…）合进去的 PR 没有任务记录：真后端用 GitHub 上的 PR 标题（#1744）。
      // 合并时刻和下面「已发布的提交」（franceReleasedCommits）对得上：主页「上线了的」按它们算一版带了哪些 PR。
      const minutesAgo = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
      const localDone = [
        { prNumber: 1745, title: '主页改成三块：要你拍的、在跑的、上线了的', mergedAt: minutesAgo(55) },
        { prNumber: 1744, title: '看门狗加「主线 N 小时没合 PR」报警', mergedAt: minutesAgo(58) },
        { prNumber: 1743, title: '发版不再开关引擎总闸', mergedAt: minutesAgo(66) },
        {
          prNumber: 1741,
          title: '发版车第 6 步只拦新出现的、跟新版有关的异常 (#1741)',
          mergedAt: minutesAgo(190),
        },
        { prNumber: 1742, title: 'PR #1742', mergedAt: minutesAgo(195) }, // 标题也没读到的退路
      ].map((p) => ({
        ...p,
        repo: repoName(st.tasks[0]?.task.repoId ?? ''),
      }));
      const done = [...taskDone, ...localDone]
        .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))
        .slice(0, 10);
      const quotaPools = st.pools.map((p) => {
        const ws = st.quota.filter((w) => w.poolId === p.id);
        return { pool: p, windows: ws };
      });
      const quotaState =
        quotaPools.length === 0
          ? { state: 'empty' as const, detail: '还没配账号池' }
          : quotaPools.every(({ windows }) => windows.length === 0)
            ? { state: 'unknown' as const, detail: '额度一次都还没读成' }
            : (() => {
                const tight = quotaPools.filter(({ windows }) =>
                  windows.some((w) => (w.utilization ?? 0) >= 0.9 || w.upstreamStatus === 'limit_reached'),
                );
                return tight.length > 0
                  ? {
                      state: 'tight' as const,
                      detail: `${tight
                        .map(({ pool }) => st.channels.find((c) => c.id === pool.channelId)?.name ?? pool.id)
                        .join('、')}快清零或已超限`,
                    }
                  : { state: 'ok' as const, detail: `${quotaPools.length} 块池都在限度内` };
              })();
      const failedRoutes = st.routes.filter((r) => r.probe?.state === 'failed');
      const alive = st.routes.filter((r) => r.alive).length;
      const routesState =
        st.routes.length === 0 || st.routes.every((r) => r.probe === undefined)
          ? { state: 'unknown' as const, detail: '探针还没出过结论' }
          : failedRoutes.length > 0 || alive === 0
            ? {
                state: 'degraded' as const,
                detail:
                  failedRoutes.length > 0
                    ? `${failedRoutes.length} 条路由探不通；${alive} 条在线`
                    : '没有在线路由',
              }
            : { state: 'ok' as const, detail: `${alive} 条路由在线` };
      return HomeResponseSchema.parse({
        decisions,
        running,
        done,
        health: { quota: quotaState, routes: routesState, engine: mockEngine() },
        flow,
        slots: {
          running: st.pools.reduce((n, p) => n + poolRunning(p.id), 0),
          reserved: st.pools.reduce((n, p) => n + poolReserved(p.id), 0),
        },
        ...(resources ? { resources } : {}),
        asOf: iso(),
      });
    },
    async board(repoId) {
      await wait();
      return boardOf(repoId);
    },
    /**
     * 环境页（#820 片 1）的假数据：形状照真后端，值取自这份假库。
     * 引擎那一格跟着 ?mockEngine= 走（和主页同一处），版本一项照实写「没查成」——假后端没有发布目录，不拿 0 冒充。
     */
    async env() {
      await wait();
      const t = now();
      // 在跑的会话只数已开工、连得到池的（和真后端的池占用同一口径）；排着的算已选定还没开跑
      const activeRuns = allRuns().filter((r) => isRunning(r) && routeInfo(r.routeId).route !== undefined);
      const byStage: Record<string, number> = {};
      for (const r of activeRuns) byStage[r.stage] = (byStage[r.stage] ?? 0) + 1;
      const poolViews = st.pools.map((p) => {
        const windows = st.quota.filter((w) => w.poolId === p.id);
        return {
          running: poolRunning(p.id),
          reserved: poolReserved(p.id),
          quotaStatus:
            windows.length === 0
              ? 'unread'
              : windows.some((w) => t - Date.parse(w.readAt) > STALE_MS)
                ? 'stale'
                : 'fresh',
        };
      });
      return EnvResponseSchema.parse({
        name: { name: '假数据' },
        asOf: iso(),
        facts: {
          engine: { ok: true, value: mockEngine() },
          master: { ok: true, value: mockMaster() },
          version: { ok: false, reason: '假后端没有发布目录，读不到在用版本' },
          sessions: { ok: true, value: { total: activeRuns.length, byStage } },
          pools: {
            ok: true,
            value: {
              count: poolViews.length,
              running: poolViews.reduce((n, p) => n + p.running, 0),
              reserved: poolViews.reduce((n, p) => n + p.reserved, 0),
              unread: poolViews.filter((p) => p.quotaStatus === 'unread').length,
              stale: poolViews.filter((p) => p.quotaStatus === 'stale').length,
            },
          },
          health: { ok: true, value: { ok: true, total: 9, failing: [], notWired: ['deploy_lag'] } },
          schedule: { ok: true, value: { status: 'never' } },
        },
      });
    },
    /**
     * 看板多机（切换器）的假数据：一个叫 wsl 的远程环境（本机 WSL）。形状照真后端；快照取自这份假库、环境名换成「本机 WSL」。
     * 地址上加 ?mockNode=stale（失联 12 分钟）/ gone（失联 5 天 2 小时，法国页手机上默认折成一行）/ never（配了钥匙没推过）/ off（没有远程环境）看另外几种，默认是 1 分钟前刚报过。
     */
    async nodes() {
      await wait();
      const t = now();
      const mode = mockNodeMode();
      const engine = (await api.env()).facts.engine;
      const remote =
        mode === 'off'
          ? []
          : [
              mode === 'never'
                ? { id: 'wsl', name: 'wsl', freshness: 'never' as const }
                : {
                    id: 'wsl',
                    name: '本机 WSL',
                    freshness: mode === 'stale' || mode === 'gone' ? ('stale' as const) : ('fresh' as const),
                    receivedAt: new Date(t - mockNodeAgo(mode)).toISOString(),
                    reportedAt: new Date(t - mockNodeAgo(mode) - 1000).toISOString(),
                    codeSha: 'a0006685f092154f90b462cc74e8872d32e5',
                  },
            ];
      return NodesResponseSchema.parse({
        self: {
          name: '假数据',
          engine: engine.ok ? engine.value : { state: 'unknown', detail: engine.reason },
        },
        nodes: remote,
      });
    },
    async localSessions() {
      await wait();
      return mockLocalSessions(now());
    },
    async worktrees() {
      await wait();
      // 排队几秒后假装引擎接手、再过几秒做完（照真引擎：判据同一份，在用、有改动的一律拒）
      const t = now();
      mockCleanups = mockCleanups.map((c) => {
        const age = t - Date.parse(c.requestedAt);
        if (c.status === 'queued' && age > 2_000)
          return { ...c, status: 'running', startedAt: new Date(t).toISOString() };
        if (c.status === 'running' && age > 5_000) {
          return {
            ...c,
            status: 'done',
            doneAt: new Date(t).toISOString(),
            result: cleanupResultOf(mockWorktrees(t, [])),
          };
        }
        return c;
      });
      return mockWorktrees(t, mockCleanups);
    },
    async worktreeCleanup(body) {
      await wait();
      const engine = mockEngine();
      if (engine.state === 'off') throw new ApiError(409, 'engine_off', `清理不了：${engine.detail}`);
      if (engine.state !== 'on')
        throw new ApiError(503, `engine_${engine.state}`, `清理不了：${engine.detail}`);
      const busy = mockCleanups.find((c) => c.status === 'queued' || c.status === 'running');
      if (busy)
        throw new ApiError(409, 'cleanup_busy', `已经有一次清理在做（${busy.requestId}），等它做完再点`);
      const at = new Date(now()).toISOString();
      const requestId = nextId('cleanup');
      mockCleanups = [{ requestId, by: 'u-founder', requestedAt: at, status: 'queued' }, ...mockCleanups];
      void body;
      return { requestId, requestedAt: at };
    },
    async node(nodeId) {
      await wait();
      const mode = mockNodeMode();
      if (nodeId !== 'wsl' || mode === 'off') throw new ApiError(404, 'node_not_found', '没有这个环境');
      if (mode === 'never')
        throw new ApiError(404, 'node_never_reported', `环境 ${nodeId} 配了通行证，但一次快照都没推来过`);
      const t = now();
      const ago = mockNodeAgo(mode);
      const home = await api.home();
      const env = await api.env();
      return NodeDetailResponseSchema.parse({
        id: 'wsl',
        name: '本机 WSL',
        freshness: mode === 'stale' || mode === 'gone' ? 'stale' : 'fresh',
        receivedAt: new Date(t - ago).toISOString(),
        reportedAt: new Date(t - ago - 1000).toISOString(),
        codeSha: 'a0006685f092154f90b462cc74e8872d32e5',
        home: { ...home, running: home.running.slice(0, 2), decisions: home.decisions.slice(0, 1) },
        env: { ...env, name: { name: '本机 WSL' } },
      });
    },
    /**
     * 任务列表（#1639）：和真后端同一个拼法（分组 taskListGroupOf、段和模型 taskFlow、花费 summarizeUsage），
     * 少的是「状态变化时刻」这一项，假库没有 state_changes：最近更新 = 开单和这张单所有会话、流水时刻里最晚的。
     */
    async tasks(query) {
      await wait();
      const q = query?.q?.trim().toLowerCase();
      const issue = q === undefined ? null : /^#?(\d{1,9})$/.exec(q);
      const matching = st.tasks.filter(
        (t) =>
          (query?.repoId === undefined || t.task.repoId === query.repoId) &&
          (!q ||
            t.task.title.toLowerCase().includes(q) ||
            (issue !== null && t.task.issueNumber === Number(issue[1]))),
      );
      const counts = { running: 0, queued: 0, waiting: 0, done: 0, failed: 0, stopped: 0 };
      for (const t of matching) counts[taskListGroupOf(t.task)] += 1;
      const rows = matching
        .filter((t) => query?.status === undefined || taskListGroupOf(t.task) === query.status)
        .map((tv) => {
          const finished = TERMINAL.has(tv.task.state);
          const sessions = [...tv.runs, ...tv.subtasks.flatMap((s) => s.runs)].sort((a, b) =>
            a.queuedAt.localeCompare(b.queuedAt),
          );
          const views = (tv.segmentRuns ?? []).map((r) =>
            readSegmentRun(
              {
                ...r,
                modelName: st.models.find((m) => m.id === r.model)?.displayName ?? r.model,
                billing: st.channels.find((c) => c.id === r.channel)?.billing,
                matchedBy: 'task',
              },
              { taskFinished: finished },
            ),
          );
          const flow = taskFlow(tv.task, views);
          const started = views
            .filter((v) => v.startedAt !== undefined)
            .sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
          const lastSession = sessions.at(-1);
          const usage = summarizeUsage(
            sessions.map((r) => {
              const info = routeInfo(r.routeId);
              return {
                ...r,
                model: info.route?.modelId ?? r.routeId,
                modelName: info.modelName,
                billing: info.billing,
              };
            }),
            views,
          ).total;
          const cost = taskListCost(usage, views.filter((v) => !v.running).length);
          const times = [
            tv.task.createdAt,
            ...sessions.flatMap((r) => [r.queuedAt, r.startedAt, r.endedAt]),
            ...views.flatMap((v) => [v.startedAt, v.endedAt]),
          ].filter((x): x is string => x !== undefined);
          const updatedAt = times.reduce((a, b) => (b > a ? b : a));
          return {
            id: tv.task.id,
            row: {
              taskId: tv.task.id,
              repoId: tv.task.repoId,
              repo: (({ owner, name }) => `${owner}/${name}`)(repoView(tv.task.repoId)),
              issueNumber: tv.task.issueNumber,
              title: tv.task.title,
              state: tv.task.state,
              ...(tv.task.paused === undefined ? {} : { paused: tv.task.paused }),
              group: taskListGroupOf(tv.task),
              segment: finished ? null : flow.segment,
              model:
                flow.worker ??
                started.at(-1)?.modelName ??
                (lastSession ? routeInfo(lastSession.routeId).modelName : null),
              createdAt: tv.task.createdAt,
              updatedAt,
              cost,
              prNumber: [...started].reverse().find((v) => v.prNumber !== undefined)?.prNumber ?? null,
            },
          };
        });
      const sliced = page(
        rows.map((r) => ({ id: r.id, at: r.row.updatedAt, row: r.row })),
        (r) => r.at,
        query?.cursor,
        query?.limit ?? 50,
      );
      return TaskListResponse.parse({
        items: sliced.items.map((r) => r.row),
        counts: { all: matching.length, ...counts },
        ...(sliced.nextCursor === undefined ? {} : { nextCursor: sliced.nextCursor }),
      });
    },
    async task(taskId) {
      await wait();
      const tv = findTask(taskId);
      const runs = [...tv.runs, ...tv.subtasks.flatMap((s) => s.runs)];
      // 三段的流水和真后端 segmentRunViews 一个读法（shared 的 readSegmentRun）：模型名查目录、计费方式查渠道
      const finished = TERMINAL.has(tv.task.state);
      const segmentRuns = (tv.segmentRuns ?? []).map((r) =>
        readSegmentRun(
          {
            ...r,
            modelName: st.models.find((m) => m.id === r.model)?.displayName ?? r.model,
            billing: st.channels.find((c) => c.id === r.channel)?.billing,
            matchedBy: r.taskId === undefined ? 'issueNumber' : 'task',
          },
          { taskFinished: finished },
        ),
      );
      return TaskDetailResponse.parse({
        task: tv.task,
        repo: repoView(tv.task.repoId),
        subtasks: tv.subtasks.map(subtaskView),
        runs: runs.map(runView),
        segmentRuns,
        routePins: { pins: tv.routePins ?? [] },
        // 和真后端同一个算法（shared 的 usage.ts）：按路由上的模型记，花费按渠道的计费方式分
        usage: summarizeUsage(
          [...runs]
            .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))
            .map((r) => {
              const info = routeInfo(r.routeId);
              return {
                ...r,
                model: info.route?.modelId ?? r.routeId,
                modelName: info.modelName,
                billing: info.billing,
              };
            }),
          segmentRuns,
        ),
      });
    },
    async runTranscript(taskId, runId, query) {
      await wait();
      const tv = findTask(taskId);
      const seg = (tv.segmentRuns ?? []).find((r) => r.id === runId);
      if (!seg) throw new ApiError(404, 'run_not_found', '这张单下没有这一段');
      if (mockTranscriptFail.has(runId)) {
        throw new ApiError(503, 'run_transcript_unreadable', '没读成：connection terminated');
      }
      const all = transcripts.byRun.get(runId) ?? [];
      // 在跑的段：先放出一部分，每被读一次多放几条（演示增量刷新）
      const live = transcripts.live.has(runId);
      const shown = live ? Math.min(all.length, revealed.get(runId) ?? LIVE_FIRST_REVEAL) : all.length;
      if (live) revealed.set(runId, Math.min(all.length, shown + LIVE_REVEAL_STEP));
      const after = query?.after;
      const limit = query?.limit ?? 200;
      const rest = all.slice(0, shown).filter((e) => after === undefined || e.seq > after);
      const entries = rest.slice(0, limit);
      const ended = seg.endedAt !== undefined;
      return RunTranscriptResponse.parse({
        entries,
        nextAfter: entries.at(-1)?.seq ?? after ?? null,
        done: ended && rest.length <= limit,
        noRecord: ended && all.length === 0,
      });
    },
    async updateTaskRoutePin(taskId, raw) {
      await wait();
      const body = UpdateTaskRoutePinRequest.parse(raw);
      const tv = findTask(taskId);
      if (TERMINAL.has(tv.task.state)) {
        throw new ApiError(409, 'task_finished', `任务已经结束（${tv.task.state}），不用再指定模型`);
      }
      // 「现在就换」（#1216）和真后端同样先核：只有动手段；单子在跑、没暂停、动手这一段开着。不行 409、什么都不改
      if (body.now) {
        const no = (code: string, why: string) => {
          throw new ApiError(409, code, `${why}去掉「现在就换」只改指定，下一次选路起生效`);
        };
        if (body.segment !== 'manual')
          no('repin_segment_unsupported', '验收这一段不能「现在就换」：它不在能当场停下重跑的那条路上。');
        if (tv.task.state !== 'running')
          no('task_not_running', `这张单现在不在跑（${tv.task.state}），没有正在跑的动手会话可换。`);
        if (tv.task.paused !== undefined)
          no('task_paused', `这张单已经暂停了（${tv.task.paused}），没有正在跑的动手会话。`);
        const open = (tv.segmentRuns ?? []).filter((r) => r.endedAt === undefined && r.outcome === undefined);
        if (!open.some((r) => r.segment === 'manual')) {
          no(
            'segment_not_running',
            open.length > 0
              ? `在跑的是「${[...new Set(open.map((r) => r.segment))].join('、')}」，不是动手这一段，没有正在跑的动手会话可换。`
              : '动手这一段现在没有在跑的会话（库里没有开着的一笔）。',
          );
        }
      }
      // 和真后端（db 的 setTaskRoutePin）同样核对：模型在目录里、钉的路由是这个模型的
      if (body.modelId !== null) {
        const model = st.models.find((m) => m.id === body.modelId);
        if (!model) throw new ApiError(422, 'route_pin_invalid', `模型目录里没有「${body.modelId}」`);
        const route = body.routeId ? st.routes.find((r) => r.id === body.routeId) : undefined;
        if (body.routeId && route?.modelId !== body.modelId) {
          throw new ApiError(422, 'route_pin_invalid', `路由「${body.routeId}」不是 ${body.modelId} 的`);
        }
      }
      const before = tv.routePins?.find((p) => p.segment === body.segment);
      const after = UpdateTaskRoutePinResponse.parse({
        segment: body.segment,
        ...(body.modelId ? { modelId: body.modelId } : {}),
        ...(body.modelId && body.routeId ? { routeId: body.routeId } : {}),
        setBy: st.me.user.id,
        setAt: iso(),
        ...(body.reason?.trim() ? { reason: body.reason.trim() } : {}),
      });
      tv.routePins = [...(tv.routePins ?? []).filter((p) => p.segment !== body.segment), after].sort((a, b) =>
        a.segment.localeCompare(b.segment),
      );
      audit({
        actor: meActor(),
        action: body.modelId === null ? 'task.routePin.clear' : 'task.routePin.set',
        target: `task:${taskId}`,
        before: { segment: body.segment, pin: before ? { modelId: before.modelId ?? null } : null },
        after: {
          segment: body.segment,
          pin: { modelId: after.modelId ?? null, routeId: after.routeId ?? null },
        },
        via: 'cockpit',
      });
      if (body.now) {
        audit({
          actor: meActor(),
          action: 'task.repin',
          target: `task:${taskId}`,
          after: { segment: body.segment },
          via: 'cockpit',
        });
      }
      emit('tasks', taskId);
      return after;
    },
    async taskAction(taskId, raw) {
      await wait();
      const body = TaskActionRequest.parse(raw);
      const tv = findTask(taskId);
      if (body.action === 'redo') {
        if (tv.task.state === 'stalled') {
          throw new ApiError(409, 'redo_refused', '上一代还在跑，先叫停再重做');
        }
        if (tv.task.state !== 'stopped') {
          throw new ApiError(
            409,
            'redo_not_allowed',
            `这张单现在是${tv.task.state}，只有已叫停或挂起的才能重做`,
          );
        }
        setTaskState(tv, 'running');
        audit({
          actor: meActor(),
          action: 'task.redo',
          target: `task:${taskId}`,
          via: 'cockpit',
        });
        emit('tasks', taskId);
        return;
      }
      if (TERMINAL.has(tv.task.state)) {
        throw new ApiError(
          409,
          'task_finished',
          `任务已经结束（${tv.task.state}），不能再${ACTION_WORDS[body.action]}`,
        );
      }
      const actor = meActor();
      switch (body.action) {
        case 'pause':
          if (tv.task.paused !== undefined) {
            throw new ApiError(
              409,
              'already_paused',
              `这张单已经暂停了（${tv.task.paused}），点「继续」接着走`,
            );
          }
          tv.paused = true;
          tv.task.paused = `已暂停：被人暂停（${actor.name}）${body.reason ? `：${body.reason}` : ''}`;
          for (const s of tv.subtasks) s.paused = true;
          log(tv, { source: 'person', kind: 'pause', text: body.reason ? `暂停：${body.reason}` : '暂停' });
          break;
        case 'resume':
          tv.paused = false;
          delete tv.task.paused;
          for (const s of tv.subtasks) s.paused = false;
          log(tv, { source: 'person', kind: 'resume', text: '继续' });
          break;
        case 'stop':
          for (const r of tv.runs) if (!r.endedAt) endRun(r, 'stopped');
          for (const s of tv.subtasks) {
            for (const r of s.runs) if (!r.endedAt) endRun(r, 'stopped');
            if (s.subtask.state !== 'merged') setSubState(tv, s, 'stopped');
          }
          tv.paused = false;
          delete tv.task.paused;
          setTaskState(tv, 'stopped');
          log(tv, { source: 'person', kind: 'stop', text: body.reason ? `叫停：${body.reason}` : '叫停' });
          break;
        case 'reroute': {
          const pool = [...tv.runs, ...tv.subtasks.flatMap((s) => s.runs)].filter(
            (r) => !r.endedAt && (body.subtaskId === undefined || r.subtaskId === body.subtaskId),
          );
          const target = latestActive(pool);
          if (!target) throw new ApiError(409, 'no_active_run', '这个任务现在没有在跑的会话，没法换路由');
          const problem = routeProblem(body.routeId, target.stage);
          if (problem) throw new ApiError(422, 'route_not_allowed', problem);
          if (!routeInfo(body.routeId).route?.alive)
            throw new ApiError(422, 'route_offline', '这条路由现在不在线');
          endRun(target, 'stopped');
          const sv = tv.subtasks.find((s) => s.subtask.id === target.subtaskId);
          const model = routeInfo(body.routeId).modelName;
          const r = startRun(tv, sv, target.stage, body.routeId, `${actor.name}手动换成 ${model}`);
          if (sv && (sv.subtask.state === 'stalled' || sv.subtask.state === 'failed'))
            setSubState(tv, sv, 'running');
          if (tv.task.state === 'stalled' || tv.task.state === 'failed') setTaskState(tv, 'running');
          log(tv, {
            source: 'person',
            kind: 'reroute',
            runId: r.id,
            text: `换路由：${body.reason ?? `换成 ${model}`}`,
          });
          break;
        }
      }
      const { action, ...detail } = body;
      audit({
        actor,
        action: `task.${action}`,
        target: `task:${taskId}`,
        after: detail,
        via: 'cockpit',
        ...('reason' in body && body.reason ? { reason: body.reason } : {}),
      });
      emit('tasks', taskId);
    },
    async routing() {
      await wait();
      return RoutingResponse.parse({
        channels: st.channels,
        channelStates: st.channelStates,
        pools: st.pools,
        models: st.models,
        routes: st.routes,
        hardBans: HARD_BANS.map(({ id, reason }) => ({ id, reason })),
        bans: st.bans,
      });
    },
    async routingLayers() {
      await wait();
      const t = now();
      // 假数据的路由两层就是 st.purposes / st.routing（和真后端那两张表一个形状）：没配的用途照真后端写成缺口。
      // 只列流程里真在用的用途（shared 的 ROUTING_PURPOSE_IDS），和真接口同一份。
      const purposes = ROUTING_PURPOSE_IDS.map((purpose) => {
        const modelIds = st.purposes[purpose] ?? [];
        if (modelIds.length === 0) {
          return {
            purpose,
            version: purposeVersion.get(purpose) ?? 0,
            verdict: 'dead' as const,
            problems: ['这个用途没有模型，派不了'],
            models: [],
          };
        }
        const models = modelIds.map((modelId) => {
          const model = st.models.find((m) => m.id === modelId);
          const routes = (st.routing[modelId] ?? [])
            .flatMap((routeId) => st.routes.find((r) => r.id === routeId) ?? [])
            .map((r) => mockRouteLiveness(r, purpose, t));
          const effort = purposeEffort.get(slotKey(purpose, modelId));
          return {
            modelId,
            displayName: model?.displayName ?? modelId,
            ...(model ? { family: model.family } : {}),
            verdict: layerVerdict(routes.map((r) => r.verdict)),
            routes,
            ...(effort ? { effort } : {}),
          };
        });
        return {
          purpose,
          version: purposeVersion.get(purpose) ?? 0,
          verdict: layerVerdict(models.map((m) => m.verdict)),
          problems: [],
          models,
        };
      });
      const manual = [...manualKeys.entries()].flatMap(([channelId, keys]) => {
        if (keys.length === 0) return [];
        const channel = st.channels.find((c) => c.id === channelId);
        return [{ channelId, channelName: channel?.name ?? channelId, count: keys.length }];
      });
      return RoutingLayersResponse.parse({
        asOf: iso(),
        purposes,
        manualTracks: [
          {
            modelId: 'opus-5.5',
            modelName: 'Opus 5.5',
            tier: 'heavyweight',
            onePass: 2,
            tasks: 4,
            lower: 0.31,
            notDone: 1,
            avgMinutes: 48,
          },
        ],
        // 假数据没有渠道名册：差集按空写。个数用目录里的模型数，两边一样，页面才能写出各几个。
        modelRoster: {
          missingFromCatalog: [],
          goneRoutes: [],
          failed: [],
          notYet: [],
          channelModelCount: st.models.length,
          catalogCount: st.models.length,
          ...(manual.length > 0 ? { manual } : {}),
        },
      });
    },
    async routingEfforts() {
      await wait();
      // 假数据没有上游模型串：能配哪几档按模型编号判（cursor 的 auto 这类整串照样配不了），判法照 shared 的 effort.ts
      const modelIds = [...new Set(st.routes.map((r) => r.modelId))].sort();
      const models = modelIds.map((modelId) => {
        const model = st.models.find((m) => m.id === modelId);
        return {
          modelId,
          displayName: model?.displayName ?? modelId,
          ...(model ? { family: model.family } : {}),
          routes: st.routes
            .filter((r) => r.modelId === modelId)
            .map((r) => {
              const choices = routeEffortChoices(r.hostId, r.modelId);
              const effort = mockEfforts.get(r.id);
              return {
                routeId: r.id,
                channelId: r.channelId,
                channelName: st.channels.find((c) => c.id === r.channelId)?.name ?? r.channelId,
                poolId: r.poolId,
                hostId: r.hostId,
                model: r.modelId,
                enabled: !switchedOff.has(r.id),
                ...(effort ? { effort } : {}),
                choices: choices.kind === 'choices' ? [...choices.values] : [],
                ...(choices.kind === 'fixed' ? { fixed: choices.why } : {}),
              };
            }),
        };
      });
      return RoutingEffortsResponse.parse({ defaultEffort: DEFAULT_SESSION_EFFORT, models });
    },
    async routeProbeHistory() {
      await wait();
      return mockProbeHistory(st.routes);
    },
    async routeProbeStatus() {
      await wait();
      advanceMockProbes();
      const { requests } = foldRouteProbeRequests(mockProbeRows(), new Date(now()));
      return RouteProbeStatusResponse.parse({ asOf: iso(), engine: { state: 'on' }, requests });
    },
    async routeProbeNow(raw) {
      await wait();
      const body = RouteProbeNowRequest.parse(raw);
      const missing = (body.routeIds ?? []).filter((id) => !st.routes.some((r) => r.id === id));
      if (missing.length > 0)
        throw new ApiError(404, 'route_not_found', `没有这条路由：${missing.join('、')}`);
      const requestId = nextId('probe');
      const routeIds = body.routeIds ? [...new Set(body.routeIds)] : null;
      audit({
        actor: meActor(),
        action: ROUTE_PROBE_ACTION.request,
        target: ROUTE_PROBE_TARGET,
        after: { requestId, routeIds },
        via: 'cockpit',
        reason: routeIds ? `点了立即探测（${routeIds.length} 条）` : '点了全部立即探测',
      });
      return RouteProbeNowResponse.parse({
        request: {
          requestId,
          requestedAt: iso(),
          by: st.me.user.id,
          ...(routeIds ? { routeIds } : {}),
          state: 'queued',
          results: [],
        },
        engine: { state: 'on' },
      });
    },
    async updateRouteEffort(modelId, routeId, raw) {
      await wait();
      const body = UpdateRouteEffortRequest.parse(raw);
      const route = st.routes.find((r) => r.id === routeId && r.modelId === modelId);
      if (!route) {
        throw new ApiError(404, 'route_not_found', `模型 ${modelId} 下没有路由 ${routeId}（路由两层里没挂）`);
      }
      if (body.effort !== null) {
        const problem = routeEffortProblem(route.hostId, route.modelId, body.effort);
        if (problem) throw new ApiError(422, 'effort_not_allowed', problem);
      }
      const current = mockEfforts.get(routeId) ?? null;
      if (current !== body.expected) {
        throw new ApiError(409, 'conflict', '这条路由的档位刚被别人改过，刷新后再改', { current });
      }
      if (body.effort === null) mockEfforts.delete(routeId);
      else mockEfforts.set(routeId, body.effort);
      audit({
        actor: meActor(),
        action: 'routing.effort.update',
        target: `route:${routeId}`,
        before: { modelId, effort: current },
        after: { modelId, effort: body.effort },
        via: 'cockpit',
        ...(body.reason ? { reason: body.reason } : {}),
      });
      return UpdateRouteEffortResponse.parse({
        modelId,
        routeId,
        ...(body.effort === null ? {} : { effort: body.effort }),
      });
    },
    async movePurposeModel(purposeParam, modelId, raw) {
      await wait();
      const body = MovePurposeModelRequest.parse(raw);
      const purpose = StageKindSchema.safeParse(purposeParam);
      if (!purpose.success) throw new ApiError(404, 'purpose_not_found', `没有这个用途：${purposeParam}`);
      const list = st.purposes[purpose.data] ?? [];
      const order =
        'order' in body
          ? mockReorder(
              list,
              modelId,
              body.order,
              body.expected,
              `用途 ${purpose.data} `,
              '模型',
              'model_not_found',
            )
          : mockMove(list, modelId, body, `用途 ${purpose.data} `, '模型', 'model_not_found');
      const changed = order.before.some((id, i) => id !== order.after[i]);
      if (changed) {
        st.purposes[purpose.data] = order.after;
        audit({
          actor: meActor(),
          action: 'routing.order.move',
          target: `stage:${purpose.data}`,
          before: { order: order.before },
          after: {
            order: order.after,
            moved: modelId,
            ...('direction' in body ? { direction: body.direction } : {}),
          },
          via: 'cockpit',
          ...(body.reason ? { reason: body.reason } : {}),
        });
      }
      return MovePurposeModelResponse.parse({ purpose: purpose.data, order: order.after });
    },
    async addPurposeModel(purposeParam, raw) {
      await wait();
      const body = AddPurposeModelRequest.parse(raw);
      const purpose = purposeOr404(purposeParam);
      assertPurposeVersion(purpose, body.version);
      const model = catalogModel(body.modelId);
      assertFounderCanWrite(model);
      const list = [...(st.purposes[purpose] ?? [])];
      if (list.includes(body.modelId)) {
        throw new ApiError(409, 'already_in_purpose', `模型 ${body.modelId} 已经在用途 ${purpose} 里`);
      }
      const position = body.position ?? list.length;
      if (!Number.isInteger(position) || position < 0 || position > list.length) {
        throw new ApiError(
          422,
          'position_invalid',
          `位置 ${String(position)} 不在 0 到 ${list.length} 之间（${list.length} 是接到末尾）`,
        );
      }
      const effort = body.effort ?? null;
      assertPurposeEffort(body.modelId, effort);
      const ban = hardBanFor(model, purpose);
      if (ban) throw new ApiError(422, 'model_not_allowed', ban.reason);
      list.splice(position, 0, body.modelId);
      st.purposes[purpose] = list;
      if (effort === null) purposeEffort.delete(slotKey(purpose, body.modelId));
      else purposeEffort.set(slotKey(purpose, body.modelId), effort);
      const version = bumpPurpose(purpose);
      audit({
        actor: meActor(),
        action: 'routing.purpose.add',
        target: `stage:${purpose}`,
        after: { modelId: body.modelId, position, effort },
        via: 'cockpit',
        ...(body.reason ? { reason: body.reason } : {}),
      });
      return PurposeMembershipResponse.parse({ purpose, version, order: membershipOrder(purpose) });
    },
    async removePurposeModel(purposeParam, modelId, raw) {
      await wait();
      const body = RemovePurposeModelRequest.parse(raw);
      const purpose = purposeOr404(purposeParam);
      assertPurposeVersion(purpose, body.version);
      const list = [...(st.purposes[purpose] ?? [])];
      if (!list.includes(modelId)) {
        throw new ApiError(404, 'model_not_found', `用途 ${purpose} 下没有模型 ${modelId}`);
      }
      st.purposes[purpose] = list.filter((id) => id !== modelId);
      purposeEffort.delete(slotKey(purpose, modelId));
      const version = bumpPurpose(purpose);
      audit({
        actor: meActor(),
        action: 'routing.purpose.remove',
        target: `stage:${purpose}`,
        after: { modelId },
        via: 'cockpit',
        ...(body.reason ? { reason: body.reason } : {}),
      });
      return PurposeMembershipResponse.parse({ purpose, version, order: membershipOrder(purpose) });
    },
    async setPurposeModelEffort(purposeParam, modelId, raw) {
      await wait();
      const body = SetPurposeModelEffortRequest.parse(raw);
      const purpose = purposeOr404(purposeParam);
      assertPurposeVersion(purpose, body.version);
      const list = st.purposes[purpose] ?? [];
      if (!list.includes(modelId)) {
        throw new ApiError(404, 'model_not_found', `用途 ${purpose} 下没有模型 ${modelId}`);
      }
      assertPurposeEffort(modelId, body.effort);
      if (body.effort === null) purposeEffort.delete(slotKey(purpose, modelId));
      else purposeEffort.set(slotKey(purpose, modelId), body.effort);
      const version = bumpPurpose(purpose);
      audit({
        actor: meActor(),
        action: 'routing.purpose.effort',
        target: `stage:${purpose}`,
        after: { modelId, effort: body.effort },
        via: 'cockpit',
        ...(body.reason ? { reason: body.reason } : {}),
      });
      return PurposeMembershipResponse.parse({ purpose, version, order: membershipOrder(purpose) });
    },
    async updateModelRoute(modelId, routeId, raw) {
      await wait();
      const body = UpdateModelRouteRequest.parse(raw);
      const list = st.routing[modelId] ?? [];
      if (!list.includes(routeId)) {
        throw new ApiError(404, 'route_not_found', `模型 ${modelId} 下没有路由 ${routeId}（路由两层里没挂）`);
      }
      if (body.op === 'enable') {
        const current = !switchedOff.has(routeId);
        if (current !== body.expected) {
          throw new ApiError(409, 'conflict', '这条路由的开关刚被别人改过，刷新后再改', { current });
        }
        if (body.enabled) switchedOff.delete(routeId);
        else switchedOff.add(routeId);
        audit({
          actor: meActor(),
          action: 'routing.route.enable',
          target: `route:${routeId}`,
          before: { modelId, enabled: current },
          after: { modelId, enabled: body.enabled },
          via: 'cockpit',
          ...(body.reason ? { reason: body.reason } : {}),
        });
        return UpdateModelRouteResponse.parse({ modelId, routeId, enabled: body.enabled });
      }
      const order =
        body.op === 'reorder'
          ? mockReorder(
              list,
              routeId,
              body.order,
              body.expected,
              `模型 ${modelId} `,
              '路由',
              'route_not_found',
            )
          : mockMove(list, routeId, body, `模型 ${modelId} `, '路由', 'route_not_found');
      const changed = order.before.some((id, i) => id !== order.after[i]);
      if (changed) {
        st.routing[modelId] = order.after;
        audit({
          actor: meActor(),
          action: 'routing.order.move',
          target: `model:${modelId}`,
          before: { order: order.before },
          after: {
            order: order.after,
            moved: routeId,
            ...(body.op === 'move' ? { direction: body.direction } : {}),
          },
          via: 'cockpit',
          ...(body.reason ? { reason: body.reason } : {}),
        });
      }
      return UpdateModelRouteResponse.parse({ modelId, routeId, order: order.after });
    },
    async setModelEnabled(modelId, raw) {
      await wait();
      const body = SetModelEnabledRequest.parse(raw);
      const list = st.routing[modelId] ?? [];
      if (list.length === 0) {
        throw new ApiError(404, 'model_not_found', `模型 ${modelId} 下没有路由（路由两层里没挂）`);
      }
      const before = list.filter((id) => !switchedOff.has(id));
      if (!sameIdSet(before, body.expectedEnabled)) {
        throw new ApiError(409, 'conflict', '这个模型的开关刚被别人改过，刷新后再改', { current: before });
      }
      for (const id of list) {
        if (body.enabled) switchedOff.delete(id);
        else switchedOff.add(id);
      }
      const after = body.enabled ? [...list] : [];
      audit({
        actor: meActor(),
        action: 'routing.model.enable',
        target: `model:${modelId}`,
        before: { enabledRouteIds: before },
        after: { enabled: body.enabled, enabledRouteIds: after },
        via: 'cockpit',
        ...(body.reason ? { reason: body.reason } : {}),
      });
      return SetModelEnabledResponse.parse({ modelId, enabled: body.enabled, enabledRouteIds: after });
    },
    async setChannelEnabled(channelId, raw) {
      await wait();
      const body = SetChannelEnabledRequest.parse(raw);
      const channel = st.channels.find((c) => c.id === channelId);
      if (!channel) throw new ApiError(404, 'channel_not_found', `没有这个渠道：${channelId}`);
      if (channel.enabled !== body.expected) {
        throw new ApiError(409, 'conflict', '这个渠道的开关刚被别人改过，刷新后再改', {
          current: channel.enabled,
        });
      }
      channel.enabled = body.enabled;
      audit({
        actor: meActor(),
        action: body.enabled ? 'channel.enable' : 'channel.disable',
        target: `channel:${channelId}`,
        before: { enabled: body.expected },
        after: { enabled: body.enabled },
        via: 'cockpit',
        ...(body.reason ? { reason: body.reason } : {}),
      });
      return SetChannelEnabledResponse.parse({ channelId, enabled: body.enabled });
    },
    async registerChannelModel(channelId, raw) {
      await wait();
      const body = ManualModelRequest.parse(raw);
      handChannel(channelId);
      const keys = manualKeys.get(channelId) ?? [];
      if (keys.includes(body.modelKey)) throw new ApiError(409, 'already_registered', '这个模型串已经登记过');
      const next = [...keys, body.modelKey];
      manualKeys.set(channelId, next);
      audit({
        actor: meActor(),
        action: 'catalog.manual.register',
        target: `channel:${channelId}`,
        after: { modelKey: body.modelKey, count: next.length },
        via: 'cockpit',
        ...(body.reason ? { reason: body.reason } : {}),
      });
      return ManualModelResponse.parse({
        channelId,
        modelKey: body.modelKey,
        source: '手工',
        count: next.length,
      });
    },
    async revokeChannelModel(channelId, raw) {
      await wait();
      const body = ManualModelRequest.parse(raw);
      handChannel(channelId);
      const keys = manualKeys.get(channelId) ?? [];
      if (!keys.includes(body.modelKey)) throw new ApiError(404, 'not_registered', '没有这条手工登记');
      const next = keys.filter((key) => key !== body.modelKey);
      manualKeys.set(channelId, next);
      audit({
        actor: meActor(),
        action: 'catalog.manual.revoke',
        target: `channel:${channelId}`,
        after: { modelKey: body.modelKey, count: next.length },
        via: 'cockpit',
        ...(body.reason ? { reason: body.reason } : {}),
      });
      return ManualModelResponse.parse({
        channelId,
        modelKey: body.modelKey,
        source: '手工',
        count: next.length,
      });
    },
    async pools() {
      await wait();
      const t = now();
      return PoolsResponse.parse({
        pools: st.pools.map((p) => {
          const ch = st.channels.find((c) => c.id === p.channelId);
          const windows = st.quota
            .filter((w) => w.poolId === p.id)
            .map(({ poolId: _p, ...w }) => ({ ...w, stale: t - Date.parse(w.readAt) > STALE_MS }));
          return {
            ...p,
            channelName: ch?.name ?? '未知渠道（库里查不到）',
            billing: ch?.billing ?? null,
            channelEnabled: ch?.enabled ?? false,
            running: poolRunning(p.id),
            reserved: poolReserved(p.id),
            quotaStatus: windows.length === 0 ? 'unread' : windows.some((w) => w.stale) ? 'stale' : 'fresh',
            windows,
          };
        }),
        staleAfterMinutes: STALE_MS / 60_000,
        asOf: iso(),
      });
    },
    async poolHolds() {
      await wait();
      return PoolHoldsResponse.parse(
        poolHoldsView(
          st.settings.find((s) => s.key === POOL_HOLDS_SETTING),
          { ok: true, alerts: st.notifications },
          new Date(now()),
        ),
      );
    },
    async jobs() {
      await wait();
      const t = now();
      return JobsResponse.parse({
        jobs: st.jobs.map(({ nextRunAt: _n, keepsFailing: _k, ...j }) => {
          let status: 'fresh' | 'overdue' | 'never' = 'never';
          if (j.lastSuccessAt) {
            status = t - Date.parse(j.lastSuccessAt) > j.expectEveryMinutes * 60_000 ? 'overdue' : 'fresh';
          }
          return { ...j, status };
        }),
        asOf: iso(),
      });
    },
    async notifications(query) {
      await wait();
      const status = query?.status ?? 'open';
      const items = st.notifications.filter((n) => status === 'all' || !n.resolvedAt);
      const res = page(items, (n) => n.createdAt, query?.cursor, query?.limit ?? 50);
      const counts = { decision: 0, alert: 0, daily: 0 };
      for (const n of items) counts[n.level] += 1;
      return NotificationsResponse.parse({ ...res, counts });
    },
    async resolveNotification(id) {
      await wait();
      const n = st.notifications.find((x) => x.id === id);
      if (!n) throw new ApiError(404, 'notification_not_found', '没有这条通知');
      n.resolvedAt = iso();
      n.resolvedBy = st.me.user.id;
      audit({
        actor: meActor(),
        action: 'notification.resolve',
        target: `notification:${id}`,
        via: 'cockpit',
      });
      emit('notifications', id);
    },
    async answerNotification(id, raw) {
      await wait();
      const body = AnswerNotificationRequest.parse(raw);
      const n = st.notifications.find((x) => x.id === id);
      if (!n) throw new ApiError(404, 'notification_not_found', '没有这条通知');
      if (n.level !== 'decision')
        throw new ApiError(409, 'notification_not_decision', '这条不是要你拍的，没有答案可记');
      if (n.resolvedAt)
        throw new ApiError(409, 'notification_already_resolved', '这条已经处理过了，答案没改');
      const picked = body.optionId === undefined ? undefined : n.options?.find((o) => o.id === body.optionId);
      if (body.optionId !== undefined && !picked)
        throw new ApiError(400, 'unknown_option', '这条通知里没有这个选项');
      const at = iso();
      const answer = picked
        ? { optionId: picked.id, text: picked.label, at, by: st.me.user.id }
        : { text: body.text ?? '', at, by: st.me.user.id };
      n.answer = answer;
      // 选了要留着的项（keepsOpen）只记答案，通知照旧开着（和后端同一个判法）
      if (answerResolves(n.options, body.optionId)) {
        n.resolvedAt = at;
        n.resolvedBy = st.me.user.id;
      }
      audit({
        actor: meActor(),
        action: 'notification.answer',
        target: `notification:${id}`,
        via: 'cockpit',
      });
      emit('notifications', id);
      // 假数据没有 GitHub：照实说没交出去，不冒充记上了
      const notWired = { ok: false as const, why: '假数据：没接 GitHub，没记到进度单' };
      return AnswerNotificationResponse.parse({
        ok: true,
        answer,
        handoff: { progress: notWired, ...(n.taskId ? { task: notWired } : {}) },
      });
    },
    async audit(query) {
      await wait();
      const items = st.audit.filter((a) => query?.target === undefined || a.target === query.target);
      return AuditResponse.parse(page(items, (a) => a.at, query?.cursor, query?.limit ?? 50));
    },
    async settings() {
      await wait();
      return SettingsResponse.parse({
        settings: Object.keys(SETTING_SCHEMAS).map(
          (key) => st.settings.find((s) => s.key === key) ?? { key, value: null, version: 0 },
        ),
      });
    },
    async updateSetting(key, raw) {
      await wait();
      if (!Object.hasOwn(SETTING_SCHEMAS, key)) throw new ApiError(404, 'setting_not_found', '没有这项设置');
      const body = UpdateSettingRequest.parse(raw);
      const current = st.settings.find((s) => s.key === key) ?? { key, value: null, version: 0 };
      if (current.version !== body.version)
        throw new ApiError(409, 'conflict', '这项设置刚被别人改过，刷新后再改');
      // 整池暂停：新写的必须过格式；认不出的原样没改才留（和后端同一条判法）。撤回、续期必须写原因。
      let stored: unknown;
      if (key === POOL_HOLDS_SETTING) {
        const accepted = acceptPoolHoldsWrite(current.value, body.value);
        if (!accepted.ok) throw new ApiError(400, 'invalid_request', accepted.message);
        const missing = revocationProblem(current.value, accepted.value, body.reason);
        if (missing) throw new ApiError(400, 'reason_required', missing);
        stored = accepted.value;
      } else {
        const schema: z.ZodType = SETTING_SCHEMAS[key as SettingKey];
        const value = schema.safeParse(body.value);
        if (!value.success)
          throw new ApiError(400, 'invalid_request', '设置的值不符合约定', value.error.issues);
        stored = value.data;
      }
      const next = {
        key,
        value: stored,
        version: current.version + 1,
        updatedAt: iso(),
        updatedBy: st.me.user.id,
      };
      st.settings = [...st.settings.filter((s) => s.key !== key), next];
      audit({
        actor: meActor(),
        action: 'setting.update',
        target: `setting:${key}`,
        before: current.value,
        after: stored,
        via: 'cockpit',
        ...(body.reason ? { reason: body.reason } : {}),
      });
      emit('settings', key);
      return UpdateSettingResponse.parse({ setting: next }).setting;
    },
    async franceReleaseState() {
      await wait();
      // 假数据：这台后端不是法国，装作「没在走」（开发 mock 看到的就是这个；真法国机器装的是正式环境）。
      return FranceReleaseStateSchema.parse({ state: 'idle', asOf: iso() });
    },
    async franceReleaseCard() {
      await wait();
      // 假数据：主线比线上多 7 个提交、CI 绿；真数据由法国那台的后端现读 GitHub 和发布目录。
      const ago = (min: number) => new Date(now() - min * 60_000).toISOString();
      const head = '2005b2909c4f8e0a1d3e5f7a9b1c3d5e7f9a1b3c';
      const live = '6896b3cb4d2e8f0a1b3c5d7e9f1a3b5c7d9e1f3a';
      return ReleaseCardSchema.parse({
        mainline: {
          state: 'ok',
          commit: { sha: head, short: head.slice(0, 12), title: '刷新 CI 测试耗时表 (#1230)', at: ago(12) },
          ci: { state: 'green' },
        },
        deployed: {
          state: 'ok',
          sha: live,
          short: live.slice(0, 12),
          title: '探针每次结论落一条历史 (#1225)',
          titleWhy: null,
          deployedAt: ago(60 * 5),
          deployedAtWhy: null,
        },
        gap: {
          state: 'ahead',
          count: 7,
          prs: [
            { number: 1230, title: '刷新 CI 测试耗时表' },
            { number: 1229, title: '单任务暂停与恢复片 3：任务页暂停继续叫停按钮' },
            { number: 1228, title: '额度读取：两个池读登录文件改以会话用户身份读' },
            { number: 1226, title: '每周刷新 CI 测试耗时表：只取 PR 触发的全量运行日志' },
            { number: 1224, title: '路由页：渠道开关改写入口' },
          ],
          nonPr: 0,
        },
        lastDone: {
          state: 'ok',
          pr: { number: 1230, title: '刷新 CI 测试耗时表', mergedAt: ago(12) },
          issue: { state: 'ok', number: 1192, title: '引擎每周刷新 CI 测试耗时表', alsoCloses: [] },
        },
        action: mockReleaseAction(),
        asOf: iso(),
      });
    },
    async franceReleasedCommits() {
      await wait();
      // 假数据：法国最近发过的几个主线提交（真数据读法国的发布历史、标题读 GitHub）。
      const ago = (min: number) => new Date(now() - min * 60_000).toISOString();
      // 前两条的 PR 号在主页假数据「做完的」里（localDone），主页「上线了的」能算出同一版还带了哪些 PR；后两条的不在，写「没列全」。
      const rows: [string, string, number, 'release' | 'rollback'][] = [
        [
          '6896b3cb4d2e8f0a1b3c5d7e9f1a3b5c7d9e1f3a',
          '主页改成三块：要你拍的、在跑的、上线了的 (#1745)',
          50,
          'release',
        ],
        [
          '5f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6',
          '发版车第 6 步只拦新出现的、跟新版有关的异常 (#1741)',
          180,
          'release',
        ],
        [
          '4e0d1c2b3a4958677685a4b3c2d1e0f9a8b7c6d5',
          '额度读取：改以会话用户身份读 (#1228)',
          60 * 5,
          'rollback',
        ],
        [
          '3d9c0b1a2f3847566574a3b2c1d0e9f8a7b6c5d4',
          '额度读取：两个池读登录文件 (#1220)',
          60 * 29,
          'release',
        ],
      ];
      return ReleasedCommitsSchema.parse({
        state: 'ok',
        commits: rows.map(([sha, title, min, event]) => ({
          sha,
          short: sha.slice(0, 12),
          title,
          titleWhy: null,
          at: ago(min),
          event,
        })),
        asOf: iso(),
      });
    },
    async franceRelease(sha) {
      await wait();
      if (mockReleaseAction().state !== 'ready') throw new Error('现在不能发（假后端的按钮是置灰的）');
      releaseMock.startedAt = now();
      releaseMock.target = `提交 ${sha.slice(0, 12)}`;
      return ReleaseRequestResponse.parse({ requested: true, sha, at: iso() });
    },
    async franceReleaseRecover(kind) {
      await wait();
      const recover = mockReleaseAction().recover;
      if (recover[kind] === null)
        throw new ApiError(409, 'recover_unavailable', '现在没有可点的按钮（假后端）');
      if (kind === 'retry') {
        releaseMock.mode = '';
        releaseMock.startedAt = now() - 3 * MOCK_STEP_MS; // 从第 3 步接着走
        releaseMock.target = '提交 2005b2909c4f';
      } else if (kind === 'restore') {
        releaseMock.mode = '';
        releaseMock.startedAt = now() - 20 * MOCK_STEP_MS; // 九步都走完
        releaseMock.target = '提交 2005b2909c4f';
      } else {
        releaseMock.mode = '';
        releaseMock.startedAt = null;
      }
      return ReleaseRecoverResponse.parse({ requested: true, kind, at: iso() });
    },
    async franceCliTools() {
      await wait();
      // 假数据：四种状态都有，截图和页面测试看得到。这台不是法国，数字不是真机读数。
      const ago = new Date(now() - 8 * 60_000).toISOString();
      const cell = (version: string) => ({ state: 'ok' as const, version });
      const row = (
        tool: string,
        name: string,
        installed:
          | { state: 'ok'; version: string }
          | { state: 'unread'; why: string }
          | { state: 'unreadable'; why: string },
        latest: { state: 'ok'; version: string } | { state: 'unreadable'; why: string },
        status:
          | { kind: 'current'; label: '最新' }
          | { kind: 'behind'; count: number; label: string }
          | { kind: 'behind-uncounted'; reason: string; label: '落后（数不出几个）' }
          | { kind: 'unread'; reason: string; label: '读不到' }
          | { kind: 'unreadable'; reason: string; label: '没查成' },
      ) => ({
        scope: 'user' as const,
        owner: '',
        tool,
        name,
        installed,
        latest,
        status,
        checkedAt: ago,
        upgrade: null,
      });
      const userRows = (behindCodex: boolean) => [
        row('claude', 'Claude Code', cell('2.1.282'), cell('2.1.296'), {
          kind: 'behind',
          count: 14,
          label: '落后 14 个版本',
        }),
        row(
          'codex',
          'Codex',
          behindCodex ? cell('0.156.1') : cell('0.162.1'),
          cell('0.162.1'),
          behindCodex
            ? { kind: 'behind', count: 6, label: '落后 6 个版本' }
            : { kind: 'current', label: '最新' },
        ),
        row('grok', 'Grok', cell('1.0.41'), cell('1.0.50'), {
          kind: 'behind',
          count: 9,
          label: '落后 9 个版本',
        }),
        row(
          'cursor-agent',
          'Cursor Agent',
          { state: 'unread', why: '退出码 127（找不到命令）' },
          cell('2026.10.08'),
          { kind: 'unread', reason: '退出码 127（找不到命令）', label: '读不到' },
        ),
        row('reclaude', 'reclaude', cell('1.3.0'), cell('1.4.1'), {
          kind: 'behind-uncounted',
          reason: '发布源只给了最新版，没有版本列表，数不出落后几个',
          label: '落后（数不出几个）',
        }),
        row(
          'mirasim-server',
          'Mirasim 服务端',
          cell('0.0.355'),
          { state: 'unreadable', why: '更新日志里没认出版本号' },
          { kind: 'unreadable', reason: '更新日志里没认出版本号', label: '没查成' },
        ),
      ];
      const stamp = (owner: string, rows: ReturnType<typeof userRows>) =>
        rows.map((item) => ({ ...item, scope: 'user' as const, owner }));
      return CliToolsResponseSchema.parse({
        state: 'ok',
        upgradeNote: null,
        asOf: iso(),
        groups: [
          {
            scope: 'user',
            owner: 'fleet-agent-carpool',
            title: 'fleet-agent-carpool',
            rows: stamp('fleet-agent-carpool', userRows(true)),
          },
          { scope: 'user', owner: 'pilot', title: 'pilot', rows: stamp('pilot', userRows(false)) },
          {
            scope: 'npm',
            owner: '',
            title: '全局 npm',
            rows: [
              {
                ...row('kimi-code', 'Kimi', cell('2.1.1'), cell('2.2.0'), {
                  kind: 'behind',
                  count: 3,
                  label: '落后 3 个版本',
                }),
                scope: 'npm',
              },
              {
                ...row('dsh', 'DeepSeek dsh', cell('0.1.5'), cell('0.1.5'), {
                  kind: 'current',
                  label: '最新',
                }),
                scope: 'npm',
              },
              {
                ...row(
                  'pi',
                  'pi',
                  { state: 'unread', why: '全局 npm 里没有 @earendil-works/pi-coding-agent' },
                  cell('0.90.0'),
                  {
                    kind: 'unread',
                    reason: '全局 npm 里没有 @earendil-works/pi-coding-agent',
                    label: '读不到',
                  },
                ),
                scope: 'npm',
              },
            ],
          },
        ],
      });
    },
    async francePreflight() {
      await wait();
      // 默认装作这台后端没接上发版预检（#2024：假后端不给假的七项）。截图、手点用：localStorage 的 mockRelease 写
      // preflight-ok 给一份「能发」的演示清单，写 preflight-blocked 给一份有卡住项的（确认框里确认键灰着，#2026）。每行都写明是演示。
      const mode = typeof localStorage !== 'undefined' ? localStorage.getItem('mockRelease') : null;
      if (mode !== 'preflight-ok' && mode !== 'preflight-blocked') {
        return FrancePreflightResponseSchema.parse({
          state: 'unreadable',
          why: '这是假后端：发版预检只在法国那台的驾驶舱上读得到',
          asOf: iso(),
        });
      }
      const blocked = mode === 'preflight-blocked';
      const lines = [
        '主线头和 CI：通过 绿（演示数据）',
        '法国在用提交：通过 提交 6896b3cb4d2e（演示数据）',
        '落后几个：通过 落后 7 个提交（演示数据）',
        '别的发布是否在走：通过 没有在走的（演示数据）',
        blocked ? '发版接活单元：卡住 法国还没装（演示数据）' : '发版接活单元：通过 装了（演示数据）',
        '引擎总开关：通过 开着，发版会先关、发完恢复到发版前（演示数据）',
        '法国在跑的会话数：留意 2 个，发版会等它们收尾（演示数据）',
      ];
      return FrancePreflightResponseSchema.parse({
        state: 'done',
        command: '进程内读事实',
        code: blocked ? 2 : 0,
        signal: null,
        stdout: `${lines.join('\n')}\n`,
        stderr: '',
        durationMs: 12,
        timedOut: false,
        truncated: false,
        asOf: iso(),
      });
    },
    subscribe(listener, onStatus) {
      listeners.add(listener);
      onStatus?.('open');
      const t = setTimeout(() => listener({ type: 'ready' }), 0);
      // 机器资源和真后端一样每 5 秒推一回（只在开着模拟器时：测试里不起定时器）
      const tick = opts.live
        ? setInterval(() => {
            const resources = mockResources(liveRunIds, new Date());
            if (resources) listener({ type: 'resources', resources });
          }, MOCK_RESOURCES_EVERY_MS)
        : undefined;
      return () => {
        clearTimeout(t);
        clearInterval(tick);
        listeners.delete(listener);
      };
    },
  };
  return api;
}
