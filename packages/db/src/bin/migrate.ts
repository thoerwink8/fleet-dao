// 给真库跑迁移：DATABASE_URL=… pnpm --filter @fleet-dao/db db:migrate
import { createDb } from '../client.ts';
import { runMigrations } from '../migrate.ts';

const { db, close } = createDb();
try {
  await runMigrations(db);
  console.log('迁移已跑完');
} finally {
  await close();
}
