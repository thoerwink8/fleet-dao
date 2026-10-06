// 选路的输入与结果。输入由引擎的 pickRoute 端口从库里取齐（候选路由、熔断、战绩），结果只有三种：派、等、派不出。
// 时刻一律 ISO 字符串（和熔断一样），认不出就抛 RoutingInputError，不当成「没有」。
import type { HostId, OrgKind, QuotaWindowKind, RouteProbeState, StageKind } from '@fleet-dao/shared';
import type { RoutingPolicy } from './policy.ts';

/**
 * 和 packages/db 的 queries/candidates.ts 的 Blocker 同一套取值（候选查询已经算好的被挡原因）。
 * engine 不依赖 db，两边各写一份：test/routing/blockers-sync.test.ts 读 db 的源码比对，那边加了取值这里会红。
 */
export type CandidateBlocker =
  | 'switched-off'
  | 'offline'
  | 'channel-disabled'
  | 'channel-failed'
  | 'pool-expired'
  | 'model-retired'
  | 'banned'
  | 'quota-exhausted'
  | 'no-slot';

export const CANDIDATE_BLOCKERS: readonly CandidateBlocker[] = [
  'switched-off',
  'offline',
  'channel-disabled',
  'channel-failed',
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

/** 一条路由的全部事实：候选查询的一行 + 给人看的名字 + 熔断 + 战绩。 */
export interface RouteFacts {
  routeId: string;
  channelId: string;
  poolId: string;
  /** 给人看的池名，例如「独享号」「拼车号」「Mirasim 中转」。不许带账号、组织编号、邮箱。 */
  poolName: string;
  /**
   * Claude 订阅池对应的 reclaude 组织类型（pools.org_kind）。会话用户同一时刻只挂一个组织，只有和它挂着的一样的池
   * 能派（ChooseRouteInput.liveOrg）；拼车用满引擎切号（#157），不再有「拼车号是备池、只接轻活」那一套（两个会话用户
   * 同时跑时的主池、备池规则 2026-09-27 随 #59 删掉）。不是 Claude 订阅池的不填。
   */
  orgKind?: OrgKind | null;
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
  /**
   * 路由探针最近一次下结论的时刻（routes.probed_at），探针还没看过为空。在线（被挡原因里没有 offline）的一定有：
   * 库里约束 alive 为真时结论必须是 ok，没有就是输入拼错了（validate.ts 抛）。超过 routeProbeStaleMinutes(hostId)
   * 没更新（探针可能停了）照派，派工理由里写明（choose.ts 的 probeNote）。
   */
  probedAt: string | null;
  /** 那次结论是什么（routes.probe_state）：探针还没看过为空。不给 = 不知道（老的输入），按 offline 原样硬挡。 */
  probeState?: RouteProbeState | null;
  /**
   * Claude 订阅池的路由：探针下那次结论时会话用户挂的是哪个组织（routes.probe_org）；读不到、不是 Claude 订阅池为空。
   * 结论是 skipped、这里是另一个组织 = 那一轮另一个组织挂着、没探它，不是它坏了：它的组织挂上以后等下一轮探针（filter.ts）。
   */
  probeOrg?: OrgKind | null;
  /** 候选查询算好的：ok / exhausted / unknown（没读成、读数过期、判不了扣不扣）。 */
  quota: 'ok' | 'exhausted' | 'unknown';
  windows: RouteWindow[];
  /** 这个池此刻在跑的会话数（按池算：已开工、没结束）。 */
  inFlight: number;
  /**
   * 这个池已选定、还没开工的会话数（按池算：session_runs 里没开工、没结束的行）。并发上限把它算进去：
   * 一批任务同时来选路时，只数已开工的，每个任务都会看到 0 个在跑。
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

/** 这个用途在路由两层里摊平之后的一行（#574：用途下模型的先后、再是模型下路由的先后）：位置、单条开关、钉住。 */
export interface StageRouteEntry {
  routeId: string;
  /** 从 0 起，越小越先用。 */
  position: number;
  /** 单条开关：关着的不派。 */
  enabled: boolean;
  /** 钉住：不参与任何微调（不提前、不后置、不因额度未知挪后），也不拿来做试探的出发点。 */
  pinned: boolean;
}

/**
 * 读会话用户此刻挂的组织的结果（real/session-org.ts 读，选路、路由探针用）。读不到、认不出是明确的失败，带白话原因
 * （不带组织编号、邮箱：原因会进库、上驾驶舱）；调用方拿它当「认不出」，不拿哪个组织顶。pending：还没读完（reclaude
 * 首跑同步配置要上百秒），不是读坏了——选路按「过一会儿再选」处理，不当成认不出挂起任务。
 */
export type LiveOrgReading = { ok: true; org: OrgKind } | { ok: false; why: string; pending?: true };

/**
 * 引擎切号的打算（engine 的 jobs/org-switch.ts 的 orgIntent，和切号同一个判法、同一份事实）：to 是引擎打算让会话用户挂到的
 * 组织（下一轮路由探针切；at 给了是到那个时刻以后的那一轮，例如拼车几点恢复），为空 = 不打算切，why 写为什么。
 * 选路按它判「不是挂着的那个组织的池」：引擎打算切过去的等得来（等切号，任务不挂起），不打算切的硬挡、写明为什么。
 */
export interface OrgPlanView {
  to: OrgKind | null;
  at: string | null;
  why: string;
  /**
   * 切回拼车的宽限中（#194 方案 4.5）：这一类的池（现在挂着的）新活先不派，等切回；已经在跑的照跑到宽限到点。不给 = 不在宽限中。
   */
  drain?: OrgKind | null;
  /**
   * 渠道不可用（#194，创始人 2026-10-04 约 22:30：可用账号 0 个「渠道不可用」）：带组织类型的池一个都不派，写明原因；
   * 有账号恢复后自己消失。不给 = 渠道没问题。
   */
  channelDown?: string | null;
}

/**
 * 拼车并发登记核对的结论（#896，real/carpool-cap.ts 现核）：ok:false = 登记的拼车并发上限和库里拼车池的对不上、没登记、写坏了、
 * 库里没有拼车池、或核对本身没读成，why 写明是哪一种。核对不上时选路不往带拼车组织类型的池派新活（对上了自己恢复）。
 */
export type CarpoolRegistryView = { ok: true } | { ok: false; why: string };

export interface ChooseRouteInput {
  stage: StageKind;
  /** 这个用途配过模型顺序没有（routing_purpose_models 里有没有它的行）。没配过就派不出，不按 id 乱挑。 */
  configured: boolean;
  /** 整个用途钉住：等于每一行都钉住。路由两层没有这一项，引擎一律给 false（纯函数照留，测试和验证那一步的输入还用得上）。 */
  stagePinned: boolean;
  order: StageRouteEntry[];
  /** 每条路由的事实；order 里的每一条、以及任务指定的那条都要有。 */
  routes: RouteFacts[];
  /** 任务（或人、帅位）指定的路由：只用它，用不了就报，不偷偷换。 */
  taskRouteId?: string;
  /**
   * 这个任务要避开的（换路由、换模型时引擎给）。families：这一步要避开的模型族，按族名认、不分大小写——开 PR 前验证只派
   * 别家，写这张单的族都在这里（docs/decisions/0003-fusion-flow.md 第 5 条）；给了它，渠道自己挑模型的路由（上游串 auto）
   * 也不派：认不出这次是哪一家在答。
   */
  avoid?: { routeIds?: string[]; poolIds?: string[]; modelIds?: string[]; families?: string[] };
  /** 这一步算界面类的活（改到了页面代码，例如验证一个改了页面的改动）：禁令按 UI 判（GPT 不做界面，含审界面）。 */
  uiWork?: boolean;
  /**
   * 会话用户此刻挂的 reclaude 组织（design 第九节：法国只有一个会话用户，同一时刻只挂一个组织）。带 orgKind 的池
   * 只有和它一样的才派；不给 = 不知道挂的是哪个，带 orgKind 的池一律不派。
   */
  liveOrg?: OrgKind;
  /**
   * 没给 liveOrg 是因为读了没读成（读不到、认不出，LiveOrgReading 的原话）：写进带 orgKind 的池被挡的原因，
   * 「会话用户挂的组织认不出（…）」。和 liveOrg 不能同时给。
   */
  liveOrgProblem?: string;
  /**
   * 引擎切号的打算（OrgPlanView）：只在给了 liveOrg、候选里又有不是它的组织的池时才要。不给 = 没判，那些池照老样子硬挡。
   */
  orgPlan?: OrgPlanView;
  /**
   * 各渠道（账号池）的额度留量线（#194 方案 4.8，shared 的 resolvePoolReserve）：setting 是设置 engine.quotaReserve 读到的原值，
   * undefined = 库里没有这一行（种子没装上，硬挡、写明原因，不当成不限）。代码里没有任何线的默认值。
   * 已用到线的池不派新活（等得来：到清零时刻，或人改线）；设置认不出的池同样硬挡；这个池没写线 = 不限。不给 = 没判（老的输入、纯函数测试），留量线不管——真装配（store-ports）一定给。
   */
  quotaReserve?: { setting: unknown };
  /**
   * 拼车并发登记核对的结论（#896）：ok:false 时带 orgKind 为 carpool 的池一律不派（硬挡，写明 why，核对对上了自己恢复）。
   * 不给 = 没判（老的输入、纯函数测试）——真装配（store-ports 经 real/index.ts 接 carpoolRegistry）一定给，测试钉着。
   */
  carpoolRegistry?: CarpoolRegistryView;
  /** [0, 1) 的随机数，试探用；由工作流经 decide 生成、记进历史。试探开着时必须给。 */
  draw?: number;
  now: string;
  policy?: Partial<RoutingPolicy>;
}

/**
 * 被挡的原因。waitable = 等得来（空位、额度清零、熔断到点）；其余是硬挡，等也等不来。
 * CandidateBlocker 来自候选查询（switched-off 选路也按顺序里那一行的开关自己判），其余是选路自己判的。
 */
export type BlockCode =
  | CandidateBlocker
  | 'host-unfit'
  | 'breaker-open'
  | 'avoided'
  | 'quota-short'
  /** 到了额度留量线（或留量线的设置认不出）：引擎最多用到那条线就停（#194 方案 4.8）。 */
  | 'quota-reserve'
  /** 拼车并发登记核对不上：不往拼车池派，对上了自己恢复（#896）。 */
  | 'carpool-registry'
  | 'org-not-live';

/**
 * 等什么：slot 空位 / quota 额度清零 / breaker 熔断到点 / org 引擎切号（会话用户挂的不是这个池的组织，引擎打算切过去）/
 * probe 探针在这个组织下探一次（上一轮另一个组织挂着，没探它）。
 */
export type RouteWaitKind = 'slot' | 'quota' | 'breaker' | 'org' | 'probe';

export interface Block {
  code: BlockCode;
  /** 白话，驾驶舱直接显示。 */
  text: string;
  /** 等什么（RouteWaitKind）；硬挡为空。 */
  wait: RouteWaitKind | null;
  /** 等得来的，最早几点能好：一定晚于现在；不知道（或那个时刻已经过了）为空。 */
  until: string | null;
}

export type Nudge = 'fast-reset' | 'poor-record' | 'quota-unknown';

/** 每条路由的判定，按它写「这次为什么派 / 不派它」。 */
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
  | 'all-open';

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
      /** 几种试探同时成立时取排在前面的（explore → breaker），why 里都写。 */
      trial: TrialKind | null;
      /** 派了但要报警（候选全熔断时放的试探）。 */
      alarm: string | null;
      verdicts: RouteVerdict[];
    }
  | {
      kind: 'wait';
      /** 最早能派的那条在等什么；时刻不知道时，有只差空位的就是空位。 */
      waitFor: RouteWaitKind;
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

/**
 * 这个阶段现在是不是「候选全都熔断」（chooseRoute 走出 trial 'all-open' 的同一条件：没有能派的，
 * 活着的候选至少两条，且全都只被熔断挡着）。false 时 detail 写现在为什么不是。
 * 给每小时对账撤 routing:all-open 用：只算、不派。
 */
export type AllOpenCheck = { allOpen: true } | { allOpen: false; detail: string };

/** 输入认不出（时刻、随机数、重复的路由、缺事实、认不出的被挡原因、策略越界）。调用方按「选路没查成」处理。 */
export class RoutingInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoutingInputError';
  }
}
