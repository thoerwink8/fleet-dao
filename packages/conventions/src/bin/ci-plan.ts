// CI 的 changes job 入口（.github/workflows/ci.yml，判法在 ../ci-plan.ts）：
//   node packages/conventions/src/bin/ci-plan.ts [--event pull_request|push|…] [--base origin/main] [--main-base <提交>]
// PR：用 git diff --name-only --no-renames <base>...HEAD 算改了什么（改名拆成删旧 + 加新，两头都算）；push 给了 --main-base 就按「基准…HEAD」这段累计改动算（同一份判法）；别的事件、push 没给基准全跑。
// 结果写进 $GITHUB_OUTPUT（下游 job 的开关）和 $GITHUB_STEP_SUMMARY；本机不设这两个变量时只打出来。
// 选中的测试文件按仓里的耗时表装进几台（../test-split.ts），每台的文件清单、估计秒数打在日志和摘要里。
// 退出码 0 = 算出来了；2 = 没算成（base 拿不到、git diff 失败、列不出测试文件、装不了箱、写不进 $GITHUB_OUTPUT）——判红，不许静默少跑。
// 耗时表读不出不算没算成：照样每个文件都分到一台，只打 ::warning::（它只影响分得匀不匀）。
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assignTests, planCi, planOutputs, readGraph } from '../ci-plan.ts';
import { fsRepo } from '../repo.ts';
import { listTestFiles, parseTimings, TIMINGS_FILE, unitOfTestFile } from '../test-split.ts';

const USAGE = '用法：ci-plan.ts [--event pull_request|push] [--base origin/main|<提交>]';
const root = fileURLToPath(new URL('../../../../', import.meta.url));

function fail(why: string): never {
  console.error(`::error::没算成要跑什么：${why}`);
  process.exit(2);
}

let event = 'pull_request';
let base = 'origin/main';
/** 主线那一轮的基准提交（--main-base）；空 = 没给，主线照旧全跑（退到全跑，绝不静默少跑）。 */
let mainBase = '';
try {
  const { values } = parseArgs({
    options: {
      event: { type: 'string' },
      base: { type: 'string' },
      'main-base': { type: 'string' },
    },
    strict: true,
  });
  event = values.event ?? event;
  base = values.base ?? base;
  mainBase = values['main-base'] ?? mainBase;
} catch (e) {
  console.error(`参数不对（${e instanceof Error ? e.message : String(e)}）。${USAGE}`);
  process.exit(2);
}

function git(args: string[]): string {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) fail(`git ${args.join(' ')} 跑不起来（${r.error.message}）`);
  if (r.status !== 0) fail(`git ${args.join(' ')} 退出 ${r.status}：${r.stderr.trim()}`);
  return r.stdout;
}

let changed: string[] = [];
/** 交给 planCi 的事件：主线给了基准就按「改动区间」算，跟 PR 同一份判法（planCi 只认 pull_request 才按改动）。 */
let planEvent = event;
if (event === 'pull_request') {
  if (base.startsWith('-')) fail(`base 不像分支名：${base}`);
  git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  changed = git(['diff', '--name-only', '-z', '--no-renames', `${base}...HEAD`])
    .split('\0')
    .filter((f) => f !== '');
} else if (event === 'push' && mainBase !== '') {
  // 主线：跑「上次真绿的头 … 这次的头」这段累计改动（基准由 main-baseline.ts 查出，工作流经 --main-base 传进来）。
  // 两点不是三点：要的是这段区间里改过什么；三个点从共同祖先算，落后/取消造成的分叉会少算。
  // 基准认不出、diff 失败都 fail（退出 2、判红）；没给 --main-base 就照旧全跑，绝不静默少跑。
  if (mainBase.startsWith('-')) fail(`主线基准不像提交：${mainBase}`);
  git(['rev-parse', '--verify', '--quiet', `${mainBase}^{commit}`]);
  changed = git(['diff', '--name-only', '-z', '--no-renames', mainBase, 'HEAD'])
    .split('\0')
    .filter((f) => f !== '');
  planEvent = 'pull_request';
}

const repo = fsRepo(root);
const assigned = assignTests(planCi({ event: planEvent, changed, graph: readGraph(repo) }), {
  all: listTestFiles(repo),
  timings: parseTimings(repo.read(TIMINGS_FILE)),
  read: (rel) => repo.read(rel),
});
if (typeof assigned === 'string') fail(assigned);
const { plan, packed } = assigned;
if (packed?.timingsProblem)
  console.log(`::warning::${packed.timingsProblem}：测试照样每个都跑，只是分台可能不匀`);
const outputs = planOutputs(plan);

/** 一台装了哪些单元：「engine 12、api 3」。 */
const unitsOf = (files: readonly string[]) => {
  const n = new Map<string, number>();
  for (const f of files) n.set(unitOfTestFile(f) ?? '?', (n.get(unitOfTestFile(f) ?? '?') ?? 0) + 1);
  return [...n].map(([u, c]) => `${u} ${c}`).join('、');
};
const human = [
  plan.full ? '全跑' : '按改动跑',
  ...plan.reasons.map((r) => `- ${r}`),
  `biome：${plan.biome}（tsc：${outputs.tsc || '不跑'}）`,
  plan.tests.length === 0
    ? 'test：不跑'
    : `test：${plan.tests.length} 台，${plan.tests.reduce((s, b) => s + b.files.length, 0)} 个测试文件，估计耗时合计 ${Math.round(plan.tests.reduce((s, b) => s + b.estMs, 0) / 1000)} 秒`,
  ...plan.tests.map(
    (b) =>
      `- test (${b.label})：${b.files.length} 个文件，估 ${Math.round(b.estMs / 1000)} 秒（${unitsOf(b.files)}）`,
  ),
  `web：${plan.web}  deploy：${plan.deploy}`,
];
console.log(`改了 ${changed.length} 个文件（${event}${event === 'pull_request' ? `，比 ${base}` : ''}）`);
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
