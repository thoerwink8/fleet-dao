// 驾驶舱接口约定（web-api）：调度台：路由与阶段策略、路由两层、思考档位。
// 入口是 ../web-api.ts（只有 export *），拆分说明见 specs/901-项目瘦身与提速/重构方案.md 第 2 节；内容是从原来一个文件里原样搬来的。
import { z } from 'zod';
import type { HostId } from '../domain.ts';
import { SESSION_EFFORTS } from '../effort.ts';
import { BillingKindSchema, HostIdSchema, RouteProbeStateSchema, StageKindSchema } from './enums.ts';
import { Id, Time } from './internal.ts';

// —— 调度台：路由与阶段策略 ——

export const ChannelSchema = z.object({
  id: Id,
  name: z.string(),
  billing: BillingKindSchema,
  enabled: z.boolean(),
});

/** 渠道近态（#1118）：运行中失败被标 disabled 的渠道、为什么、顺到谁、探针什么时候看过。没有这一行的渠道没出过事。 */
export const ChannelStateSchema = z.object({
  channelId: Id,
  status: z.enum(['ok', 'disabled']),
  reason: z.string().optional(),
  failedRouteId: Id.optional(),
  fallbackChannelId: Id.optional(),
  fallbackModelId: Id.optional(),
  lastProbedAt: Time.optional(),
  flaggedAt: Time.optional(),
  updatedAt: Time,
});

export const ModelSchema = z.object({
  id: Id,
  family: z.string(),
  displayName: z.string(),
  retiredAt: Time.optional(),
});

/** 探针多久一轮（design 第九节「路由探针」：Claude 订阅起步 15 分钟，和对账补漏错开）。 */
export const ROUTE_PROBE_EVERY_MINUTES = 15;
/** 结论超过这么久没更新（连着三轮没跑）：驾驶舱标「探测过期」，探针可能停了。 */
export const ROUTE_PROBE_STALE_MINUTES = 45;
/**
 * 按一次的成本放慢的执行方式（design 第九节「路由探针」：贵的放慢）：上一次探通了，隔这么久才再真探。
 * 连着不通的按 route-probe-pace 逐级退避（15、30、60、120、240 分钟，封顶 240），不按这个表每轮重探。
 * 没列的每轮都探。cursor-agent：一次最小会话约 1.3 万输入 token
 * （2026-09-27 本机实测），扣的是按月的包含用量、和创始人在编辑器里用的是同一份——每轮都探一个月约 2900 次，2 小时一次约 360 次。
 * grok：同一个道理——SuperGrok 订阅按周的额度、和创始人在 grok.com 上用的是同一份，一次最小会话光系统提示就一万多输入 token
 * （法国真跑的过程记录：一次模型调用约 1.5 万输入、其中 1.2 万走缓存）。mirasim：探通即代表真打了一次上游（MS-27，账本要
 * 见到 2xx），扣的是 Mirasim 那份紧张的中转额度（#345，创始人 2026-09-27「额度不太够」）——15 分钟一轮会一个月探约 2900 次，
 * 和 cursor-agent、grok 一样放慢到 2 小时。
 */
export const ROUTE_PROBE_HOST_EVERY_MINUTES: Readonly<Partial<Record<HostId, number>>> = {
  'cursor-agent': 120,
  grok: 120,
  mirasim: 120,
};

/** 这种执行方式探通之后隔多久再真探（分钟）。 */
export function routeProbeEveryMinutes(hostId: string | undefined): number {
  const slow =
    hostId === undefined ? undefined : (ROUTE_PROBE_HOST_EVERY_MINUTES as Record<string, number>)[hostId];
  return slow ?? ROUTE_PROBE_EVERY_MINUTES;
}

/** 这条路由的结论多久没更新算过期（探针可能停了）：再探的间隔加两轮。每轮都探的就是 ROUTE_PROBE_STALE_MINUTES。 */
export function routeProbeStaleMinutes(hostId: string | undefined): number {
  return routeProbeEveryMinutes(hostId) + ROUTE_PROBE_STALE_MINUTES - ROUTE_PROBE_EVERY_MINUTES;
}

