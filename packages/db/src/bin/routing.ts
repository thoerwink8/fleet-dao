// 路由两层默认骨架的装载器命令行入口（#574），发布脚本在目录装载器之后调：DATABASE_URL=… node packages/db/src/bin/routing.ts [骨架文件]
// 骨架默认是这一版里的 packages/db/routing.default.json。只补缺、跑几遍都一样；读不到、格式错、引用对不上（骨架里的模型、
// 路由库里没有）都退出 1、库里一行不写，发布那一步跟着红（deploy/release.sh 的 load_routing），不吞。
import { createDb } from '../client.ts';
import { runRoutingApply } from '../routing-apply.ts';

const path = process.argv[2];
try {
  const { db, close } = createDb();
  try {
    console.log(await runRoutingApply(db, path || undefined));
  } finally {
    await close();
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
