// 调度台要的配置：族、渠道、账号池、模型、路由、每个用途的路由顺序（路由两层）、禁令，外加额度窗（机器写的现值）。

import {
  type OrgKind,
  type RunAsUser,
  type ScopeMembership,
  SESSION_EFFORTS,
  type SessionEffort,
} from '@fleet-dao/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import {
  billingKind,
  hostId,
  ORG_KINDS,
  quotaStatus,
  quotaUnit,
  quotaWindowKind,
  RUN_AS_USERS,
  readingKind,
  routeProbeState,
  stageKind,
} from './enums.ts';

const tz = { withTimezone: true, mode: 'date' } as const;

/** 路由探针按活跃分的三档（#1798 片 2）：引擎每轮重写；空 = 还没写过。 */
export const ROUTE_PROBE_TIERS = ['active', 'idle', 'unused'] as const;
export type RouteProbeTier = (typeof ROUTE_PROBE_TIERS)[number];

/** 上一次真探的种类：连通 / 身份（#1798 片 2）。空 = 还没写过，或老结论。 */
export const ROUTE_PROBE_KINDS = ['ping', 'identity'] as const;
export type RouteProbeKind = (typeof ROUTE_PROBE_KINDS)[number];

export const families = pgTable('families', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  vendor: text('vendor').notNull(),
});

export const channels = pgTable('channels', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  billing: billingKind('billing').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  /**
   * 这个渠道上的活跃路由要不要额外问身份题（#1798）：目录 deploy/catalog.json 的 identityCheck，
   * 装载器写进来。默认 false；现在只有 mirasim 中转为 true。
   */
  identityCheck: boolean('identity_check').notNull().default(false),
});

/** 账号池 = 渠道下的一份额度。库里只放占位 id，账号与凭据在机器本地配置。 */
export const pools = pgTable(
  'pools',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id),
    /** 没有「不限」：没量过的池也要填一个保守数。 */
    maxConcurrency: integer('max_concurrency').notNull(),
    /** 订阅到期日：读数里给了就按读数写（savePoolQuota），没给就留着人填的。 */
    expiresAt: timestamp('expires_at', tz),
    /** 模型组窗口扣哪些模型（组名 → 成员表），读数里给了就按读数写。 */
    scopeModels: jsonb('scope_models').$type<Record<string, ScopeMembership>>(),
    /** 最近一次读成额度的时刻（savePoolQuota 写，读失败不动）。每小时对账看它是否超过 30 分钟。 */
    lastReadOkAt: timestamp('last_read_ok_at', tz),
    /** 这个池的会话跑在哪个系统用户下（法国只有一个会话用户，两个 Claude 池都是它）。空 = 还没定。 */
    // 不叫 session_user：那是 Postgres 保留字，裸写 select 拿到的是连接角色。
    runAsUser: text('run_as_user').$type<RunAsUser>(),
    /** Claude 订阅池对应哪类 reclaude 组织（拼车 / 独享）：会话用户挂着哪个组织，只有那个池能派。别的池空着。 */
    orgKind: text('org_kind').$type<OrgKind>(),
  },
  (t) => [
    check(
      'pools_run_as_user_known',
      sql`${t.runAsUser} is null or ${t.runAsUser} in (${sql.raw(RUN_AS_USERS.map((u) => `'${u}'`).join(', '))})`,
    ),
    check(
      'pools_org_kind_known',
      sql`${t.orgKind} is null or ${t.orgKind} in (${sql.raw(ORG_KINDS.map((k) => `'${k}'`).join(', '))})`,
    ),
    // 会话用户和组织类型要么都有要么都没有：跑会话的池漏了组织类型，选路判不了会话用户挂没挂着它（会派到没挂着的池、
    // 额度记错池）；不跑会话的池写了组织类型，又会被当成 Claude 组织池错挡、错放。
    check('pools_session_pool_org_kind_together', sql`(${t.runAsUser} is null) = (${t.orgKind} is null)`),
    // 给 routes 的组合外键用：路由挂的池必须属于路由写的渠道。
    unique('pools_channel_id_id_unique').on(t.channelId, t.id),
    check('pools_max_concurrency_positive', sql`${t.maxConcurrency} > 0`),
    // 成员表每一项都得是 {in: [模型 id…]} 或 {notIn: [模型 id…]}（二选一）：形状不对，选路时按它判会直接出错。
    // 嵌套数组（[["x"]]）漏得过去：jsonpath 宽松模式会把它拆开。
    check(
      'pools_scope_models_shape',
      sql`${t.scopeModels} is null or (jsonb_typeof(${t.scopeModels}) = 'object' and not jsonb_path_exists(${t.scopeModels}, '$.* ? (!(@.in.type() == "array" || @.notIn.type() == "array") || (exists(@.in) && exists(@.notIn)))') and not jsonb_path_exists(${t.scopeModels}, '$.*.*[*] ? (@.type() != "string")'))`,
    ),
  ],
);

