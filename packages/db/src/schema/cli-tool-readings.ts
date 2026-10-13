// 命令行工具最近一次读数（#1969）。只存读到的版本和读不到的原因，不存「落后」：落后由读的时候现算。
// 在用版本和它的错误恰好一个非空，官方最新和它的错误也恰好一个非空。release_versions 为空表示发布源没给列表。
import { sql } from 'drizzle-orm';
import { check, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

const tz = { withTimezone: true, mode: 'date' } as const;

export const cliToolReadings = pgTable(
  'cli_tool_readings',
  {
    /** user = 某个家目录；npm = 全局 npm，不按用户重复。 */
    scope: text('scope').notNull(),
    /** 会话用户名。全局 npm 这一列是空串。 */
    owner: text('owner').notNull(),
    tool: text('tool').notNull(),
    installedVersion: text('installed_version'),
    installedError: text('installed_error'),
    latestVersion: text('latest_version'),
    latestError: text('latest_error'),
    /** 发布源给的版本号。null = 没给列表（不是「只有最新这一版」）。 */
    releaseVersions: jsonb('release_versions').$type<string[] | null>(),
    checkedAt: timestamp('checked_at', tz).notNull(),
  },
  (t) => [
    primaryKey({ name: 'cli_tool_readings_pk', columns: [t.scope, t.owner, t.tool] }),
    check('cli_tool_readings_scope_known', sql`${t.scope} in ('user', 'npm')`),
    check(
      'cli_tool_readings_installed_one',
      sql`(${t.installedVersion} is not null and ${t.installedError} is null) or (${t.installedVersion} is null and coalesce(${t.installedError}, '') <> '')`,
    ),
    check(
      'cli_tool_readings_latest_one',
      sql`(${t.latestVersion} is not null and ${t.latestError} is null) or (${t.latestVersion} is null and coalesce(${t.latestError}, '') <> '')`,
    ),
  ],
);
