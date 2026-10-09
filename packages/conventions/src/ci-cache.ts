// PR 的测试结果缓存（.github/workflows/ci.yml 的 test job，入口 bin/ci-cache.ts）：同一个 PR 重推时，
// 一台测试（test-split.ts 装好的箱，矩阵里给的是明确的文件清单）的输入没变、上一轮又全绿，就不再跑 vitest。
// 缓存粒度是整台的输入（键），命中后再逐文件核对哈希；不按 import 图做按文件的键：test-changed.ts 开头注释记着那两个坑
// （vitest --changed 基准读不到不报错、引擎工作流测试走路径打的包不在 import 图里）。
// 装箱是确定的：同一个 PR 重推、选中的单元没变，每台分到的文件就一样，键才对得上；选中的单元变了、台重新分了，就全跑一轮。
// 改这里之前必须知道：
// - GitHub 的缓存按 ref 分作用域：pull_request 跑出来的缓存只有这个 PR 自己的重跑读得到，别的 PR、main 都读不到。
//   所以只在 PR 的 test job 上做；主线（push）那一轮是自动发布的闸门（deploy/france/auto-release/lib.mjs 认它的结论），
//   不靠这个缓存跳测试——每一步都先认事件名（PR_EVENT），不是 pull_request 一律「全跑、不写」，工作流里的 if 丢了也一样。
//   （主线能不重测只有一条路：同树复用一次成功的 PR 检查，见 main-reuse.ts，由那次 PR 真跑过背书，不是缓存。）
// - 这里判「少跑」等于放行没测过的改动，改它要连测试一起看。
// - 三态纪律（假绿的防线，缺一不可）：读不出、不是 JSON、字段认不全、schema 版本不对、缓存读不到、哈希对不上、
//   这一台的文件清单认不出——一律回来真跑，绝不当成「都跑过了」。只在整台全绿的那一轮写清单；命中后不信键，把清单里每个文件的哈希
//   重算比对；拿「分到这一台的文件」当全集再减去已覆盖的（新增的测试文件必须跑）。跑完 ci-box.ts 再核对一遍
//   「盖住的 + 实际跑的 == 分到的」，对不上 job 红。
// - 键要盖住测试读的一切：这一台的文件清单、被测单元整棵源码、向下依赖闭包、TEST_READS、根配置和包外读的文件、夹具、
//   这一台的测试文件内容、环境身份（node、系统、vitest 版本、有没有真 Postgres、Temporal 命令行版本、日期）、本文件的 CACHE_SCHEMA。
//   test/ci-plan.test.ts 从扫描器反推「测试读的包外文件」，漏盖一处就红；键怎么算改了（多盖少盖）要升 CACHE_SCHEMA。
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENTS_UNIT, FIXTURE_PATH, type PackageGraph, ROOT_CONFIG_FILES, TEST_READS } from './ci-plan.ts';
import { isTestFile, unitOfTestFile, withSiblings } from './test-split.ts';

/** 键和清单的格式版本：算键的办法、清单的字段一变就加一，旧缓存自然读不到、也不会被当成清单。
 * 2：分台从「包目录 + --shard」换成明确的文件清单（键里的 args 换成 box，清单、交接文件同改）。 */
export const CACHE_SCHEMA = 3;
/** 只有 pull_request 才缓存。 */
export const PR_EVENT = 'pull_request';
/** 缓存目录名（放在 $RUNNER_TEMP 下；ci.yml 的 restore/save 用同一个名字）。 */
export const CACHE_SUBDIR = 'fleet-test-cache';
export const MANIFEST_FILE = 'manifest.json';

export class CacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CacheError';
  }
}

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const SHA = /^[0-9a-f]{64}$/;

// ---- 读盘：整棵树的哈希

export interface HashFs {
  /** 文件的原始字节；不存在返回 undefined，读不了（权限等）抛。 */
  bytes(rel: string): Uint8Array | undefined;
  /** 列目录（'' 是仓根）；不是目录、不存在返回 undefined，列不了（权限等）抛。 */
  list(rel: string): string[] | undefined;
}

/** 不进哈希的目录：和 .gitignore 里忽略的生成物、本机工具目录同一批（被忽略的东西进不了 CI 的检出，也不是测试的输入）。 */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'coverage',
  '_tmp',
  '.git',
  '.mirasim',
  '.codegraph',
  '.playwright-mcp',
]);

