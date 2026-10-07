// CI 按改动跑（.github/workflows/ci.yml）：从这次 PR 改了哪些文件、各包谁依赖谁，算出哪几个 job 要跑、测试跑哪几个包，
// 再把选中的测试文件按耗时装进几台（assignTests → test-split.ts）；
// 汇总 job（必过检查 check）再逐个核对「该跑的跑了且绿、不该跑的确实跳过」。纯判断，不碰 git、不碰网络；入口在 bin/ci-plan.ts、bin/ci-verdict.ts。
// 本机的 test:changed（test-changed.ts）、推前预检（prepare-push.ts）也只问这里：改这里的判法，本机那两样跟着变。
// job 数就是并发槽数（GitHub 免费档同时最多 20 个，一个 PR 的 CI 占掉越多，能并着跑的 PR 越少）：所以把两两不相干的小检查
// 装进同一个 job（lint），装依赖只装一次；同一件事别开两个 job。见 PLANNED_JOBS 上面的注释。
// 三态纪律：认不出的路径、读不出的依赖图、空的改动列表、非 PR 事件一律升成全跑，不拿「没改什么」冒充可以少跑。
// 改这里之前必须知道：
// - 测试不只读自己包里的文件（读别的包的源码、夹具，读 docs/ops.md、AGENTS.md、deploy/ 下的脚本）。PATH_RULES 和 TEST_READS
//   就是这些「谁的测试读谁」的清单；test/ci-plan.test.ts 扫所有测试文件里指向包外的路径，漏记一条就红。
// - 这里判「少跑」等于放行没测过的改动，改它要连测试一起看。
import { type Reuse, reuseOf } from './main-reuse.ts';
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

/** e2e 要跑的 spec：'all' 全套；数组是只跑这几个（仓内相对路径）；空数组不跑。见 CiPlan.e2e。 */
export type E2eSpecs = 'all' | string[];

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
  /**
   * 驾驶舱用户视角 e2e（真 Postgres + 真后端 + 真前端 + Chromium，packages/web/e2e，#930）：一个 job、要几分钟。
   * 决定 0029（#1186）：PR 只点改动页，输出是「跑哪些 spec」而不是「跑不跑」：
   * - `'all'`：全套 spec。非 PR 事件（每夜 schedule、主线推送）、依赖图读不出、空改动、认不出的路径、
   *   改到 e2e 夹具、playwright 配置、ci.yml、映射表本身、映射不到页面的 web 文件，都是全套（不确定就全跑）。
   * - 非空数组：只跑这几个 spec（仓内相对路径，来自 E2E_PAGE_MAP 或改到的 spec 文件自己）。
   * - 空数组：这次不跑 e2e（只改 api、只改测试文件、改的页面没有 spec 盖着），回归靠每夜全量兜底；汇总 job 把 e2e job 的 skipped 当「本该跳过」。
   * 注意它和 full 不同步：全跑（deploy/ 脚本、根配置这类升的全跑）不一定开 e2e，见 planCi。
   */
  e2e: E2eSpecs;
  /** deploy/test/run.sh：all 全套；ops 只跑读 docs/ops.md 的两块（`run.sh --ops`：端口表、place-file）；none 不跑。 */
  deploy: DeployMode;
  /**
   * 只有主线推送会有：这一轮的 test、web、deploy 不重测，复用了一次同树、同基准树、成功的 PR 检查（main-reuse.ts 判）。
   * 有它时 tests 空、web 假、deploy none——汇总 job 据此认「这三个 job 本该跳过」，同时核对它是主线事件上带来的、字段齐全。
   */
  reused?: Reuse;
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
 * agents/test/worker.test.ts 读 db 的路由骨架 routing.default.json（本机启动器照它定思考档位，#470）；
 * agents/test/rules/prompt-log.rules.test.ts 读 agents-sync 的 targets.ts（钩子登记表，钉住 UserPromptSubmit 那条）。
 */
export const TEST_READS: Record<string, string[]> = {
  api: ['web'],
  feishu: ['web'],
  db: ['core'],
  [AGENTS_UNIT]: ['db', 'agents-sync'],
};

