// 路由两层默认骨架和各渠道额度留量线种子的装载器命令行入口（#574、#194 4.8），发布脚本在目录装载器之后调：
// DATABASE_URL=… node packages/db/src/bin/routing.ts [骨架文件]
// 骨架默认是这一版里的 packages/db/routing.default.json，留量线种子是 packages/db/quota-reserve.default.json（和路由骨架同一条发布链路，
// 不另起一步）。都只补缺、跑几遍都一样；读不到、格式错、引用对不上（骨架里的模型、路由、种子里的池库里没有）都退出 1、对应的库里一行不写，
// 发布那一步跟着红（deploy/release.sh 的 load_routing），不吞。路由骨架先装；它失败就不往下装留量线。
import { createDb } from '../client.ts';
import { runQuotaReserveApply } from '../quota-reserve-apply.ts';
import { runRoutingApply } from '../routing-apply.ts';

const path = process.argv[2];
try {
  const { db, close } = createDb();
  try {
    console.log(await runRoutingApply(db, path || undefined));
    console.log(await runQuotaReserveApply(db));
  } finally {
    await close();
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
