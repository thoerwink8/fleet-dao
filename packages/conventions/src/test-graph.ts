// 文件级的测试影响分析：给定这次改了哪些文件，算出哪些测试文件真受影响。纯判断：只经 RepoView 读仓、经 tsgo 子进程解析，不碰 git、不碰网络。
// 算不准的一律交回调用方按 ci-plan.ts 的包级、路径规则处理（unresolved / opaque / runAll），绝不当「没受影响」。
// 改这里之前必须知道：
// - 这里判「少跑」= 放行没测过的改动。拿不准的写法要么交回（unresolved）、要么把测试标成看不透（opaque），不许静默丢掉。
// - 解析用 typescript 7 的 `typescript/unstable/sync`（起一个 tsgo 子进程、经虚拟文件系统喂内容）。API 标着 unstable：
//   升级 typescript 先跑 test/test-graph.test.ts。读不到、解析失败都抛 TestGraphError，调用方按全跑处理。
// - 漏边（图里没有、运行时真读了）只有运行时核对查得出来：改了这里的判据，跑一遍 test-graph-audit.ts（bin/test-graph-audit.ts）。
// - 类型导入（`import type`、`export type … from`）不算边：Node 和 vitest 跑测试前都把它整句擦掉，改了类型不改测试的行为
//   （类型对不对由 tsc 那一步管，tsc 按包跑，不受这里影响）。`import { type A, b }` 这种混着的整句保留，算边。
import { isBuiltin } from 'node:module';
import { posix } from 'node:path';
import { type Node, type SourceFile, SyntaxKind } from 'typescript/unstable/ast';
import { isTypeNode } from 'typescript/unstable/ast/is';
import { API } from 'typescript/unstable/sync';
import { ROOT_CONFIG_FILES } from './ci-plan.ts';
import type { RepoView } from './repo.ts';

export class TestGraphError extends Error {
  override name = 'TestGraphError';
}

/** 和仓根 vitest.config.ts 的 include 一致（test/test-graph.test.ts 核对）。 */
const TEST_FILE = [
  /^packages\/[^/]+\/(?:src|test)\/(?:.+\/)?[^/]+\.test\.tsx?$/,
  /^agents\/test\/(?:.+\/)?[^/]+\.test\.ts$/,
];
export const isTestFile = (rel: string) => TEST_FILE.some((re) => re.test(rel));
const isTestish = (rel: string) => isTestFile(rel) || /(?:^|\/)test\//.test(rel);

/** 所有测试都会加载的入口：它和它的闭包改了，全跑。 */
export const GLOBAL_ENTRIES: readonly string[] = ['vitest.config.ts'];

/** 改了一律交回调用方的：任何一层的 package.json、锁文件、tsconfig、vitest 配置、CI 工作流（另加 ci-plan.ts 的根配置清单）。 */
const HAND_BACK =
  /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig[^/]*\.json|vitest\.config\.[^/]+|\.npmrc|\.nvmrc|\.node-version)$|^\.github\/workflows\//;

const SOURCE_EXT = /\.(?:d\.ts|ts|tsx|mts|cts|mjs|cjs|js)$/;
/** 被读的数据文件：它自己不会再引别的仓内文件，改了只影响读它的。不在这里的（.sh、.py、无后缀脚本……）改了要交回调用方。 */
const DATA_EXT =
  /\.(?:json|jsonl|ndjson|md|txt|ya?ml|sql|csv|tsv|css|svg|png|jpe?g|gif|webp|ico|snap|stderr|stdout|example|toml|xml|html)$/;
/** 走仓时不进的目录名（任何一层）。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-demo', 'coverage']);
/** 走仓时不进的仓根目录。 */
const SKIP_TOP = new Set(['_tmp', '.claude']);

export interface TestGraph {
  /** 图认识的所有仓内文件（调用方给的 git ls-files，或走仓得来的）。 */
  files: ReadonlySet<string>;
  /** 解析过的源文件（.ts/.tsx/.mjs/.js…，外加 shebang 是 node 的无后缀脚本）。 */
  sources: ReadonlySet<string>;
  tests: readonly string[];
  /** 源文件 → 它用到的文件。 */
  deps: ReadonlyMap<string, ReadonlySet<string>>;
  /** 源文件 → 它动态加载的目录：目录下的全部文件（含以后新加、删掉的）当代码，往下走它们的依赖。 */
  dirDeps: ReadonlyMap<string, ReadonlySet<string>>;
  /** 源文件 → 它当数据读的目录（列目录、读里面的文件）：目录下文件的内容和增删影响它，不往下走那些文件的依赖。 */
  dataDirs: ReadonlyMap<string, ReadonlySet<string>>;
  /** 源文件 → 它自己看不透的写法（「行号: 原因: 原文」）。 */
  blind: ReadonlyMap<string, readonly string[]>;
  /** GLOBAL_ENTRIES 和它们的闭包。 */
  /** 被 import 语句真加载的测试文件（极少见）：闭包要往下走。其余测试文件只在路径字符串里出现，当数据。 */
  importedTests: ReadonlySet<string>;
  global: ReadonlySet<string>;
}

export interface Closure {
  files: Set<string>;
  /** 动态加载的目录（目录里的非测试文件已经并进 files）。 */
  codeDirs: Set<string>;
  /** 当数据读的目录。 */
  dataDirs: Set<string>;
  /** 闭包里看不透的地方：「文件 行号: 原因: 原文」。非空 = 这个测试 opaque。 */
  blind: string[];
}

export interface TestSelection {
  /** 图能证明受影响、必须跑的测试文件。 */
  tests: string[];
  /** 图说不清的改动文件，交回调用方按现有规则（planCi 的包级、路径规则）处理。 */
  unresolved: { file: string; why: string }[];
  /**
   * 看不透的测试文件（闭包里有算不出路径的读取、动态加载）：图不替它们做主，调用方按包级规则决定跑不跑
   * （它所在的包被现有规则选中就跑）。这里列的是全仓所有看不透的测试，和这次改了什么无关。
   */
  opaque: { test: string; why: string[] }[];
  /** 改到了所有测试都会加载的文件（vitest 配置的闭包）：调用方全跑。 */
  runAll: { file: string; why: string }[];
  /** 每个改动文件落到了哪，给 CI 日志看。 */
  notes: string[];
}

// ---------------------------------------------------------------- 走仓、读包

/** 走仓列出全部文件（跳过 node_modules、.git、构建产物和仓根的 _tmp、.claude）。列不出抛错。 */
export function listRepoFiles(repo: RepoView): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    const names = repo.list(dir);
    if (names === undefined) throw new TestGraphError(`列不出目录 ${dir === '' ? '（仓根）' : dir}`);
    for (const name of names.sort()) {
      if (SKIP_DIRS.has(name) || (dir === '' && SKIP_TOP.has(name))) continue;
      const rel = dir === '' ? name : `${dir}/${name}`;
      if (repo.isDir(rel)) walk(rel);
      else out.push(rel);
    }
  };
  walk('');
  return out;
}

interface Pkg {
  dir: string;
  exports: unknown;
  imports: unknown;
  main: unknown;
}

function readPackages(repo: RepoView, files: ReadonlySet<string>): Map<string, Pkg> {
  const byName = new Map<string, Pkg>();
  for (const f of files) {
    const m = /^packages\/([^/]+)\/package\.json$/.exec(f);
    if (!m) continue;
    const text = repo.read(f);
    if (text === undefined) throw new TestGraphError(`读不到 ${f}`);
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(text) as Record<string, unknown>;
    } catch (e) {
      throw new TestGraphError(`${f} 不是 JSON（${e instanceof Error ? e.message : String(e)}）`);
    }
    if (typeof pkg.name !== 'string') throw new TestGraphError(`${f} 没有 name`);
    byName.set(pkg.name, {
      dir: `packages/${m[1]}`,
      exports: pkg.exports,
      imports: pkg.imports,
      main: pkg.main,
    });
  }
  return byName;
}

// ---------------------------------------------------------------- 解析（tsgo）

