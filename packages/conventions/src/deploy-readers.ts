// 只改了 deploy/ 时 CI 该跑哪些测试文件：读 deploy/ 的那些（决定 0093，B8）。
// 不手写清单，从代码里算：
// - 一个文件「读 deploy/」= 去掉注释后的代码里有指向 deploy 的路径字面量（deploy/…、'deploy'、`deploy`），并且这个文件会碰文件系统或子进程
//   （只在注释、规则表、文档指针里提到 deploy/ 的不算：ci-plan.ts 的 PATH_RULES 写着 'deploy/'，但它不读）；
// - 测试文件读 deploy/ = 它自己读，或它顺着 import 能走到的文件读（相对路径、@fleet-dao/<包> 经 package.json 的 exports 进到包内）。
// 宁多勿少：认不出的 import、读不到的文件返回一句为什么，调用方退回全跑，不拿「没找到」冒充「没人读」。
// 主线推送照旧全跑（发版只认主线全绿，决定 0093 第 6 条），所以这里即使漏了，合并后主线那一轮也会兜住。
import { posix } from 'node:path';
import type { RepoView } from './repo.ts';

/** 去掉块注释和行注释（行注释要求 // 前面是行首或空白，免得把 'https://…' 当注释）。 */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

/** 指向 deploy 的路径字面量：deploy/…、'deploy'、"deploy"、`deploy`、…/deploy 结尾的路径拼接。 */
const DEPLOY_PATH = /(?<![\w.-])deploy(?:\/|(?=['"`]))/;
/** 会碰文件系统或子进程的写法；import.meta.url / dirname 是「按自己位置找文件」的标志。 */
const TOUCHES_FS =
  /\b(?:readFileSync|readFile|readdirSync|readdir|existsSync|statSync|stat|spawnSync|spawn|execFileSync|execFile|execSync|exec|createReadStream|opendir|cp|copyFile|access|readTextFile)\b|import\.meta\.(?:url|dirname)|\brepo(?:File)?\s*\(|\.read\(/;

/** 去掉注释后的代码是不是读 deploy/。 */
export function readsDeploy(text: string): boolean {
  const code = stripComments(text);
  return DEPLOY_PATH.test(code) && TOUCHES_FS.test(code);
}

const IMPORT_SPEC =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bexport\s+\*\s+from\s*)(['"])([^'"\n]+)\1/g;

/** 一个文件 import 的东西（原样的说明符）。 */
export function importSpecs(text: string): string[] {
  return [...stripComments(text).matchAll(IMPORT_SPEC)]
    .map((m) => m[2] as string)
    .filter((s) => s.startsWith('.') || s.startsWith('@fleet-dao/'));
}

const EXTS = ['', '.ts', '.tsx', '.mts', '.mjs', '.js', '/index.ts', '/index.tsx'];

/**
 * 把 from 文件里的 import 说明符落到仓内文件。相对路径按目录算；@fleet-dao/<包>[/子路径] 按 packages/<包>/package.json 的 exports；
 * 别的（node:、第三方包）返回 null（不在仓里，不读 deploy/）。相对路径落不到文件当没有（见下）；@fleet-dao 包认不出返回一句为什么。
 */
export function resolveImport(repo: RepoView, from: string, spec: string): string | null | { why: string } {
  if (spec.startsWith('.')) {
    const base = posix.normalize(posix.join(posix.dirname(from), spec));
    for (const ext of EXTS) {
      const c = `${base}${ext}`;
      if (repo.exists(c) && !repo.isDir(c)) return c;
    }
    // 说明符带 .js 而源文件是 .ts 的写法
    const noExt = base.replace(/\.(?:js|mjs)$/, '');
    for (const ext of ['.ts', '.tsx']) if (repo.exists(`${noExt}${ext}`)) return `${noExt}${ext}`;
    // 导进来的是数据文件（.json 等）：不是代码，不会再 import 别的
    if (/\.(?:json|md|sql|txt|css|svg|sh)$/.test(base)) return null;
    // 落不到文件：多半是字符串里、模板里写的 import 样例（web 的 mock 对话稿就有）；真 import 落不到，测试和 tsc 自己先红
    return null;
  }
  const m = /^@fleet-dao\/([a-z0-9-]+)(\/.+)?$/.exec(spec);
  if (!m) return null;
  const pkgJson = repo.read(`packages/${m[1]}/package.json`);
  if (pkgJson === undefined)
    return { why: `${from} 里 import 的 ${spec}：读不到 packages/${m[1]}/package.json` };
  let exportsMap: unknown;
  try {
    exportsMap = (JSON.parse(pkgJson) as { exports?: unknown }).exports;
  } catch {
    return { why: `packages/${m[1]}/package.json 不是 JSON` };
  }
  const key = m[2] === undefined ? '.' : `.${m[2]}`;
  const target =
    typeof exportsMap === 'object' && exportsMap !== null
      ? (exportsMap as Record<string, unknown>)[key]
      : undefined;
  if (typeof target !== 'string')
    return { why: `${from} 里 import 的 ${spec}：packages/${m[1]} 的 exports 里没有 ${key}` };
  const file = posix.normalize(posix.join(`packages/${m[1]}`, target));
  return repo.exists(file) ? file : { why: `${spec} 指向的 ${file} 不存在` };
}

/** 测试夹具、辅助模块：在 test/ 或 e2e/ 目录里、自己不是测试文件。顺着它们往下走不设限；源码只看一跳。 */
const isHelper = (f: string) => /\/(?:test|e2e)\//.test(f) && !/\.test\.tsx?$/.test(f);

/**
 * 全部测试文件里，读 deploy/ 的。排好序。一个测试算「读」，当且仅当下面任一成立：
 * - 它自己读（readsDeploy）；
 * - 它 import 的测试辅助模块（test/、e2e/ 里的非测试文件）读，辅助模块再 import 的辅助模块也算，不限层数；
 * - 它或辅助模块直接 import 的源码文件读。再往下（源码 import 的源码）不跟：走到头会把整个仓拉进来（conventions 的入口一个 export 就连着所有包），
 *   一个测试改成「间接读 deploy/」的漏判由主线推送全跑兜住（决定 0093 第 6 条）。
 * 读不到某个测试文件：返回一句为什么（调用方退回全跑）。读不到的 import 当作不在仓里。
 */
export function deployReaders(repo: RepoView, tests: readonly string[]): string[] | string {
  const info = new Map<string, { reads: boolean; imports: string[] } | undefined>();
  const load = (f: string) => {
    if (!info.has(f)) {
      const text = repo.read(f);
      info.set(
        f,
        text === undefined
          ? undefined
          : {
              reads: readsDeploy(text),
              imports: importSpecs(text).flatMap((spec) => {
                const r = resolveImport(repo, f, spec);
                return typeof r === 'string' ? [r] : [];
              }),
            },
      );
    }
    return info.get(f);
  };
  const out: string[] = [];
  for (const t of tests) {
    const self = load(t);
    if (self === undefined) return `读不到 ${t}（认不出它读不读 deploy/）`;
    const seen = new Set([t]);
    const todo = [t];
    let hit = false;
    while (!hit && todo.length > 0) {
      const f = todo.pop() as string;
      const x = load(f);
      if (x === undefined) continue;
      if (x.reads) hit = true;
      for (const g of x.imports) {
        if (seen.has(g)) continue;
        seen.add(g);
        const y = load(g);
        if (y?.reads) hit = true;
        else if (isHelper(g)) todo.push(g);
      }
    }
    if (hit) out.push(t);
  }
  return out.sort();
}
