// close.mjs：收单时先拆目录联接再删工作树。联接指回主检出的依赖目录，跟着删会把主检出删空。
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../skills/mirasim-sessions/scripts/close.mjs', import.meta.url));

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
interface MergeOpts {
  exec: (cmd: string, args: string[]) => ExecResult;
  fetch: (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => Promise<{
    status: number;
    text: () => Promise<string>;
  }>;
  env: NodeJS.ProcessEnv;
  repo: string;
  pr?: string;
  mr?: string;
  slug?: string;
  host?: string;
  project?: string;
}
interface CloseMod {
  closeRun(
    argv: string[],
    io?: {
      log?: (line: string) => void;
      deleteSession?: (key: string) => Promise<{ skipped: boolean; detail: string }>;
    },
  ): Promise<number>;
  performMerge(o: MergeOpts): Promise<{ skipped: boolean; detail: string }>;
  remoteHost(url: string): { host: string; project: string } | null;
  directoryLinks(root: string): string[];
}

const mod = (await import(pathToFileURL(SCRIPT).href)) as CloseMod;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const r = spawnSync(
    'git',
    ['-c', 'user.name=close-test', '-c', 'user.email=close-test@example.com', ...args],
    {
      cwd,
      encoding: 'utf8',
    },
  );
  if (r.status !== 0) throw new Error(`${args.join(' ')}\n${r.stderr || r.stdout}`);
  return r.stdout;
}

/** 主检出 + 已合进 main 的分支工作树。node_modules 被忽略，里面放两份文件。 */
function mergedRepo(): { main: string; wt: string; branch: string } {
  const root = mkdtempSync(join(tmpdir(), 'close-3970-'));
  roots.push(root);
  const main = join(root, 'main');
  const wt = join(root, 'wt');
  mkdirSync(main);
  git(main, ['init', '-b', 'main']);
  writeFileSync(join(main, '.gitignore'), 'node_modules\n');
  writeFileSync(join(main, 'readme.txt'), 'ok\n');
  git(main, ['add', '.gitignore', 'readme.txt']);
  git(main, ['commit', '-m', 'init']);
  const branch = 'local/3970-demo';
  git(main, ['worktree', 'add', '-b', branch, wt]);
  writeFileSync(join(wt, 'change.txt'), 'change\n');
  git(wt, ['add', 'change.txt']);
  git(wt, ['commit', '-m', 'change']);
  git(main, ['merge', '--no-ff', branch, '-m', 'merge']);
  mkdirSync(join(main, 'node_modules'));
  writeFileSync(join(main, 'node_modules', 'keep.txt'), 'keep\n');
  writeFileSync(join(main, 'node_modules', 'also.txt'), 'also\n');
  return { main, wt, branch };
}

function linkModules(main: string, wt: string, kind: 'junction' | 'dir') {
  symlinkSync(join(main, 'node_modules'), join(wt, 'node_modules'), kind);
}

async function runClose(main: string, branch: string): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const code = await mod.closeRun(['--repo', main, '--branch', branch], { log: (line) => lines.push(line) });
  return { code, out: lines.join('\n') };
}

function depCount(main: string): number {
  return readdirSync(join(main, 'node_modules')).length;
}