const VROOT = process.platform === 'win32' ? 'C:/__fleet_test_graph__' : '/__fleet_test_graph__';

/** 把一批文件交给 tsgo 解析，回调里用 AST（API 关掉之前）。语法错、拿不到 AST 都抛。 */
function withParsed<T>(texts: ReadonlyMap<string, string>, use: (asts: Map<string, SourceFile>) => T): T {
  const byVirtual = new Map<string, string>();
  let i = 0;
  for (const rel of texts.keys()) {
    // 虚拟名只带后缀：tsgo 按后缀定 ScriptKind，无后缀的 node 脚本当 .mjs
    const ext = SOURCE_EXT.exec(rel)?.[0] ?? '.mjs';
    byVirtual.set(`${VROOT}/f${i++}${ext}`, rel);
  }
  const config = `${VROOT}/tsconfig.json`;
  const norm = (f: string) => f.replace(/\\/g, '/');
  const configText = JSON.stringify({
    compilerOptions: {
      allowJs: true,
      noResolve: true,
      noLib: true,
      types: [],
      noEmit: true,
      jsx: 'preserve',
    },
    files: [...byVirtual.keys()],
  });
  const api = new API({
    cwd: VROOT,
    fs: {
      readFile(f) {
        const n = norm(f);
        if (n === config) return configText;
        const rel = byVirtual.get(n);
        if (rel !== undefined) return texts.get(rel) ?? null;
        return n.startsWith(VROOT) ? null : undefined;
      },
      fileExists(f) {
        const n = norm(f);
        if (n === config || byVirtual.has(n)) return true;
        return n.startsWith(VROOT) ? false : undefined;
      },
      directoryExists(f) {
        const n = norm(f);
        if (n === VROOT) return true;
        return n.startsWith(VROOT) ? false : undefined;
      },
    },
  });
  try {
    const project = api.updateSnapshot({ openProjects: [config] }).getProjects()[0];
    if (project === undefined) throw new TestGraphError('tsgo 没给出项目');
    const bad = project.program.getSyntacticDiagnostics();
    if (bad.length > 0) {
      const lines = bad
        .slice(0, 10)
        .map((d) => `${byVirtual.get(norm(d.fileName ?? '')) ?? d.fileName ?? '?'}: ${d.text}`);
      throw new TestGraphError(`解析失败（${bad.length} 处）：\n${lines.join('\n')}`);
    }
    const asts = new Map<string, SourceFile>();
    for (const [v, rel] of byVirtual) {
      const sf = project.program.getSourceFile(v);
      if (sf === undefined) throw new TestGraphError(`tsgo 没给出 ${rel} 的语法树`);
      asts.set(rel, sf);
    }
    return use(asts);
  } finally {
    api.close();
  }
}

// ---------------------------------------------------------------- 路径求值

/** 路径值：仓内路径一律写成 VR 下的绝对 posix 路径。 */
const VR = '/@repo';
type Val =
  | { k: 'str'; s: string }
  | { k: 'path'; p: string }
  /** 已知开头 + 算不出的后半截。path=false 时开头是普通字符串。dep：后半截来自哪个函数的参数（调用点能补上）。 */
  | { k: 'part'; pre: string; path: boolean; dep?: Node; bare?: boolean }
  /** join(未知, '字', '面') 的尾巴：当仓根相对的候选，不参与拼接。 */
  | { k: 'tail'; s: string }
  | { k: 'param'; fn: Node; index: number }
  | { k: 'unk'; why?: string };

const UNK: Val = { k: 'unk' };
const MAX_VALS = 32;

const toRel = (abs: string): string | undefined => {
  const n = posix.normalize(abs).replace(/\/+$/, '');
  if (n === VR) return '';
  return n.startsWith(`${VR}/`) ? n.slice(VR.length + 1) : undefined;
};
const depOf = (v: Val): Node | undefined => (v.k === 'param' ? v.fn : v.k === 'part' ? v.dep : undefined);

const PATH_FNS = new Set(['join', 'resolve', 'dirname', 'normalize', 'basename']);
const URL_FNS = new Set(['fileURLToPath', 'pathToFileURL']);

interface FileCtx {
  rel: string;
  sf: SourceFile;
  /** 名字 → 它的各个声明初值（const/let/var，整个文件不分作用域）。 */
  decls: Map<string, Node[]>;
  /** 本地名 → 从哪个模块导入的哪个名字。 */
  imports: Map<string, { spec: string; name: string }>;
  /** 导出名 → 本地名。 */
  exportsLocal: Map<string, string>;
  /** 本地名 → node:path / node:url 的函数名。 */
  pathFns: Map<string, string>;
  /** 绑到 node:path（或 posix）、node:url 整个模块的本地名。 */
  pathNs: Set<string>;
  urlNs: Set<string>;
}

