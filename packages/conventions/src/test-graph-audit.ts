// 拿真实运行时核对静态图（test-graph.ts）准不准：记下每个测试跑的时候真的加载、读了哪些仓内文件（含子进程里读的），
// 和「静态图预测的闭包」比，列出图漏掉的边。漏边 = 选漏 = PR 绿了主线红，所以这组数据最要紧。挂每晚的定时任务里跑
// （bin/test-graph-audit.ts）。分三块：
// - trace-setup.ts / trace-child.ts：vitest 的 setupFiles 和子进程的 --import，把读盘、模块加载记成 JSONL；
// - runTrace：起一轮 vitest 真跑，返回记下来的流水；
// - compareTrace：流水对图，按「改了它会不会真的选漏」分级。
// 改这里之前必须知道：
// - 漏边分两级。selectTests 会替它做主的文件（classifyChange 判 resolved）漏了才真会选漏，记进 misses；
//   改了本来就交回调用方的文件（根配置、文档、没人引用的）漏了也不会少跑，记进 handedBack，只供参考。
// - 记不到的：shell 脚本自己读的文件、洗掉 NODE_OPTIONS 的子进程、别的机器上的进程。跳过（没跑到）的测试算「没查成」。
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Closure, changeIndex, classifyChange, closureOf, type TestGraph } from './test-graph.ts';

export const traceSetupFile = fileURLToPath(new URL('./trace-setup.ts', import.meta.url));
export const traceChildFile = fileURLToPath(new URL('./trace-child.ts', import.meta.url));

/** 流水里的一条：一个测试文件（或它起的一个子进程）这一轮加载、读取的记录。 */
export interface TraceRecord {
  /** 跑的是哪个测试文件（绝对路径）；子进程记的是起它的那个测试文件。 */
  testFile: string;
  /** 这批路径以哪个目录为仓根。测试把仓拷到临时目录再跑时，那批路径的根不同，不参与比对。 */
  root?: string;
  child?: boolean;
  /** 加载过的模块（绝对路径）。 */
  loaded: string[];
  /** 读过、探过（stat/exists）的路径（绝对路径）。 */
  read: string[];
  /** 列过的目录（绝对路径）。 */
  listed: string[];
}

/** 读 JSONL 流水。读不到、认不出抛错，不拿空数组冒充「没记到东西」。 */
export function readTrace(files: readonly string[]): TraceRecord[] {
  const out: TraceRecord[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(f, 'utf8');
    } catch (e) {
      throw new Error(`读不到流水文件 ${f}（${e instanceof Error ? e.message : String(e)}）`);
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let rec: unknown;
      try {
        rec = JSON.parse(line);
      } catch {
        throw new Error(`流水文件 ${f} 里有一行不是 JSON：${line.slice(0, 200)}`);
      }
      const r = rec as Partial<TraceRecord> | null;
      if (
        typeof r !== 'object' ||
        r === null ||
        typeof r.testFile !== 'string' ||
        !Array.isArray(r.loaded) ||
        !Array.isArray(r.read) ||
        !Array.isArray(r.listed)
      )
        throw new Error(`流水文件 ${f} 里的记录认不出：${line.slice(0, 200)}`);
      out.push(r as TraceRecord);
    }
  }
  return out;
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
function relOf(p: string, root: string): string | undefined {
  const n = norm(p);
  const r = norm(root);
  if (n.toLowerCase() === r.toLowerCase()) return '';
  // Windows 上盘符大小写不定
  return n.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? n.slice(r.length + 1) : undefined;
}
/** 依赖、构建产物、临时文件：不是仓内的源，读了不算边。 */
const IGNORED =
  /^(?:node_modules|_tmp|\.git|\.claude|coverage)(?:\/|$)|(?:^|\/)(?:node_modules|dist|dist-demo)(?:\/|$)/;

export interface Miss {
  test: string;
  /** 运行时真用到、图的闭包里没有、而且 selectTests 会替它做主的文件：改了它会选漏这个测试。 */
  files: string[];
  /** 运行时用到、图里没有，但改它本来就交回现有规则（根配置、文档、没人引用的）：不会少跑，只供参考。 */
  handedBack: string[];
  /** 运行时列了目录、图里没有那条目录边（目录里增删文件本来就交回，不会少跑，只供参考）。 */
  dirs: string[];
}

