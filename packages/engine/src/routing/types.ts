// 选路的输入与结果。输入由引擎的 pickRoute 端口从库里取齐（候选路由、熔断、战绩），结果只有三种：派、等、派不出。
// 时刻一律 ISO 字符串（和熔断一样），认不出就抛 RoutingInputError，不当成「没有」。
import type { HostId, QuotaWindowKind, StageKind } from '@fleet-dao/shared';
import type { RoutingPolicy } from './policy.ts';

/**
 * 和 packages/db 的 queries/candidates.ts 的 Blocker 同一套取值（候选查询已经算好的被挡原因）。
 * engine 不依赖 db，两边各写一份：test/routing/blockers-sync.test.ts 读 db 的源码比对，那边加了取值这里会红。
 */
export type CandidateBlocker =
  | 'switched-off'
  | 'offline'
  | 'channel-disabled'
  | 'pool-expired'
  | 'model-retired'
  | 'banned'
  | 'quota-exhausted'
  | 'no-slot';

export const CANDIDATE_BLOCKERS: readonly CandidateBlocker[] = [
  'switched-off',
  'offline',
  'channel-disabled',
  'pool-expired',
  'model-retired',
  'banned',
  'quota-exhausted',
  'no-slot',
];

/** 一个适用于这条路由的额度窗（候选查询的 CandidateWindow，加上已用比例和实读 / 估算）。 */
export interface RouteWindow {
  /** 上游原名，例如 5h、7d、7d_claude、auto_percent。 */
  label: string;
  window: QuotaWindowKind;
  /** 模型组窗口的组名；账号级窗口为空。 */
  scope: string | null;
  state: 'ok' | 'exhausted' | 'stale' | 'reset';
  /** yes = 扣这条路由；unknown = 判不了扣不扣。 */
  applies: 'yes' | 'unknown';
  /** 已用比例，通常 0–1，超额可以大于 1；算不出来为空。 */
  used: number | null;
  resetsAt: string | null;
  reading: 'measured' | 'estimated';
  readAt: string;
  /** 非空 = 上游这次没报（候选查询只留下最后一次读到是用满、还没过清零时刻的）。 */
  staleSince: string | null;
}

/** 熔断的判定（failure/breaker.ts 的 RouteBreakerState 的子集）。 */
export interface BreakerFacts {
  state: 'closed' | 'open' | 'half_open';
  admit: 'all' | 'trial' | 'none';
  reason: string;
  probeAt?: string;
}

/** 这条路由在这个阶段类型上最近的战绩（引擎按近 7 天真实结局算，只数算路由账的失败）。 */
export interface RouteRecord {
  samples: number;
  successes: number;
}

/**
 * 主池 / 备池。独享号是主池，拼车号是备池：备池只接短而轻的活、并发另有上限、剩余不够跑一个活就不派，
 * 额度未知时只放一个试探。端口按池的会话用户填（pools.run_as_user = fleet-agent-carpool → backup），其余 primary。
 */
export type PoolRole = 'primary' | 'backup';

/** 一条路由的全部事实：候选查询的一行 + 给人看的名字 + 熔断 + 战绩。 */
export interface RouteFacts {
  routeId: string;
  channelId: string;
  poolId: string;
  /** 给人看的池名，例如「独享号」「拼车号」「Mirasim 中转」。不许带账号、组织编号、邮箱。 */
  poolName: string;
  poolRole: PoolRole;
  modelId: string;
  /** 模型目录的显示名，例如 Opus 5.5（硬禁令也按它认 Fable）。 */
  modelName: string;
  family: string;
  hostId: HostId;
  /**
   * 插头实际发给上游的模型串和别名（routes.upstream_model / upstream_aliases，没填为 null / 空数组）。
   * 硬禁令也按它们认（shared 的 BanSubject）：目录里模型写成 opus、上游串却是 Fable，照样要拦。
   */
  upstreamModel: string | null;
  upstreamAliases: string[];
  /** 候选查询算好的：ok / exhausted / unknown（没读成、读数过期、判不了扣不扣）。 */
  quota: 'ok' | 'exhausted' | 'unknown';
  windows: RouteWindow[];
  /** 这个池此刻在跑的会话数（按池算：已开工、没结束）。 */
  inFlight: number;
  /**
   * 这个池已选定、还没开工的会话数（按池算：session_runs 里没开工、没结束的行）。并发上限、备池上限、
   * 「只放一个试探」都把它算进去：一批任务同时来选路时，只数已开工的，每个任务都会看到 0 个在跑。
   */
  reserved: number;
  maxConcurrency: number;
  /** 命中的禁令原因（代码里的硬禁令 + 库里的 bans）。 */
  banReasons: string[];
  blockers: CandidateBlocker[];
  breaker: BreakerFacts;
  /** 没有这个阶段的战绩为空（从没跑过），不是「读不到」：读不到端口要抛错。 */
  record: RouteRecord | null;
}

