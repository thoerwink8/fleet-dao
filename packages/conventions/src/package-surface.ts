// 包的「对外面」：从 package.json 的 exports、bin 出发，顺着包内的相对 import、new URL(..., import.meta.url) 能走到的文件。
// 依赖这个包的包只能经这些入口用到它（跨包相对路径另有 package-boundaries 测试登记，测试读包外文件另有 TEST_READS），
// 所以改到面以外的文件（入口脚本、只在包内用的模块、测试）只测这个包自己，不连带依赖它的包（ci-plan.ts 的 sortChanges）。
// 本机只改 conventions 的 check.ts 时原来连 engine、api、github 一起跑，五分钟上下（#2115 之后实测 4 分 39 秒）。
// 三态纪律：认不出就当整个包都是面（返回 null）——没有 exports、入口文件读不到、相对路径落不到文件、有拿变量拼的
// import(...) / new URL(...)，都不拿「走不到」冒充「不对外」。
import type { RepoView } from './repo.ts';

/** 列包里的文件时不进的目录：装的依赖、打包产物。 */
const SKIP_DIRS = new Set(['node_modules', 'dist']);

/** 读它、找它里面相对引用的文件：源码和没扩展名的 bin 脚本；别的（json、夹具）只算进面，不往下读。 */
const PARSED = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;

