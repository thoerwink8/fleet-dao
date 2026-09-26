// CI 按改动跑（.github/workflows/ci.yml）：从这次 PR 改了哪些文件、各包谁依赖谁，算出哪几个 job 要跑、测试跑哪几个包；
// 汇总 job（必过检查 check）再逐个核对「该跑的跑了且绿、不该跑的确实跳过」。纯判断，不碰 git、不碰网络；入口在 bin/ci-plan.ts、bin/ci-verdict.ts。
// 三态纪律：认不出的路径、读不出的依赖图、空的改动列表、非 PR 事件一律升成全跑，不拿「没改什么」冒充可以少跑。
// 改这里之前必须知道：
// - 测试不只读自己包里的文件（读别的包的源码、夹具，读 docs/ops.md、AGENTS.md、deploy/ 下的脚本）。PATH_RULES 和 TEST_READS
//   就是这些「谁的测试读谁」的清单；test/ci-plan.test.ts 扫所有测试文件里指向包外的路径，漏记一条就红。
// - 这里判「少跑」等于放行没测过的改动，所以本文件和两个入口都在 high-risk-paths.json 里（先审后合）。
import type { RepoView } from './repo.ts';

/** 测试单元：packages/ 下的包目录名，外加仓根的 agents（skill 的测试，tsconfig 和 vitest 都把它当一个单元）。 */
export const AGENTS_UNIT = 'agents';

export interface PackageGraph {
  /** 包目录名 → 它依赖的仓内包目录名（package.json 里的 @fleet-dao/*）。 */
  deps: Record<string, string[]>;
}

export interface TestShard {
  /** engine、db 各占一台（最慢的两个），其余合一台。 */
  name: 'engine' | 'db' | 'rest';
  /** 交给 `vitest run` 的参数：包目录（带 / 结尾，免得 api 匹配到 api-x），或全跑时 rest 排除 engine、db 的写法。 */
  args: string[];
  /** 引擎的测试要真的 Temporal 开发服务端（test/support.ts）。 */
  temporal: boolean;
}

export interface CiPlan {
  full: boolean;
  /** 为什么这么跑：全跑时是触发全跑的那几条，否则是各文件落到了哪。 */
  reasons: string[];
  /** biome + tsc。只改 .md 时不跑（biome 不认 md，tsc 不看 md）。 */
  lint: boolean;
  /** tsc -b 的项目目录；'all' 是仓根整棵树。空数组 = 只跑 biome。 */
  tsc: string[] | 'all';
  tests: TestShard[];
  /** 演示版打包 + 扫产物。 */
  web: boolean;
  /** deploy/test/run.sh。 */
  deploy: boolean;
}

/** 这些包的测试或打包被 deploy/test 直接跑（agents-sync 的同步脚本、飞书网关打包、web 的扫描脚本）。 */
export const DEPLOY_READS_PACKAGES = ['agents-sync', 'feishu', 'web'] as const;

/**
 * 测试读了别的包的文件、但 package.json 里没有依赖：键是读的那个包，值是被读的包（被读的一改，读的那个跟着测；
 * 不再往下传——依赖读的那个包的，并不读被读的文件）。
 * api/test/health-public-text.test.ts 按路径动态加载 web/src/build/scan.ts；feishu/test/static.test.ts 读 web 的路由表。
 */
export const TEST_READS: Record<string, string[]> = { api: ['web'], feishu: ['web'] };

type Rule =
  | { match: (f: string) => boolean; full: string }
  | { match: (f: string) => boolean; units: string[]; deploy?: true; why: string };

const exact = (p: string) => (f: string) => f === p;
const under = (p: string) => (f: string) => f.startsWith(p);

