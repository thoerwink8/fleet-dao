// test-graph.ts：每类边一条；每条退回路径（解析失败、读不到、图外文件、看不透）各造一遍失败；再对真仓抽查几条。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { fsRepo } from '../src/repo.ts';
import {
  buildTestGraph,
  classifyChange,
  closureOf,
  isTestFile,
  listRepoFiles,
  selectTests,
  type TestGraph,
  TestGraphError,
} from '../src/test-graph.ts';
import { memRepo } from './helpers.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** 一个小仓：两个包（a 依赖 b），各种写法各一处。 */
const FILES: Record<string, string> = {
  'package.json': '{"name":"root"}',
  'AGENTS.md': '通用段',
  'docs/ops.md': '端口表',
  'docs/unused.md': '没人读',
  'deploy/run.sh': '#!/bin/sh\n. ./lib.sh\n',
  'vitest.config.ts': `import { workers } from './packages/a/src/workers.ts';\nexport default workers;`,
  'packages/a/package.json': JSON.stringify({
    name: '@x/a',
    exports: { '.': './src/index.ts' },
    imports: { '#brand': './src/brand.ts' },
  }),
  'packages/b/package.json': JSON.stringify({
    name: '@x/b',
    exports: { '.': './src/index.ts', './sub': './src/sub.ts' },
  }),
  'packages/a/src/workers.ts': 'export const workers = {};',
  'packages/a/src/index.ts': `export { lib } from './lib.ts';`,
  'packages/a/src/lib.ts': 'export const lib = 1;',
  'packages/a/src/types.ts': 'export interface T { a: number }',
  'packages/a/src/mixed.ts': 'export interface M {}\nexport const m = 1;',
  'packages/a/src/brand.ts': 'export const brand = 1;',
  'packages/a/src/dyn.ts': 'export const dyn = 1;',
  'packages/a/src/mocked.ts': 'export const mocked = 1;',
  'packages/a/src/orphan.ts': 'export const orphan = 1;',
  'packages/a/src/paths.ts': `import { fileURLToPath } from 'node:url';\nexport const REPO = fileURLToPath(new URL('../../../', import.meta.url));`,
  'packages/a/src/bin/tool': `#!/usr/bin/env node\nimport { lib } from '../lib.ts';\nconsole.log(lib);`,
  'packages/a/templates/one.md': 'x',
  'packages/a/templates/two.md': 'y',
  'packages/a/scripts/s1.mjs': `import { lib } from '../src/lib.ts';\nexport default lib;`,
  'packages/a/scripts/s2.mjs': 'export default 2;',
  'packages/a/routes/home.tsx': `import { lib } from '../src/lib.ts';\nexport default () => <div>{lib}</div>;`,
  'packages/b/src/index.ts': 'export const b = 1;',
  'packages/b/src/sub.ts': 'export const sub = 1;',
  'packages/b/src/other.ts': 'export const other = 1;',
  // 一个测试一种写法
  'packages/a/test/static.test.ts': `import { lib } from '../src/index.ts';`,
  'packages/a/test/type-only.test.ts': `import type { T } from '../src/types.ts';\nexport type { M } from '../src/mixed.ts';`,
  'packages/a/test/mixed.test.ts': `import { type M, m } from '../src/mixed.ts';`,
  'packages/a/test/dynamic.test.ts': `const d = await import('../src/dyn.ts');`,
  'packages/a/test/workspace.test.ts': `import { b } from '@x/b';\nimport { sub } from '@x/b/sub';\nimport { brand } from '#brand';`,
  'packages/a/test/workspace-dir.test.ts': `import { nope } from '@x/b/not-exported';`,
  'packages/a/test/url.test.ts': `const one = new URL('../templates/one.md', import.meta.url);\nconst all = new URL('../templates/', import.meta.url);`,
  'packages/a/test/root-literal.test.ts': `import { readFileSync } from 'node:fs';\nreadFileSync('docs/ops.md', 'utf8');`,
  'packages/a/test/join.test.ts': `import { join, dirname } from 'node:path';\nimport { fileURLToPath } from 'node:url';\nconst ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');\nreadFileSync(join(ROOT, 'AGENTS.md'));`,
  'packages/a/test/helper.test.ts': `const repoFile = (p: string) => readFileSync(new URL(\`../../../\${p}\`, import.meta.url), 'utf8');\nrepoFile('AGENTS.md');`,
  'packages/a/test/cross-module.test.ts': `import { join } from 'node:path';\nimport { REPO } from '../src/paths.ts';\nreadFileSync(join(REPO, 'docs', 'ops.md'));`,
  'packages/a/test/bin.test.ts': `spawnSync(process.execPath, ['packages/a/src/bin/tool']);`,
  'packages/a/test/mock.test.ts': `vi.mock('../src/mocked.ts');`,
  'packages/a/test/dir-import.test.ts': `import { join } from 'node:path';\nimport { fileURLToPath, pathToFileURL } from 'node:url';\nconst DIR = new URL('../scripts/', import.meta.url);\nexport const load = async (name: string) => import(pathToFileURL(join(fileURLToPath(DIR), name)).href);`,
  'packages/a/test/glob.test.tsx': `const pages = import.meta.glob('../routes/*.tsx', { eager: true });`,
  'packages/a/test/script.test.ts': `spawnSync('sh', ['deploy/run.sh']);`,
  'packages/a/test/snap.test.ts': `expect(1).toMatchSnapshot();`,
  'packages/a/test/__snapshots__/snap.test.ts.snap': 'exports[`x`] = `1`;',
  // 看不透的几种
  'packages/a/test/opaque-import.test.ts': `export const load = (name: string) => import(name);`,
  'packages/a/test/opaque-root.test.ts': `import { join } from 'node:path';\nimport { fileURLToPath } from 'node:url';\nconst ROOT = fileURLToPath(new URL('../../../', import.meta.url));\nexport const f = (rel: string) => readFileSync(join(ROOT, rel));`,
  'packages/a/test/opaque-url.test.ts': `export const f = (u: string) => readFileSync(new URL(u, import.meta.url));`,
  'packages/a/test/missing.test.ts': `import { gone } from '../src/gone.ts';`,
  'packages/b/test/b.test.ts': `import { other } from '../src/other.ts';`,
};

