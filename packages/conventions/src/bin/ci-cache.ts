// CI test job 的结果缓存入口（.github/workflows/ci.yml，判法在 ../ci-cache.ts）。三步，每步都要 --event：
//   key    算这一组测试的键，记下 vitest 实际会收哪些文件。输出 enabled、cache_key、dir、state。
//   plan   restore 之后：读清单、核对、算这次跑哪些。输出 mode=all|files|none；files 的文件名写进 <tmp>/fleet-test-run-files.txt。
//   record vitest 全绿之后：写清单到 <tmp>/fleet-test-cache/manifest.json（之后 ci.yml 才 save 缓存）。输出 written。
// 参数：--event <GitHub 事件名> --tmp <临时目录，CI 里是 $RUNNER_TEMP>；key 还要 --args "<交给 vitest 的参数>" --label <组名>
//   [--temporal "<版本> <校验和>"]（引擎那几台，和 ci.yml 里 Temporal 命令行那一步同一份）；record 用 --report 指向 vitest 的 JSON 报告。
// 非 pull_request 事件（主线推送）：每步都只打一行说明、不碰缓存，退出码 0、mode=all。
// 算不出、读不出一律 enabled=false / mode=all（回来真跑），不是静默当成「跑过了」；退出码 2 只给参数不对（工作流写错了）。
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  buildEnvIdentity,
  CACHE_SUBDIR,
  CacheError,
  fsHashFs,
  MANIFEST_FILE,
  relativeToRoot,
  stepKey,
  stepPlan,
  stepRecord,
  vitestVersion,
} from '../ci-cache.ts';
import { readGraph } from '../ci-plan.ts';
import { fsRepo } from '../repo.ts';

const USAGE =
  '用法：ci-cache.ts <key|plan|record> --event <事件名> --tmp <临时目录> [--args "<vitest 参数>" --label <组名> --temporal "<版本> <校验和>"] [--report <vitest JSON 报告>]';
const root = fileURLToPath(new URL('../../../../', import.meta.url));

const [command, ...rest] = process.argv.slice(2);
let values: {
  event?: string;
  tmp?: string;
  args?: string;
  label?: string;
  temporal?: string;
  report?: string;
};
try {
  values = parseArgs({
    args: rest,
    options: {
      event: { type: 'string' },
      tmp: { type: 'string' },
      args: { type: 'string' },
      label: { type: 'string' },
      temporal: { type: 'string' },
      report: { type: 'string' },
    },
    strict: true,
  }).values;
} catch (e) {
  console.error(`参数不对（${e instanceof Error ? e.message : String(e)}）。${USAGE}`);
  process.exit(2);
}
if (!(command === 'key' || command === 'plan' || command === 'record') || !values.event || !values.tmp) {
  console.error(USAGE);
  process.exit(2);
}
const event = values.event;
const tmp = values.tmp;
const cacheDir = join(tmp, CACHE_SUBDIR);
const statePath = join(tmp, 'fleet-test-cache-state.json');
const runFilesPath = join(tmp, 'fleet-test-run-files.txt');

function output(pairs: Record<string, string>) {
  for (const [k, v] of Object.entries(pairs)) console.log(`  ${k}=${v}`);
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;
  try {
    appendFileSync(
      out,
      `${Object.entries(pairs)
        .map(([k, v]) => `${k}=${v}\n`)
        .join('')}`,
    );
  } catch (e) {
    // 写不进输出：下游拿不到 mode 就按「没开缓存」处理（ci.yml 里 mode 空 = 全跑），这里直接红，免得悄悄少记
    console.error(`::error::写不进 GITHUB_OUTPUT（${e instanceof Error ? e.message : String(e)}）`);
    process.exit(2);
  }
}

function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