export type Rule =
  | { match: (f: string) => boolean; full: string }
  | { match: (f: string) => boolean; units: string[]; deploy?: 'all' | 'ops'; why: string };

const exact = (p: string) => (f: string) => f === p;
const under = (p: string) => (f: string) => f.startsWith(p);

/**
 * 哪些改动要跑驾驶舱 e2e（#930）。
 *
 * **2026-10-05 收窄**（创始人「现在全套 e2e 流程太长了，要 300+ 秒，我不认可每个 pr 都要这种流程」，
 * 按五步法的「删」）：原来碰 `web`/`api`/`db`/`shared` **或**根配置（package.json、锁文件、workspace）
 * 就开。实测这台 job 364 秒（全仓最长的一块，其余全在 90 秒内），而最近 40 个合并 PR 里碰 `web` 的只有
 * 6 个、`api` 3 个、`db` 2 个、`shared` 2 个——**拿 17% 的场景罚了 100% 的 PR**。
 *
 * 现在只认真正会改变「用户在页面上看到或点到的东西」的那两个包：
 * - `web`（前端本身）、`api`（它起的真入口、页面读的后端）；
 * - `.github/workflows/ci.yml` 自己（改了 e2e 的定义就该跑一遍）。
 * `db` 和 `shared` 不再单独触发：它们各有自己的单测和契约测试把关，e2e 不是替它们兜底的；
 * 根配置（锁文件、package.json、workspace）同理——「装不装得上依赖」由别的 job 管。
 * 全量回归有兜底：这些路径的改动由**每天一次的定时轮**在 main 上跑全套（ci.yml 的 schedule）。
 *
 * 别的包（core、engine、github……）一如既往不开：每多开一档就是多一个几分钟的 job 占并发槽
 * （免费档全账号同时 20 个，见 specs/901-项目瘦身与提速/CI耗时实测.md 第 6 条）。
 *
 * **要补的那条证据：量不出来，样本是 0**（2026-10-05，#1002 合并后复查的第 2 条）。
 * 方案 `specs/995-断链统一/方案.md:71` 要求先量「只改 db/shared 的 PR，e2e 抓到过单测漏掉的错没有」。
 * 实测：e2e 进 CI 是 2026-10-04 20:26（#985），收窄是 2026-10-05 02:48（#1002），中间六小时里跑过 e2e 的
 * 只有 #985（它自己，改的就是 ci.yml）和 #991（发布，只改 CHANGELOG）——**没有一个只改 db/shared 的 PR**。
 * 所以这不是「没抓到」，是**没有可比的样本**。要真拿证据，得等上面那轮定时全量跑过几轮之后再看它有没有
 * 抓到 db/shared 的集成错；抓到了就恢复这一档触发或补针对性测试。量法：逐 PR 看 `gh pr checks <号>` 的
 * `e2e` 与 `test` 两项状态。
 */
/**
 * **2026-10-07 再拆开（决定 0029，#1186）**：PR 只点改动页，全量回归留给每夜（非 PR 事件在 planCi 里一律 'all'）。
 * 上面那段说的「web、api 一碰就整套」不再是现状：现在按改到的文件算出要跑哪几个 spec（e2eSpecsFor）。
 *
 * 判法，逐个改动文件：
 * - 全套：`.github/workflows/ci.yml`、本文件（映射表就写在这里，改了表要全跑一遍验表）、
 *   `packages/web/e2e/` 里 specs 以外的东西（夹具 support/、playwright 配置）、`packages/api/test/e2e/`（e2e 的备库）、
 *   `packages/web` 里不在 E2E_PAGE_MAP 的文件（共享组件、样式、路由骨架、壳、依赖这类：不知道会碰到哪一页，不拿「没映射」冒充不用跑）。
 * - 只那几个 spec：E2E_PAGE_MAP 里的页面私有文件；改到的 spec 文件自己（文件名合规且还在）。
 * - 不跑：`packages/api` 的其余改动（只改后端、靠每夜全量兜底，单上第 1 条）、web 里的测试文件和 .md、
 *   映射表里写明「没有 spec 盖着」的页面（法国总览、占位页）。
 * 别的包、根配置、文档：和 2026-10-05 收窄后一样不触发（认不出的路径另由 planCi 的 unknown 升成全套）。
 */