function lineOf(sf: SourceFile, node: Node): number {
  const start = node.getStart(sf);
  let line = 1;
  const text = sf.text;
  for (let i = 0; i < start && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

const snippet = (sf: SourceFile, node: Node) => node.getText(sf).replace(/\s+/g, ' ').slice(0, 100);

function isFunctionLike(n: Node): boolean {
  return (
    n.kind === SyntaxKind.FunctionDeclaration ||
    n.kind === SyntaxKind.FunctionExpression ||
    n.kind === SyntaxKind.ArrowFunction ||
    n.kind === SyntaxKind.MethodDeclaration
  );
}

function stringOf(n: Node): string | undefined {
  if (n.kind === SyntaxKind.StringLiteral || n.kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
    return (n as unknown as { text: string }).text;
  }
  return undefined;
}

const nameText = (n: Node | undefined): string | undefined =>
  n !== undefined && (n.kind === SyntaxKind.Identifier || n.kind === SyntaxKind.StringLiteral)
    ? (n as unknown as { text: string }).text
    : undefined;

function buildCtx(rel: string, sf: SourceFile): FileCtx {
  const ctx: FileCtx = {
    rel,
    sf,
    decls: new Map(),
    imports: new Map(),
    exportsLocal: new Map(),
    pathFns: new Map(),
    pathNs: new Set(),
    urlNs: new Set(),
  };
  const visit = (n: Node): undefined => {
    if (n.kind === SyntaxKind.VariableDeclaration) {
      const d = n as unknown as { name: Node; initializer?: Node };
      const name = nameText(d.name);
      if (name !== undefined && d.initializer !== undefined && d.name.kind === SyntaxKind.Identifier) {
        ctx.decls.set(name, [...(ctx.decls.get(name) ?? []), d.initializer]);
        const stmt = n.parent?.parent;
        if (stmt?.kind === SyntaxKind.VariableStatement && hasExport(stmt)) ctx.exportsLocal.set(name, name);
      }
    } else if (n.kind === SyntaxKind.FunctionDeclaration && hasExport(n)) {
      const name = nameText((n as unknown as { name?: Node }).name);
      if (name !== undefined) ctx.exportsLocal.set(name, name);
    } else if (n.kind === SyntaxKind.ImportDeclaration) {
      const d = n as unknown as {
        moduleSpecifier: Node;
        importClause?: { phaseModifier?: SyntaxKind; name?: Node; namedBindings?: Node };
      };
      const spec = stringOf(d.moduleSpecifier);
      const clause = d.importClause;
      if (spec !== undefined && clause !== undefined && clause.phaseModifier !== SyntaxKind.TypeKeyword) {
        const isPath =
          spec === 'node:path' || spec === 'path' || spec === 'node:path/posix' || spec === 'path/posix';
        const isUrl = spec === 'node:url' || spec === 'url';
        const def = nameText(clause.name);
        if (def !== undefined) {
          ctx.imports.set(def, { spec, name: 'default' });
          if (isPath) ctx.pathNs.add(def);
          if (isUrl) ctx.urlNs.add(def);
        }
        const nb = clause.namedBindings;
        if (nb?.kind === SyntaxKind.NamespaceImport) {
          const ns = nameText((nb as unknown as { name: Node }).name);
          if (ns !== undefined) {
            ctx.imports.set(ns, { spec, name: '*' });
            if (isPath) ctx.pathNs.add(ns);
            if (isUrl) ctx.urlNs.add(ns);
          }
        } else if (nb?.kind === SyntaxKind.NamedImports) {
          for (const el of (nb as unknown as { elements: readonly Node[] }).elements) {
            const e = el as unknown as { isTypeOnly: boolean; name: Node; propertyName?: Node };
            if (e.isTypeOnly) continue;
            const local = nameText(e.name);
            const imported = nameText(e.propertyName) ?? local;
            if (local === undefined || imported === undefined) continue;
            ctx.imports.set(local, { spec, name: imported });
            if (isPath && PATH_FNS.has(imported)) ctx.pathFns.set(local, imported);
            if (isPath && imported === 'posix') ctx.pathNs.add(local);
            if (isUrl && URL_FNS.has(imported)) ctx.pathFns.set(local, imported);
          }
        }
      }
      return undefined;
    } else if (n.kind === SyntaxKind.ExportDeclaration) {
      const d = n as unknown as { isTypeOnly: boolean; moduleSpecifier?: Node; exportClause?: Node };
      if (
        !d.isTypeOnly &&
        d.moduleSpecifier === undefined &&
        d.exportClause?.kind === SyntaxKind.NamedExports
      ) {
        for (const el of (d.exportClause as unknown as { elements: readonly Node[] }).elements) {
          const e = el as unknown as { name: Node; propertyName?: Node };
          const exported = nameText(e.name);
          const local = nameText(e.propertyName) ?? exported;
          if (exported !== undefined && local !== undefined) ctx.exportsLocal.set(exported, local);
        }
      }
      return undefined;
    }
    n.forEachChild(visit);
    return undefined;
  };
  sf.forEachChild(visit);
  return ctx;
}

function hasExport(n: Node): boolean {
  const mods = (n as unknown as { modifiers?: readonly Node[] }).modifiers;
  return mods?.some((m) => m.kind === SyntaxKind.ExportKeyword) ?? false;
}

/** 标识符的绑定：最近一层函数的同名参数（返回那个函数和第几个），否则 undefined。 */
function paramBinding(id: Node, name: string): { fn: Node; index: number; param: Node } | undefined {
  for (let p: Node | undefined = id.parent; p !== undefined; p = p.parent) {
    if (!isFunctionLike(p)) continue;
    const params = (p as unknown as { parameters: readonly Node[] }).parameters;
    for (let i = 0; i < params.length; i++) {
      const param = params[i] as Node;
      if (nameText((param as unknown as { name: Node }).name) === name) return { fn: p, index: i, param };
    }
  }
  return undefined;
}

class Analyzer {
  private ctxs = new Map<string, FileCtx>();
  private inProgress = new Set<Node>();
  private asts: ReadonlyMap<string, SourceFile>;
  private resolveSpec: (spec: string, from: string) => Target;
  constructor(asts: ReadonlyMap<string, SourceFile>, resolveSpec: (spec: string, from: string) => Target) {
    this.asts = asts;
    this.resolveSpec = resolveSpec;
  }

  ctx(rel: string): FileCtx | undefined {
    let c = this.ctxs.get(rel);
    if (c === undefined) {
      const sf = this.asts.get(rel);
      if (sf === undefined) return undefined;
      c = buildCtx(rel, sf);
      this.ctxs.set(rel, c);
    }
    return c;
  }

  /** 求一个表达式可能的值。env：调用点给函数参数绑上的值。 */
  evaluate(n: Node, c: FileCtx, env?: Map<Node, Val[]>): Val[] {
    const vals = this.eval1(n, c, env);
    return vals.length > MAX_VALS ? [UNK] : vals;
  }

  private eval1(n: Node, c: FileCtx, env?: Map<Node, Val[]>): Val[] {
    const any = n as unknown as Record<string, Node & readonly Node[]>;
    switch (n.kind) {
      case SyntaxKind.StringLiteral:
      case SyntaxKind.NoSubstitutionTemplateLiteral:
        return [{ k: 'str', s: (n as unknown as { text: string }).text }];
      case SyntaxKind.ParenthesizedExpression:
      case SyntaxKind.AsExpression:
      case SyntaxKind.NonNullExpression:
      case SyntaxKind.SatisfiesExpression:
      case SyntaxKind.AwaitExpression:
        return this.evaluate(any.expression as Node, c, env);
      case SyntaxKind.TemplateExpression: {
        let acc: Val[] = [{ k: 'str', s: (any.head as unknown as { text: string }).text }];
        for (const span of any.templateSpans as readonly Node[]) {
          const s = span as unknown as { expression: Node; literal: { text: string } };
          acc = cross(acc, this.evaluate(s.expression, c, env), concat);
          acc = cross(acc, [{ k: 'str', s: s.literal.text }], concat);
        }
        return acc;
      }
      case SyntaxKind.BinaryExpression: {
        const b = n as unknown as { left: Node; right: Node; operatorToken: Node };
        if (b.operatorToken.kind !== SyntaxKind.PlusToken) return [UNK];
        return cross(this.evaluate(b.left, c, env), this.evaluate(b.right, c, env), concat);
      }
      case SyntaxKind.ConditionalExpression: {
        const t = n as unknown as { whenTrue: Node; whenFalse: Node };
        return [...this.evaluate(t.whenTrue, c, env), ...this.evaluate(t.whenFalse, c, env)];
      }
      case SyntaxKind.Identifier:
        return this.evalIdent(n, c, env);
      case SyntaxKind.MetaProperty:
        return [UNK];
      case SyntaxKind.PropertyAccessExpression: {
        const p = n as unknown as { expression: Node; name: Node };
        const prop = nameText(p.name);
        if (p.expression.kind === SyntaxKind.MetaProperty) {
          const file = `${VR}/${c.rel}`;
          if (prop === 'url' || prop === 'filename') return [{ k: 'path', p: file }];
          if (prop === 'dirname') return [{ k: 'path', p: posix.dirname(file) }];
          return [UNK];
        }
        if (prop === 'href' || prop === 'pathname') return this.evaluate(p.expression, c, env);
        return [UNK];
      }
      case SyntaxKind.CallExpression:
        return this.evalCall(n, c, env);
      case SyntaxKind.NewExpression: {
        const ne = n as unknown as { expression: Node; arguments?: readonly Node[] };
        if (nameText(ne.expression) !== 'URL' || ne.arguments === undefined || ne.arguments.length === 0)
          return [UNK];
        const [a0, a1] = ne.arguments;
        const rels = this.evaluate(a0 as Node, c, env);
        if (a1 === undefined) {
          return rels.map((v) =>
            v.k === 'str' && v.s.startsWith('file:')
              ? { k: 'path', p: fileUrlPath(v.s) }
              : v.k === 'str'
                ? v
                : UNK,
          );
        }
        const bases = this.evaluate(a1, c, env);
        return cross(rels, bases, (rv, bv) => {
          if (bv.k !== 'path') return UNK;
          if (rv.k === 'str') {
            if (/^[a-z][a-z0-9+.-]*:/i.test(rv.s))
              return rv.s.startsWith('file:') ? { k: 'path', p: fileUrlPath(rv.s) } : rv;
            return { k: 'path', p: urlResolve(rv.s, bv.p) };
          }
          if (rv.k === 'part' && !rv.path && rv.pre !== '') {
            const pre = urlResolve(rv.pre.replace(/[^/]*$/, ''), bv.p);
            return {
              k: 'part',
              pre: pre.endsWith('/') ? pre : `${pre}/`,
              path: true,
              ...(rv.dep ? { dep: rv.dep } : {}),
            };
          }
          if (rv.k === 'part' && !rv.path && rv.pre === '' && bv.p.endsWith('/')) {
            // new URL(`${name}.ext`, 目录 URL)：落在那个目录里（name 里带 .. 或绝对路径的写法没人这么用），连到目录
            return { k: 'part', pre: bv.p, path: true, ...(rv.dep ? { dep: rv.dep } : {}) };
          }
          if (rv.k === 'param' || (rv.k === 'part' && !rv.path && rv.pre === '')) {
            // 整个相对 URL 都是参数：调用点补得上就按实参算；补不上它可以是任何地方（'../..'、绝对路径），只能看不透
            const dep = rv.k === 'param' ? rv.fn : rv.dep;
            return {
              k: 'part',
              pre: urlResolve('./', bv.p),
              path: true,
              bare: true,
              ...(dep ? { dep } : {}),
            };
          }
          return { k: 'unk', why: 'new URL(算不出的路径, import.meta.url)' };
        });
      }
      default:
        return [UNK];
    }
  }

  private evalIdent(n: Node, c: FileCtx, env?: Map<Node, Val[]>): Val[] {
    const name = (n as unknown as { text: string }).text;
    if (name === '__dirname') return [{ k: 'path', p: posix.dirname(`${VR}/${c.rel}`) }];
    if (name === '__filename') return [{ k: 'path', p: `${VR}/${c.rel}` }];
    const bound = paramBinding(n, name);
    if (bound !== undefined) {
      const v = env?.get(bound.param);
      return v ?? [{ k: 'param', fn: bound.fn, index: bound.index }];
    }
    const decls = c.decls.get(name);
    if (decls !== undefined) {
      const out: Val[] = [];
      for (const init of decls) {
        if (this.inProgress.has(init)) {
          out.push(UNK);
          continue;
        }
        this.inProgress.add(init);
        try {
          // 声明处的初值不带调用点的 env：顶层常量不依赖参数；函数里的局部常量依赖参数时，值里带着 dep
          out.push(...this.evaluate(init, c, env));
        } finally {
          this.inProgress.delete(init);
        }
      }
      return out;
    }
    const imp = c.imports.get(name);
    if (imp !== undefined && imp.name !== '*' && imp.name !== 'default') {
      const t = this.resolveSpec(imp.spec, c.rel);
      if ('file' in t) {
        const other = this.ctx(t.file);
        const local = other?.exportsLocal.get(imp.name);
        if (other !== undefined && local !== undefined) {
          const decls2 = other.decls.get(local) ?? [];
          const out: Val[] = [];
          for (const init of decls2) {
            if (this.inProgress.has(init)) continue;
            this.inProgress.add(init);
            try {
              out.push(...this.evaluate(init, other).map((v) => (depOf(v) ? UNK : v)));
            } finally {
              this.inProgress.delete(init);
            }
          }
          if (out.length > 0) return out;
        }
      }
    }
    return [UNK];
  }

  isPathCall(n: Node, c: FileCtx): boolean {
    return this.calleeName((n as unknown as { expression: Node }).expression, c) !== undefined;
  }

  private calleeName(callee: Node, c: FileCtx): string | undefined {
    if (callee.kind === SyntaxKind.Identifier) {
      const name = (callee as unknown as { text: string }).text;
      if (name === 'String') return 'String';
      return c.pathFns.get(name);
    }
    if (callee.kind === SyntaxKind.PropertyAccessExpression) {
      const p = callee as unknown as { expression: Node; name: Node };
      const prop = nameText(p.name);
      if (prop === undefined) return undefined;
      const obj = p.expression;
      const objName = nameText(obj);
      if (objName !== undefined && c.pathNs.has(objName) && PATH_FNS.has(prop)) return prop;
      if (objName !== undefined && c.urlNs.has(objName) && URL_FNS.has(prop)) return prop;
      // path.posix.join
      if (obj.kind === SyntaxKind.PropertyAccessExpression) {
        const inner = obj as unknown as { expression: Node; name: Node };
        const innerObj = nameText(inner.expression);
        if (
          innerObj !== undefined &&
          c.pathNs.has(innerObj) &&
          nameText(inner.name) === 'posix' &&
          PATH_FNS.has(prop)
        )
          return prop;
      }
      if (objName === 'process' && prop === 'cwd') return 'cwd';
      if (prop === 'toString') return 'toString';
    }
    return undefined;
  }

  private evalCall(n: Node, c: FileCtx, env?: Map<Node, Val[]>): Val[] {
    const call = n as unknown as { expression: Node; arguments: readonly Node[] };
    const fn = this.calleeName(call.expression, c);
    if (fn === undefined) return [UNK];
    // vitest 在仓根跑，测试里的 cwd 就是仓根；源文件被子进程跑时 cwd 由调用方定，算不出
    if (fn === 'cwd') return isTestish(c.rel) ? [{ k: 'path', p: VR }] : [UNK];
    if (fn === 'toString') {
      return this.evaluate((call.expression as unknown as { expression: Node }).expression, c, env);
    }
    const args = call.arguments.map((a) =>
      a.kind === SyntaxKind.SpreadElement ? [UNK] : this.evaluate(a, c, env),
    );
    if (fn === 'String' || fn === 'fileURLToPath' || fn === 'pathToFileURL' || fn === 'normalize') {
      return (args[0] ?? [UNK]).map((v) =>
        v.k === 'str' && v.s.startsWith('file:') ? { k: 'path', p: fileUrlPath(v.s) } : v,
      );
    }
    if (fn === 'dirname') {
      return (args[0] ?? [UNK]).map(
        (v): Val =>
          v.k === 'path'
            ? { k: 'path', p: posix.dirname(v.p) }
            : v.k === 'str'
              ? { k: 'str', s: posix.dirname(v.s) }
              : v.k === 'part'
                ? v
                : UNK,
      );
    }
    if (fn === 'basename') return [UNK];
    // join / resolve：各参数取值的笛卡尔积
    let combos: Val[][] = [[]];
    for (const a of args) {
      const next: Val[][] = [];
      for (const prefix of combos) for (const v of a) next.push([...prefix, v]);
      combos = next;
      if (combos.length > MAX_VALS) return [UNK];
    }
    return combos.map((parts) => (fn === 'join' ? joinVals(parts) : resolveVals(parts)));
  }
}

function fileUrlPath(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname);
  } catch {
    return '';
  }
}