export interface AuditReport {
  /** 静态图里是 opaque 的测试（调用方按包级跑）。 */
  opaqueTests: Set<string>;
  /** 每个记到流水的测试一条（没漏的 files 为空）。 */
  results: Miss[];
  /** 这轮打算核的测试文件数。 */
  scope: number;
  /** 该核却没记到流水的测试文件（跳过的、没跑到的）：没查成。 */
  missingTrace: string[];
  /** 记到了流水、但静态图里没有的测试文件。 */
  unknownTests: string[];
}

/**
 * 流水对图。root 是仓根绝对路径。scope 是这轮打算跑的测试（仓内相对路径或绝对路径，给目录也行）：
 * 只有它们才谈得上「该记到却没记到」；不给就是全部测试。
 */
export function compareTrace(
  records: readonly TraceRecord[],
  graph: TestGraph,
  root: string,
  options: { closures?: Map<string, Closure>; scope?: readonly string[] } = {},
): AuditReport {
  const closures = options.closures ?? new Map(graph.tests.map((t) => [t, closureOf(graph, t)] as const));
  const index = changeIndex(graph);
  const dirsOfRepo = new Set<string>();
  for (const f of graph.files) {
    const segs = f.split('/');
    for (let i = 1; i < segs.length; i++) dirsOfRepo.add(segs.slice(0, i).join('/'));
  }
  const byTest = new Map<string, { used: Set<string>; listed: Set<string> }>();
  // 追踪钩子自己（setupFiles、子进程的 --import）每个测试都会加载，不是测试的依赖
  const tracer = new Set([relOf(traceSetupFile, root), relOf(traceChildFile, root)]);
  for (const r of records) {
    const t = relOf(r.testFile, root);
    if (t === undefined || t === '') continue;
    if (r.root !== undefined && r.root !== '' && relOf(r.root, root) !== '') continue;
    const slot = byTest.get(t) ?? { used: new Set<string>(), listed: new Set<string>() };
    for (const p of [...r.loaded, ...r.read]) {
      const rel = relOf(p, root);
      if (rel !== undefined && rel !== '' && !IGNORED.test(rel) && !tracer.has(rel)) slot.used.add(rel);
    }
    for (const p of r.listed) {
      const rel = relOf(p, root);
      if (rel !== undefined && rel !== '' && !IGNORED.test(rel)) slot.listed.add(rel);
    }
    byTest.set(t, slot);
  }
  const scopeList = (options.scope ?? graph.tests).map((s) => relOf(s, root) ?? norm(s));
  const inScope = (t: string) => scopeList.some((s) => t === s || t.startsWith(`${s}/`));

  const results: Miss[] = [];
  const missingTrace: string[] = [];
  for (const t of graph.tests) {
    const slot = byTest.get(t);
    if (slot === undefined) {
      if (inScope(t)) missingTrace.push(t);
      continue;
    }
    const cl = closures.get(t) as Closure;
    const covered = (rel: string) =>
      cl.files.has(rel) || [...cl.codeDirs, ...cl.dataDirs].some((d) => rel === d || rel.startsWith(`${d}/`));
    const files: string[] = [];
    const handedBack: string[] = [];
    for (const rel of slot.used) {
      // 探目录（stat、exists 一个目录）不是读内容；探一个不存在的路径也不是（文件清单里没有它）
      if (dirsOfRepo.has(rel) || !graph.files.has(rel) || covered(rel)) continue;
      if (classifyChange(graph, rel, index).kind === 'resolved') files.push(rel);
      else handedBack.push(rel);
    }
    const dirs = [...slot.listed].filter((d) => dirsOfRepo.has(d) && !covered(d));
    results.push({ test: t, files: files.sort(), handedBack: handedBack.sort(), dirs: dirs.sort() });
  }
  const opaqueTests = new Set<string>();
  for (const t of graph.tests) if ((closures.get(t) as Closure).blind.length > 0) opaqueTests.add(t);
  return {
    opaqueTests,
    results,
    scope: graph.tests.filter(inScope).length,
    missingTrace,
    unknownTests: [...byTest.keys()].filter((t) => !graph.tests.includes(t)).sort(),
  };
}

/** 有漏边（会选漏）的那些。opaque 的测试由调用方按包级跑，漏边不直接导致少跑，但也列出来。 */
export const realMisses = (r: AuditReport) => r.results.filter((m) => m.files.length > 0);

