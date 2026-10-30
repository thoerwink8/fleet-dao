// 只用来生成迁移（pnpm --filter @fleet-dao/harness-store db:generate），不连库。只管 fleet2 这个 schema。
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  schemaFilter: ['fleet2'],
  migrations: { schema: 'fleet2', table: '__migrations' },
});
