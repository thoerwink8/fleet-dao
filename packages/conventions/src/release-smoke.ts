// 发版装好的一版目录里，服务入口用到的模块是不是都找得到（入口 bin/release-smoke.ts，CI 的 lint 里跑）。
// 从入口文件出发，用 esbuild 认出每个文件运行时会 import 什么（declared-deps.ts 的 extractImports），再用 node 自己的解析
// （import.meta.resolve，带父模块）逐个解析：仓里的文件顺着往下走，第三方包只解析到它的入口为止。只解析、不执行，
// 所以不用配库、不起服务，也不会被入口里的副作用卡住。
// 判红：解析不了（ERR_MODULE_NOT_FOUND 一类，065445a4 那次就是这个）；解析到这一版目录外面（家目录里的 pnpm 仓库等，
// 服务单元 ProtectHome、只读挂载下看不到）。读不出、解析器起不来是「没查成」，同样不当成过。
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractImports, loaderOf, packageOf } from './declared-deps.ts';

/** 解析一个模块名（父模块的 file: URL）→ 解析结果的 URL；解析不了抛错。 */
export type Resolver = (spec: string, parentUrl: string) => string;

export interface SmokeResult {
  /** 走过的仓内文件个数。 */
  files: number;
  /** 解析过的 import 条数。 */
  resolved: number;
  problems: string[];
}

const inside = (base: string, p: string) => {
  const r = relative(base, p);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};

/** 从入口（相对 releaseDir）出发走一遍。releaseDir 要是真实路径（realpath 过的）。 */
export async function walkRelease(
  releaseDir: string,
  entries: readonly string[],
  resolve: Resolver,
): Promise<SmokeResult> {
  const problems: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [];
  let resolved = 0;
  const show = (p: string) => relative(releaseDir, p).split(sep).join('/');
  for (const e of entries) {
    let p: string;
    try {
      p = realpathSync(`${releaseDir}${sep}${e}`);
    } catch (err) {
      problems.push(`入口 ${e} 不在：${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (!seen.has(p)) {
      seen.add(p);
      queue.push(p);
    }
  }
  while (queue.length > 0) {
    const file = queue.shift() as string;
    let contents: string;
    try {
      contents = readFileSync(file, 'utf8');
    } catch (err) {
      problems.push(`读不出 ${show(file)}：${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const { imports, errors } = await extractImports([{ path: file, contents }]);
    for (const e of errors) problems.push(`解析不了 ${show(file)}：${e}`);
    const parentUrl = pathToFileURL(file).href;
    for (const imp of imports) {
      if (!imp.spec.startsWith('.') && !imp.spec.startsWith('#') && packageOf(imp.spec) === null) continue; // node 内置
      let url: string;
      try {
        url = resolve(imp.spec, parentUrl);
      } catch (err) {
        const code = (err as { code?: string }).code;
        problems.push(
          `${show(file)}：import '${imp.spec}' 找不到（${code ?? (err instanceof Error ? err.message : String(err))}）`,
        );
        continue;
      }
      resolved++;
      if (!url.startsWith('file:')) continue;
      let target: string;
      try {
        target = realpathSync(fileURLToPath(url));
      } catch (err) {
        problems.push(
          `${show(file)}：import '${imp.spec}' 解析到的文件不在（${err instanceof Error ? err.message : String(err)}）`,
        );
        continue;
      }
      if (!inside(releaseDir, target)) {
        problems.push(`${show(file)}：import '${imp.spec}' 解析到这一版目录外面（${target}），服务看不到`);
        continue;
      }
      const rel = show(target);
      // 第三方包只查到入口；仓里的源码（含经 workspace 链接到的别的包）顺着往下走
      if (rel.split('/').includes('node_modules')) continue;
      if (loaderOf(target) === null || /\.json$/.test(target)) continue;
      if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return { files: seen.size, resolved, problems };
}
