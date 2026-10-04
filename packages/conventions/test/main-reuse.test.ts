// 主线同树复用（src/main-reuse.ts、ci-plan.ts 的 applyReuse / ciVerdict、两个入口、ci.yml 的写法）。
// 复用 = 少跑，所以每一条「对不上、查不到、读不到」都有一条故意造出的失败：全部必须回到「不复用」，不能当绿。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applyReuse,
  assignTests,
  type CiPlan,
  ciVerdict,
  PLANNED_JOBS,
  planCi,
  planOutputs,
  readGraph,
} from '../src/ci-plan.ts';
import type { GhApi } from '../src/gh-api.ts';
import { CLAIM_PREFIX, claimOf, claimStepName, findReuse, parseReuse, reuseOf } from '../src/main-reuse.ts';
import { fsRepo } from '../src/repo.ts';
import { listTestFiles, parseTimings, TIMINGS_FILE } from '../src/test-split.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SHA = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const TREE = 'c'.repeat(40);
const BASE_TREE = 'd'.repeat(40);
const OTHER = 'e'.repeat(40);
const input = { sha: SHA, tree: TREE, baseTree: BASE_TREE, workflowFile: 'ci.yml' };

const pull = (over: Record<string, unknown> = {}) => ({
  number: 7,
  merge_commit_sha: SHA,
  merged_at: '2026-10-05T00:00:00Z',
  base: { ref: 'main' },
  head: { sha: HEAD },
  ...over,
});
const run = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  head_sha: HEAD,
  event: 'pull_request',
  conclusion: 'success',
  ...over,
});
const job = (name: string, conclusion = 'success', steps: string[] = []) => ({
  name,
  conclusion,
  steps: steps.map((n) => ({ name: n })),
});
/** 一次干净的 PR 运行的 jobs：check、changes 都成功，changes 里带着声明。 */
const jobsOf = (
  claim: string | string[] | null = claimStepName(TREE, BASE_TREE),
  over: Record<string, unknown> = {},
) => ({
  jobs: [
    job('check'),
    job('changes', 'success', ['Set up job', ...(claim === null ? [] : [claim].flat()), 'Complete job']),
  ],
  ...over,
});

interface World {
  pulls: unknown;
  runs: unknown;
  jobs: Record<number, unknown>;
  broken?: string;
  seen: string[];
}
function api(w: World): GhApi {
  return {
    async get(path) {
      w.seen.push(path);
      if (w.broken && path.includes(w.broken)) throw new Error(`GitHub 回了 500（GET ${path}）`);
      if (path.startsWith('/commits/')) return w.pulls;
      if (path.startsWith('/actions/workflows/')) return w.runs;
      const id = Number(/\/actions\/runs\/(\d+)\/jobs/.exec(path)?.[1]);
      return w.jobs[id];
    },
    getOrNull: async () => null,
    post: async () => {},
  };
}
const world = (over: Partial<World> = {}): World => ({
  pulls: [pull()],
  runs: { workflow_runs: [run(11)] },
  jobs: { 11: jobsOf() },
  seen: [],
  ...over,
});

describe('声明（PR 那一轮 changes job 的步骤名）', () => {
  it('写法就是 claimStepName 那一句，恰好一条才认', () => {
    expect(claimStepName(TREE, BASE_TREE)).toBe(`${CLAIM_PREFIX} tree=${TREE} base=${BASE_TREE}`);
    expect(claimOf(['x', claimStepName(TREE, BASE_TREE)])).toEqual({ tree: TREE, baseTree: BASE_TREE });
    expect(claimOf(['x', 'y'])).toBeNull();
  });

  it('【故意造出的失败】多于一条、写法认不出（短哈希、缺 base、HEAD 不是合并提交的占位）：不是正常的声明', () => {
    const one = claimStepName(TREE, BASE_TREE);
    expect(claimOf([one, claimStepName(OTHER, BASE_TREE)])).toMatch(/2 条/);
    expect(claimOf([`${CLAIM_PREFIX} tree=abc base=${BASE_TREE}`])).toMatch(/认不出/);
    expect(claimOf([`${CLAIM_PREFIX} tree=${TREE}`])).toMatch(/认不出/);
    expect(claimOf([`${CLAIM_PREFIX} 无（HEAD 不是合并提交）`])).toMatch(/认不出/);
  });
});

