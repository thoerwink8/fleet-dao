// 库的大小（#1985）：资源页「数据库」那一行和磁盘占用榜里的「库 fleet」等。走 SQL，不读数据目录（归 postgres、700，后端读不了）。
// pg_database_size 要对那个库有 CONNECT 权限（默认 PUBLIC 有）；没有的那个库单写没读到，不让一个库连累整条查询。
// 只在按目录的磁盘占用那一回里查（10 分钟一次，disk-footprint.ts），不在 5 秒那一回里。
import type { DatabaseSizes } from './disk-footprint.ts';

export const DATABASE_SIZES_SQL =
  "select datname as name, case when has_database_privilege(datname, 'CONNECT') then pg_database_size(datname) end as bytes " +
  'from pg_database where not datistemplate order by datname';

/** postgres.js 把 bigint 给成字符串：转成数；null（没权限）是 undefined；认不出的抛（整块写没读到，不拿 0 顶）。 */
export function parseDatabaseSizes(
  rows: readonly { name: unknown; bytes: unknown }[],
): { name: string; bytes: number | undefined }[] {
  return rows.map((r) => {
    if (typeof r.name !== 'string' || r.name === '') throw new Error(`库名认不出：${JSON.stringify(r.name)}`);
    if (r.bytes === null || r.bytes === undefined) return { name: r.name, bytes: undefined };
    const n =
      typeof r.bytes === 'number' ? r.bytes : typeof r.bytes === 'string' ? Number(r.bytes) : Number.NaN;
    if (!Number.isSafeInteger(n) || n < 0)
      throw new Error(`库 ${r.name} 的大小认不出：${JSON.stringify(r.bytes)}`);
    return { name: r.name, bytes: n };
  });
}

/** 接 postgres.js 的连接（main.ts 的 client.unsafe）。 */
export function pgDatabaseSizes(
  query: (text: string) => Promise<readonly { name: unknown; bytes: unknown }[]>,
): DatabaseSizes {
  return async () => parseDatabaseSizes(await query(DATABASE_SIZES_SQL));
}