/** 字面量写的相对引用：import / export from、import('…')、import '…'、require('…')、new URL('…', import.meta.url)。 */
const LITERAL_REFS = [
  /\bfrom\s*['"](\.{1,2}\/[^'"]*)['"]/g,
  /\bimport\s*\(\s*['"](\.{1,2}\/[^'"]*)['"]\s*[,)]/g,
  /\bimport\s+['"](\.{1,2}\/[^'"]*)['"]/g,
  /\brequire\s*\(\s*['"](\.{1,2}\/[^'"]*)['"]\s*\)/g,
  /\bnew\s+URL\s*\(\s*['"](\.{1,2}\/?[^'"]*)['"]\s*,\s*import\.meta\.url/g,
];

/** 拿变量、模板串拼的 import(…)、new URL(…, import.meta.url)：走到哪认不出。 */
const COMPUTED_REFS = [/\bimport\s*\(\s*[^'"\s)]/, /\bnew\s+URL\s*\(\s*[^'"\s)][^,)]*,\s*import\.meta\.url/];

/**
 * 去掉整行的注释（// 开头、块注释的 /* 和 * 开头的行：注释里常写着 import(...) 这类举例，不算引用）。
 * 不按 /* … *\/ 成对去：字符串里的 'src/**\/*.ts' 会被当成注释开头，吃掉后面真的 import，把在面上的文件判成面以外。
 */
function stripComments(text: string): string {
  return text.replace(/^\s*(?:\/\/|\/\*|\*).*$/gm, '');
}

/** 拼仓内相对路径（/ 分隔）；走出仓根返回 undefined。 */
function resolveRel(fromFile: string, spec: string): string | undefined {
  const parts = fromFile.split('/').slice(0, -1);
  for (const seg of spec.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** 目录下所有文件（递归，仓内相对路径）；列不出返回 undefined。 */
function filesUnder(repo: RepoView, dir: string): string[] | undefined {
  const names = repo.list(dir);
  if (names === undefined) return undefined;
  const out: string[] = [];
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    const rel = `${dir}/${name}`;
    if (repo.isDir(rel)) {
      const sub = filesUnder(repo, rel);
      if (sub === undefined) return undefined;
      out.push(...sub);
    } else out.push(rel);
  }
  return out;
}

/** exports 的值（字符串、条件对象、数组）里的每一个相对路径。 */
function exportTargets(v: unknown, out: string[]): boolean {
  if (typeof v === 'string') {
    out.push(v);
    return true;
  }
  if (Array.isArray(v)) return v.every((x) => exportTargets(x, out));
  if (typeof v === 'object' && v !== null) return Object.values(v).every((x) => exportTargets(x, out));
  return v === null;
}

/**
 * 一个源码文件里字面量写的相对引用落到的仓内路径；有拿变量拼的引用、走出仓根时返回 null（认不出它够得着哪）。
 */
function relativeRefs(file: string, raw: string): string[] | null {
  const text = stripComments(raw);
  if (COMPUTED_REFS.some((re) => re.test(text))) return null;
  const out: string[] = [];
  for (const re of LITERAL_REFS) {
    for (const m of text.matchAll(re)) {
      const target = resolveRel(file, m[1] as string);
      if (target === undefined) return null;
      out.push(target);
    }
  }
  return out;
}

const parsed = (file: string) => {
  const name = file.split('/').pop() as string;
  return PARSED.test(name) || !name.includes('.');
};

/**
 * packages/<dir> 的面：仓内相对路径排好序；认不出返回 null（整个包都算面）。
 * pkg 是已经 JSON.parse 过的 package.json。指到别的包的相对引用不在这里管（crossPackageTargets）。
 */
export function packageSurface(repo: RepoView, dir: string, pkg: Record<string, unknown>): string[] | null {
  const base = `packages/${dir}`;
  if (pkg.exports === undefined) return null;
  const entries: string[] = [];
  if (!exportTargets(pkg.exports, entries)) return null;
  if (pkg.bin !== undefined && !exportTargets(pkg.bin, entries)) return null;
  if (pkg.main !== undefined && !exportTargets(pkg.main, entries)) return null;
  const seen = new Set<string>();
  const todo: string[] = [];
  const inside = (rel: string) => rel === base || rel.startsWith(`${base}/`);
  const add = (rel: string): boolean => {
    if (repo.isDir(rel)) {
      const files = filesUnder(repo, rel);
      if (files === undefined) return false;
      for (const f of files) add(f);
      return true;
    }
    if (!repo.exists(rel)) return false;
    if (!seen.has(rel)) {
      seen.add(rel);
      todo.push(rel);
    }
    return true;
  };
  for (const e of entries) {
    // 入口带 * 的（子路径通配）认不出展开到哪
    if (!e.startsWith('./') || e.includes('*')) return null;
    const rel = resolveRel(`${base}/package.json`, e);
    if (rel === undefined || !inside(rel) || !add(rel)) return null;
  }
  while (todo.length > 0) {
    const file = todo.pop() as string;
    if (!parsed(file)) continue;
    const raw = repo.read(file);
    if (raw === undefined) return null;
    const refs = relativeRefs(file, raw);
    if (refs === null) return null;
    for (const target of refs) if (inside(target) && !add(target)) return null;
  }
  return [...seen].sort();
}

/** 测试文件（test/ 下的、*.test.*）：它们读别的包的文件由 ci-plan 的 TEST_READS 和 ci-plan.test.ts 的扫描器管。 */
const isTestFile = (rel: string) => rel.includes('/test/') || /\.test\.[cm]?[jt]sx?$/.test(rel);

/**
 * 别的地方（别的包的非测试文件、agents/ 的脚本）拿相对路径直接引用到的 packages/<包>/… 文件：它们改了，引用它的那头
 * 会变（package-boundaries.test.ts 要求这类引用都登记、包也声明了依赖），一律算在被引用的包的面上。
 * 拿变量拼的引用认不出够得着哪，不算（package-boundaries 只认字面量）。
 */
export function crossPackageTargets(repo: RepoView, dirs: readonly string[]): Set<string> {
  const out = new Set<string>();
  const scan = (root: string, own: string | undefined) => {
    for (const file of filesUnder(repo, root) ?? []) {
      if (isTestFile(file) || !parsed(file)) continue;
      const raw = repo.read(file);
      if (raw === undefined) continue;
      for (const target of relativeRefs(file, raw) ?? []) {
        const pkg = /^packages\/([^/]+)\//.exec(target)?.[1];
        if (pkg !== undefined && pkg !== own) out.add(target);
      }
    }
  };
  for (const dir of dirs) scan(`packages/${dir}`, dir);
  scan('agents', undefined);
  return out;
}

/**
 * 包里现有、不在面上的文件（仓内相对路径，排好序）。面认不出（packageSurface 是 null）、列不出包目录时是空的：整个包都算面。
 * 只列现有的：改动里删掉的文件不在这里，照「在面上」算。crossTargets 是 crossPackageTargets 算出的，也都算在面上。
 */
export function packageOffSurface(
  repo: RepoView,
  dir: string,
  pkg: Record<string, unknown>,
  crossTargets: ReadonlySet<string>,
): string[] {
  const surface = packageSurface(repo, dir, pkg);
  if (surface === null) return [];
  // package.json（依赖、exports）、tsconfig.json（tsc -b 顺着引用连带建）改了依赖它的包跟着变：算在面上
  const on = new Set([...surface, `packages/${dir}/package.json`, `packages/${dir}/tsconfig.json`]);
  const files = filesUnder(repo, `packages/${dir}`);
  if (files === undefined) return [];
  // 指到目录的跨包引用：目录下的都算
  const crossDirs = [...crossTargets].filter((t) => repo.isDir(t)).map((t) => `${t}/`);
  return files
    .filter((f) => !on.has(f) && !crossTargets.has(f) && !crossDirs.some((d) => f.startsWith(d)))
    .sort();
}
