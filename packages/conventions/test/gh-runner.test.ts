import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitRunner } from '../src/git-runner.ts';
import { ghRunner } from '../src/issue-new.ts';
import { buildQueue } from '../src/work-queue.ts';
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
