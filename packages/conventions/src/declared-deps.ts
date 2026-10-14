// 「代码 import 了、自己 package.json 没声明」的依赖（入口 bin/deps-check.ts，CI 的 lint 里跑）。
// 为什么要有：pnpm 不把依赖提升到别的包看得见的地方，一个包只认得自己 node_modules 和仓根 node_modules 里的东西。
// 没声明的包能不能碰巧解析到，取决于安装布局（隐藏提升、全局虚拟仓、NODE_PATH 钩子）——CI、本机、法国三处各不一样，
// 同一份代码在 CI 绿、在法国起不来（065445a4 那次 fleet-api 报 ERR_MODULE_NOT_FOUND）。所以这里不靠「装完试一下」，
// 直接按声明判：文件归离它最近的那个工作区包（packages/<名>/package.json，其余归仓根），它在运行时会 import 的每个包名
// 必须写在自己包或仓根 package.json 的依赖（任何一栏）里——这正是 pnpm 布局下 node 顺着目录往上能找到的范围。
// 判「运行时会 import」交给 esbuild 解析：import type、export type 被擦掉不算；字面量的 import()、require()、require.resolve() 算。
// 三态纪律：esbuild 解析不了的文件、读不出的 package.json 都报成「没查成」，不当成没问题。
import { builtinModules } from 'node:module';
import { build, type Plugin } from 'esbuild';

export interface SourceFile {
  /** 仓内相对路径（/ 分隔）。 */
  path: string;
  contents: string;
}

export interface FoundImport {
  /** 仓内相对路径。 */
  file: string;
  /** 原样的模块名（import 'x/y' 的 x/y）。 */
  spec: string;
}

export interface Manifest {
  /** 包目录（仓内相对，/ 分隔；仓根是空串）。 */
  dir: string;
  name: string;
  /** dependencies、devDependencies、peerDependencies、optionalDependencies 里的全部包名。 */
  deps: ReadonlySet<string>;
}

export interface Undeclared {
  file: string;
  spec: string;
  /** 缺的包名。 */
  pkg: string;
  /** 该写进哪份 package.json（仓内相对路径）。 */
  manifest: string;
}

const BUILTINS = new Set(builtinModules);

/** 模块名里的包名：@scope/name/sub → @scope/name，name/sub → name。相对路径、绝对路径、node 内置、#子路径返回 null。 */
export function packageOf(spec: string): string | null {
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('#')) return null;
  if (spec.startsWith('node:')) return null;
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? spec);
  if (BUILTINS.has(name)) return null;
  return name;
}

/** 一份 package.json 的内容 → 包名和全部依赖名。认不出返回一句为什么。 */
export function parseManifest(dir: string, text: string): Manifest | string {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return `${dir || '仓根'}/package.json 不是 JSON（${e instanceof Error ? e.message : String(e)}）`;
  }
  if (typeof data !== 'object' || data === null) return `${dir || '仓根'}/package.json 不是对象`;
  const d = data as Record<string, unknown>;
  const deps = new Set<string>();
  for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const v = d[k];
    if (v === undefined) continue;
    if (typeof v !== 'object' || v === null) return `${dir || '仓根'}/package.json 的 ${k} 不是对象`;
    for (const n of Object.keys(v)) deps.add(n);
  }
  return { dir, name: typeof d.name === 'string' ? d.name : '', deps };
}

/** 文件归哪个包：离它最近、目录是它前缀的那份清单（仓根清单的 dir 是空串，兜底）。 */
export function ownerOf(file: string, manifests: readonly Manifest[]): Manifest | undefined {
  let best: Manifest | undefined;
  for (const m of manifests) {
    if (m.dir !== '' && !file.startsWith(`${m.dir}/`)) continue;
    if (best === undefined || m.dir.length > best.dir.length) best = m;
  }
  return best;
}

/** 判：每条 import 的包名要在自己包或仓根的依赖里（或就是自己包）。按文件、包名排好序。 */
export function findUndeclared(
  imports: readonly FoundImport[],
  manifests: readonly Manifest[],
): Undeclared[] {
  const root = manifests.find((m) => m.dir === '');
  const out: Undeclared[] = [];
  const seen = new Set<string>();
  for (const imp of imports) {
    const pkg = packageOf(imp.spec);
    if (pkg === null) continue;
    const own = ownerOf(imp.file, manifests);
    if (own === undefined) continue;
    if (pkg === own.name || own.deps.has(pkg) || root?.deps.has(pkg)) continue;
    const key = `${imp.file}\0${pkg}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      file: imp.file,
      spec: imp.spec,
      pkg,
      manifest: own.dir === '' ? 'package.json' : `${own.dir}/package.json`,
    });
  }
  return out.sort((a, b) => (a.file === b.file ? a.pkg.localeCompare(b.pkg) : a.file < b.file ? -1 : 1));
}

const LOADERS: Record<string, 'ts' | 'tsx' | 'js' | 'jsx'> = {
  ts: 'ts',
  mts: 'ts',
  cts: 'ts',
  tsx: 'tsx',
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  jsx: 'jsx',
};

/** 认得的源码扩展名；没扩展名的（bin 脚本）当 js。 */
export function loaderOf(path: string): 'ts' | 'tsx' | 'js' | 'jsx' | null {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return 'js';
  return LOADERS[base.slice(dot + 1)] ?? null;
}

/**
 * 每个文件运行时会 import 的模块名（esbuild 解析，内容从参数里取、不读盘）。解析不了的文件进 errors，不当成没有 import。
 * 和 node 的类型剥离同一口径：verbatimModuleSyntax 开着，只有 import type / { type X } 被擦掉，没用到的值导入照样算。
 */
export async function extractImports(
  files: readonly SourceFile[],
): Promise<{ imports: FoundImport[]; errors: string[] }> {
  const byPath = new Map(files.map((f) => [f.path, f.contents]));
  const imports: FoundImport[] = [];
  const errors: string[] = [];
  const plugin: Plugin = {
    name: 'record-imports',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (a) => {
        // 入口路径 esbuild 会补成 ./x：去掉，和 files 里的键对上
        if (a.kind === 'entry-point') return { path: a.path.replace(/^\.\//, ''), namespace: 'src' };
        imports.push({ file: a.importer, spec: a.path });
        return { path: a.path, external: true };
      });
      b.onLoad({ filter: /.*/, namespace: 'src' }, (a) => {
        const contents = byPath.get(a.path);
        const loader = loaderOf(a.path);
        if (contents === undefined || loader === null) return { errors: [{ text: '读不到或认不出扩展名' }] };
        return { contents, loader };
      });
    },
  };
  // 一个文件一次 build：一个文件解析不了只记它自己，不连累别的文件没人查
  for (const f of files) {
    try {
      const r = await build({
        entryPoints: [f.path],
        bundle: true,
        write: false,
        outdir: 'out',
        platform: 'node',
        format: 'esm',
        logLevel: 'silent',
        jsx: 'automatic',
        tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
        plugins: [plugin],
      });
      for (const e of r.errors) errors.push(`${f.path}：${e.text}`);
    } catch (e) {
      const errs = (e as { errors?: { text: string }[] }).errors;
      if (errs && errs.length > 0) for (const x of errs) errors.push(`${f.path}：${x.text}`);
      else errors.push(`${f.path}：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { imports, errors };
}
