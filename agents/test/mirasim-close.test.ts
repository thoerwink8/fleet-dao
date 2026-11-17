// close.mjs：收单时先拆目录联接再删工作树。联接指回主检出的依赖目录，跟着删会把主检出删空。
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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runChild, runChildOk } from './child.ts';

vi.setConfig({ testTimeout: 20_000 });
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
      exec?: (cmd: string, args: string[]) => ExecResult;
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
  return runChildOk(
    'git',
    ['-c', 'user.name=close-test', '-c', 'user.email=close-test@example.com', ...args],
    { cwd },
  );
}
/** close.mjs 自己调的 git：参数里已带 -C，这里只补提交身份。 */
function realGit(cmd: string, args: string[]): ExecResult {
  const r = runChild(
    cmd,
    cmd === 'git' ? ['-c', 'user.name=close-test', '-c', 'user.email=close-test@example.com', ...args] : args,
  );
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
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

describe('工作树落在主检出里时，不把工作树自己的目录算进依赖项数', () => {
  /** 工作树在主检出的 .claude/worktrees 下。packages/adapters 有 6 项，主检出 node_modules 有 2 项。 */
  function nestedRepo(): { main: string; wt: string; branch: string } {
    const root = mkdtempSync(join(tmpdir(), 'close-4079-'));
    roots.push(root);
    const main = join(root, 'main');
    const wt = join(main, '.claude', 'worktrees', 'demo');
    mkdirSync(main);
    git(main, ['init', '-b', 'main']);
    writeFileSync(join(main, '.gitignore'), 'node_modules\n');
    mkdirSync(join(main, 'packages', 'adapters'), { recursive: true });
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) {
      writeFileSync(join(main, 'packages', 'adapters', `${name}.txt`), `${name}\n`);
    }
    writeFileSync(join(main, 'readme.txt'), 'ok\n');
    git(main, ['add', '.gitignore', 'readme.txt', 'packages']);
    git(main, ['commit', '-m', 'init']);
    const branch = 'local/4079-demo';
    mkdirSync(join(main, '.claude', 'worktrees'), { recursive: true });
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

  /** 一个联接指回工作树自己的 packages/adapters，一个指回主检出的 node_modules。 */
  function linkOwnAndMain(main: string, wt: string) {
    const kind = process.platform === 'win32' ? 'junction' : 'dir';
    const nm = join(wt, 'node_modules');
    mkdirSync(join(nm, '@local'), { recursive: true });
    symlinkSync(join(wt, 'packages', 'adapters'), join(nm, '@local', 'adapters'), kind);
    symlinkSync(join(main, 'node_modules'), join(nm, '.main-deps'), kind);
  }

  it('指向自己的联接和指向主检出的联接：删完不报项数变了', async () => {
    const { main, wt, branch } = nestedRepo();
    linkOwnAndMain(main, wt);
    const { code, out } = await runClose(main, branch);
    expect(code, out).toBe(0);
    expect(out).not.toMatch(/项数变了/);
    expect(out).toMatch(/项数未变/);
    expect(existsSync(wt)).toBe(false);
    expect(depCount(main)).toBe(2);
    expect(readFileSync(join(main, 'node_modules', 'keep.txt'), 'utf8')).toBe('keep\n');
    expect(git(main, ['branch', '--list', branch]).trim()).toBe('');
  });

  it('主检出依赖真被删空时照样报，不继续删分支', async () => {
    const { main, wt, branch } = nestedRepo();
    linkOwnAndMain(main, wt);
    const lines: string[] = [];
    const code = await mod.closeRun(['--repo', main, '--branch', branch], {
      log: (line) => lines.push(line),
      exec: (cmd, args) => {
        const result = realGit(cmd, args);
        const removing = cmd === 'git' && args.at(-3) === 'worktree' && args.at(-2) === 'remove';
        if (removing && result.code === 0)
          rmSync(join(main, 'node_modules'), { recursive: true, force: true });
        return result;
      },
    });
    const out = lines.join('\n');
    expect(code, out).not.toBe(0);
    expect(out).toMatch(/停在：删工作树/);
    expect(out).toMatch(/项数变了/);
    expect(out).toMatch(/node_modules 删除前 2，删除后 目录没了/);
    expect(out).not.toMatch(/packages[\\/]adapters/);
    expect(git(main, ['branch', '--list', branch]).trim()).toContain(branch);
  });
});

describe('推其余远端时跳过推不出去的', () => {
  /** 另加一个本地远端当「其余远端」。origin 仍是快进来源，这个不该挡住后面的删除。 */
  function withOther(pushUrl: string): { main: string; wt: string; branch: string } {
    const repo = mergedRepo();
    const bare = join(repo.main, '..', 'other.git');
    git(repo.main, ['init', '--bare', bare]);
    git(repo.main, ['remote', 'add', 'origin', bare]);
    git(repo.main, ['push', '-u', 'origin', 'main']);
    git(repo.main, ['remote', 'set-head', 'origin', 'main']);
    git(repo.main, ['remote', 'add', 'upstream', bare]);
    git(repo.main, ['remote', 'set-url', '--push', 'upstream', pushUrl]);
    return repo;
  }

  it('推送地址是 DISABLED：跳过并写明，工作树和分支照样删', async () => {
    const { main, wt, branch } = withOther('DISABLED');
    const { code, out } = await runClose(main, branch);
    expect(code, out).toBe(0);
    expect(out).toMatch(/跳过 upstream：推送地址是 DISABLED/);
    expect(out).not.toMatch(/停在：/);
    expect(existsSync(wt)).toBe(false);
    expect(git(main, ['branch', '--list', branch]).trim()).toBe('');
    expect(depCount(main)).toBe(2);
  });

  it('git remote get-url --push 失败：跳过并写明，工作树照样删', async () => {
    const { main, wt, branch } = withOther('DISABLED');
    const lines: string[] = [];
    const code = await mod.closeRun(['--repo', main, '--branch', branch], {
      log: (line) => lines.push(line),
      exec: (cmd, args) => {
        if (cmd === 'git' && args.includes('--push') && args.at(-1) === 'upstream') {
          return { code: 1, stdout: '', stderr: "error: No such remote 'upstream'" };
        }
        return realGit(cmd, args);
      },
    });
    const out = lines.join('\n');
    expect(code, out).toBe(0);
    expect(out).toMatch(/跳过 upstream：读推送地址没成/);
    expect(existsSync(wt)).toBe(false);
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

describe('历史无共同祖先时快进失败仍继续收', () => {
  it('报告主检出没快进，工作树和分支仍删，会话仍收，退出码 0', async () => {
    const { main, wt, branch } = mergedRepo();
    const bare = join(main, '..', 'unrelated.git');
    const seed = join(main, '..', 'seed');
    mkdirSync(seed);
    git(seed, ['init', '-b', 'main']);
    writeFileSync(join(seed, 'other.txt'), 'other\n');
    git(seed, ['add', 'other.txt']);
    git(seed, ['commit', '-m', 'other']);
    git(seed, ['init', '--bare', bare]);
    git(seed, ['remote', 'add', 'origin', bare]);
    git(seed, ['push', 'origin', 'main']);
    git(main, ['remote', 'add', 'origin', bare]);
    git(main, ['fetch', 'origin', 'main']);
    git(main, ['remote', 'set-head', 'origin', 'main']);
    const head = git(main, ['rev-parse', 'HEAD']);
    const dropped: string[] = [];
    const lines: string[] = [];
    const code = await mod.closeRun(
      ['--repo', main, '--branch', branch, '--pr', '7', '--session', 'kimi:abc'],
      {
        log: (line) => lines.push(line),
        deleteSession: async (key) => {
          dropped.push(key);
          return { skipped: false, detail: `已删会话 ${key}` };
        },
        exec: (cmd, args) => {
          if (cmd === 'gh') return { code: 0, stdout: '{"state":"MERGED"}', stderr: '' };
          if (cmd === 'git' && args.includes('fetch')) return { code: 0, stdout: '', stderr: '' };
          if (cmd === 'git' && args.includes('get-url') && args.at(-1) === 'origin') {
            return { code: 0, stdout: 'https://github.com/acme/widgets.git\n', stderr: '' };
          }
          return realGit(cmd, args);
        },
      },
    );
    const out = lines.join('\n');
    expect(code, out).toBe(0);
    expect(out).toContain('主检出没快进：历史无共同祖先');
    expect(out).not.toMatch(/停在：/);
    expect(existsSync(wt)).toBe(false);
    expect(git(main, ['branch', '--list', branch]).trim()).toBe('');
    expect(git(main, ['rev-parse', 'HEAD'])).toBe(head);
    expect(dropped).toEqual(['kimi:abc']);
    expect(out).toContain('已删会话 kimi:abc');
  });
});

describe('git 登记消失不能当成目录已删', () => {
  function conventionalRepo(merged: boolean): { main: string; wt: string; branch: string } {
    const root = mkdtempSync(join(tmpdir(), 'close-4099-'));
    roots.push(root);
    const main = join(root, 'main');
    const branch = 'local/demo';
    const wt = join(main, '.claude', 'worktrees', 'demo');
    mkdirSync(main);
    git(main, ['init', '-b', 'main']);
    writeFileSync(join(main, '.gitignore'), 'node_modules\n');
    writeFileSync(join(main, 'readme.txt'), 'ok\n');
    git(main, ['add', '.gitignore', 'readme.txt']);
    git(main, ['commit', '-m', 'init']);
    mkdirSync(join(main, '.claude', 'worktrees'), { recursive: true });
    git(main, ['worktree', 'add', '-b', branch, wt]);
    writeFileSync(join(wt, 'change.txt'), 'change\n');
    git(wt, ['add', 'change.txt']);
    git(wt, ['commit', '-m', 'change']);
    if (merged) git(main, ['merge', '--no-ff', branch, '-m', 'merge']);
    mkdirSync(join(main, 'node_modules'));
    writeFileSync(join(main, 'node_modules', 'keep.txt'), 'keep\n');
    return { main, wt, branch };
  }

  function dropAdmin(wt: string): void {
    const gitdir = git(wt, ['rev-parse', '--path-format=absolute', '--git-dir']).trim();
    rmSync(gitdir, { recursive: true, force: true });
  }

  it('git worktree remove 退出码 0 但目录还在：失败，不删分支、不删会话', async () => {
    const { main, wt, branch } = mergedRepo();
    let dropped = false;
    const lines: string[] = [];
    const code = await mod.closeRun(['--repo', main, '--branch', branch, '--session', 'kimi:abc'], {
      log: (line) => lines.push(line),
      deleteSession: async () => {
        dropped = true;
        return { skipped: false, detail: '不该删' };
      },
      exec: (cmd, args) => {
        if (cmd === 'git' && args.includes('worktree') && args.includes('remove')) {
          return { code: 0, stdout: '', stderr: '' };
        }
        return realGit(cmd, args);
      },
    });
    const out = lines.join('\n');
    expect(code, out).not.toBe(0);
    expect(out).toMatch(/停在：删工作树/);
    expect(out).toContain(wt);
    expect(existsSync(wt)).toBe(true);
    expect(existsSync(join(main, 'readme.txt'))).toBe(true);
    expect(git(main, ['branch', '--list', branch]).trim()).toContain(branch);
    expect(dropped).toBe(false);
  });

  it('登记没了、分支已在默认分支、目录对得上：拆联接后删掉，主检出还在', async () => {
    const { main, wt, branch } = conventionalRepo(true);
    linkModules(main, wt, process.platform === 'win32' ? 'junction' : 'dir');
    dropAdmin(wt);
    expect(git(main, ['worktree', 'list'])).not.toContain(wt);
    const dropped: string[] = [];
    const lines: string[] = [];
    const code = await mod.closeRun(['--repo', main, '--branch', branch, '--session', 'kimi:on-main'], {
      log: (line) => lines.push(line),
      deleteSession: async (key) => {
        dropped.push(key);
        return { skipped: false, detail: `已删会话 ${key}` };
      },
    });
    const out = lines.join('\n');
    expect(code, out).toBe(0);
    expect(existsSync(wt)).toBe(false);
    expect(readFileSync(join(main, 'node_modules', 'keep.txt'), 'utf8')).toBe('keep\n');
    expect(readFileSync(join(main, 'readme.txt'), 'utf8')).toBe('ok\n');
    expect(git(main, ['branch', '--list', branch]).trim()).toBe('');
    expect(dropped).toEqual(['kimi:on-main']);
  });

  it('登记没了但仍有未提交文件：不删', async () => {
    const { main, wt, branch } = conventionalRepo(true);
    writeFileSync(join(wt, 'dirty.txt'), 'x\n');
    dropAdmin(wt);
    const { code, out } = await runClose(main, branch);
    expect(code, out).not.toBe(0);
    expect(out).toMatch(/未提交/);
    expect(existsSync(join(wt, 'dirty.txt'))).toBe(true);
    expect(existsSync(join(main, 'readme.txt'))).toBe(true);
  });

  it('登记没了且分支还不在默认分支：不删目录', async () => {
    const { main, wt, branch } = conventionalRepo(false);
    dropAdmin(wt);
    const { code, out } = await runClose(main, branch);
    expect(code, out).not.toBe(0);
    expect(out).toMatch(/停在：合并/);
    expect(existsSync(join(wt, 'change.txt'))).toBe(true);
  });

  it('分支已删的空目录残留：只删那个目录，主检出还在', async () => {
    const { main } = conventionalRepo(true);
    const empty = join(main, '.claude', 'worktrees', 'gone');
    mkdirSync(empty);
    const { code, out } = await runClose(main, 'local/gone');
    expect(code, out).toBe(0);
    expect(existsSync(empty)).toBe(false);
    expect(readFileSync(join(main, 'readme.txt'), 'utf8')).toBe('ok\n');
    expect(existsSync(join(main, '.claude', 'worktrees', 'demo'))).toBe(true);
  });

  it('分支已删但目录里还有文件：不删', async () => {
    const { main } = conventionalRepo(true);
    const kept = join(main, '.claude', 'worktrees', 'kept');
    mkdirSync(kept);
    writeFileSync(join(kept, 'note.txt'), 'keep\n');
    const { code, out } = await runClose(main, 'local/kept');
    expect(code, out).not.toBe(0);
    expect(out).toContain(kept);
    expect(readFileSync(join(kept, 'note.txt'), 'utf8')).toBe('keep\n');
    expect(readFileSync(join(main, 'readme.txt'), 'utf8')).toBe('ok\n');
  });

  it('工作树根是指向主检出的联接：不删主检出', async () => {
    const { main } = conventionalRepo(true);
    const link = join(main, '.claude', 'worktrees', 'loop');
    symlinkSync(main, link, process.platform === 'win32' ? 'junction' : 'dir');
    const { out } = await runClose(main, 'local/loop');
    expect(existsSync(join(main, 'readme.txt')), out).toBe(true);
    expect(existsSync(link), out).toBe(true);
    expect(out).not.toContain('已删');
  });
});
