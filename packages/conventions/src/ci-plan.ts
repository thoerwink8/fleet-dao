// CI 按改动跑（.github/workflows/ci.yml）：从这次 PR 改了哪些文件、各包谁依赖谁，算出哪几个 job 要跑、测试跑哪几个包，
// 再把选中的测试文件按耗时装进几台（assignTests → test-split.ts）；
// 汇总 job（必过检查 check）再逐个核对「该跑的跑了且绿、不该跑的确实跳过」。纯判断，不碰 git、不碰网络；入口在 bin/ci-plan.ts、bin/ci-verdict.ts。
// job 数就是并发槽数（GitHub 免费档同时最多 20 个，一个 PR 的 CI 占掉越多，能并着跑的 PR 越少）：所以把两两不相干的小检查
// 装进同一个 job（lint），装依赖只装一次；同一件事别开两个 job。见 PLANNED_JOBS 上面的注释。
// 三态纪律：认不出的路径、读不出的依赖图、空的改动列表、非 PR 事件一律升成全跑，不拿「没改什么」冒充可以少跑。
// 改这里之前必须知道：
// - 测试不只读自己包里的文件（读别的包的源码、夹具，读 docs/ops.md、AGENTS.md、deploy/ 下的脚本）。PATH_RULES 和 TEST_READS
//   就是这些「谁的测试读谁」的清单；test/ci-plan.test.ts 扫所有测试文件里指向包外的路径，漏记一条就红。
// - 这里判「少跑」等于放行没测过的改动，所以本文件和两个入口都在 high-risk-paths.json 里（先审后合）。
import type { RepoView } from './repo.ts';
import {
  type Packed,
  packTests,
  TEMPORAL_MARKER,
  type TestBox,
  type Timings,
  unitOfTestFile,
  withSiblings,
} from './test-split.ts';

/** 测试单元：packages/ 下的包目录名，外加仓根的 agents（skill 的测试，tsconfig 和 vitest 都把它当一个单元）。 */
export const AGENTS_UNIT = 'agents';

export interface PackageGraph {
  /** 包目录名 → 它依赖的仓内包目录名（package.json 里的 @fleet-dao/*）。 */
  deps: Record<string, string[]>;
}

export interface CiPlan {
  full: boolean;
  /** 为什么这么跑：全跑时是触发全跑的那几条，否则是各文件落到了哪。 */
  reasons: string[];
  /** biome。只改 .md 时不跑（biome 不认 md）；tsc 同理不看 md。
   * 这两个各占一台机器，但和 docs、hygiene 一样，墙钟都远小于最慢的测试台（db 约 87 秒），所以
   * 合成一个 job（lint）、装依赖只装一次，任务数少 3 个而整轮墙钟不变。见 PLANNED_JOBS 上面的注释。 */
  biome: boolean;
  /** tsc -b 的项目目录；'all' 是仓根整棵树。空数组 = 只跑 biome、不跑 tsc。 */
  tsc: string[] | 'all';
  /**
   * 要测的单元（包目录名、agents）；全跑时是全部（和 full 一起看）。planCi 只算到这一步；
   * 落到哪些测试文件、怎么分台由 assignTests 填进 tests（以后换成文件级选择，也只是换掉 assignTests 里「选文件」那一步）。
   */
  testUnits: string[];
  /** 装好箱的测试台（test-split.ts）：每台一份明确的文件清单。testUnits 不空时 assignTests 之后才有，汇总核对两边对得上。 */
  tests: TestBox[];
  /** 演示版打包 + 扫产物。 */
  web: boolean;
  /** deploy/test/run.sh：all 全套；ops 只跑读 docs/ops.md 的两块（`run.sh --ops`：端口表、place-file）；none 不跑。 */
  deploy: DeployMode;
}

export const DEPLOY_MODES = ['all', 'ops', 'none'] as const;
export type DeployMode = (typeof DEPLOY_MODES)[number];

