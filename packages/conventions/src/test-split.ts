// CI 的测试怎么分台（.github/workflows/ci.yml 的 test job）：一个池子、按耗时装箱、台数按工作量定（业界叫 split by timings）。
// changes job 不装依赖，所以测试文件由这里按 TEST_INCLUDE 自己枚举（vitest.config.ts 的 include 就取这一份）；
// 按仓里的耗时表（test-timings.json）用「最长的先放、放进当前最空的那台」（LPT）装进 k 台，每台拿到一份明确的文件清单。
// 改这里之前必须知道：
// - 耗时表只影响分得匀不匀，绝不影响跑不跑：表里没有的文件按中位数估，表读不出就每个文件按 FALLBACK_FILE_MS 估——
//   照样每个文件都分到一台。CI 的判定只看检出来的文件（#299），所以表进仓、不在 CI 里现读 GitHub；`pnpm ci:timings` 刷新它。
// - vitest 的位置参数是子串过滤（`a.test.ts` 也会拉上 `a.test.tsx`）：名字被别的测试文件「包含」的，两个必须同一台
//   （withSiblings / 装箱时并成一件）。每台跑完还要拿 JSON 报告核对「实际跑的 == 分到的」（ci-box.ts），不等就红。
// - 环境类和能力是两回事：FLEET_TEST_PG_URL 一设，这个进程里所有 createTestDb 都连真 Postgres（packages/db/src/testing.ts）；
//   db 以外的测试在 CI 上一直是 PGlite 跑的，所以 db 的测试单独装台（pg 台），不和别的混在一个 vitest 进程里。
//   Temporal 命令行只是多装一个程序、不改别的测试的行为，哪台装进了要它的文件哪台就装（可以混）。
// - 枚举、选择、装箱都是纯函数、结果排好序：同一份检出、同一份改动，什么时候算都一样。
import type { RepoView } from './repo.ts';

/** vitest 收哪些测试文件（vitest.config.ts 的 include 取的就是这一份）。只用到 `*`、`**`、`{a,b}` 三种写法。 */
export const TEST_INCLUDE: readonly string[] = [
  'packages/*/src/**/*.test.{ts,tsx}',
  'packages/*/test/**/*.test.{ts,tsx}',
  'agents/test/**/*.test.ts',
];

/** vitest 默认不收的目录（vitest 5 的 defaultExclude：`**\/node_modules/**`、`**\/.git/**`）。 */
const EXCLUDED_DIRS = new Set(['node_modules', '.git']);

/** CI 里经文件清单、GitHub 矩阵传来传去：带空白、控制字符的路径认不出（一行一个、按空白切都会切错）。 */
const SAFE_PATH = /^[^\s\p{Cc}]+$/u;

/** 一段路径的匹配：`*` 不跨 /、`{a,b}` 二选一；vitest 用 dot: true，所以 `*` 也匹配点开头的名字。 */
function segmentRegExp(seg: string): RegExp {
  let re = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i] as string;
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = seg.indexOf('}', i);
      if (end < 0) throw new Error(`认不出的 include 写法：${seg}`);
      re += `(?:${seg
        .slice(i + 1, end)
        .split(',')
        .map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&'))
        .join('|')})`;
      i = end;
    } else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const COMPILED = TEST_INCLUDE.map((p) => p.split('/').map((s) => (s === '**' ? '**' : segmentRegExp(s))));

function matchSegs(segs: readonly (RegExp | '**')[], parts: readonly string[]): boolean {
  if (segs.length === 0) return parts.length === 0;
  const [head, ...rest] = segs;
  if (head === '**') {
    for (let i = 0; i <= parts.length; i++) if (matchSegs(rest, parts.slice(i))) return true;
    return false;
  }
  return parts.length > 0 && (head as RegExp).test(parts[0] as string) && matchSegs(rest, parts.slice(1));
}

/** 这个仓内路径会不会被 vitest 当测试文件收（按 TEST_INCLUDE，排除 node_modules、.git 下的）。 */
export function isTestFile(path: string): boolean {
  const parts = path.split('/');
  if (parts.some((p) => EXCLUDED_DIRS.has(p))) return false;
  return COMPILED.some((segs) => matchSegs(segs, parts));
}

/**
 * 列出 vitest 会收的全部测试文件（仓内相对路径、排好序）。每条 include 开头那段固定目录（packages、agents/test）列不出，
 * 返回一句为什么：调用方判红，不拿空清单冒充「没有测试」。
 * test/test-split.test.ts 拿装着的 vitest 自己 `vitest list` 出来的全集逐个核对，两边差一个就红。
 */