/** new URL(rel, base) 的路径部分；base 是 VR 下的绝对路径（文件或以 / 结尾的目录）。 */
function urlResolve(rel: string, base: string): string {
  try {
    return decodeURIComponent(new URL(rel, `file://${base}`).pathname);
  } catch {
    return '';
  }
}

function cross(a: Val[], b: Val[], f: (x: Val, y: Val) => Val): Val[] {
  if (a.length * b.length > MAX_VALS) return [UNK];
  const out: Val[] = [];
  for (const x of a) for (const y of b) out.push(f(x, y));
  return out;
}

function concat(a: Val, b: Val): Val {
  if (a.k === 'str' && b.k === 'str') return { k: 'str', s: a.s + b.s };
  if (a.k === 'path' && b.k === 'str') return { k: 'path', p: a.p + b.s };
  if (a.k === 'str' && b.k === 'path' && a.s === '') return b;
  if (a.k === 'str' && a.s.startsWith('file://') && b.k === 'str') return { k: 'str', s: a.s + b.s };
  if (a.k === 'part') return a;
  if (a.k === 'str' || a.k === 'path') {
    const dep = depOf(b);
    return { k: 'part', pre: a.k === 'str' ? a.s : a.p, path: a.k === 'path', ...(dep ? { dep } : {}) };
  }
  return a.k === 'unk' ? a : UNK;
}

function joinVals(parts: Val[]): Val {
  const first = parts[0];
  if (first === undefined) return { k: 'str', s: '.' };
  if (first.k !== 'path' && first.k !== 'str') {
    // 底算不出：后面全是字面量就当一条仓根相对的候选
    const rest = parts.slice(1);
    if (rest.length > 0 && rest.every((p) => p.k === 'str')) {
      return { k: 'tail', s: posix.join(...rest.map((p) => (p as { s: string }).s)) };
    }
    return first.k === 'param' ? { k: 'unk' } : UNK;
  }
  let acc = first.k === 'path' ? first.p : first.s;
  for (const p of parts.slice(1)) {
    if (p.k === 'str') acc = posix.join(acc, p.s);
    else if (p.k === 'path') acc = posix.join(acc, p.p);
    else {
      const dep = depOf(p);
      return {
        k: 'part',
        pre: `${acc.replace(/\/+$/, '')}/`,
        path: first.k === 'path',
        ...(dep ? { dep } : {}),
      };
    }
  }
  return first.k === 'path' ? { k: 'path', p: acc } : { k: 'str', s: acc };
}

