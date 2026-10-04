// 一个在跑的会话在这个工人进程里的状态（Live）和新建它的 newLive：起会话、接回、看守、进度、停机放手都读写它。
// registry（runId → Live）在 shared 里，newLive 从 registry.size 记下同时在跑的会话数。从 sessions.ts 拆出来，函数体原样。

import type { SessionUser, SpawnInfo } from '@fleet-dao/adapters';
import type { ProgressEvent, StageKind } from '@fleet-dao/shared';
import type { StallToolCall } from '../failure/stall.ts';
import type { ContinueMode, HostDriver, HostReport, WiredHost } from './hosts.ts';
import type { OomCounters } from './kill-evidence.ts';
import type { OutputKind } from './prompts.ts';
import type { SessionShared } from './session-types.ts';

export interface Live {
  runId: string;
  /** 起会话时回给工作流的号（看守拿它对会话）：cursor 开新会话时是临时号。 */
  sessionId: string;
  /** 执行体真用的会话号：Claude、续会话一开始就知道；cursor 开新会话要等 init 帧报上来，没报就一直没有。 */
  agentSessionId: string | undefined;
  hostId: WiredHost;
  driver: HostDriver;
  taskId: string;
  stage: StageKind;
  kind: OutputKind;
  mode: ContinueMode;
  user: SessionUser;
  poolId: string;
  routeId: string;
  dir: string;
  baseHead: string | undefined;
  /** 仓的主线分支：交活核对、Lead 交的改动扣掉并进来的主线（树里钉的 origin/<它>，user-git.ts 的 ownSpan）。 */
  defaultBranch: string;
  reviewHead: string | undefined;
  /** 开 PR 前验证对照的「怎么算做完」：读结论文件时拿它核逐条答全了没有。 */
  verifyCriteria: string[] | undefined;
  /** 续会话时上一轮结束时的会话累计花费：这一轮的花费按它求差。 */
  previousCost: number | null | undefined;
  startedAt: number;
  spawned: Promise<SpawnInfo>;
  report: Promise<HostReport>;
  /** 插头收场（进程、scope 都收了）之后删这次会话的临时目录；不会失败（删不掉只记日志）。 */
  cleaned: Promise<void>;
  abort: AbortController;
  stop:
    | { kind: 'stop'; reason: string }
    | { kind: 'stall'; rule: string; basis: string }
    /** 切号（#59）：会话用户要换组织，先停下，切过去接着干（交回 org_switch，失败分流 OS1 马上续）。 */
    | { kind: 'org-switch'; why: string }
    /** 排空到截止（drain.ts）：先停下，新引擎起来按编号续上（交回 engine_stop，失败分流 KL3）。 */
    | { kind: 'engine-stop'; why: string }
    | undefined;
  /** 还没进库的进度事件；seq = 出自输出的哪一行（走文件时有），进库时一起把「确认到哪一行」推上去。 */
  pending: { event: ProgressEvent; seq: number | undefined }[];
  /** 走文件、脱开引擎进程跑（deps.ioRoot）：引擎重启了由新引擎接回，停机不停它、排空不等它。 */
  detached: boolean;
  /** 引擎停机时放手（releaseDetached）：不再读它的输出、不写库、不停它，留给下一个引擎接回。 */
  release: AbortController;
  flushTimer: ReturnType<typeof setTimeout> | undefined;
  flushing: Promise<void>;
  writeError: string | undefined;
  dropped: number;
  lastEventAt: number | null;
  /** 上次为停滞题问 Jev 的时刻（Date.now()）；没问过是 undefined。 */
  stallJevAt?: number;
  lastStepAt: number | undefined;
  lastFileAt: number | undefined;
  tools: Map<string, { name: string; since: number }>;
  recent: StallToolCall[];
  says: string[];
  plan: Map<string, string>;
  quotaError: string | undefined;
  /** 起来时读的会话资源池按内存杀进程的累计数：被信号杀掉时拿它比（kill-evidence.ts）。 */
  oomBefore: Promise<OomCounters>;
  /** 会话自己的 scope 名（插头交回的），看守醒来读它的内存记录。 */
  scopeUnit: string | undefined;
  /** 看守读到的它自己 scope 里按内存杀进程的最大数；没读到过是 undefined。 */
  scopeOomSeen: number | undefined;
  /** 这个会话在跑时，这个工人手上同时在跑的别的会话最多几个。 */
  peersSeen: number;
  /** 正挂着的看守有几个（看守被取消时会话可能还在跑，收场后由起会话那头撤掉排空的登记）。 */
  awaiting: number;
}

export function createLive(shared: SessionShared) {
  const { registry } = shared;

  /** 新看守的状态：起会话、接回共用，只给认得出这个会话的那些，其余从空开始。 */
  function newLive(
    base: Pick<
      Live,
      | 'runId'
      | 'sessionId'
      | 'agentSessionId'
      | 'hostId'
      | 'driver'
      | 'taskId'
      | 'stage'
      | 'kind'
      | 'mode'
      | 'user'
      | 'poolId'
      | 'routeId'
      | 'dir'
      | 'baseHead'
      | 'defaultBranch'
      | 'reviewHead'
      | 'verifyCriteria'
      | 'previousCost'
      | 'startedAt'
      | 'spawned'
      | 'abort'
      | 'detached'
      | 'oomBefore'
    >,
  ): Live {
    return {
      ...base,
      release: new AbortController(),
      report: Promise.resolve(undefined as unknown as HostReport),
      cleaned: Promise.resolve(),
      stop: undefined,
      pending: [],
      flushTimer: undefined,
      flushing: Promise.resolve(),
      writeError: undefined,
      dropped: 0,
      lastEventAt: null,
      lastStepAt: undefined,
      lastFileAt: undefined,
      tools: new Map(),
      recent: [],
      says: [],
      plan: new Map(),
      quotaError: undefined,
      scopeUnit: undefined,
      scopeOomSeen: undefined,
      peersSeen: registry.size,
      awaiting: 0,
    };
  }

  return { newLive };
}