export const models = pgTable('models', {
  id: text('id').primaryKey(),
  family: text('family')
    .notNull()
    .references(() => families.id),
  displayName: text('display_name').notNull(),
  /** 下架时间；过了这个时间，候选路由里它就被排除。 */
  retiredAt: timestamp('retired_at', tz),
});

export const routes = pgTable(
  'routes',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id').notNull(),
    poolId: text('pool_id').notNull(),
    modelId: text('model_id')
      .notNull()
      .references(() => models.id),
    hostId: hostId('host_id').notNull(),
    /** 只由探针和熔断写。新路由没探过，默认不在线；为真时探针的结论必须是 ok（下面的约束）。 */
    alive: boolean('alive').notNull().default(false),
    /** 路由探针最近一次的结论（design 第九节「路由探针」）；空 = 探针还没看过这条路由。 */
    probeState: routeProbeState('probe_state'),
    /** 探针下这个结论的时刻（没探的也记：这一轮看过、没探）。和 probe_state 同空同有。 */
    probedAt: timestamp('probed_at', tz),
    /** 不是 ok 必须写原因；ok 也带一句（回答、用时）。 */
    probeDetail: text('probe_detail'),
    /**
     * Claude 订阅池的路由：探针下这个结论时会话用户挂的是哪个组织；读不到、不是 Claude 订阅池为空。结论是 skipped、这里是
     * 另一个组织，说明那一轮另一个组织挂着、没探它（不是它坏了）：它的组织挂上以后选路等下一轮探针，不当成不在线挂起（#335）。
     */
    probeOrg: text('probe_org').$type<OrgKind>(),
    /** 插头实际发给上游的模型串（目录原文）。额度成员表只和它、和别名比；都没填，扣哪个桶判不了。 */
    upstreamModel: text('upstream_model'),
    /** 上游在别处（额度接口的成员表）对这条路由的叫法，和上面的模型串不同名时填。 */
    upstreamAliases: text('upstream_aliases').array().notNull().default(sql`'{}'::text[]`),
    /**
     * 名册拆出来的思考档位（#1355）。跟 routing_catalog.effort 不是一回事：那一列是起会话的档位上限。
     * 空 = 这条路由不是自动入库的，或上游串里没有档位。
     */
    variantEffort: text('variant_effort').$type<SessionEffort>(),
    /** 名册拆出来的 fast。空 = 不是自动入库的，不知道有没有 fast。 */
    variantFast: boolean('variant_fast'),
    /** 名册拆出来的 thinking。空 = 不知道。 */
    variantThinking: boolean('variant_thinking'),
    /** 名册拆出来的上下文，例如 1m、256k。 */
    variantContext: text('variant_context'),
    /** 渠道最近一次读成的名册里已经没有这条路由（#1355）。不删。再次出现就清掉。 */
    goneAt: timestamp('gone_at', tz),
    /**
     * Mirasim 这条路由该起的执行体（名册帧的 agent，或按上游串前缀判出来的）。
     * 空 = 还没盖过，选路当时按前缀现判。字面「执行体未知」不是执行体名：选路不派。
     */
    executor: text('executor'),
    /**
     * 探针节奏档（#1798 片 2）：active / idle / unused。引擎每轮重写；空 = 还没写过。
     * 选路和页面以后只读这一列，不再从 probe_detail 里抠。
     */
    probeTier: text('probe_tier').$type<RouteProbeTier>(),
    /** 下次定时探的时刻；不在用的为空。 */
    probeNextAt: timestamp('probe_next_at', tz),
    /** 连着不通几次；探通清零。取代原文里的「连着不通 N 次」。 */
    probeFailStreak: integer('probe_fail_streak').notNull().default(0),
    /** 上一次真探是 ping 还是 identity；空 = 还没写过。 */
    probeKind: text('probe_kind').$type<RouteProbeKind>(),
  },
  (t) => [
    foreignKey({
      name: 'routes_pool_in_channel_fk',
      columns: [t.channelId, t.poolId],
      foreignColumns: [pools.channelId, pools.id],
    }),
    // 同一模型换一种执行方式就是另一条路由。同池同模型同执行方式、上游串也一样（空也算一样）才是重复；
    // 上游串不同是同一模型的另一个变体（#1355）。
    unique('routes_pool_model_host_unique')
      .on(t.poolId, t.modelId, t.hostId, t.upstreamModel)
      .nullsNotDistinct(),
    // 给 routing_catalog 的复合外键用：一条路由只能挂在它自己的模型下面（id 本来就唯一，这条只为让外键能指到 (id, model_id)）。
    unique('routes_id_model_unique').on(t.id, t.modelId),
    // 不许拿默认值、手改冒充在线：在线必须是探针这一轮真探通了。结论为空时比较得 NULL、CHECK 会放行，所以包一层 coalesce。
    check('routes_alive_needs_probe_ok', sql`not ${t.alive} or coalesce(${t.probeState} = 'ok', false)`),
    check('routes_probe_state_at_together', sql`(${t.probeState} is null) = (${t.probedAt} is null)`),
    // 不在线、没探的都要写原因（没跑成 ≠ 没问题）。
    check(
      'routes_probe_not_ok_has_detail',
      sql`${t.probeState} is null or ${t.probeState} = 'ok' or coalesce(${t.probeDetail}, '') <> ''`,
    ),
    check(
      'routes_probe_org_known',
      sql`${t.probeOrg} is null or ${t.probeOrg} in (${sql.raw(ORG_KINDS.map((k) => `'${k}'`).join(', '))})`,
    ),
    check(
      'routes_variant_effort_known',
      sql`${t.variantEffort} is null or ${t.variantEffort} in (${sql.raw(SESSION_EFFORTS.map((e) => `'${e}'`).join(', '))})`,
    ),
    check(
      'routes_variant_context_nonempty',
      sql`${t.variantContext} is null or length(btrim(${t.variantContext})) > 0`,
    ),
    check('routes_executor_nonempty', sql`${t.executor} is null or length(btrim(${t.executor})) > 0`),
    check(
      'routes_probe_tier_known',
      sql`${t.probeTier} is null or ${t.probeTier} in (${sql.raw(ROUTE_PROBE_TIERS.map((v) => `'${v}'`).join(', '))})`,
    ),
    check('routes_probe_fail_streak_nonneg', sql`${t.probeFailStreak} >= 0`),
    check(
      'routes_probe_kind_known',
      sql`${t.probeKind} is null or ${t.probeKind} in (${sql.raw(ROUTE_PROBE_KINDS.map((v) => `'${v}'`).join(', '))})`,
    ),
  ],
);

