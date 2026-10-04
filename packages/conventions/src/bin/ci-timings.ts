// 刷新 CI 测试装箱用的耗时表（packages/conventions/test-timings.json，判法在 ../test-timings.ts）：
//   pnpm ci:timings [--run <主线 ci.yml 的 run 编号>] [--log-file <存下来的 gh run view --log 输出>] [--out <写到哪，默认仓里那份>]
// 不给 --run 就取主线最近一次绿的 ci.yml 推送运行。要 gh 登录（连不上 GitHub 先设代理）。写完自己看 git diff 再提交。
// 退出码 0 = 写好了；2 = 没做成（gh 跑不成、日志里认不出一个文件、列不出仓里的测试文件）——不写半张表。
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { fsRepo } from '../repo.ts';
import { listTestFiles, parseTimings, TIMINGS_FILE } from '../test-split.ts';
import { mergeTimings, parseRunLog, renderTimings } from '../test-timings.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

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

let values: { run?: string; 'log-file'?: string; out?: string };
try {
  values = parseArgs({
    options: { run: { type: 'string' }, 'log-file': { type: 'string' }, out: { type: 'string' } },
    strict: true,
  }).values;
} catch (e) {
  fail(`参数不对（${e instanceof Error ? e.message : String(e)}）`);
}

let log: string;
let source: string;
if (values['log-file']) {
  try {
    log = readFileSync(values['log-file'], 'utf8');
  } catch (e) {
    fail(`读不到 ${values['log-file']}（${e instanceof Error ? e.message : String(e)}）`);
  }
  source = `日志文件 ${values['log-file'].split(/[\\/]/).pop()}`;
} else {
  let run = values.run;
  let meta = '';
  if (run === undefined) {
    const text = gh([
      'run',
      'list',
      '--workflow',
      'ci.yml',
      '--branch',
      'main',
      '--event',
      'push',
      '--status',
      'success',
      '--limit',
      '1',
      '--json',
      'databaseId,headSha,createdAt',
    ]);
    let list: { databaseId?: unknown; headSha?: unknown; createdAt?: unknown }[];
    try {
      list = JSON.parse(text);
    } catch {
      fail('gh run list 的输出不是 JSON');
    }
    const top = list[0];
    if (!top || typeof top.databaseId !== 'number') fail('主线上没找到绿的 ci.yml 推送运行');
    run = String(top.databaseId);
    meta = `（${String(top.createdAt).slice(0, 10)}，${String(top.headSha).slice(0, 8)}）`;
  }
  if (!/^\d+$/.test(run)) fail(`run 编号认不出：${run}`);
  log = gh(['run', 'view', run, '--log']);
  source = `ci.yml 主线 run ${run}${meta}`;
}

const measured = parseRunLog(log);
if (measured.size === 0)
  fail('日志里一个测试文件的耗时都没认出来（job 名不是 test (…)？报告器的格式变了？）');
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
  `${values.out ?? TIMINGS_FILE}：这一轮量到 ${measured.size} 个文件（更新 ${r.updated}、新增 ${r.added}），沿用旧值 ${r.kept} 个，删掉仓里已没有的 ${r.dropped.length} 个`,
);
if (missing.length > 0)
  console.log(`表里还缺 ${missing.length} 个（装箱时按中位数估）：${missing.slice(0, 5).join('、')}`);
