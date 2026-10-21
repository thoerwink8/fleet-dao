// 方案状态存量回填（#3498，一次性；逻辑在 ../specs-index.ts）：给头部还没有「- 状态：」的方案主文件加上一行。
// 按目录编号对应的单机械判：关了 → 做完，开着 → 在做，没这张单、是 PR → 未复核；不猜「被取代」。正文一字不动，只新增行。
//   node packages/conventions/src/bin/specs-backfill.ts [--write]   不带 --write 只列出要改成什么
// 单的开关一次读全（GitHub 全部 issue），读不到就一个字不写、退出 2。仓名照 resolveRepo（GH_REPO → GITHUB_REPOSITORY → origin）。
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { exitWith, runMain } from '../exit.ts';
import { liveGitHub, resolveRepo } from '../github-api.ts';
import { fsRepo } from '../repo.ts';
import { backfillStatus, mainFile, SPECS_DIR, withStatusLine } from '../specs-index.ts';

runMain(async () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const unknown = args.filter((a) => a !== '--write');
  if (unknown.length > 0) {
    console.error(`参数不对：认不出「${unknown.join(' ')}」。用法：specs-backfill.ts [--write]`);
    exitWith(2);
  }
  const write = args.includes('--write');
  const resolved = resolveRepo(process.env, root);
  if (!resolved.repo) {
    console.error(resolved.error ?? '没查成：认不出是哪个仓（设 GH_REPO=owner/name）。');
    exitWith(2);
  }
  let states: Map<number, string>;
  try {
    const issues = await liveGitHub(resolved.repo, process.env).allIssues();
    states = new Map(issues.map((i) => [i.number, i.state]));
  } catch (e) {
    console.error(
      `没查成：读不到 ${resolved.repo} 的单（${e instanceof Error ? e.message : String(e)}），一个字没写。`,
    );
    exitWith(2);
  }

  const repo = fsRepo(root);
  const dirs = (repo.list(SPECS_DIR) ?? []).filter((d) => repo.isDir(`${SPECS_DIR}/${d}`)).sort();
  const counts = new Map<string, number>();
  for (const dir of dirs) {
    const file = mainFile(repo.list(`${SPECS_DIR}/${dir}`) ?? []);
    if (file === undefined) continue;
    const rel = `${SPECS_DIR}/${dir}/${file}`;
    const text = repo.read(rel);
    if (text === undefined) {
      console.error(`读不到 ${rel}，跳过。`);
      continue;
    }
    const number = Number(/^(\d+)-/.exec(dir)?.[1] ?? Number.NaN);
    const state = states.get(number);
    const status = backfillStatus(state === undefined ? undefined : { state });
    const next = withStatusLine(text, status);
    if (next === undefined) continue;
    counts.set(status, (counts.get(status) ?? 0) + 1);
    console.log(`${rel}  → ${status}（#${number} ${state ?? '对不上单'}）`);
    if (write) writeFileSync(`${root}${rel}`, next, 'utf8');
  }
  const summary = [...counts].map(([s, n]) => `${s} ${n}`).join('、') || '没有要补的';
  console.log(`${write ? '写好了' : '只列出，没写（加 --write 才写）'}：${summary}。`);
  return undefined;
});
