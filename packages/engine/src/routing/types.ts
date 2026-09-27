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
}

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
  /** [0, 1) 的随机数，试探用；由工作流经 decide 生成、记进历史。试探开着时必须给。 */
  draw?: number;
  now: string;
  policy?: Partial<RoutingPolicy>;
  /**
   * 这一步会给这张单加一个写手族（选副手、Lead 换路由）：只派加上它的族之后开 PR 前验证还派得出别家的（0003 第 5 条
   * 「验证只派别家」）。不给 = 不管（规划、验证本身、开了 PR 之后、需求工作流、子任务）。判法见 choose.ts 的 chooseRoute。
   */
  keepVerifier?: KeepVerifier;
}

/**
 * 给开 PR 前验证留一家要的：写这张单的族、验证那一步此刻的选路输入。每个候选的族，把「写手族 + 它」交给验证那一步现选一次
 * （和 workflows/verify.ts 真验证时同一个 chooseRoute、同一份事实）：派不出的族挡掉（no-verifier），等得来的不算派不出。
 */
export interface KeepVerifier {
  /** 已经写过这张单的族（库里这张单起过的会话，和验证查作者同一个查询）。 */
  writers: string[];
  /** 开 PR 前验证那一步此刻的选路输入：阶段就是 verify，只派别家的那几族按 writers 加上候选的族现算，不在这里给。 */
  verify: VerifyProbe;
  /**
   * 平时先避开、只在别家都会让验证没人可派时才派的族：副手避开 Lead 那一族（Claude 额度留给 Lead，0002 第 5 条「优先」）。
   * 别家的候选能派、却都会让验证没人可派，才放行它们——它们本来就在写这张单，不多加一族；别家是没额度、连不上，照旧避开
   * （副手派不出由 Lead 自己干，0003 第 7 条）。
   */
  spare?: string[];
  /**
   * 能给验证留一家的都派不出时：none = 交派不出（副手：Lead 自己干，写手族不变，验证照样有人）；any = 照常选，结果带
   * noVerifier（Lead：非派不可）。写这张单的族已经让验证没人可派（选谁都救不回来）时两种都照常选、带 noVerifier。
   */
  otherwise: 'none' | 'any';
}

/** 开 PR 前验证那一步的选路输入（KeepVerifier.verify）：阶段、只派别家的族由选路现填。 */
export type VerifyProbe = Omit<ChooseRouteInput, 'stage' | 'avoid' | 'taskRouteId' | 'keepVerifier'> & {
  avoid?: { routeIds?: string[]; poolIds?: string[]; modelIds?: string[] };
};

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
  | 'org-not-live'
  /** 选它开 PR 前验证就没有别家可派了（ChooseRouteInput.keepVerifier）。 */
  | 'no-verifier';

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
  | 'all-open';

export type ChooseRouteResult = (
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
    }
) & {
  /**
   * 给了 keepVerifier、这张单做完却没人能验（写这张单的族已经让验证没人可派，或非派不可的这一步只剩会让验证没人可派的）：
   * 白话原因。调用方当场报警，不等干完几小时走到验证那一步才挂起「没有别家可验」。验证留得下就没有这一项。
   */
  noVerifier?: string;
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
