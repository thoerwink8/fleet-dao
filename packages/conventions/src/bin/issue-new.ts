// 开单脚本入口：pnpm issue:new --kind 需求 --milestone v1 --title "…" --body-file 正文.md [--mother] [--parent 母单号] [--local]（见 ../issue-new.ts）
// 退出码：0 开了；1 没开（或开没开说不准，照报的话去 GitHub 找）。帅位座位整张删掉（#531）：
// 开单时替帅位在库里认领那一步（claimLocal）一并删——本机不再在库里认领。
import { fileURLToPath } from 'node:url';
import { ghRunner, issueNew } from '../issue-new.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

try {
  const r = await issueNew(process.argv.slice(2), {
    gh: ghRunner(root),
    cwd: process.env.INIT_CWD || process.cwd(),
  });
  console.log(
    `开了 #${r.number}（${r.milestone}${r.parent === undefined ? '' : `，挂在母单 #${r.parent} 下面`}${r.local ? '，贴了「本机做」：接活不自动派' : ''}）：${r.url}`,
  );
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
