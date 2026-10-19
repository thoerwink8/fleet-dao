// 只由发布版 migration-budget.ts 启动，stdin 是有界数据，不是可执行模块路径。
import { verifyMigrationData } from '../migration-budget-data.ts';

const chunks: Buffer[] = [];
let bytes = 0;
for await (const chunk of process.stdin) {
  bytes += chunk.length;
  if (bytes > 4 * 1024 * 1024) throw new Error('迁移核验输入超限');
  chunks.push(chunk);
}
try {
  await verifyMigrationData(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  process.stdout.write(JSON.stringify({ verified: true }));
} catch (error) {
  process.stdout.write(JSON.stringify({ verified: false, reason: String(error).slice(0, 500) }));
}