describe('findReuse：同树、同基准树、成功的 PR 检查', () => {
  it('对得上：回运行号和 PR 号；只读了该读的接口', async () => {
    const w = world();
    expect(await findReuse(api(w), input)).toEqual({
      reuse: { run: 11, pr: 7, tree: TREE, baseTree: BASE_TREE },
    });
    expect(w.seen).toEqual([
      `/commits/${SHA}/pulls`,
      `/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${HEAD}&status=success&per_page=5`,
      '/actions/runs/11/jobs?filter=latest&per_page=100',
    ]);
  });

  it('重跑过：头一次对不上的不要紧，后一次对得上就认后一次', async () => {
    const w = world({
      runs: { workflow_runs: [run(12), run(11)] },
      jobs: { 12: jobsOf(claimStepName(OTHER, BASE_TREE)), 11: jobsOf() },
    });
    expect(await findReuse(api(w), input)).toMatchObject({ reuse: { run: 11 } });
  });

  const none = async (w: World) => {
    const r = await findReuse(api(w), input);
    expect(r.reuse, JSON.stringify(r)).toBeNull();
    return 'why' in r ? r.why : '';
  };

  it('【故意造出的失败】树对不上（合并前主线又动过）：不复用', async () => {
    expect(await none(world({ jobs: { 11: jobsOf(claimStepName(OTHER, BASE_TREE)) } }))).toContain(
      '不是这次主线的树',
    );
  });

  it('【故意造出的失败】基准树对不上（中间插了别的提交，PR 选测试用的区间不同）：不复用', async () => {
    expect(await none(world({ jobs: { 11: jobsOf(claimStepName(TREE, OTHER)) } }))).toContain('基准树');
  });

  it('【故意造出的失败】没有声明（声明上线之前跑的）、声明多于一条或认不出：不复用', async () => {
    expect(await none(world({ jobs: { 11: jobsOf(null) } }))).toContain('没有');
    expect(
      await none(
        world({ jobs: { 11: jobsOf([claimStepName(TREE, BASE_TREE), claimStepName(OTHER, BASE_TREE)]) } }),
      ),
    ).toContain('2 条');
    expect(await none(world({ jobs: { 11: jobsOf(`${CLAIM_PREFIX} tree=1 base=2`) } }))).toContain('认不出');
  });

  it('【故意造出的失败】check 或 changes 不是恰好一个成功的 job（缺、重名、不是 success）：不复用', async () => {
    const bad = (jobs: unknown[]) => none(world({ jobs: { 11: { jobs } } }));
    const claimJob = job('changes', 'success', [claimStepName(TREE, BASE_TREE)]);
    expect(await bad([claimJob])).toContain('check');
    expect(await bad([job('check', 'failure'), claimJob])).toContain('check');
    expect(await bad([job('check'), job('check'), claimJob])).toContain('check');
    expect(await bad([job('check'), job('changes', 'failure', [claimStepName(TREE, BASE_TREE)])])).toContain(
      'changes',
    );
    expect(await bad([job('check')])).toContain('changes');
  });

  it('【故意造出的失败】没有对应的 PR（直接推的）、对得上好几个、PR 没合并、合到别的分支：不复用', async () => {
    expect(await none(world({ pulls: [] }))).toContain('不是哪个 PR');
    expect(await none(world({ pulls: [pull(), pull({ number: 8 })] }))).toContain('2 个 PR');
    expect(await none(world({ pulls: [pull({ merged_at: null })] }))).toContain('不是哪个 PR');
    expect(await none(world({ pulls: [pull({ base: { ref: 'release' } })] }))).toContain('不是哪个 PR');
    expect(await none(world({ pulls: [pull({ merge_commit_sha: OTHER })] }))).toContain('不是哪个 PR');
  });

  it('【故意造出的失败】PR 头上没有成功的运行、运行是别的头或别的事件的（接口不管过滤说什么，自己再核）：不复用', async () => {
    expect(await none(world({ runs: { workflow_runs: [] } }))).toContain('没有成功的');
    expect(
      await none(
        world({
          runs: {
            workflow_runs: [
              run(11, { head_sha: OTHER }),
              run(12, { event: 'push' }),
              run(13, { conclusion: 'failure' }),
              run(14, { id: 'x' }),
            ],
          },
        }),
      ),
    ).toContain('没有成功的');
  });

  it('【故意造出的失败】读不到、认不出：抛出去（调用方记「没查成」、不复用），不吞成「对不上」也不当绿', async () => {
    for (const broken of ['/pulls', '/actions/workflows/', '/jobs']) {
      await expect(findReuse(api(world({ broken })), input), broken).rejects.toThrow('500');
    }
    await expect(findReuse(api(world({ pulls: { x: 1 } })), input)).rejects.toThrow('不是列表');
    await expect(findReuse(api(world({ pulls: [pull({ head: {} })] })), input)).rejects.toThrow('认不出');
    await expect(findReuse(api(world({ runs: [] })), input)).rejects.toThrow('workflow_runs');
    await expect(findReuse(api(world({ jobs: { 11: { nope: 1 } } })), input)).rejects.toThrow('jobs');
    await expect(
      findReuse(
        api(world({ jobs: { 11: { jobs: [job('check'), { name: 'changes', conclusion: 'success' }] } } })),
        input,
      ),
    ).rejects.toThrow('步骤列表');
    await expect(findReuse(api(world()), { ...input, tree: 'abc' })).rejects.toThrow('树认不出');
    await expect(findReuse(api(world()), { ...input, baseTree: '' })).rejects.toThrow('基准树认不出');
  });
});

