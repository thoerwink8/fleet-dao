// pnpm line:stats：两条线（引擎 / 本机）近 7、30 天的交付质量对比（决定 0093 的 A4，SQL 和口径见 queries/executor-line-stats.ts）。
//   DATABASE_URL=… pnpm line:stats        连库算，打印 JSON
//   pnpm line:stats --sql                 只打印 SQL，本机没有库连接时经 ssh 管给法国的只读 psql
import { createDb } from '../client.ts';
import { executorLineStats, executorLineStatsSql } from '../queries/executor-line-stats.ts';

if (process.argv.includes('--sql')) {
  console.log(`${executorLineStatsSql()};`);
} else {
  const { db, close } = createDb();
  try {
    console.log(JSON.stringify(await executorLineStats(db), null, 2));
  } finally {
    await close();
  }
}
