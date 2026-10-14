// PR 只改 deploy/ 时只跑读 deploy/ 的测试文件（B8，决定 0093）：判法在 src/deploy-readers.ts，接进计划在 ci-plan.ts 的 narrowDeploy。
// 少测的兜底是主线推送全跑（发版只认主线全绿），所以这里还钉住「主线、本机预检不窄」。
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  applyReuse,
  assignTests,
  type CiPlan,
  ciVerdict,
  planCi,
  planOutputs,
  readGraph,
} from '../src/ci-plan.ts';
import { deployReaders, importSpecs, readsDeploy, stripComments } from '../src/deploy-readers.ts';
import { CLAIM_PREFIX, claimOf, parseReuse } from '../src/main-reuse.ts';
import { fsRepo } from '../src/repo.ts';
import { listTestFiles, parseTimings, TIMINGS_FILE } from '../src/test-split.ts';
import { runChild } from './child.ts';
import { memRepo } from './helpers.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const REPO = fsRepo(ROOT);
const g = readGraph(REPO);
if (typeof g === 'string') throw new Error(g);
const ALL = listTestFiles(REPO);
if (typeof ALL === 'string') throw new Error(ALL);
const TIMINGS = parseTimings(readFileSync(join(ROOT, TIMINGS_FILE), 'utf8'));
if (typeof TIMINGS === 'string') throw new Error(TIMINGS);
const inputs = { all: ALL, timings: TIMINGS, read: (rel: string) => REPO.read(rel), repo: REPO };
const pr = (narrowDeploy: boolean, ...changed: string[]) =>
  planCi({ event: 'pull_request', changed, graph: g, narrowDeploy });
const assigned = (p: CiPlan) => {
  const r = assignTests(p, inputs);
  if (typeof r === 'string') throw new Error(r);
  return r.plan;
};
const filesOf = (p: CiPlan) => p.tests.flatMap((b) => b.files).sort();

describe('读 deploy/ 的判法（代码里的路径字面量 + 会碰文件）', () => {
  it('读：join(…, "deploy", …)、deploy/ 路径字面量、模板里的 deploy/；不读：只在注释里提、没有文件操作', () => {
    expect(readsDeploy(`readFileSync(join(ROOT, 'deploy', 'catalog.json'))`)).toBe(true);
    expect(readsDeploy('readFileSync(`${root}/deploy/release.sh`)')).toBe(true);
    expect(readsDeploy(`spawnSync('bash', ['deploy/test/run.sh'])`)).toBe(true);
    expect(readsDeploy(`// 见 deploy/france.sh\nreadFileSync('a')`)).toBe(false);
    expect(readsDeploy(`/* deploy/ 目录 */ readFileSync('a')`)).toBe(false);
    // 规则表：写着 'deploy/' 但不碰文件
    expect(readsDeploy(`const rule = { match: under('deploy/') }`)).toBe(false);
    // 别的词里带 deploy 不算
    expect(readsDeploy(`readFileSync('redeploy/x'); const deployed = 1`)).toBe(false);
  });

  it('注释只去真注释：字符串里的 // 留着', () => {
    expect(stripComments(`const u = 'https://x/deploy/a'; // 尾巴`)).toContain('https://x/deploy/a');
    expect(stripComments(`const u = 1; // 尾巴`)).not.toContain('尾巴');
  });

  it('import 说明符：只留相对路径和 @fleet-dao 包，注释里的不算', () => {
    const text = `import a from './a.ts';\nimport b from 'node:fs';\nimport { c } from '@fleet-dao/db';\nconst d = await import('../d.ts');\n// import x from './no.ts'`;
    expect(importSpecs(text)).toEqual(['./a.ts', '@fleet-dao/db', '../d.ts']);
  });
});