describe('parseReuse / reuseOf：认出来是齐全的才算', () => {
  const ok = { run: 11, pr: 7, tree: TREE, baseTree: BASE_TREE };
  it('齐全的认', () => {
    expect(parseReuse(JSON.stringify(ok))).toEqual(ok);
    expect(reuseOf(ok)).toEqual(ok);
  });
  it('【故意造出的失败】空、坏 JSON、字段缺或类型不对、哈希不是 40 位：回 null，不当成复用', () => {
    for (const bad of [
      undefined,
      '',
      '  ',
      '{',
      '[]',
      'null',
      JSON.stringify({ ...ok, run: 0 }),
      JSON.stringify({ ...ok, pr: 1.5 }),
      JSON.stringify({ ...ok, tree: 'abc' }),
      JSON.stringify({ ...ok, baseTree: 5 }),
      JSON.stringify({ run: 11 }),
    ]) {
      expect(parseReuse(bad), String(bad)).toBeNull();
    }
    expect(reuseOf('x')).toBeNull();
  });
});

describe('applyReuse + 汇总（check）：复用后 test、web、deploy 本该跳过', () => {
  const repo = fsRepo(ROOT);
  const all = listTestFiles(repo);
  const timings = parseTimings(repo.read(TIMINGS_FILE));
  if (typeof all === 'string' || typeof timings === 'string') throw new Error('读不到测试清单或耗时表');
  const planFor = (...changed: string[]): CiPlan => {
    const graph = readGraph(repo);
    const r = assignTests(planCi({ event: 'pull_request', changed, graph }), {
      all,
      timings,
      read: (rel) => repo.read(rel),
    });
    if (typeof r === 'string') throw new Error(r);
    return r.plan;
  };
  const reuse = { run: 11, pr: 7, tree: TREE, baseTree: BASE_TREE };
  const needs = (p: CiPlan, over: Record<string, unknown> = {}) => ({
    changes: { result: 'success', outputs: planOutputs(p) },
    lint: { result: 'success' },
    test: { result: 'skipped' },
    web: { result: 'skipped' },
    deploy: { result: 'skipped' },
    ...over,
  });

  it('applyReuse：test、web、deploy 清空、写明复用了谁；biome、tsc 的开关不动；不复用时一个字没变', () => {
    const full = planFor('.github/workflows/ci.yml');
    expect(full.full).toBe(true);
    const r = applyReuse(full, reuse);
    expect(r).toMatchObject({
      full: false,
      tests: [],
      testUnits: [],
      web: false,
      deploy: 'none',
      biome: true,
      reused: reuse,
    });
    expect(r.reasons.at(-1)).toContain('PR #7');
    expect(planOutputs(r)).toMatchObject({
      tests: '[]',
      web: 'false',
      deploy: 'none',
      deploy_matrix: '[]',
      reused: '11',
    });
    expect(planOutputs(full).reused).toBe('');
    expect('reused' in full).toBe(false);
  });

  it('主线推送上复用：三个 job 都 skipped 才过（skipped 不被当成「没跑」或失败）', () => {
    const p = applyReuse(planFor('packages/cli/src/help.ts'), reuse);
    const v = ciVerdict(needs(p), 'push');
    expect(v.ok, v.lines.join('\n')).toBe(true);
    expect(v.lines.join('\n')).toContain('同树复用');
    for (const j of PLANNED_JOBS) expect(v.lines.join('\n')).toContain(`✓ ${j}：skipped`);
  });

  it('【故意造出的失败】复用了却有 job 真跑了、或红了：不过（test 该 skipped 却 success）', () => {
    const p = applyReuse(planFor('packages/cli/src/help.ts'), reuse);
    expect(ciVerdict(needs(p, { test: { result: 'success' } }), 'push').ok).toBe(false);
    expect(ciVerdict(needs(p, { deploy: { result: 'failure' } }), 'push').ok).toBe(false);
    expect(ciVerdict(needs(p, { lint: { result: 'failure' } }), 'push').ok).toBe(false);
  });

  it('【故意造出的失败】不是主线推送、没给事件：带复用记录的 plan 不认（PR 不能靠它把测试变成「本该跳过」）', () => {
    const p = applyReuse(planFor('packages/cli/src/help.ts'), reuse);
    for (const event of ['pull_request', 'schedule', undefined]) {
      const v = ciVerdict(needs(p), event);
      expect(v.ok, String(event)).toBe(false);
      expect(v.lines.join('\n')).toContain('不是主线推送');
    }
  });

  it('【故意造出的失败】reused 输出和 plan 里的不是一份、plan 里没有输出却有、记录不齐全、复用了却还有要测的：不过', () => {
    const p = applyReuse(planFor('packages/cli/src/help.ts'), reuse);
    const wrongRun = needs(p, {
      changes: { result: 'success', outputs: { ...planOutputs(p), reused: '99' } },
    });
    expect(ciVerdict(wrongRun, 'push').ok).toBe(false);
    const stray = needs(planFor('packages/cli/src/help.ts'), {
      changes: {
        result: 'success',
        outputs: { ...planOutputs(planFor('packages/cli/src/help.ts')), reused: '11' },
      },
      test: { result: 'success' },
    });
    expect(ciVerdict(stray, 'push').ok).toBe(false);
    const broken = JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
    broken.reused = { run: 11 };
    expect(
      ciVerdict(
        needs(p, {
          changes: { result: 'success', outputs: { ...planOutputs(p), plan: JSON.stringify(broken) } },
        }),
        'push',
      ).lines.join('\n'),
    ).toContain('reused');
    const stillTesting = { ...p, tests: planFor('packages/cli/src/help.ts').tests };
    expect(
      ciVerdict(
        needs(p, {
          changes: {
            result: 'success',
            outputs: {
              ...planOutputs(p),
              plan: JSON.stringify(stillTesting),
              tests: JSON.stringify(stillTesting.tests),
            },
          },
        }),
        'push',
      ).ok,
    ).toBe(false);
  });
});

