// 开单脚本入口：pnpm issue:new --kind 需求 --milestone 当前 --title "…" --body-file 正文.md [--mother] [--parent 母单号] [--local] [--order-after 单号]（见 ../issue-new.ts）
// 退出码：0 开了（挂版本的母单、单独的单也排进了版本的先后）；1 没开、开没开说不准，或者开了可没挂到母单下面、没排进先后
// （照报的话去 GitHub 找、补）。帅位座位整张删掉（#531）：开单时替帅位在库里认领那一步（claimLocal）一并删——本机不再在库里认领。
// 本机做的单「怎么算做完」里有要 diff 外证据的条目：照开，开完打一段提示改写（交给引擎的单这种在 issueNew 里就拒开了）。
// 开单先走法国的开单服务（POST /api/nodes/issues，../issue-intake.ts，决定 0122）：法国连不上、超时、401、503 才退回 gh 直连开单并打一行原因；
// 法国回 409（同题强命中，打出候选，--force 照开、--merge-into <号> 并进那张单）、422（正文问题）不退回，退出码 1。
// 并进别的单（merged）时打「并进了 #N（没开新单）」，挂母单、排先后、戳法国、领单都跳过。走法国时相似单法国已查，本机不再查；退回 gh 才查。
// 母单（--mother）、写具体版本名的 --milestone 直接 gh。挂母单（--parent）、排先后开完单后仍在本机用 gh 做。
// 开给法国的单开完顺手调一次法国的 POST /api/nodes/dispatch（../issue-poke.ts，决定 0096、0122），不等 5 分钟轮询；戳不成只提示。
// 开单前先查同仓开着的单和最近合并的 PR 里有没有可能重复的（#995 拍 3，../issue-similar.ts）：列在开单结果后面，只提示、不影响退出码。
// 带 --local 的开完当场领单（决定 0096，../work.ts 的 pnpm work claim）：登记进法国、带租约、打出分支名；没登记上退出码 1，照报的话补登。
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveRepo } from '../github-api.ts';
import { type FranceIntake, liveIntakePost } from '../issue-intake.ts';
import { describeOrder, ghRunner, issueNew } from '../issue-new.ts';
import { pokeFrance } from '../issue-poke.ts';
import { renderSimilar, similarIssues } from '../issue-similar.ts';
import { describeOffDiff, OFF_DIFF_REWRITE } from '../off-diff-acceptance.ts';
import { liveClaimsPost, readClaimsEndpoint, work } from '../work.ts';
import { removeLease, writeLease } from '../work-queue.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

/** 法国开单通道：认不出开给哪个仓就不走法国（直接 gh，和以前一样）。 */
function franceIntake(): FranceIntake | undefined {
  const { repo } = resolveRepo(process.env, root);
  if (!repo) return undefined;
  return {
    repo,
    ref: process.env.CLAUDE_CODE_SESSION_ID?.trim() || `${hostname()}-${new Date().toISOString()}`,
    post: liveIntakePost(),
  };
}

try {
  const gh = ghRunner(root);
  const r = await issueNew(process.argv.slice(2), {
    gh,
    cwd: process.env.INIT_CWD || process.cwd(),
    similar: (q) => similarIssues(gh, q),
    france: franceIntake(),
    warn: (line) => console.error(line),
  });
  if (r.merged) {
    // 并进了别的单：没开新单，挂母单、排先后、戳法国、领单都不做
    console.log(`并进了 #${r.number}（没开新单）：${r.url}`);
    process.exit(0);
  }
  const notes = [
    r.milestone,
    ...(r.existing ? ['法国回：这张单之前已开过，没重复开'] : []),
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
      // 租约本机记一份，pnpm work queue 才认得这张在做（法国的租约本机读不到，单 #2731）
      leases: { write: (rec) => writeLease(rec), remove: (repo, issue) => removeLease(repo, issue) },
    });
    if (claimed !== 0) process.exitCode = 1;
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
