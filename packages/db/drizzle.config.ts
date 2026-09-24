// 只用来生成迁移（pnpm --filter @fleet-dao/db db:generate），不连库。
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
});