/** 包外路径的去处，按顺序取第一条。包内的（packages/<包>/…）不在这里，按依赖图算。 */
export const PATH_RULES: readonly Rule[] = [
  ...[
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.json',
    'tsconfig.base.json',
    'biome.json',
    'vitest.config.ts',
  ].map((p) => ({ match: exact(p), full: '根配置，所有包都受影响' })),
  { match: under('.github/workflows/'), full: 'CI 工作流本身' },
  { match: under('packages/shared/'), full: '几乎所有包都依赖 shared' },
  {
    match: (f) => /^packages\/[^/]+\/test\/(?:.+\/)?fixtures\//.test(f),
    full: '测试夹具，别的包的测试也读',
  },
  { match: under('deploy/'), full: '装机脚本：deploy/test 全跑，好几个包的测试也直接读 deploy/ 下的文件' },
  { match: exact('docs/ops.md'), units: ['db'], deploy: true, why: 'deploy/test 核对端口表、db 的测试读它' },
  { match: exact('AGENTS.md'), units: ['agents-sync'], deploy: true, why: '通用段由 agents-sync 分发' },
  {
    match: under('agents/'),
    units: [AGENTS_UNIT, 'agents-sync'],
    deploy: true,
    why: 'skill 由 agents-sync 分发',
  },
  {
    match: exact('.github/pull_request_template.md'),
    units: ['conventions', 'github'],
    why: 'PR 必填栏、引擎写 PR 正文都照这份模板',
  },
  { match: exact('.gitignore'), units: ['hygiene'], why: '标记段是卫生检查的密钥文件名单' },
  { match: under('.githooks/'), units: ['hygiene'], why: '推前钩子调卫生检查' },
  { match: under('docs/'), units: [], why: '文档' },
  { match: under('specs/'), units: [], why: '需求文档' },
  { match: exact('README.md'), units: [], why: '文档' },
  { match: under('.github/ISSUE_TEMPLATE/'), units: [], why: 'GitHub 上开单的表单，测试不读' },
];

const PKG_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** 读 packages/*\/package.json 的仓内依赖。读不到、认不出返回一句为什么（调用方升成全跑）。 */
export function readGraph(repo: RepoView): PackageGraph | string {
  const dirs = repo.list('packages');
  if (!dirs) return '列不出 packages/';
  const byName = new Map<string, string>();
  const raw = new Map<string, Record<string, unknown>>();
  for (const dir of dirs.sort()) {
    if (!repo.isDir(`packages/${dir}`)) continue;
    if (!PKG_NAME.test(dir)) return `包目录名认不出：packages/${dir}`;
    const text = repo.read(`packages/${dir}/package.json`);
    if (text === undefined) return `读不到 packages/${dir}/package.json`;
    let pkg: unknown;
    try {
      pkg = JSON.parse(text);
    } catch (e) {
      return `packages/${dir}/package.json 不是 JSON（${e instanceof Error ? e.message : String(e)}）`;
    }
    if (typeof pkg !== 'object' || pkg === null || typeof (pkg as { name?: unknown }).name !== 'string') {
      return `packages/${dir}/package.json 没有 name`;
    }
    const p = pkg as Record<string, unknown>;
    byName.set(p.name as string, dir);
    raw.set(dir, p);
  }
  if (raw.size === 0) return 'packages/ 下一个包都没有';
  const deps: Record<string, string[]> = {};
  for (const [dir, p] of raw) {
    const names = new Set<string>();
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const v = p[field];
      if (v === undefined) continue;
      if (typeof v !== 'object' || v === null) return `packages/${dir}/package.json 的 ${field} 认不出`;
      for (const name of Object.keys(v)) {
        const d = byName.get(name);
        if (d !== undefined && d !== dir) names.add(d);
        else if (name.startsWith('@fleet-dao/') && d === undefined) {
          return `packages/${dir} 依赖的 ${name} 在 packages/ 下找不到`;
        }
      }
    }
    deps[dir] = [...names].sort();
  }
  return { deps };
}

