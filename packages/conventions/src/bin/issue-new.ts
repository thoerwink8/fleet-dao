// 开单脚本入口：pnpm issue:new --kind 需求 --milestone 当前 --title "…" --body-file 正文.md [--mother] [--parent 母单号] [--local] [--order-after 单号]（见 ../issue-new.ts）
// 退出码：0 开了（挂版本的母单、单独的单也排进了版本的先后）；1 没开、开没开说不准，或者开了可没挂到母单下面、没排进先后
// （照报的话去 GitHub 找、补）。帅位座位整张删掉（#531）：开单时替帅位在库里认领那一步（claimLocal）一并删——本机不再在库里认领。
// 本机做的单「怎么算做完」里有要 diff 外证据的条目：照开，开完打一段提示改写（交给引擎的单这种在 issueNew 里就拒开了）。
// 开给法国的单开完顺手经 ssh 调一次 fleet-api dispatch-issue（../issue-poke.ts，决定 0096），不等 5 分钟轮询；戳不成只提示。
// 开单前先查同仓开着的单和最近合并的 PR 里有没有可能重复的（#995 拍 3，../issue-similar.ts）：列在开单结果后面，只提示、不影响退出码。
// 带 --local 的开完当场领单（决定 0096，../work.ts 的 pnpm work claim）：登记进法国、带租约、打出分支名；没登记上退出码 1，照报的话补登。
import { fileURLToPath } from 'node:url';
import { describeOrder, ghRunner, issueNew } from '../issue-new.ts';
import { pokeFrance } from '../issue-poke.ts';
import { renderSimilar, similarIssues } from '../issue-similar.ts';
import { describeOffDiff, OFF_DIFF_REWRITE } from '../off-diff-acceptance.ts';
import { liveClaimsPost, readClaimsEndpoint, work } from '../work.ts';

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
    ...(r.order === undefined ? [] : [describeOrder(r.order)]),
  ];
  console.log(`开了 #${r.number}（${notes.join('，')}）：${r.url}`);
  if (r.offDiff) {
    console.log(
      `提示：「怎么算做完」里这几条要 diff 外的证据（本机做的单照开）：\n${describeOffDiff(r.offDiff)}\n${OFF_DIFF_REWRITE}`,
    );
  }
  // 开给法国的单（不是本机做、母单、子单）开完顺手戳一下，让法国立刻接（#决定0096 A6）；戳不成不影响开单，照实说
  if (!r.local && !r.mother && r.parent === undefined) console.log(await pokeFrance(r.url));
  if (r.similar) for (const line of renderSimilar(r.similar, r.number)) console.log(line);
  if (r.local) {
    const claimed = await work(['claim', String(r.number)], {
      gh,
      post: liveClaimsPost(() => readClaimsEndpoint()),
      out: (line) => console.log(line),
      err: (line) => console.error(`单开了，可本机领单没成：${line}。补领：pnpm work claim ${r.number}`),
    });
    if (claimed !== 0) process.exitCode = 1;
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
