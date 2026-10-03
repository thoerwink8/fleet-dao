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
  PATH_RULES,
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
/** 要测的包目录（同一组切成几台时，每台的包目录一样、只差末尾的 --shard，这里去重、去掉 --shard）。 */
const testArgs = (p: CiPlan) => [
  ...new Set(p.tests.flatMap((s) => s.args).filter((a) => !a.startsWith('--shard='))),
];
/** 跑哪几组（engine、db、rest）；一组切成几台不影响这里。 */
const shards = (p: CiPlan) => [...new Set(p.tests.map((s) => s.name))];

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
      expect(shards(p)).toEqual(['engine', 'db', 'rest']);
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

  it('纯文档（docs、specs、README、开单表单）：只剩每次都跑的 hygiene、docs', () => {
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
    expect(p.tests).toEqual([{ name: 'rest', label: 'rest', args: ['packages/cli/'], temporal: false }]);
  });

  it('改了 conventions：engine 依赖它，engine 也测', () => {
    expect(shards(pr('packages/conventions/src/ci-plan.ts'))).toEqual(['engine', 'rest']);
  });

  it('改了 db：db 和所有依赖它的（engine、api、github、jev）都测；engine 单独一台、带 Temporal', () => {
    const p = pr('packages/db/src/schema/index.ts');
    expect(shards(p)).toEqual(['engine', 'db', 'rest']);
    expect(p.tests[0]).toEqual({
      name: 'engine',
      label: 'engine 1/2',
      args: ['packages/engine/', '--shard=1/2'],
      temporal: true,
    });
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
    // AGENTS.md 要带两家：agents-sync 分发它，agents 的钉子测试读它（agents/test/rules/design-skills.rules.test.ts，#522）；
    // 只带 agents-sync 的话改通用段的 PR 不测 agents，那条钉子测试根本不跑（主线从 1bff4dbc 起红了 8+ 个提交）
    expect(pr('AGENTS.md')).toMatchObject({
      biome: false,
      deploy: 'none',
      tests: [{ args: ['agents/', 'packages/agents-sync/'] }],
    });
    expect(pr('docs/ops.md')).toMatchObject({ deploy: 'ops', tests: [{ name: 'db' }] });
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
  const plan = pr('packages/conventions/src/ci-plan.ts');
  const needs = (over: Record<string, unknown> = {}, p: CiPlan = plan) => ({
    changes: { result: 'success', outputs: planOutputs(p) },
    hygiene: { result: 'success', outputs: {} },
    docs: { result: 'success', outputs: {} },
    biome: { result: 'success', outputs: {} },
    tsc: { result: 'success', outputs: {} },
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
    const docs = pr('docs/design.md');
    const skipped = { result: 'skipped' };
    expect(ciVerdict(needs({ biome: skipped, tsc: skipped, test: skipped }, docs)).ok).toBe(true);
    expect(ciVerdict(needs({ biome: skipped }, docs)).ok).toBe(false);
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
    const over = { biome: { result: 'skipped' }, tsc: { result: 'skipped' }, test: { result: 'success' } };
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
    expect(ciVerdict(needs({ docs: { result: 'skipped' } })).ok).toBe(false);
    const { deploy: _, ...rest } = needs();
    expect(ciVerdict(rest).lines.join('\n')).toContain('✗ deploy：没有这个 job 的结果');
  });

  it('hygiene 红了：汇总 check 照样过，不挡合并（卫生检查改成挡在推之前，创始人 2026-09-28 傍晚拍）', () => {
    const v = ciVerdict(needs({ hygiene: { result: 'failure' } }));
    expect(v.ok).toBe(true);
    // hygiene 不在必过名单里：不管它跑成什么样，汇总的结论文字里都不提它
    expect(v.lines.join('\n')).not.toContain('hygiene');
    for (const result of ['skipped', 'cancelled']) {
      expect(ciVerdict(needs({ hygiene: { result } })).ok, result).toBe(true);
    }
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
    expect(ciVerdict(needs({ web: { result: 'skipped' }, biome: { result: 'success' } }, broken)).ok).toBe(
      false,
    );
    // 全跑却只跑 deploy 的两块：job 照样 success，但 plan 本身不对
    const opsOnly: CiPlan = { ...full, deploy: 'ops' };
    const allGreen = {
      web: { result: 'success' },
      biome: { result: 'success' },
      tsc: { result: 'success' },
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
    for (const line of ['biome=true', 'tsc=all', 'web=true', 'deploy=all'])
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
    const p = planOutputs(pr('docs/design.md'));
    const base = {
      changes: { result: 'success', outputs: p },
      hygiene: { result: 'success' },
      docs: { result: 'success' },
      biome: { result: 'skipped' },
      tsc: { result: 'skipped' },
      test: { result: 'skipped' },
      web: { result: 'skipped' },
      deploy: { result: 'skipped' },
    };
    expect(run(verdict, [], { CI_NEEDS: JSON.stringify(base) }).status).toBe(0);
    expect(
      run(verdict, [], { CI_NEEDS: JSON.stringify({ ...base, docs: { result: 'failure' } }) }).status,
    ).toBe(1);
    // hygiene 红了不挡：汇总入口照样退出 0（卫生检查改成挡在推之前，创始人 2026-09-28 傍晚拍）
    expect(
      run(verdict, [], { CI_NEEDS: JSON.stringify({ ...base, hygiene: { result: 'failure' } }) }).status,
    ).toBe(0);
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

  it('【故意造出的失败】biome 和 tsc 各自一个 job：合成一个 job 的连续 step，biome 先红就把 tsc 跳过（#566 的 7 个类型错就是这么漏的）', () => {
    // job() 切到下一个 job 头，会把紧贴在它上面的注释一起带进来；判「正文里有没有 tsc」前先把整行注释去掉。
    const body = (id: string) =>
      job(id)
        .split('\n')
        .filter((l) => !/^\s*#/.test(l))
        .join('\n');
    const biome = job('biome');
    const tsc = job('tsc');
    expect(biome, 'biome job 不见了').not.toBe('');
    expect(tsc, 'tsc job 不见了，或者又并回 biome 里了').not.toBe('');
    // 两个各自开、各自看自己的开关
    expect(biome).toMatch(/^ {4}needs: changes$/m);
    expect(biome).toMatch(/^ {4}if: needs\.changes\.outputs\.biome == 'true'$/m);
    expect(tsc).toMatch(/^ {4}needs: changes$/m);
    expect(tsc).toMatch(/^ {4}if: needs\.changes\.outputs\.tsc != ''$/m);
    expect(biome).toContain('pnpm exec biome check .');
    expect(tsc).toContain('pnpm exec tsc -b');
    // biome 那个 job 里不许再出现 tsc（连着写就又是「前一步红了后一步不跑」）。
    // 不认命令怎么写、不认 step 叫什么名、也不认单行还是多行 run: | —— 正文里出现 tsc 就判红。
    expect(body('biome')).not.toMatch(/\btsc\b/);
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

  it('按开关跑的几个 job 都看 changes 给的开关；hygiene、docs 不看、每次都跑', () => {
    for (const j of PLANNED_JOBS) {
      expect(job(j), j).toMatch(/^ {4}needs: changes$/m);
      expect(job(j), j).toMatch(/^ {4}if: .*needs\.changes\.outputs\./m);
    }
    for (const j of ['hygiene', 'docs']) expect(job(j), j).not.toMatch(/^ {4}(if|needs):/m);
    expect(job('changes')).toContain('fetch-depth: 0');
    expect(job('changes')).toContain('node packages/conventions/src/bin/ci-plan.ts');
  });

  it('没有 job 用仓库密钥；hygiene 一行 PR 里的代码都不执行：代码取目标分支上的 trusted/，PR 检出到 pr/ 只当数据扫（这个 PR 自己改不宽卫生检查的规则，#115 第二意见）', () => {
    const ids = [...yml.matchAll(/^ {2}([\w-]+):$/gm)].map((m) => m[1] as string);
    expect(ids).toContain('hygiene');
    for (const id of ids) expect(job(id), id).not.toContain('secrets.');
    const h = job('hygiene');
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
    expect(runSh).toContain('ops-only auto-release-state'); // 分台名单里排着 ops-only（自己也要跑）
    expect(existsSync(join(ROOT, 'deploy/test/ops-only.test.sh'))).toBe(true);
  });

  it('不用工作流级 paths 过滤（必过检查要永远触发）', () => {
    expect(yml).not.toMatch(/^\s+paths(-ignore)?:/m);
  });
});

describe('测试切成几台并行跑（vitest --shard，#654 F）', () => {
  /** 每一组的 --shard=i/n 必须正好是 1..n 各一台：少一台那几个测试文件就没人跑（check 只看跑了的台是不是绿，看不出漏了哪台）。 */
  function coverage(p: CiPlan): Record<string, string> {
    const out: Record<string, string> = {};
    for (const group of shards(p)) {
      const legs = p.tests.filter((s) => s.name === group);
      const marks = legs.map((s) => s.args.find((a) => a.startsWith('--shard='))?.slice('--shard='.length));
      if (legs.length === 1 && marks[0] === undefined) {
        out[group] = '1 台，不切';
        continue;
      }
      const n = legs.length;
      const got = marks.map((m) => /^(\d+)\/(\d+)$/.exec(m ?? ''));
      const ok = got.every((m, i) => m && Number(m[1]) === i + 1 && Number(m[2]) === n);
      out[group] = ok ? `${n} 台，1..${n} 齐` : `对不上：${marks.join('、')}`;
    }
    return out;
  }

  it('全跑：engine 两台、db 一台、rest 三台；每台带自己的 --shard 和 job 名', () => {
    const p = planCi({ event: 'push', changed: [], graph: graph() });
    expect(p.tests.map((s) => s.label)).toEqual([
      'engine 1/2',
      'engine 2/2',
      'db',
      'rest 1/3',
      'rest 2/3',
      'rest 3/3',
    ]);
    expect(p.tests.filter((s) => s.name === 'engine').map((s) => s.args)).toEqual([
      ['packages/engine/', '--shard=1/2'],
      ['packages/engine/', '--shard=2/2'],
    ]);
    expect(p.tests.find((s) => s.name === 'db')?.args).toEqual(['packages/db/']);
    expect(p.tests.filter((s) => s.temporal).map((s) => s.name)).toEqual(['engine', 'engine']);
    expect(coverage(p)).toEqual({ engine: '2 台，1..2 齐', db: '1 台，不切', rest: '3 台，1..3 齐' });
  });

  it('改了 db：engine 切两台、rest 的包够多就切三台；每台装一份 Temporal（temporal 跟着 engine 走）', () => {
    const p = pr('packages/db/src/schema/index.ts');
    expect(coverage(p)).toEqual({ engine: '2 台，1..2 齐', db: '1 台，不切', rest: '3 台，1..3 齐' });
  });

  it('rest 只有一两个包：不切（几十秒就跑完，切开只多出每台 30 秒的固定开销）', () => {
    const p = pr('packages/cli/src/help.ts');
    expect(p.tests).toHaveLength(1);
    expect(coverage(p)).toEqual({ rest: '1 台，不切' });
  });

  it('改了 engine：只有 engine，切两台', () => {
    expect(coverage(pr('packages/engine/src/worker.ts'))).toEqual({ engine: '2 台，1..2 齐' });
  });

  it('【故意造出的失败】少了一台 / 台号对不上：coverage 报「对不上」，不当成齐了', () => {
    const p = planCi({ event: 'push', changed: [], graph: graph() });
    const lost = { ...p, tests: p.tests.filter((s) => s.label !== 'rest 2/3') };
    expect(coverage(lost).rest).toBe('对不上：1/3、3/3');
    const wrong = {
      ...p,
      tests: p.tests.map((s) =>
        s.label === 'engine 2/2' ? { ...s, args: ['packages/engine/', '--shard=1/2'] } : s,
      ),
    };
    expect(coverage(wrong).engine).toBe('对不上：1/2、1/2');
  });

  it('ci.yml 的 job 名用 matrix.label（切了以后每台名字不同），db 的 Postgres 仍按组名 db 认', () => {
    const yml = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
    expect(yml).toContain('name: test (${{ matrix.label }})');
    expect(yml).toContain("matrix.name == 'db'");
  });
});