/** vitest list：这组参数实际会收哪些测试文件（仓内相对路径、排好序）。跑不成、认不出抛 CacheError。 */
function listTests(args: string[]): string[] {
  mkdirSync(tmp, { recursive: true });
  const out = join(tmp, 'fleet-test-list.json');
  try {
    writeFileSync(out, '');
  } catch (e) {
    throw new CacheError(`临时目录写不了（${e instanceof Error ? e.message : String(e)}）`);
  }
  const r = spawnSync(
    process.execPath,
    [join(root, 'node_modules/vitest/vitest.mjs'), 'list', '--filesOnly', `--json=${out}`, ...args],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.error) throw new CacheError(`vitest list 跑不起来（${r.error.message}）`);
  if (r.status !== 0)
    throw new CacheError(`vitest list 退出 ${r.status}：${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(out, 'utf8'));
  } catch {
    throw new CacheError('vitest list 的输出不是 JSON');
  }
  if (!Array.isArray(parsed)) throw new CacheError('vitest list 的输出不是数组');
  const files = new Set<string>();
  for (const item of parsed as { file?: unknown }[]) {
    const rel = typeof item?.file === 'string' ? relativeToRoot(root, item.file) : undefined;
    if (rel === undefined)
      throw new CacheError(`vitest list 给了个认不出、不在仓里的文件：${JSON.stringify(item)}`);
    files.add(rel);
  }
  return [...files].sort();
}

function main() {
  if (command === 'key') {
    const args = (values.args ?? '').split(/\s+/).filter(Boolean);
    const fs = fsHashFs(root);
    const step = stepKey({
      event,
      args,
      label: values.label ?? '',
      fs,
      graph: readGraph(fsRepo(root)),
      env: () =>
        buildEnvIdentity({
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch,
          env: process.env,
          vitestVersion: vitestVersion(fs),
          temporalLabel: values.temporal ?? '',
          now: new Date(),
        }),
      listTests,
    });
    if (!step.enabled) {
      console.log(`测试缓存：不开（${step.why}）`);
      output({ enabled: 'false' });
      return;
    }
    mkdirSync(tmp, { recursive: true });
    writeFileSync(statePath, JSON.stringify(step.state));
    console.log(`测试缓存：键 ${step.key}（${Object.keys(step.state.collected).length} 个测试文件）`);
    for (const [k, v] of Object.entries(step.parts)) console.log(`  ${k} ${v.slice(0, 12)}`);
    output({ enabled: 'true', cache_key: step.cacheKey, dir: cacheDir });
    return;
  }

  if (command === 'plan') {
    const step = stepPlan({
      event,
      stateText: readIfExists(statePath),
      manifestText: readIfExists(join(cacheDir, MANIFEST_FILE)),
      listTests,
    });
    console.log(`测试缓存：${step.why}`);
    if (step.state) writeFileSync(statePath, JSON.stringify(step.state));
    writeFileSync(runFilesPath, step.mode === 'files' ? `${step.run.join('\n')}\n` : '');
    if (step.mode === 'files') for (const f of step.run) console.log(`  跑 ${f}`);
    output({ mode: step.mode, run_files: runFilesPath });
    return;
  }

  // record
  const reportPath = values.report;
  const step = stepRecord({
    event,
    stateText: readIfExists(statePath),
    reportText: reportPath ? readIfExists(reportPath) : undefined,
    root,
  });
  if (!('manifest' in step)) {
    console.log(`测试缓存：没写清单（${step.why}）`);
    output({ written: 'false' });
    return;
  }
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, MANIFEST_FILE), JSON.stringify(step.manifest, null, 1));
  console.log(`测试缓存：写了清单（${Object.keys(step.manifest.files).length} 个文件，全绿）`);
  output({ written: 'true' });
}

try {
  main();
} catch (e) {
  // 缓存这一层出了什么岔子都回来真跑：key 不开、plan 全跑、record 不写；不让它把一个本来能过的测试 job 弄红，也不让它冒充「跑过了」
  console.error(`::warning::测试缓存没做成（${e instanceof Error ? e.message : String(e)}）：测试照常全跑`);
  if (command === 'key') output({ enabled: 'false' });
  else if (command === 'plan') output({ mode: 'all', run_files: runFilesPath });
  else output({ written: 'false' });
}