function resolveVals(parts: Val[]): Val {
  // 从右往左找最后一个绝对的起点；起点之后有算不出的就是半截
  let start = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i] as Val;
    if (p.k === 'path' || (p.k === 'str' && p.s.startsWith('/'))) {
      start = i;
      break;
    }
  }
  const tail = parts.slice(start + 1);
  let acc =
    start >= 0
      ? (parts[start] as Val).k === 'path'
        ? (parts[start] as { p: string }).p
        : (parts[start] as { s: string }).s
      : VR;
  if (start < 0 && parts.some((p) => p.k !== 'str')) {
    const firstBad = parts.findIndex((p) => p.k !== 'str');
    if (firstBad === 0) {
      const rest = parts.slice(1);
      if (rest.length > 0 && rest.every((p) => p.k === 'str')) {
        return { k: 'tail', s: posix.join(...rest.map((p) => (p as { s: string }).s)) };
      }
      return UNK;
    }
  }
  for (const p of tail) {
    if (p.k === 'str') acc = posix.resolve(acc, p.s);
    else {
      const dep = depOf(p);
      return { k: 'part', pre: `${acc.replace(/\/+$/, '')}/`, path: true, ...(dep ? { dep } : {}) };
    }
  }
  return { k: 'path', p: acc };
}

// ---------------------------------------------------------------- 模块说明符

type Target = { file: string } | { dir: string } | { ext: true } | { missing: string };

