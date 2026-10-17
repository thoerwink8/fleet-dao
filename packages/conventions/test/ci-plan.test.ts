import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { keyCovers, keyRoots, sourceClosure } from '../src/ci-cache.ts';
import {
  AGENTS_UNIT,
  ALWAYS_JOBS,
  ALWAYS_TESTS,
  applyReuse,
  assignTests,
  type CiPlan,
  ciFullPlan,
  ciVerdict,
  dependentsClosure,
  E2E_PAGE_MAP,
  E2E_SPEC_DIR,
  e2eRuns,
  e2eSpecsFor,
  fallbackUnits,
  PATH_RULES,
  type PackageGraph,
  PLANNED_JOBS,
  planCi,
  planOutputs,
  readGraph,
  TEST_READS,
} from '../src/ci-plan.ts';
import { fsRepo } from '../src/repo.ts';
import { listTestFiles, parseTimings, type TestBox, TIMINGS_FILE } from '../src/test-split.ts';
import { runChild } from './child.ts';
import { memRepo } from './helpers.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const REAL = readGraph(fsRepo(ROOT));
const graph = (): PackageGraph => {
  if (typeof REAL === 'string') throw new Error(REAL);
  return REAL;
};
const pr = (...changed: string[]) => planCi({ event: 'pull_request', changed, graph: graph() });
/** 要测的单元（engine、db、rest 那三组没了：现在只到单元，落到文件和分台是 assignTests 的事）。 */
const units = (p: CiPlan) => p.testUnits;
/** 本仓的耗时表（装箱要用；每个 PR 都读同一份，读一次）。 */
const TIMINGS = parseTimings(readFileSync(join(ROOT, TIMINGS_FILE), 'utf8'));
const REPO = fsRepo(ROOT);
const ALL_TESTS = listTestFiles(REPO);
if (typeof ALL_TESTS === 'string') throw new Error(ALL_TESTS);
if (typeof TIMINGS === 'string') throw new Error(TIMINGS);
const inputs = { all: ALL_TESTS, timings: TIMINGS, read: (rel: string) => REPO.read(rel) };
/** 装箱之后的计划（和 changes job 的入口同一条路：planCi → assignTests）。 */
const assigned = (p: CiPlan): CiPlan => {
  const r = assignTests(p, inputs);
  if (typeof r === 'string') throw new Error(r);
  return r.plan;
};
/** 每一台分到的文件（排好序的清单）。 */
const boxFiles = (p: CiPlan) => p.tests.map((b) => b.files);
/** 每一台的名字（看得出装了什么：第几台/共几台、pg、temporal）。 */
const labels = (p: CiPlan) => p.tests.map((b) => b.label);
/** 要测的单元目录（本机 test:changed 交给 vitest 的那几个；CI 走装箱，见 ci-box）。 */
const testArgs = (p: CiPlan) => units(p).map((u) => (u === AGENTS_UNIT ? 'agents/' : `packages/${u}/`));

describe('依赖图：从 packages/*/package.json 读', () => {
  it('本仓：每个包都在，engine 依赖 db、api 依赖 github', () => {
    const g = graph();
    for (const dir of readdirSync(join(ROOT, 'packages'))) expect(g.deps, dir).toHaveProperty(dir);
    expect(g.deps.engine).toContain('db');
    expect(g.deps.api).toContain('github');
    expect(g.deps.shared).toEqual([]);
  });

  it('读不出就说为什么，不拿空图顶上：缺 package.json、不是 JSON、没有 name、依赖的仓内包找不到、目录名怪、一个包都没有', () => {
    const ok = JSON.stringify({ name: '@fleet-dao/a' });
    expect(readGraph(memRepo({ 'packages/a/package.json': ok, 'packages/b/': '' }))).toBe(
      '读不到 packages/b/package.json',
    );
    expect(readGraph(memRepo({ 'packages/a/package.json': '{' }))).toMatch(
      /^packages\/a\/package.json 不是 JSON/,
    );
    expect(readGraph(memRepo({ 'packages/a/package.json': '{}' }))).toBe('packages/a/package.json 没有 name');
    expect(
      readGraph(
        memRepo({
          'packages/a/package.json': JSON.stringify({
            name: '@fleet-dao/a',
            dependencies: { '@fleet-dao/x': '*' },
          }),
        }),
      ),
    ).toBe('packages/a 依赖的 @fleet-dao/x 在 packages/ 下找不到');
    expect(readGraph(memRepo({ 'packages/A b/package.json': ok }))).toBe('包目录名认不出：packages/A b');
    expect(readGraph(memRepo({ 'packages/': '' }))).toBe('packages/ 下一个包都没有');
    expect(readGraph(memRepo({ 'x.md': '' }))).toBe('列不出 packages/');
  });

  it('依赖图读不出：升成全跑，理由里写着为什么', () => {
    const p = planCi({
      event: 'pull_request',
      changed: ['docs/design.md'],
      graph: '读不到 packages/b/package.json',
    });
    expect(p.full).toBe(true);
    expect(p.reasons.join()).toContain('读不到 packages/b/package.json');
  });
});

describe('按改动算要跑什么', () => {
  it('主线推送、别的事件：全跑（兜底）', () => {
    for (const event of ['push', 'workflow_dispatch', 'merge_group']) {
      const p = planCi({ event, changed: ['README.md'], graph: graph() });
      expect(p.full, event).toBe(true);
      expect(p).toMatchObject({ biome: true, tsc: 'all', web: true, deploy: 'all' });
      // 全跑：单元清单空（full 就是「全部」），装箱之后每一台都有文件
      expect(units(p), event).toEqual([]);
      expect(assignTests(p, inputs), event).not.toBeTypeOf('string');
    }
  });

  it('改动列表是空的：认不出改了什么，全跑，不当成「什么都不用跑」', () => {
    expect(pr().full).toBe(true);
  });

  it('认不出的路径、不在依赖图里的包：全跑', () => {
    for (const f of ['.gitattributes', 'scripts/new.sh', 'packages/nope/src/x.ts', 'LICENSE']) {
      const p = pr('docs/design.md', f);
      expect(p.full, f).toBe(true);
      expect(p.reasons.join(), f).toContain(f);
    }
  });

  it('根配置、锁文件、CI 工作流、shared、deploy/：全跑', () => {
    for (const f of [
      'pnpm-lock.yaml',
      'package.json',
      'pnpm-workspace.yaml',
      'tsconfig.json',
      'tsconfig.base.json',
      'biome.json',
      'vitest.config.ts',
      '.github/workflows/ci.yml',
      'packages/shared/src/domain.ts',
      'deploy/lib/common.sh',
    ]) {
      expect(pr(f).full, f).toBe(true);
    }
  });

  it('测试夹具不升全跑：只测它所在的包，加上测试读这个包的；不把依赖它的整串拉进来', () => {
    const f = 'packages/adapters/test/fixtures/claude-code/cc-haiku-read.ndjson';
    const p = pr(f);
    expect(p.full).toBe(false);
    // db 的测试读 adapters 的夹具（TEST_READS）。engine 依赖 adapters，但夹具在面以外，不连带。
    expect(units(p)).toEqual(['adapters', 'db']);
    expect(units(p)).not.toContain('engine');
  });

  it('纯文档（docs、specs、README、开单表单）：什么都裁掉，lint 里只剩 docs、hygiene 两步', () => {
    const p = pr(
      'docs/design.md',
      'docs/design.md',
      'specs/12-登录验证码/需求.md',
      'README.md',
      '.github/ISSUE_TEMPLATE/requirement.yml',
    );
    expect(p).toMatchObject({ full: false, tests: [], web: false, deploy: 'none', tsc: [] });
    // .yml 不是 md：biome 会看它
    expect(p.biome).toBe(true);
    expect(pr('docs/design.md', 'specs/1-x/方案.md').biome).toBe(false);
  });

  it('只改 packages/*/AGENTS.md：当纯文档，不测那个包也不连带依赖它的包（文档指针检查每个 PR 都跑）', () => {
    for (const f of [
      'packages/conventions/AGENTS.md',
      'packages/shared/AGENTS.md',
      'packages/db/AGENTS.md',
    ]) {
      const p = pr(f);
      expect(p, f).toMatchObject({
        full: false,
        tests: [],
        testUnits: [],
        web: false,
        deploy: 'none',
        tsc: [],
        biome: false,
      });
    }
    // 同一包里别的文件照旧测包；AGENTS.md 只在包根才算（更深的路径不是包说明）
    expect(units(pr('packages/conventions/src/x.ts'))).toContain('conventions');
    expect(units(pr('packages/conventions/AGENTS.md', 'packages/conventions/src/x.ts'))).toContain(
      'conventions',
    );
    expect(pr('packages/conventions/test/AGENTS.md').testUnits).toContain('conventions');
  });

  it('只改一个没人依赖的包（agent-eval）：只测它、只类型检查它，不打包 web、不跑 deploy', () => {
    const p = pr('packages/agent-eval/src/cli.ts');
    expect(p).toMatchObject({
      full: false,
      biome: true,
      tsc: ['packages/agent-eval'],
      web: false,
      deploy: 'none',
    });
    expect(units(p)).toEqual(['agent-eval']);
    // 装箱之后只跑 cli 自己的测试文件，一台
    const packed = assigned(p);
    expect(labels(packed)).toEqual(['1/1']);
    expect(
      boxFiles(packed)
        .flat()
        .every((f) => f.startsWith('packages/agent-eval/')),
    ).toBe(true);
  });

  it('改了 conventions 面上的文件：直接依赖它的 api、engine、github 都测，store 经 github 传上来（store 依赖 github）；改 standard-paths.json 再加读它的 agents', () => {
    expect(units(pr('packages/conventions/src/ci-plan.ts'))).toEqual([
      'api',
      'conventions',
      'engine',
      'github',
      'store',
    ]);
    expect(units(pr('packages/conventions/standard-paths.json'))).toEqual([
      'agents',
      'api',
      'conventions',
      'engine',
      'github',
      'store',
    ]);
  });

  it('只改包的面以外（入口脚本、包内模块、测试）：只测这个包自己，不连带依赖它的（本机改 check.ts 原来连 engine 一起跑，五分钟）', () => {
    for (const f of [
      'packages/conventions/src/check.ts',
      'packages/conventions/src/bin/check.ts',
      'packages/conventions/test/check.test.ts',
      'packages/github/test/client.test.ts',
    ]) {
      const pkg = f.split('/')[1] as string;
      expect(units(pr(f)), f).toEqual([pkg]);
      expect(pr(f).reasons.join(' '), f).toContain('只改到包的面以外');
    }
    // 面以外的和面上的一起改：照面上的连带
    expect(units(pr('packages/conventions/src/check.ts', 'packages/conventions/src/index.ts'))).toEqual(
      units(pr('packages/conventions/src/index.ts')),
    );
    // 删掉的、仓里没有的文件认不出在不在面上：照在面上算（多测不少测）
    expect(units(pr('packages/conventions/src/gone.ts'))).toEqual(
      units(pr('packages/conventions/src/index.ts')),
    );
    // 手搭的图没有 offSurface：整个包都算面
    const g = graph();
    const bare: PackageGraph = { deps: g.deps };
    expect(
      planCi({ event: 'pull_request', changed: ['packages/conventions/src/check.ts'], graph: bare })
        .testUnits,
    ).toEqual(units(pr('packages/conventions/src/index.ts')));
  });

  it('改了 db：db 和所有依赖它的（engine、api、store、jev）都测，读 db 路由骨架的 agents 也测；pg 的测试单独一台。github 不在里面（#901 ⑤：它不再依赖 db，改 db 不用重测它）', () => {
    const p = pr('packages/db/src/schema/index.ts');
    // shared 不再读路由骨架：没登记的单价按未知算（#1355），改 db 不用重测它。
    expect(units(p)).toEqual(['agents', 'api', 'db', 'engine', 'jev', 'store']);
    expect(units(p)).not.toContain('github');
    const packed = assigned(p);
    // db 的测试（要真 Postgres）单独一台，不和别的包混在一个 vitest 进程里（FLEET_TEST_PG_URL 一设，全进程都连真库）
    const pg = packed.tests.filter((b) => b.pg);
    expect(pg.length).toBeGreaterThanOrEqual(1);
    for (const b of pg) {
      expect(b.files.every((f) => f.startsWith('packages/db/'))).toBe(true);
      expect(b.label).toContain('· pg');
    }
    // 别的台不带 pg，也不装 db 的文件
    for (const b of packed.tests.filter((x) => !x.pg)) {
      expect(b.files.some((f) => f.startsWith('packages/db/'))).toBe(false);
    }
    // 每个要测的包都有自己的测试文件在某台里
    for (const u of ['db', 'engine', 'api', 'jev']) {
      expect(
        boxFiles(packed)
          .flat()
          .some((f) => f.startsWith(`packages/${u}/`)),
        u,
      ).toBe(true);
    }
    expect(
      boxFiles(packed)
        .flat()
        .some((f) => f.startsWith('agents/')),
      'agents',
    ).toBe(true);
    expect(p.tsc).toEqual(expect.arrayContaining(['packages/db', 'packages/engine', 'packages/api']));
  });

  it('改了 engine（#88 的偶发超时只挡改到 engine 的 PR）：别的包的 PR 不测 engine', () => {
    expect(units(pr('packages/engine/src/worker.ts'))).toEqual(['engine']);
    for (const f of [
      'packages/agent-eval/src/cli.ts',
      'packages/web/src/app.css',
      'packages/agents-sync/src/sync.ts',
      'docs/ops.md',
    ]) {
      expect(units(pr(f)), f).not.toContain('engine');
    }
  });

  it('改了 web：打包驾驶舱前端、跑 deploy（发布、扫公开页面文字用它）；api 的测试读 web 的文件，也测，但不往下传到 engine', () => {
    const p = pr('packages/web/src/build/scan.ts');
    expect(p).toMatchObject({ web: true, deploy: 'all' });
    expect(units(p)).toEqual(['api', 'web']);
  });

  it('改了 adapters 的源码：依赖它的跟着测；db 的测试读它的夹具，也测，不往下传到依赖 db 的（#984）', () => {
    // store 依赖 db，但不读 adapters 的夹具：db→adapters 停在 db，不把 store 拉上来
    expect(units(pr('packages/adapters/src/x.ts'))).toEqual([
      'adapters',
      'agents',
      'agents-sync',
      'api',
      'db',
      'engine',
      'jev',
      'mirasim-reclaude',
    ]);
  });

  it('改了 agents-sync：deploy/test 跑同步脚本，要跑 deploy', () => {
    expect(pr('packages/agents-sync/src/sync.ts').deploy).toBe('all');
    expect(pr('packages/jev/src/index.ts').deploy).toBe('none');
  });

  it('只改 docs/ops.md：deploy 只跑读它的端口表那块（run.sh --ops），和要全套的一起改照旧全套', () => {
    expect(pr('docs/ops.md').deploy).toBe('ops');
    expect(pr('docs/ops.md', 'docs/design.md', 'specs/1-x/方案.md').deploy).toBe('ops');
    // 顺序不影响：全套压过 ops
    expect(pr('docs/ops.md', 'packages/web/src/build/scan.ts').deploy).toBe('all');
    expect(pr('packages/agents-sync/src/sync.ts', 'docs/ops.md').deploy).toBe('all');
    expect(pr('docs/ops.md', 'deploy/france.sh').full).toBe(true);
    expect(pr('docs/ops.md', 'deploy/france.sh').deploy).toBe('all');
    expect(planOutputs(pr('docs/ops.md')).deploy).toBe('ops');
  });

  it('测试会读的包外文件：AGENTS.md、docs/ops.md、agents/、PR 模板、.gitignore 各自带上读它的包', () => {
    // AGENTS.md 要带两家：agents 的字数预算测试量本仓段，agents-sync 核它不再带通用段；
    // 通用段原件 agents/shared-rules.md 落在 agents/ 那道门里，同样两家都测（钉子测试 agents/test/rules/ 读它，#522）
    expect(testArgs(pr('agents/shared-rules.md'))).toEqual(['agents/', 'packages/agents-sync/']);
    expect(pr('agents/shared-rules.md').deploy).toBe('none');
    expect(pr('AGENTS.md')).toMatchObject({
      biome: false,
      deploy: 'none',
      testUnits: ['agents', 'agents-sync'],
    });
    expect(pr('docs/ops.md')).toMatchObject({ deploy: 'ops', testUnits: ['conventions', 'db'] });
    expect(testArgs(pr('agents/skills/discuss/SKILL.md'))).toEqual(['agents/', 'packages/agents-sync/']);
    // 调工具前的钩子：引擎起 Claude 会话也直接用仓里这份（adapters 的测试真跑它）
    expect(testArgs(pr('agents/hooks/pretool.mjs'))).toEqual([
      'packages/adapters/',
      'agents/',
      'packages/agents-sync/',
    ]);
    // 只改说明文字不拖上 2 分钟的 deploy/test（#121 只改 AGENTS.md 和 skill 就跑了 2 分 13 秒）
    expect(pr('agents/skills/discuss/SKILL.md').deploy).toBe('none');
    expect(pr('AGENTS.md', 'agents/skills/discuss/SKILL.md', 'docs/design.md').deploy).toBe('none');
    expect(pr('AGENTS.md', 'docs/ops.md').deploy).toBe('ops');
    expect(testArgs(pr('.github/pull_request_template.md'))).toEqual(
      expect.arrayContaining(['packages/conventions/', 'packages/github/']),
    );
    expect(testArgs(pr('.gitignore'))).toEqual(['packages/hygiene/']);
  });

  it('每个包改了都有一台测它（不会算丢）', () => {
    for (const dir of Object.keys(graph().deps)) {
      if (dir === 'shared') continue; // shared 全跑
      expect(testArgs(pr(`packages/${dir}/src/x.ts`)), dir).toContain(`packages/${dir}/`);
    }
  });
});