describe('入口 ci-plan.ts --reuse', () => {
  const bin = fileURLToPath(new URL('../src/bin/ci-plan.ts', import.meta.url));
  const git = (...a: string[]) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  const headTree = git('rev-parse', 'HEAD^{tree}');
  const exec = (args: string[]) => {
    const out = join(mkdtempSync(join(tmpdir(), 'ci-reuse-')), 'out');
    writeFileSync(out, '');
    const r = spawnSync(process.execPath, [bin, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: '' },
    });
    return { ...r, out: readFileSync(out, 'utf8') };
  };
  const good = JSON.stringify({ run: 11, pr: 7, tree: headTree, baseTree: headTree });

  it('推送 + 区间基准 + 两棵树都对得上：test、web、deploy 复用，reused 写进输出', () => {
    // 基准给 HEAD：区间是空的，plan 本来升成全跑（改动列表是空的）；复用后三个都被标成不测
    const r = exec(['--event', 'push', '--main-base', 'HEAD', '--reuse', good]);
    expect(r.status).toBe(0);
    expect(r.out).toContain('reused=11\n');
    expect(r.out).toContain('tests=[]\n');
    expect(r.out).toContain('web=false\n');
    expect(r.out).toContain('deploy=none\n');
    expect(r.stdout).toContain('同树复用');
  });

  it('没给 --reuse 或给空：照旧全跑，reused 是空', () => {
    for (const args of [[], ['--reuse', '']]) {
      const r = exec(['--event', 'push', '--main-base', 'HEAD', ...args]);
      expect(r.status).toBe(0);
      expect(r.out).toContain('reused=\n');
      expect(r.out).toMatch(/^tests=\[.*"files"/m);
    }
  });

  it('【故意造出的失败】树对不上、记录认不出：不复用、照区间全跑，留 ::warning::', () => {
    const wrongTree = JSON.stringify({ run: 11, pr: 7, tree: OTHER, baseTree: headTree });
    const wrongBase = JSON.stringify({ run: 11, pr: 7, tree: headTree, baseTree: OTHER });
    for (const text of [wrongTree, wrongBase, '{', JSON.stringify({ run: 11 })]) {
      const r = exec(['--event', 'push', '--main-base', 'HEAD', '--reuse', text]);
      expect(r.status, text).toBe(0);
      expect(r.stdout, text).toContain('::warning::同树复用');
      expect(r.out, text).toContain('reused=\n');
      expect(r.out, text).toMatch(/^tests=\[.*"files"/m);
    }
  });

  it('【故意造出的失败】PR 事件、或没给区间基准就带 --reuse：退出 2，不静默当成复用', () => {
    expect(exec(['--event', 'pull_request', '--base', 'HEAD', '--reuse', good]).status).toBe(2);
    expect(exec(['--event', 'push', '--reuse', good]).status).toBe(2);
  });
});

describe('入口 main-reuse.ts', () => {
  const bin = fileURLToPath(new URL('../src/bin/main-reuse.ts', import.meta.url));
  const exec = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [bin, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_TOKEN: '', ...env },
    });

  it('【故意造出的失败】没有基准、基准认不出、没令牌（查不成）：什么都不打到标准输出、退出 0、留 ::warning::——照旧全跑', () => {
    for (const args of [[], ['--base', ''], ['--base', 'HEAD'], ['--base', 'a'.repeat(40)]]) {
      const r = exec(args);
      expect(r.status, args.join(' ')).toBe(0);
      expect(r.stdout, args.join(' ')).toBe('');
      expect(r.stderr, args.join(' ')).toContain('::warning::主线这一轮不复用');
    }
  });

  it('参数不对（多余的参数、工作流名不像文件名）：退出 2', () => {
    expect(exec(['--nope']).status).toBe(2);
    expect(exec(['--base', 'a'.repeat(40), '--workflow', '../x']).status).toBe(2);
  });
});