export function listTestFiles(repo: RepoView): string[] | string {
  const out = new Set<string>();
  for (const [p, pattern] of TEST_INCLUDE.entries()) {
    const segs = COMPILED[p] as (RegExp | '**')[];
    // 开头那段不带通配的固定目录：列不出就是检出坏了，不是「没有测试」
    const literal = pattern.split('/');
    let i = 0;
    while (i < literal.length - 1 && !/[*?{]/.test(literal[i] as string)) i++;
    const base = literal.slice(0, i).join('/');
    if (repo.list(base) === undefined) return `列不出 ${base}/（测试文件从这里找）`;
    const walk = (dir: string, rest: readonly (RegExp | '**')[]) => {
      if (rest.length === 0) return;
      const [head, ...tail] = rest;
      const names = repo.list(dir) ?? [];
      if (head === '**') {
        walk(dir, tail);
        for (const name of names) {
          if (EXCLUDED_DIRS.has(name)) continue;
          const child = `${dir}/${name}`;
          if (repo.isDir(child)) walk(child, rest);
        }
        return;
      }
      for (const name of names) {
        if (EXCLUDED_DIRS.has(name) || !(head as RegExp).test(name)) continue;
        const child = `${dir}/${name}`;
        if (tail.length === 0) {
          if (!repo.isDir(child)) out.add(child);
        } else if (repo.isDir(child)) walk(child, tail);
      }
    };
    walk(base, segs.slice(i));
  }
  const files = [...out].sort();
  const bad = files.find((f) => !SAFE_PATH.test(f));
  if (bad !== undefined) return `测试文件名里有空白或控制字符，CI 的文件清单装不下：${JSON.stringify(bad)}`;
  return files;
}

/** 测试文件属于哪个测试单元：packages/<包> 的包目录名，agents/test 下的是 agents（和 ci-plan.ts 的单元一致）。 */
export function unitOfTestFile(path: string): string | undefined {
  if (path.startsWith('agents/')) return 'agents';
  return /^packages\/([^/]+)\//.exec(path)?.[1];
}

// ---- vitest 的子串过滤

/**
 * 把 f 交给 vitest 当过滤条件时，会跟它一起被拉上的别的文件（照 vitest 的 filterFiles）。
 * 两个方向都算：`x.test.ts` 和 `x.test.tsx` 同时收进来时，拿短的当条件会把长的也拉上。
 */
export function siblingsOf(f: string, universe: readonly string[]): string[] {
  const low = f.toLowerCase();
  return universe.filter((g) => g !== f && (g.toLowerCase().includes(low) || low.includes(g.toLowerCase())));
}

/** 选中的文件加上它们当过滤条件时会被一起拉上的（多跑几个无妨；少分一个，核对那一步会红）。排好序。 */
export function withSiblings(selected: readonly string[], universe: readonly string[]): string[] {
  const out = new Set(selected);
  // 子串关系可传递（f ⊂ g ⊂ h 则 f ⊂ h），一遍就够
  for (const f of selected) for (const g of siblingsOf(f, universe)) out.add(g);
  return [...out].sort();
}

// ---- 环境类、能力

/**
 * 要真 Postgres 环境（FLEET_TEST_PG_URL）的测试：packages/db 下的。这一台的 vitest 进程里所有 createTestDb 都会连真库，
 * 所以这类文件单独装台。real-pg.test.ts 没设变量时在 CI 里直接红（不悄悄跳过）；
 * test/test-split.test.ts 扫全仓：用到 FLEET_TEST_PG_URL / realTestPgUrl 的测试文件都得落在这一类里。
 */
export function needsPg(file: string): boolean {
  return file.startsWith('packages/db/');
}

/**
 * 要 Temporal 命令行（FLEET_TEST_TEMPORAL_CLI）的测试：调了 createRealEnv（packages/engine/test/support.ts，真开发服务端）的。
 * 按文件内容认，不按包猜。test/test-split.test.ts 钉着：除了 support.ts 里那份定义，没有别的非测试文件包一层再调它
 * （包一层的话，调包装的测试文件里就看不到这个名字了）。漏认了也不会悄悄过：CI 里没给这个变量，support.ts 当场抛错。
 */
export const TEMPORAL_MARKER = /\bcreateRealEnv\s*\(/;

// ---- 耗时表

/** 耗时表在仓里的位置（仓根相对）。 */
export const TIMINGS_FILE = 'packages/conventions/test-timings.json';

export interface Timings {
  /** 从哪一轮 CI 量出来的（给人看）。 */
  source: string;
  /** 测试文件 → 毫秒（那一轮 vitest 报的这个文件的耗时：4 核机器上并行跑时量的）。 */
  files: Record<string, number>;
}

/** 读耗时表；认不出返回一句为什么（调用方照样装箱，只是每个文件按 FALLBACK_FILE_MS 估，并报警）。 */
export function parseTimings(text: string | undefined): Timings | string {
  if (text === undefined) return `读不到 ${TIMINGS_FILE}`;
  let t: unknown;
  try {
    t = JSON.parse(text);
  } catch {
    return `${TIMINGS_FILE} 不是 JSON`;
  }
  const o = t as Partial<Timings> | null;
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return `${TIMINGS_FILE} 不是对象`;
  if (typeof o.source !== 'string') return `${TIMINGS_FILE} 里没有 source`;
  const files = o.files;
  if (typeof files !== 'object' || files === null || Array.isArray(files))
    return `${TIMINGS_FILE} 里没有 files`;
  const entries = Object.entries(files as Record<string, unknown>);
  if (entries.length === 0) return `${TIMINGS_FILE} 的 files 是空的`;
  for (const [f, ms] of entries) {
    if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 0)
      return `${TIMINGS_FILE} 里 ${f} 的毫秒数认不出`;
  }
  return { source: o.source, files: files as Record<string, number> };
}

// ---- 装箱

/**
 * 每台的目标：测试耗时合计 50 秒。依据（2026-10-03 主线全量一轮）：一台 GitHub 运行机 4 核，vitest 并行跑，「各文件耗时合计 / 墙钟」
 * 实测 1.9–2，所以 50 秒合计 ≈ 25 秒墙钟，加每台约 20 秒固定开销（检出、装依赖），一台 45 秒上下。
 */
export const TARGET_BOX_MS = 50_000;
/**
 * 最多几台。GitHub 免费档全账号同时只能跑 20 个 job：一个 PR 除测试外还有 changes、lint、web、deploy（最多 3）、check，
 * 主线那一轮和 PR 撞上时（2026-10-03 实测 PR 第一个 job 排队 38 秒）测试台越多越挤。先定 8，量过再调。
 */
export const MAX_BOXES = 8;
/** 耗时表读不出时每个文件按多少毫秒估：2026-10-03 那一轮 359 个文件合计 687 秒，平均 1.9 秒。 */
export const FALLBACK_FILE_MS = 2_000;

export interface TestBox {
  /** job 名里显示的：第几台/共几台；pg 台带「· pg」，装了要 Temporal 的带「· temporal」。 */
  label: string;
  /** 这台跑的测试文件（仓内相对路径、排好序）。 */
  files: string[];
  /** 按耗时表估的这台测试耗时合计（毫秒；并行跑，墙钟约一半）。 */
  estMs: number;
  /** 起 postgres:16、设 FLEET_TEST_PG_URL（needsPg 那一类；pg 台上只有这一类）。 */
  pg: boolean;
  /** 装 Temporal 命令行、设 FLEET_TEST_TEMPORAL_CLI（装进了 TEMPORAL_MARKER 认出的文件）。 */
  temporal: boolean;
}

export interface PackInput {
  /** 要跑的测试文件（已经 withSiblings 过）。 */
  files: readonly string[];
  /** 全部测试文件（认子串过滤会拉上谁）。 */
  universe: readonly string[];
  timings: Timings | string;
  /** 要 Temporal 命令行的文件。 */
  temporal: ReadonlySet<string>;
}

export interface Packed {
  boxes: TestBox[];
  /** 给人看的说明（耗时表读不出、新文件按中位数估了几个、几个文件因子串过滤并成一件）。 */
  notes: string[];
  /** 耗时表读不出（报 ::warning::，照样装箱）。 */
  timingsProblem?: string;
}

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s.length === 0 ? FALLBACK_FILE_MS : (s[Math.floor((s.length - 1) / 2)] as number);
}