describe('deployReaders：测试自己读、辅助模块读、直接 import 的源码读，才算', () => {
  const read = `import { readFileSync } from 'node:fs';\nexport const x = readFileSync('deploy/catalog.json');\n`;
  const plain = `export const y = 1;\n`;
  const repo = memRepo({
    'packages/a/package.json': JSON.stringify({ name: '@fleet-dao/a', exports: { '.': './src/index.ts' } }),
    'packages/a/src/index.ts': `import { x } from './reader.ts';\nexport { x };\n`,
    'packages/a/src/reader.ts': read,
    'packages/a/src/deep.ts': `import { x } from './reader.ts';\nexport const z = x;\n`,
    'packages/a/test/self.test.ts': read,
    'packages/a/test/helper-user.test.ts': `import { h } from './support.ts';\n`,
    'packages/a/test/support.ts': `import { h2 } from './support2.ts';\nexport const h = h2;\n`,
    'packages/a/test/support2.ts': read,
    'packages/a/test/src-direct.test.ts': `import { x } from '../src/reader.ts';\n`,
    'packages/a/test/src-two-hops.test.ts': `import { z } from '../src/deep.ts';\n`,
    'packages/a/test/plain.test.ts': `import { y } from './plain.ts';\n`,
    'packages/a/test/plain.ts': plain,
    'packages/b/package.json': JSON.stringify({ name: '@fleet-dao/b' }),
    'packages/b/test/pkg.test.ts': `import { x } from '@fleet-dao/a';\n`,
    'packages/b/test/comment-only.test.ts': `// deploy/ 不读\nimport { y } from '../../a/test/plain.ts';\n`,
    'packages/b/test/string-import.test.ts': `const s = 'import x from "./nope.ts"';\nexport {};\n`,
  });
  const tests = [
    'packages/a/test/self.test.ts',
    'packages/a/test/helper-user.test.ts',
    'packages/a/test/src-direct.test.ts',
    'packages/a/test/src-two-hops.test.ts',
    'packages/a/test/plain.test.ts',
    'packages/b/test/pkg.test.ts',
    'packages/b/test/comment-only.test.ts',
    'packages/b/test/string-import.test.ts',
  ];

  it('自己读、辅助模块链上读（不限层）、直接 import 的源码读：选中；两跳源码、没读的、注释和字符串里的 import：不选', () => {
    expect(deployReaders(repo, tests)).toEqual([
      'packages/a/test/helper-user.test.ts',
      'packages/a/test/self.test.ts',
      'packages/a/test/src-direct.test.ts',
    ]);
  });

  it('经 @fleet-dao 包入口 import：入口只是转出，读在第二跳，不选（只跟一跳源码）', () => {
    expect(deployReaders(repo, ['packages/b/test/pkg.test.ts'])).toEqual([]);
  });

  it('读不到某个测试文件：一句为什么，不拿空清单冒充没人读', () => {
    expect(deployReaders(repo, ['packages/a/test/没有.test.ts'])).toMatch(
      /读不到 packages\/a\/test\/没有\.test\.ts/,
    );
  });
});

describe('本仓真跑', () => {
  const found = deployReaders(REPO, ALL);
  if (typeof found === 'string') throw new Error(found);

  it('数量在合理范围：不是空、不是几乎全部（约 45–70 个）', () => {
    expect(found.length).toBeGreaterThan(30);
    expect(found.length).toBeLessThan(120);
    expect(ALL.length).toBeGreaterThan(found.length * 5);
  });

  it('已知读 deploy/ 的测试都在（含约定测试 ci-cache、ci-plan）', () => {
    for (const must of [
      'packages/conventions/test/ci-cache.test.ts',
      'packages/conventions/test/ci-plan.test.ts',
      'packages/conventions/test/ci-plan-deploy.test.ts',
      'packages/db/test/catalog.test.ts',
    ]) {
      expect(found, must).toContain(must);
    }
  });

  it('只读 packages/engine 里别处的、不碰 deploy/ 的测试不选（不是全都选）', () => {
    expect(found).not.toContain('packages/engine/test/task-workflow.test.ts');
  });
});