/** 路由探针最近一次的结论（domain.ts 的 RouteProbe）。 */
export const RouteProbeSchema = z.object({
  state: RouteProbeStateSchema,
  at: Time,
  /** 不是 ok 必须写原因；ok 也带一句（回答、用时）。 */
  detail: z.string().optional(),
});

export const RouteSchema = z.object({
  id: Id,
  channelId: Id,
  poolId: Id,
  modelId: Id,
  hostId: HostIdSchema,
  /** 只由探针和熔断写：为真时 probe 一定是 ok（库里有约束）。 */
  alive: z.boolean(),
  /** 没有 = 探针还没看过这条路由（上线后第一轮之前），不是离线。 */
  probe: RouteProbeSchema.optional(),
});

export const BanSchema = z.object({
  family: z.string().optional(),
  modelId: Id.optional(),
  stage: StageKindSchema.optional(),
  reason: z.string(),
});

export const PoolSchema = z.object({
  id: Id,
  channelId: Id,
  maxConcurrency: z.number().int().min(0),
  expiresAt: Time.optional(),
});

/**
 * 一块功能还没做（装配时定，不是跑出来的；和 /healthz 的「未接」同一个做法）：驾驶舱整块显示「待实现」占位，
 * 写明排在哪个阶段、哪张单，不把「没读到」说成「没查成」「离线」。接上以后后端不再给这一项。
 */
export const NotWiredSchema = z.object({
  /** 这块是什么：额度读数、路由在线状态…… */
  what: z.string(),
  /** 排在 plan.md 的哪个阶段，如 P3。 */
  phase: z.string(),
  /** 对应的单号。 */
  issue: z.number().int().positive(),
  /** 单开在哪个仓（驾驶舱据此链过去）；受管的仓里找不到它就不给，只显示单号。 */
  issueRepo: z.object({ owner: z.string(), name: z.string() }).optional(),
});
export type NotWired = z.infer<typeof NotWiredSchema>;

/**
 * 路由目录：渠道、账号池、模型、路由和禁令。每个用途按什么先后用哪些路由不在这里——那是路由两层（下面的
 * RoutingLayersResponse，GET /routing/layers），路由页、任务页「用哪个模型」都读那一份（#574）。
 */
export const RoutingResponse = z.object({
  channels: z.array(ChannelSchema),
  /** 渠道近态（只有出过事的渠道有行）：为什么不可用、顺延到谁。读不到整个接口报错，不给空的顶。 */
  channelStates: z.array(ChannelStateSchema),
  pools: z.array(PoolSchema),
  models: z.array(ModelSchema),
  routes: z.array(RouteSchema),
  /** 写死在代码里的全局禁令（bans.ts），驾驶舱只读展示，改不了。 */
  hardBans: z.array(z.object({ id: z.string(), reason: z.string() })),
  /** 库里另外配的禁令，和 hardBans 一起生效。 */
  bans: z.array(BanSchema),
});

// —— 路由两层（#574）：每个用途 → 模型 → 路由，每一层现在活着吗 ——
// 活不活不存，读的时候按探针、额度、禁令现算（db 的 routing-liveness.ts，判法只在那里）。

/** live 派得出去；dead 派不出去；unknown 不知道（探针没看过、额度没读成）——不当活，也不当死。 */
export const LivenessVerdictSchema = z.enum(['live', 'dead', 'unknown']);

/** 接得上、额度够、没被禁令挡里的一件：结论和原因。原因总有：没查成不等于没问题。 */
export const LivenessFactSchema = z.object({
  verdict: LivenessVerdictSchema,
  reason: z.string().min(1),
});

