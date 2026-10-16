// changes job 在主线推送时、算计划之前跑这个：找一次「同树、成功、全套」的 PR 检查（判法在 ../main-reuse.ts）：
//   node packages/conventions/src/bin/main-reuse.ts --workflow ci.yml
// 标准输出只有一行：`reuse=<JSON>`（run、pr、tree），直接追加进 $GITHUB_OUTPUT；找不到什么都不打、退出码 0——
// 调用方（ci-plan）见空就照旧全套。每一条没复用的路径都在 Actions 里打一条 ::warning:: 写明原因
// （对不上、查不到、读不到都一样，绝不静默，更不当成可以少跑）。退出码 2 只给参数不对。
// 不用 process.exit：带顶层 await 的模块里调它，Windows 上的 Node 会崩（退出码 0xC0000409），测试在本机也跑。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ghApi } from '../gh-api.ts';
import { findReuse } from '../main-reuse.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const USAGE = '用法：main-reuse.ts [--workflow ci.yml]';

/** 不复用：留一条 ::warning::，退出码 0（调用方照旧全套）。 */
function noReuse(why: string): number {
  console.error(`::warning::主线这一轮不复用 PR 的检查（${why}），照旧全套`);
  return 0;
}

function git(args: string[]): string | { why: string } {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.error || r.status !== 0)
    return { why: `git ${args.join(' ')} 没成（${r.error?.message ?? r.stderr.trim()}）` };
  return r.stdout.trim();
}

async function main(): Promise<number> {
  let workflow = 'ci.yml';
  try {
    const { values } = parseArgs({
      options: { workflow: { type: 'string' } },
      strict: true,
    });
    workflow = values.workflow ?? workflow;
  } catch (e) {
    console.error(`参数不对（${e instanceof Error ? e.message : String(e)}）。${USAGE}`);
    return 2;
  }
  if (!/^[\w.-]+$/.test(workflow)) {
    console.error(`工作流文件名不对。${USAGE}`);
    return 2;
  }

  // 树在这里现算，不信任何一方报的
  const sha = git(['rev-parse', 'HEAD']);
  if (typeof sha !== 'string') return noReuse(sha.why);
  const tree = git(['rev-parse', 'HEAD^{tree}']);
  if (typeof tree !== 'string') return noReuse(tree.why);

  try {
    const r = await findReuse(ghApi(process.env), { sha, tree, workflowFile: workflow });
    if (r.reuse === null) return noReuse(r.why);
    console.error(
      `主线 ${sha.slice(0, 7)} 的树和 PR #${r.reuse.pr} 的检查（运行 ${r.reuse.run}，全套）测的是同一棵：test、web、e2e、deploy 不再重跑`,
    );
    console.log(`reuse=${JSON.stringify(r.reuse)}`);
    return 0;
  } catch (e) {
    return noReuse(`查不成：${e instanceof Error ? e.message : String(e)}`);
  }
}

process.exitCode = await main();
