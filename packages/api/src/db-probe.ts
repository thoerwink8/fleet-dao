// 健康检查探库。原来在 pg-store.ts 里，搬 Store 时留在 api：它抛 PublicHealthError（health.ts，公网看得到的原因），
// store 不能反过来依赖 health.ts；health-public-text.test.ts 数 api/src 里每一处 new PublicHealthError，留在这里才不漏扫。

import type { Db } from '@fleet-dao/db';
import { repos, tasks, users } from '@fleet-dao/db';
import { sqlState } from '@fleet-dao/store';
import { sql } from 'drizzle-orm';
import { PublicHealthError } from './health.ts';

/** 健康检查探库的上限：比单项上限（health.ts 的 3 秒）早到点，报出来的是「查库超时」而不是笼统的超时。 */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * 健康检查用：真去读登录和首页要用的表（users、repos、tasks），本事务里等锁和跑语句都限时，到点报红。
 * 只 select 1 查不出「表被锁住」：锁表时它照样秒回，接口却全卡住。
 */
export async function probeDb(db: Db, timeoutMs = PROBE_TIMEOUT_MS): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      const ms = String(timeoutMs);
      await tx.execute(
        sql`select set_config('lock_timeout', ${ms}, true), set_config('statement_timeout', ${ms}, true)`,
      );
      await tx.execute(
        sql`select (select 1 from ${users} limit 1), (select 1 from ${repos} limit 1), (select 1 from ${tasks} limit 1)`,
      );
    });
  } catch (err) {
    const code = sqlState(err);
    // 57014 = 语句超时，55P03 = 等锁超时。
    if (code === '57014' || code === '55P03') {
      throw new PublicHealthError('timeout', `查库超过 ${timeoutMs / 1000} 秒没回来（多半有表被锁住）`);
    }
    throw err;
  }
}