export const RoutingLayerRouteSchema = z.object({
  routeId: Id,
  channelId: Id,
  /** 渠道目录里的名字；目录里找不到就是渠道编号。 */
  channelName: z.string(),
  poolId: Id,
  hostId: HostIdSchema,
  /** 这条路由在它的模型下开着吗（关着的照样挂在顺序里，但不派，ban 那一件写「开关关着」）。 */
  enabled: z.boolean(),
  /** 三件事合起来：任何一件 dead 就 dead；没有 dead、有 unknown 就 unknown；三件都 live 才 live。 */
  verdict: LivenessVerdictSchema,
  connect: LivenessFactSchema,
  quota: LivenessFactSchema,
  ban: LivenessFactSchema,
  /** 探针最近一次下结论的时刻；没有 = 探针还没看过。过没过期按执行方式判（routeProbeStaleMinutes）；退避、隔 30 分钟再探的按那一档；按需探测的不算过期。 */
  probedAt: Time.optional(),
  /** 探针原文（routes.probe_detail）。退避、隔 30 分钟再探、按需探测都写在这里，驾驶舱据此放宽「探针可能停了」。 */
  probeDetail: z.string().optional(),
  /** 挡着这条路由的、用满了的额度窗：哪一个、几点清零（读数里没有清零时刻就不给）。 */
  exhausted: z.array(z.object({ label: z.string(), resetsAt: Time.optional() })),
  /** 账号池此刻在跑几个、已选定还没开跑几个（#757 预占）、最多几个：两者之和到了上限就是满（shared 的 poolFull），等空位，不算死。 */
  inFlight: z.number().int().min(0),
  reserved: z.number().int().min(0),
  maxConcurrency: z.number().int().min(0),
});

export const RoutingLayerModelSchema = z.object({
  modelId: Id,
  /** 模型目录里的名字；目录里找不到就是模型编号。 */
  displayName: z.string(),
  /** 目录里找不到、下面也没有路由时不给。 */
  family: z.string().optional(),
  /** 下面有一条 live 就 live；没有 live、有 unknown 就 unknown；全 dead 或一条都没有就 dead。 */
  verdict: LivenessVerdictSchema,
  /** 按这个模型下路由的先后。空 = 一条都没有（用途的 problems 里写明）。 */
  routes: z.array(RoutingLayerRouteSchema),
  /** 这个用途下另配的档位；没有 = 没另配（起会话仍看路由上的档）。 */
  effort: z.enum(SESSION_EFFORTS).nullable().optional(),
});

export const RoutingLayerPurposeSchema = z.object({
  purpose: StageKindSchema,
  /** 加进、移出、改档位时带回的版本。还没人用这套接口改过是 0。 */
  version: z.number().int().nonnegative(),
  /** 判法和模型那一层一样：有一个模型 live 就 live。 */
  verdict: LivenessVerdictSchema,
  /** 配置上的缺口：这个用途没有模型、某个模型下一条路由都没有。照实写，不当成「没有」。 */
  problems: z.array(z.string()),
  /** 按这个用途的模型先后。 */
  models: z.array(RoutingLayerModelSchema),
});

/** 渠道里看见、目录的上游串和别名都对不上的模型。只列，不加进目录。 */
export const ModelRosterMissingSchema = z.object({
  channelId: Id,
  channelName: z.string().min(1),
  modelKey: z.string().min(1).max(2000),
  firstSeenAt: Time,
  lastSeenAt: Time,
});

/** 目录里有这条路由，最近一次读成的名册里已经没有它的上游串和别名。 */
export const ModelRosterGoneRouteSchema = z.object({
  channelId: Id,
  channelName: z.string().min(1),
  routeId: Id,
  modelId: Id,
  /** 目录写的上游串；没写上游串、用别名顶上时是别名。都没写就是空串。 */
  upstreamModel: z.string().max(2000),
});

export const ModelRosterFailureSchema = z.object({
  channelId: Id,
  channelName: z.string().min(1),
  code: z.string().min(1).max(80),
  message: z.string().min(1).max(2000),
});

export const ModelRosterNotYetSchema = z.object({
  channelId: Id,
  channelName: z.string().min(1),
});

/** 没有名册命令、靠手工登记的渠道。页面写「这个渠道靠手工登记，共 N 个」，不报没读成。 */
export const ModelRosterManualSchema = z.object({
  channelId: Id,
  channelName: z.string().min(1),
  count: z.number().int().nonnegative(),
});

