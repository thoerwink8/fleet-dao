// 刷新 CI 测试装箱用的耗时表（packages/conventions/test-timings.json，判法在 ../test-timings.ts）：
//   pnpm ci:timings [--run <ci.yml 的 run 编号>]… [--log-file <存下来的 gh run view --log 输出>]… [--out <写到哪，默认仓里那份>]
// --run、--log-file 可以重复给：每个文件取各轮的中位数（单轮里一个文件会因机器抖动慢一倍）。
// 一个都不给：从最近的绿的 ci.yml 运行（PR、主线都算）里取头 5 次真跑了测试台的——主线 88% 的轮次复用同树的 PR 检查、
// 根本不跑测试，只看主线最近一次会常常取到一轮没有测试日志的。要 gh 登录（连不上 GitHub 先设代理）。写完自己看 git diff 再提交。
// 退出码 0 = 写好了；2 = 没做成（gh 跑不成、某一轮日志里认不出一个文件、找不到跑过测试的运行、列不出仓里的测试文件）——不写半张表。
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { fsRepo } from '../repo.ts';
import { listTestFiles, parseTimings, TIMINGS_FILE } from '../test-split.ts';
import { medianOfRuns, mergeTimings, parseRunLog, renderTimings } from '../test-timings.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
/** 不给 --run 时取几轮、最多往回翻几次运行找。 */
const AUTO_RUNS = 5;
const AUTO_SCAN = 40;
/** 一轮至少有几台测试台才算「真跑了测试」（按改动跑的小 PR 只有一两台，量到的文件太少、不值得混进来）。 */
const AUTO_MIN_BOXES = 4;

function fail(why: string): never {
  console.error(`耗时表没刷新：${why}`);
  process.exit(2);
}

function gh(args: string[]): string {
  const r = spawnSync('gh', args, { cwd: root, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  if (r.error) fail(`gh ${args.join(' ')} 跑不起来（${r.error.message}）`);
  if (r.status !== 0) fail(`gh ${args.join(' ')} 退出 ${r.status}：${r.stderr.trim().slice(0, 300)}`);
  return r.stdout;
}

let values: { run?: string[]; 'log-file'?: string[]; out?: string };
try {
  values = parseArgs({
    options: {
      run: { type: 'string', multiple: true },
      'log-file': { type: 'string', multiple: true },
      out: { type: 'string' },
    },
    strict: true,
  }).values;
} catch (e) {
  fail(`参数不对（${e instanceof Error ? e.message : String(e)}）`);
}

/** 不给 --run 时：最近的绿的 ci.yml 运行里，头 AUTO_RUNS 次有至少 AUTO_MIN_BOXES 台测试台跑成功的。 */
function pickAutoRuns(): string[] {
  const text = gh([
    'run',
    'list',
    '--workflow',
    'ci.yml',
    '--status',
    'success',
    '--limit',
    String(AUTO_SCAN),
    '--json',
    'databaseId',
  ]);
  let list: { databaseId?: unknown }[];
  try {
    list = JSON.parse(text);
  } catch {
    fail('gh run list 的输出不是 JSON');
  }
  const picked: string[] = [];
  for (const item of list) {
    if (typeof item.databaseId !== 'number') fail('gh run list 给的运行编号认不出');
    const id = String(item.databaseId);
    const boxes = gh([
      'run',
      'view',
      id,
      '--json',
      'jobs',
      '--jq',
      '[.jobs[] | select((.name | startswith("test (")) and .conclusion == "success")] | length',
    ]);
    if (!/^\d+\s*$/.test(boxes)) fail(`运行 ${id} 的测试台数认不出：${boxes.trim().slice(0, 80)}`);
    if (Number(boxes) >= AUTO_MIN_BOXES) picked.push(id);
    if (picked.length === AUTO_RUNS) break;
  }
  if (picked.length === 0)
    fail(
      `最近 ${list.length} 次绿的 ci.yml 运行里没有一次真跑了 ${AUTO_MIN_BOXES} 台以上的测试台（自己用 --run 指几轮）`,
    );
  return picked;
}

const logs: { name: string; text: string }[] = [];
for (const file of values['log-file'] ?? []) {
  try {
    logs.push({ name: `日志文件 ${file.split(/[\\/]/).pop()}`, text: readFileSync(file, 'utf8') });
  } catch (e) {
    fail(`读不到 ${file}（${e instanceof Error ? e.message : String(e)}）`);
  }
}
let runIds = values.run ?? [];
if (runIds.length === 0 && logs.length === 0) runIds = pickAutoRuns();
for (const run of runIds) {
  if (!/^\d+$/.test(run)) fail(`run 编号认不出：${run}`);
  logs.push({ name: `ci.yml run ${run}`, text: gh(['run', 'view', run, '--log']) });
}

const perRun: Map<string, number>[] = [];
for (const l of logs) {
  const m = parseRunLog(l.text);
  if (m.size === 0)
    fail(
      `${l.name} 的日志里一个测试文件的耗时都没认出来（job 名不是 test (…)？报告器的格式变了？那一轮根本没跑测试？）`,
    );
  perRun.push(m);
}
const measured = medianOfRuns(perRun);
if (measured === undefined) fail('一轮日志都没有');
const source = `${logs.map((l) => l.name).join('、')}，共 ${logs.length} 轮取中位数（${new Date().toISOString().slice(0, 10)}）`;

const existing = listTestFiles(fsRepo(root));
if (typeof existing === 'string') fail(existing);
const path = values.out ?? join(root, TIMINGS_FILE);
let oldText: string | undefined;
try {
  oldText = readFileSync(path, 'utf8');
} catch {
  oldText = undefined;
}
const old = parseTimings(oldText);
if (typeof old === 'string') console.warn(`旧表认不出（${old}），这次只用新量的`);
const r = mergeTimings(typeof old === 'string' ? undefined : old, measured, existing, source);
writeFileSync(path, renderTimings(r.timings));
const missing = existing.filter((f) => r.timings.files[f] === undefined);
console.log(
  `${values.out ?? TIMINGS_FILE}：${logs.length} 轮取中位数，量到 ${measured.size} 个文件（更新 ${r.updated}、新增 ${r.added}），沿用旧值 ${r.kept} 个，删掉仓里已没有的 ${r.dropped.length} 个`,
);
if (missing.length > 0)
  console.log(`表里还缺 ${missing.length} 个（装箱时按中位数估）：${missing.slice(0, 5).join('、')}`);