/**
 * deploy/ 的全套切成几台并行跑（deploy/test/run.sh --shard i/n）。数字要和 run.sh 里 SHARDS 的项数一样
 * （test/ci-plan.test.ts 读 run.sh 核对）：那份文件是单一事实，这里只是把它写进 CI 的矩阵。
 * 2026-10-03 实测：全套 300 秒上下，login-user 一项就 94 秒，按它搭三台各 100 秒上下（run.sh 里 SHARDS 的注释写着怎么搭）。
 */
export const DEPLOY_SHARDS = 3;

/** deploy 那一 job 的矩阵：all 切成 DEPLOY_SHARDS 台、ops 一台（只跑读 docs/ops.md 的两块）、none 空。 */
export interface DeployLeg {
  label: string;
  /** run.sh 的参数。 */
  args: string[];
  /**
   * 这台要不要 sudo + FLEET_TEST_SYSTEM_USERS=1。只有全套那几台要（建、删真系统账号的测试在里面）；
   * ops 那台不碰系统账号，不带（CI 上 sudo 要宽权限，能不带就不带）。
   */
  sudo: boolean;
}

export function deployMatrix(mode: DeployMode): DeployLeg[] {
  if (mode === 'none') return [];
  if (mode === 'ops') return [{ label: 'ops', args: ['--ops'], sudo: false }];
  return Array.from({ length: DEPLOY_SHARDS }, (_, i) => ({
    label: `${i + 1}/${DEPLOY_SHARDS}`,
    args: ['--shard', `${i + 1}/${DEPLOY_SHARDS}`],
    sudo: true,
  }));
}

/** 这些包的测试或打包被 deploy/test 直接跑（agents-sync 的同步脚本、飞书网关打包、web 的扫描脚本）。 */
export const DEPLOY_READS_PACKAGES = ['agents-sync', 'feishu', 'web'] as const;

/**
 * 测试读了别的包的文件、但 package.json 里没有依赖：键是读的那个包，值是被读的包（被读的一改，读的那个跟着测；
 * 不再往下传——依赖读的那个包的，并不读被读的文件）。
 * api/test/health-public-text.test.ts 按路径动态加载 web/src/build/scan.ts；feishu/test/static.test.ts 读 web 的路由表；
 * agents/test/worker.test.ts 读 db 的路由骨架 routing.default.json（本机启动器照它定思考档位，#470）。
 */
export const TEST_READS: Record<string, string[]> = {
  api: ['web'],
  feishu: ['web'],
  db: ['core'],
  [AGENTS_UNIT]: ['db'],
};

export type Rule =
  | { match: (f: string) => boolean; full: string }
  | { match: (f: string) => boolean; units: string[]; deploy?: 'all' | 'ops'; why: string };

const exact = (p: string) => (f: string) => f === p;
const under = (p: string) => (f: string) => f.startsWith(p);

/** 仓根的配置：改到任何一个，所有包都受影响（PATH_RULES 全跑；ci-cache.ts 的缓存键也认这一份）。 */
export const ROOT_CONFIG_FILES: readonly string[] = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'tsconfig.base.json',
  'biome.json',
  'vitest.config.ts',
];

/** 测试夹具：别的包的测试也读（PATH_RULES 全跑；ci-cache.ts 的缓存键也认这一条）。 */
export const FIXTURE_PATH = /^packages\/[^/]+\/test\/(?:.+\/)?fixtures\//;

