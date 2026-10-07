// 开单脚本入口：pnpm issue:new --kind 需求 --milestone v1 --title "…" --body-file 正文.md [--mother] [--parent 母单号] [--local] [--order-after 单号]（见 ../issue-new.ts）
// 退出码：0 开了（挂版本的母单、单独的单也排进了版本的先后）；1 没开、开没开说不准，或者开了可没挂到母单下面、没排进先后
// （照报的话去 GitHub 找、补）。帅位座位整张删掉（#531）：开单时替帅位在库里认领那一步（claimLocal）一并删——本机不再在库里认领。
// 开单前先查同仓开着的单和最近合并的 PR 里有没有可能重复的（#995 拍 3，../issue-similar.ts）：列在开单结果后面，只提示、不影响退出码。
import { fileURLToPath } from 'node:url';
import { ghRunner, issueNew } from '../issue-new.ts';
import { renderSimilar, similarIssues } from '../issue-similar.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

try {
  const gh = ghRunner(root);
  const r = await issueNew(process.argv.slice(2), {
    gh,
    cwd: process.env.INIT_CWD || process.cwd(),
    similar: (q) => similarIssues(gh, q),
  });
  const notes = [
    r.milestone,
    ...(r.parent === undefined ? [] : [`挂在母单 #${r.parent} 下面`]),
    ...(r.local ? ['贴了「本机做」：接活不自动派'] : []),
    ...(r.order === undefined ? [] : [`排进先后第 ${r.order.position} 位（共 ${r.order.count} 张）`]),
  ];
  console.log(`开了 #${r.number}（${notes.join('，')}）：${r.url}`);
  if (r.similar) for (const line of renderSimilar(r.similar, r.number)) console.log(line);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