describe('接进计划：PR 只改 deploy/ 窄，主线推送、本机预检不窄', () => {
  it('PR 改 deploy/：不全跑；deploy 全套照跑；不开 web、不跑 tsc；单元清单空、测试台是读 deploy/ 的那些', () => {
    const p = pr(true, 'deploy/lib/common.sh');
    expect(p).toMatchObject({
      full: false,
      deploy: 'all',
      web: false,
      tsc: [],
      testUnits: [],
      deployTests: true,
    });
    expect(p.biome).toBe(true);
    const a = assigned(p);
    const want = deployReaders(REPO, ALL);
    expect(filesOf(a)).toEqual(expect.arrayContaining(want as string[]));
    expect(filesOf(a).length).toBeLessThan(ALL.length / 5);
    expect(a.reasons.join('\n')).toContain('读 deploy/ 的测试文件');
  });

  it('同时改了别的包：那个包的单元照测，加上读 deploy/ 的', () => {
    const a = assigned(pr(true, 'deploy/lib/common.sh', 'packages/cli/src/help.ts'));
    expect(a.testUnits).toEqual(['cli']);
    const files = filesOf(a);
    expect(files.some((f) => f.startsWith('packages/cli/'))).toBe(true);
    expect(files).toContain('packages/conventions/test/ci-cache.test.ts');
  });

  it('同时改了真要全跑的（根配置）：照旧全跑，deploy 全套', () => {
    const p = pr(true, 'deploy/lib/common.sh', 'package.json');
    expect(p.full).toBe(true);
    expect(p.deploy).toBe('all');
    expect(p.deployTests).toBeUndefined();
  });

  it('不窄的两条路：不传 narrowDeploy（本机预检、test:changed）、主线推送（event 不是 pull_request），deploy/ 都全跑', () => {
    expect(pr(false, 'deploy/lib/common.sh')).toMatchObject({
      full: true,
      deploy: 'all',
      web: true,
      tsc: 'all',
    });
    expect(
      planCi({ event: 'push', changed: ['deploy/lib/common.sh'], graph: g, narrowDeploy: false }).full,
    ).toBe(true);
    // 主线推送非 PR 事件，即使有人传了 narrowDeploy 也全跑（planCi 第一行就返回）
    expect(
      planCi({ event: 'push', changed: ['deploy/lib/common.sh'], graph: g, narrowDeploy: true }).full,
    ).toBe(true);
  });

  it('assignTests 没给仓的视图、或某个测试读不到：判红的一句为什么，不静默少跑', () => {
    const p = pr(true, 'deploy/lib/common.sh');
    const { repo: _omit, ...noRepo } = inputs;
    expect(assignTests(p, noRepo)).toMatch(/没给仓的视图/);
    expect(assignTests(p, { ...inputs, repo: memRepo({}) })).toMatch(/找不出读 deploy\/ 的测试文件/);
  });

  it('汇总核对：窄计划装好箱后 test 本该 success；装不出台（deployTests 却没台）判红；复用后不再带 deployTests', () => {
    const a = assigned(pr(true, 'deploy/lib/common.sh'));
    const needs = (plan: CiPlan, over: Record<string, unknown> = {}) => ({
      changes: { result: 'success', outputs: planOutputs(plan) },
      lint: { result: 'success' },
      test: { result: 'success' },
      web: { result: 'skipped' },
      e2e: { result: 'skipped' },
      deploy: { result: 'success' },
      ...over,
    });
    expect(ciVerdict(needs(a), 'pull_request').ok).toBe(true);
    expect(ciVerdict(needs(a, { test: { result: 'skipped' } }), 'pull_request').ok).toBe(false);
    const noBoxes = { ...a, tests: [] };
    expect(ciVerdict(needs(noBoxes), 'pull_request').lines.join('\n')).toContain('一台测试都没装');

    const reuse = parseReuse(
      JSON.stringify({ pr: 1, run: 2, tree: 'a'.repeat(40), baseTree: 'b'.repeat(40) }),
    );
    if (reuse === null) throw new Error('测试里造的复用记录认不出');
    const reused = applyReuse(a, reuse);
    expect(reused.deployTests).toBeUndefined();
    expect(reused.tests).toEqual([]);
  });
});

describe('窄跑的 PR 不留树声明：合并后主线不复用它，自己全跑（少测的兜底）', () => {
  const doc = parse(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')) as {
    jobs: { changes: { steps: { id?: string; run?: string; name?: string }[] } };
  };
  const steps = doc.jobs.changes.steps;
  const script = steps.find((s) => s.id === 'tested')?.run ?? '';

  const claim = (narrowed: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'tested-'));
    const out = join(dir, 'out');
    writeFileSync(out, '');
    const r = runChild('bash', ['-c', script], {
      cwd: ROOT,
      env: { ...process.env, NARROWED: narrowed, GITHUB_OUTPUT: out },
    });
    return { r, line: readFileSync(out, 'utf8').trim() };
  };

  it('planOutputs 的 narrowed：窄跑的计划是 true，别的是空串', () => {
    expect(planOutputs(assigned(pr(true, 'deploy/lib/common.sh'))).narrowed).toBe('true');
    expect(planOutputs(assigned(pr(true, 'packages/cli/src/help.ts'))).narrowed).toBe('');
    expect(planOutputs(pr(false, 'deploy/lib/common.sh')).narrowed).toBe('');
  });

  it('找得到那一步的脚本；没窄跑：照旧写树声明（claimOf 认得）；窄跑：写「无」，claimOf 判认不出，主线不复用', () => {
    expect(script).toContain('NARROWED');
    const normal = claim('');
    expect(normal.r.status, normal.r.stderr).toBe(0);
    const tree = /claim=(.*)/.exec(normal.line)?.[1] ?? '';
    // 本机检出可能不是合并提交（两个 parent）：那一支写「无」；是的话必须是 tree=… base=… 的声明
    if (tree.startsWith('tree=')) {
      expect(claimOf([`${CLAIM_PREFIX} ${tree}`])).toMatchObject({ tree: expect.any(String) });
    }
    const narrow = claim('true');
    expect(narrow.r.status, narrow.r.stderr).toBe(0);
    expect(narrow.line).toContain('claim=无（只改 deploy/');
    const verdict = claimOf([`${CLAIM_PREFIX} ${narrow.line.replace('claim=', '')}`]);
    expect(typeof verdict, '窄跑的声明被主线当成了可复用的树').toBe('string');
  });

  it('plan 步在 tested 步前面（tested 读 steps.plan.outputs.narrowed）', () => {
    const at = (id: string) => steps.findIndex((s) => s.id === id);
    expect(at('plan')).toBeGreaterThan(-1);
    expect(at('plan')).toBeLessThan(at('tested'));
  });
});
