import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AGENTS_UNIT,
  ALWAYS_JOBS,
  type CiPlan,
  ciVerdict,
  type PackageGraph,
  PLANNED_JOBS,
  planCi,
  planOutputs,
  readGraph,
} from '../src/ci-plan.ts';
import { parseRiskPaths, RISK_PATHS_FILE } from '../src/merge-gates.ts';
import { fsRepo } from '../src/repo.ts';
import { memRepo } from './helpers.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const REAL = readGraph(fsRepo(ROOT));
const graph = (): PackageGraph => {
  if (typeof REAL === 'string') throw new Error(REAL);
  return REAL;
};
const pr = (...changed: string[]) => planCi({ event: 'pull_request', changed, graph: graph() });
const testArgs = (p: CiPlan) => p.tests.flatMap((s) => s.args);
const shards = (p: CiPlan) => p.tests.map((s) => s.name);

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
      changed: ['docs/plan.md'],
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
      expect(p).toMatchObject({ lint: true, tsc: 'all', web: true, deploy: 'all' });
      expect(shards(p)).toEqual(['engine', 'db', 'rest']);
    }
  });

  it('改动列表是空的：认不出改了什么，全跑，不当成「什么都不用跑」', () => {
    expect(pr().full).toBe(true);
  });

  it('认不出的路径、不在依赖图里的包：全跑', () => {
    for (const f of ['.gitattributes', 'scripts/new.sh', 'packages/nope/src/x.ts', 'LICENSE']) {
      const p = pr('docs/plan.md', f);
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

  it('纯文档（docs、specs、README、开单表单）：只剩每次都跑的 hygiene、docs', () => {
    const p = pr(
      'docs/design.md',
      'docs/plan.md',
      'specs/12-登录验证码/需求.md',
      'README.md',
      '.github/ISSUE_TEMPLATE/requirement.yml',
    );
    expect(p).toMatchObject({ full: false, tests: [], web: false, deploy: 'none', tsc: [] });
    // .yml 不是 md：biome 会看它
    expect(p.lint).toBe(true);
    expect(pr('docs/design.md', 'specs/1-x/方案.md').lint).toBe(false);
  });

  it('只改一个没人依赖的包（cli）：只测它、只类型检查它，不打包 web、不跑 deploy', () => {
    const p = pr('packages/cli/src/help.ts');
    expect(p).toMatchObject({ full: false, lint: true, tsc: ['packages/cli'], web: false, deploy: 'none' });
    expect(p.tests).toEqual([{ name: 'rest', args: ['packages/cli/'], temporal: false }]);
  });

  it('改了 conventions：engine 依赖它，engine 也测', () => {
    expect(shards(pr('packages/conventions/src/ci-plan.ts'))).toEqual(['engine', 'rest']);
  });

  it('改了 db：db 和所有依赖它的（engine、api、github、jev）都测；engine 单独一台、带 Temporal', () => {
    const p = pr('packages/db/src/schema/index.ts');
    expect(shards(p)).toEqual(['engine', 'db', 'rest']);
    expect(p.tests[0]).toEqual({ name: 'engine', args: ['packages/engine/'], temporal: true });
    for (const u of ['packages/api/', 'packages/github/', 'packages/jev/']) expect(testArgs(p)).toContain(u);
    expect(p.tsc).toEqual(expect.arrayContaining(['packages/db', 'packages/engine', 'packages/api']));
  });

  it('改了 engine（#88 的偶发超时只挡改到 engine 的 PR）：别的包的 PR 不测 engine', () => {
    expect(shards(pr('packages/engine/src/worker.ts'))).toEqual(['engine']);
    for (const f of [
      'packages/cli/src/help.ts',
      'packages/web/src/app.css',
      'packages/agents-sync/src/sync.ts',
      'docs/ops.md',
    ]) {
      expect(shards(pr(f)), f).not.toContain('engine');
    }
  });

  it('改了 web：打包演示版、跑 deploy（发布、扫产物用它）；api、feishu 的测试读 web 的文件，也测，但不往下传到 engine', () => {
    const p = pr('packages/web/src/build/scan.ts');
    expect(p).toMatchObject({ web: true, deploy: 'all' });
    expect(testArgs(p)).toEqual(['packages/api/', 'packages/feishu/', 'packages/web/']);
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
    expect(pr('AGENTS.md')).toMatchObject({
      lint: false,
      deploy: 'all',
      tests: [{ args: ['packages/agents-sync/'] }],
    });
    expect(pr('docs/ops.md')).toMatchObject({ deploy: 'ops', tests: [{ name: 'db' }] });
    expect(testArgs(pr('agents/skills/discuss/SKILL.md'))).toEqual(['agents/', 'packages/agents-sync/']);
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
      'packages/github/test/fixtures/github/issue.json', // join(import.meta.dirname, '../../github/…')
      '.github/pull_request_template.md',
      '.gitignore',
    ]) {
      expect(all).toContain(must);
    }
  });

  it('每一处都落进 PATH_RULES / 依赖图 / TEST_READS', () => {
    const missed: string[] = [];
    for (const { unit, rel } of files) {
      if (ALWAYS.has(rel)) continue;
      const own = unit === AGENTS_UNIT ? 'agents/' : `packages/${unit}/`;
      for (const ref of refs(rel)) {
        if (`${ref}/`.startsWith(own)) continue;
        const probe = statSync(join(ROOT, ref)).isDirectory() ? `${ref}/x` : ref;
        const p = pr(probe);
        if (!p.full && !testArgs(p).includes(own)) missed.push(`${rel} 读 ${ref}，改它的 PR 不测 ${unit}`);
      }
    }
    expect(missed).toEqual([]);
  });
});