/**
 * 四个渠道的名册和目录的差。四张表都空才是对得上；有失败、还没读过，页面不能写对得上。
 * manual 是手工登记的渠道，可缺（老的响应）。只读、只列，不带「加进目录」之类的动作。
 * channelModelCount / catalogCount 是比过的两边各有几个：没给时页面只写两边的名字，不编 0。
 */
export const ModelRosterDiffSchema = z.object({
  missingFromCatalog: z.array(ModelRosterMissingSchema),
  goneRoutes: z.array(ModelRosterGoneRouteSchema),
  failed: z.array(ModelRosterFailureSchema),
  notYet: z.array(ModelRosterNotYetSchema),
  manual: z.array(ModelRosterManualSchema).optional(),
  /** 最近一次读成的名册里，渠道自己认的模型串一共几个。读失败、还没读过的不算。 */
  channelModelCount: z.number().int().nonnegative().optional(),
  /** 拿来跟名册比的目录一侧：这些路由按模型编号去重后一共几个。已经标下架的不算。 */
  catalogCount: z.number().int().nonnegative().optional(),
});

export const ManualModelRequest = z.object({
  modelKey: z.string().trim().min(1).max(2000),
  reason: z.string().trim().max(2000).optional(),
});

export const ManualModelResponse = z.object({
  channelId: Id,
  modelKey: z.string().min(1).max(2000),
  source: z.literal('手工'),
  count: z.number().int().nonnegative(),
});

export const RoutingLayersResponse = z.object({
  /** 现算的时刻。 */
  asOf: Time,
  /** 每个用途一份，按 StageKind 的先后；unavailable 时为空。 */
  purposes: z.array(RoutingLayerPurposeSchema),
  /** 这里读不了路由两层（开发环境的内存版没有这两张表）：写明为什么，不拿空列表冒充「都没配」。 */
  unavailable: z.string().optional(),
  /** 渠道名册和目录的差。没给、或给了 modelRosterUnavailable，都不能当成「都对得上」。 */
  modelRoster: ModelRosterDiffSchema.optional(),
  /** 名册这一层没接上、或这一下没读成。写明为什么。 */
  modelRosterUnavailable: z.string().optional(),
});

// —— 思考档位（#470）：路由两层里每个模型下的每条路由，起会话想多深 ——
// 存在库里（routing_catalog.effort，运行时配置，决定 0011 第 7 条）：改了下一个起的会话就照新的，不走改仓库再部署。
// 能配哪几档照 effort.ts 的 routeEffortChoices（和引擎起会话、骨架装载同一份判法）。

export const SessionEffortSchema = z.enum(SESSION_EFFORTS);

export const RouteEffortSchema = z.object({
  routeId: Id,
  channelId: Id,
  /** 渠道目录里的名字；目录里找不到就是渠道编号。 */
  channelName: z.string(),
  poolId: Id,
  hostId: HostIdSchema,
  /** 起会话时发给执行体的模型串（路由的上游模型串，没有就是模型编号）：cursor 能不能配看它带不带方括号。 */
  model: z.string(),
  /** 这条路由在它的模型下开着吗：关着的也能先配好，开了就照它。 */
  enabled: z.boolean(),
  /** 配的档位；没有 = 没配，起会话用 defaultEffort。 */
  effort: SessionEffortSchema.optional(),
  /** 能配哪几档，从低到高；配不了时为空，fixed 写为什么。 */
  choices: z.array(SessionEffortSchema),
  fixed: z.string().optional(),
});

export const EffortModelSchema = z.object({
  modelId: Id,
  /** 模型目录里的名字；目录里找不到就是模型编号。 */
  displayName: z.string(),
  family: z.string().optional(),
  /** 这个模型下的路由，按路由两层里的先后。 */
  routes: z.array(RouteEffortSchema),
});

export const RoutingEffortsResponse = z.object({
  /** 没配的路由起会话用这一档。 */
  defaultEffort: SessionEffortSchema,
  /** 挂进了路由两层的模型（按模型编号排）。unavailable 时为空。 */
  models: z.array(EffortModelSchema),
  /** 这里读不了（开发环境的内存版没有路由两层那两张表）：写明为什么，不拿空列表冒充「都没配」。 */
  unavailable: z.string().optional(),
});