export function makeHasher(fs: HashFs) {
  const fileMemo = new Map<string, string>();
  const listMemo = new Map<string, string[] | undefined>();

  function file(rel: string): string {
    const hit = fileMemo.get(rel);
    if (hit !== undefined) return hit;
    const b = fs.bytes(rel);
    if (b === undefined) throw new CacheError(`读不到 ${rel}（列出来了、读时没了）`);
    const h = sha256(b);
    fileMemo.set(rel, h);
    return h;
  }

  /** rel 下所有文件（递归、排好序、跳过 SKIP_DIRS）；rel 不是目录返回 undefined。 */
  function filesUnder(rel: string): string[] | undefined {
    if (listMemo.has(rel)) return listMemo.get(rel);
    const names = fs.list(rel);
    if (names === undefined) {
      listMemo.set(rel, undefined);
      return undefined;
    }
    const out: string[] = [];
    for (const name of [...names].sort()) {
      if (SKIP_DIRS.has(name) || name.endsWith('.tsbuildinfo')) continue;
      const child = rel === '' ? name : `${rel}/${name}`;
      const sub = filesUnder(child);
      if (sub === undefined) out.push(child);
      else out.push(...sub);
    }
    listMemo.set(rel, out);
    return out;
  }

  const digestOf = (paths: readonly string[]) => sha256(paths.map((p) => `${p}\0${file(p)}`).join('\n'));

  return {
    file,
    filesUnder,
    digestOf,
    /** 一个文件或一整棵目录的摘要；不存在记成 absent（真的不存在，不是读不了：读不了会抛）。 */
    tree(rel: string): string {
      const under = filesUnder(rel);
      if (under !== undefined) return digestOf(under);
      const b = fs.bytes(rel);
      return b === undefined ? 'absent' : `file:${sha256(b)}`;
    },
  };
}

/** 真读盘。ENOENT、ENOTDIR 当不存在，别的错照抛（不拿「读不了」冒充「没有」）。 */
export function fsHashFs(root: string): HashFs {
  const abs = (rel: string) => join(root, ...rel.split('/').filter(Boolean));
  const absent = (e: unknown) => {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  };
  return {
    bytes(rel) {
      try {
        return readFileSync(abs(rel));
      } catch (e) {
        if (absent(e) || (e as NodeJS.ErrnoException).code === 'EISDIR') return undefined;
        throw e;
      }
    },
    list(rel) {
      try {
        return readdirSync(abs(rel));
      } catch (e) {
        if (absent(e)) return undefined;
        throw e;
      }
    },
  };
}

// ---- 这一台的文件清单 → 单元 → 闭包

/**
 * 这一台跑的文件清单（ci.yml 矩阵里的 files，一行一个交给 vitest）。认不出的不猜：抛 CacheError，调用方全跑。
 * 不是测试文件、空的、重复的都算认不出——清单是 ci-box.ts 解析过的，这里再核一遍，防的是工作流被改坏。
 */
export function boxUnits(files: readonly string[]): string[] {
  if (files.length === 0) throw new CacheError('这一台一个测试文件都没有');
  const units = new Set<string>();
  const seen = new Set<string>();
  for (const f of files) {
    if (!isTestFile(f)) throw new CacheError(`认不出的测试文件：${f}`);
    if (seen.has(f)) throw new CacheError(`清单里 ${f} 出现了两次`);
    seen.add(f);
    const u = unitOfTestFile(f);
    if (u === undefined) throw new CacheError(`认不出 ${f} 属于哪个单元`);
    units.add(u);
  }
  return [...units].sort();
}

/** 这一台的文件，加上按名字会被过滤一起拉上的别的测试文件（vitest 是子串过滤，见 test-split.ts 的 withSiblings）。排好序。 */
export function boxFiles(files: readonly string[], universe: readonly string[]): string[] {
  return withSiblings(files, universe);
}

/** start 自己加上它们直接间接依赖的包（向下）。 */
export function downwardClosure(graph: PackageGraph, start: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const todo = [...start];
  while (todo.length > 0) {
    const u = todo.pop() as string;
    if (seen.has(u)) continue;
    seen.add(u);
    todo.push(...(graph.deps[u] ?? []));
  }
  return seen;
}