let graph: TestGraph;
const repo = memRepo(FILES);
beforeAll(() => {
  graph = buildTestGraph(repo);
});

const deps = (f: string) => [...(graph.deps.get(f) ?? [])].sort();
const sel = (...changed: string[]) => selectTests({ changed, repo, graph });

describe('每类边', () => {
  it('静态 import、export … from', () => {
    expect(deps('packages/a/test/static.test.ts')).toEqual(['packages/a/src/index.ts']);
    expect(deps('packages/a/src/index.ts')).toEqual(['packages/a/src/lib.ts']);
    expect(sel('packages/a/src/lib.ts').tests).toContain('packages/a/test/static.test.ts');
  });

  it('import type、export type … from 不算边（运行前整句擦掉）；混着值的整句算边', () => {
    expect(deps('packages/a/test/type-only.test.ts')).toEqual([]);
    expect(deps('packages/a/test/mixed.test.ts')).toEqual(['packages/a/src/mixed.ts']);
  });

  it('字面量的动态 import', () => {
    expect(deps('packages/a/test/dynamic.test.ts')).toEqual(['packages/a/src/dyn.ts']);
  });

  it('工作区包：exports 的主入口、子路径，包自己的 #imports', () => {
    expect(deps('packages/a/test/workspace.test.ts')).toEqual([
      'packages/a/src/brand.ts',
      'packages/b/src/index.ts',
      'packages/b/src/sub.ts',
    ]);
  });

  it('工作区包的子路径解析不出：连到整个包目录（当代码，往下走）', () => {
    expect([...(graph.dirDeps.get('packages/a/test/workspace-dir.test.ts') ?? [])]).toEqual(['packages/b']);
    expect(sel('packages/b/src/other.ts').tests).toContain('packages/a/test/workspace-dir.test.ts');
  });

  it('new URL(字面量, import.meta.url)：指文件连文件，指目录连目录下全部', () => {
    expect(deps('packages/a/test/url.test.ts')).toEqual(['packages/a/templates/one.md']);
    expect([...(graph.dataDirs.get('packages/a/test/url.test.ts') ?? [])]).toEqual(['packages/a/templates']);
    expect(sel('packages/a/templates/two.md').tests).toContain('packages/a/test/url.test.ts');
    // 目录里新加的文件（图里还没有）也算到它头上，但同时交回调用方
    const added = sel('packages/a/templates/three.md');
    expect(added.tests).toContain('packages/a/test/url.test.ts');
    expect(added.unresolved.map((u) => u.file)).toEqual(['packages/a/templates/three.md']);
  });

  it('仓根相对的字符串字面量', () => {
    expect(deps('packages/a/test/root-literal.test.ts')).toEqual(['docs/ops.md']);
    expect(sel('docs/ops.md').tests).toEqual(
      expect.arrayContaining([
        'packages/a/test/root-literal.test.ts',
        'packages/a/test/cross-module.test.ts',
      ]),
    );
  });

  it('join(ROOT, 字面量…)：ROOT 由 dirname(fileURLToPath(import.meta.url)) 算出', () => {
    expect(deps('packages/a/test/join.test.ts')).toEqual(['AGENTS.md']);
  });

  it('参数拼路径的小帮手：按每个调用点的实参补上，不当看不透', () => {
    expect(deps('packages/a/test/helper.test.ts')).toEqual(['AGENTS.md']);
    expect(graph.blind.get('packages/a/test/helper.test.ts')).toBeUndefined();
  });

  it('从别的模块导入的路径常量', () => {
    expect(deps('packages/a/test/cross-module.test.ts')).toEqual(['docs/ops.md', 'packages/a/src/paths.ts']);
  });

  it('子进程跑的 bin 脚本（无后缀、shebang 是 node）也解析，往下走它的依赖', () => {
    expect(graph.sources.has('packages/a/src/bin/tool')).toBe(true);
    expect(sel('packages/a/src/lib.ts').tests).toContain('packages/a/test/bin.test.ts');
  });

  it('vi.mock 的说明符', () => {
    expect(deps('packages/a/test/mock.test.ts')).toEqual(['packages/a/src/mocked.ts']);
  });

  it('import(join(目录, 参数))：动态加载目录里的任意文件，连到目录（当代码，往下走）', () => {
    expect([...(graph.dirDeps.get('packages/a/test/dir-import.test.ts') ?? [])]).toEqual([
      'packages/a/scripts',
    ]);
    expect(sel('packages/a/src/lib.ts').tests).toContain('packages/a/test/dir-import.test.ts');
  });

  it('import.meta.glob：连到模式的固定前缀目录（当代码）', () => {
    expect([...(graph.dirDeps.get('packages/a/test/glob.test.tsx') ?? [])]).toEqual(['packages/a/routes']);
    expect(sel('packages/a/src/lib.ts').tests).toContain('packages/a/test/glob.test.tsx');
  });

  it('快照文件算测试的边', () => {
    expect(sel('packages/a/test/__snapshots__/snap.test.ts.snap').tests).toEqual([
      'packages/a/test/snap.test.ts',
    ]);
  });

  it('测试文件自己改了选自己；不相干的测试不选', () => {
    const s = sel('packages/b/test/b.test.ts');
    expect(s.tests).toEqual(['packages/b/test/b.test.ts']);
    expect(s.unresolved).toEqual([]);
  });

  it('改到 vitest 配置会加载的文件：全跑', () => {
    expect(sel('packages/a/src/workers.ts').runAll.map((r) => r.file)).toEqual(['packages/a/src/workers.ts']);
  });
});