/**
 * 改一条路由的思考档位。effort 写 null = 清掉、回到没配（用 defaultEffort）。expected 填改之前看到的（没配写 null）：
 * 别人先改了就返回 409，刷新后再改，不悄悄盖掉。这条路由的执行方式不认的档返回 422 写明为什么。
 */
export const UpdateRouteEffortRequest = z.object({
  effort: SessionEffortSchema.nullable(),
  expected: SessionEffortSchema.nullable(),
  /** 写进操作记录。 */
  reason: z.string().max(500).optional(),
});
export const UpdateRouteEffortResponse = z.object({
  modelId: Id,
  routeId: Id,
  /** 改完的档位；没有 = 没配。 */
  effort: SessionEffortSchema.optional(),
});

// —— 先后和开关（母单 #1089 第二片）：驾驶舱「路由」页改用途下的模型先后、模型下的渠道先后、渠道开关 ——
// 存在库里（routing_purpose_models.position、routing_catalog.position / enabled，运行时配置）：改完下一次选路就照新的。
// 都带「我看到的旧值」（expected）：别人先改了就返回 409，刷新后再改，不悄悄盖掉。

export const MoveDirectionSchema = z.enum(['up', 'down']);

const OrderReason = z.string().max(500).optional();

/**
 * 用途下的模型先后。两种写法：direction 上移 / 下移一位；order 把整段排成新先后（拖到目标位置）。
 * expected 都是改之前看到的模型先后（模型编号，从先到后）：对不上返回 409（details.current 是库里现在的先后）。
 * 已经在最上 / 最下返回 422；order 不是现在这一串的重排也返回 422。
 */
export const MovePurposeModelRequest = z.union([
  z.object({
    order: z.array(Id).min(1),
    expected: z.array(Id).min(1),
    reason: OrderReason,
  }),
  z.object({
    direction: MoveDirectionSchema,
    expected: z.array(Id).min(1),
    reason: OrderReason,
  }),
]);
export const MovePurposeModelResponse = z.object({
  purpose: StageKindSchema,
  /** 改完后这个用途下的模型先后（模型编号，从先到后）。 */
  order: z.array(Id),
});

/**
 * 模型下的一条渠道（路由）：op=move 上移 / 下移一位，expected 是改之前看到的这个模型下的路由先后（路由编号）；
 * op=enable 开 / 关，expected 是改之前看到的开关。先后和开关都不分用途：哪个用途排了这个模型，都照它。
 * 别人先改了返回 409（details.current 是库里现在的值），已经在最上 / 最下返回 422。
 */
export const UpdateModelRouteRequest = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('move'),
    direction: MoveDirectionSchema,
    expected: z.array(Id).min(1),
    reason: OrderReason,
  }),
  z.object({
    op: z.literal('reorder'),
    /** 改完后这个模型下的路由先后。必须是 expected 的重排。 */
    order: z.array(Id).min(1),
    expected: z.array(Id).min(1),
    reason: OrderReason,
  }),
  z.object({
    op: z.literal('enable'),
    enabled: z.boolean(),
    expected: z.boolean(),
    reason: OrderReason,
  }),
]);
export const UpdateModelRouteResponse = z.object({
  modelId: Id,
  routeId: Id,
  /** op=move / reorder：改完后这个模型下的路由先后；op=enable 不给。 */
  order: z.array(Id).optional(),
  /** op=enable：改完的开关；换位置不给。 */
  enabled: z.boolean().optional(),
});

/**
 * 模型级开关：开 = 这个模型下的路由全部打开，关 = 全部关掉。关了以后哪个用途都不派（选路看的还是每条路由的开关）。
 * expectedEnabled 是改之前看到的、开着的路由编号：对不上返回 409（details.current 是现在开着的）。
 */
export const SetModelEnabledRequest = z.object({
  enabled: z.boolean(),
  expectedEnabled: z.array(Id),
  reason: OrderReason,
});
export const SetModelEnabledResponse = z.object({
  modelId: Id,
  enabled: z.boolean(),
  /** 改完后开着的路由编号（按先后）。 */
  enabledRouteIds: z.array(Id),
});