describe('ci.yml 的写法', () => {
  const yml = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const changes = yml.slice(yml.indexOf('  changes:'), yml.indexOf('\n  lint:'));
  const check = yml.slice(yml.indexOf('\n  check:'));

  it('PR 留声明：步骤名用同一个前缀、值来自 tree= base= 那一步；主线查复用排在算计划之前、且只在 push 上', () => {
    expect(changes).toContain(`name: ${CLAIM_PREFIX} \${{ steps.tested.outputs.claim }}`);
    const echo =
      /echo "claim=(tree=\$\(git rev-parse 'HEAD\^\{tree\}'\) base=\$\(git rev-parse 'HEAD\^1\^\{tree\}'\))"/.exec(
        changes,
      );
    expect(echo, '声明那一步的写法换了：claimStepName 和它要一起改').not.toBeNull();
    // 把 shell 里的两处换成真哈希，必须正好是 claimStepName 认的样子
    const filled = `${CLAIM_PREFIX} ${(echo?.[1] ?? '').replace(/\$\(git rev-parse 'HEAD\^\{tree\}'\)/, TREE).replace(/\$\(git rev-parse 'HEAD\^1\^\{tree\}'\)/, BASE_TREE)}`;
    expect(filled).toBe(claimStepName(TREE, BASE_TREE));
    expect(changes).toMatch(/- id: tested\n\s+if: github\.event_name == 'pull_request'/);
    expect(changes).toMatch(/- id: reuse\n\s+if: github\.event_name == 'push'/);
    expect(changes.indexOf('id: reuse')).toBeLessThan(changes.indexOf('id: plan'));
    expect(changes).toContain('--reuse "$REUSE"');
    expect(changes).toContain(['REUSE: $', '{{ steps.reuse.outputs.reuse }}'].join(''));
    expect(changes).toContain(['reused: $', '{{ steps.plan.outputs.reused }}'].join(''));
  });

  it('【故意造出的失败】声明那一步缺了 pull_request 条件、或检出不是 fetch-depth: 0：查得出来（主线那一步要读基准树，要全历史）', () => {
    expect(changes).toContain('fetch-depth: 0');
    const noIf = changes.replace(
      /- id: tested\n\s+if: github\.event_name == 'pull_request'\n/,
      '- id: tested\n',
    );
    expect(noIf).not.toBe(changes);
    expect(noIf).not.toMatch(/- id: tested\n\s+if: github\.event_name == 'pull_request'/);
  });

  it('汇总（check）把事件名交给判法：同树复用只有主线推送认', () => {
    expect(check).toContain(['CI_EVENT: $', '{{ github.event_name }}'].join(''));
  });
});