describe('要全跑、本机又不全跑时先跑哪些（fallbackUnits，给 test:changed）：同一份判法，只是放下升全跑那一档', () => {
  const fb = (...changed: string[]) => fallbackUnits(changed, graph());
  /** 依赖图里直接间接依赖 pkg 的（不含它自己）。 */
  const usersOf = (pkg: string) => [...dependentsClosure(graph(), [pkg])].filter((u) => u !== pkg).sort();

  it('改动里没有升全跑的文件：就是 planCi 选中的那份，一个不多、一个不少，没有留给 CI 的', () => {
    const cases: string[][] = [
      ['docs/design.md'],
      ['AGENTS.md'],
      ['docs/ops.md'],
      ['agents/skills/discuss/SKILL.md'],
      ['agents/hooks/pretool.mjs'],
      ['.gitignore'],
      ['.github/pull_request_template.md'],
      ['.githooks/pre-push'],
      ['packages/db/src/schema/index.ts', 'docs/ops.md'],
      ...Object.keys(graph().deps)
        .filter((d) => d !== 'shared')
        .map((d) => [`packages/${d}/src/x.ts`]),
    ];
    for (const changed of cases) {
      const p = pr(...changed);
      expect(p.full, changed.join()).toBe(false);
      expect(fb(...changed), changed.join()).toEqual({ units: p.testUnits, hubs: [], dependents: [] });
    }
  });

  it('改了 shared：只算 shared 自己；依赖它的（依赖图里直接间接依赖它的全部，加上测试读它们的）放进 dependents，留给 CI', () => {
    expect(usersOf('shared').length).toBeGreaterThan(5);
    expect(fb('packages/shared/src/domain.ts')).toEqual({
      units: ['shared'],
      hubs: ['shared'],
      // agents 不在依赖图里，它的测试读 db 的路由骨架（TEST_READS）：db 依赖 shared，agents 也算
      dependents: [...usersOf('shared'), AGENTS_UNIT].sort(),
    });
  });

  it('shared 和 db 一起改：db 照 planCi 带上依赖它的，shared 只算自己；已经在 units 里的不在 dependents 里重复', () => {
    const r = fb('packages/shared/src/domain.ts', 'packages/db/src/schema/index.ts');
    // 这次两个文件都改了，shared 在 units 里；这里只核对不重复。
    expect(r.units).toEqual(
      [...new Set([...pr('packages/db/src/schema/index.ts').testUnits, 'shared'])].sort(),
    );
    expect(r.dependents).toEqual(usersOf('shared').filter((u) => !r.units.includes(u)));
    expect(r.dependents).not.toContain('db');
  });

  it('根配置、锁文件、CI 工作流、deploy/、认不出的路径：不落在哪个单元，什么都不加；一起改的别的文件照 planCi 算', () => {
    for (const f of [
      'pnpm-lock.yaml',
      'package.json',
      'vitest.config.ts',
      '.github/workflows/ci.yml',
      'deploy/france.sh',
      'LICENSE',
    ]) {
      expect(pr(f).full, f).toBe(true);
      expect(fb(f), f).toEqual({ units: [], hubs: [], dependents: [] });
    }
    expect(fb('pnpm-lock.yaml', 'packages/agent-eval/src/cli.ts')).toEqual({
      units: ['agent-eval'],
      hubs: [],
      dependents: [],
    });
  });

  it('不在依赖图里的包目录：算那个包自己', () => {
    expect(fb('packages/nope/src/x.ts')).toEqual({ units: ['nope'], hubs: ['nope'], dependents: [] });
  });

  it('【故意造出的失败】依赖图读不出：改到的包只算自己，dependents 是一句为什么，不拿空清单冒充「没人依赖」', () => {
    const r = fallbackUnits(
      ['packages/api/src/a.ts', 'packages/shared/src/domain.ts', 'AGENTS.md'],
      '读不到 packages/api/package.json',
    );
    expect(r.units).toEqual(['agents', 'agents-sync', 'api', 'shared']);
    expect(r.hubs).toEqual(['shared']);
    expect(r.dependents).toBe('包依赖图读不出（读不到 packages/api/package.json），依赖改到的包的算不出来');
  });
});