describe('close.mjs 删工作树不跟着目录联接', () => {
  it.skipIf(process.platform !== 'win32')('Windows 目录联接：主检出依赖还在，项数不变', async () => {
    const { main, wt, branch } = mergedRepo();
    linkModules(main, wt, 'junction');
    expect(depCount(main)).toBe(2);
    const { code, out } = await runClose(main, branch);
    expect(code, out).toBe(0);
    expect(existsSync(wt)).toBe(false);
    expect(readFileSync(join(main, 'node_modules', 'keep.txt'), 'utf8')).toBe('keep\n');
    expect(depCount(main)).toBe(2);
    expect(out).toMatch(/项数未变/);
    expect(out).toMatch(/不适用/);
  });

  it('POSIX 目录软链：主检出依赖还在，项数不变', async () => {
    const { main, wt, branch } = mergedRepo();
    linkModules(main, wt, 'dir');
    expect(mod.directoryLinks(wt)).toHaveLength(1);
    const { code, out } = await runClose(main, branch);
    expect(code, out).toBe(0);
    expect(existsSync(wt)).toBe(false);
    expect(readFileSync(join(main, 'node_modules', 'keep.txt'), 'utf8')).toBe('keep\n');
    expect(depCount(main)).toBe(2);
  });

  it('有未提交改动：不删，联接还在', async () => {
    const { main, wt, branch } = mergedRepo();
    linkModules(main, wt, process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(join(wt, 'dirty.txt'), 'nope\n');
    const { code, out } = await runClose(main, branch);
    expect(code, out).not.toBe(0);
    expect(out).toMatch(/停在：核对/);
    expect(out).toMatch(/未提交/);
    expect(existsSync(wt)).toBe(true);
    expect(existsSync(join(wt, 'node_modules'))).toBe(true);
    expect(depCount(main)).toBe(2);
  });

  it('删工作树失败后重跑：已拆的联接不重做，接着删完，依赖还在', async () => {
    const { main, wt, branch } = mergedRepo();
    linkModules(main, wt, process.platform === 'win32' ? 'junction' : 'dir');
    git(main, ['worktree', 'lock', wt]);
    const first = await runClose(main, branch);
    expect(first.code, first.out).not.toBe(0);
    expect(first.out).toMatch(/停在：删工作树/);
    expect(existsSync(wt)).toBe(true);
    expect(existsSync(join(wt, 'node_modules'))).toBe(false);
    expect(depCount(main)).toBe(2);
    git(main, ['worktree', 'unlock', wt]);
    const second = await runClose(main, branch);
    expect(second.code, second.out).toBe(0);
    expect(second.out).toMatch(/没有目录联接/);
    expect(existsSync(wt)).toBe(false);
    expect(readFileSync(join(main, 'node_modules', 'keep.txt'), 'utf8')).toBe('keep\n');
    expect(depCount(main)).toBe(2);
    expect(git(main, ['branch', '--list', branch]).trim()).toBe('');
  });
});

describe('performMerge 只用仓自己的远端', () => {
  it('GitHub：开着的 PR 用远端里的 owner/repo 去 squash，不写死仓库', async () => {
    const calls: string[] = [];
    const exec = (cmd: string, args: string[]) => {
      calls.push([cmd, ...args].join(' '));
      if (args[1] === 'view') return { code: 0, stdout: '{"state":"OPEN"}', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const result = await mod.performMerge({
      exec,
      fetch: async () => ({ status: 500, text: async () => '' }),
      env: {},
      repo: 'unused',
      pr: '12',
      slug: 'acme/widgets',
    });
    expect(result.skipped).toBe(false);
    expect(
      calls.some(
        (c) => c.includes('pr merge 12') && c.includes('--repo acme/widgets') && c.includes('--squash'),
      ),
    ).toBe(true);
  });

  it('GitLab：请求打到远端主机，令牌不出现在地址里', async () => {
    const urls: string[] = [];
    const fetch = async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
      urls.push(`${init?.method ?? 'GET'} ${url}`);
      expect(url.includes('secret-token')).toBe(false);
      expect(init?.headers?.['PRIVATE-TOKEN']).toBe('secret-token');
      if (init?.method === 'POST') return { status: 200, text: async () => '{"state":"merged"}' };
      return { status: 200, text: async () => '{"state":"opened"}' };
    };
    const result = await mod.performMerge({
      exec: () => ({ code: 1, stdout: '', stderr: '' }),
      fetch,
      env: { GITLAB_TOKEN: 'secret-token' },
      repo: 'unused',
      mr: '9',
      host: 'gitlab.example.test',
      project: 'group/sub/app',
    });
    expect(result.skipped).toBe(false);
    expect(urls[0]).toBe(
      'GET https://gitlab.example.test/api/v4/projects/group%2Fsub%2Fapp/merge_requests/9',
    );
    expect(urls[1]).toMatch(
      /POST https:\/\/gitlab\.example\.test\/api\/v4\/projects\/group%2Fsub%2Fapp\/merge_requests\/9\/merge/,
    );
  });

  it('remoteHost 认远端地址，本地路径不是主机', () => {
    expect(mod.remoteHost('git@gitlab.example.test:group/app.git')).toEqual({
      host: 'gitlab.example.test',
      project: 'group/app',
    });
    expect(mod.remoteHost('https://github.com/acme/widgets.git')).toEqual({
      host: 'github.com',
      project: 'acme/widgets',
    });
    expect(mod.remoteHost('D:/repos/origin.git')).toBeNull();
  });
});
