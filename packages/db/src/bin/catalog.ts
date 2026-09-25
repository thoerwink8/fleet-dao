// 目录装载器的命令行入口，发布脚本在迁移之后调：DATABASE_URL=… node packages/db/src/bin/catalog.ts [目录配置文件]
// 配置文件默认 /etc/fleet-dao/catalog.json，也可以用环境变量 FLEET_CATALOG 指定。
// 只补缺、跑几遍都一样；缺文件、格式错、引用不存在都退出 1，库里一行不写。
import { catalogPath, formatCatalogResult, loadCatalog, readCatalogFile } from '../catalog.ts';
import { createDb } from '../client.ts';

const path = catalogPath(process.argv.slice(2), process.env);
try {
  const config = await readCatalogFile(path);
  const { db, close } = createDb();
  try {
    console.log(formatCatalogResult(await loadCatalog(db, config, { source: path })));
  } finally {
    await close();
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
