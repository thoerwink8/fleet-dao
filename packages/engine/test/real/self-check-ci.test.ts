import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  type CiSourceInput,
  ciTestCoverage,
  isCiContractPath,
  trustedReleaseCommit,
} from '../../src/real/self-check-ci.ts';

const HEAD = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const RELEASE = 'c'.repeat(40);
const input: CiSourceInput = {
  pr: 12,
  head: HEAD,
  tree: TREE,
  node: 'v22.23.2',
  pnpm: '11.28.2',
  vitest: '5.0.1',
};
const signal = () => new AbortController().signal;
const blob = (content: string) => ({
  sha: createHash('sha1')
    .update(`blob ${Buffer.byteLength(content)}\0`)
    .update(content)
    .digest('hex'),
  body: { encoding: 'base64', content: Buffer.from(content).toString('base64') },
});
function fixture() {
  const pkg = blob('{"packageManager":"pnpm@11.28.2"}');
  const lock = blob(
    'importers:\n  .:\n    devDependencies:\n      vitest:\n        specifier: ^5.0.1\n        version: 5.0.1(vite@8.3.0)\n',
  );
  const tree = {
    truncated: false,
    tree: [
      { path: 'package.json', sha: pkg.sha, mode: '100644', type: 'blob' },
      { path: 'pnpm-lock.yaml', sha: lock.sha, mode: '100644', type: 'blob' },
      { path: '.github/workflows/ci.yml', sha: 'd'.repeat(40), mode: '100644', type: 'blob' },
    ],
  };
  const pr = {
    number: 12,
    state: 'open',
    head: { sha: HEAD, repo: { full_name: 'thoerwink8/fleet-dao' } },
    base: { ref: 'main', repo: { full_name: 'thoerwink8/fleet-dao' } },
  };
  const run = {
    id: 50,
    workflow_id: 9,
    head_sha: HEAD,
    event: 'pull_request',
    path: '.github/workflows/ci.yml',
    status: 'completed',
    conclusion: 'success',
    run_attempt: 2,
    repository: { full_name: 'thoerwink8/fleet-dao' },
    pull_requests: [{ number: 12 }],
  };
  const job = (name: string, steps: unknown[] = []) => ({
    name,
    status: 'completed',
    conclusion: 'success',
    steps,
  });
  const jobs = {
    total_count: 4,
    jobs: [
      job('check'),
      job('changes', [{ name: `已测的树 tree=${TREE}`, conclusion: 'success' }]),
      job('test (1/2)', [{ name: '已测的环境 node=v22.23.3', conclusion: 'success' }]),
      job('test (2/2)', [{ name: '已测的环境 node=v22.23.4', conclusion: 'success' }]),
    ],
  };
  const runs = { total_count: 1, workflow_runs: [{ id: 50 }] };
  const data: Record<string, unknown> = {
    '/pulls/12': pr,
    [`/git/trees/${RELEASE}?recursive=1`]: tree,
    [`/git/trees/${TREE}?recursive=1`]: structuredClone(tree),
    [`/git/blobs/${pkg.sha}`]: pkg.body,
    [`/git/blobs/${lock.sha}`]: lock.body,
    '/actions/workflows/ci.yml': { id: 9, path: '.github/workflows/ci.yml' },
    [`/actions/workflows/9/runs?event=pull_request&head_sha=${HEAD}&per_page=100`]: runs,
    '/actions/runs/50': run,
    '/actions/runs/50/attempts/2/jobs?per_page=100': jobs,
  };
  const calls: string[] = [];
  const hook = { beforeRead: (_path: string) => {} };
  const check = ciTestCoverage(
    async (path, abort) => {
      abort.throwIfAborted();
      calls.push(path);
      hook.beforeRead(path);
      if (!(path in data)) throw new Error(`unexpected ${path}`);
      return structuredClone(data[path]);
    },
    async () => RELEASE,
  );
  return { check, calls, data, jobs, runs, run, pr, tree, hook };
}

