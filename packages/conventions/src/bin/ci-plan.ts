// CI 的 changes job 入口（.github/workflows/ci.yml，判法在 ../ci-plan.ts）：
//   node packages/conventions/src/bin/ci-plan.ts [--event pull_request|push|…] [--reuse <JSON>]
// CI 一律全套（决定 0101）：不看改了什么，全部测试按仓里的耗时表装进几台（../test-split.ts）、web、e2e 全套、deploy 全套。
// 主线推送带了 --reuse（main-reuse.ts 那一步找到的同树 PR 检查）且这里现算的树对得上，就整轮复用、test、web、e2e、deploy 都不跑。
// 结果写进 $GITHUB_OUTPUT（下游 job 的开关）和 $GITHUB_STEP_SUMMARY；本机不设这两个变量时只打出来。
// 退出码 0 = 算出来了；2 = 没算成（列不出测试文件、装不了箱、写不进 $GITHUB_OUTPUT、参数不对）——判红，不许静默少跑。
// 耗时表读不出不算没算成：照样每个文件都分到一台，只打 ::warning::（它只影响分得匀不匀）。
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { applyReuse, assignTests, ciFullPlan, planOutputs } from '../ci-plan.ts';
import { exitWith, runMain } from '../exit.ts';
import { parseReuse } from '../main-reuse.ts';
import { fsRepo } from '../repo.ts';
import {
  listTestFiles,
  parseTimings,
  TIMINGS_FILE,
  timingsStaleWarning,
  unitOfTestFile,
} from '../test-split.ts';

// 退出不用 process.exit（Windows 上偶发崩成 3221226505，../exit.ts）：提前退出用 exitWith，runMain 接住设退出码。
runMain(() => {
  const USAGE = '用法：ci-plan.ts [--event pull_request|push] [--reuse <JSON>]';
  const root = fileURLToPath(new URL('../../../../', import.meta.url));

  function fail(why: string): never {
    console.error(`::error::没算成要跑什么：${why}`);
    exitWith(2);
  }

  let event = 'pull_request';
  /** 主线同树复用（--reuse，main-reuse.ts 那一步的输出，JSON）；空 = 没复用。认不出、树对不上都当没复用，照旧全套。 */
  let reuseText = '';
  try {
    const { values } = parseArgs({
      options: {
        event: { type: 'string' },
        reuse: { type: 'string' },
      },
      strict: true,
    });
    event = values.event ?? event;
    reuseText = values.reuse ?? reuseText;
  } catch (e) {
    console.error(`参数不对（${e instanceof Error ? e.message : String(e)}）。${USAGE}`);
    exitWith(2);
  }

  function git(args: string[]): string {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (r.error) fail(`git ${args.join(' ')} 跑不起来（${r.error.message}）`);
    if (r.status !== 0) fail(`git ${args.join(' ')} 退出 ${r.status}：${r.stderr.trim()}`);
    return r.stdout;
  }

  const repo = fsRepo(root);
  const assigned = assignTests(ciFullPlan(), {
    all: listTestFiles(repo),
    timings: parseTimings(repo.read(TIMINGS_FILE)),
    read: (rel) => repo.read(rel),
  });
  if (typeof assigned === 'string') fail(assigned);
  let { plan } = assigned;
  const { packed } = assigned;
  // 同树复用：只在主线推送上认；这里再核一遍树（main-reuse.ts 那一步核过，这里不信它的输出）。
  // 对不上、认不出一律当没复用：照旧全套，并留 ::warning::。
  if (reuseText.trim() !== '') {
    const reuse = parseReuse(reuseText);
    if (event !== 'push') {
      fail('--reuse 只能和 push 事件一起给');
    } else if (reuse === null) {
      console.log(`::warning::同树复用的记录认不出（${reuseText.slice(0, 200)}），不复用，照旧全套`);
    } else {
      const headTree = git(['rev-parse', 'HEAD^{tree}']).trim();
      if (headTree !== reuse.tree) {
        console.log(
          `::warning::同树复用的记录和这一轮的检出对不上（树 ${headTree.slice(0, 7)}，记录是 ${reuse.tree.slice(0, 7)}），不复用，照旧全套`,
        );
      } else {
        plan = applyReuse(plan, reuse);
      }
    }
  }
  if (packed?.timingsProblem)
    console.log(`::warning::${packed.timingsProblem}：测试照样每个都跑，只是分台可能不匀`);
  // 表缺的文件占比超过 10% 也提醒（只提醒、不挡）：判法只看检出来的表和测试文件（#299），不读 GitHub
  const stale = packed && packed.boxes.length > 0 ? timingsStaleWarning(packed) : undefined;
  if (stale !== undefined) console.log(`::warning::${stale}`);
  const outputs = planOutputs(plan);

  /** 一台装了哪些单元：「engine 12、api 3」。 */
  const unitsOf = (files: readonly string[]) => {
    const n = new Map<string, number>();
    for (const f of files) n.set(unitOfTestFile(f) ?? '?', (n.get(unitOfTestFile(f) ?? '?') ?? 0) + 1);
    return [...n].map(([u, c]) => `${u} ${c}`).join('、');
  };
  const human = [
    plan.reused ? '同树复用' : '全套',
    ...plan.reasons.map((r) => `- ${r}`),
    `biome：${plan.biome}（tsc：${outputs.tsc || '不跑'}）`,
    plan.tests.length === 0
      ? 'test：不跑'
      : `test：${plan.tests.length} 台，${plan.tests.reduce((s, b) => s + b.files.length, 0)} 个测试文件，估计耗时合计 ${Math.round(plan.tests.reduce((s, b) => s + b.estMs, 0) / 1000)} 秒`,
    ...plan.tests.map(
      (b) =>
        `- test (${b.label})：${b.files.length} 个文件，估 ${Math.round(b.estMs / 1000)} 秒（${unitsOf(b.files)}）`,
    ),
    `web：${plan.web}  e2e：${plan.e2e === 'all' ? '全套' : '不跑'}  deploy：${plan.deploy}`,
  ];
  console.log(`事件：${event}`);
  for (const line of human) console.log(line);

  const outFile = process.env.GITHUB_OUTPUT;
  if (outFile) {
    try {
      appendFileSync(
        outFile,
        Object.entries(outputs)
          .map(([k, v]) => `${k}=${v}\n`)
          .join(''),
      );
    } catch (e) {
      fail(`写不进 GITHUB_OUTPUT（${e instanceof Error ? e.message : String(e)}）`);
    }
  }
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    try {
      appendFileSync(summary, `### 这次跑什么\n\n${human.join('\n')}\n`);
    } catch {
      // 摘要只给人看；写不上不影响开关
    }
  }
  return undefined;
});