/**
 * 渠道级开关（channels.enabled）：关了，这个渠道下所有路由都不派。不是已删的 PATCH /routing/channels/:id。
 * expected 是改之前看到的开关：对不上返回 409。
 */
export const SetChannelEnabledRequest = z.object({
  enabled: z.boolean(),
  expected: z.boolean(),
  reason: OrderReason,
});
export const SetChannelEnabledResponse = z.object({
  channelId: Id,
  enabled: z.boolean(),
});

// —— 用途里加模型、移出、改档位（#1356）——
// 版本是这个用途的整数（routing_purpose_revisions）。看到的和库里对不上返回 409（details.version 是现在的），一行不写。
// 目录里没有这个模型、用途里没有这个模型：404。已经在这个用途里：409。不认识的用途由路径判 404。
// 硬禁令（GPT × 界面）在加进这一步拒绝，422 写明原因。

export const PurposeModelSlotSchema = z.object({
  modelId: Id,
  /** 这个用途下的档位；null = 没另配。 */
  effort: SessionEffortSchema.nullable(),
});

export const PurposeMembershipResponse = z.object({
  purpose: StageKindSchema,
  version: z.number().int().nonnegative(),
  /** 改完后这个用途下的模型，从先到后，带着各自的档位。 */
  order: z.array(PurposeModelSlotSchema),
});

/** 把目录里的一个模型加进用途。position 不给 = 末尾；给了必须在 0 到「现在有几条」之间（含末尾）。effort 不给 = 不另配。 */
export const AddPurposeModelRequest = z.object({
  modelId: Id,
  position: z.number().int().nonnegative().optional(),
  effort: SessionEffortSchema.nullable().optional(),
  version: z.number().int().nonnegative(),
  reason: OrderReason,
});

export const RemovePurposeModelRequest = z.object({
  version: z.number().int().nonnegative(),
  reason: OrderReason,
});

/** effort 写 null = 清掉这个用途下的档位。 */
export const SetPurposeModelEffortRequest = z.object({
  effort: SessionEffortSchema.nullable(),
  version: z.number().int().nonnegative(),
  reason: OrderReason,
});

// —— 立即探测（驾驶舱改版，创始人 2026-10-07「渠道状态无法探测」）——
// 点一下「立即探测」= 记一条操作记录（routing.probe.request）；引擎每几秒看一眼操作记录，接手时记 routing.probe.start，
// 探完记 routing.probe.done（带每条路由的结论）。状态不另存：读的时候从这三种记录现算（shared 的 route-probe-now.ts）。

/** 一条路由这一次的结论：探针的四种，加上 unsettled（会话用户挂的组织这会儿定不下来，没探）、gone（路由已经不在了）。 */
export const RouteProbeOutcomeSchema = z.enum([
  'ok',
  'failed',
  'not_wired',
  'skipped',
  'on_demand',
  'unsettled',
  'gone',
]);

export const RouteProbeResultSchema = z.object({
  routeId: Id,
  outcome: RouteProbeOutcomeSchema,
  /** 原文：通了是回答和用时，不通是探针写的原因（原样，不改写）。 */
  detail: z.string(),
  at: Time,
  /** 这一次从起探到下结论用了多久（毫秒，含没通时隔一会儿再探的那一次）；没真探（跳过、没接）不给。 */
  durationMs: z.number().int().nonnegative().optional(),
});

/**
 * queued = 记下了、引擎还没接手；running = 引擎接手了在探；done = 探完了（每条的结论在 results）；
 * failed = 引擎接手了但这一轮没跑成，或接手太久没回结果（why 写原因）；expired = 太久没人接手，作废（引擎也不再接）。
 */
export const RouteProbeRequestStateSchema = z.enum(['queued', 'running', 'done', 'failed', 'expired']);

/** 自动排的立即探测的来源：任务在这条路由上断了（引擎当场排的），不是人点的。老请求不带。 */
export const RouteProbeSourceSchema = z.object({
  kind: z.literal('task-route-broken'),
  issueNumber: z.number().int().positive(),
});