export const E2E_SPEC_DIR = 'packages/web/e2e/specs/';
const spec = (stem: string) => `${E2E_SPEC_DIR}${stem}.e2e.ts`;
/** 一页的私有文件（只有这一页的路由引用它，用反向引用扫过确认）→ 点验它的 spec。files 以 / 结尾的是目录前缀，其余是整条路径；specs 为空 = 这页没有 spec。 */
export interface E2ePageEntry {
  files: readonly string[];
  specs: readonly string[];
}
const W = 'packages/web/src/';
export const E2E_PAGE_MAP: readonly E2ePageEntry[] = [
  // 登录页（01）。password-field 登录页和设置页「账密登录」共用
  { files: [`${W}routes/login.tsx`], specs: [spec('01-login')] },
  { files: [`${W}components/password-field.tsx`], specs: [spec('01-login'), spec('10-credentials')] },
  // 主页（02）；07c 在主页上切环境，08 从别页点回主页
  {
    files: [
      `${W}routes/home.tsx`,
      `${W}components/home/`,
      `${W}components/not-built.tsx`,
      `${W}lib/home-flow-layout.ts`,
    ],
    specs: [spec('02-home'), spec('07c-nodes'), spec('08-backend-down')],
  },
  // 主页和单子详情共用
  { files: [`${W}lib/segments.ts`], specs: [spec('02-home'), spec('03-task')] },
  // 单子详情（03）
  {
    files: [
      `${W}routes/task.tsx`,
      `${W}components/run-timeline.tsx`,
      `${W}components/segment-usage.tsx`,
      `${W}components/usage.tsx`,
      `${W}components/route-label.tsx`,
      `${W}lib/usage.ts`,
    ],
    specs: [spec('03-task')],
  },
  // 额度页（04）；05 在设置页改了开关后回额度页核对，07c 看远程环境的额度页，08 用它造后端断开
  {
    files: [
      `${W}routes/quota.tsx`,
      `${W}components/quota.tsx`,
      `${W}components/carpool-reconcile.tsx`,
      `${W}components/org-switch.tsx`,
    ],
    specs: [spec('04-quota'), spec('05-settings'), spec('07c-nodes'), spec('08-backend-down')],
  },
  // 设置页（05）；08 在设置页上造后端断开，10 是设置页的「账密登录」一节
  {
    files: [
      `${W}routes/settings.tsx`,
      `${W}components/pool-holds.tsx`,
      `${W}components/repo-dispatch.tsx`,
      `${W}lib/pool-holds.ts`,
      `${W}lib/reserve.ts`,
    ],
    specs: [spec('05-settings'), spec('07b-env'), spec('08-backend-down'), spec('10-credentials')],
  },
  { files: [`${W}components/credentials-section.tsx`], specs: [spec('10-credentials')] },
  // 通知中心（06）；08 站内跳到它造后端断开
  { files: [`${W}routes/notifications.tsx`], specs: [spec('06-notifications'), spec('08-backend-down')] },
  // 环境页（07b、07c 并排看多机）
  {
    files: [`${W}routes/env.tsx`, `${W}components/engine-master-card.tsx`],
    specs: [spec('07b-env'), spec('07c-nodes')],
  },
  // 其余页（07）：路由、思考档位、定时任务、操作记录、更新日志、演示链接、找不到的页面
  {
    files: [
      `${W}routes/routing.tsx`,
      `${W}routes/routing-status.tsx`,
      `${W}routes/efforts.tsx`,
      `${W}routes/changelog.tsx`,
      `${W}routes/demo-links.tsx`,
      `${W}routes/not-found.tsx`,
      `${W}components/channel-status.tsx`,
      `${W}components/routing-edit.tsx`,
      `${W}lib/channel-status.ts`,
      `${W}lib/provider-status.ts`,
      `${W}lib/efforts.ts`,
      `${W}lib/changelog.ts`,
      `${W}demo/labels.ts`,
    ],
    specs: [spec('07-other-pages')],
  },
  // 定时任务页：08 点它造后端 500
  {
    files: [`${W}routes/schedules.tsx`, `${W}lib/schedule.ts`],
    specs: [spec('07-other-pages'), spec('08-backend-down')],
  },
  // 操作记录页和设置页共用 lib/audit；10 也去操作记录里核对
  {
    files: [`${W}routes/audit.tsx`, `${W}lib/audit.ts`],
    specs: [spec('05-settings'), spec('07-other-pages'), spec('10-credentials')],
  },
  // 法国总览和占位页：没有任何 spec 点它们（specs 里没有 goto），改它们不跑 e2e，靠每夜全量里别页的回归兜底
  { files: [`${W}routes/france.tsx`, `${W}routes/soon.tsx`], specs: [] },
];

