import { spawnSync } from 'node:child_process';
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
  assignTests,
  type CiPlan,
  ciVerdict,
  dependentsClosure,
  fallbackUnits,
  PATH_RULES,
  type PackageGraph,
  PLANNED_JOBS,
  planCi,
  planOutputs,
  readGraph,
} from '../src/ci-plan.ts';
import { parseRiskPaths, RISK_PATHS_FILE } from '../src/merge-gates.ts';
import { fsRepo } from '../src/repo.ts';
import { listTestFiles, parseTimings, TARGET_BOX_MS, type TestBox, TIMINGS_FILE } from '../src/test-split.ts';
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

  it('根配置、锁文件、CI 工作流、shared、测试夹具、deploy/：全跑', () => {
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
      'packages/adapters/test/fixtures/claude-code/x.ndjson',
      'packages/adapters/test/quota/fixtures/y.json',
      'deploy/lib/common.sh',
    ]) {
      expect(pr(f).full, f).toBe(true);
    }
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

  it('只改一个没人依赖的包（cli）：只测它、只类型检查它，不打包 web、不跑 deploy', () => {
    const p = pr('packages/cli/src/help.ts');
    expect(p).toMatchObject({ full: false, biome: true, tsc: ['packages/cli'], web: false, deploy: 'none' });
    expect(units(p)).toEqual(['cli']);
    // 装箱之后只跑 cli 自己的测试文件，一台
    const packed = assigned(p);
    expect(labels(packed)).toEqual(['1/1']);
    expect(
      boxFiles(packed)
        .flat()
        .every((f) => f.startsWith('packages/cli/')),
    ).toBe(true);
  });

  it('改了 conventions：engine 依赖它，engine 也测（api、github 经 engine 传上来：它们依赖 engine）', () => {
    expect(units(pr('packages/conventions/src/ci-plan.ts'))).toEqual([
      'api',
      'conventions',
      'engine',
      'github',
    ]);
  });

  it('改了 db：db 和所有依赖它的（engine、api、github、jev）都测；pg 的测试单独一台', () => {
    const p = pr('packages/db/src/schema/index.ts');
    expect(units(p)).toEqual(['api', 'db', 'engine', 'github', 'jev']);
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
    for (const u of ['db', 'engine', 'api', 'github', 'jev']) {
      expect(
        boxFiles(packed)
          .flat()
          .some((f) => f.startsWith(`packages/${u}/`)),
        u,
      ).toBe(true);
    }
    expect(p.tsc).toEqual(expect.arrayContaining(['packages/db', 'packages/engine', 'packages/api']));
  });

  it('改了 engine（#88 的偶发超时只挡改到 engine 的 PR）：别的包的 PR 不测 engine', () => {
    expect(units(pr('packages/engine/src/worker.ts'))).toEqual(['engine']);
    for (const f of [
      'packages/cli/src/help.ts',
      'packages/web/src/app.css',
      'packages/agents-sync/src/sync.ts',
      'docs/ops.md',
    ]) {
      expect(units(pr(f)), f).not.toContain('engine');
    }
  });

  it('改了 web：打包演示版、跑 deploy（发布、扫产物用它）；api、feishu 的测试读 web 的文件，也测，但不往下传到 engine', () => {
    const p = pr('packages/web/src/build/scan.ts');
    expect(p).toMatchObject({ web: true, deploy: 'all' });
    expect(units(p)).toEqual(['api', 'feishu', 'web']);
  });

  it('改了 feishu、agents-sync：deploy/test 打包网关、跑同步脚本，要跑 deploy', () => {
    expect(pr('packages/feishu/src/gateway.ts').deploy).toBe('all');
    expect(pr('packages/agents-sync/src/sync.ts').deploy).toBe('all');
    expect(pr('packages/jev/src/index.ts').deploy).toBe('none');
  });

  it('只改 docs/ops.md：deploy 只跑读它的两块（run.sh --ops），和要全套的一起改照旧全套', () => {
    expect(pr('docs/ops.md').deploy).toBe('ops');
    expect(pr('docs/ops.md', 'docs/design.md', 'specs/1-x/方案.md').deploy).toBe('ops');
    // 顺序不影响：全套压过 ops
    expect(pr('docs/ops.md', 'packages/feishu/src/gateway.ts').deploy).toBe('all');
    expect(pr('packages/agents-sync/src/sync.ts', 'docs/ops.md').deploy).toBe('all');
    expect(pr('docs/ops.md', 'deploy/france.sh').full).toBe(true);
    expect(pr('docs/ops.md', 'deploy/france.sh').deploy).toBe('all');
    expect(planOutputs(pr('docs/ops.md')).deploy).toBe('ops');
  });

  it('测试会读的包外文件：AGENTS.md、docs/ops.md、agents/、PR 模板、.gitignore 各自带上读它的包', () => {
    // AGENTS.md 要带两家：agents-sync 分发它，agents 的钉子测试读它（agents/test/rules/design-skills.rules.test.ts，#522）；
    // 只带 agents-sync 的话改通用段的 PR 不测 agents，那条钉子测试根本不跑（主线从 1bff4dbc 起红了 8+ 个提交）
    expect(pr('AGENTS.md')).toMatchObject({
      biome: false,
      deploy: 'none',
      testUnits: ['agents', 'agents-sync'],
    });
    expect(pr('docs/ops.md')).toMatchObject({ deploy: 'ops', testUnits: ['db'] });
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

  it('改了 shared：只算 shared 自己；依赖它的（依赖图里直接间接依赖它的全部）放进 dependents，留给 CI', () => {
    expect(usersOf('shared').length).toBeGreaterThan(5);
    expect(fb('packages/shared/src/domain.ts')).toEqual({
      units: ['shared'],
      hubs: ['shared'],
      dependents: usersOf('shared'),
    });
  });

  it('shared 和 db 一起改：db 照 planCi 带上依赖它的，shared 只算自己；已经在 units 里的不在 dependents 里重复', () => {
    const r = fb('packages/shared/src/domain.ts', 'packages/db/src/schema/index.ts');
    expect(r.units).toEqual([...pr('packages/db/src/schema/index.ts').testUnits, 'shared'].sort());
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
    expect(fb('pnpm-lock.yaml', 'packages/cli/src/help.ts')).toEqual({
      units: ['cli'],
      hubs: [],
      dependents: [],
    });
  });

  it('测试夹具、不在依赖图里的包目录：算那个包自己，依赖它的放进 dependents', () => {
    expect(fb('packages/adapters/test/fixtures/claude-code/x.ndjson')).toEqual({
      units: ['adapters'],
      hubs: ['adapters'],
      dependents: usersOf('adapters'),
    });
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
      if (name === 'node_modules' || name === 'dist' || name === 'dist-demo') continue;
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
      'deploy/examples/catalog.example.json', // repoFile(EXAMPLE_PATH)
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
   * 【故意造出的失败】上面那条平时绿着，看不出它还在不在查。真要拦住的是「漏记一处」，
   * 所以这里把门开一次、关一次，对着看：开着时一处都不漏，关掉 AGENTS.md 这道门里的 agents 后
   * 正好红在那一处。少了这条，改 AGENTS.md 不测 agents 又能悄悄过去
   * （主线从 1bff4dbc（#527）起红了 8+ 个提交就是这么来的）。
   */
  it('【故意造出的失败】把 agents 从 AGENTS.md 这道门里去掉：扫出来必须正好是那一处', () => {
    // 开着：改 AGENTS.md 测 agents 和 agents-sync，读它的那条测试算进了门里，一处都不漏
    expect(testArgs(pr('AGENTS.md'))).toEqual(['agents/', 'packages/agents-sync/']);
    expect(scan((changed) => planCi({ event: 'pull_request', changed, graph: graph() }))).toEqual([]);
    // 关掉：只把管 AGENTS.md 那道门的 agents 去掉，别的门一个都不碰
    const shut = PATH_RULES.map((r) =>
      r.match('AGENTS.md') && 'units' in r ? { ...r, units: r.units.filter((u) => u !== AGENTS_UNIT) } : r,
    );
    expect(
      shut.filter((r, i) => r !== PATH_RULES[i]),
      '没关掉任何门：管 AGENTS.md 的那道门写法换了，这条测试跟着改',
    ).toHaveLength(1);
    // 关掉后，上面那条正对着的那处漏记必须报出来——读 AGENTS.md 的每个测试都得报，一封不少、也不多报别人。
    // 报几条是从 files 现算的：以后再加一个读 AGENTS.md 的测试（2026-10-01 加 ask-scope.rules.test.ts 时
    // 这里写死成一条、主线当场红），不会因为写死的条数又红一次；反过来，门还开着却少报一条，照样红。
    const readers = files
      .filter(({ unit, rel }) => unit === AGENTS_UNIT && refs(rel).includes('AGENTS.md'))
      .map(({ rel }) => `${rel} 读 AGENTS.md，改它的 PR 不测 agents`);
    expect(readers.length, '没有测试读 AGENTS.md 了：这条查的漏记不存在，测试该删').toBeGreaterThan(0);
    expect(
      scan((changed) => planCi({ event: 'pull_request', changed, graph: graph(), rules: shut })),
    ).toEqual(readers);
  });
});

describe('汇总（必过检查 check）：该跑的跑了且绿，不该跑的跳过了', () => {
  // 汇总核的是 changes 给的 plan + 矩阵里的那份台：和入口同一条路（planCi → assignTests），不然「有单元没装箱」会被判成该跳过
  const plan = assigned(pr('packages/conventions/src/ci-plan.ts'));
  const needs = (over: Record<string, unknown> = {}, p: CiPlan = plan) => ({
    changes: { result: 'success', outputs: planOutputs(p) },
    lint: { result: 'success', outputs: {} },
    test: { result: 'success', outputs: {} },
    web: { result: 'skipped', outputs: {} },
    deploy: { result: 'skipped', outputs: {} },
    ...over,
  });

  it('对得上就过，逐个写出来', () => {
    const v = ciVerdict(needs());
    expect(v.ok).toBe(true);
    expect(v.lines).toHaveLength(ALWAYS_JOBS.length + PLANNED_JOBS.length);
  });

  it('纯文档：lint（里面只跑 docs、hygiene 两步）、changes 跑了，test、web、deploy 跳过', () => {
    const docs = assigned(pr('docs/design.md'));
    const skipped = { result: 'skipped' };
    expect(ciVerdict(needs({ test: skipped }, docs)).ok).toBe(true);
    // lint 是每次都得跑的（它里面有 docs、hygiene 两步每次都跑）：跳过它 = 没跑该跑的
    expect(ciVerdict(needs({ test: skipped, lint: skipped }, docs)).ok).toBe(false);
  });

  it('本该跑的被跳过、红了、取消了：不过', () => {
    for (const result of ['skipped', 'failure', 'cancelled']) {
      const v = ciVerdict(needs({ test: { result } }));
      expect(v.ok, result).toBe(false);
      expect(v.lines.join('\n')).toContain(`✗ test：${result}，本该 success`);
    }
  });

  it('lint（biome/tsc/docs/hygiene 并成的那个）红了：不过，报的是这一项', () => {
    const v = ciVerdict(needs({ lint: { result: 'failure' } }));
    expect(v.ok).toBe(false);
    expect(v.lines.join('\n')).toContain('✗ lint：failure');
  });

  it('deploy=ops：deploy job 要跑且绿（只跑两块也是跑），跳过、红了都不过', () => {
    const ops = assigned(pr('docs/ops.md'));
    const over = { test: { result: 'success' } };
    expect(ciVerdict(needs({ ...over, deploy: { result: 'success' } }, ops)).ok).toBe(true);
    for (const result of ['skipped', 'failure']) {
      const v = ciVerdict(needs({ ...over, deploy: { result } }, ops));
      expect(v.ok, result).toBe(false);
      expect(v.lines.join('\n')).toContain(`✗ deploy：${result}，本该 success`);
    }
  });

  it('本该跳过的却跑了（开关和 if 对不上）：不过', () => {
    expect(ciVerdict(needs({ web: { result: 'success' } })).ok).toBe(false);
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
    const withDeploy = (d: unknown) => JSON.stringify({ ...pr('docs/ops.md'), deploy: d });
    for (const bad of ['', '{', '{"full":true}', undefined, withDeploy(true), withDeploy('some')]) {
      const n = needs();
      n.changes.outputs = { ...n.changes.outputs, plan: bad as string };
      expect(ciVerdict(n).ok, String(bad)).toBe(false);
    }
    expect(ciVerdict(null).ok).toBe(false);
    expect(ciVerdict('x').ok).toBe(false);
  });

  it('plan 说全跑却有 job 没开（被改坏的 plan）：不过', () => {
    const full = assigned(planCi({ event: 'push', changed: [], graph: graph() }));
    const broken = { ...full, web: false };
    expect(ciVerdict(needs({ web: { result: 'skipped' } }, broken)).ok).toBe(false);
    // 全跑却只跑 deploy 的两块：job 照样 success，但 plan 本身不对
    const opsOnly: CiPlan = { ...full, deploy: 'ops' };
    const allGreen = {
      web: { result: 'success' },
      tsc: { result: 'success' },
      deploy: { result: 'success' },
    };
    expect(ciVerdict(needs(allGreen, full)).ok).toBe(true);
    expect(ciVerdict(needs(allGreen, opsOnly)).ok).toBe(false);
  });

  /**
   * 【故意造出的失败】planCi 之后忘了装箱（或者装箱失败还照常往下走）：test job 会被 if 判成不该跑、汇总却当它
   * 「本该 skipped」，一个测试都不跑还算绿。有要测的单元却一台都没有，汇总必须红。
   */
  it('【故意造出的失败】有要测的单元却一台测试都没有（没装箱）：不过，不当成「本该 skipped」', () => {
    const noBoxes = pr('packages/cli/src/help.ts');
    expect(noBoxes.testUnits, '这条查的场景不成立了（planCi 现在自己装箱了？）').toEqual(['cli']);
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
    const p = assigned(pr('packages/cli/src/help.ts'));
    n.changes.outputs = { ...n.changes.outputs, plan: JSON.stringify(p), tests: '[]' };
    expect(ciVerdict(n).ok).toBe(false);
    expect(ciVerdict(n).lines.join('\n')).toContain('和 plan 里的测试台不是同一份');
  });

  /** 台本身认不出（缺名字、文件空、一个文件两台里都有、两台同名）：不过，不拿半份清单去核对。 */
  it('【故意造出的失败】台认不出：缺名字、没文件、一个文件分到两台、两台同名、开关不是真假值', () => {
    const good = assigned(pr('packages/db/src/schema/index.ts'));
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

describe('入口', () => {
  const plan = fileURLToPath(new URL('../src/bin/ci-plan.ts', import.meta.url));
  const verdict = fileURLToPath(new URL('../src/bin/ci-verdict.ts', import.meta.url));
  const run = (bin: string, args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [bin, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '', ...env },
    });

  it('拿不到 base：退出 2 判红，不静默少跑', () => {
    const r = run(plan, ['--event', 'pull_request', '--base', 'refs/heads/没有这个分支-ci-plan-test']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('没算成要跑什么');
  });

  it('base 像参数：退出 2', () => {
    expect(run(plan, ['--base=--output=/tmp/x']).status).toBe(2);
  });

  it('主线推送：不看 git，全跑，开关写进 GITHUB_OUTPUT', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'ci-plan-')), 'out');
    const r = run(plan, ['--event', 'push'], { GITHUB_OUTPUT: out });
    expect(r.status).toBe(0);
    const text = readFileSync(out, 'utf8');
    for (const line of ['biome=true', 'tsc=all', 'web=true', 'deploy=all'])
      expect(text).toContain(`${line}\n`);
    expect(text).toMatch(/^tests=\[.*"files":\[.*\]/m);
  });

  it('主线给的基准就是 HEAD（区间里没有改动）：认不出改了什么，兜底全跑，不当成「没东西要跑」', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'ci-plan-')), 'out');
    const r = run(plan, ['--event', 'push', '--main-base', 'HEAD'], { GITHUB_OUTPUT: out });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('改了 0 个文件（push）');
    // 走的是按改动算的那条路（不是「push 事件：全跑」那句兜底），只是空改动认不出所以升成全跑
    expect(r.stdout).toContain('改动列表是空的');
    expect(readFileSync(out, 'utf8')).toContain('tsc=all\n');
  });

  it('【故意造出的失败】主线基准认不出（不是提交、像参数）：退出 2 判红，不静默少跑', () => {
    expect(run(plan, ['--event', 'push', '--main-base', '0'.repeat(40)]).status).toBe(2);
    expect(run(plan, ['--event', 'push', '--main-base=--output=/tmp/x']).status).toBe(2);
  });

  it('【故意造出的失败】主线给了空基准（查不到上一次绿）：照旧全跑', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'ci-plan-')), 'out');
    const r = run(plan, ['--event', 'push', '--main-base', ''], { GITHUB_OUTPUT: out });
    expect(r.status).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain('tsc=all\n');
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
    expect(assignTests({ ...pr('packages/cli/src/help.ts'), testUnits: ['没有这个包'] }, inputs)).toMatch(
      /一个测试文件都没有/,
    );
    // 列不出测试文件（检出坏了）：也是一句为什么，不是空清单
    expect(assignTests(pr('packages/cli/src/help.ts'), { ...inputs, all: '列不出 packages/' })).toContain(
      '列不出 packages/',
    );
    // 读不了某个测试文件（认不出要不要 Temporal）：判红，不猜
    expect(assignTests(pr('packages/cli/src/help.ts'), { ...inputs, read: () => undefined })).toContain(
      '读不到测试文件',
    );
  });

  it('汇总入口：没给 CI_NEEDS、不是 JSON 退出 2；对不上退出 1；对得上退出 0', () => {
    expect(run(verdict, [], { CI_NEEDS: '' }).status).toBe(2);
    expect(run(verdict, [], { CI_NEEDS: '{' }).status).toBe(2);
    const p = planOutputs(pr('docs/design.md'));
    const base = {
      changes: { result: 'success', outputs: p },
      lint: { result: 'success' },
      test: { result: 'skipped' },
      web: { result: 'skipped' },
      deploy: { result: 'skipped' },
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
    expect(lint).toContain(`pnpm exec vitest run ${ALWAYS_TESTS.join(' ')}`);
    // 三样在同一步里各自后台跑、各写各的结果（并行跑的那步真跑一遍，见下面「lint 的并行步」）；汇总读的是这一步
    // 写出来的三样结果，不读哪一步的 conclusion（continue-on-error 的步 conclusion 会被改写成 success）。
    expect(lint).toMatch(/^\s+id: checks$/m);
    expect(lint).toContain('steps.checks.outputs.biome');
    expect(lint).toContain('steps.checks.outputs.tsc');
    expect(lint).toContain('steps.checks.outputs.docs');
    expect(lint).not.toMatch(/steps\.\w+\.conclusion/);
    // 判红的那步要真的非零退出（只 echo 不算红）。
    expect(lint).toMatch(/::error::lint 里有检查不对/);
  });

  /**
   * 抠出 lint 里「并行跑」那一步的脚本，配一个假的 pnpm（按子命令决定退出码）原样交给 bash 跑：
   * 一样红了另外两样照样跑完、各自写出结果，开关说不跑的写 skipped。
   */
  // 每条都起 bash + 几个后台子进程：Windows 本机在别的测试一起跑时一条能到 5–10 秒，默认 5 秒的限时会误红。
  describe('lint 的并行步（真跑它的脚本）', { timeout: 30_000 }, () => {
    const doc = parse(yml) as {
      jobs: { lint: { steps: { id?: string; run?: string }[] } };
    };
    const script = doc.jobs.lint.steps.find((s) => s.id === 'checks')?.run ?? '';
    const go = (env: Record<string, string>, fail: string[]) => {
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
      const r = spawnSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
          GITHUB_OUTPUT: out,
          LOGS: join(dir, 'logs'),
          ...env,
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

    it('三样都绿：三样都写 success，tsc 带上算出来的项目', () => {
      const { outputs, calls } = go({ BIOME_WANT: 'true', TSC: 'packages/cli packages/core' }, []);
      expect(outputs).toEqual({ biome: 'success', tsc: 'success', docs: 'success' });
      expect(calls).toContain('exec tsc -b packages/cli packages/core');
      expect(calls).toContain('exec biome check .');
    });

    it('【故意造出的失败】biome 红了：tsc、docs 照样跑完、照样 success，biome 写 failure（#566 不许再漏）', () => {
      const { outputs, calls } = go({ BIOME_WANT: 'true', TSC: 'all' }, ['biome']);
      expect(outputs).toEqual({ biome: 'failure', tsc: 'success', docs: 'success' });
      expect(calls).toContain('exec tsc -b');
      expect(calls).toContain('doc-pointers.test.ts');
    });

    it('【故意造出的失败】三样全红：三样都写 failure，一个不少', () => {
      const { outputs } = go({ BIOME_WANT: 'true', TSC: 'all' }, ['biome', 'tsc', 'vitest']);
      expect(outputs).toEqual({ biome: 'failure', tsc: 'failure', docs: 'failure' });
    });

    it('开关说不跑（只改了 .md）：biome、tsc 写 skipped、没被叫，docs 照跑', () => {
      const { outputs, calls } = go({ BIOME_WANT: 'false', TSC: '' }, []);
      expect(outputs).toEqual({ biome: 'skipped', tsc: 'skipped', docs: 'success' });
      expect(calls).not.toContain('biome');
      expect(calls).not.toContain('tsc');
    });
  });

  /**
   * 抠出 deploy 里「给 /etc/skel 瘦身」那一步，配一个假 sudo（照原样执行，命令行含指定片段时假装失败），
   * SKEL 指到临时目录真跑：瘦成、半路失败要挪回去、挪不回去要红。
   */
  describe('deploy 的 skel 瘦身步（真跑它的脚本）', { timeout: 30_000 }, () => {
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
      const r = spawnSync('bash', ['-c', step?.run ?? ''], {
        encoding: 'utf8',
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
  describe('lint 的汇总步（真跑它的脚本）', () => {
    const doc = parse(yml) as {
      jobs: { lint: { steps: { name?: string; run?: string }[] } };
    };
    const step = doc.jobs.lint.steps.find((s) => s.name?.startsWith('汇总'));
    const script = step?.run ?? '';
    const base: Record<string, string> = {
      BIOME: 'success',
      TSC: 'success',
      DOCS: 'success',
      BIOME_WANT: 'true',
      TSC_WANT: 'all',
      HYGIENE: 'success',
      HYGIENE_HISTORY: 'success',
    };
    const run = (over: Record<string, string> = {}) =>
      spawnSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: { ...process.env, ...base, ...over },
      });

    it('找得到汇总步和它的脚本（不然下面几条等于没查）', () => {
      expect(script).toContain('set -euo pipefail');
    });

    it('该跑的都 success：退出 0', () => {
      expect(run().status).toBe(0);
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

    it('【故意造出的失败】docs 红了、被跳过了（docs 每次都得跑）：都红', () => {
      // 空值 = 并行那步中途崩了、没写出结果：同样红
      for (const DOCS of ['failure', 'skipped', 'cancelled', '']) {
        const r = run({ DOCS });
        expect(r.status, DOCS).toBe(1);
        expect(r.stdout, DOCS).toContain(`docs（${DOCS}，本该 success）`);
      }
    });

    it('【故意造出的失败】开关说要跑、那一步却是 skipped：红，不把「没跑」当成「跑过了」', () => {
      const r = run({ BIOME: 'skipped' });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('biome（skipped，本该 success）');
      const t = run({ TSC: 'skipped' });
      expect(t.status).toBe(1);
      expect(t.stdout).toContain('tsc（skipped，本该 success）');
    });

    it('开关说不跑（只改了 .md）：那两步是 skipped 才对；跑了反而红', () => {
      const off = { BIOME_WANT: 'false', TSC_WANT: '' };
      expect(run({ ...off, BIOME: 'skipped', TSC: 'skipped' }).status).toBe(0);
      const r = run({ ...off, BIOME: 'success', TSC: 'skipped' });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('biome（success，本该 skipped）');
    });

    it('卫生检查红了：只打 ::warning::、不让 job 红（只报不挡）；两步都 skipped（push 事件）也不红', () => {
      const r = run({ HYGIENE: 'failure' });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('::warning::卫生检查没过');
      expect(run({ HYGIENE_HISTORY: 'failure' }).status).toBe(0);
      expect(run({ HYGIENE_HISTORY: 'skipped' }).status).toBe(0);
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

  it('【故意造出的失败】并发组 PR 按号分、推主线按分支分：合过的 PR 改标题正文那一轮（github.ref 是 refs/heads/main）不许挤掉主线的全量', () => {
    const group = /^concurrency:\n {2}group: (.+)$/m.exec(yml)?.[1];
    expect(group).toBe(['ci-$', '{{ github.event.pull_request.number || github.ref }}'].join(''));
  });

  it('【故意造出的失败】只有 PR 上新的一轮挤掉旧的，主线推送不挤掉在跑的全量：挤了的话合并一密一个全绿的提交都没有，自动发布无可发（#362）', () => {
    const cancel = /^concurrency:\n {2}group: .+\n {2}cancel-in-progress: (.+)$/m.exec(yml)?.[1];
    expect(cancel).toBe(['$', "{{ github.event_name == 'pull_request' }}"].join(''));
  });

  it('按开关跑的几个 job 都看 changes 给的开关；lint 每次跑，里面几步各看自己的开关', () => {
    for (const j of PLANNED_JOBS) {
      expect(job(j), j).toMatch(/^ {4}needs: changes$/m);
      expect(job(j), j).toMatch(/^ {4}if: .*needs\.changes\.outputs\./m);
    }
    expect(job('changes')).toContain('fetch-depth: 0');
    expect(job('changes')).toContain('node packages/conventions/src/bin/ci-plan.ts');
    // lint 是每次都跑的 job（里面有 docs、hygiene 两步每次都跑），没有 job 级 if；不等 changes，自己用同一个入口
    // 算同一份计划，biome、tsc 看自己算出来的开关。
    const lint = job('lint')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(lint).not.toMatch(/^ {4}(needs|if): /m);
    expect(lint).toContain(
      'node packages/conventions/src/bin/ci-plan.ts --event "$EVENT" --base "origin/$BASE"',
    );
    expect(lint).toContain(['BIOME_WANT: $', '{{ steps.plan.outputs.biome }}'].join(''));
    expect(lint).toContain(['TSC: $', '{{ steps.plan.outputs.tsc }}'].join(''));
  });

  it('没有 job 用仓库密钥；lint 里卫生检查一行 PR 里的代码都不执行：代码取目标分支上的 trusted/，PR 检出到仓根只当数据扫（这个 PR 自己改不宽卫生检查的规则，#115 第二意见）', () => {
    const ids = [...yml.matchAll(/^ {2}([\w-]+):$/gm)].map((m) => m[1] as string);
    expect(ids).toContain('lint');
    for (const id of ids) expect(job(id), id).not.toContain('secrets.');
    const lint = job('lint');
    // 执行的是主线上的 trusted/ 那份代码：卫生检查两步都从 TRUSTED 取，PR 的文件只当数据扫。
    expect((lint.match(/TRUSTED: \$\{\{ github\.workspace \}\}\/trusted\n/g) ?? []).length).toBe(2);
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
    expect(at('id: hygiene_history'), '找不到 hygiene_history 步').toBeGreaterThan(0);
    const install = at('pnpm install --frozen-lockfile');
    expect(install, '找不到装依赖那步').toBeGreaterThan(0);
    expect(at('id: hygiene\n')).toBeLessThan(install);
    expect(at('id: hygiene_history')).toBeLessThan(install);
    // 算计划那步跑的也是 PR 里的代码（ci-plan.ts）：同样得排在卫生检查两步之后
    expect(at('id: plan\n'), '找不到算计划那步').toBeGreaterThan(0);
    expect(at('id: hygiene_history')).toBeLessThan(at('id: plan\n'));
    // 动态 import 的只有 trusted/ 下的卫生检查
    const imports = [...lint.matchAll(/import\(([^)]*)\)/g)].map((m) => m[1]);
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatch(
      /^pathToFileURL\(`\$\{process\.env\.TRUSTED\}\/packages\/hygiene\/src\/check\.ts`$/,
    );
  });

  it('CI 按改动少跑的判法：从两个入口顺着相对导入走到的文件都在先审后合清单里（漏一个，PR 改它就能让测试少跑）', () => {
    const parsed = parseRiskPaths(readFileSync(join(ROOT, RISK_PATHS_FILE), 'utf8'));
    if (typeof parsed === 'string') throw new Error(parsed);
    const covered = (f: string) =>
      parsed.some((r) => (r.path.endsWith('/') ? f.startsWith(r.path) : f === r.path));
    // 缓存那两个文件也是「决定少跑」的一步（PR 的测试分片结果缓存）：它们顺着导入走到的文件同样要在清单里
    const todo = [
      'packages/conventions/src/bin/ci-plan.ts',
      'packages/conventions/src/bin/ci-verdict.ts',
      'packages/conventions/src/bin/ci-cache.ts',
    ];
    const seen = new Set<string>();
    while (todo.length > 0) {
      const rel = todo.pop() as string;
      if (seen.has(rel)) continue;
      seen.add(rel);
      const text = readFileSync(join(ROOT, rel), 'utf8');
      for (const m of text.matchAll(/from '(\.{1,2}\/[^']+)'/g)) {
        todo.push(posix.join(posix.dirname(rel), m[1] as string));
      }
    }
    expect([...seen]).toContain('packages/conventions/src/repo.ts');
    expect([...seen].filter((f) => !covered(f))).toEqual([]);
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
    // 8 台封顶（TARGET_BOX_MS 50 秒、MAX_BOXES 8）：全量 687 秒的耗时合计 → 8 台，每台 91 秒上下
    expect(p.tests.length).toBe(8);
    const all = boxFiles(p).flat();
    expect(all.length).toBe(ALL_TESTS.length);
    expect([...all].sort()).toEqual([...ALL_TESTS].sort());
    // 名字：第几台/共几台，pg 台带「· pg」，装了 Temporal 的带「· temporal」（具体哪台随耗时表变，不钉死）
    expect(labels(p).map((l, i) => l.startsWith(`${i + 1}/8`))).toEqual(Array(8).fill(true));
    expect(labels(p).filter((l) => l.includes('· pg')).length).toBeGreaterThanOrEqual(1);
    expect(labels(p).filter((l) => l.includes('· temporal'))).toHaveLength(1);
    // 每台的估计耗时都在「目标 50 秒」的两倍以内（LPT 装得住；一台 4 核、并行跑的墙钟约是它的一半）
    for (const b of p.tests) expect(b.estMs).toBeLessThanOrEqual(TARGET_BOX_MS * 2);
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
    const p = assigned(pr('packages/cli/src/help.ts'));
    expect(p.tests).toHaveLength(1);
    expect(labels(p)).toEqual(['1/1']);
    expect(p.tests[0]?.files.every((f) => f.startsWith('packages/cli/'))).toBe(true);
  });

  it('改了 engine：engine 的 88 个文件按耗时装进几台，最慢的几台差得不多（不再像 --shard 那样 89/35/137）', () => {
    const p = assigned(pr('packages/engine/src/worker.ts'));
    expect(p.tests.length).toBeGreaterThan(1);
    const loads = p.tests.map((b) => b.estMs);
    const total = loads.reduce((a, b) => a + b, 0);
    // LPT：最重的台不超过「平均 + 最重那个文件」（装箱问题的常识上界）
    expect(Math.max(...loads)).toBeLessThanOrEqual(total / loads.length + 27_285);
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
