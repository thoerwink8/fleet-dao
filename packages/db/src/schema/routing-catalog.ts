// 路由两层副本（specs/509-需求梳理/流程重做方案.md 第八节、specs/574-路由两层DB/需求.md）：
// 「用途 → 模型顺序」+「模型 → 渠道顺序」整套放进同一张表，一次对账整份覆盖。读「这条现在活着吗」
// 的代码不在本切片——这里只把「哪里有这条」说清楚（status、last_error、检查约束的形状），
// 引擎后续切片按这两列 + routes/pools 的现值判死活。
import { sql } from 'drizzle-orm';
import { check, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

const tz = { withTimezone: true, mode: 'date' } as const;

/** 引擎认的路由配置版本；和 packages/core/src/routing-catalog.ts 的 ROUTING_FORMAT_VERSION 同步。 */
export const ROUTING_CATALOG_FORMAT_VERSION = 1;

/**
 * 一行 = 一份「同一时刻读出来的」整份副本。id = source（org_default / 仓 owner/name
 * 暂记 project/<owner>/<name>，后续接三层覆盖时再加）。一份副本一次对账全量覆盖：
 * catalog 里第一二层的全部行、写进 payload，外加这个版本最后对账一次的结果。
 *
 * 跟 routes/route_pools/pools/models 完全分离（那些是「在哪派、额度多少」的事实层）；
 * 这张表的行数是「每个仓 + 一份全组织默认」，不会按调用次数增长。
 */
export const routingCatalog = pgTable(
  'routing_catalog',
  {
    /** org_default = 全组织默认；其他来源先不写。 */
    source: text('source').notNull(),
    /** 合并、校验后的整份（core 的 RoutingCatalog）。 */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    /** 这份配置读自默认分支的哪个提交；读不到读自哪不许写。 */
    commit: text('commit').notNull(),
    /** 一行一个用途的脉。 */
    purposesVersion: integer('purposes_version').notNull(),
    /** 最近一次读成、认得出的时刻；用来跟 routes.probe 比新不新鲜。 */
    syncedAt: timestamp('synced_at', tz).notNull(),
    /** 最近一次对账指向的时刻（读没读成都记）。 */
    checkedAt: timestamp('checked_at', tz).notNull(),
    /** 最近一次没读成的原因（GitHub 出错、配置认不出等）；成功对账清空。 */
    lastError: text('last_error'),
    /**
     * 这份副本「有没被源头接受」：fresh = 最近一次对账读成、payload 是新的；
     * stale = 最近一次没读成 / 主线上 commit 变了还没追上；blocked = 主线读出了
     * 更严格的版本（formatVersion 比我们认的高），等引擎升级才动。
     */
    status: text('status').$type<'fresh' | 'stale' | 'blocked'>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.source] }),
    check('routing_catalog_commit_sha', sql`${t.commit} ~ '^[0-9a-f]{40}$'`),
    check('routing_catalog_status_known', sql`${t.status} in ('fresh', 'stale', 'blocked')`),
    // Postgres 的 CHECK 只拒 false、null 通过；任何一段是 null 整条就放行，所以每段都要包「非 true 就拒」。
    check(
      'routing_catalog_payload_shape',
      sql`
        coalesce(jsonb_typeof(${t.payload}) = 'object', false)
        and coalesce(jsonb_typeof(${t.payload} -> 'purposes') = 'object', false)
        and coalesce(jsonb_typeof(${t.payload} -> 'models') = 'object', false)
        and coalesce(${t.payload} ->> 'formatVersion' = '1', false)
      `,
    ),
    check('routing_catalog_purposes_version_positive', sql`${t.purposesVersion} >= 1`),
    check('routing_catalog_error_shape', sql`${t.lastError} is null or ${t.lastError} <> ''`),
  ],
);