export function formatAudit(report: AuditReport): string {
  const bad = realMisses(report);
  const lines = [
    `打算核 ${report.scope} 个测试，记到 ${report.results.length} 个（没记到 ${report.missingTrace.length} 个、图里没有的 ${report.unknownTests.length} 个）。`,
    `会选漏的漏边：${bad.length} 个测试、${new Set(bad.flatMap((m) => m.files)).size} 个文件` +
      `（其中 opaque、本来就按包级跑的 ${bad.filter((m) => report.opaqueTests.has(m.test)).length} 个）。`,
    `不会选漏、只供参考：交回现有规则的文件 ${new Set(report.results.flatMap((m) => m.handedBack)).size} 个，` +
      `图里没有的目录列举 ${new Set(report.results.flatMap((m) => m.dirs)).size} 个。`,
  ];
  for (const m of bad) {
    lines.push(`  ${m.test}${report.opaqueTests.has(m.test) ? '（opaque）' : ''}：${m.files.join(' ')}`);
  }
  if (report.missingTrace.length > 0)
    lines.push(`没记到（没查成）：${report.missingTrace.slice(0, 30).join(' ')}`);
  return lines.join('\n');
}

export interface TraceRun {
  outDir: string;
  records: TraceRecord[];
  /** vitest 的退出码。 */
  status: number;
  /** vitest 报红的测试文件（仓内相对路径）。红了的测试可能半路停下、读得比平时少：它们的核对只算下限。 */
  failed: string[];
  stderr: string;
}

/**
 * 真跑一轮 vitest（仓根配置 + 追踪 setupFiles），流水写进 outDir/trace.jsonl。
 * 追踪用的配置写在 <root>/node_modules/.fleet-trace/ 下（它要从仓的 node_modules 解析 vitest/config）。
 * 一条都没记到时抛错（vitest 起不来、setup 没挂上），不拿空流水冒充「什么都没读」。
 */
export async function runTrace(
  root: string,
  args: readonly string[] = [],
  outDir?: string,
): Promise<TraceRun> {
  const dir = outDir ?? mkdtempSync(join(tmpdir(), 'fleet-trace-'));
  mkdirSync(dir, { recursive: true });
  const configDir = join(root, 'node_modules', '.fleet-trace');
  mkdirSync(configDir, { recursive: true });
  const config = join(configDir, 'vitest.config.mjs');
  const slash = (p: string) => p.replace(/\\/g, '/');
  writeFileSync(
    config,
    `import base from ${JSON.stringify(`${slash(root)}/vitest.config.ts`)};
import { mergeConfig } from 'vitest/config';
export default mergeConfig(base, {
  root: ${JSON.stringify(slash(root))},
  test: { root: ${JSON.stringify(slash(root))}, setupFiles: [${JSON.stringify(slash(traceSetupFile))}] },
});
`,
  );
  const out = join(dir, 'trace.jsonl');
  writeFileSync(out, '');
  const { status, stderr, stdout } = await new Promise<{ status: number; stderr: string; stdout: string }>(
    (resolve) => {
      const child = spawn(
        process.execPath,
        [join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', config, ...args],
        {
          cwd: root,
          env: {
            ...process.env,
            FLEET_TRACE_OUT: out,
            FLEET_TRACE_ROOT: slash(root),
            FLEET_TRACE_CHILD: slash(traceChildFile),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let err = '';
      let std = '';
      child.stdout?.on('data', (d: Buffer) => {
        std += d.toString();
      });
      child.stderr?.on('data', (d: Buffer) => {
        err += d.toString();
      });
      child.on('close', (code) => resolve({ status: code ?? 1, stderr: err, stdout: std }));
    },
  );
  const records = readTrace([out]);
  if (records.length === 0)
    throw new Error(`一条流水都没记到（vitest 退出码 ${status}）：\n${stderr.slice(-2000)}`);
  // vitest 的报告里红了的文件写成「 FAIL  <路径> …」（带颜色码时先剥掉）
  const plain = `${stdout}\n${stderr}`.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
  const failed = [...new Set([...plain.matchAll(/^\s*FAIL\s+(\S+)/gm)].map((m) => m[1] as string))].sort();
  return { outDir: dir, records, status, failed, stderr };
}
