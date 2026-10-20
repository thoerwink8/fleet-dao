import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitRunner } from '../src/git-runner.ts';
import { ghRunner } from '../src/issue-new.ts';
import { type LocalClaimRequest, work } from '../src/work.ts';
import { buildQueue, type QueueReport } from '../src/work-queue.ts';
import { runChild } from './child.ts';

const child = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (...args: unknown[]) =>
      args[0] === 'git'
        ? (actual.execFile as (...args: unknown[]) => unknown)(...args)
        : child.execFile(...args),
  };
});

type Call = { command: string; args: string[]; env: NodeJS.ProcessEnv };
const dirs: string[] = [];
const calls: Call[] = [];
let reply: (call: Call) => { code: number; stdout: string; stderr: string };
const ok = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });

beforeEach(() => {
  vi.stubEnv('GH_REPO', '');
  vi.stubEnv('GITHUB_REPOSITORY', '');
  calls.length = 0;
  reply = () => ok({});
  child.execFile.mockImplementation((command, args, options, callback) => {
    const call = { command, args, env: options.env } as Call;
    calls.push(call);
    const r = reply(call);
    callback(r.code ? Object.assign(new Error(r.stderr), { code: r.code }) : null, r.stdout, r.stderr);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(origin = 'https://relay.mirasim.ai/v2/gateway/git/github.com/acme/app.git'): string {
  const dir = mkdtempSync(join(tmpdir(), 'gh-relay-'));
  dirs.push(dir);
  for (const args of [
    ['init', '-q'],
    ['remote', 'add', 'origin', origin],
  ]) {
    expect(runChild('git', args, { cwd: dir }).status).toBe(0);
  }
  return dir;
}

describe('ghRunner：relay origin 仍能盘点真实仓库', () => {
  it('repo view 补位置仓名；pr/issue/api 用 GH_REPO，参数保持原值', async () => {
    const gh = ghRunner(repo());
    for (const args of [
      ['repo', 'view', '--json', 'nameWithOwner'],
      ['pr', 'list', '--state', 'open'],
      ['issue', 'list', '--label', '本机做'],
      ['api', 'repos/{owner}/{repo}/issues'],
    ])
      await gh(args);
    expect(calls.map((c) => c.args)).toEqual([
      ['repo', 'view', 'acme/app', '--json', 'nameWithOwner'],
      ['pr', 'list', '--state', 'open'],
      ['issue', 'list', '--label', '本机做'],
      ['api', 'repos/{owner}/{repo}/issues'],
    ]);
    expect(calls.every((c) => c.env.GH_REPO === 'acme/app')).toBe(true);
    expect(process.env.GH_REPO).toBe('');
  });

  it('显式 GH_REPO 优先于 Actions 和 origin；保留显式跨仓参数', async () => {
    vi.stubEnv('GH_REPO', 'other/selected');
    vi.stubEnv('GITHUB_REPOSITORY', 'actions/repo');
    const gh = ghRunner(repo());
    for (const args of [
      ['repo', 'view', '--json', 'nameWithOwner'],
      ['repo', 'view', 'explicit/repo', '--json', 'nameWithOwner'],
      ['repo', 'view', '--json', 'nameWithOwner', 'explicit/repo'],
      ['pr', 'list', '-R', 'explicit/repo'],
      ['api', 'repos/explicit/repo/issues'],
    ])
      await gh(args);
    expect(calls[0]?.args).toEqual(['repo', 'view', 'other/selected', '--json', 'nameWithOwner']);
    expect(calls[1]?.args[2]).toBe('explicit/repo');
    expect(calls[2]?.args.at(-1)).toBe('explicit/repo');
    expect(calls[2]?.args).toHaveLength(5);
    expect(calls[3]?.args).toEqual(['pr', 'list', '-R', 'explicit/repo']);
    expect(calls[4]?.args).toEqual(['api', 'repos/explicit/repo/issues']);
    expect(calls.every((c) => c.env.GH_REPO === 'other/selected')).toBe(true);
  });

  it('Actions 仓名可覆盖非 GitHub origin；repo view 的选项值不当仓名', async () => {
    vi.stubEnv('GITHUB_REPOSITORY', 'actions/repo');
    await ghRunner(repo('https://gitlab.com/acme/app.git'))([
      'repo',
      'view',
      '--branch',
      'main',
      '--json=nameWithOwner',
      '--jq',
      '.nameWithOwner',
      '--web',
    ]);
    expect(calls[0]?.args.slice(0, 3)).toEqual(['repo', 'view', 'actions/repo']);
    expect(calls[0]?.env.GH_REPO).toBe('actions/repo');
  });

  it('认不出仓名时让 gh 报原错误；不猜目录名、不回成功空列表', async () => {
    reply = () => ({ code: 1, stdout: '', stderr: 'no matching GitHub remote' });
    const gh = ghRunner(repo('https://gitlab.com/acme/app.git'));
    expect(await gh(['repo', 'view', '--json', 'nameWithOwner'])).toEqual({
      code: 1,
      stdout: '',
      stderr: 'no matching GitHub remote',
    });
    expect(calls[0]?.args).toEqual(['repo', 'view', '--json', 'nameWithOwner']);
    expect(calls[0]?.env.GH_REPO).toBe('');
  });

  it('队列经真实 runner 和 relay git origin 读到 PR 与租约；PR 读取失败仍使整队列失败', async () => {
    const root = repo();
    expect(
      runChild('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-qm', 'c'], {
        cwd: root,
      }).status,
    ).toBe(0);
    expect(runChild('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: root }).status).toBe(0);
    let failPulls = false;
    reply = ({ args, env }) => {
      if (args[0] === 'repo' && args[1] === 'view' && args[2] === 'acme/app')
        return ok({ nameWithOwner: 'acme/app' });
      if (env.GH_REPO !== 'acme/app') return { code: 1, stdout: '', stderr: 'no matching remote' };
      if (args[0] === 'issue')
        return ok(
          [10, 11].map((number) => ({ number, title: '待办', body: '', labels: [{ name: '本机做' }] })),
        );
      if (args[0] === 'pr')
        return failPulls
          ? { code: 1, stdout: '', stderr: 'GitHub unavailable' }
          : ok([{ number: 20, body: 'Closes #10', headRefName: 'local/10-test' }]);
      return { code: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
    };
    const deps = {
      gh: ghRunner(root),
      git: gitRunner(root),
      readBeats: () => [],
      readLeases: () => [{ repo: 'acme/app', issue: 11, leaseUntil: '2030-01-01T00:00:00Z' }],
      readFranceClaims: async () => [],
      now: () => new Date('2026-10-18T00:00:00Z'),
    };
    const result = await buildQueue(deps);
    expect(result.problems).toEqual([]);
    expect(result.items.map((i) => [i.issue, i.state, i.pr])).toEqual([
      [10, 'working', 20],
      [11, 'working', null],
    ]);
    expect(result.items[1]?.claimers[0]?.kind).toBe('lease');
    failPulls = true;
    await expect(buildQueue(deps)).rejects.toThrow(/开着的 PR没读成.*GitHub unavailable/);
  });
});

const TARGET = 'thoerwink8/fleet-dao';
const RELAY = 'https://relay.mirasim.ai/v2/gateway/git/github.com/acme/app.git';

describe('work 真装配：显式目标仓走 ghRunner，租约和前置读全，登记仍走原来的口', () => {
  const leaseBody = { ok: true, leaseUntil: '2030-01-01T00:00:00.000Z' };
  const issues = [
    { number: 10, title: '等前置', body: '前置：#81', labels: [{ name: '本机做' }] },
    { number: 11, title: '有租约', body: '', labels: [{ name: '本机做' }] },
    { number: 12, title: '可接', body: '', labels: [{ name: '本机做' }] },
  ];

  function withMain(origin = RELAY): string {
    const root = repo(origin);
    expect(
      runChild('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-qm', 'c'], {
        cwd: root,
      }).status,
    ).toBe(0);
    expect(runChild('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: root }).status).toBe(0);
    return root;
  }

  async function runWork(root: string, argv: string[], leases = true) {
    const sent: LocalClaimRequest[] = [];
    const out: string[] = [];
    const err: string[] = [];
    const code = await work(argv, {
      gh: ghRunner(root),
      env: process.env,
      root,
      post: async (body) => {
        sent.push(body);
        return { status: 200, text: JSON.stringify(leaseBody) };
      },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      ...(argv[0] === 'queue'
        ? {
            queue: {
              git: gitRunner(root),
              readBeats: () => [],
              readFranceClaims: async () => [],
              readLeases: () =>
                leases
                  ? [
                      { repo: 'acme/app', issue: 12, leaseUntil: '2030-01-01T00:00:00.000Z' },
                      { repo: TARGET, issue: 11, leaseUntil: '2030-01-01T00:00:00.000Z' },
                    ]
                  : [],
              now: () => new Date('2026-10-18T00:00:00.000Z'),
              env: process.env,
              root,
            },
          }
        : {}),
    });
    return { code, sent, out, err, text: () => [...out, ...err].join('\n') };
  }

  it('relay origin + 显式目标仓：queue 读全租约和前置，claim/renew 登记这个仓，已有 PR 不重复领', async () => {
    vi.stubEnv('GH_REPO', TARGET);
    const root = withMain();
    let pulls: unknown[] = [];
    reply = ({ args, env }) => {
      if (env.GH_REPO !== TARGET) return { code: 1, stdout: '', stderr: 'GH_REPO 被换成了别的仓' };
      if (args[0] === 'repo' && args[1] === 'view') {
        const want = `repo view ${TARGET} --json nameWithOwner`;
        if (args.join(' ') !== want)
          return { code: 1, stdout: '', stderr: `repo view 参数不对：${args.join(' ')}` };
        return ok({ nameWithOwner: TARGET });
      }
      if (args[0] === 'issue' && args[1] === 'list') return ok(issues);
      if (args[0] === 'issue' && args[1] === 'view') return ok({ title: 'Add captcha', state: 'OPEN' });
      if (args[0] === 'pr') return ok(pulls);
      if (args[0] === 'issue' && args[1] === 'edit') return { code: 0, stdout: '', stderr: '' };
      if (args[0] === 'api' && args[1] === 'graphql') {
        const q = args.find((a) => a.startsWith('query=')) ?? '';
        if (!q.includes(`"${TARGET.split('/')[0]}"`) || !q.includes(`"${TARGET.split('/')[1]}"`)) {
          return { code: 1, stdout: '', stderr: `前置问错了仓：${q}` };
        }
        return ok({ data: { repository: { n81: { state: 'OPEN' } } } });
      }
      return { code: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
    };

    const queue = await runWork(root, ['queue', '--json']);
    expect(queue.code).toBe(0);
    const report = JSON.parse(queue.out.join('')) as QueueReport;
    expect(report.problems).toEqual([]);
    const by = new Map(report.items.map((i) => [i.issue, i]));
    expect(by.get(10)).toMatchObject({ state: 'blocked', takeable: false, blockedBy: [81] });
    expect(by.get(10)?.why).toContain('还开着');
    expect(by.get(11)?.state).toBe('working');
    expect(by.get(11)?.claimers[0]).toMatchObject({ kind: 'lease' });
    expect(by.get(12)).toMatchObject({ state: 'takeable', takeable: true, claimers: [] });

    const claim = await runWork(root, ['claim', '42'], false);
    expect(claim.code).toBe(0);
    expect(claim.sent).toEqual([{ action: 'claim', repo: TARGET, issue: 42, title: 'Add captcha' }]);
    const renew = await runWork(root, ['renew', '42'], false);
    expect(renew.code).toBe(0);
    expect(renew.sent).toEqual([{ action: 'renew', repo: TARGET, issue: 42 }]);

    pulls = [{ number: 77, body: '', headRefName: 'fleet/42-tabcdef12' }];
    const again = await runWork(root, ['claim', '42'], false);
    expect(again.code).toBe(1);
    expect(again.sent).toEqual([]);
    expect(again.text()).toContain('#77');
  });

  it('正常 github origin、没有显式目标仓：仍认 origin，登记这个仓', async () => {
    vi.stubEnv('GH_REPO', '');
    const root = repo('https://github.com/acme/app.git');
    reply = ({ args, env }) => {
      if (args[0] === 'repo' && args[1] === 'view') {
        const want = 'repo view acme/app --json nameWithOwner';
        if (args.join(' ') !== want || env.GH_REPO !== 'acme/app') {
          return {
            code: 1,
            stdout: '',
            stderr: `识仓参数不对：${args.join(' ')} GH_REPO=${env.GH_REPO ?? ''}`,
          };
        }
        return ok({ nameWithOwner: 'acme/app' });
      }
      if (args[0] === 'issue' && args[1] === 'view') return ok({ title: 'T', state: 'OPEN' });
      if (args[0] === 'pr') return ok([]);
      if (args[0] === 'issue' && args[1] === 'edit') return { code: 0, stdout: '', stderr: '' };
      return { code: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
    };
    const claim = await runWork(root, ['claim', '7'], false);
    expect(claim.code).toBe(0);
    expect(claim.sent).toEqual([{ action: 'claim', repo: 'acme/app', issue: 7, title: 'T' }]);
  });

  it('【故意造出的失败】非法目标仓、回了另一个仓、GitHub 没读成：不登记，队列不当成可接', async () => {
    const standard = repo('https://github.com/acme/app.git');
    vi.stubEnv('GH_REPO', 'not a repo');
    reply = () => ok({ nameWithOwner: 'acme/app' });
    const illegal = await runWork(standard, ['claim', '42'], false);
    expect(illegal.code).toBe(1);
    expect(illegal.sent).toEqual([]);
    expect(illegal.text()).toContain('不是 owner/name');
    expect(calls).toEqual([]);

    vi.stubEnv('GH_REPO', TARGET);
    const root = withMain();
    reply = ({ args }) => {
      if (args[0] === 'repo') return ok({ nameWithOwner: 'acme/app' });
      return { code: 1, stdout: '', stderr: '不该继续问' };
    };
    const clash = await runWork(root, ['renew', '42'], false);
    expect(clash.code).toBe(1);
    expect(clash.sent).toEqual([]);
    expect(clash.text()).toContain('不改记到回的那个仓');
    expect(clash.text()).not.toContain('登记');

    reply = ({ args }) => {
      if (args[0] === 'repo') return { code: 1, stdout: '', stderr: 'HTTP 502' };
      if (args[0] === 'issue' && args[1] === 'list') return ok(issues);
      if (args[0] === 'pr') return ok([]);
      return { code: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
    };
    const queue = await runWork(root, ['queue', '--json']);
    expect(queue.code).toBe(0);
    const report = JSON.parse(queue.out.join('')) as QueueReport;
    expect(report.problems.join('\n')).toContain('没读成');
    expect(report.items.every((i) => i.takeable === false)).toBe(true);
    expect(report.items.find((i) => i.issue === 10)?.why).toContain('没查成');
    expect(report.items.find((i) => i.issue === 12)?.why).toContain('不当成没有');
    const claim = await runWork(root, ['claim', '42'], false);
    expect(claim.code).toBe(1);
    expect(claim.sent).toEqual([]);
    expect(claim.text()).toContain('没读成');
  });
});
