// fleet-api groom 的本体（母单 #1335 第 3 片，#1338；法国上经 packages/api/bin/fleet-api 转过来，换成 fleet 身份、带 api.env 跑）：
//   node packages/engine/src/bin/groom.ts <owner/仓名> [--note "<为什么>"]
// 叫一次临时指挥官整理待办：判能不能叫（引擎总开关、同一时刻只一个、这个仓 24 小时内最多 3 次），能就记一条 groom.request，
// 法国引擎几秒内接手（jobs/groom.ts）。逻辑和规矩见 jobs/groom-command.ts、jobs/groom-request.ts。
// 只连库（DATABASE_URL），不连 GitHub、Temporal。退出码：0 排上队了；1 拒了或没查成；2 参数不对。

import { createDb, listIntakeRepos } from '@fleet-dao/db';
import { runGroomCommand } from '../jobs/groom-command.ts';
import { groomRequestDeps } from '../real/groom-request.ts';

const env = process.env;

process.exitCode = await runGroomCommand(process.argv.slice(2), {
  out: (text) => console.log(text),
  err: (text) => console.error(text),
  async open() {
    const { db, close } = createDb({ env });
    return {
      deps: groomRequestDeps(db),
      async repoKnown(slug) {
        const want = slug.toLowerCase();
        return (await listIntakeRepos(db)).some((r) => `${r.owner}/${r.name}`.toLowerCase() === want);
      },
      operator: env.FLEET_OPS_OPERATOR?.trim().slice(0, 64) || '认不出的用户（没经 bin/fleet-api）',
      close,
    };
  },
});
