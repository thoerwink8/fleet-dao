// CI 的 changes job 入口（.github/workflows/ci.yml，判法在 ../ci-plan.ts）：
//   node packages/conventions/src/bin/ci-plan.ts [--event pull_request|push|…] [--base origin/main]
// PR：用 git diff --name-only --no-renames <base>...HEAD 算改了什么（改名拆成删旧 + 加新，两头都算）；别的事件全跑。
// 结果写进 $GITHUB_OUTPUT（下游 job 的开关）和 $GITHUB_STEP_SUMMARY；本机不设这两个变量时只打出来。
// 退出码 0 = 算出来了；2 = 没算成（base 拿不到、git diff 失败、写不进 $GITHUB_OUTPUT）——判红，不许静默少跑。
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { planCi, planOutputs, readGraph } from '../ci-plan.ts';
import { fsRepo } from '../repo.ts';

const USAGE = '用法：ci-plan.ts [--event pull_request|push] [--base origin/main]';
const root = fileURLToPath(new URL('../../../../', import.meta.url));

function fail(why: string): never {
  console.error(`::error::没算成要跑什么：${why}`);
  process.exit(2);
}

let event = 'pull_request';
let base = 'origin/main';
try {
  const { values } = parseArgs({
    options: { event: { type: 'string' }, base: { type: 'string' } },
    strict: true,
  });
  event = values.event ?? event;
  base = values.base ?? base;
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
if (event === 'pull_request') {
  if (base.startsWith('-')) fail(`base 不像分支名：${base}`);
  git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  changed = git(['diff', '--name-only', '-z', '--no-renames', `${base}...HEAD`])
    .split('\0')
    .filter((f) => f !== '');
}

const plan = planCi({ event, changed, graph: readGraph(fsRepo(root)) });
const outputs = planOutputs(plan);

const human = [
  plan.full ? '全跑' : '按改动跑',
  ...plan.reasons.map((r) => `- ${r}`),
  `lint：${plan.lint}（tsc：${outputs.tsc || '不跑'}）`,
  `test：${plan.tests.map((s) => `${s.name}（${s.args.join(' ')}）`).join('；') || '不跑'}`,
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