/**
 * 路由两层的上层「用途 → 模型顺序」（#574，specs/574-路由两层DB）：每个用途（阶段类型）一串模型，越靠前越先用。
 * 选路按这两张表挑（先模型的先后、再模型下路由的先后，queries/engine-route-facts.ts 的 routeFactsForPurpose）。仓里的默认骨架
 * 只在这张表还没有任何一行时写一次（routing-apply.ts，#1356）；已经有行，发版不再补模型、不再改开关。两层没有「钉住」这一列，选路一律按没钉住算。
 * 「这一层现在活着吗」不存列：它由下层现算（routing-liveness.ts 写明三件事各看哪张表的哪几列）。
 */
export const routingPurposeModels = pgTable(
  'routing_purpose_models',
  {
    purpose: stageKind('purpose').notNull(),
    modelId: text('model_id')
      .notNull()
      .references(() => models.id),
    /** 从 0 起，越小越先用。 */
    position: integer('position').notNull(),
    /**
     * 这个用途下这个模型起会话想用的思考档位（#1356）。空 = 这个用途没另配。
     * 引擎起会话仍读 routing_catalog.effort（这条路由的档）；这一列给驾驶舱按用途配，下一片再接到开会话。
     * 认不出的写法由下面的约束挡；这条模型的执行方式认不认这一档，由写入的地方照 routeEffortProblem 判。
     */
    effort: text('effort').$type<SessionEffort>(),
  },
  (t) => [
    primaryKey({ columns: [t.purpose, t.modelId] }),
    unique('routing_purpose_models_purpose_position_unique').on(t.purpose, t.position),
    check('routing_purpose_models_position_nonneg', sql`${t.position} >= 0`),
    check(
      'routing_purpose_models_effort_known',
      sql`${t.effort} is null or ${t.effort} in (${sql.raw(SESSION_EFFORTS.map((e) => `'${e}'`).join(', '))})`,
    ),
  ],
);