/**
 * 改了就让所有测试都得跑的包：ci-plan.ts 的 PATH_RULES 把 packages/shared/ 判成全跑（几乎所有包依赖它，
 * agents/test/france.test.ts 这类不在依赖图里的测试也直接读它的源码）。键里每一组都带上它；
 * test/ci-cache.test.ts 核对 PATH_RULES 里这条还在。
 */
export const UNIVERSAL_PACKAGES: readonly string[] = ['shared'];

/**
 * 键要盖住源码的包：这一组的单元 + 它们向下的依赖闭包 + TEST_READS 里读的包（连同它们的闭包：被读的包自己 import 的也算）
 * + UNIVERSAL_PACKAGES。TEST_READS 只对这一组自己的单元生效，不顺着依赖往下传（和 ci-plan.ts 一样：依赖读的那个包的，
 * 并不读被读的文件）。
 */
export function sourceClosure(graph: PackageGraph, units: readonly string[]): string[] {
  const start = new Set([...units, ...UNIVERSAL_PACKAGES]);
  for (const u of units) for (const r of TEST_READS[u] ?? []) start.add(r);
  const packages = [
    ...downwardClosure(
      graph,
      [...start].filter((u) => u !== AGENTS_UNIT),
    ),
  ];
  return packages.sort();
}

// ---- 键的输入

/** 测试读的包外文件（单个）；根配置那份和 ci-plan.ts 的 PATH_RULES 共用 ROOT_CONFIG_FILES。 */
export const EXTERNAL_INPUT_FILES: readonly string[] = [
  ...ROOT_CONFIG_FILES,
  'AGENTS.md',
  'docs/ops.md',
  // 决定 0035 的钉子测试读它（PATH_RULES 里同一道门）
  'docs/decisions/0035-haiku55-by-checkable-output.md',
  '.github/pull_request_template.md',
  '.gitignore',
  '.claude/settings.json',
];
/** 测试读的包外目录（整棵）：CI 工作流、装机脚本、agents（skill 和调工具前的钩子）、推前钩子。 */
export const EXTERNAL_INPUT_DIRS: readonly string[] = ['.github/workflows', 'deploy', 'agents', '.githooks'];

/**
 * 测试会通读「所有包的测试源码、package.json」的单元：ci-plan.test.ts 的扫描器遍历每个包的 test/ 和 src 里的测试文件，
 * 别的包加一个读包外文件的测试，它就该红——这一组的键得盖住全仓的测试文件，不然只改了别的包的测试时命中、扫描器那条被跳过。
 */
export const WHOLE_REPO_READERS: readonly string[] = ['conventions'];

/** 全仓测试源码（含 agents/test）和各包的 package.json。 */
export function isWholeRepoInput(path: string): boolean {
  if (/^packages\/[^/]+\/package\.json$/.test(path)) return true;
  if (!/\.(?:ts|tsx|mts|mjs)$/.test(path)) return false;
  if (!(path.startsWith('packages/') || path.startsWith('agents/test/'))) return false;
  return /(?:^|\/)test\//.test(path) || /\.test\.tsx?$/.test(path);
}

export interface EnvIdentity {
  /** 整串 process.version（含补丁号：测试在不同补丁版本上可能不同）。 */
  node: string;
  platform: string;
  /** 运行机镜像版本（GitHub 的 ImageVersion）；没有就空。 */
  image: string;
  vitest: string;
  /** 有没有真 Postgres（FLEET_TEST_PG_URL 非空）：db 的 real-pg 测试只在有时才跑。 */
  pg: boolean;
  /** Temporal 命令行：没起是 none；起了是「版本 校验和」，再加 FLEET_TEST_TEMPORAL_CLI 有没有交给测试。 */
  temporal: string;
  /** UTC 日期：有的测试跟「今天」有关（到期日之类），隔天不沿用。 */
  day: string;
}

export function buildEnvIdentity(input: {
  nodeVersion: string;
  platform: string;
  arch: string;
  env: Readonly<Record<string, string | undefined>>;
  vitestVersion: string;
  temporalLabel: string;
  now: Date;
}): EnvIdentity {
  const cli = input.env.FLEET_TEST_TEMPORAL_CLI?.trim() ? 'cli' : 'no-cli';
  return {
    node: input.nodeVersion,
    platform: `${input.platform}-${input.arch}`,
    image: input.env.ImageVersion?.trim() ?? '',
    vitest: input.vitestVersion,
    pg: Boolean(input.env.FLEET_TEST_PG_URL?.trim()),
    temporal: `${cli}:${input.temporalLabel.trim() || 'none'}`,
    day: input.now.toISOString().slice(0, 10),
  };
}

