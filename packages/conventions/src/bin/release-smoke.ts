// 发版目录冒烟（判法见 ../release-smoke.ts）：
//   node --experimental-import-meta-resolve packages/conventions/src/bin/release-smoke.ts <这一版目录> [入口…]
// 不给入口就查法国服务真起的那几个：fleet-api、fleet-engine 的 main.ts，加引擎起来时打包的工作流入口。
// 退出码：0 都找得到、都在目录里；1 有找不到或指到目录外的；2 没查成（参数不对、没带解析开关、目录不在）。
import { realpathSync } from 'node:fs';
import { exitWith, runMain } from '../exit.ts';
import { walkRelease } from '../release-smoke.ts';

/** 法国服务单元的 ExecStart（deploy/france/fleet-api.service、fleet-engine.service）和引擎打包的工作流入口（engine/src/worker.ts 的 WORKFLOWS_PATH）。 */
const DEFAULT_ENTRIES = [
  'packages/api/src/main.ts',
  'packages/engine/src/main.ts',
  'packages/engine/src/workflows/index.ts',
];

runMain(async () => {
  const [dir, ...rest] = process.argv.slice(2).filter((a) => a !== '--');
  if (!dir) {
    console.error('用法：node --experimental-import-meta-resolve release-smoke.ts <这一版目录> [入口…]');
    exitWith(2);
  }
  // 不带这个开关时 import.meta.resolve 不认第二个参数（父模块），会按本文件的位置解析，查的就不是那一版目录：直接算没查成
  if (!process.execArgv.includes('--experimental-import-meta-resolve')) {
    console.error('没查成：要用 node --experimental-import-meta-resolve 跑（按父模块解析要这个开关）');
    exitWith(2);
  }
  let base: string;
  try {
    base = realpathSync(dir);
  } catch (e) {
    console.error(`没查成：目录 ${dir} 不在（${e instanceof Error ? e.message : String(e)}）`);
    exitWith(2);
  }
  const entries = rest.length > 0 ? rest : DEFAULT_ENTRIES;
  const resolve = (spec: string, parent: string) =>
    (import.meta.resolve as (s: string, p: string) => string)(spec, parent);
  const r = await walkRelease(base, entries, resolve);
  if (r.problems.length > 0) {
    console.error(`发版目录冒烟没过（走了 ${r.files} 个文件、解析 ${r.resolved} 条 import）：`);
    for (const p of r.problems) console.error(`  ${p}`);
    return 1;
  }
  console.log(
    `发版目录冒烟：${entries.join('、')} 走了 ${r.files} 个文件、解析 ${r.resolved} 条 import，都找得到、都在目录里`,
  );
  return 0;
});