/** 台数：k = clamp(ceil(合计 / TARGET_BOX_MS), 1, MAX_BOXES)。 */
export function boxCount(totalMs: number): number {
  return Math.min(MAX_BOXES, Math.max(1, Math.ceil(totalMs / TARGET_BOX_MS)));
}

interface Item {
  files: string[];
  ms: number;
}

/** 最长的先放、放进当前最空的那台；同样重按路径、同样空按台号，结果确定。 */
function lpt(items: readonly Item[], bins: number): Item[][] {
  const sorted = [...items].sort(
    (a, b) => b.ms - a.ms || ((a.files[0] as string) < (b.files[0] as string) ? -1 : 1),
  );
  const out: Item[][] = Array.from({ length: bins }, () => []);
  const load = new Array<number>(bins).fill(0);
  for (const it of sorted) {
    let best = 0;
    for (let i = 1; i < bins; i++) if ((load[i] as number) < (load[best] as number)) best = i;
    (out[best] as Item[]).push(it);
    load[best] = (load[best] as number) + it.ms;
  }
  return out;
}

/**
 * 装箱。返回空清单表示没有要跑的；有文件该放哪一类认不出（子串过滤把 db 和别的包的文件绑在了一起）返回一句为什么。
 * 台数先按总工作量定（boxCount），再在 pg、普通两类之间分：每类至少一台，其余一台一台给「平均每台最重」的那类。
 * 两类都有、而总量只够一台时，实际是两台（两类不能同一个进程）。
 */