function jobAt(f: ReturnType<typeof fixture>, index: number) {
  const job = f.jobs.jobs[index];
  if (!job) throw new Error('missing fixture job');
  return job;
}

describe('selfCheck 规范 CI 源码覆盖', () => {
  it('精确同树完整最新 attempt，每台实测 Node 同 minor，补丁差异可覆盖', async () => {
    const f = fixture();
    const covered = await f.check(input, signal());
    expect(covered).toMatchObject({
      head: HEAD,
      tree: TREE,
      pr: 12,
      run: 50,
      attempt: 2,
      contractCommit: RELEASE,
    });
    expect(covered?.checks).toEqual(['check', 'changes', 'test (1/2)', 'test (2/2)']);
    expect(f.calls).toContain('/actions/runs/50/attempts/2/jobs?per_page=100');
    expect(f.calls.filter((s) => s === '/actions/runs/50')).toHaveLength(2);
  });

  it.each(['failure', 'cancelled', null])('最新 run %s 不回看旧绿', async (conclusion) => {
    const f = fixture();
    Object.assign(f.run, { conclusion });
    expect(await f.check(input, signal())).toBeNull();
  });
  it.each(['in_progress', 'queued'])('%s 不算完整', async (status) => {
    const f = fixture();
    Object.assign(f.run, { status });
    expect(await f.check(input, signal())).toBeNull();
  });
  it.each([
    [
      '旧CI缺环境声明',
      (f: ReturnType<typeof fixture>) => {
        jobAt(f, 2).steps = [];
      },
    ],
    [
      '第二台跨minor',
      (f: ReturnType<typeof fixture>) => {
        jobAt(f, 3).steps = [{ name: '已测的环境 node=v22.24.0', conclusion: 'success' }];
      },
    ],
    [
      '环境多声明',
      (f: ReturnType<typeof fixture>) => {
        jobAt(f, 2).steps.push(...jobAt(f, 2).steps);
      },
    ],
    [
      '环境没成功',
      (f: ReturnType<typeof fixture>) => {
        jobAt(f, 2).steps = [{ name: '已测的环境 node=v22.23.3', conclusion: 'skipped' }];
      },
    ],
    [
      '树声明重复',
      (f: ReturnType<typeof fixture>) => {
        jobAt(f, 1).steps.push(...jobAt(f, 1).steps);
      },
    ],
    [
      '非严格旧树声明',
      (f: ReturnType<typeof fixture>) => {
        jobAt(f, 1).steps = [{ name: `已测的树 tree=${TREE} base=${HEAD}`, conclusion: 'success' }];
      },
    ],
    [
      'check同名冒充',
      (f: ReturnType<typeof fixture>) => {
        f.jobs.jobs.push({ ...jobAt(f, 0) });
        f.jobs.total_count++;
      },
    ],
    [
      'test失败',
      (f: ReturnType<typeof fixture>) => {
        jobAt(f, 2).conclusion = 'failure';
      },
    ],
    [
      'jobs分页不全',
      (f: ReturnType<typeof fixture>) => {
        f.jobs.total_count++;
      },
    ],
    [
      'runs分页不全',
      (f: ReturnType<typeof fixture>) => {
        f.runs.total_count++;
      },
    ],
    [
      '多个run歧义',
      (f: ReturnType<typeof fixture>) => {
        f.runs.workflow_runs.push({ id: 51 });
        f.runs.total_count++;
      },
    ],
    [
      '别的workflow',
      (f: ReturnType<typeof fixture>) => {
        f.run.workflow_id = 10;
      },
    ],
    [
      '非PR事件',
      (f: ReturnType<typeof fixture>) => {
        f.run.event = 'workflow_dispatch';
      },
    ],
    [
      '不是这个PR',
      (f: ReturnType<typeof fixture>) => {
        f.run.pull_requests = [{ number: 13 }];
      },
    ],
    [
      'PR已换头',
      (f: ReturnType<typeof fixture>) => {
        f.pr.head.sha = 'e'.repeat(40);
      },
    ],
    [
      'fork来源',
      (f: ReturnType<typeof fixture>) => {
        f.pr.head.repo.full_name = 'other/fleet-dao';
      },
    ],
    [
      '树截断',
      (f: ReturnType<typeof fixture>) => {
        f.tree.truncated = true;
      },
    ],
  ])('%s 回原路', async (_name, change) => {
    const f = fixture();
    change(f);
    expect(await f.check(input, signal())).toBeNull();
  });
  it.each(['.github/workflows/ci.yml', 'pnpm-lock.yaml', 'package.json'])(
    '候选改%s合同不能自证',
    async (path) => {
      const f = fixture();
      const candidate = f.data[`/git/trees/${TREE}?recursive=1`] as typeof f.tree;
      const entry = candidate.tree.find((e) => e.path === path);
      if (!entry) throw new Error('missing fixture');
      entry.sha = 'f'.repeat(40);
      expect(await f.check(input, signal())).toBeNull();
    },
  );
  it('取消不吞成缺证据', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(fixture().check(input, ac.signal)).rejects.toThrow();
  });
  it.each(['attempt', 'new-run', 'head'])('取证途中%s变化不能沿用先前绿', async (kind) => {
    const f = fixture();
    let count = 0;
    const path =
      kind === 'attempt'
        ? '/actions/runs/50'
        : kind === 'head'
          ? '/pulls/12'
          : `/actions/workflows/9/runs?event=pull_request&head_sha=${HEAD}&per_page=100`;
    f.hook.beforeRead = (p) => {
      if (p !== path || ++count !== 2) return;
      if (kind === 'attempt') f.run.run_attempt = 3;
      if (kind === 'head') f.pr.head.sha = 'e'.repeat(40);
      if (kind === 'new-run') {
        f.runs.total_count = 2;
        f.runs.workflow_runs.push({ id: 51 });
      }
    };
    expect(await f.check(input, signal())).toBeNull();
  });
  it('无可信发布来源回原路，不信开发树目录名', async () => {
    expect(await trustedReleaseCommit()).toBeNull();
    const check = ciTestCoverage(
      async () => {
        throw new Error('不该读');
      },
      async () => null,
    );
    expect(await check(input, signal())).toBeNull();
  });
  it('pnpm或Vitest安装版本不匹配回原路', async () => {
    expect(await fixture().check({ ...input, pnpm: '11.28.1' }, signal())).toBeNull();
    expect(await fixture().check({ ...input, vitest: '5.0.0' }, signal())).toBeNull();
  });
  it('工具和选测合同必须保持固定，普通源码由同树完整CI覆盖', () => {
    for (const path of [
      'vitest.config.ts',
      'pnpm-workspace.yaml',
      'packages/core/package.json',
      'packages/conventions/src/test-changed.ts',
      'deploy/france.sh',
    ])
      expect(isCiContractPath(path)).toBe(true);
    expect(isCiContractPath('packages/core/src/dispatch.ts')).toBe(false);
  });
  it('声明来自每台test runner的setup-node实际输出，不借changes机器代称', () => {
    const ci = parse(readFileSync(new URL('../../../../.github/workflows/ci.yml', import.meta.url), 'utf8'));
    const steps = ci.jobs.test.steps as Record<string, unknown>[];
    const node = steps.filter((s) => s.uses === 'actions/setup-node@v4');
    expect(node).toHaveLength(1);
    expect(node[0]?.id).toBe('test-node');
    expect(steps.filter((s) => typeof s.name === 'string' && s.name.startsWith('已测的环境'))).toEqual([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression, intentionally literal.
      { name: '已测的环境 node=${{ steps.test-node.outputs.node-version }}', run: ':' },
    ]);
  });
});