/**
 * 每个用途一份整数版本（#1356）：加进、移出、改档位都带「我看到的版本」，对不上就整笔不写。
 * 单独一张表，是因为用途里最后一个模型被移出后，成员行没了，版本还得在（空用途也允许）。
 * 没有这一行 = 版本 0（还没人用这套接口改过）。成功一次加一。
 */
export const routingPurposeRevisions = pgTable(
  'routing_purpose_revisions',
  {
    purpose: stageKind('purpose').primaryKey(),
    version: integer('version').notNull(),
  },
  (t) => [check('routing_purpose_revisions_version_nonneg', sql`${t.version} >= 0`)],
);

/**
 * 路由两层的下层「模型 → 渠道顺序」（#574）：一个模型一串路由（渠道 + 账号池 + 执行方式），越靠前越先用。
 * 加一个能跑这个模型的新渠道，只在这个模型下加一行。路由必须是这个模型自己的（复合外键）。
 * 开关不分用途：关了这一行，哪个用途都不派它；路由探针也只探开着、模型又排进了某个用途的（routing-layers.ts 的 routesInUse）。
 */
export const routingCatalog = pgTable(
  'routing_catalog',
  {
    modelId: text('model_id')
      .notNull()
      .references(() => models.id),
    routeId: text('route_id').notNull(),
    /** 从 0 起，越小越先用。 */
    position: integer('position').notNull(),
    /** 调度台上的开关：关着的照样挂在顺序里，但不派。没有默认值：写入的地方必须逐条带上，漏带就插不进去，不会悄悄全打开。 */
    enabled: boolean('enabled').notNull(),
    /**
     * 这条路由起会话的思考档位（#470）：空 = 没配，用 high（shared 的 DEFAULT_SESSION_EFFORT）。它是这条路由的默认也是上限，
     * 分档只往下压（engine 的 sessionEffortFor）。运行时配置、留在库里（决定 0011 第 7 条）：驾驶舱改了，下一个起的会话就照它；
     * 仓里骨架的值只在用途表还没有任何一行、并且这个模型还没有路由行时写进来（routing-apply.ts）；用途表已经有行，发版不再改这一列。
     * 这一列只挡认不出的写法；这条路由的执行方式认不认这一档（Grok 没有 max、cursor 的整串模型名配不了），由写入的地方
     * 照 shared 的 routeEffortProblem 判（setRoutingEffort、routing-apply.ts），起会话时引擎再判一次。
     */
    effort: text('effort').$type<SessionEffort>(),
  },
  (t) => [
    primaryKey({ columns: [t.modelId, t.routeId] }),
    foreignKey({
      name: 'routing_catalog_route_of_model_fk',
      columns: [t.routeId, t.modelId],
      foreignColumns: [routes.id, routes.modelId],
    }),
    unique('routing_catalog_model_position_unique').on(t.modelId, t.position),
    check('routing_catalog_position_nonneg', sql`${t.position} >= 0`),
    check(
      'routing_catalog_effort_known',
      sql`${t.effort} is null or ${t.effort} in (${sql.raw(SESSION_EFFORTS.map((e) => `'${e}'`).join(', '))})`,
    ),
  ],
);