const unitPath = (u: string) => (u === AGENTS_UNIT ? 'agents/' : `packages/${u}/`);
const unitProject = (u: string) => (u === AGENTS_UNIT ? 'agents' : `packages/${u}`);

function fullPlan(reasons: string[]): CiPlan {
  return {
    full: true,
    reasons,
    lint: true,
    tsc: 'all',
    tests: [
      { name: 'engine', args: ['packages/engine/'], temporal: true },
      { name: 'db', args: ['packages/db/'], temporal: false },
      {
        name: 'rest',
        args: ['--exclude', 'packages/engine/**', '--exclude', 'packages/db/**'],
        temporal: false,
      },
    ],
    web: true,
    deploy: true,
  };
}

/** 改了 start 里的包，要跟着测的：它们自己 + 所有直接间接依赖它们的。 */
export function dependentsClosure(graph: PackageGraph, start: Iterable<string>): Set<string> {
  const users = new Map<string, string[]>();
  for (const [pkg, ds] of Object.entries(graph.deps)) {
    for (const d of ds) users.set(d, [...(users.get(d) ?? []), pkg]);
  }
  const seen = new Set<string>();
  const todo = [...start];
  while (todo.length > 0) {
    const u = todo.pop() as string;
    if (seen.has(u)) continue;
    seen.add(u);
    todo.push(...(users.get(u) ?? []));
  }
  return seen;
}

export interface PlanInput {
  /** GitHub 的事件名；只有 pull_request 按改动算，别的（主线推送等）全跑。 */
  event: string;
  /** 这次改了的文件，仓内相对路径（git diff --name-only --no-renames base...HEAD）。 */
  changed: readonly string[];
  graph: PackageGraph | string;
}

export function planCi({ event, changed, graph }: PlanInput): CiPlan {
  if (event !== 'pull_request') return fullPlan([`${event} 事件：全跑（主线上兜底）`]);
  if (typeof graph === 'string') return fullPlan([`包依赖图读不出（${graph}）：全跑`]);
  if (changed.length === 0) return fullPlan(['改动列表是空的：认不出这次改了什么，全跑']);

  const fullWhy: string[] = [];
  const reasons: string[] = [];
  /** 改到了源码的包：它们和依赖它们的都要测。 */
  const units = new Set<string>();
  /** 测试读了改到的包外文件的单元：只测它们自己（依赖它们的包不读那个文件）。 */
  const readers = new Set<string>();
  let deploy = false;
  for (const f of changed) {
    const rule = PATH_RULES.find((r) => r.match(f));
    if (rule && 'full' in rule) {
      fullWhy.push(`${f}：${rule.full}`);
      continue;
    }
    if (rule) {
      for (const u of rule.units) readers.add(u);
      if (rule.deploy) deploy = true;
      reasons.push(`${f}：${rule.why}${rule.units.length > 0 ? `，测 ${rule.units.join('、')}` : ''}`);
      continue;
    }
    const m = /^packages\/([^/]+)\//.exec(f);
    if (m?.[1] !== undefined && m[1] in graph.deps) {
      units.add(m[1]);
      continue;
    }
    fullWhy.push(`${f}：${m ? `packages/${m[1]} 不在依赖图里` : '认不出的路径'}，全跑`);
  }
  if (fullWhy.length > 0) return fullPlan(fullWhy);

  const closure = dependentsClosure(graph, units);
  if (closure.size > 0) reasons.push(`改到源码的包和依赖它们的：${[...closure].sort().join('、')}`);
  for (const [reader, reads] of Object.entries(TEST_READS)) {
    if (reads.some((r) => closure.has(r))) readers.add(reader);
  }
  const all = [...new Set([...closure, ...readers])].sort();

  const tests: TestShard[] = [];
  if (all.includes('engine')) tests.push({ name: 'engine', args: ['packages/engine/'], temporal: true });
  if (all.includes('db')) tests.push({ name: 'db', args: ['packages/db/'], temporal: false });
  const rest = all.filter((u) => u !== 'engine' && u !== 'db');
  if (rest.length > 0) tests.push({ name: 'rest', args: rest.map(unitPath), temporal: false });

  const lint = changed.some((f) => !f.endsWith('.md'));
  return {
    full: false,
    reasons,
    lint,
    tsc: lint ? all.map(unitProject) : [],
    tests,
    web: closure.has('web'),
    deploy: deploy || DEPLOY_READS_PACKAGES.some((p) => closure.has(p)),
  };
}