describe('测试读包外的文件，改那个文件的 PR 一定测到它（漏记一条这里就红）', () => {
  // docs job 每个 PR 都跑的两份：它们读哪都不用记；本文件是扫描器自己（注释里举的例子会被当成读）
  const ALWAYS = new Set([
    'packages/conventions/test/doc-pointers.test.ts',
    'agents/test/skills.test.ts',
    'packages/conventions/test/ci-plan.test.ts',
  ]);

  function walk(rel: string, out: string[]) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) return;
    for (const name of readdirSync(abs)) {
      if (name === 'node_modules' || name === 'dist') continue;
      const r = `${rel}/${name}`;
      if (statSync(join(ROOT, r)).isDirectory()) walk(r, out);
      else if (/\.(ts|tsx|mts|mjs)$/.test(name)) out.push(r);
    }
  }
  const files: { unit: string; rel: string }[] = [];
  for (const dir of readdirSync(join(ROOT, 'packages'))) {
    const found: string[] = [];
    walk(`packages/${dir}/test`, found);
    walk(`packages/${dir}/src`, found);
    for (const rel of found) {
      if (rel.includes('/test/') || /\.test\.tsx?$/.test(rel)) files.push({ unit: dir, rel });
    }
  }
  const agentFiles: string[] = [];
  walk('agents/test', agentFiles);
  for (const rel of agentFiles) files.push({ unit: AGENTS_UNIT, rel });

  /** 一个字符串字面量（单、双、反引号，不含 ${}），值在三个捕获组之一。 */
  const LIT = String.raw`(?:'([^'\n$]*)'|"([^"\n$]*)"|\x60([^\x60\n$]*)\x60)`;
  const val = (m: RegExpMatchArray, i: number) => m[i] ?? m[i + 1] ?? m[i + 2];
  /** 一个测试文件里指向包外、真实存在的路径（仓内相对）。认的写法：'../…' 字面量；repoFile('x')、read('x') 这类以仓根为底的帮手；join(dirname(import.meta), '..', …)、join(REPO, …)。 */
  function refs(rel: string): string[] {
    const text = readFileSync(join(ROOT, rel), 'utf8');
    const dir = posix.dirname(rel);
    const out = new Set<string>();
    const add = (p: string) => {
      const n = posix.normalize(p);
      if (!n.startsWith('..')) out.add(n.replace(/\/$/, ''));
    };
    const all = (re: string) => [...text.matchAll(new RegExp(re, 'g'))];
    for (const m of all(LIT)) {
      const s = val(m, 1);
      if (s?.startsWith('../')) add(posix.join(dir, s));
    }
    // const repoFile = (path) => readFileSync(new URL(`../../../${path}`, …)) 这类帮手：调用时的字面量（或常量）以那个底为准
    const consts = new Map(
      all(String.raw`const (\w+) = ${LIT}`).map((c) => [c[1] as string, val(c, 2)] as const),
    );
    for (const h of all(String.raw`const (\w+) = \(\w+(?::[^)]*)?\) =>[^\n]*?\x60((?:\.\./)+)\$\{`)) {
      const base = posix.join(dir, h[2] as string);
      for (const c of all(String.raw`\b${h[1]}\((?:${LIT}|(\w+)\))`)) {
        const arg = val(c, 1) ?? consts.get(c[4] ?? '');
        if (arg) add(posix.join(base, arg));
      }
    }
    const segs = (args: string) => [...args.matchAll(new RegExp(LIT, 'g'))].map((s) => val(s, 1) as string);
    const here = String.raw`(?:dirname\(fileURLToPath\(import\.meta\.url\)\)|import\.meta\.dirname)`;
    const joins = (base: string, head: string) => {
      for (const j of all(String.raw`join\(\s*${head}\s*,([^)]*)\)`)) {
        const s = segs(j[1] as string);
        if (s.length > 0) add(posix.join(base, ...s));
      }
    };
    joins(dir, here);
    // const REPO = join(dirname(…), '..', '..', '..') 或 fileURLToPath(new URL('../../', import.meta.url))，再 join(REPO, 'AGENTS.md')
    const bases = new Map<string, string>();
    for (const c of all(String.raw`const (\w+) = join\(\s*${here}\s*,([^)]*)\)`)) {
      bases.set(c[1] as string, posix.join(dir, ...segs(c[2] as string)));
    }
    for (const c of all(String.raw`const (\w+) = fileURLToPath\(new URL\(${LIT}, import\.meta\.url\)\)`)) {
      bases.set(c[1] as string, posix.join(dir, val(c, 2) as string));
    }
    for (const [name, base] of bases) joins(base, name);
    return [...out].filter((p) => p !== '' && p !== 'packages' && existsSync(join(ROOT, p)));
  }

  it('扫得到东西（不然下面那条等于没查）', () => {
    expect(files.length).toBeGreaterThan(100);
    const all = files.flatMap((f) => refs(f.rel));
    for (const must of [
      'AGENTS.md', // join(REPO, 'AGENTS.md')
      'docs/ops.md', // repoFile('docs/ops.md')
      'deploy/catalog.json', // repoFile(EXAMPLE_PATH)
      'deploy/lib/snapshot.sh', // join(dirname(…), '..', …)
      'deploy/release.sh', // new URL('../../../deploy/release.sh', …)
      'packages/web/src/build/scan.ts',
      '.github/pull_request_template.md',
      '.gitignore',
    ]) {
      expect(all).toContain(must);
    }
  });

  /** 拿一个「算要跑什么」的函数扫一遍：每个测试读的包外文件，改它的 PR 都得测到读的那个单元。返回漏记的清单。 */
  const scan = (plan: (changed: string[]) => CiPlan) => {
    const missed: string[] = [];
    for (const { unit, rel } of files) {
      if (ALWAYS.has(rel)) continue;
      const own = unit === AGENTS_UNIT ? 'agents/' : `packages/${unit}/`;
      for (const ref of refs(rel)) {
        if (`${ref}/`.startsWith(own)) continue;
        const probe = statSync(join(ROOT, ref)).isDirectory() ? `${ref}/x` : ref;
        const p = plan([probe]);
        if (!p.full && !testArgs(p).includes(own)) missed.push(`${rel} 读 ${ref}，改它的 PR 不测 ${unit}`);
      }
    }
    return missed;
  };

  it('每一处都落进 PATH_RULES / 依赖图 / TEST_READS', () => {
    expect(scan((changed) => pr(...changed))).toEqual([]);
  });

  /**
   * 跨包读对账（#984）：测试文件扫出来的「这个包读了那个包」，必须在 package.json 推出的依赖图上，
   * 或在 TEST_READS 上。被读的包源码一改就全跑的（shared）算盖住了。
   * 只改夹具才全跑的不算：改 adapters 的源码不会因此选上 db。
   */
  /** TEST_READS 的一项盖住了 target 这个包：写的是包名，或是这个包里的文件（带 /）。 */
  const readsPackage = (reads: readonly string[], target: string) =>
    reads.some((r) => r === target || r.startsWith(`packages/${target}/`));
  const sourceForcesFull = (target: string) => {
    const probe = `packages/${target}/src/x.ts`;
    const rule = PATH_RULES.find((r) => r.match(probe));
    return rule !== undefined && 'full' in rule;
  };
  const missingReadEdges = (reads: Readonly<Record<string, readonly string[]>>) => {
    const g = graph();
    const missed: string[] = [];
    for (const { unit, rel } of files) {
      if (ALWAYS.has(rel)) continue;
      for (const ref of refs(rel)) {
        const target = /^packages\/([^/]+)\//.exec(ref)?.[1];
        if (target === undefined || target === unit) continue;
        const has =
          (g.deps[unit] ?? []).includes(target) ||
          readsPackage(reads[unit] ?? [], target) ||
          sourceForcesFull(target);
        if (!has) missed.push(`${rel} 读 ${ref}（${unit}→${target}），依赖图和 TEST_READS 都没有这条边`);
      }
    }
    return missed;
  };

  it('依赖图或 TEST_READS 盖住扫出来的每一条跨包读；api→web、db→adapters 都在（#984）', () => {
    const has = (from: string, to: string) =>
      (graph().deps[from] ?? []).includes(to) || readsPackage(TEST_READS[from] ?? [], to);
    expect(has('api', 'web'), 'api→web').toBe(true);
    expect(has('db', 'adapters'), 'db→adapters').toBe(true);
    expect(missingReadEdges(TEST_READS)).toEqual([]);
  });

  it('【故意造出的失败】删掉 db→adapters：对账必须正好红在 db 读 adapters 的那几处', () => {
    expect(missingReadEdges(TEST_READS)).toEqual([]);
    const dbReads = TEST_READS.db ?? [];
    const cut = { ...TEST_READS, db: dbReads.filter((r) => r !== 'adapters') };
    expect(dbReads, '没删成：db 的 TEST_READS 里已经没有 adapters，这条该改').toContain('adapters');
    expect(cut.db).not.toContain('adapters');
    const readers = files.flatMap(({ unit, rel }) => {
      if (ALWAYS.has(rel) || unit !== 'db') return [];
      return refs(rel)
        .filter((ref) => /^packages\/adapters\//.test(ref))
        .map((ref) => `${rel} 读 ${ref}（db→adapters），依赖图和 TEST_READS 都没有这条边`);
    });
    expect(readers.length, '没有测试读 adapters 了：这条查的漏记不存在，测试该删').toBeGreaterThan(0);
    expect(missingReadEdges(cut)).toEqual(readers);
  });

  /**
   * PR 的测试分片结果缓存（ci-cache.ts）的键必须盖住同一批读取：测试读的包外文件改了，命中缓存就会跳过读它的测试。
   * 输入集从上面的扫描器反推（refs 扫出来的每一处），不手写第二份清单。docs job 每个 PR 单独跑的那两份不算（ALWAYS 里
   * 的 ci-plan.test.ts 不免：它在 rest 分片里真跑，读的 ci.yml、deploy/、各包测试源码都得在键里）。
   */
  const cacheMissed = (cover: typeof keyCovers) => {
    const missed: string[] = [];
    for (const { unit, rel } of files) {
      if (rel === 'packages/conventions/test/doc-pointers.test.ts' || rel === 'agents/test/skills.test.ts')
        continue;
      const roots = keyRoots([unit], sourceClosure(graph(), [unit]));
      for (const ref of refs(rel)) {
        // 「.」是仓根这个底（const ROOT = fileURLToPath(new URL('../../../', …))），不是读了哪个文件：
        // 它下面具体读的文件，写得出字面量的会作为各自的路径出现在这里
        if (ref === '.') continue;
        if (!cover(roots, ref)) missed.push(`${rel} 读 ${ref}，缓存键没盖住`);
      }
    }
    return missed;
  };

  it('缓存键盖住扫描器扫出的每一处包外读取（ci-cache.ts 的 keyCovers）', () => {
    expect(cacheMissed(keyCovers)).toEqual([]);
  });

  it('【故意造出的失败】缓存键少盖一块（deploy/ 那棵）：扫出来必须正好是读 deploy/ 的那些测试，不是空、也不是别人', () => {
    const noDeploy: typeof keyCovers = (roots, path) =>
      keyCovers({ ...roots, dirs: roots.dirs.filter((d) => d !== 'deploy') }, path);
    const missed = cacheMissed(noDeploy);
    expect(missed.length, 'deploy/ 没有被任何测试读到了：这条查的东西不存在，测试该删').toBeGreaterThan(0);
    expect(
      missed.every((m) => /读 deploy(\/|$)/.test(m)),
      missed.join('\n'),
    ).toBe(true);
  });

  /**
   * 改 AGENTS.md 要测 agents：repo-entry.rules.test.ts 对仓根跑仓合同，读的是 AGENTS.md 里的 repo-contract:skip 标记。
   * 它经 checkRepo(仓根) 读、不写字面路径，上面的扫描器看不见，所以这道门直接钉在这里，不靠扫描反推。
   */
  it('改 AGENTS.md 测 agents 和 agents-sync，扫描器也不报漏记', () => {
    expect(testArgs(pr('AGENTS.md'))).toEqual(['agents/', 'packages/agents-sync/']);
    expect(scan((changed) => planCi({ event: 'pull_request', changed, graph: graph() }))).toEqual([]);
  });
});