/** 夹具、配置、备库：e2e 自己的地基，改了就是全套。 */
const E2E_FULL_PREFIXES: readonly string[] = ['packages/web/e2e/', 'packages/api/test/e2e/'];
const E2E_FULL_FILES: readonly string[] = ['.github/workflows/ci.yml', 'packages/conventions/src/ci-plan.ts'];
/** 合规的 spec 文件名（会被原样交给 playwright 当参数，所以只认安全字符）。 */
const E2E_SPEC_FILE = /^packages\/web\/e2e\/specs\/[A-Za-z0-9._-]+\.e2e\.ts$/;
/** web 里只给 vitest 用的：改了不影响 e2e 起的真前端。 */
const WEB_TEST_FILE = /\.test\.tsx?$/;
const WEB_TEST_DIR = 'packages/web/src/test/';

/**
 * 这批改动要跑的 e2e spec（规则见上面 E2E_PAGE_MAP 的注释）。specExists 给了时，改到的 spec 文件已经不在了（删了）就不再点名它；
 * 映射表里的 spec 不做存在检查（表里写错了让 playwright 找不到、job 红，比悄悄少跑好；有测试核对表里每条都在）。
 */
export function e2eSpecsFor(changed: readonly string[], specExists?: (rel: string) => boolean): E2eSpecs {
  const specs = new Set<string>();
  for (const f of changed) {
    if (f.endsWith('.md')) continue;
    if (E2E_FULL_FILES.includes(f)) return 'all';
    if (E2E_SPEC_FILE.test(f)) {
      if (specExists === undefined || specExists(f)) specs.add(f);
      continue;
    }
    if (E2E_FULL_PREFIXES.some((p) => f.startsWith(p))) return 'all';
    const pkg = /^packages\/([^/]+)\//.exec(f)?.[1];
    if (pkg !== 'web') continue; // api 的其余改动（只改后端）和别的包都不开
    if (WEB_TEST_FILE.test(f) || f.startsWith(WEB_TEST_DIR)) continue;
    const hit = E2E_PAGE_MAP.find((e) => e.files.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p)));
    if (hit === undefined) return 'all';
    for (const s of hit.specs) specs.add(s);
  }
  return [...specs].sort();
}

/** 这份 e2e 清单要不要起 e2e job。 */
export const e2eRuns = (e: E2eSpecs): boolean => e === 'all' || e.length > 0;