describe('汇总（必过检查 check）：该跑的跑了且绿，不该跑的跳过了', () => {
  const plan = pr('packages/conventions/src/ci-plan.ts');
  const needs = (over: Record<string, unknown> = {}, p: CiPlan = plan) => ({
    changes: { result: 'success', outputs: planOutputs(p) },
    hygiene: { result: 'success', outputs: {} },
    docs: { result: 'success', outputs: {} },
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

  it('纯文档：只有 changes、hygiene、docs 跑了', () => {
    const docs = pr('docs/plan.md');
    const skipped = { result: 'skipped' };
    expect(ciVerdict(needs({ lint: skipped, test: skipped }, docs)).ok).toBe(true);
    expect(ciVerdict(needs({ lint: skipped }, docs)).ok).toBe(false);
  });

  it('本该跑的被跳过、红了、取消了：不过', () => {
    for (const result of ['skipped', 'failure', 'cancelled']) {
      const v = ciVerdict(needs({ test: { result } }));
      expect(v.ok, result).toBe(false);
      expect(v.lines.join('\n')).toContain(`✗ test：${result}，本该 success`);
    }
  });

  it('deploy=ops：deploy job 要跑且绿（只跑两块也是跑），跳过、红了都不过', () => {
    const ops = pr('docs/ops.md');
    const over = { lint: { result: 'skipped' }, test: { result: 'success' } };
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

  it('changes 没算成、hygiene 红了、少了某个 job 的结果：不过', () => {
    expect(ciVerdict(needs({ changes: { result: 'failure', outputs: {} } })).ok).toBe(false);
    expect(ciVerdict(needs({ hygiene: { result: 'failure' } })).ok).toBe(false);
    expect(ciVerdict(needs({ docs: { result: 'skipped' } })).ok).toBe(false);
    const { deploy: _, ...rest } = needs();
    expect(ciVerdict(rest).lines.join('\n')).toContain('✗ deploy：没有这个 job 的结果');
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
    const full = planCi({ event: 'push', changed: [], graph: graph() });
    const broken = { ...full, web: false };
    expect(ciVerdict(needs({ web: { result: 'skipped' }, lint: { result: 'success' } }, broken)).ok).toBe(
      false,
    );
    // 全跑却只跑 deploy 的两块：job 照样 success，但 plan 本身不对
    const opsOnly: CiPlan = { ...full, deploy: 'ops' };
    const allGreen = {
      web: { result: 'success' },
      lint: { result: 'success' },
      deploy: { result: 'success' },
    };
    expect(ciVerdict(needs(allGreen, full)).ok).toBe(true);
    expect(ciVerdict(needs(allGreen, opsOnly)).ok).toBe(false);
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
    for (const line of ['lint=true', 'tsc=all', 'web=true', 'deploy=all'])
      expect(text).toContain(`${line}\n`);
    expect(text).toMatch(/^tests=\[.*"engine".*\]$/m);
  });

  it('GITHUB_OUTPUT 写不进去：退出 2', () => {
    expect(run(plan, ['--event', 'push'], { GITHUB_OUTPUT: join(ROOT, '没有这个目录', 'out') }).status).toBe(
      2,
    );
  });

  it('汇总入口：没给 CI_NEEDS、不是 JSON 退出 2；对不上退出 1；对得上退出 0', () => {
    expect(run(verdict, [], { CI_NEEDS: '' }).status).toBe(2);
    expect(run(verdict, [], { CI_NEEDS: '{' }).status).toBe(2);
    const p = planOutputs(pr('docs/plan.md'));
    const base = {
      changes: { result: 'success', outputs: p },
      hygiene: { result: 'success' },
      docs: { result: 'success' },
      lint: { result: 'skipped' },
      test: { result: 'skipped' },
      web: { result: 'skipped' },
      deploy: { result: 'skipped' },
    };
    expect(run(verdict, [], { CI_NEEDS: JSON.stringify(base) }).status).toBe(0);
    expect(
      run(verdict, [], { CI_NEEDS: JSON.stringify({ ...base, hygiene: { result: 'failure' } }) }).status,
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

  it('必过检查 check 是汇总 job：always() 跑、needs 全部 job、跑汇总入口', () => {
    const check = job('check');
    expect(check).toContain('if: always()');
    for (const j of [...ALWAYS_JOBS, ...PLANNED_JOBS])
      expect(check).toMatch(new RegExp(`needs:[^\\n]*\\b${j}\\b`));
    expect(check).toContain(['CI_NEEDS: $', '{{ toJSON(needs) }}'].join(''));
    expect(check).toContain('node packages/conventions/src/bin/ci-verdict.ts');
  });

  it('按开关跑的几个 job 都看 changes 给的开关；hygiene、docs 不看、每次都跑', () => {
    for (const j of PLANNED_JOBS) {
      expect(job(j), j).toMatch(/^ {4}needs: changes$/m);
      expect(job(j), j).toMatch(/^ {4}if: .*needs\.changes\.outputs\./m);
    }
    for (const j of ['hygiene', 'docs']) expect(job(j), j).not.toMatch(/^ {4}(if|needs):/m);
    expect(job('changes')).toContain('fetch-depth: 0');
    expect(job('changes')).toContain('node packages/conventions/src/bin/ci-plan.ts');
  });

  it('真的已知敏感值名单只给 hygiene job，它一行 PR 里的代码都不执行：代码取目标分支上的 trusted/，PR 检出到 pr/ 只当数据扫（#115 第二意见）', () => {
    const ids = [...yml.matchAll(/^ {2}([\w-]+):$/gm)].map((m) => m[1] as string);
    expect(ids).toContain('hygiene');
    for (const id of ids) {
      if (id !== 'hygiene') expect(job(id), id).not.toContain('secrets.');
    }
    const h = job('hygiene');
    expect(h).toContain('secrets.FLEET_SENSITIVE_VALUES');
    expect(h).not.toMatch(/pnpm|npm |npx|vitest|cache:/);
    // 两次检出：PR 的在 pr/，执行的代码在 trusted/，取目标分支的提交
    expect(h).toMatch(/path: pr\n/);
    expect(h).toMatch(
      /ref: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.sha \}\}\n\s+path: trusted\n/,
    );
    // 没有单行的 run（像 node packages/… 那样跑 PR 里的文件）；动态 import 的只有 TRUSTED 下的卫生检查
    expect(h.match(/^ +(?:- )?run: (?!\|).*$/gm)).toBeNull();
    expect(h).toContain('working-directory: pr');
    expect(h).toMatch(/TRUSTED: \$\{\{ github\.workspace \}\}\/trusted\n/);
    const imports = [...h.matchAll(/import\(([^)]*)\)/g)].map((m) => m[1]);
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
    const todo = ['packages/conventions/src/bin/ci-plan.ts', 'packages/conventions/src/bin/ci-verdict.ts'];
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

  it('deploy job：all 跑全套、ops 跑 run.sh --ops，两种都开 job；run.sh 认 --ops、全套里带着 ops-only 自检', () => {
    const d = job('deploy');
    expect(d).toContain("if: needs.changes.outputs.deploy == 'all' || needs.changes.outputs.deploy == 'ops'");
    expect(d).toMatch(
      /- if: needs\.changes\.outputs\.deploy == 'all'\n\s+run: sudo FLEET_TEST_SYSTEM_USERS=1 bash deploy\/test\/run\.sh\n/,
    );
    expect(d).toMatch(
      /- if: needs\.changes\.outputs\.deploy == 'ops'\n\s+run: bash deploy\/test\/run\.sh --ops\n/,
    );
    const runSh = readFileSync(join(ROOT, 'deploy/test/run.sh'), 'utf8');
    expect(runSh).toMatch(/^--ops\) only_ops=1 ;;$/m);
    expect(runSh).toMatch(/\bops-only\b.*; do$/m);
    expect(existsSync(join(ROOT, 'deploy/test/ops-only.test.sh'))).toBe(true);
  });

  it('不用工作流级 paths 过滤（必过检查要永远触发）', () => {
    expect(yml).not.toMatch(/^\s+paths(-ignore)?:/m);
  });
});