/** 调度台上这个阶段的一行：人排的顺序、单条开关、钉住。 */
export interface StageRouteEntry {
  routeId: string;
  /** 从 0 起，越小越先用。 */
  position: number;
  /** 单条开关：关着的不派。 */
  enabled: boolean;
  /** 钉住：不参与任何微调（不提前、不后置、不因额度未知挪后），也不拿来做试探的出发点。 */
  pinned: boolean;
}

/** 活的轻重：备池只接轻的。不给就按阶段的默认（policy.stageWeight）。 */
export type TaskWeight = 'light' | 'heavy';

export interface ChooseRouteInput {
  stage: StageKind;
  /** 这个阶段在调度台上配过顺序没有（stage_policies 有没有这一行）。没配过就派不出，不按 id 乱挑。 */
  configured: boolean;
  /** 整个阶段钉住（stage_policies.pinned）：等于每一行都钉住。 */
  stagePinned: boolean;
  order: StageRouteEntry[];
  /** 每条路由的事实；order 里的每一条、以及任务指定的那条都要有。 */
  routes: RouteFacts[];
  /** 任务（或人、帅位）指定的路由：只用它，用不了就报，不偷偷换。 */
  taskRouteId?: string;
  weight?: TaskWeight;
  /** 这个任务要避开的（换路由、换模型时引擎给）。 */
  avoid?: { routeIds?: string[]; poolIds?: string[]; modelIds?: string[] };
  /** [0, 1) 的随机数，试探用；由工作流经 decide 生成、记进历史。试探开着时必须给。 */
  draw?: number;
  now: string;
  policy?: Partial<RoutingPolicy>;
}

/**
 * 被挡的原因。waitable = 等得来（空位、额度清零、熔断到点）；其余是硬挡，等也等不来。
 * CandidateBlocker 来自候选查询（switched-off 选路也按调度台那一行自己判），其余是选路自己判的。
 */
export type BlockCode =
  | CandidateBlocker
  | 'host-unfit'
  | 'breaker-open'
  | 'avoided'
  | 'quota-short'
  | 'backup-heavy'
  | 'backup-no-slot'
  | 'backup-quota-unknown';

export interface Block {
  code: BlockCode;
  /** 白话，驾驶舱直接显示。 */
  text: string;
  /** 等什么：slot 空位 / quota 额度清零 / breaker 熔断到点；硬挡为空。 */
  wait: 'slot' | 'quota' | 'breaker' | null;
  /** 等得来的，最早几点能好：一定晚于现在；不知道（或那个时刻已经过了）为空。 */
  until: string | null;
}

export type Nudge = 'fast-reset' | 'poor-record' | 'quota-unknown' | 'backup-pool';

/** 每条路由的判定，驾驶舱调度台按它显示「这次为什么派 / 不派它」。 */
export interface RouteVerdict {
  routeId: string;
  /** 「独享号 · Opus 5.5 · Claude Code」。 */
  label: string;
  /** 人排的位置（1 起）。任务指定、不在顺序里的为空。 */
  humanRank: number | null;
  /** 微调后的位置（1 起）。 */
  rank: number;
  pinned: boolean;
  blocks: Block[];
  /** 这次对它做了哪些微调，带白话。 */
  nudges: { kind: Nudge; text: string }[];
}

export type TrialKind =
  /** 约 10% 的试探：派给非首选的可用路由，攒战绩。 */
  | 'explore'
  /** 熔断半开，这一单就是那一个试探。 */
  | 'breaker'
  /** 候选全都熔断：多半是共用的一层坏了，放最早到点的一条去试探，并报警。 */
  | 'all-open'
  /** 备池额度未知：只放这一个去试探，被拒就按原文的清零时刻避开这个池。 */
  | 'quota-probe';

export type ChooseRouteResult =
  | {
      kind: 'dispatch';
      routeId: string;
      poolId: string;
      modelId: string;
      family: string;
      hostId: HostId;
      /** 一句「为什么派给它」，驾驶舱和飞书直接显示。 */
      why: string;
      /** 几种试探同时成立时取排在前面的（explore → breaker → quota-probe），why 里都写。 */
      trial: TrialKind | null;
      /** 派了但要报警（候选全熔断时放的试探）。 */
      alarm: string | null;
      verdicts: RouteVerdict[];
    }
  | {
      kind: 'wait';
      /** 最早能派的那条在等什么；时刻不知道时，有只差空位的就是空位。 */
      waitFor: 'slot' | 'quota' | 'breaker';
      /**
       * 最早能派的时刻：各条路由里最早好的那条，一定晚于现在。有一条时刻不知道（只差空位、等试探结果、
       * 清零时刻不知道）就为空：它随时可能好，调用方按轮询间隔再选一次。
       */
      until: string | null;
      reason: string;
      verdicts: RouteVerdict[];
    }
  | {
      kind: 'none';
      /** 派不出一律报警：附每条路由被挡的原因。 */
      reason: string;
      verdicts: RouteVerdict[];
    };

/** 输入认不出（时刻、随机数、重复的路由、缺事实、认不出的被挡原因、策略越界）。调用方按「选路没查成」处理。 */
export class RoutingInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoutingInputError';
  }
}
