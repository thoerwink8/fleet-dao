// 给真库跑 fleet2 的迁移：发版时 deploy/release.sh 在旧库迁移之后调（DATABASE_URL 由它给）。
// 只进不退；记账表在 fleet2.__migrations，和旧库的 drizzle.__drizzle_migrations 分开（旧代码不碰 fleet2，旧版本的回退判断不用管它）。
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { MIGRATION_OPTIONS } from '../index.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('没给 DATABASE_URL，不跑');
  process.exit(2);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  await migrate(drizzle(sql), MIGRATION_OPTIONS);
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from fleet2.__migrations`;
  console.log(`fleet2 迁移已跑完（共 ${row?.n ?? '?'} 个）`);
} finally {
  await sql.end({ timeout: 5 });
}