export const RouteProbeRequestSchema = z.object({
  requestId: z.string().min(1),
  requestedAt: Time,
  /** 谁点的。 */
  by: z.string(),
  /** 点的是哪几条；不给 = 全部路由。 */
  routeIds: z.array(Id).optional(),
  /** 自动排的才有：谁要的（任务断链）。不给 = 人点的。 */
  source: RouteProbeSourceSchema.optional(),
  state: RouteProbeRequestStateSchema,
  startedAt: Time.optional(),
  finishedAt: Time.optional(),
  /** failed、expired 的原因；queued 太久时的提醒。 */
  why: z.string().optional(),
  results: z.array(RouteProbeResultSchema),
});

/** 引擎此刻在不在（和主页「引擎」那一格同一个探法）：off = 按配置没开，down = 没连上，unknown = 没查成。 */
export const RouteProbeEngineSchema = z.object({
  state: z.enum(['on', 'off', 'down', 'unknown']),
  detail: z.string().optional(),
});

export const RouteProbeStatusResponse = z.object({
  asOf: Time,
  engine: RouteProbeEngineSchema,
  /** 最近的立即探测，新的在前。 */
  requests: z.array(RouteProbeRequestSchema),
  /** 没接上（开发环境内存版）：整块写这一句，不拿空列表冒充「没人点过」。 */
  unavailable: z.string().optional(),
});

// —— 探针真历史（#1139）：渠道状态页的近 60 次格子 ——
// 每次探针落一行（db 的 route_probe_history）。这里是按渠道收好的条带，旧的在左，最多 60 格。
// 读不到、没接上：state=unreadable，why 里写「没查成」。不回空的 channels 冒充没有历史。

export const ProbeHistoryResultSchema = z.enum(['passed', 'failed', 'not_probed']);

export const ProbeHistoryCellSchema = z.object({
  id: z.number().int().positive(),
  routeId: Id,
  channelId: Id,
  probedAt: Time,
  result: ProbeHistoryResultSchema,
  /** 这一次的耗时（毫秒）。没探、没量到是 null，不当 0。 */
  durationMs: z.number().int().nonnegative().nullable(),
  /** 不通、没探的原因。通过是 null。 */
  failureReason: z.string().nullable(),
  /** 发出去的请求原文。没发出去是 null。 */
  requestText: z.string().nullable(),
  /** 响应原文。没拿到是 null。 */
  responseText: z.string().nullable(),
  /** 降智检测（#1637）：题、标准答案、实答、判过没过（null = 没判）、自报身份。老行和没带题的探测都是 null。 */
  checkQuestion: z.string().nullable(),
  checkExpected: z.string().nullable(),
  checkAnswer: z.string().nullable(),
  checkPassed: z.boolean().nullable(),
  selfIdentity: z.string().nullable(),
});

export const ProbeHistoryChannelSchema = z.object({
  channelId: Id,
  /** 从旧到新，最多 60。不够不补假格子（页面自己补空位）。 */
  cells: z.array(ProbeHistoryCellSchema).max(60),
  /** 量到了耗时的那些的平均（毫秒）。一个都没有是 null。 */
  avgDurationMs: z.number().int().nonnegative().nullable(),
  passed: z.number().int().nonnegative(),
  /** 通过 + 不通。没探的不进。0 = 还没有真探，页面不写成 0% 或 100%。 */
  attempted: z.number().int().nonnegative(),
});

export const RouteProbeHistoryResponse = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('ok'),
    channels: z.array(ProbeHistoryChannelSchema),
    /** 每条路由自己的最近一次。挤出 60 格的也在，点路由行用。 */
    latestByRoute: z.array(ProbeHistoryCellSchema),
  }),
  z.object({
    state: z.literal('unreadable'),
    /** 给人看的一句，以「没查成」开头。 */
    why: z.string().min(1),
  }),
]);

/** routeIds 不给 = 全部路由。 */
export const RouteProbeNowRequest = z.object({
  routeIds: z.array(Id).min(1).max(200).optional(),
  reason: z.string().max(500).optional(),
});
export const RouteProbeNowResponse = z.object({
  request: RouteProbeRequestSchema,
  engine: RouteProbeEngineSchema,
});
