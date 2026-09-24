// 调度台要的配置：族、渠道、账号池、模型、路由、每个阶段的路由顺序、禁令，外加额度窗（机器写的现值）。

import type { ScopeMembership } from '@fleet-dao/shared';
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
  quotaStatus,
  quotaUnit,
  quotaWindowKind,
  readingKind,
  stageKind,
} from './enums.ts';

const tz = { withTimezone: true, mode: 'date' } as const;

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
  },
  (t) => [
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
    /** 只由探针和熔断写。新路由没探过，默认不在线。 */
    alive: boolean('alive').notNull().default(false),
    /** 插头实际发给上游的模型串（目录原文）。额度成员表只和它、和别名比；都没填，扣哪个桶判不了。 */
    upstreamModel: text('upstream_model'),
    /** 上游在别处（额度接口的成员表）对这条路由的叫法，和上面的模型串不同名时填。 */
    upstreamAliases: text('upstream_aliases').array().notNull().default(sql`'{}'::text[]`),
  },
  (t) => [
    foreignKey({
      name: 'routes_pool_in_channel_fk',
      columns: [t.channelId, t.poolId],
      foreignColumns: [pools.channelId, pools.id],
    }),
    // 同一模型换一种执行方式就是另一条路由；同池同模型同执行方式不许重复。
    unique('routes_pool_model_host_unique').on(t.poolId, t.modelId, t.hostId),
  ],
);

/** 每个阶段类型一行；顺序在 stage_policy_routes。 */
export const stagePolicies = pgTable('stage_policies', {
  stage: stageKind('stage').primaryKey(),
  /** 创始人手动钉住的顺序，AI 帅位不改。 */
  pinned: boolean('pinned').notNull().default(false),
});

export const stagePolicyRoutes = pgTable(
  'stage_policy_routes',
  {
    stage: stageKind('stage')
      .notNull()
      .references(() => stagePolicies.stage, { onDelete: 'cascade' }),
    routeId: text('route_id')
      .notNull()
      .references(() => routes.id),
    /** 从 0 起，越小越先用。 */
    position: integer('position').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.stage, t.routeId] }),
    unique('stage_policy_routes_stage_position_unique').on(t.stage, t.position),
    check('stage_policy_routes_position_nonneg', sql`${t.position} >= 0`),
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