describe('退回调用方的路径（每条都故意造出来）', () => {
  it('解析失败：抛 TestGraphError，不当没受影响', () => {
    const bad = memRepo({ ...FILES, 'packages/a/src/broken.ts': 'export const = ;' });
    expect(() => buildTestGraph(bad)).toThrow(TestGraphError);
    expect(() => buildTestGraph(bad)).toThrow(/解析失败.*packages\/a\/src\/broken\.ts/s);
  });

  it('文件读不到：抛', () => {
    expect(() => buildTestGraph(repo, { files: [...Object.keys(FILES), 'packages/a/src/ghost.ts'] })).toThrow(
      /读不到 packages\/a\/src\/ghost\.ts/,
    );
  });

  it('package.json 不是 JSON：抛', () => {
    const bad = memRepo({ ...FILES, 'packages/b/package.json': '{ nope' });
    expect(() => buildTestGraph(bad)).toThrow(/packages\/b\/package\.json 不是 JSON/);
  });

  it('改动列表是空的：抛', () => {
    expect(() => sel()).toThrow(/改动列表是空的/);
  });

  it('图外文件（删掉的、仓外路径）、没人读的文档：交回，不拿空列表冒充没受影响', () => {
    const s = sel('packages/a/src/deleted.ts', 'docs/unused.md');
    expect(s.unresolved.map((u) => u.file)).toEqual(['packages/a/src/deleted.ts', 'docs/unused.md']);
  });

  it('没人引用的源文件：交回', () => {
    expect(sel('packages/a/src/orphan.ts').unresolved.map((u) => u.file)).toEqual([
      'packages/a/src/orphan.ts',
    ]);
  });

  it('只被 import type 引用的文件：交回（运行时没人加载它，但改它要按包级兜底）', () => {
    expect(classifyChange(graph, 'packages/a/src/types.ts').kind).toBe('unresolved');
  });

  it('脚本类文件（.sh）有测试直接用：选中那些测试，同时交回（它可能再引别的文件）', () => {
    const s = sel('deploy/run.sh');
    expect(s.tests).toEqual(['packages/a/test/script.test.ts']);
    expect(s.unresolved.map((u) => u.file)).toEqual(['deploy/run.sh']);
  });

  it('package.json 有测试读也交回（管依赖和模块解析）', () => {
    expect(classifyChange(graph, 'packages/b/package.json').kind).toBe('unresolved');
    expect(classifyChange(graph, 'package.json').kind).toBe('unresolved');
  });

  it('看不透：非字面量的动态 import、仓根拼算不出的路径、非字面量的 new URL、指到不存在的相对导入', () => {
    const opaque = new Map(sel('AGENTS.md').opaque.map((o) => [o.test, o.why.join('\n')]));
    expect(opaque.get('packages/a/test/opaque-import.test.ts')).toMatch(/动态加载的说明符算不出/);
    expect(opaque.get('packages/a/test/opaque-root.test.ts')).toMatch(/仓根拼上算不出的路径/);
    expect(opaque.get('packages/a/test/opaque-url.test.ts')).toMatch(/new URL\(算不出的路径/);
    expect(opaque.get('packages/a/test/missing.test.ts')).toMatch(/在仓里找不到/);
    // 能看透的不在里面
    expect(opaque.has('packages/a/test/helper.test.ts')).toBe(false);
    expect(opaque.has('packages/a/test/static.test.ts')).toBe(false);
  });
});

describe('测试文件的认法和 vitest 配置一致', () => {
  it('vitest.config.ts 的 include 就是这三条', () => {
    const text = readFileSync(new URL('../../../vitest.config.ts', import.meta.url), 'utf8');
    const include = /include:\s*\[([^\]]*)\]/.exec(text)?.[1] ?? '';
    const globs = [...include.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(globs).toEqual([
      'packages/*/src/**/*.test.{ts,tsx}',
      'packages/*/test/**/*.test.{ts,tsx}',
      'agents/test/**/*.test.ts',
    ]);
    expect(isTestFile('packages/web/src/lib/x.test.tsx')).toBe(true);
    expect(isTestFile('packages/web/src/lib/x.test.mjs')).toBe(false);
    expect(isTestFile('agents/test/rules/a.rules.test.ts')).toBe(true);
    expect(isTestFile('agents/skills/x.test.ts')).toBe(false);
  });
});

describe('真仓抽查', () => {
  let real: TestGraph;
  const realRepo = fsRepo(ROOT);
  beforeAll(() => {
    real = buildTestGraph(realRepo, { files: listRepoFiles(realRepo) });
  }, 60_000);

  it('改引擎的每小时对账，选中它的真测试，不拖上不相干的包', () => {
    const s = selectTests({
      changed: ['packages/engine/src/jobs/hourly-reconcile.ts'],
      repo: realRepo,
      graph: real,
    });
    expect(s.tests).toContain('packages/engine/test/real/hourly-reconcile.test.ts');
    expect(s.tests).toContain('packages/engine/test/hourly-reconcile.test.ts');
    expect(s.tests.some((t) => t.startsWith('packages/web/'))).toBe(false);
    expect(s.unresolved).toEqual([]);
  });

  it('改 AGENTS.md：读它的规矩测试都选上', () => {
    const s = selectTests({ changed: ['AGENTS.md'], repo: realRepo, graph: real });
    expect(s.tests).toContain('agents/test/agents-md-budget.test.ts');
  });

  it('改 db 的默认路由配置（经 export const 的 new URL、再当默认参数用）：选中读它的测试', () => {
    const s = selectTests({ changed: ['packages/db/routing.default.json'], repo: realRepo, graph: real });
    expect(s.tests).toContain('packages/db/test/routing-two-layer.test.ts');
  });

  it('改 CHANGELOG.md（web 经 ?raw 导入）：选中驾驶舱的测试', () => {
    const s = selectTests({ changed: ['CHANGELOG.md'], repo: realRepo, graph: real });
    expect(s.tests).toContain('packages/web/src/brand/cockpit.test.tsx');
  });

  it('每个测试的闭包都含它自己；看不透的测试有理由', () => {
    for (const t of real.tests) expect(closureOf(real, t).files.has(t)).toBe(true);
    const s = selectTests({ changed: ['AGENTS.md'], repo: realRepo, graph: real });
    for (const o of s.opaque) expect(o.why.length).toBeGreaterThan(0);
    // 宁可多标，但别把大半个仓都标成看不透（那就没收益了）
    expect(s.opaque.length).toBeLessThan(real.tests.length / 3);
  });
});