/** 全局禁令。family 和 modelId 至少填一个；stage 不填 = 所有阶段。 */
export const bans = pgTable(
  'bans',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    family: text('family').references(() => families.id),
    modelId: text('model_id').references(() => models.id),
    stage: stageKind('stage'),
    reason: text('reason').notNull(),
  },
  (t) => [
    check('bans_target_required', sql`${t.family} is not null or ${t.modelId} is not null`),
    unique('bans_target_stage_unique').on(t.family, t.modelId, t.stage).nullsNotDistinct(),
  ],
);

/**
 * 额度窗现值：每个账号池、每个上游窗口（按上游原名 label）各一行，每次读数覆盖。
 * 行数不随读数次数增长，按主键直查。window 是归类（认不出的归 other），scope 为空串 = 账号级窗口。
 * 只经 savePoolQuota 写：上游不再报的窗口先标 stale_since，满 24 小时才删。
 */
export const quotaWindows = pgTable(
  'quota_windows',
  {
    poolId: text('pool_id')
      .notNull()
      .references(() => pools.id),
    /** 上游对这个窗口的原名，同一池里不重复。 */
    label: text('label').notNull(),
    window: quotaWindowKind('window').notNull(),
    scope: text('scope').notNull().default(''),
    utilization: doublePrecision('utilization'),
    used: doublePrecision('used'),
    limit: doublePrecision('limit'),
    unit: quotaUnit('unit').notNull(),
    resetsAt: timestamp('resets_at', tz),
    upstreamStatus: quotaStatus('upstream_status'),
    /** 上游的原状态字。 */
    statusRaw: text('status_raw'),
    reading: readingKind('reading').notNull(),
    /** 读法：claude-usage、mirasim-relay、cursor-dashboard、grok-billing、estimate…… */
    source: text('source').notNull(),
    readAt: timestamp('read_at', tz).notNull(),
    /** 读成了、但上游从这一次起没再报这个窗口的时刻；重新报了清空。不挡路由、不参与排序。 */
    staleSince: timestamp('stale_since', tz),
  },
  (t) => [
    primaryKey({ columns: [t.poolId, t.label] }),
    check('quota_windows_label_nonempty', sql`${t.label} <> ''`),
    check('quota_windows_source_nonempty', sql`${t.source} <> ''`),
    check('quota_windows_utilization_nonneg', sql`${t.utilization} is null or ${t.utilization} >= 0`),
    // 7d_model 必须写组名，否则没法按组匹配路由；别的窗口也可以只扣一组模型（Cursor 的 auto / api 桶）。
    check('quota_windows_model_scope', sql`${t.window} <> '7d_model' or ${t.scope} <> ''`),
  ],
);