/** node_modules/vitest/package.json 的版本；读不出抛（环境身份少一块就不缓存）。 */
export function vitestVersion(fs: HashFs): string {
  const b = fs.bytes('node_modules/vitest/package.json');
  if (b === undefined) throw new CacheError('读不到 node_modules/vitest/package.json：认不出 vitest 版本');
  let v: unknown;
  try {
    v = (JSON.parse(Buffer.from(b).toString('utf8')) as { version?: unknown }).version;
  } catch {
    throw new CacheError('node_modules/vitest/package.json 不是 JSON');
  }
  if (typeof v !== 'string' || v === '') throw new CacheError('vitest 的 package.json 里没有 version');
  return v;
}

/** 一组测试的键盖住哪些东西（computeKey 照它算；test/ci-plan.test.ts 拿它核对扫描器扫出的包外读取）。 */
export interface KeyRoots {
  /** 要哈希整棵源码的包目录：packages/<包>。 */
  packages: string[];
  files: string[];
  dirs: string[];
  /** 所有包的测试夹具（FIXTURE_PATH）。 */
  fixtures: boolean;
  /** 全仓测试源码、package.json（isWholeRepoInput）。 */
  wholeRepoTests: boolean;
}

export function keyRoots(units: readonly string[], closure: readonly string[]): KeyRoots {
  return {
    packages: closure.map((p) => `packages/${p}`),
    files: [...EXTERNAL_INPUT_FILES],
    dirs: [...EXTERNAL_INPUT_DIRS],
    fixtures: true,
    wholeRepoTests: units.some((u) => WHOLE_REPO_READERS.includes(u)),
  };
}

/** 仓内这个路径（文件，或目录）改了，会不会让这组测试的键变。 */
export function keyCovers(roots: KeyRoots, path: string): boolean {
  const under = (d: string) => path === d || path.startsWith(`${d}/`);
  if (roots.files.includes(path) || roots.dirs.some(under) || roots.packages.some(under)) return true;
  if (roots.fixtures && (FIXTURE_PATH.test(path) || FIXTURE_PATH.test(`${path}/x`))) return true;
  return roots.wholeRepoTests && isWholeRepoInput(path);
}

export interface KeyInput {
  fs: HashFs;
  graph: PackageGraph;
  /** 这一台分到的测试文件（矩阵里的 files；里面每个都要在依赖图里有单元）。 */
  box: readonly string[];
  env: EnvIdentity;
}

/** 单元都在依赖图里、且有测试文件的那些文件；认不出抛（调用方全跑，不拿半份清单算键）。 */
export function checkedFiles(graph: PackageGraph, files: readonly string[]): string[] {
  const known = new Set([...Object.keys(graph.deps), AGENTS_UNIT]);
  boxUnits(files);
  for (const f of files) {
    const u = unitOfTestFile(f) as string;
    if (!known.has(u)) throw new CacheError(`依赖图里没有这个单元：${u}（${f}）`);
  }
  return [...files].sort();
}

export interface KeyResult {
  /** 整个输入的 sha256。 */
  key: string;
  /** 各块输入各自的摘要（打出来给人看：键变了是哪一块变的）。 */
  parts: Record<string, string>;
  units: string[];
  closure: string[];
  /** 这一台每个测试文件的内容哈希。 */
  collected: Record<string, string>;
}