/** 写进 $GITHUB_OUTPUT 的几行；下游 job 的 if 和汇总 job 都只读这些。 */
export function planOutputs(plan: CiPlan): Record<string, string> {
  return {
    plan: JSON.stringify(plan),
    lint: String(plan.lint),
    tsc: plan.tsc === 'all' ? 'all' : plan.tsc.join(' '),
    tests: JSON.stringify(plan.tests),
    web: String(plan.web),
    deploy: String(plan.deploy),
  };
}

/** 汇总 job 核对的几个 job（ci.yml 里的 job id）；hygiene 每次都得跑。 */
export const PLANNED_JOBS = ['lint', 'test', 'web', 'deploy'] as const;
export const ALWAYS_JOBS = ['changes', 'hygiene'] as const;

function expected(plan: CiPlan, job: (typeof PLANNED_JOBS)[number]): boolean {
  if (job === 'test') return plan.tests.length > 0;
  return plan[job];
}

function parsePlan(text: unknown): CiPlan | string {
  if (typeof text !== 'string' || text === '') return 'changes 没给出 plan';
  let p: unknown;
  try {
    p = JSON.parse(text);
  } catch {
    return 'changes 给的 plan 不是 JSON';
  }
  const o = p as Partial<CiPlan> | null;
  if (
    typeof o !== 'object' ||
    o === null ||
    typeof o.full !== 'boolean' ||
    typeof o.lint !== 'boolean' ||
    typeof o.web !== 'boolean' ||
    typeof o.deploy !== 'boolean' ||
    !Array.isArray(o.tests) ||
    !(o.tsc === 'all' || Array.isArray(o.tsc))
  ) {
    return 'changes 给的 plan 认不出';
  }
  return o as CiPlan;
}

/**
 * 汇总 job 的结论：`needs` 是 ci.yml 里 `toJSON(needs)` 原样给的。每个 job 的 result 必须是
 * 「本该跑 → success、本该不跑 → skipped」，changes、hygiene 必须 success；有一条不对、认不出，就不通过。
 */
export function ciVerdict(needs: unknown): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  if (typeof needs !== 'object' || needs === null)
    return { ok: false, lines: ['读不出各 job 的结果（needs）'] };
  const n = needs as Record<string, { result?: unknown; outputs?: Record<string, unknown> } | undefined>;
  let ok = true;
  const bad = (line: string) => {
    ok = false;
    lines.push(`✗ ${line}`);
  };
  for (const job of ALWAYS_JOBS) {
    const r = n[job]?.result;
    if (r === 'success') lines.push(`✓ ${job}：success`);
    else bad(`${job}：${r === undefined ? '没有这个 job 的结果' : String(r)}（每次都得跑且绿）`);
  }
  const plan = parsePlan(n.changes?.outputs?.plan);
  if (typeof plan === 'string') {
    bad(plan);
    return { ok: false, lines };
  }
  if (plan.full && PLANNED_JOBS.some((j) => !expected(plan, j))) bad('plan 说全跑，却有 job 没开');
  for (const job of PLANNED_JOBS) {
    const want = expected(plan, job) ? 'success' : 'skipped';
    const r = n[job]?.result;
    if (r === want) lines.push(`✓ ${job}：${r}`);
    else bad(`${job}：${r === undefined ? '没有这个 job 的结果' : String(r)}，本该 ${want}`);
  }
  return { ok, lines };
}
