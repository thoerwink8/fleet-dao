// 给真库写种子（先跑迁移）：DATABASE_URL=… pnpm --filter @fleet-dao/db db:seed
import { createDb } from '../client.ts';
import { seed } from '../seed.ts';

const { db, close } = createDb();
try {
  console.log('新写入的行数', await seed(db));
} finally {
  await close();
}
