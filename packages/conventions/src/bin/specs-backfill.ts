// 方案状态存量回填（#3498，一次性；逻辑在 ../specs-index.ts 的 planBackfill）：给头部还没有「- 状态：」的方案主文件加上一行。
// 按目录编号对应的单机械判：关了 → 做完，开着 → 在做，没这张单、是 PR、读不到单的状态 → 未复核；不猜「被取代」。
// 正文一字不动，只新增行。读不到某份主文件没法往里加行：列出来、其余照写，最后退出 2（不当成回填完了）。
//   node packages/conventions/src/bin/specs-backfill.ts [--write]   不带 --write 只列出要改成什么
// 单的开关一次读全（GitHub 全部 issue）；读不到就每份都标「未复核」（不整批放弃）。仓名照 resolveRepo（GH_REPO → GITHUB_REPOSITORY → origin）。
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { exitWith, runMain } from '../exit.ts';
import { liveGitHub, resolveRepo } from '../github-api.ts';
import { fsRepo } from '../repo.ts';
import { planBackfill } from '../specs-index.ts';

runMain(async () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const unknown = args.filter((a) => a !== '--write');
  if (unknown.length > 0) {
    console.error(`参数不对：认不出「${unknown.join(' ')}」。用法：specs-backfill.ts [--write]`);
    exitWith(2);
  }
  const write = args.includes('--write');
  let states: Map<number, string> | undefined;
  const resolved = resolveRepo(process.env, root);
  if (!resolved.repo) {
    console.error(
      `${resolved.error ?? '认不出是哪个仓（设 GH_REPO=owner/name）。'}读不到单的状态，每份标「未复核」。`,
    );
  } else {
    try {
      const issues = await liveGitHub(resolved.repo, process.env).allIssues();
      states = new Map(issues.map((i) => [i.number, i.state]));
    } catch (e) {
      console.error(
        `没查成：读不到 ${resolved.repo} 的单（${e instanceof Error ? e.message : String(e)}），每份标「未复核」。`,
      );
    }
  }

  const { changes, problems } = planBackfill(fsRepo(root), states);
  const counts = new Map<string, number>();
  for (const c of changes) {
    counts.set(c.status, (counts.get(c.status) ?? 0) + 1);
    console.log(`${c.rel}  → ${c.status}（${c.why}）`);
    if (write) writeFileSync(`${root}${c.rel}`, c.next, 'utf8');
  }
  const summary = [...counts].map(([s, n]) => `${s} ${n}`).join('、') || '没有要补的';
  console.log(`${write ? '写好了' : '只列出，没写（加 --write 才写）'}：${summary}。`);
  for (const p of problems) console.error(p);
  if (problems.length > 0) exitWith(2);
  return undefined;
});
