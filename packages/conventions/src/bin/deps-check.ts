// 未声明依赖检查（判法见 ../declared-deps.ts）：node packages/conventions/src/bin/deps-check.ts
// 扫 git 跟踪的全部源码（.ts/.tsx/.js/.mjs/.cjs，加 bin/ 下带 node 抬头的无扩展名脚本），文件归离它最近的工作区包。
// 退出码：0 都声明了；1 有没声明的（逐条列出该写进哪份 package.json）；2 没查成（git 列不出、package.json 读不出、文件解析不了）。
// 只读检出来的文件，不碰网络、不看 node_modules：CI 里和本机结果一样。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractImports,
  findUndeclared,
  loaderOf,
  type Manifest,
  parseManifest,
  type SourceFile,
} from '../declared-deps.ts';
import { exitWith, runMain } from '../exit.ts';

/** 工作区包：仓根和 packages/<名>/package.json（pnpm-workspace.yaml 的 packages/*）。更深的 package.json 是夹具，不算包。 */
const WORKSPACE_MANIFEST = /^(?:package\.json|packages\/[^/]+\/package\.json)$/;
/** 更深的 package.json 所在目录：那下面是夹具（评测题的工作目录等），不归任何工作区包，不查。 */
const NESTED_MANIFEST = /^(.+)\/package\.json$/;

runMain(async () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  let tracked: string[];
  try {
    tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 })
      .split('\0')
      .filter(Boolean);
  } catch (e) {
    console.error(`没查成：git ls-files 失败（${e instanceof Error ? e.message : String(e)}）`);
    exitWith(2);
  }
  const manifests: Manifest[] = [];
  const nested: string[] = [];
  for (const f of tracked) {
    if (WORKSPACE_MANIFEST.test(f)) {
      const dir = f === 'package.json' ? '' : f.slice(0, -'/package.json'.length);
      let m: Manifest | string;
      try {
        m = parseManifest(dir, readFileSync(join(root, f), 'utf8'));
      } catch (e) {
        m = `读不出 ${f}（${e instanceof Error ? e.message : String(e)}）`;
      }
      if (typeof m === 'string') {
        console.error(`没查成：${m}`);
        exitWith(2);
      }
      manifests.push(m);
    } else {
      const d = NESTED_MANIFEST.exec(f)?.[1];
      if (d !== undefined) nested.push(d);
    }
  }
  if (!manifests.some((m) => m.dir === '')) {
    console.error('没查成：git 里没有仓根 package.json');
    exitWith(2);
  }
  const files: SourceFile[] = [];
  for (const f of tracked) {
    if (nested.some((d) => f.startsWith(`${d}/`))) continue;
    const base = f.slice(f.lastIndexOf('/') + 1);
    const noExt = !base.includes('.') || base.startsWith('.');
    if (noExt && !/(^|\/)bin\/[^/]+$/.test(f)) continue;
    if (!noExt && (loaderOf(f) === null || /\.d\.[cm]?ts$/.test(f))) continue;
    let contents: string;
    try {
      contents = readFileSync(join(root, f), 'utf8');
    } catch (e) {
      // git 跟踪着、工作区里删了（未提交的删除）：不算要查的
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      console.error(`没查成：读不出 ${f}（${e instanceof Error ? e.message : String(e)}）`);
      exitWith(2);
    }
    if (noExt && !/^#!.*\bnode\b/.test(contents)) continue;
    // 无扩展名的 node 脚本带 #! 抬头，esbuild 认得
    files.push({ path: f, contents });
  }
  const { imports, errors } = await extractImports(files);
  if (errors.length > 0) {
    console.error(`没查成：${errors.length} 个文件解析不了`);
    for (const e of errors) console.error(`  ${e}`);
    exitWith(2);
  }
  const bad = findUndeclared(imports, manifests);
  if (bad.length === 0) {
    console.log(`未声明依赖：查了 ${files.length} 个文件、${manifests.length} 份 package.json，都声明了`);
    return 0;
  }
  console.error(
    `未声明依赖 ${bad.length} 处（pnpm 下没声明的包能不能找到看安装布局，法国起服务会 ERR_MODULE_NOT_FOUND）：`,
  );
  for (const b of bad) console.error(`  ${b.file}：import '${b.spec}'，${b.manifest} 里没有 ${b.pkg}`);
  return 1;
});