describe('汇总（必过检查 check）：一律全套（决定 0101），该跑的跑了且绿', () => {
  // 汇总核的是 changes 给的 plan + 矩阵里的那份台：和入口同一条路（ciFullPlan → assignTests），不然「有单元没装箱」会被判成该跳过
  const plan = assigned(ciFullPlan());
  const green = { result: 'success', outputs: {} };
  const needs = (over: Record<string, unknown> = {}, p: CiPlan = plan) => ({
    changes: { result: 'success', outputs: planOutputs(p) },
    lint: green,
    test: green,
    web: green,
    e2e: green,
    deploy: green,
    ...over,
  });

  it('对得上就过，逐个写出来', () => {
    const v = ciVerdict(needs(), 'pull_request');
    expect(v.ok, v.lines.join('\n')).toBe(true);
    expect(v.lines).toHaveLength(ALWAYS_JOBS.length + PLANNED_JOBS.length);
  });

  it('CI 的计划就是全套：全部测试、web、e2e all（两种屏宽）、deploy all、biome、整棵树的 tsc', () => {
    expect(plan).toMatchObject({ full: true, web: true, e2e: 'all', deploy: 'all', biome: true, tsc: 'all' });
    const files = plan.tests.flatMap((b) => b.files).sort();
    expect(files).toEqual([...ALL_TESTS].sort());
    expect(planOutputs(plan)).toMatchObject({ web: 'true', e2e: 'all', deploy: 'all' });
  });

  /**
   * 【故意造出的失败】#2502 那种：PR 只改了 agents/…/release-train-lib.mjs，按改动选测时 agents/ 的规则不开 deploy、也不开 e2e，
   * PR 上 deploy 被跳过、合进主线才红。现在 CI 不按改动选：plan 里一定有 deploy all、e2e all；按改动选出来的 plan 交给汇总就红。
   */
  it('【故意造出的失败】只改 release-train-lib.mjs 的 PR：CI 计划里有 deploy all、e2e all；按改动选的 plan 汇总红', () => {
    const f = 'agents/skills/commander/scripts/release-train-lib.mjs';
    const picked = assigned(pr(f));
    expect(picked.deploy, '这条查的场景不成立了（本机选测开了 deploy？）').toBe('none');
    expect(picked.e2e).toEqual([]);
    expect(plan.deploy).toBe('all');
    expect(plan.e2e).toBe('all');
    const skipped = { result: 'skipped' };
    for (const event of ['pull_request', 'push']) {
      const v = ciVerdict(needs({ web: skipped, e2e: skipped, deploy: skipped }, picked), event);
      expect(v.ok, event).toBe(false);
      expect(v.lines.join('\n')).toContain('plan 不是全套');
    }
  });

  it('lint 被跳过（每次都得跑）：不过', () => {
    expect(ciVerdict(needs({ lint: { result: 'skipped' } })).ok).toBe(false);
  });

  it('本该跑的被跳过、红了、取消了：不过', () => {
    for (const job of PLANNED_JOBS) {
      for (const result of ['skipped', 'failure', 'cancelled']) {
        const v = ciVerdict(needs({ [job]: { result } }));
        expect(v.ok, `${job} ${result}`).toBe(false);
        expect(v.lines.join('\n')).toContain(`✗ ${job}：${result}，本该 success`);
      }
    }
  });

  it('红的 job 单列出来（#2795）：lint、test 红了就说 lint（failure）、test（failure）；全绿是空的', () => {
    expect(ciVerdict(needs()).redJobs).toEqual([]);
    const v = ciVerdict(needs({ lint: { result: 'failure' }, test: { result: 'failure' } }));
    expect(v.redJobs).toEqual(['lint（failure）', 'test（failure）']);
    // 本该跳过的却跑了、本该跑的没有结果，也算不对的 job
    expect(ciVerdict(needs({ e2e: { result: 'cancelled' } })).redJobs).toEqual(['e2e（cancelled）']);
    const { deploy: _, ...rest } = needs();
    expect(ciVerdict(rest).redJobs).toEqual(['deploy（没有结果）']);
  });

  it('lint（biome/tsc/docs/hygiene 并成的那个）红了：不过，报的是这一项', () => {
    const v = ciVerdict(needs({ lint: { result: 'failure' } }));
    expect(v.ok).toBe(false);
    expect(v.lines.join('\n')).toContain('✗ lint：failure');
  });

  it('changes 没算成、少了某个 job 的结果：不过', () => {
    expect(ciVerdict(needs({ changes: { result: 'failure', outputs: {} } })).ok).toBe(false);
    expect(ciVerdict(needs({ lint: { result: 'skipped' } })).ok).toBe(false);
    const { deploy: _, ...rest } = needs();
    expect(ciVerdict(rest).lines.join('\n')).toContain('✗ deploy：没有这个 job 的结果');
  });

  it('hygiene 并进 lint 了：lint 绿就过，hygiene 那一步红不红由 lint 自己判（不在汇总的文字里）', () => {
    const v = ciVerdict(needs());
    expect(v.ok).toBe(true);
    // 卫生检查不在这份判定里：汇总的结论文字里不单独提它
    expect(v.lines.join('\n')).not.toContain('hygiene');
  });

  it('plan 读不出（空、不是 JSON、缺字段）、needs 不是对象：不过，不当成全跳过', () => {
    const withDeploy = (d: unknown) => JSON.stringify({ ...plan, deploy: d });
    for (const bad of ['', '{', '{"full":true}', undefined, withDeploy(true), withDeploy('some')]) {
      const n = needs();
      n.changes.outputs = { ...n.changes.outputs, plan: bad as string };
      expect(ciVerdict(n).ok, String(bad)).toBe(false);
    }
    expect(ciVerdict(null).ok).toBe(false);
    expect(ciVerdict('x').ok).toBe(false);
  });

  it('【故意造出的失败】plan 说全跑却有一样不是全套（被改坏的 plan）：不过，即使 job 都绿', () => {
    const broken: CiPlan[] = [
      { ...plan, web: false },
      { ...plan, deploy: 'ops' },
      { ...plan, e2e: [`${E2E_SPEC_DIR}01-login.e2e.ts`] },
      { ...plan, tsc: ['packages/core'] },
      { ...plan, biome: false },
    ];
    for (const b of broken) {
      const v = ciVerdict(needs({}, b));
      expect(v.ok, JSON.stringify({ web: b.web, deploy: b.deploy, e2e: b.e2e, tsc: b.tsc })).toBe(false);
      expect(v.lines.join('\n')).toContain('plan 不是全套');
    }
  });

  /**
   * 【故意造出的失败】算计划之后忘了装箱（或者装箱失败还照常往下走）：test job 会被 if 判成不该跑、汇总却当它
   * 「本该 skipped」，一个测试都不跑还算绿。要全跑却一台都没有，汇总必须红。
   */
  it('【故意造出的失败】要全跑却一台测试都没有（没装箱）：不过，不当成「本该 skipped」', () => {
    const noBoxes = ciFullPlan();
    expect(noBoxes.tests).toEqual([]);
    const v = ciVerdict(needs({ test: { result: 'skipped' } }, noBoxes));
    expect(v.ok).toBe(false);
    expect(v.lines.join('\n')).toContain('却一台测试都没装');
    // 反过来：没有要测的单元却铺了台，一样红（矩阵和开关对不上）
    const nothing: CiPlan = {
      ...pr('docs/design.md'),
      tests: [{ label: '1/1', files: ['x'], estMs: 1, pg: false, temporal: false }],
    };
    expect(ciVerdict(needs({ test: { result: 'success' } }, nothing)).ok).toBe(false);
  });

  /** 矩阵铺的是 outputs.tests：它和 plan 里核过的那份不是同一份（工作流被改坏），就红。 */
  it('【故意造出的失败】矩阵里的台和 plan 里的不是同一份：不过', () => {
    const n = needs();
    n.changes.outputs = { ...n.changes.outputs, tests: '[]' };
    expect(ciVerdict(n).ok).toBe(false);
    expect(ciVerdict(n).lines.join('\n')).toContain('和 plan 里的测试台不是同一份');
  });

  /** 台本身认不出（缺名字、文件空、一个文件两台里都有、两台同名）：不过，不拿半份清单去核对。 */
  it('【故意造出的失败】台认不出：缺名字、没文件、一个文件分到两台、两台同名、开关不是真假值', () => {
    const good = plan;
    const first = good.tests[0] as (typeof good.tests)[number];
    const broken: Partial<CiPlan>[] = [
      { ...good, tests: [{ ...first, label: '' }] },
      { ...good, tests: [{ ...first, files: [] }] },
      { ...good, tests: [{ ...first, pg: 'yes' as unknown as boolean }] },
      { ...good, tests: [{ ...first, estMs: Number.NaN }] },
      { ...good, tests: [first, { ...first, label: '另一台' }] },
      { ...good, tests: [first, { ...first, label: `${first.label}x` }] },
    ];
    for (const b of broken) {
      const v = ciVerdict(needs({}, b as CiPlan));
      expect(v.ok, JSON.stringify(b.tests)).toBe(false);
      expect(v.lines.join('\n')).toMatch(/测试台认不出|分到了两台|同名/);
    }
  });
});

describe('入口', { timeout: 0 }, () => {
  const plan = fileURLToPath(new URL('../src/bin/ci-plan.ts', import.meta.url));
  const verdict = fileURLToPath(new URL('../src/bin/ci-verdict.ts', import.meta.url));
  const run = (bin: string, args: string[], env: Record<string, string> = {}) =>
    runChild(process.execPath, [bin, ...args], {
      env: { ...process.env, GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '', ...env },
    });

  /**
   * 【故意造出的失败】PR 那一轮：原来按 origin/main...HEAD 的改动选测、e2e 挪到主线（输出空串），漏的到主线才红。
   * 现在不管改了什么都是全套：e2e=all、deploy=all、web=true、全部测试都装了台。
   */
  for (const event of ['pull_request', 'push', 'schedule', 'workflow_dispatch']) {
    it(`${event}：一律全套，开关写进 GITHUB_OUTPUT（e2e all、deploy all、web、全部测试）`, () => {
      const out = join(mkdtempSync(join(tmpdir(), 'ci-plan-')), 'out');
      const r = run(plan, ['--event', event], { GITHUB_OUTPUT: out });
      expect(r.status, r.stderr).toBe(0);
      const text = readFileSync(out, 'utf8');
      for (const line of ['biome=true', 'tsc=all', 'web=true', 'e2e=all', 'deploy=all', 'reused='])
        expect(text).toContain(`${line}\n`);
      const tests = /^tests=(.*)$/m.exec(text)?.[1] ?? '[]';
      const files = (JSON.parse(tests) as TestBox[]).flatMap((b) => b.files).sort();
      expect(files).toEqual([...ALL_TESTS].sort());
    });
  }

  it('【故意造出的失败】旧参数（--base、--main-base）、认不出的参数：退出 2，不静默照旧算', () => {
    expect(run(plan, ['--base', 'origin/main']).status).toBe(2);
    expect(run(plan, ['--event', 'push', '--main-base', 'HEAD']).status).toBe(2);
    expect(run(plan, ['--frobnicate']).status).toBe(2);
  });

  it('GITHUB_OUTPUT 写不进去：退出 2', () => {
    expect(run(plan, ['--event', 'push'], { GITHUB_OUTPUT: join(ROOT, '没有这个目录', 'out') }).status).toBe(
      2,
    );
  });

  /**
   * 【故意造出的失败】装箱这一步没算成：退出 2 判红，不静默少跑（原来那种「vitest 一个文件都没收到」的红要保住）。
   */
  it('【故意造出的失败】没单元有测试文件 / 列不出测试文件 / 读不了某个文件：一句为什么，不静默少跑', () => {
    expect(
      assignTests({ ...pr('packages/agent-eval/src/cli.ts'), testUnits: ['没有这个包'] }, inputs),
    ).toMatch(/一个测试文件都没有/);
    // 列不出测试文件（检出坏了）：也是一句为什么，不是空清单
    expect(
      assignTests(pr('packages/agent-eval/src/cli.ts'), { ...inputs, all: '列不出 packages/' }),
    ).toContain('列不出 packages/');
    // 读不了某个测试文件（认不出要不要 Temporal）：判红，不猜
    expect(assignTests(pr('packages/agent-eval/src/cli.ts'), { ...inputs, read: () => undefined })).toContain(
      '读不到测试文件',
    );
  });

  it('汇总入口：没给 CI_NEEDS、不是 JSON 退出 2；对不上退出 1；对得上退出 0', () => {
    expect(run(verdict, [], { CI_NEEDS: '' }).status).toBe(2);
    expect(run(verdict, [], { CI_NEEDS: '{' }).status).toBe(2);
    const p = planOutputs(assigned(ciFullPlan()));
    const base = {
      changes: { result: 'success', outputs: p },
      lint: { result: 'success' },
      test: { result: 'success' },
      web: { result: 'success' },
      e2e: { result: 'success' },
      deploy: { result: 'success' },
    };
    expect(run(verdict, [], { CI_NEEDS: JSON.stringify(base) }).status).toBe(0);
    expect(
      run(verdict, [], { CI_NEEDS: JSON.stringify({ ...base, changes: { result: 'failure' } }) }).status,
    ).toBe(1);
    // lint 红了不挡——不行：lint 是必过的一项，红了汇总入口退出 1
    expect(
      run(verdict, [], { CI_NEEDS: JSON.stringify({ ...base, lint: { result: 'failure' } }) }).status,
    ).toBe(1);
  });

  it('红了：汇总入口打一条 ::error title=红的 job，写明哪几个 job 红了（引擎等 CI 读得到，#2795）；全绿没有这一条', () => {
    const p = planOutputs(assigned(ciFullPlan()));
    const base = {
      changes: { result: 'success', outputs: p },
      lint: { result: 'success' },
      test: { result: 'success' },
      web: { result: 'success' },
      e2e: { result: 'success' },
      deploy: { result: 'success' },
    };
    const red = run(verdict, [], {
      CI_NEEDS: JSON.stringify({ ...base, lint: { result: 'failure' }, test: { result: 'failure' } }),
    });
    expect(red.status).toBe(1);
    expect(red.stderr).toContain('::error title=红的 job::lint（failure）、test（failure）');
    expect(run(verdict, [], { CI_NEEDS: JSON.stringify(base) }).stderr).not.toContain('红的 job');
  });
});