/** 包外路径的去处，按顺序取第一条。包内的（packages/<包>/…）不在这里，按依赖图算。 */
export const PATH_RULES: readonly Rule[] = [
  ...ROOT_CONFIG_FILES.map((p) => ({ match: exact(p), full: '根配置，所有包都受影响' })),
  { match: under('.github/workflows/'), full: 'CI 工作流本身' },
  { match: under('packages/shared/'), full: '几乎所有包都依赖 shared' },
  { match: (f) => FIXTURE_PATH.test(f), full: '测试夹具，别的包的测试也读' },
  { match: under('deploy/'), full: '装机脚本：deploy/test 全跑，好几个包的测试也直接读 deploy/ 下的文件' },
  // deploy/test 里读 docs/ops.md 的只有端口表那段和 place-file.test.sh：只改文档跑这两块（run.sh --ops），不拖上全套
  {
    match: exact('docs/ops.md'),
    units: ['db'],
    deploy: 'ops',
    why: 'deploy/test 核对端口表、放文件的命令，db 的测试读它',
  },
  // AGENTS.md、agents/ 是 agents-sync 的输入，也是 agents 单测的输入：标记成对、skill 格式由 agents-sync 和 agents 的单测读真文件核对，
  // 通用段自己也被 agents 的钉子测试读（agents/test/rules/design-skills.rules.test.ts 读这几条规矩在不在，#522）；
  // deploy/test 的同步测试只验换身份写文件，内容换了结果不变，所以不跑 deploy（纯说明 PR 曾被拖 2 分多钟）。
  {
    match: exact('AGENTS.md'),
    units: [AGENTS_UNIT, 'agents-sync'],
    why: '通用段由 agents-sync 分发，agents 的测试读它核规矩',
  },
  // 引擎起 Claude 会话经 --settings 直接用仓里这份调工具前的钩子（adapters 的 PRETOOL_SCRIPT），adapters 的测试真跑它
  {
    match: under('agents/hooks/'),
    units: [AGENTS_UNIT, 'agents-sync', 'adapters'],
    why: '钩子由 agents-sync 分发，引擎起 Claude 会话也直接用仓里这份',
  },
  {
    match: under('agents/'),
    units: [AGENTS_UNIT, 'agents-sync'],
    why: 'skill 由 agents-sync 分发',
  },
  {
    match: exact('.github/pull_request_template.md'),
    units: ['conventions', 'github'],
    why: 'PR 必填栏、引擎写 PR 正文都照这份模板',
  },
  { match: exact('.gitignore'), units: ['hygiene'], why: '标记段是卫生检查的密钥文件名单' },
  {
    match: under('.githooks/'),
    units: ['hygiene', AGENTS_UNIT],
    why: '推前钩子调卫生检查、查认领（agents 的测试直接跑这个钩子）',
  },
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

/** 单元的目录（带 / 结尾，免得 api 匹配到 api-x）：本机 test:changed 交给 vitest 当过滤条件。 */
export const unitPath = (u: string) => (u === AGENTS_UNIT ? 'agents/' : `packages/${u}/`);
const unitProject = (u: string) => (u === AGENTS_UNIT ? 'agents' : `packages/${u}`);

function fullPlan(reasons: string[]): CiPlan {
  return {
    full: true,
    reasons,
    biome: true,
    tsc: 'all',
    testUnits: [],
    tests: [],
    web: true,
    deploy: 'all',
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
  /** 包外路径的去处；只在测试里换掉（ci-plan.test.ts 拿漏记一处的版本核对扫描器查不查得出来）。 */
  rules?: readonly Rule[];
}

export function planCi({ event, changed, graph, rules = PATH_RULES }: PlanInput): CiPlan {
  if (event !== 'pull_request') return fullPlan([`${event} 事件：全跑（主线上兜底）`]);
  if (typeof graph === 'string') return fullPlan([`包依赖图读不出（${graph}）：全跑`]);
  if (changed.length === 0) return fullPlan(['改动列表是空的：认不出这次改了什么，全跑']);

  const fullWhy: string[] = [];
  const reasons: string[] = [];
  /** 改到了源码的包：它们和依赖它们的都要测。 */
  const units = new Set<string>();
  /** 测试读了改到的包外文件的单元：只测它们自己（依赖它们的包不读那个文件）。 */
  const readers = new Set<string>();
  /** 取最大的：有一条要全套就全套。 */
  let deploy: DeployMode = 'none';
  for (const f of changed) {
    const rule = rules.find((r) => r.match(f));
    if (rule && 'full' in rule) {
      fullWhy.push(`${f}：${rule.full}`);
      continue;
    }
    if (rule) {
      for (const u of rule.units) readers.add(u);
      if (rule.deploy === 'all' || (rule.deploy === 'ops' && deploy === 'none')) deploy = rule.deploy;
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

  const biome = changed.some((f) => !f.endsWith('.md'));
  return {
    full: false,
    reasons,
    biome,
    tsc: biome ? all.map(unitProject) : [],
    testUnits: all,
    tests: [],
    web: closure.has('web'),
    deploy: DEPLOY_READS_PACKAGES.some((p) => closure.has(p)) ? 'all' : deploy,
  };
}

export interface TestInputs {
  /** 全部测试文件（test-split.ts 的 listTestFiles）；string 是列不出的原因。 */
  all: readonly string[] | string;
  /** 耗时表；string 是读不出的原因（照样装箱，只是分得可能不匀）。 */
  timings: Timings | string;
  /** 读测试文件的内容（认哪些要 Temporal 命令行）。 */
  read: (rel: string) => string | undefined;
}

/**
 * 把 planCi 选中的单元落到测试文件、装进几台（test-split.ts 的 packTests），填进 plan.tests。
 * 选文件这一步：全跑（plan.full）是全部测试文件，否则是选中单元下的（再加上按名字会被一起拉上的，见 withSiblings）。
 * 以后换成文件级选择，换的只是 picked 这一步，装箱只吃「要跑的测试文件」。
 * 列不出测试文件、选中的单元一个测试文件都没有、读不了某个测试文件、装不了箱：返回一句为什么，调用方判红（不静默少跑）。
 */
export function assignTests(
  plan: CiPlan,
  input: TestInputs,
): { plan: CiPlan; packed: Packed | undefined } | string {
  if (!plan.full && plan.testUnits.length === 0) return { plan, packed: undefined };
  if (typeof input.all === 'string') return `列不出测试文件：${input.all}`;
  const units = plan.full ? undefined : new Set(plan.testUnits);
  const picked = input.all.filter((f) => units === undefined || units.has(unitOfTestFile(f) ?? ''));
  if (picked.length === 0) {
    const what = plan.full ? '全部' : plan.testUnits.join('、');
    return `要测 ${what}，却一个测试文件都没有（vitest 没收到文件会红）`;
  }
  const files = withSiblings(picked, input.all);
  const temporal = new Set<string>();
  for (const f of files) {
    const text = input.read(f);
    if (text === undefined) return `读不到测试文件 ${f}（认不出它要不要 Temporal 命令行）`;
    if (TEMPORAL_MARKER.test(text)) temporal.add(f);
  }
  const packed = packTests({ files, universe: input.all, timings: input.timings, temporal });
  if (typeof packed === 'string') return `装不了箱：${packed}`;
  return { plan: { ...plan, tests: packed.boxes, reasons: [...plan.reasons, ...packed.notes] }, packed };
}

/** 写进 $GITHUB_OUTPUT 的几行；下游 job 的 if 和汇总 job 都只读这些。
 * lint job 里的 biome、tsc 两步各读自己那一份（`biome`、`tsc`）——job 级的开与不开由 ciVerdict 核，
 * 这两行只管 job 里面哪一步跑。 */
export function planOutputs(plan: CiPlan): Record<string, string> {
  return {
    plan: JSON.stringify(plan),
    biome: String(plan.biome),
    tsc: plan.tsc === 'all' ? 'all' : plan.tsc.join(' '),
    tests: JSON.stringify(plan.tests),
    web: String(plan.web),
    deploy: plan.deploy,
    deploy_matrix: JSON.stringify(deployMatrix(plan.deploy)),
  };
}

/**
 * 汇总 job 核对的几个 job（ci.yml 里的 job id）。job 数就是并发槽数（免费档同时 20 个），所以几个小检查并进
 * 同一个 job：
 * - `lint`：原来分开的 biome、tsc、docs、hygiene 四个 job 并成一个。整轮墙钟不变（几步串起来仍短于最慢的测试台），
 *   但一个 PR 少占三个并发槽。**这个 job 每次都得跑且绿**：它里面几步各自 continue-on-error、最后一步按各步的
 *   outcome 判红，所以「biome 先红 → tsc 被跳过、类型错没人看见」（#566）不会重演——红了的是 job，不是被跳过的步。
 *   哪一步该跑、哪一步该跳也由那最后一步现核（开关在 changes 的输出里），不靠 job 级的 if。
 * - `test`、`web`、`deploy`：按改动开关，该跑的必须绿、该跳的必须是跳过。
 * hygiene 现在在 lint 里面，只报不挡（红了不算进 lint 的结论，创始人 2026-09-28 傍晚拍），不在这两份名单里。
 */
export const PLANNED_JOBS = ['test', 'web', 'deploy'] as const;
export const ALWAYS_JOBS = ['changes', 'lint'] as const;

function expected(plan: CiPlan, job: (typeof PLANNED_JOBS)[number]): boolean {
  if (job === 'test') return plan.tests.length > 0;
  if (job === 'deploy') return plan.deploy !== 'none';
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
    typeof o.biome !== 'boolean' ||
    typeof o.web !== 'boolean' ||
    !(DEPLOY_MODES as readonly unknown[]).includes(o.deploy) ||
    !Array.isArray(o.tests) ||
    !(o.tsc === 'all' || Array.isArray(o.tsc)) ||
    !(Array.isArray(o.testUnits) && o.testUnits.every((u) => typeof u === 'string'))
  ) {
    return 'changes 给的 plan 认不出';
  }
  const why = testsProblem(o as CiPlan);
  return why ?? (o as CiPlan);
}

/**
 * 装好的台本身对不对：每台有名字、有文件、两个开关是真假值；一个文件不在两台里；要测的单元不空就必须有台、空就不许有台
 * （planCi 之后忘了 assignTests，test job 就会被跳过、汇总还当它本该跳过——这里拦住）。
 */
function testsProblem(plan: CiPlan): string | undefined {
  const seen = new Set<string>();
  const labels = new Set<string>();
  for (const b of plan.tests as unknown[]) {
    const x = b as Partial<TestBox> | null;
    if (
      typeof x !== 'object' ||
      x === null ||
      typeof x.label !== 'string' ||
      x.label === '' ||
      !Array.isArray(x.files) ||
      x.files.length === 0 ||
      x.files.some((f) => typeof f !== 'string' || f === '') ||
      typeof x.estMs !== 'number' ||
      !Number.isFinite(x.estMs) ||
      typeof x.pg !== 'boolean' ||
      typeof x.temporal !== 'boolean'
    ) {
      return 'changes 给的测试台认不出（缺名字、文件清单、开关）';
    }
    if (labels.has(x.label)) return `两台测试同名：${x.label}`;
    labels.add(x.label);
    for (const f of x.files) {
      if (seen.has(f)) return `${f} 分到了两台`;
      seen.add(f);
    }
  }
  const want = plan.full || plan.testUnits.length > 0;
  if (want !== plan.tests.length > 0) {
    return want ? 'plan 有要测的单元，却一台测试都没装（没装箱？）' : 'plan 没有要测的单元，却装了测试台';
  }
  return undefined;
}

/**
 * 汇总 job 的结论：`needs` 是 ci.yml 里 `toJSON(needs)` 原样给的。每个 job 的 result 必须是
 * 「本该跑 → success、本该不跑 → skipped」，changes、docs 必须 success；有一条不对、认不出，就不通过。
 * hygiene 不在这条判定里（红了不挡，见 ALWAYS_JOBS 的注释），但 ci.yml 仍然 needs 它，check 会等它跑完。
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
  // test job 的矩阵铺的是 outputs.tests：必须和 plan 里核过的那份是同一份
  if (n.changes?.outputs?.tests !== JSON.stringify(plan.tests))
    bad('changes 给 test job 铺矩阵的 tests 和 plan 里的测试台不是同一份');
  if (plan.full && (PLANNED_JOBS.some((j) => !expected(plan, j)) || plan.deploy !== 'all'))
    bad('plan 说全跑，却有 job 没开（或 deploy 不是全套）');
  for (const job of PLANNED_JOBS) {
    const want = expected(plan, job) ? 'success' : 'skipped';
    const r = n[job]?.result;
    if (r === want) lines.push(`✓ ${job}：${r}`);
    else bad(`${job}：${r === undefined ? '没有这个 job 的结果' : String(r)}，本该 ${want}`);
  }
  return { ok, lines };
}