const RELATIVE_CANDIDATES = (base: string): string[] => {
  const out = [base];
  if (/\.js$/.test(base)) out.push(base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'));
  if (/\.mjs$/.test(base)) out.push(base.replace(/\.mjs$/, '.mts'));
  for (const ext of ['.ts', '.tsx', '.mts', '.mjs', '.js', '.json']) out.push(base + ext);
  for (const idx of ['index.ts', 'index.tsx', 'index.mjs', 'index.js']) out.push(posix.join(base, idx));
  return out;
};

function makeResolver(files: ReadonlySet<string>, dirs: ReadonlySet<string>, pkgs: Map<string, Pkg>) {
  const byDir = new Map<string, Pkg>([...pkgs.values()].map((p) => [p.dir, p]));
  const findFile = (base: string): string | undefined => RELATIVE_CANDIDATES(base).find((c) => files.has(c));
  const mapField = (field: unknown, key: string, pkgDir: string): Target | undefined => {
    if (field === undefined || field === null) return undefined;
    let entry: unknown;
    let star: string | undefined;
    if (typeof field === 'string' || Array.isArray(field)) {
      if (key !== '.') return undefined;
      entry = field;
    } else if (typeof field === 'object') {
      const obj = field as Record<string, unknown>;
      const keys = Object.keys(obj);
      const isMap = keys.some((k) => k.startsWith('.') || k.startsWith('#'));
      if (!isMap) {
        if (key !== '.') return undefined;
        entry = obj;
      } else if (key in obj) entry = obj[key];
      else {
        for (const k of keys) {
          const i = k.indexOf('*');
          if (i < 0) continue;
          const pre = k.slice(0, i);
          const post = k.slice(i + 1);
          if (key.startsWith(pre) && key.endsWith(post) && key.length >= pre.length + post.length) {
            entry = obj[k];
            star = key.slice(pre.length, key.length - post.length);
            break;
          }
        }
      }
    }
    if (entry === undefined) return undefined;
    const leaves: string[] = [];
    const collect = (v: unknown) => {
      if (typeof v === 'string') leaves.push(star === undefined ? v : v.replaceAll('*', star));
      else if (Array.isArray(v)) v.forEach(collect);
      else if (typeof v === 'object' && v !== null) Object.values(v).forEach(collect);
    };
    collect(entry);
    const hits = leaves.map((l) => posix.join(pkgDir, l)).filter((f) => files.has(f));
    // 条件导出指向几个文件时连到包目录（宁可多连）
    if (hits.length === 1) return { file: hits[0] as string };
    return { dir: pkgDir };
  };
  const pkgOf = (from: string): Pkg | undefined => {
    const m = /^packages\/[^/]+/.exec(from);
    return m ? byDir.get(m[0]) : undefined;
  };
  return (rawSpec: string, from: string): Target => {
    const spec = rawSpec.replace(/\?.*$/, '');
    if (spec.startsWith('node:') || isBuiltin(spec)) return { ext: true };
    if (spec.startsWith('.') || spec.startsWith('/')) {
      const base = posix.normalize(
        spec.startsWith('/') ? spec.slice(1) : posix.join(posix.dirname(from), spec),
      );
      if (base.startsWith('..')) return { missing: `${rawSpec} 指到仓外` };
      const f = findFile(base);
      if (f !== undefined) return { file: f };
      if (dirs.has(base)) return { dir: base };
      return { missing: `${rawSpec} 在仓里找不到` };
    }
    if (spec.startsWith('#')) {
      const pkg = pkgOf(from);
      if (pkg === undefined) return { missing: `${rawSpec}：不在任何包里，找不到 imports` };
      return mapField(pkg.imports, spec, pkg.dir) ?? { dir: pkg.dir };
    }
    const segs = spec.split('/');
    const name = spec.startsWith('@') ? segs.slice(0, 2).join('/') : (segs[0] as string);
    const pkg = pkgs.get(name);
    if (pkg === undefined) return { ext: true };
    const sub = spec.slice(name.length);
    const key = sub === '' ? '.' : `.${sub}`;
    const viaExports = mapField(pkg.exports, key, pkg.dir);
    if (viaExports !== undefined) return viaExports;
    if (pkg.exports === undefined) {
      if (sub !== '') {
        const f = findFile(posix.join(pkg.dir, sub));
        if (f !== undefined) return { file: f };
      } else if (typeof pkg.main === 'string' && files.has(posix.join(pkg.dir, pkg.main))) {
        return { file: posix.join(pkg.dir, pkg.main) };
      }
    }
    return { dir: pkg.dir };
  };
}

// ---------------------------------------------------------------- 建图

const MODULE_CALLS = new Set([
  'require',
  'require.resolve',
  'import.meta.resolve',
  'vi.mock',
  'vi.doMock',
  'vi.unmock',
  'vi.doUnmock',
  'vi.importActual',
  'vi.importMock',
]);

function dottedName(n: Node): string | undefined {
  if (n.kind === SyntaxKind.Identifier) return (n as unknown as { text: string }).text;
  if (n.kind === SyntaxKind.MetaProperty) return 'import.meta';
  if (n.kind === SyntaxKind.PropertyAccessExpression) {
    const p = n as unknown as { expression: Node; name: Node };
    const left = dottedName(p.expression);
    const right = nameText(p.name);
    return left !== undefined && right !== undefined ? `${left}.${right}` : undefined;
  }
  return undefined;
}

const PATHY_KINDS = new Set<SyntaxKind>([
  SyntaxKind.StringLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TemplateExpression,
  SyntaxKind.Identifier,
  SyntaxKind.NewExpression,
  SyntaxKind.MetaProperty,
]);

export interface BuildOptions {
  /** 仓内文件清单（git ls-files）；不给就走仓（listRepoFiles）。 */
  files?: readonly string[];
}

/** 建依赖图。读不到文件、package.json 认不出、语法错都抛 TestGraphError。 */
export function buildTestGraph(repo: RepoView, options: BuildOptions = {}): TestGraph {
  const fileList = options.files ?? listRepoFiles(repo);
  const files = new Set(fileList);
  const dirs = new Set<string>(['']);
  for (const f of files) {
    const segs = f.split('/');
    for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join('/'));
  }
  const pkgs = readPackages(repo, files);
  const texts = new Map<string, string>();
  for (const f of [...files].sort()) {
    const isSource = SOURCE_EXT.test(f);
    const maybeScript = !isSource && !/\.[^/]+$/.test(f.slice(f.lastIndexOf('/') + 1));
    if (!isSource && !maybeScript) continue;
    const text = repo.read(f);
    if (text === undefined) throw new TestGraphError(`读不到 ${f}`);
    if (maybeScript && !/^#!.*\bnode\b/.test(text)) continue;
    texts.set(f, text);
  }
  const resolve = makeResolver(files, dirs, pkgs);
  const deps = new Map<string, Set<string>>();
  const dirDeps = new Map<string, Set<string>>();
  const dataDirs = new Map<string, Set<string>>();
  const blind = new Map<string, string[]>();
  const importedTests = new Set<string>();

  withParsed(texts, (asts) => {
    const az = new Analyzer(asts, resolve);
    for (const rel of texts.keys()) {
      const c = az.ctx(rel) as FileCtx;
      const myDeps = new Set<string>();
      const myDirs = new Set<string>();
      const myData = new Set<string>();
      const myBlind: string[] = [];
      const say = (node: Node, why: string) =>
        myBlind.push(`${lineOf(c.sf, node)}: ${why}: ${snippet(c.sf, node)}`);
      const addTarget = (t: Target, node: Node) => {
        if ('file' in t) {
          myDeps.add(t.file);
          if (isTestFile(t.file)) importedTests.add(t.file);
        } else if ('dir' in t) myDirs.add(t.dir);
        else if ('missing' in t) say(node, t.missing);
      };
      // 目录分两种：动态加载的（当代码，往下走它们的依赖）和当数据读的（列目录、读里面的文件：只认内容与增删）
      const existing = (rel2: string | undefined, node: Node, rootWhy: string, module: boolean): void => {
        if (rel2 === undefined) return;
        if (rel2 === '') return void say(node, rootWhy);
        if (files.has(rel2)) myDeps.add(rel2);
        else if (dirs.has(rel2)) (module ? myDirs : myData).add(rel2);
      };
      const dirOfPart = (pre: string, node: Node, module: boolean) => {
        let rel2 = toRel(pre.endsWith('/') ? pre : posix.dirname(pre));
        if (rel2 === undefined) return;
        while (rel2 !== '' && !dirs.has(rel2)) rel2 = posix.dirname(rel2) === '.' ? '' : posix.dirname(rel2);
        if (rel2 === '') say(node, '仓根拼上算不出的路径');
        else (module ? myDirs : myData).add(rel2);
      };
      /** deferred：值依赖某个函数的参数，等看完调用点再定。expr 是求值的表达式，node 是报告位置。 */
      const deferred = new Map<Node, Map<Node, { node: Node; module: boolean }>>();
      const record = (vals: Val[], node: Node, module: boolean, final: boolean, expr: Node = node) => {
        for (const v of vals) {
          const dep = depOf(v);
          if (dep !== undefined && !final) {
            const uses = deferred.get(dep) ?? new Map<Node, { node: Node; module: boolean }>();
            uses.set(expr, { node, module });
            deferred.set(dep, uses);
            continue;
          }
          switch (v.k) {
            case 'path':
              existing(toRel(v.p), node, '仓根整个交给了别处，读什么看不出', module);
              break;
            case 'part':
              if (v.bare) say(node, 'new URL(算不出的路径, import.meta.url)');
              else if (v.path) dirOfPart(v.pre, node, module);
              else if (v.pre.startsWith('./') || v.pre.startsWith('../'))
                dirOfPart(
                  posix.join(posix.dirname(`${VR}/${rel}`), v.pre) + (v.pre.endsWith('/') ? '/' : ''),
                  node,
                  module,
                );
              else if (module) say(node, '动态加载的说明符算不出');
              break;
            case 'str':
              if (module) addTarget(resolve(v.s, rel), node);
              else strCandidate(v.s, node);
              break;
            case 'tail':
              strCandidate(v.s, node, true);
              break;
            case 'param':
            case 'unk':
              if (v.k === 'unk' && v.why) say(node, v.why);
              else if (module) say(node, '动态加载的说明符算不出');
              break;
          }
        }
      };
      const strCandidate = (s: string, node: Node, rootOnly = false) => {
        if (s === '' || /^[a-z][a-z0-9+.-]*:/i.test(s) || s.includes('\n') || s.length > 300) return;
        if (!rootOnly && (s.startsWith('./') || s.startsWith('../'))) {
          const r = toRel(posix.join(posix.dirname(`${VR}/${rel}`), s));
          if (r) existing(r, node, '', false);
        }
        const r = posix.normalize(s.replace(/^\.\//, '')).replace(/\/+$/, '');
        if (r.startsWith('..') || r.startsWith('/') || r === '.') return;
        // 不带斜杠的一整段（README.md、package.json 这种）只在实参位置当仓根相对路径：别处多半是判据、消息文本
        const callArg =
          node.parent?.kind === SyntaxKind.CallExpression || node.parent?.kind === SyntaxKind.NewExpression;
        if (r.includes('/')) existing(r, node, '', false);
        else if (callArg && files.has(r)) existing(r, node, '', false);
      };
      const moduleUse = (arg: Node | undefined, node: Node) => {
        if (arg === undefined) return say(node, '动态加载没有参数');
        const lit = stringOf(arg);
        if (lit !== undefined) return addTarget(resolve(lit, rel), node);
        record(az.evaluate(arg, c), node, true, false, arg);
      };
      // 标识符只在「把值交出去」的位置算一次使用（实参、属性值、数组元素、返回值）；比较、取属性（ROOT.length）不算读
      const isValueIdent = (ident: Node): boolean => {
        let id = ident;
        for (;;) {
          const up = id.parent;
          if (up === undefined) return false;
          const wraps =
            up.kind === SyntaxKind.ParenthesizedExpression ||
            up.kind === SyntaxKind.AsExpression ||
            up.kind === SyntaxKind.NonNullExpression ||
            up.kind === SyntaxKind.SatisfiesExpression ||
            up.kind === SyntaxKind.AwaitExpression ||
            (up.kind === SyntaxKind.ConditionalExpression &&
              (up as unknown as { condition: Node }).condition !== id) ||
            (up.kind === SyntaxKind.BinaryExpression &&
              [SyntaxKind.QuestionQuestionToken, SyntaxKind.BarBarToken].includes(
                (up as unknown as { operatorToken: Node }).operatorToken.kind,
              ));
          if (!wraps) break;
          id = up;
        }
        const p = id.parent;
        if (p === undefined) return false;
        const pa = p as unknown as Record<string, unknown>;
        switch (p.kind) {
          case SyntaxKind.CallExpression:
          case SyntaxKind.NewExpression:
            return pa.expression !== id;
          case SyntaxKind.ShorthandPropertyAssignment:
          case SyntaxKind.SpreadElement:
          case SyntaxKind.ArrayLiteralExpression:
          case SyntaxKind.ReturnStatement:
            return true;
          case SyntaxKind.PropertyAssignment:
            return pa.initializer === id;
          case SyntaxKind.ArrowFunction:
            return pa.body === id;
          case SyntaxKind.Parameter:
          case SyntaxKind.BindingElement:
            return pa.initializer === id;
          default:
            return false;
        }
      };
      const isCandidate = (n: Node): boolean => {
        if (n.kind === SyntaxKind.Identifier) return isValueIdent(n);
        if (PATHY_KINDS.has(n.kind)) {
          const pa = n.parent as unknown as Record<string, unknown> | undefined;
          return !(pa && (pa.name === n || pa.propertyName === n));
        }
        if (n.kind === SyntaxKind.BinaryExpression)
          return (n as unknown as { operatorToken: Node }).operatorToken.kind === SyntaxKind.PlusToken;
        if (n.kind === SyntaxKind.CallExpression) return az.isPathCall(n, c);
        if (n.kind === SyntaxKind.PropertyAccessExpression) {
          const p = n as unknown as { expression: Node; name: Node };
          const prop = nameText(p.name);
          return p.expression.kind === SyntaxKind.MetaProperty || prop === 'href' || prop === 'pathname';
        }
        return false;
      };
      const isDefinition = (n: Node): boolean => {
        const p = n.parent;
        if (p?.kind !== SyntaxKind.VariableDeclaration) return false;
        const d = p as unknown as { initializer?: Node; name: Node };
        return d.initializer === n && d.name.kind === SyntaxKind.Identifier;
      };
      const visit = (n: Node, suppressed: boolean): undefined => {
        if (
          isTypeNode(n) ||
          n.kind === SyntaxKind.TypeAliasDeclaration ||
          n.kind === SyntaxKind.InterfaceDeclaration ||
          n.kind === SyntaxKind.ImportType
        )
          return undefined;
        switch (n.kind) {
          case SyntaxKind.ImportDeclaration: {
            const d = n as unknown as {
              moduleSpecifier: Node;
              importClause?: { phaseModifier?: SyntaxKind };
            };
            if (d.importClause?.phaseModifier === SyntaxKind.TypeKeyword) return undefined;
            moduleUse(d.moduleSpecifier, n);
            return undefined;
          }
          case SyntaxKind.ExportDeclaration: {
            const d = n as unknown as { isTypeOnly: boolean; moduleSpecifier?: Node };
            if (!d.isTypeOnly && d.moduleSpecifier !== undefined) moduleUse(d.moduleSpecifier, n);
            return undefined;
          }
          case SyntaxKind.ImportEqualsDeclaration: {
            const d = n as unknown as { isTypeOnly: boolean; moduleReference: Node };
            if (!d.isTypeOnly && d.moduleReference.kind === SyntaxKind.ExternalModuleReference)
              moduleUse((d.moduleReference as unknown as { expression: Node }).expression, n);
            return undefined;
          }
          case SyntaxKind.CallExpression: {
            const call = n as unknown as { expression: Node; arguments: readonly Node[] };
            const callee = call.expression;
            const dn = callee.kind === SyntaxKind.ImportKeyword ? 'import' : dottedName(callee);
            if (dn === 'import' || (dn !== undefined && MODULE_CALLS.has(dn))) {
              moduleUse(call.arguments[0], n);
              for (const a of call.arguments.slice(1)) visit(a, false);
              if (callee.kind !== SyntaxKind.ImportKeyword) visit(callee, false);
              return undefined;
            }
            if (dn === 'import.meta.glob') {
              const globs = call.arguments[0];
              const pats: string[] = [];
              const lit = globs ? stringOf(globs) : undefined;
              if (lit !== undefined) pats.push(lit);
              else if (globs?.kind === SyntaxKind.ArrayLiteralExpression) {
                for (const e of (globs as unknown as { elements: readonly Node[] }).elements) {
                  const s = stringOf(e);
                  if (s === undefined) return void say(n, 'import.meta.glob 的模式算不出');
                  pats.push(s);
                }
              } else return void say(n, 'import.meta.glob 的模式算不出');
              for (const pat of pats) {
                const stat = pat.replace(/^!/, '').split(/[*?{[]/)[0] as string;
                dirOfPart(
                  `${posix.join(posix.dirname(`${VR}/${rel}`), stat.replace(/[^/]*$/, ''))}/`,
                  n,
                  true,
                );
              }
              return undefined;
            }
            break;
          }
        }
        if (isCandidate(n)) {
          if (!suppressed && isDefinition(n)) {
            // 常量定义处：指向具体文件、子目录的照记（用处可能在默认参数之类认不出的位置）；值是仓根或「仓根 + 算不出」
            // 的不在这里判看不透，等用到它的地方再判（ROOT 常量本身不读任何东西）
            const vals = az.evaluate(n, c).filter((v) => {
              if (v.k === 'path') return toRel(v.p) !== '';
              if (v.k === 'part') return false;
              return v.k === 'str' || v.k === 'tail';
            });
            record(vals, n, false, false);
          } else if (!suppressed) record(az.evaluate(n, c), n, false, false);
          n.forEachChild((ch) => visit(ch, true));
          return undefined;
        }
        n.forEachChild((ch) => visit(ch, false));
        return undefined;
      };
      c.sf.forEachChild((ch) => visit(ch, false));

      // 依赖参数的路径：函数只在本文件里被直接调用（没导出、没当值传走）就按每个调用点的实参补上；否则按半截处理
      for (const [fn, uses] of deferred) {
        const callSites = callSitesOf(fn, c);
        for (const [expr, use] of uses) {
          if (callSites === undefined) {
            record(az.evaluate(expr, c), use.node, use.module, true);
            continue;
          }
          const params = (fn as unknown as { parameters: readonly Node[] }).parameters;
          for (const site of callSites) {
            const env = new Map<Node, Val[]>();
            params.forEach((p, i) => {
              const a = site.arguments[i];
              env.set(p, a === undefined ? [UNK] : az.evaluate(a, c));
            });
            record(az.evaluate(expr, c, env), use.node, use.module, true);
          }
        }
      }
      deps.set(rel, myDeps);
      dirDeps.set(rel, myDirs);
      dataDirs.set(rel, myData);
      if (myBlind.length > 0) blind.set(rel, [...new Set(myBlind)]);
    }
  });

  // vitest 的快照文件不在代码里出现，但测试会读它：<目录>/__snapshots__/<文件名>.snap
  for (const t of files) {
    if (!isTestFile(t)) continue;
    const snap = `${posix.dirname(t)}/__snapshots__/${posix.basename(t)}.snap`;
    if (files.has(snap)) deps.get(t)?.add(snap);
  }

  const graph: TestGraph = {
    files,
    sources: new Set(texts.keys()),
    tests: [...files].filter(isTestFile).sort(),
    deps,
    dirDeps,
    dataDirs,
    blind,
    importedTests,
    global: new Set(),
  };
  const global = new Set<string>();
  for (const entry of GLOBAL_ENTRIES) {
    if (!files.has(entry)) continue;
    const cl = closureOf(graph, entry);
    for (const f of cl.files) global.add(f);
  }
  return { ...graph, global };
}

/** 函数的全部调用点；函数导出了、或在本文件里被当成值用了（传走、赋值），返回 undefined。 */
function callSitesOf(fn: Node, c: FileCtx): { arguments: readonly Node[] }[] | undefined {
  let name: string | undefined;
  if (fn.kind === SyntaxKind.FunctionDeclaration) {
    if (hasExport(fn)) return undefined;
    name = nameText((fn as unknown as { name?: Node }).name);
  } else if (fn.parent?.kind === SyntaxKind.VariableDeclaration) {
    const stmt = fn.parent.parent?.parent;
    if (stmt !== undefined && hasExport(stmt)) return undefined;
    name = nameText((fn.parent as unknown as { name: Node }).name);
  }
  if (name === undefined || c.exportsLocal.has(name)) return undefined;
  const sites: { arguments: readonly Node[] }[] = [];
  let escapes = false;
  const visit = (n: Node): undefined => {
    if (escapes) return undefined;
    if (n.kind === SyntaxKind.Identifier && (n as unknown as { text: string }).text === name) {
      const p = n.parent;
      const pa = p as unknown as Record<string, unknown>;
      if (p?.kind === SyntaxKind.CallExpression && pa.expression === n)
        sites.push(p as unknown as { arguments: readonly Node[] });
      else if (
        !(
          pa.name === n &&
          (p?.kind === SyntaxKind.VariableDeclaration || p?.kind === SyntaxKind.FunctionDeclaration)
        )
      )
        escapes = true;
    }
    n.forEachChild(visit);
    return undefined;
  };
  c.sf.forEachChild(visit);
  return escapes ? undefined : sites;
}

/**
 * 一个文件（通常是测试）的传递闭包：用到的文件、它落的目录和闭包里看不透的地方。
 * code dirs（动态加载的）往下走目录里各文件的依赖；data dirs（当数据读的）只记目录本身——改目录里任何文件都算影响到它，
 * 但那些文件自己依赖什么与它无关。
 */
export function closureOf(graph: TestGraph, start: string): Closure {
  const files = new Set<string>();
  const codeDirs = new Set<string>();
  const dataDirs = new Set<string>();
  const blind: string[] = [];
  const todo = [start];
  const sortedFiles = [...graph.files].sort();
  const isTest = new Set(graph.tests);
  while (todo.length > 0) {
    const f = todo.pop() as string;
    if (files.has(f)) continue;
    files.add(f);
    // 别的测试文件在路径字符串里出现（扫描、点名）只是当文本读，不会被执行：不往下走它的依赖和看不透
    if (f !== start && isTest.has(f) && !graph.importedTests.has(f)) continue;
    for (const b of graph.blind.get(f) ?? []) blind.push(`${f} ${b}`);
    for (const d of graph.deps.get(f) ?? []) if (!files.has(d)) todo.push(d);
    for (const d of graph.dirDeps.get(f) ?? []) {
      if (codeDirs.has(d)) continue;
      codeDirs.add(d);
      // 测试文件只由 vitest 跑，不会被别的代码当模块加载：动态加载的目录里碰到测试文件不往下走
      for (const g of filesUnder(sortedFiles, d)) if (!isTest.has(g) && !files.has(g)) todo.push(g);
    }
    for (const d of graph.dataDirs.get(f) ?? []) dataDirs.add(d);
  }
  return { files, codeDirs, dataDirs, blind };
}

/** 改了 f，这个闭包受不受影响（目录边：数据目录里任何文件都算；代码目录里的测试文件不算）。 */
export function closureHits(cl: Closure, f: string): boolean {
  return cl.files.has(f) || under(f, cl.dataDirs) || (!isTestFile(f) && under(f, cl.codeDirs));
}

/** 从 start 走到 target 的一条最短链（每一步是文件，经目录的写成「目录/」）；走不到返回 undefined。给日志、排查用。 */
export function explainPath(graph: TestGraph, start: string, target: string): string[] | undefined {
  const sortedFiles = [...graph.files].sort();
  const isTest = new Set(graph.tests);
  const prev = new Map<string, { from: string; via?: string }>();
  const seen = new Set([start]);
  const queue = [start];
  const chainTo = (f: string): string[] => {
    const chain = [f];
    for (let p = prev.get(f); p !== undefined; p = prev.get(p.from)) {
      if (p.via !== undefined) chain.unshift(`${p.via}/`);
      chain.unshift(p.from);
    }
    return chain;
  };
  while (queue.length > 0) {
    const f = queue.shift() as string;
    if (f === target) return chainTo(f);
    const nexts: [string, string | undefined][] = [];
    for (const d of graph.deps.get(f) ?? []) nexts.push([d, undefined]);
    for (const d of graph.dirDeps.get(f) ?? []) {
      if (target.startsWith(`${d}/`) && !graph.files.has(target)) return [...chainTo(f), `${d}/`];
      for (const g of filesUnder(sortedFiles, d)) if (!isTest.has(g)) nexts.push([g, d]);
    }
    for (const [n, via] of nexts) {
      if (seen.has(n)) continue;
      seen.add(n);
      prev.set(n, via === undefined ? { from: f } : { from: f, via });
      queue.push(n);
    }
  }
  return undefined;
}

function filesUnder(sorted: readonly string[], dir: string): string[] {
  const prefix = `${dir}/`;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] as string) < prefix) lo = mid + 1;
    else hi = mid;
  }
  const out: string[] = [];
  for (let i = lo; i < sorted.length && (sorted[i] as string).startsWith(prefix); i++)
    out.push(sorted[i] as string);
  return out;
}

const under = (f: string, dirs: Iterable<string>) => {
  for (const d of dirs) if (f === d || f.startsWith(`${d}/`)) return true;
  return false;
};

export interface SelectInput {
  /** 这次改了的文件，仓内相对路径（含删掉的）。空列表抛错：认不出改了什么不能当没改。 */
  changed: readonly string[];
  repo: RepoView;
  /** 已经建好的图（同一棵树上算多次时复用）；不给就现建。 */
  graph?: TestGraph;
  /** 建图用的文件清单（git ls-files）；给了 graph 时不用。 */
  files?: readonly string[];
}

/** 一个改动文件在图上的去处。resolved：图替它做主（选中的测试就是全部）；unresolved：交回调用方；runAll：全跑。 */
export type ChangeKind =
  | { kind: 'resolved'; why: string }
  | { kind: 'unresolved'; why: string }
  | { kind: 'runAll'; why: string };

/** 判一个改动文件归哪一类（selectTests 和 test-graph-audit.ts 共用：核对时漏边只在 resolved 的文件上才真会选漏）。 */
export function classifyChange(graph: TestGraph, f: string, index = changeIndex(graph)): ChangeKind {
  const known = index.referenced.has(f) || under(f, index.dirs);
  if (graph.global.has(f)) return { kind: 'runAll', why: 'vitest 配置会加载它，所有测试都受影响' };
  // 管「测试怎么跑、模块怎么解析」的配置：就算有测试把它当数据读，改它的影响也不止这些测试
  if (HAND_BACK.test(f) || ROOT_CONFIG_FILES.includes(f))
    return { kind: 'unresolved', why: '配置（依赖、模块解析、CI、测试运行方式），交回现有规则' };
  if (graph.sources.has(f) && (isTestFile(f) || known)) return { kind: 'resolved', why: '源文件' };
  if (graph.sources.has(f))
    return { kind: 'unresolved', why: '源文件没有任何文件引用（新文件，或只被脚本、配置调用的入口）' };
  if (graph.files.has(f) && known && DATA_EXT.test(f)) return { kind: 'resolved', why: '数据文件' };
  if (graph.files.has(f) && known)
    return { kind: 'unresolved', why: '不是解析过的源文件（脚本之类），可能再引别的文件' };
  return {
    kind: 'unresolved',
    why: graph.files.has(f) ? '没有源文件用到它（文档、配置……）' : '图里没有这个文件（删掉的、图外路径）',
  };
}

export interface ChangeIndex {
  referenced: ReadonlySet<string>;
  dirs: ReadonlySet<string>;
}

export function changeIndex(graph: TestGraph): ChangeIndex {
  const referenced = new Set<string>();
  for (const ds of graph.deps.values()) for (const d of ds) referenced.add(d);
  const dirs = new Set<string>();
  for (const ds of graph.dirDeps.values()) for (const d of ds) dirs.add(d);
  for (const ds of graph.dataDirs.values()) for (const d of ds) dirs.add(d);
  return { referenced, dirs };
}

/** 算这次改动必须跑的测试文件。语义见 TestSelection；建图失败抛 TestGraphError。 */
export function selectTests({ changed, repo, graph: given, files }: SelectInput): TestSelection {
  if (changed.length === 0) throw new TestGraphError('改动列表是空的：认不出这次改了什么');
  const graph = given ?? buildTestGraph(repo, files === undefined ? {} : { files });
  const closures = new Map(graph.tests.map((t) => [t, closureOf(graph, t)] as const));
  const index = changeIndex(graph);

  const tests = new Set<string>();
  const unresolved: TestSelection['unresolved'] = [];
  const runAll: TestSelection['runAll'] = [];
  const notes: string[] = [];
  for (const f of changed) {
    const hits = graph.tests.filter((t) => closureHits(closures.get(t) as Closure, f));
    for (const t of hits) tests.add(t);
    const c = classifyChange(graph, f, index);
    if (c.kind === 'runAll') runAll.push({ file: f, why: c.why });
    if (c.kind === 'unresolved') unresolved.push({ file: f, why: c.why });
    const tail =
      c.kind === 'resolved'
        ? `${hits.length} 个测试用到它`
        : `交回：${c.why}（另有 ${hits.length} 个测试直接用到它）`;
    notes.push(
      `${f}：${c.kind === 'runAll' ? `全跑（${c.why}）` : `${c.why === '源文件' || c.why === '数据文件' ? c.why : ''}${tail}`}`,
    );
  }
  const opaque = graph.tests
    .map((t) => ({ test: t, why: (closures.get(t) as Closure).blind }))
    .filter((o) => o.why.length > 0);
  return { tests: [...tests].sort(), unresolved, opaque, runAll, notes };
}