export function packTests(input: PackInput): Packed | string {
  const notes: string[] = [];
  const timings = typeof input.timings === 'string' ? undefined : input.timings;
  const known = timings ? Object.values(timings.files) : [];
  const guess = timings ? median(known) : FALLBACK_FILE_MS;
  const unknown = input.files.filter((f) => timings?.files[f] === undefined);
  if (!timings)
    notes.push(`耗时表读不出（${input.timings}）：每个文件按 ${FALLBACK_FILE_MS / 1000} 秒估，分得可能不匀`);
  else if (unknown.length > 0)
    notes.push(
      `耗时表里没有的 ${unknown.length} 个文件按中位数 ${guess} 毫秒估（${unknown.slice(0, 3).join('、')}${unknown.length > 3 ? '……' : ''}）`,
    );
  const ms = (f: string) => timings?.files[f] ?? guess;

  // 子串过滤绑在一起的文件并成一件（并查集）
  const parent = new Map(input.files.map((f) => [f, f]));
  const find = (f: string): string => {
    const p = parent.get(f) as string;
    if (p === f) return f;
    const r = find(p);
    parent.set(f, r);
    return r;
  };
  const chosen = new Set(input.files);
  for (const f of input.files) {
    for (const g of siblingsOf(f, input.universe)) {
      if (!chosen.has(g)) return `${f} 会把 ${g} 一起拉上，但 ${g} 不在要跑的清单里（先 withSiblings）`;
      parent.set(find(g), find(f));
    }
  }
  const groups = new Map<string, string[]>();
  for (const f of [...input.files].sort()) {
    const r = find(f);
    groups.set(r, [...(groups.get(r) ?? []), f]);
  }
  const pgItems: Item[] = [];
  const plainItems: Item[] = [];
  for (const files of groups.values()) {
    if (files.length > 1) notes.push(`${files.join('、')} 按名字会互相拉上（vitest 是子串过滤），放在同一台`);
    const pg = files.filter(needsPg).length;
    if (pg > 0 && pg < files.length)
      return `${files.join('、')} 按名字绑在一起，却一半要真 Postgres、一半不要：分不了台`;
    (pg > 0 ? pgItems : plainItems).push({ files, ms: files.reduce((s, f) => s + ms(f), 0) });
  }

  const classes = [
    { pg: true, items: pgItems, bins: 0 },
    { pg: false, items: plainItems, bins: 0 },
  ].filter((c) => c.items.length > 0);
  if (classes.length === 0) return { boxes: [], notes };
  const total = classes.reduce((s, c) => s + c.items.reduce((t, i) => t + i.ms, 0), 0);
  const k = boxCount(total);
  for (const c of classes) c.bins = 1;
  const loadOf = (c: (typeof classes)[number]) => c.items.reduce((t, i) => t + i.ms, 0) / c.bins;
  for (let given = classes.length; given < k; given++) {
    const open = classes.filter((c) => c.bins < c.items.length);
    if (open.length === 0) break;
    const heaviest = open.reduce((a, b) => (loadOf(b) > loadOf(a) ? b : a));
    heaviest.bins++;
  }

  const raw: Omit<TestBox, 'label'>[] = [];
  for (const c of classes) {
    for (const bin of lpt(c.items, c.bins)) {
      const files = bin.flatMap((i) => i.files).sort();
      raw.push({
        files,
        estMs: bin.reduce((t, i) => t + i.ms, 0),
        pg: c.pg,
        temporal: files.some((f) => input.temporal.has(f)),
      });
    }
  }
  const n = raw.length;
  const boxes = raw.map((b, i) => ({
    label: `${i + 1}/${n}${b.pg ? ' · pg' : ''}${b.temporal ? ' · temporal' : ''}`,
    ...b,
  }));
  return { boxes, notes, ...(timings ? {} : { timingsProblem: input.timings as string }) };
}
