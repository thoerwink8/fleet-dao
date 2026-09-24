// 调度台要的配置：族、渠道、账号池、模型、路由、每个阶段的路由顺序、禁令，外加额度窗（机器写的现值）。
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { billingKind, hostId, quotaStatus, quotaWindowKind, readingKind, stageKind } from './enums.ts';

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
    expiresAt: timestamp('expires_at', tz),
  },
  (t) => [
    // 给 routes 的组合外键用：路由挂的池必须属于路由写的渠道。
    unique('pools_channel_id_id_unique').on(t.channelId, t.id),
    check('pools_max_concurrency_positive', sql`${t.maxConcurrency} > 0`),
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
 * 额度窗现值：每个账号池、每个时间窗（模型组窗口再按 scope 分）各一行，每次读数覆盖。
 * 行数不随读数次数增长，按主键直查。scope 为空串 = 账号级窗口。
 */
export const quotaWindows = pgTable(
  'quota_windows',
  {
    poolId: text('pool_id')
      .notNull()
      .references(() => pools.id),
    window: quotaWindowKind('window').notNull(),
    scope: text('scope').notNull().default(''),
    utilization: doublePrecision('utilization'),
    used: doublePrecision('used'),
    limit: doublePrecision('limit'),
    resetsAt: timestamp('resets_at', tz),
    upstreamStatus: quotaStatus('upstream_status'),
    reading: readingKind('reading').notNull(),
    readAt: timestamp('read_at', tz).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.poolId, t.window, t.scope] }),
    check('quota_windows_utilization_nonneg', sql`${t.utilization} is null or ${t.utilization} >= 0`),
    // 模型组窗口必须写组名，账号级窗口不许写：否则两个模型组窗口会撞主键，也没法按组匹配路由。
    check('quota_windows_model_scope', sql`(${t.window} = '7d_model') = (${t.scope} <> '')`),
  ],
);