describe('ci.yml 和这里对得上', () => {
  const yml = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const job = (id: string) => {
    const start = yml.search(new RegExp(`^  ${id}:$`, 'm'));
    if (start < 0) return '';
    const next = yml.slice(start + 1).search(/^ {2}[\w-]+:$/m);
    return next < 0 ? yml.slice(start) : yml.slice(start, start + 1 + next);
  };

  it('【故意造出的失败】lint 里 biome、tsc 两步各自 continue-on-error + 最后一步按 outcome 判红：谁都不能把对方跳过（#566 的 7 个类型错就是这么漏的）', () => {
    // job() 切到下一个 job 头，会把紧贴在它上面的注释一起带进来；判「正文里有没有 tsc」前先把整行注释去掉。
    const body = (id: string) =>
      job(id)
        .split('\n')
        .filter((l) => !/^\s*#/.test(l))
        .join('\n');
    const lint = body('lint');
    expect(lint, 'lint job 不见了').not.toBe('');
    expect(lint).toContain('pnpm exec biome check .');
    expect(lint).toContain('pnpm exec tsc -b');
    // 每次都跑的测试一样一样各自起（红了看得出是哪一类），合起来正好是 ALWAYS_TESTS（test-changed.test.ts 另核 ci.yml 和它对得上）
    for (const t of ALWAYS_TESTS) expect(lint).toContain(`pnpm exec vitest run ${t}`);
    // 三样在同一步里各自后台跑、各写各的结果（并行跑的那步真跑一遍，见下面「lint 的并行步」）；汇总读的是这一步
    // 写出来的三样结果，不读哪一步的 conclusion（continue-on-error 的步 conclusion 会被改写成 success）。
    expect(lint).toMatch(/^\s+id: checks$/m);
    expect(lint).toContain('steps.checks.outputs.biome');
    expect(lint).toContain('steps.checks.outputs.tsc');
    expect(lint).toContain('steps.checks.outputs.doc_pointers');
    expect(lint).toContain('steps.checks.outputs.agents_test');
    expect(lint).toContain('steps.checks.outputs.deps');
    expect(lint).toContain('steps.checks.outputs.release_smoke');
    expect(lint).not.toMatch(/steps\.\w+\.conclusion/);
    // 判红的那步要真的非零退出（只 echo 不算红）。
    expect(lint).toMatch(/::error::lint 里有检查不对/);
  });

  /**
   * 抠出 lint 里「并行跑」那一步的脚本，配一个假的 pnpm（按子命令决定退出码）原样交给 bash 跑：
   * 一样红了另外两样照样跑完、各自写出结果，开关说不跑的写 skipped。
   */
  // 每条都起 bash + 几个后台子进程：Windows 本机在别的测试一起跑时一条能到 5–10 秒，默认 5 秒的限时会误红。
  describe('lint 的并行步（真跑它的脚本）', { timeout: 0 }, () => {
    const doc = parse(yml) as {
      jobs: { lint: { steps: { id?: string; run?: string }[] } };
    };
    const script = doc.jobs.lint.steps.find((s) => s.id === 'checks')?.run ?? '';
    const go = (fail: string[]) => {
      const dir = mkdtempSync(join(tmpdir(), 'lint-checks-'));
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      // 假 pnpm：记下被叫了什么，参数里含 fail 里的哪个词就退 1
      const pnpm = join(bin, 'pnpm');
      writeFileSync(
        pnpm,
        [
          '#!/usr/bin/env bash',
          `echo "$*" >> "${posix.join(dir.replace(/\\/g, '/'), 'calls')}"`,
          ...fail.map((f) => `case "$*" in *${f}*) exit 1;; esac`),
          'exit 0',
          '',
        ].join('\n'),
      );
      chmodSync(pnpm, 0o755);
      const out = join(dir, 'out');
      writeFileSync(out, '');
      const r = runChild('bash', ['-c', script], {
        env: {
          ...process.env,
          PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
          GITHUB_OUTPUT: out,
          LOGS: join(dir, 'logs'),
        },
      });
      const outputs = Object.fromEntries(
        readFileSync(out, 'utf8')
          .split('\n')
          .filter((l) => l.includes('='))
          .map((l) => l.split('=') as [string, string]),
      );
      const calls = existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8') : '';
      return { r, outputs, calls };
    };

    it('找得到并行步和它的脚本（不然下面几条等于没查）', () => {
      expect(script).toContain('wait');
    });

    it('每一样的分组标题带上它自己跑了几秒（三样并行，墙钟 = 最慢那样，不记看不出该省哪个）', () => {
      const { r } = go([]);
      for (const name of ['biome', 'tsc', 'doc_pointers', 'agents_test', 'deps', 'release_smoke'])
        expect(r.stdout, name).toMatch(new RegExp(`::group::${name}（退出码 0，\\d+ 秒）`));
    });

    it('都绿：每一样都写 success；biome 查整个仓、tsc 查整棵树（一律全套，没有开关）', () => {
      const { outputs, calls } = go([]);
      expect(outputs).toEqual({
        biome: 'success',
        tsc: 'success',
        doc_pointers: 'success',
        agents_test: 'success',
        deps: 'success',
        release_smoke: 'success',
      });
      expect(calls).toMatch(/^exec tsc -b$/m);
      expect(calls).toContain('exec biome check .');
    });

    it('【故意造出的失败】biome 红了：tsc、doc_pointers、agents_test 照样跑完、照样 success，biome 写 failure（#566 不许再漏）', () => {
      const { outputs, calls } = go(['biome']);
      expect(outputs).toEqual({
        biome: 'failure',
        tsc: 'success',
        doc_pointers: 'success',
        agents_test: 'success',
        deps: 'success',
        release_smoke: 'success',
      });
      expect(calls).toContain('exec tsc -b');
      expect(calls).toContain('doc-pointers.test.ts');
      expect(calls).toContain('agents/test/');
    });

    it('【故意造出的失败】只有文档指针那一样红：只它写 failure，agents_test 照跑照 success（红在哪一类一眼看得出）', () => {
      const { outputs } = go(['doc-pointers']);
      expect(outputs).toEqual({
        biome: 'success',
        tsc: 'success',
        doc_pointers: 'failure',
        agents_test: 'success',
        deps: 'success',
        release_smoke: 'success',
      });
    });

    it('【故意造出的失败】只有 agents/test 那一样红：只它写 failure，doc_pointers 照 success', () => {
      const { outputs } = go(['agents/test']);
      expect(outputs).toEqual({
        biome: 'success',
        tsc: 'success',
        doc_pointers: 'success',
        agents_test: 'failure',
        deps: 'success',
        release_smoke: 'success',
      });
    });

    it('【故意造出的失败】四样全红：四样都写 failure，一个不少', () => {
      const { outputs } = go(['biome', 'tsc', 'vitest']);
      expect(outputs).toEqual({
        biome: 'failure',
        tsc: 'failure',
        doc_pointers: 'failure',
        agents_test: 'failure',
        deps: 'success',
        release_smoke: 'success',
      });
    });

    it('【故意造出的失败】未声明依赖、照法国装的冒烟各自红：只它们写 failure，别的照 success', () => {
      const { outputs, calls } = go(['deps:check', 'release:smoke']);
      expect(outputs).toEqual({
        biome: 'success',
        tsc: 'success',
        doc_pointers: 'success',
        agents_test: 'success',
        deps: 'failure',
        release_smoke: 'failure',
      });
      expect(calls).toContain('run deps:check');
      expect(calls).toContain('run release:smoke');
    });
  });

  /**
   * 抠出 deploy 里「给 /etc/skel 瘦身」那一步，配一个假 sudo（照原样执行，命令行含指定片段时假装失败），
   * SKEL 指到临时目录真跑：瘦成、半路失败要挪回去、挪不回去要红。
   */
  describe('deploy 的 skel 瘦身步（真跑它的脚本）', { timeout: 0 }, () => {
    const doc = parse(yml) as {
      jobs: { deploy: { steps: { name?: string; if?: unknown; run?: string }[] } };
    };
    const step = doc.jobs.deploy.steps.find((s) => s.name?.includes('/etc/skel 瘦身'));
    const go = (fail: string[]) => {
      const dir = mkdtempSync(join(tmpdir(), 'skel-')).split('\\').join('/');
      const skel = `${dir}/skel`;
      mkdirSync(`${skel}/.rustup/toolchains`, { recursive: true });
      writeFileSync(`${skel}/.rustup/toolchains/big`, 'x');
      writeFileSync(`${skel}/.profile`, 'profile');
      writeFileSync(`${skel}/.bashrc`, 'bashrc');
      mkdirSync(`${dir}/bin`);
      const sudo = `${dir}/bin/sudo`;
      writeFileSync(
        sudo,
        [
          '#!/usr/bin/env bash',
          // DIR 换成这次的临时目录：只卡「某某 挪到 skel」那条 mv，不卡前面的 mkdir；不写死 /（Windows 上路径是 C:/…）
          ...fail.map((f) => `case "$*" in *"${f.split('DIR').join(dir)}"*) exit 1;; esac`),
          'exec "$@"',
          '',
        ].join('\n'),
      );
      chmodSync(sudo, 0o755);
      const r = runChild('bash', ['-c', step?.run ?? ''], {
        env: {
          ...process.env,
          PATH: `${dir}/bin${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
          SKEL: skel,
        },
      });
      const ls = (p: string) => (existsSync(p) ? readdirSync(p).sort() : null);
      return { r, skel: ls(skel), full: ls(`${skel}.ci-full`) };
    };

    it('只在要 sudo 的台上跑', () => {
      expect(step, '找不到瘦身那步').toBeDefined();
      expect(step?.if).toBe('matrix.sudo');
    });

    it('瘦成：只留顶层普通文件，工具链目录挪到 .ci-full', () => {
      const { r, skel, full } = go([]);
      expect(r.status, r.stderr).toBe(0);
      expect(skel).toEqual(['.bashrc', '.profile']);
      expect(full).toEqual(['.bashrc', '.profile', '.rustup']);
    });

    it('【故意造出的失败】新的挪不进去：把原来的挪回去，照原样跑（退出 0、打 warning）', () => {
      // 只卡「把瘦身目录换进去」那条 mv（命令里 skel.slim 后面跟着空格和路径）：这时原目录已经挪走了，要走恢复那条路
      const { r, skel } = go(['skel.slim DIR/skel']);
      expect(r.status, r.stderr).toBe(0);
      expect(skel).toEqual(['.bashrc', '.profile', '.rustup']);
      expect(r.stdout).toContain('::warning::');
    });

    it('【故意造出的失败】新的挪不进去、原来的也挪不回去：红，不拿「照原样跑」糊过去', () => {
      const { r, skel } = go(['skel.slim DIR/skel', 'skel.ci-full DIR/skel']);
      expect(r.status).toBe(1);
      expect(skel).toBeNull();
      expect(r.stdout).toContain('::error::');
    });
  });

  /** 抠出 lint 里「汇总」那一步的脚本，原样交给 bash 跑：每种红法都造一遍，看退出码和报出来的名字。 */
  describe('lint 的汇总步（真跑它的脚本）', { timeout: 0 }, () => {
    const doc = parse(yml) as {
      jobs: { lint: { steps: { name?: string; run?: string }[] } };
    };
    const step = doc.jobs.lint.steps.find((s) => s.name?.startsWith('汇总'));
    const script = step?.run ?? '';
    const base: Record<string, string> = {
      BIOME: 'success',
      TSC: 'success',
      DOC_POINTERS: 'success',
      AGENTS_TEST: 'success',
      DEPS: 'success',
      RELEASE_SMOKE: 'success',
      HYGIENE: 'success',
    };
    const run = (over: Record<string, string> = {}) =>
      runChild('bash', ['-c', script], { env: { ...process.env, ...base, ...over } });

    it('找得到汇总步和它的脚本（不然下面几条等于没查）', () => {
      expect(script).toContain('set -euo pipefail');
    });

    it('该跑的都 success：退出 0', () => {
      expect(run().status).toBe(0);
    });

    it('【故意造出的失败】deps、release_smoke 红了或被跳过（每次都得跑）：红，点名那一样', () => {
      for (const [k, name] of [
        ['DEPS', 'deps'],
        ['RELEASE_SMOKE', 'release_smoke'],
      ] as const) {
        for (const v of ['failure', 'skipped']) {
          const r = run({ [k]: v });
          expect(r.status, `${k}=${v}`).toBe(1);
          expect(r.stdout, `${k}=${v}`).toContain(`${name}（${v}，本该 success）`);
        }
      }
    });

    it('【故意造出的失败】biome 红了、tsc 照样 success：job 红，只点名 biome（tsc 没被它吃掉）', () => {
      const r = run({ BIOME: 'failure' });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('biome（failure，本该 success）');
      expect(r.stdout).not.toContain('tsc（');
    });

    it('【故意造出的失败】tsc 红了（biome 绿）：job 红，点名 tsc', () => {
      const r = run({ TSC: 'failure' });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('tsc（failure，本该 success）');
    });

    it('【故意造出的失败】两个都红：两个名字都报出来，不是只报第一个', () => {
      const r = run({ BIOME: 'failure', TSC: 'failure' });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('biome（failure');
      expect(r.stdout).toContain('tsc（failure');
    });

    it('【故意造出的失败】doc_pointers、agents_test 红了、被跳过了（每次都得跑）：都红，且只点名红的那一样', () => {
      // 空值 = 并行那步中途崩了、没写出结果：同样红
      for (const [env, other] of [
        ['DOC_POINTERS', 'agents_test'],
        ['AGENTS_TEST', 'doc_pointers'],
      ] as const) {
        const name = env.toLowerCase();
        for (const v of ['failure', 'skipped', 'cancelled', '']) {
          const r = run({ [env]: v });
          expect(r.status, `${env}=${v}`).toBe(1);
          expect(r.stdout, `${env}=${v}`).toContain(`${name}（${v}，本该 success）`);
          expect(r.stdout, `${env}=${v}`).not.toContain(`${other}（`);
        }
      }
    });

    it('【故意造出的失败】biome、tsc 是 skipped 或空（没跑、并行那步崩了）：红，不把「没跑」当成「跑过了」', () => {
      for (const [k, name] of [
        ['BIOME', 'biome'],
        ['TSC', 'tsc'],
      ] as const) {
        for (const v of ['skipped', '']) {
          const r = run({ [k]: v });
          expect(r.status, `${k}=${v}`).toBe(1);
          expect(r.stdout).toContain(`${name}（${v}，本该 success）`);
        }
      }
    });

    it('卫生检查红了：只打 ::warning::、不让 job 红（只报不挡）；skipped（push 事件）也不红', () => {
      const r = run({ HYGIENE: 'failure' });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('::warning::卫生检查没过');
      expect(run({ HYGIENE: 'skipped' }).status).toBe(0);
    });
  });

  it('必过检查 check 是汇总 job：always() 跑、needs 全部 job、跑汇总入口', () => {
    const check = job('check');
    expect(check).toContain('if: always()');
    for (const j of [...ALWAYS_JOBS, ...PLANNED_JOBS])
      expect(check).toMatch(new RegExp(`needs:[^\\n]*\\b${j}\\b`));
    expect(check).toContain(['CI_NEEDS: $', '{{ toJSON(needs) }}'].join(''));
    expect(check).toContain('node packages/conventions/src/bin/ci-verdict.ts');
  });

  /**
   * 【故意造出的失败】原来主线推送按分支分组（github.ref）：一组只许一个排队，新推的把排着的那个挤掉，7 天 49 轮被挤掉、那些提交没有结论。
   * 现在 PR 按号分（新推的挤掉旧的），别的事件按提交号分（github.sha）：主线每个提交各自一组，一个都不挤掉；带事件名，夜跑和推送同一个提交也不撞。
   */
  it('【故意造出的失败】并发组 PR 按号分、主线推送按提交号分（一个都不挤掉）、末尾带事件名', () => {
    const group = /^concurrency:\n {2}group: (.+)$/m.exec(yml)?.[1];
    expect(group).toBe(
      ['ci-$', '{{ github.event.pull_request.number || github.sha }}-$', '{{ github.event_name }}'].join(''),
    );
    expect(group).not.toContain('github.ref');
  });

  it('【故意造出的失败】只有 PR 上新的一轮挤掉旧的，主线推送和定时轮不挤掉在跑的全量：挤了的话合并一密一个全绿的提交都没有，自动发布无可发（#362）；定时轮被主线顶掉的话那一夜的全量回归直接不跑（2026-10-05 第二意见）', () => {
    const cancel = /^concurrency:\n {2}group: .+\n {2}cancel-in-progress: (.+)$/m.exec(yml)?.[1];
    expect(cancel).toBe(['$', "{{ github.event_name == 'pull_request' }}"].join(''));
  });

  it('test、web、e2e、deploy 都看 changes 给的开关（全套时都开、同树复用时都关）；lint 每次跑、没有开关；没有按改动选测的那一套', () => {
    for (const j of PLANNED_JOBS) {
      expect(job(j), j).toMatch(/^ {4}needs: changes$/m);
      expect(job(j), j).toMatch(/^ {4}if: .*needs\.changes\.outputs\./m);
    }
    const changes = job('changes');
    expect(changes).toContain(
      'node packages/conventions/src/bin/ci-plan.ts --event "$EVENT" --reuse "$REUSE"',
    );
    // 【故意造出的失败】找「上一次主线真绿的头」、按区间选测的那一步删了（决定 0101）
    expect(changes).not.toContain('mainbase');
    expect(changes).not.toContain('main-base');
    expect(changes).not.toContain('--base');
    expect(changes).not.toContain('narrowed');
    // lint 是每次都跑的 job，没有 job 级 if；不再算计划，biome、tsc 每次都跑整仓
    const lint = job('lint')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(lint).not.toMatch(/^ {4}(needs|if): /m);
    expect(lint).not.toContain('ci-plan.ts');
    expect(lint).not.toContain('steps.plan');
    expect(lint).toContain('start biome pnpm exec biome check .');
    expect(lint).toContain('start tsc pnpm exec tsc -b');
  });

  it('没有 job 用仓库密钥；lint 里卫生检查一行 PR 里的代码都不执行：代码取目标分支上的 trusted/，PR 检出到仓根只当数据扫（这个 PR 自己改不宽卫生检查的规则，#115 第二意见）', () => {
    const ids = [...yml.matchAll(/^ {2}([\w-]+):$/gm)].map((m) => m[1] as string);
    expect(ids).toContain('lint');
    for (const id of ids) expect(job(id), id).not.toContain('secrets.');
    const lint = job('lint');
    // 执行的是主线上的 trusted/ 那份代码：卫生检查（一步里的两遍）都从 TRUSTED 取，PR 的文件只当数据扫。
    expect((lint.match(/TRUSTED: \$\{\{ github\.workspace \}\}\/trusted\n/g) ?? []).length).toBe(1);
    // PR 检出到 pr/（job 级 defaults.run.working-directory: pr，所有 run 步都在那里跑），主线的检出在并排的 trusted/，
    // 不在 PR 树里面：biome check . 和卫生检查扫文件树都碰不到它。
    expect(lint).toMatch(/defaults:\n\s+run:\n\s+working-directory: pr\n/);
    expect(lint).toMatch(/path: pr\n/);
    expect(lint).toMatch(/path: trusted\n/);
    expect(lint).toMatch(
      /ref: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.sha \}\}\n\s+path: trusted\n/,
    );
    // 【故意造出的失败】卫生检查两步必须排在装依赖之前：装依赖会跑 PR 的安装脚本，排后面它就能先改掉 trusted/ 里的
    // 卫生检查代码、再让它放过自己（#115 的防线）。
    const at = (needle: string) => lint.indexOf(needle);
    expect(at('id: hygiene\n'), '找不到 hygiene 步').toBeGreaterThan(0);
    // CI 里卫生检查只剩一处：文件树和历史两遍在同一步里，不再有第二步
    expect(lint).not.toContain('hygiene_history');
    expect(lint).toContain('packages/hygiene/src/bin/ci-history.ts');
    expect((lint.match(/runCheck\(/g) ?? []).length).toBe(1);
    const install = at('pnpm install --frozen-lockfile');
    expect(install, '找不到装依赖那步').toBeGreaterThan(0);
    expect(at('id: hygiene\n')).toBeLessThan(install);
    // 动态 import 的只有 trusted/ 下的卫生检查
    const imports = [...lint.matchAll(/import\(([^)]*)\)/g)].map((m) => m[1]);
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatch(
      /^pathToFileURL\(`\$\{process\.env\.TRUSTED\}\/packages\/hygiene\/src\/check\.ts`$/,
    );
  });

  it('deploy job：按 changes 给的矩阵铺（all 几台 --shard、ops 一台 --ops），开关空就不开；每一台都真跑、只有全套那几台带 sudo', () => {
    const d = job('deploy');
    expect(d).toContain("if: needs.changes.outputs.deploy_matrix != '[]'");
    expect(d).toContain('include: ${{ fromJSON(needs.changes.outputs.deploy_matrix) }}');
    // 【故意造出的失败】原来跑测试那步写着 if: deploy == 'all'：ops 那台铺了矩阵却被跳过，空跑还报绿（#662 第二意见）。
    // 现在跑测试的那步没有条件（每一台腿都跑），sudo 由矩阵每台的 sudo 决定。
    expect(d).not.toMatch(/run: sudo FLEET_TEST_SYSTEM_USERS=1 bash deploy\/test\/run\.sh/);
    expect(d).toMatch(/name: deploy 检查（\$\{\{ matrix\.label \}\}）/);
    expect(d).toContain('NEEDS_SUDO: ${{ matrix.sudo }}');
    expect(d).toMatch(/sudo FLEET_TEST_SYSTEM_USERS=1 bash deploy\/test\/run\.sh "\$\{args\[@\]\}"/);
    expect(d).toMatch(/^\s+bash deploy\/test\/run\.sh "\$\{args\[@\]\}"$/m);
    const runSh = readFileSync(join(ROOT, 'deploy/test/run.sh'), 'utf8');
    expect(runSh).toMatch(/^ {2}--ops\)$/m);
    expect(runSh).toMatch(/^ {2}'[^']*\bops-only\b[^']*'$/m); // 分台名单里排着 ops-only（自己也要跑）
    expect(existsSync(join(ROOT, 'deploy/test/ops-only.test.sh'))).toBe(true);
  });

  it('不用工作流级 paths 过滤（必过检查要永远触发）', () => {
    expect(yml).not.toMatch(/^\s+paths(-ignore)?:/m);
  });
});

/**
 * 测试怎么分台（test-split.ts 装箱，#654 F 从「按包分组 + vitest --shard 按文件个数切」换成「一个池子、按耗时装箱」）。
 * 每个文件都必须正好落到一台：漏一个就是那个测试再也没人跑（汇总只看跑了的那几台是不是绿）。
 */
describe('测试分台（按耗时装箱，一台一份明确的文件清单）', () => {
  const coverage = (p: CiPlan): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const u of p.testUnits) {
      out[u] = boxFiles(p).filter((fs) =>
        fs.some((f) => f.startsWith(`packages/${u}/`) || f.startsWith('agents/')),
      ).length
        ? '有台'
        : '没有台';
    }
    return out;
  };

  it('全跑：每一台都有明确的文件清单，合起来正好是全部测试文件、不重不漏；每台的名字看得出第几台/共几台、pg、temporal', () => {
    const p = assigned(planCi({ event: 'push', changed: [], graph: graph() }));
    // 8 台封顶（TARGET_BOX_MS 50 秒、MAX_BOXES 8）：全量的耗时合计远大于 8×50 秒 → 8 台
    expect(p.tests.length).toBe(8);
    const all = boxFiles(p).flat();
    expect(all.length).toBe(ALL_TESTS.length);
    expect([...all].sort()).toEqual([...ALL_TESTS].sort());
    // 名字：第几台/共几台，pg 台带「· pg」，装了 Temporal 的带「· temporal」（具体哪台随耗时表变，不钉死）
    expect(labels(p).map((l, i) => l.startsWith(`${i + 1}/8`))).toEqual(Array(8).fill(true));
    expect(labels(p).filter((l) => l.includes('· pg')).length).toBeGreaterThanOrEqual(1);
    expect(labels(p).filter((l) => l.includes('· temporal'))).toHaveLength(1);
    // 台数封顶 8 之后，全量合计远大于 8×目标（表里 455 个文件合计 700 秒上下），每台自然超过「目标 50 秒」，所以不拿目标比、
    // 拿平均比：装得匀，哪一台都不超过平均的 1.3 倍（pg 台只有 db 的文件、不能和别的台互补，它是最容易偏高的那一台）。
    // 原来写「目标的两倍」，耗时表一刷新（总量涨了）就红，不是装箱坏了。
    const avg = p.tests.reduce((s, b) => s + b.estMs, 0) / p.tests.length;
    for (const b of p.tests) expect(b.estMs).toBeLessThanOrEqual(avg * 1.3);
    expect(coverage(p)).toEqual(Object.fromEntries(p.testUnits.map((u) => [u, '有台'])));
  });

  it('db 的测试单独一台（要真 Postgres），那一台只有 db 的文件；别的台不带 pg', () => {
    const p = assigned(pr('packages/db/src/schema/index.ts'));
    const pg = p.tests.filter((b) => b.pg);
    expect(pg.length).toBeGreaterThanOrEqual(1);
    for (const b of pg) expect(b.files.every((f) => f.startsWith('packages/db/'))).toBe(true);
    for (const b of p.tests.filter((x) => !x.pg))
      expect(b.files.some((f) => f.startsWith('packages/db/'))).toBe(false);
  });

  it('要 Temporal 命令行的文件（github-reconcile.test.ts）装在哪台，哪台装 Temporal', () => {
    const p = assigned(pr('packages/engine/src/worker.ts'));
    const withTemporal = p.tests.filter((b) => b.temporal);
    expect(withTemporal).toHaveLength(1);
    expect(withTemporal[0]?.files).toContain('packages/engine/test/github-reconcile.test.ts');
    for (const b of p.tests.filter((x) => !x.temporal)) expect(b.temporal).toBe(false);
  });

  it('只改一个包：台数按工作量定（包小就一台，不为了「并行」白起机器）', () => {
    const p = assigned(pr('packages/agent-eval/src/cli.ts'));
    expect(p.tests).toHaveLength(1);
    expect(labels(p)).toEqual(['1/1']);
    expect(p.tests[0]?.files.every((f) => f.startsWith('packages/agent-eval/'))).toBe(true);
  });

  it('改了 engine：engine 的 88 个文件按耗时装进几台，最慢的几台差得不多（不再像 --shard 那样 89/35/137）', () => {
    const p = assigned(pr('packages/engine/src/worker.ts'));
    expect(p.tests.length).toBeGreaterThan(1);
    const loads = p.tests.map((b) => b.estMs);
    const total = loads.reduce((a, b) => a + b, 0);
    // LPT：最重的台不超过「平均 + 最重那个文件」（装箱问题的常识上界）
    const heaviest = Math.max(
      ...p.tests
        .flatMap((b) => b.files)
        .map((f) => (typeof TIMINGS === 'string' ? 0 : (TIMINGS.files[f] ?? 0))),
    );
    expect(Math.max(...loads)).toBeLessThanOrEqual(total / loads.length + heaviest);
    for (const b of p.tests) expect(b.files.every((f) => f.startsWith('packages/engine/'))).toBe(true);
  });

  it('【故意造出的失败】少一台 / 两台重了：coverage 报出来，不当成齐了', () => {
    const p = assigned(planCi({ event: 'push', changed: [], graph: graph() }));
    const lost = { ...p, tests: p.tests.slice(0, 3) };
    const all = boxFiles(lost).flat();
    expect([...all].sort()).not.toEqual([...ALL_TESTS].sort());
    const first = p.tests[0] as TestBox;
    const dup: CiPlan = { ...p, tests: [first, { ...first, label: '重了' }] };
    expect(
      ciVerdict({
        changes: { result: 'success', outputs: planOutputs(dup) },
        lint: { result: 'success' },
        test: { result: 'success' },
        web: { result: 'success' },
        e2e: { result: 'success' },
        deploy: { result: 'success' },
      }).ok,
    ).toBe(false);
  });

  it('ci.yml 的 job 名用 matrix.label（每台名字不同），环境的开关按 matrix.pg / matrix.temporal 判', () => {
    const yml = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
    expect(yml).toContain(['name: test ($', '{{ matrix.label }})'].join(''));
    expect(yml).toContain('if: matrix.pg');
    expect(yml).toContain('if: matrix.temporal');
    expect(yml).not.toContain("matrix.name == 'db'");
    // 不再有 --shard：每台给的是明确的文件清单
    expect(yml).not.toMatch(/--shard=\d/);
  });
});

describe('驾驶舱 e2e（#930）：CI 一律全套（决定 0101），本机 planCi 按改动给 spec 清单（决定 0029）；红了汇总就红', () => {
  const needs = (p: CiPlan, over: Record<string, unknown> = {}) => ({
    changes: { result: 'success', outputs: planOutputs(p) },
    lint: { result: 'success', outputs: {} },
    test: { result: p.tests.length > 0 ? 'success' : 'skipped', outputs: {} },
    web: { result: p.web ? 'success' : 'skipped', outputs: {} },
    e2e: { result: e2eRuns(p.e2e) ? 'success' : 'skipped', outputs: {} },
    deploy: { result: p.deploy === 'none' ? 'skipped' : 'success', outputs: {} },
    ...over,
  });
  const SPECS = 'packages/web/e2e/specs/';
  const ALL_SPEC_FILES = readdirSync(join(ROOT, SPECS))
    .filter((n) => n.endsWith('.e2e.ts'))
    .sort();

  it('改一个页面文件：清单只含那页的 spec（不是全套）；输出是相对 packages/web 的路径、空格隔开', () => {
    const p = pr('packages/web/src/routes/notifications.tsx');
    expect(p.e2e).toEqual([`${SPECS}06-notifications.e2e.ts`, `${SPECS}08-backend-down.e2e.ts`]);
    expect(planOutputs(p).e2e).toBe('e2e/specs/06-notifications.e2e.ts e2e/specs/08-backend-down.e2e.ts');
    // 登录页只有登录那个 spec
    expect(pr('packages/web/src/routes/login.tsx').e2e).toEqual([`${SPECS}01-login.e2e.ts`]);
    // 页面私有的组件跟着它的页面走；目录前缀整个认
    expect(pr('packages/web/src/components/home/flow-board.tsx').e2e).toContain(`${SPECS}02-home.e2e.ts`);
    // 首页窄屏页头（#2969）挂在主页这条上：只落在 specs/ 里、没有页面指向，映射表自检会红
    expect(pr('packages/web/src/routes/home.tsx').e2e).toContain(`${SPECS}02c-home-narrow.e2e.ts`);
    expect(pr('packages/web/src/components/home/flow-board.tsx').e2e).not.toContain(
      `${SPECS}06-notifications.e2e.ts`,
    );
    // 改到的 spec 文件自己：只跑它
    expect(pr(`${SPECS}05-settings.e2e.ts`).e2e).toEqual([`${SPECS}05-settings.e2e.ts`]);
    // 两页一起改：清单是并集、去重、排好序
    const two = pr('packages/web/src/routes/login.tsx', 'packages/web/src/routes/notifications.tsx').e2e;
    expect(two).toEqual([...new Set(two as string[])].sort());
    expect(two).toContain(`${SPECS}01-login.e2e.ts`);
    expect(two).toContain(`${SPECS}06-notifications.e2e.ts`);
  });

  it('改 e2e 夹具（support/）、playwright 配置、e2e 的备库、ci.yml、映射表本身（ci-plan.ts）：全套', () => {
    for (const f of [
      'packages/web/e2e/support/fixtures.ts',
      'packages/web/e2e/support/viewports.ts',
      'packages/web/e2e/playwright.config.ts',
      'packages/api/test/e2e/prepare.ts',
      '.github/workflows/ci.yml',
      'packages/conventions/src/ci-plan.ts',
    ]) {
      const p = pr(f);
      expect(p.e2e, f).toBe('all');
      expect(planOutputs(p).e2e, f).toBe('all');
    }
    // 和一个页面一起改：全套盖过清单
    expect(pr('packages/web/src/routes/login.tsx', 'packages/web/e2e/support/stack.ts').e2e).toBe('all');
  });

  it('映射不到页面的 web 改动（共享组件、样式、路由骨架、壳、包配置）：全套，不拿「没映射」冒充不用跑', () => {
    for (const f of [
      'packages/web/src/app.css',
      'packages/web/src/routes.ts',
      'packages/web/src/root.tsx',
      'packages/web/src/routes/shell.tsx',
      'packages/web/src/components/page.tsx',
      'packages/web/src/components/ui/button.tsx',
      'packages/web/src/lib/format.ts',
      'packages/web/src/api/client.tsx',
      'packages/web/package.json',
      'packages/web/vite.config.ts',
      // 不是 spec 的合规名字（含奇怪字符）：不原样交给 playwright，走全套
      'packages/web/e2e/specs/x y.e2e.ts',
    ]) {
      expect(pr(f).e2e, f).toBe('all');
    }
    // 一个映射得到、一个映射不到：全套
    expect(pr('packages/web/src/routes/login.tsx', 'packages/web/src/app.css').e2e).toBe('all');
  });

  it('只改 api（含 api 的测试）、只改 web 的测试文件和 .md、改的页面没有 spec 盖着：空清单，输出空串', () => {
    for (const f of [
      'packages/api/src/cockpit.ts',
      'packages/api/test/health.test.ts',
      'packages/web/src/routes/login.test.tsx',
      'packages/web/src/lib/utils.test.ts',
      'packages/web/src/test/harness.tsx',
      'packages/web/e2e/README.md',
      'packages/web/src/routes/soon.tsx',
    ]) {
      const p = pr(f);
      expect(p.e2e, f).toEqual([]);
      expect(planOutputs(p).e2e, f).toBe('');
    }
    // 法国页现在有 spec 点它（环境页并进来，#1217）：改它要跑 07b、07c，不再是空清单
    expect(pr('packages/web/src/routes/france.tsx').e2e).toEqual([
      `${SPECS}07b-env.e2e.ts`,
      `${SPECS}07c-nodes.e2e.ts`,
    ]);
    expect(pr('packages/api/src/cockpit.ts', 'packages/api/src/db.ts').e2e).toEqual([]);
    // 空清单和别的页面一起改：只剩别的页面
    expect(pr('packages/api/src/cockpit.ts', 'packages/web/src/routes/login.tsx').e2e).toEqual([
      `${SPECS}01-login.e2e.ts`,
    ]);
  });

  it('改到的 spec 文件被删了：不再点名它（playwright 找不到文件会红）；删了又只改这一个就是空清单', () => {
    const gone = `${SPECS}99-gone.e2e.ts`;
    const exists = (rel: string) => rel !== gone;
    expect(e2eSpecsFor([gone], exists)).toEqual([]);
    expect(e2eSpecsFor([gone, `${SPECS}01-login.e2e.ts`], exists)).toEqual([`${SPECS}01-login.e2e.ts`]);
    const p = planCi({ event: 'pull_request', changed: [gone], graph: graph(), specExists: exists });
    expect(p.e2e).toEqual([]);
  });

  it('映射表自检：每条的文件都在仓里、每个 spec 都在 specs/ 里；每个 spec 至少有一页指向它', () => {
    const seen = new Set<string>();
    for (const entry of E2E_PAGE_MAP) {
      expect(entry.files.length).toBeGreaterThan(0);
      for (const f of entry.files) {
        expect(existsSync(join(ROOT, f)), `映射表里的 ${f} 不在仓里`).toBe(true);
        if (f.endsWith('/')) expect(statSync(join(ROOT, f)).isDirectory(), f).toBe(true);
      }
      for (const s of entry.specs) {
        expect(s.startsWith(E2E_SPEC_DIR), s).toBe(true);
        expect(existsSync(join(ROOT, s)), `映射表里的 ${s} 不在 specs/ 里`).toBe(true);
        seen.add(s);
      }
    }
    // 新加了 spec 却忘了接进映射表：改那一页的 PR 不会点到它（只有每夜才跑），这里拦住
    // 例外：09-logout 测的是壳的账号菜单，壳（shell.tsx、topbar）不在表里——壳的改动本来就按「映射不到」走全套
    const SHELL_ONLY = ['09-logout.e2e.ts'];
    for (const n of ALL_SPEC_FILES.filter((x) => !SHELL_ONLY.includes(x)))
      expect(seen.has(`${SPECS}${n}`), `${n} 没有任何页面指向它`).toBe(true);
    // 同一个文件不在两条里（两条说法打架）
    const files = E2E_PAGE_MAP.flatMap((e) => e.files);
    expect(new Set(files).size).toBe(files.length);
  });

  it('【故意造出的失败】认不出改了什么（非 PR 事件、空改动、依赖图读不出、认不出的路径）：全套，不拿「没改什么」冒充可以不跑', () => {
    // 每夜（schedule）、主线推送、手动：一行不改，照旧全套
    for (const event of ['push', 'schedule', 'workflow_dispatch', 'merge_group'])
      expect(planCi({ event, changed: ['README.md'], graph: graph() }).e2e, event).toBe('all');
    expect(
      planCi({ event: 'schedule', changed: ['packages/api/src/cockpit.ts'], graph: graph() }).e2e,
      '每夜轮即使改动只碰 api 也是全套',
    ).toBe('all');
    expect(planCi({ event: 'pull_request', changed: [], graph: graph() }).e2e).toBe('all');
    expect(planCi({ event: 'pull_request', changed: ['docs/x.md'], graph: '读不出' }).e2e).toBe('all');
    expect(pr('some-new-top-dir/file.txt').e2e).toBe('all');
    expect(pr('packages/not-a-package/src/a.ts').e2e).toBe('all');
    // 认不出的路径和只改 api 一起：全套盖过空清单
    expect(pr('some-new-top-dir/file.txt', 'packages/api/src/cockpit.ts').e2e).toBe('all');
  });

  it('别的改动不开：文档、别的包、db、shared、根配置、deploy/（升了全跑也不开）、别的工作流', () => {
    for (const f of [
      'docs/design.md',
      'packages/engine/src/index.ts',
      'packages/agent-eval/src/cli.ts',
      'packages/db/src/catalog.ts',
      'packages/shared/src/domain.ts',
      'pnpm-lock.yaml',
      'deploy/france.sh',
      'biome.json',
      '.github/workflows/merge-gate.yml',
    ]) {
      const p = pr(f);
      expect(p.e2e, f).toEqual([]);
      expect(planOutputs(p).e2e, f).toBe('');
    }
    // deploy/ 升全跑，但 e2e 不跟着开：全跑的原因和 e2e 认的路径是两回事
    expect(pr('deploy/france.sh')).toMatchObject({ full: true, e2e: [] });
    // 一起改：页面的清单照出
    expect(pr('docs/design.md', 'packages/web/src/routes/login.tsx').e2e).toEqual([
      `${SPECS}01-login.e2e.ts`,
    ]);
  });

  it('同树复用（主线推送）：PR 那一轮跑的是全套，test、web、e2e、deploy 都不再跑（e2e 也复用）', () => {
    const full = assigned(ciFullPlan());
    const reuse = { run: 11, pr: 7, tree: 'a'.repeat(40) };
    const reused = applyReuse(full, reuse);
    expect(reused.e2e).toEqual([]);
    expect(planOutputs(reused).e2e).toBe('');
    const ok = ciVerdict(needs(reused), 'push');
    expect(ok.ok, ok.lines.join('\n')).toBe(true);
    expect(ok.lines.join('\n')).toContain('✓ e2e：skipped');
    // 【故意造出的失败】复用了，e2e 却又跑了：开关和 if 对不上，汇总红
    const ran = ciVerdict(needs(reused, { e2e: { result: 'success' } }), 'push');
    expect(ran.ok).toBe(false);
    expect(ran.lines.join('\n')).toContain('✗ e2e：success，本该 skipped');
    // 复用的 plan 里还有 e2e、web 要跑：汇总不信
    for (const lying of [
      { ...reused, e2e: 'all' as const },
      { ...reused, web: true },
    ]) {
      const v = ciVerdict(needs(lying), 'push');
      expect(v.ok).toBe(false);
      expect(v.lines.join('\n')).toContain('还有要测的');
    }
  });

  /**
   * 【故意造出的失败】e2e 红 → 汇总红。全套里 e2e job 红了、被取消、被误跳过，汇总都得红并点名。
   */
  it('【故意造出的失败】e2e 该跑却红了、取消了、被跳过、没有结果：汇总红，点名 e2e', () => {
    const p = assigned(ciFullPlan());
    expect(ciVerdict(needs(p)).ok).toBe(true);
    for (const result of ['failure', 'cancelled', 'skipped']) {
      const v = ciVerdict(needs(p, { e2e: { result } }));
      expect(v.ok, result).toBe(false);
      expect(v.lines.join('\n')).toContain(`✗ e2e：${result}，本该 success`);
    }
    const missing = needs(p) as Record<string, unknown>;
    delete missing.e2e;
    const none = ciVerdict(missing);
    expect(none.ok).toBe(false);
    expect(none.lines.join('\n')).toContain('✗ e2e：没有这个 job 的结果');
  });

  it('开关输出和 plan 不是同一份：红；GitHub 不放空串输出（复用时 e2e 空）按空串认', () => {
    const p = assigned(ciFullPlan());
    const reused = applyReuse(p, { run: 11, pr: 7, tree: 'a'.repeat(40) });
    // GitHub 不把空串输出放进 needs（#1204 那次真事）：没有 e2e 这一项按空串认
    const omitted = needs(reused);
    const { e2e: _dropped, ...rest } = omitted.changes.outputs;
    omitted.changes.outputs = rest;
    const okOmitted = ciVerdict(omitted, 'push');
    expect(okOmitted.ok, okOmitted.lines.join('\n')).toBe(true);
    // 【故意造出的失败】plan 要跑 e2e，输出却缺了这一项：不能当成空清单放过
    const missing = needs(p);
    const { e2e: _gone, ...rest2 } = missing.changes.outputs;
    missing.changes.outputs = rest2;
    expect(ciVerdict(missing).ok).toBe(false);
    // 开关输出和 plan 里的不是同一份
    for (const wrong of ['', 'e2e/specs/01-login.e2e.ts']) {
      const n = needs(p);
      n.changes.outputs = { ...n.changes.outputs, e2e: wrong };
      const off = ciVerdict(n);
      expect(off.ok, wrong).toBe(false);
      expect(off.lines.join('\n')).toContain('e2e job 的开关');
    }
    // plan 缺 e2e 字段（旧的 plan）、或还是旧的 true/false：认不出，不当成不用跑
    for (const bad of [undefined, true, false, 'some', [1]]) {
      const old = JSON.parse(planOutputs(p).plan as string) as Record<string, unknown>;
      if (bad === undefined) delete old.e2e;
      else old.e2e = bad;
      const m = needs(p);
      m.changes.outputs = { ...m.changes.outputs, plan: JSON.stringify(old) };
      expect(ciVerdict(m).ok, String(bad)).toBe(false);
    }
  });

  it('【故意造出的失败】本机选测的 plan（全跑但 e2e 只点几页或不点，比如改 deploy/ 脚本）交给汇总：红，CI 不认', () => {
    const p = assigned(pr('deploy/france.sh'));
    expect(p).toMatchObject({ full: true, e2e: [] });
    expect(ciVerdict(needs(p)).ok).toBe(false);
    const withPage = assigned(pr('deploy/france.sh', 'packages/web/src/routes/login.tsx'));
    expect(withPage).toMatchObject({ full: true, e2e: [`${SPECS}01-login.e2e.ts`] });
    const v = ciVerdict(needs(withPage));
    expect(v.ok).toBe(false);
    expect(v.lines.join('\n')).toContain('plan 不是全套');
  });

  it('ci.yml 的 e2e job：只在 changes 给 all 时开、跑全套分片、红了不吞（没有 continue-on-error / || true）、Postgres 和 Chromium 照 README 给，汇总 job 等它', () => {
    const yml = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    const doc = parse(yml) as {
      jobs: Record<
        string,
        {
          needs?: unknown;
          if?: string;
          'timeout-minutes'?: number;
          env?: Record<string, string>;
          steps?: Array<Record<string, unknown>>;
        }
      >;
    };
    const e2e = doc.jobs.e2e;
    expect(e2e, 'ci.yml 里没有 e2e job').toBeDefined();
    expect(e2e?.needs).toBe('changes');
    expect(e2e?.if, '只有全套这一种跑法；同树复用（输出空串）整个跳过').toBe(
      "needs.changes.outputs.e2e == 'all'",
    );
    expect(e2e?.['timeout-minutes'], '要给总耗时上限').toBeGreaterThan(0);
    expect(e2e?.['timeout-minutes']).toBeLessThanOrEqual(15);
    expect(e2e?.env?.E2E_PG_ADMIN_URL).toMatch(/^postgres:\/\/postgres@127\.0\.0\.1:5432\/postgres$/);
    expect(e2e?.env?.E2E_BROWSER_CHANNEL).toBe('chromium');
    const steps = e2e?.steps ?? [];
    const runs = steps.map((s) => String(s.run ?? '')).join('\n');
    expect(runs).toContain('pnpm --filter @fleet-dao/web e2e');
    expect(runs).toContain('playwright install --with-deps chromium');
    expect(runs).toContain('postgres:16');
    // 红了不吞：没有 job 级 continue-on-error，也没有步骤级的（隔离集 2026-10-16 起挪去 e2e-quarantine.yml 每天跑）；没有 || true
    expect(e2e).not.toHaveProperty('continue-on-error');
    expect(steps.filter((s) => 'continue-on-error' in s)).toEqual([]);
    expect(JSON.stringify(steps)).not.toContain('E2E_QUARANTINE: only');
    const quarantineYml = readFileSync(join(ROOT, '.github/workflows/e2e-quarantine.yml'), 'utf8');
    expect(quarantineYml).toMatch(/^ {2}schedule:/m);
    expect(quarantineYml).toMatch(/^ {2}workflow_dispatch:/m);
    expect(quarantineYml).toContain('E2E_QUARANTINE: only');
    expect(doc.jobs.check?.needs).not.toContain('quarantine');
    expect(runs).not.toContain('|| true');
    // 跑 e2e 的那一步本身没有 if（该跑的 job 里它一定跑）
    const run = steps.find((s) => String(s.run ?? '').includes('pnpm --filter @fleet-dao/web e2e'));
    expect(run, '找不到跑 e2e 的那一步').toBeDefined();
    expect(run).not.toHaveProperty('if');
    expect((run?.env as Record<string, string> | undefined)?.E2E_QUARANTINE, '挡的那一步跳过隔离集').toBe(
      'skip',
    );
    // 全套：不给 spec 参数（两种屏宽都在 playwright 配置的项目里），不再有「只点改动页」那条路
    expect(String(run?.run)).not.toContain('${{');
    expect(String(run?.run).trim()).toBe(
      'pnpm --filter @fleet-dao/web e2e --shard="$SHARD" --pass-with-no-tests',
    );
    expect(run?.env as Record<string, string> | undefined).not.toHaveProperty('E2E_SPECS');
    // 分片连续且不重复：漏片或重复跑一片都会让全套覆盖不成立。
    const strategy = (e2e as { strategy?: { 'fail-fast'?: boolean; matrix?: { shard?: number[] } } })
      ?.strategy;
    const shards = strategy?.matrix?.shard ?? [];
    expect(shards.length).toBeGreaterThan(0);
    expect(shards).toEqual(Array.from({ length: shards.length }, (_, i) => i + 1));
    expect(strategy?.['fail-fast'], '一片失败不能取消其余片的验证').toBe(false);
    expect((run?.env as Record<string, string> | undefined)?.SHARD).toBe(
      '${{ matrix.shard }}/${{ strategy.job-total }}',
    );
    // 汇总 job 等它
    expect(doc.jobs.check?.needs).toContain('e2e');
    // 它的名字在 PLANNED_JOBS 里（汇总核对）
    expect(PLANNED_JOBS).toContain('e2e');
  });
});