/** 各块摘要合成一个键（每一块——含 schema——变一个字，键都变）。 */
export function keyFromParts(parts: Readonly<Record<string, string>>): string {
  return sha256(JSON.stringify(Object.entries(parts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}

export function computeKey(input: KeyInput): KeyResult {
  const { fs, graph, box, env } = input;
  const files = checkedFiles(graph, box);
  const units = boxUnits(files);
  const closure = sourceClosure(graph, units);
  const roots = keyRoots(units, closure);
  const h = makeHasher(fs);
  const parts: Record<string, string> = {
    schema: String(CACHE_SCHEMA),
    box: sha256(JSON.stringify(files)),
    env: sha256(JSON.stringify(env)),
  };
  for (const p of roots.packages) parts[`pkg:${p}`] = h.tree(p);
  for (const f of roots.files) parts[`file:${f}`] = h.tree(f);
  for (const d of roots.dirs) parts[`dir:${d}`] = h.tree(d);
  const everything = [...(h.filesUnder('packages') ?? []), ...(h.filesUnder('agents/test') ?? [])];
  if (roots.fixtures) parts.fixtures = h.digestOf(everything.filter((p) => FIXTURE_PATH.test(p)));
  if (roots.wholeRepoTests) parts.wholeRepoTests = h.digestOf(everything.filter(isWholeRepoInput));
  const collected: Record<string, string> = {};
  for (const f of files) collected[f] = h.file(f);
  parts.collected = sha256(JSON.stringify(collected));
  return { key: keyFromParts(parts), parts, units, closure, collected };
}

// ---- 清单

export interface Manifest {
  schema: number;
  complete: true;
  key: string;
  /** 这一台分到的测试文件（矩阵里那一份，排好序）。 */
  box: string[];
  files: Record<string, { sha: string; status: 'passed' }>;
}

/** 读清单；认不出返回一句为什么（调用方全跑）。认的只有：JSON、schema 对、complete 是 true、字段认全、每个文件有哈希和 passed。 */
export function parseManifest(text: string): Manifest | string {
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch {
    return '清单不是 JSON';
  }
  const o = m as Partial<Manifest> | null;
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return '清单不是对象';
  if (o.schema !== CACHE_SCHEMA) return `清单的 schema 是 ${String(o.schema)}，要 ${CACHE_SCHEMA}`;
  if (o.complete !== true) return '清单没标 complete（上一轮没跑完、没全绿）';
  if (typeof o.key !== 'string' || !SHA.test(o.key)) return '清单里没有键';
  if (!Array.isArray(o.box) || o.box.length === 0 || o.box.some((a) => typeof a !== 'string'))
    return '清单里的文件清单认不出';
  const files = o.files;
  if (typeof files !== 'object' || files === null || Array.isArray(files)) return '清单里没有文件表';
  const entries = Object.entries(files as Record<string, unknown>);
  if (entries.length === 0) return '清单里一个文件都没有';
  for (const [f, e] of entries) {
    const x = e as { sha?: unknown; status?: unknown } | null;
    if (typeof x !== 'object' || x === null || typeof x.sha !== 'string' || !SHA.test(x.sha)) {
      return `清单里 ${f} 没有哈希`;
    }
    if (x.status !== 'passed') return `清单里 ${f} 没标跑成（${String(x.status)}）`;
  }
  return o as Manifest;
}

export type Mode = 'all' | 'files' | 'none';

export interface Selection {
  mode: Mode;
  /** files 模式要跑的文件；all 是全部收到的，none 是空。 */
  run: string[];
  /** 清单里核对过、不用再跑的文件。 */
  covered: string[];
  why: string;
}

/**
 * 命中之后怎么选：不信键，拿这一台分到的文件当全集，减去「清单里有、标了 passed、内容哈希和现在一样」的。
 * 清单读不出、键对不上、文件清单对不上，全跑；一个文件都盖不住也全跑。盖得住全部才 none。
 */
export function selectToRun(input: {
  collected: Readonly<Record<string, string>>;
  key: string;
  box: readonly string[];
  manifestText: string | undefined;
}): Selection {
  const all = Object.keys(input.collected).sort();
  const full = (why: string): Selection => ({ mode: 'all', run: all, covered: [], why });
  if (all.length === 0) return full('vitest 一个测试文件都没收到：全跑');
  if (input.manifestText === undefined) return full('缓存没命中（没有清单）：全跑');
  const m = parseManifest(input.manifestText);
  if (typeof m === 'string') return full(`${m}：全跑，不信这份缓存`);
  if (m.key !== input.key) return full('清单里的键和这次算出来的不一样：全跑，不信这份缓存');
  if (JSON.stringify(m.box) !== JSON.stringify([...input.box].sort()))
    return full('清单里的文件清单和这一台分到的不一样：全跑');
  const covered: string[] = [];
  const run: string[] = [];
  const changed: string[] = [];
  for (const f of all) {
    const e = m.files[f];
    if (e === undefined) run.push(f);
    else if (e.sha === input.collected[f]) covered.push(f);
    else {
      run.push(f);
      changed.push(f);
    }
  }
  if (covered.length === 0) return full('清单里没有一个文件能对上：全跑');
  const note = changed.length > 0 ? `（${changed.length} 个文件的哈希对不上，重跑）` : '';
  if (run.length === 0)
    return { mode: 'none', run: [], covered, why: `缓存命中，${covered.length} 个文件都核对过：不跑` };
  return {
    mode: 'files',
    run,
    covered,
    why: `清单盖住 ${covered.length} 个，其余 ${run.length} 个要跑${note}`,
  };
}

// ---- 一轮里三步之间的交接（key → plan → record）

export interface State {
  schema: number;
  key: string;
  /** 这一台分到的文件（collected 的键就是它们；装箱是确定的，重推时是同一份）。 */
  box: string[];
  /** 这一台分到的文件 → 内容哈希。 */
  collected: Record<string, string>;
  mode: Mode;
  covered: string[];
  run: string[];
}

export function parseState(text: string | undefined): State | string {
  if (text === undefined) return '没有交接文件（key 那一步没成）';
  let s: unknown;
  try {
    s = JSON.parse(text);
  } catch {
    return '交接文件不是 JSON';
  }
  const o = s as Partial<State> | null;
  if (typeof o !== 'object' || o === null) return '交接文件不是对象';
  const strs = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  if (
    o.schema !== CACHE_SCHEMA ||
    typeof o.key !== 'string' ||
    !SHA.test(o.key) ||
    !strs(o.box) ||
    typeof o.collected !== 'object' ||
    o.collected === null ||
    Object.values(o.collected).some((v) => typeof v !== 'string' || !SHA.test(v)) ||
    !(o.mode === 'all' || o.mode === 'files' || o.mode === 'none') ||
    !strs(o.covered) ||
    !strs(o.run)
  ) {
    return '交接文件的字段认不全';
  }
  return o as State;
}

const notPr = (event: string) =>
  `${event} 事件：不缓存，测试全跑（缓存只给 pull_request；主线是自动发布的闸门）`;

export type KeyStep =
  | { enabled: false; why: string }
  | { enabled: true; cacheKey: string; key: string; parts: Record<string, string>; state: State };

/** 第一步：算键，记下这一台分到的文件。算不出一律 enabled:false（不缓存、全跑）。 */
export function stepKey(input: {
  event: string;
  box: readonly string[];
  label: string;
  fs: HashFs;
  graph: PackageGraph | string;
  env: () => EnvIdentity;
}): KeyStep {
  if (input.event !== PR_EVENT) return { enabled: false, why: notPr(input.event) };
  if (typeof input.graph === 'string')
    return { enabled: false, why: `包依赖图读不出（${input.graph}）：全跑` };
  try {
    const r = computeKey({ fs: input.fs, graph: input.graph, box: input.box, env: input.env() });
    const slug =
      input.label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'box';
    return {
      enabled: true,
      cacheKey: `ci-test-v${CACHE_SCHEMA}-${slug}-${r.key}`,
      key: r.key,
      parts: r.parts,
      state: {
        schema: CACHE_SCHEMA,
        key: r.key,
        box: checkedFiles(input.graph, input.box),
        collected: r.collected,
        mode: 'all',
        covered: [],
        run: Object.keys(r.collected).sort(),
      },
    };
  } catch (e) {
    if (e instanceof CacheError) return { enabled: false, why: `${e.message}：不缓存，全跑` };
    throw e;
  }
}

export type PlanStep = { mode: Mode; why: string; run: string[]; state: State | undefined };

/**
 * 第二步：restore 之后，读清单、核对、算这次该跑哪些。任何一环对不上都是 all。
 * files 模式跑的就是清单没盖住的那几个文件本身（是这一台分到的），不再交给 vitest 按名字过滤——跑完 ci-box.ts 会核对
 * 「盖住的 + 真跑的 == 分到的」（vitest 是子串过滤，多拉上谁只有跑完才看得出）。
 */
export function stepPlan(input: {
  event: string;
  stateText: string | undefined;
  manifestText: string | undefined;
}): PlanStep {
  if (input.event !== PR_EVENT) return { mode: 'all', why: notPr(input.event), run: [], state: undefined };
  const state = parseState(input.stateText);
  if (typeof state === 'string') return { mode: 'all', why: `${state}：全跑`, run: [], state: undefined };
  const sel = selectToRun({
    collected: state.collected,
    key: state.key,
    box: state.box,
    manifestText: input.manifestText,
  });
  const { mode, run, covered, why } = sel;
  return { mode, why, run, state: { ...state, mode, covered, run } };
}

/**
 * 从 vitest 的 JSON 报告里认出：这一轮报告里出现了哪些文件（reported），其中哪些跑成了（passed：状态 passed 且至少一条用例真跑过）。
 * 报告本身不对（没成功、有失败、认不出）返回一句为什么。
 */
export function passedFiles(
  reportText: string | undefined,
  root: string,
): { passed: Set<string>; reported: Set<string> } | string {
  if (reportText === undefined) return '没有 vitest 的 JSON 报告';
  let r: unknown;
  try {
    r = JSON.parse(reportText);
  } catch {
    return 'vitest 的报告不是 JSON';
  }
  const o = r as {
    success?: unknown;
    numFailedTests?: unknown;
    numFailedTestSuites?: unknown;
    testResults?: unknown;
  } | null;
  if (typeof o !== 'object' || o === null || !Array.isArray(o.testResults))
    return 'vitest 的报告里没有 testResults';
  if (o.success !== true || o.numFailedTests !== 0 || o.numFailedTestSuites !== 0) {
    return 'vitest 的报告不是全绿（success 不是 true、或有失败）';
  }
  const passed = new Set<string>();
  const reported = new Set<string>();
  for (const t of o.testResults as { name?: unknown; status?: unknown; assertionResults?: unknown }[]) {
    if (typeof t?.name !== 'string' || typeof t.status !== 'string' || !Array.isArray(t.assertionResults)) {
      return 'vitest 的报告里有一条认不出';
    }
    const rel = relativeToRoot(root, t.name);
    if (rel === undefined) continue;
    reported.add(rel);
    const ran = (t.assertionResults as { status?: unknown }[]).some((a) => a?.status === 'passed');
    if (t.status === 'passed' && ran) passed.add(rel);
  }
  return { passed, reported };
}

/** 绝对路径转成仓内相对路径（/ 分隔）；不在仓里返回 undefined。 */
export function relativeToRoot(root: string, p: string): string | undefined {
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const q = p.replace(/\\/g, '/');
  return q.startsWith(`${r}/`) ? q.slice(r.length + 1) : undefined;
}

export type RecordStep = { manifest: Manifest } | { why: string };

/**
 * 第三步：vitest 全绿之后写清单。收到的每个文件，要么是第二步核对过的（covered），要么这一轮在报告里标了 passed——
 * 少一个都不写（不标 complete、不写文件，下一轮照样全跑）。
 */
export function stepRecord(input: {
  event: string;
  stateText: string | undefined;
  reportText: string | undefined;
  root: string;
}): RecordStep {
  if (input.event !== PR_EVENT) return { why: notPr(input.event) };
  const state = parseState(input.stateText);
  if (typeof state === 'string') return { why: `${state}：不写清单` };
  if (state.mode === 'none') return { why: '这一轮一个测试都没跑（全部命中）：不用写清单' };
  const report = passedFiles(input.reportText, input.root);
  if (typeof report === 'string') return { why: `${report}：不写清单` };
  const { passed, reported } = report;
  const covered = new Set(state.covered);
  const run = new Set(state.run);
  // 报告里实际跑的文件必须正好是这一轮该跑的：多了少了都说明 vitest 实际做的和清单对不上，不写
  const off =
    [...run].filter((f) => !reported.has(f)).length + [...reported].filter((f) => !run.has(f)).length;
  if (off > 0) {
    return { why: `vitest 实际跑的文件和这一台该跑的对不上（差 ${off} 个）：不写清单` };
  }
  const files: Manifest['files'] = {};
  const missing: string[] = [];
  for (const [f, sha] of Object.entries(state.collected)) {
    if (covered.has(f) || (run.has(f) && passed.has(f))) files[f] = { sha, status: 'passed' };
    else missing.push(f);
  }
  if (missing.length > 0) {
    return {
      why: `${missing.length} 个文件没有跑成的记录（${missing.slice(0, 3).join('、')}${missing.length > 3 ? '……' : ''}）：不写清单`,
    };
  }
  return { manifest: { schema: CACHE_SCHEMA, complete: true, key: state.key, box: state.box, files } };
}