/** 写进 $GITHUB_OUTPUT 的 e2e 值：'all' | 空格隔开的 spec 路径（相对 packages/web，e2e job 在那里跑 playwright）| 空串（不跑）。 */
export function e2eOutput(e: E2eSpecs): string {
  return e === 'all' ? 'all' : e.map((s) => s.replace(/^packages\/web\//, '')).join(' ');
}

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
  // agents/ 是 agents-sync 的输入，也是 agents 单测的输入：通用段原件 agents/shared-rules.md 标记成对、skill 格式由
  // agents-sync 和 agents 的单测读真文件核对，通用段自己也被 agents 的钉子测试读（agents/test/rules/ 读这几条规矩在不在，#522）。
  // 仓根 AGENTS.md 只剩本仓段，照样有两家读它：agents 的字数预算测试量本仓段，agents-sync 核它不再带通用段（带了会读两遍）。
  // deploy/test 的同步测试只验换身份写文件，内容换了结果不变，所以不跑 deploy（纯说明 PR 曾被拖 2 分多钟）。
  {
    match: exact('AGENTS.md'),
    units: [AGENTS_UNIT, 'agents-sync'],
    why: 'agents 的测试量本仓段字数，agents-sync 核它不再带通用段',
  },
  // 引擎起 Claude 会话经 --settings 直接用仓里这份调工具前的钩子（adapters 的 PRETOOL_SCRIPT），adapters 的测试真跑它
  {
    match: under('agents/hooks/'),
    units: [AGENTS_UNIT, 'agents-sync', 'adapters'],
    why: '钩子由 agents-sync 分发，引擎起 Claude 会话也直接用仓里这份',
  },
  // conventions 的 intents-host.test.ts 拿登法国的 ssh 名字和法国引擎页（france-lib.mjs，import france-query.mjs）对拍
  {
    match: under('agents/skills/commander/scripts/france-'),
    units: [AGENTS_UNIT, 'agents-sync', 'conventions'],
    why: 'skill 由 agents-sync 分发；conventions 的测试拿 ssh 名字的判法和它对拍',
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

/** e2e 默认全套：升全跑的原因里有「认不出改了什么」时不能拿它冒充可以少跑；只有 planCi 能确定「全跑是因为 deploy/、根配置这类、没碰 e2e 认的路径」时才传别的清单。 */
function fullPlan(reasons: string[], e2e: E2eSpecs = 'all'): CiPlan {
  return {
    full: true,
    reasons,
    biome: true,
    tsc: 'all',
    testUnits: [],
    tests: [],
    web: true,
    e2e,
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
  /** 仓里有没有这个文件：e2e 清单里改到的 spec 文件被删了就不再点名。不给 = 都当还在。 */
  specExists?: (rel: string) => boolean;
}

/** 测试读这些包的文件、package.json 里却没依赖它们的单元（TEST_READS；不往下传）。 */
function testReaders(pkgs: ReadonlySet<string>): string[] {
  return Object.entries(TEST_READS)
    .filter(([, reads]) => reads.some((r) => pkgs.has(r)))
    .map(([reader]) => reader);
}

/** 一份改动按 PATH_RULES 和依赖图分拣的结果。planCi 和 fallbackUnits 都从这一步算，两边不各写一套「改动落在哪」。 */
interface Sorted {
  /** 升全跑的文件和为什么。 */
  fullWhy: string[];
  /** 升全跑的文件落在的包：shared、测试夹具所在的包、不在依赖图里的包目录。 */
  hubs: Set<string>;
  /** 改到了源码的包：它们和依赖它们的都要测。 */
  units: Set<string>;
  /** 测试读了改到的包外文件的单元：只测它们自己（依赖它们的包不读那个文件）。 */
  readers: Set<string>;
  reasons: string[];
  /** 取最大的：有一条要全套就全套。 */
  deploy: DeployMode;
  /** 有文件认不出（不在依赖图里的包目录、不在任何规则里的路径）：这次改了什么不确定，e2e 不许当成不用跑。 */
  unknown: boolean;
}

function sortChanges(
  changed: readonly string[],
  inGraph: (pkg: string) => boolean,
  rules: readonly Rule[],
): Sorted {
  const s: Sorted = {
    fullWhy: [],
    hubs: new Set(),
    units: new Set(),
    readers: new Set(),
    reasons: [],
    deploy: 'none',
    unknown: false,
  };
  for (const f of changed) {
    const rule = rules.find((r) => r.match(f));
    const pkg = /^packages\/([^/]+)\//.exec(f)?.[1];
    if (rule && 'full' in rule) {
      s.fullWhy.push(`${f}：${rule.full}`);
      if (pkg !== undefined) s.hubs.add(pkg);
      continue;
    }
    if (rule) {
      for (const u of rule.units) s.readers.add(u);
      if (rule.deploy === 'all' || (rule.deploy === 'ops' && s.deploy === 'none')) s.deploy = rule.deploy;
      s.reasons.push(`${f}：${rule.why}${rule.units.length > 0 ? `，测 ${rule.units.join('、')}` : ''}`);
      continue;
    }
    if (pkg !== undefined && inGraph(pkg)) {
      s.units.add(pkg);
      continue;
    }
    s.fullWhy.push(`${f}：${pkg !== undefined ? `packages/${pkg} 不在依赖图里` : '认不出的路径'}，全跑`);
    s.unknown = true;
    if (pkg !== undefined) s.hubs.add(pkg);
  }
  return s;
}

export function planCi({ event, changed, graph, rules = PATH_RULES, specExists }: PlanInput): CiPlan {
  if (event !== 'pull_request') return fullPlan([`${event} 事件：全跑（主线上兜底）`]);
  if (typeof graph === 'string') return fullPlan([`包依赖图读不出（${graph}）：全跑`]);
  if (changed.length === 0) return fullPlan(['改动列表是空的：认不出这次改了什么，全跑']);

  const s = sortChanges(changed, (pkg) => Object.hasOwn(graph.deps, pkg), rules);
  // e2e 单独判：全跑的原因（deploy/、根配置这类）不一定碰 e2e 认的路径；认不出的路径则全套（不确定就跑）
  const e2e: E2eSpecs = s.unknown ? 'all' : e2eSpecsFor(changed, specExists);
  if (s.fullWhy.length > 0) return fullPlan(s.fullWhy, e2e);

  const closure = dependentsClosure(graph, s.units);
  const reasons = [...s.reasons];
  if (closure.size > 0) reasons.push(`改到源码的包和依赖它们的：${[...closure].sort().join('、')}`);
  const all = [...new Set([...closure, ...s.readers, ...testReaders(closure)])].sort();

  const biome = changed.some((f) => !f.endsWith('.md'));
  return {
    full: false,
    reasons,
    biome,
    tsc: biome ? all.map(unitProject) : [],
    testUnits: all,
    tests: [],
    web: closure.has('web'),
    e2e,
    deploy: DEPLOY_READS_PACKAGES.some((p) => closure.has(p)) ? 'all' : s.deploy,
  };
}

/** planCi 判出全跑、本机又不全跑时，先跑哪些（fallbackUnits）。 */
export interface Fallback {
  /** 先跑的单元。 */
  units: string[];
  /** 升全跑的文件落在的包（shared、测试夹具所在的包这类）：它们自己在 units 里。 */
  hubs: string[];
  /** 依赖 hubs 的、units 里没有的单元：CI 全跑会测到，本机不逐个跑。依赖图读不出是一句为什么（不拿空清单冒充「没人依赖」）。 */
  dependents: string[] | string;
}

/**
 * planCi 判出全跑、本机又不全跑时（test:changed：几个会话同时全跑会把机器拖满）先跑哪些——同一份判法，只是放下「升全跑」那一档：
 * - 没升全跑的文件照 planCi：改到的包和直接间接依赖它们的、测试读到改动的单元。改动里没有升全跑的文件时，units 就是 planCi 的 testUnits；
 * - 升全跑的文件落在某个包下的（shared、测试夹具、不在依赖图里的包目录）只算那个包自己：依赖它的（升全跑正是因为几乎都依赖它）
 *   放进 dependents，写给人看；
 * - 根配置、CI 工作流、deploy/、认不出的路径不落在哪个单元，什么都不加（全量交给 CI）。
 */
export function fallbackUnits(
  changed: readonly string[],
  graph: PackageGraph | string,
  rules: readonly Rule[] = PATH_RULES,
): Fallback {
  if (typeof graph === 'string') {
    const s = sortChanges(changed, () => true, rules);
    return {
      units: [...new Set([...s.units, ...s.readers, ...s.hubs])].sort(),
      hubs: [...s.hubs].sort(),
      dependents: `包依赖图读不出（${graph}），依赖改到的包的算不出来`,
    };
  }
  const s = sortChanges(changed, (pkg) => Object.hasOwn(graph.deps, pkg), rules);
  const closure = dependentsClosure(graph, s.units);
  const units = new Set([...closure, ...s.readers, ...testReaders(closure), ...s.hubs]);
  const users = dependentsClosure(graph, s.hubs);
  const dependents = [...new Set([...users, ...testReaders(users)])].filter((u) => !units.has(u)).sort();
  return { units: [...units].sort(), hubs: [...s.hubs].sort(), dependents };
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

/**
 * 主线这一轮复用了一次同树的 PR 检查（main-reuse.ts 已经核过树和基准树）：test、web、deploy 不再测。biome、tsc 的开关不动
 * （lint 本来就每轮自己跑一遍）。plan 先按区间算好、装好箱再交进来：被跳过的是「本来要测的」，不是「什么都不用测」。
 */
export function applyReuse(plan: CiPlan, reuse: Reuse): CiPlan {
  const wasTesting = plan.full
    ? '全部测试'
    : `${plan.tests.reduce((n, b) => n + b.files.length, 0)} 个测试文件`;
  return {
    ...plan,
    full: false,
    testUnits: [],
    tests: [],
    web: false,
    e2e: [],
    deploy: 'none',
    reused: reuse,
    reasons: [
      ...plan.reasons,
      `同树复用：这次主线提交的树和 PR #${reuse.pr} 的检查（运行 ${reuse.run}）测的是同一棵、基准也是上次真绿的头；` +
        `本来要测的（${wasTesting}${plan.web ? '、web' : ''}${e2eRuns(plan.e2e) ? '、e2e' : ''}${plan.deploy === 'none' ? '' : `、deploy ${plan.deploy}`}）不再重测`,
    ],
  };
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
    e2e: e2eOutput(plan.e2e),
    deploy: plan.deploy,
    deploy_matrix: JSON.stringify(deployMatrix(plan.deploy)),
    // 复用的那次 PR 检查的运行号；没复用是空串。汇总 job 核它和 plan 里的是同一份。
    reused: plan.reused ? String(plan.reused.run) : '',
  };
}

/**
 * 汇总 job 核对的几个 job（ci.yml 里的 job id）。job 数就是并发槽数（免费档同时 20 个），所以几个小检查并进
 * 同一个 job：
 * - `lint`：原来分开的 biome、tsc、docs、hygiene 四个 job 并成一个。整轮墙钟不变（几步串起来仍短于最慢的测试台），
 *   但一个 PR 少占三个并发槽。**这个 job 每次都得跑且绿**：它里面几步各自 continue-on-error、最后一步按各步的
 *   outcome 判红，所以「biome 先红 → tsc 被跳过、类型错没人看见」（#566）不会重演——红了的是 job，不是被跳过的步。
 *   哪一步该跑、哪一步该跳也由那最后一步现核（开关在 changes 的输出里），不靠 job 级的 if。
 * - `test`、`web`、`e2e`、`deploy`：按改动开关，该跑的必须绿、该跳的必须是跳过（e2e 红、取消、被误跳过都不过，#930）。
 * hygiene 现在在 lint 里面，只报不挡（红了不算进 lint 的结论，创始人 2026-09-28 傍晚拍），不在这两份名单里。
 */
export const PLANNED_JOBS = ['test', 'web', 'e2e', 'deploy'] as const;
/**
 * 全跑（plan.full）时必须开的 job：e2e 不在里面——它按 e2eSpecsFor 单独判（全跑的原因是 deploy/ 或根配置时不开），
 * 开不开由 changes 的 e2e 输出和 plan.e2e 对账（同一份），汇总照 plan.e2e 核 job 的结果。
 */
const FULL_JOBS = PLANNED_JOBS.filter((j) => j !== 'e2e');
export const ALWAYS_JOBS = ['changes', 'lint'] as const;

/**
 * CI 不管改了什么都跑的测试：lint job 里 docs 那一步（.github/workflows/ci.yml 写死同一份；test/test-changed.test.ts 现读
 * ci.yml，两边多一份少一份都红）。本机 test:changed 给出的清单不管选中什么、拒不拒跑都带上它们（#740：拒跑时漏过）。
 */
export const ALWAYS_TESTS: readonly string[] = Object.freeze([
  'packages/conventions/test/doc-pointers.test.ts',
  'agents/test/',
]);

function expected(plan: CiPlan, job: (typeof PLANNED_JOBS)[number]): boolean {
  if (job === 'test') return plan.tests.length > 0;
  if (job === 'deploy') return plan.deploy !== 'none';
  if (job === 'web') return plan.web;
  return e2eRuns(plan.e2e);
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
    !(o.e2e === 'all' || (Array.isArray(o.e2e) && o.e2e.every((x) => typeof x === 'string'))) ||
    !(DEPLOY_MODES as readonly unknown[]).includes(o.deploy) ||
    !Array.isArray(o.tests) ||
    !(o.tsc === 'all' || Array.isArray(o.tsc)) ||
    !(Array.isArray(o.testUnits) && o.testUnits.every((u) => typeof u === 'string'))
  ) {
    return 'changes 给的 plan 认不出';
  }
  const why = testsProblem(o as CiPlan);
  if (why !== undefined) return why;
  if ('reused' in o && o.reused !== undefined) {
    const reused = reuseOf(o.reused);
    if (reused === null) return 'changes 给的 plan 里 reused（同树复用）字段不齐全';
    if (o.full || o.testUnits?.length || o.tests?.length || o.web || e2eRuns(o.e2e) || o.deploy !== 'none')
      return 'plan 说复用了同树的 PR 检查，却还有要测的 test、web、e2e、deploy';
    return { ...(o as CiPlan), reused };
  }
  return o as CiPlan;
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
export function ciVerdict(needs: unknown, event?: string): { ok: boolean; lines: string[] } {
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
  // e2e job 的 if 读的是 outputs.e2e：必须和 plan 里核过的是同一份（不然 job 的开关和汇总核的「本该跑不跑」各说各的）。
  // GitHub 不把值为空串的 job 输出放进 needs.<job>.outputs（清单为空时这一项整个没有），所以没有这一项按空串比；
  // plan 要跑（'all' 或有清单）而输出缺了，照样不等、判红。
  if ((n.changes?.outputs?.e2e ?? '') !== e2eOutput(plan.e2e))
    bad('changes 给 e2e job 的开关（outputs.e2e）和 plan 里的 e2e 不是同一份');
  if (plan.full && (FULL_JOBS.some((j) => !expected(plan, j)) || plan.deploy !== 'all'))
    bad('plan 说全跑，却有 job 没开（或 deploy 不是全套）');
  // 同树复用（主线推送才有）：test、web、deploy 本该跳过的依据。只认主线事件、且 changes 的输出和 plan 里是同一次运行；
  // 事件没给（旧调用）、不是 push 都不认——一个 PR 的 plan 不能靠它把测试变成「本该跳过」。
  const claimedRun = n.changes?.outputs?.reused;
  if (plan.reused) {
    if (event !== 'push')
      bad(`plan 说复用了同树的 PR 检查，但这一轮不是主线推送（事件：${event ?? '没给'}）`);
    if (claimedRun !== String(plan.reused.run)) bad('changes 的 reused 输出和 plan 里复用的运行号不是同一份');
    lines.push(
      `✓ 同树复用：test、web、deploy 复用 PR #${plan.reused.pr} 的检查（运行 ${plan.reused.run}），不重测`,
    );
  } else if (typeof claimedRun === 'string' && claimedRun !== '') {
    bad('changes 给了 reused 输出，plan 里却没有复用的记录');
  }
  for (const job of PLANNED_JOBS) {
    const want = expected(plan, job) ? 'success' : 'skipped';
    const r = n[job]?.result;
    if (r === want) lines.push(`✓ ${job}：${r}`);
    else bad(`${job}：${r === undefined ? '没有这个 job 的结果' : String(r)}，本该 ${want}`);
  }
  return { ok, lines };
}
