// close.mjs：收单时先拆目录联接再删工作树。联接指回主检出的依赖目录，跟着删会把主检出删空。
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
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
interface SessionRow {
  sessionKey: string;
  runState: string;
  workdir: string;
  title?: string;
  source?: 'managed' | 'native';
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
      sessionRow?: (key: string) => Promise<SessionRow | null>;
      deleteSession?: (key: string, row?: SessionRow) => Promise<{ skipped: boolean; detail: string }>;
    },
  ): Promise<number>;
  getSessionRow(
    env: NodeJS.ProcessEnv,
    exec: (cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => ExecResult,
    key: string,
  ): Promise<SessionRow | null>;
  deleteSession(
    env: NodeJS.ProcessEnv,
    exec: (cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => ExecResult,
    key: string,
    row?: SessionRow,
  ): Promise<{ skipped: boolean; detail: string }>;
  performMerge(o: MergeOpts): Promise<{ skipped: boolean; detail: string }>;
  remoteHost(url: string): { host: string; project: string } | null;
  directoryLinks(root: string): string[];
  conventionalWorktreePath(main: string, branch: string): string | null;
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
function sessionRow(sessionKey: string, workdir: string, runState = 'completed'): SessionRow {
  return { sessionKey, workdir, runState, source: 'managed', title: 'test' };
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
function sessionEnv(): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), 'close-protocol-'));
  roots.push(home);
  const app = join(home, '.mirasim', 'app');
  mkdirSync(join(app, 'test-version'), { recursive: true });
  writeFileSync(join(app, 'state.json'), JSON.stringify({ good: 'test-version' }));
  writeFileSync(join(app, 'test-version', 'server.cjs'), '');
  return { USERPROFILE: home, MIRASIM_HOST_PORT: '4970' };
}

function sessionFrame(sessionKey: string, row: unknown): string {
  return JSON.stringify({
    ok: true,
    atom: 'getSessionRow',
    frames: [{ type: 'sessionRow', reqId: `close-${sessionKey}`, sessionKey, row }],
  });
}

describe('getSessionRow accepts only the official successful frame', () => {
  const key = 'kimi:protocol-test';
  const session = { sessionKey: key, workdir: 'D:/repo/task', runState: 'completed' };
  const query = (stdout: string, code = 0) =>
    mod.getSessionRow(sessionEnv(), () => ({ code, stdout, stderr: '' }), key);

  it.each(['"bad"', '42', 'null', '{"ok":false,"atom":"getSessionRow","frames":[]}'])(
    'rejects malformed or failed response %s',
    async (stdout) => {
      await expect(query(stdout)).rejects.toThrow();
    },
  );

  it('rejects a malformed row instead of treating it as missing', async () => {
    for (const row of ['"bad"', '42', 'false', '[]']) {
      await expect(query(sessionFrame(key, JSON.parse(row)))).rejects.toThrow(/row/);
    }
  });

  it('requires one identity-matching sessionRow frame', async () => {
    await expect(query(JSON.stringify({ ok: true, atom: 'getSessionRow', frames: [] }))).rejects.toThrow();
    await expect(query(sessionFrame('kimi:other', session))).rejects.toThrow(/格式或身份/);
    const duplicate = JSON.parse(sessionFrame(key, session));
    duplicate.frames.push(duplicate.frames[0]);
    await expect(query(JSON.stringify(duplicate))).rejects.toThrow(/唯一/);
  });

  it('accepts only protocol null as missing and an object as present', async () => {
    await expect(query(sessionFrame(key, null))).resolves.toBeNull();
    await expect(query(sessionFrame(key, session))).resolves.toEqual(session);
  });

  it('rejects a failed atom process', async () => {
    await expect(query(sessionFrame(key, session), 1)).rejects.toThrow(/退出码 1/);
  });

  it('rejects failed envelopes even when they contain a plausible missing row', async () => {
    const response = JSON.parse(sessionFrame(key, null));
    response.ok = false;
    await expect(query(JSON.stringify(response))).rejects.toThrow();
  });

  it('rejects missing fields, failed frames and incomplete session objects', async () => {
    const valid = JSON.parse(sessionFrame(key, null));
    const frame = valid.frames[0];
    for (const response of [
      { ...valid, atom: 'listSessions' },
      { ...valid, frames: [null] },
      { ...valid, frames: [{ ...frame, row: undefined }] },
      { ...valid, frames: [{ ...frame, reqId: undefined }] },
      { ...valid, frames: [{ ...frame, ok: false }] },
      { ...valid, frames: [{ ...frame, type: 'error' }] },
    ]) {
      await expect(query(JSON.stringify(response))).rejects.toThrow();
    }
    for (const row of [
      {},
      { ...session, sessionKey: 'kimi:other' },
      { ...session, workdir: '' },
      { ...session, runState: null },
    ]) {
      await expect(query(sessionFrame(key, row))).rejects.toThrow();
    }
  });
});

describe('deleteSession 使用官方入口且不删除工作树', () => {
  it('只传目标会话、身份和 removeWorktree:false', async () => {
    const home = mkdtempSync(join(tmpdir(), 'close-session-'));
    roots.push(home);
    const version = 'test-version';
    const app = join(home, '.mirasim', 'app');
    mkdirSync(join(app, version), { recursive: true });
    writeFileSync(join(app, 'state.json'), JSON.stringify({ good: version }));
    writeFileSync(join(app, version, 'server.cjs'), '');

    let called = false;
    const result = await mod.deleteSession(
      { USERPROFILE: home, MIRASIM_HOST_PORT: '4970' },
      (cmd, args) => {
        called = true;
        expect(cmd).toBe(process.execPath);
        expect(args).toEqual([
          join(app, version, 'server.cjs'),
          'ui-cli',
          '--port',
          '4970',
          'call',
          'deleteSession',
          '--args',
          JSON.stringify({
            sessionKey: 'kimi:target',
            removeWorktree: false,
            title: 'test',
            source: 'managed',
          }),
        ]);
        return { code: 0, stdout: '{"ok":true}', stderr: '' };
      },
      'kimi:target',
      sessionRow('kimi:target', 'D:/repo/.claude/worktrees/task'),
    );
    expect(called).toBe(true);
    expect(result).toEqual({ skipped: false, detail: '已删会话 kimi:target' });
  });
});

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
        sessionRow: async () => sessionRow('kimi:abc', wt),
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
describe('会话释放先于工作树删除', () => {
  it('running 会话拒绝删除工作树、分支和会话', async () => {
    const { main, wt, branch } = mergedRepo();
    let dropped = false;
    const lines: string[] = [];
    const code = await mod.closeRun(['--repo', main, '--branch', branch, '--session', 'kimi:running'], {
      log: (line) => lines.push(line),
      sessionRow: async () => sessionRow('kimi:running', wt, 'running'),
      deleteSession: async () => {
        dropped = true;
        return { skipped: false, detail: '不该删' };
      },
    });
    const out = lines.join('\n');
    expect(code, out).not.toBe(0);
    expect(out).toMatch(/目标会话 kimi:running 还在运行/);
    expect(existsSync(wt)).toBe(true);
    expect(git(main, ['branch', '--list', branch]).trim()).toContain(branch);
    expect(dropped).toBe(false);
  });

  it('释放失败时不删除工作树和分支', async () => {
    const { main, wt, branch } = mergedRepo();
    const lines: string[] = [];
    const code = await mod.closeRun(['--repo', main, '--branch', branch, '--session', 'kimi:failed'], {
      log: (line) => lines.push(line),
      sessionRow: async () => sessionRow('kimi:failed', wt),
      deleteSession: async () => {
        throw new Error('session release failed');
      },
    });
    const out = lines.join('\n');
    expect(code, out).not.toBe(0);
    expect(out).toContain('释放会话 kimi:failed 没成');
    expect(existsSync(wt)).toBe(true);
    expect(git(main, ['branch', '--list', branch]).trim()).toContain(branch);
  });

  it.each(['completed', 'incomplete'])('已结束的 %s 会话没有 archived 字段也能释放', async (state) => {
    const { main, wt, branch } = mergedRepo();
    const drop = vi.fn(async () => ({ skipped: false, detail: '已释放目标会话' }));
    const lines: string[] = [];
    const code = await mod.closeRun(['--repo', main, '--branch', branch, '--session', 'kimi:ended'], {
      log: (line) => lines.push(line),
      sessionRow: async () => sessionRow('kimi:ended', wt, state),
      deleteSession: drop,
    });
    expect(code, lines.join('\n')).toBe(0);
    expect(drop).toHaveBeenCalledOnce();
    expect(existsSync(wt)).toBe(false);
    expect(git(main, ['branch', '--list', branch]).trim()).toBe('');
  });

  it.each([1, 2])('第 %i 次读取都拒绝未知状态且保留树和分支', async (badRead) => {
    const { main, wt, branch } = mergedRepo();
    let reads = 0;
    const drop = vi.fn(async () => ({ skipped: false, detail: '不该删' }));
    const lines: string[] = [];
    const code = await mod.closeRun(['--repo', main, '--branch', branch, '--session', 'kimi:unknown'], {
      log: (line) => lines.push(line),
      sessionRow: async () =>
        sessionRow('kimi:unknown', wt, ++reads === badRead ? 'future-state' : 'completed'),
      deleteSession: drop,
    });
    expect(code, lines.join('\n')).toBe(1);
    expect(lines.join('\n')).toContain('状态未知');
    expect(drop).not.toHaveBeenCalled();
    expect(existsSync(wt)).toBe(true);
    expect(git(main, ['branch', '--list', branch]).trim()).toContain(branch);
  });

  it.each(['running', 'identity', 'workdir'])('删除前复查拒绝变化的 %s', async (change) => {
    const { main, wt, branch } = mergedRepo();
    let reads = 0;
    const drop = vi.fn(async () => ({ skipped: false, detail: '不该删' }));
    const code = await mod.closeRun(['--repo', main, '--branch', branch, '--session', 'kimi:changed'], {
      log: () => {},
      sessionRow: async () => {
        const row = sessionRow('kimi:changed', wt);
        if (++reads === 2) {
          if (change === 'running') row.runState = 'running';
          if (change === 'identity') row.sessionKey = 'kimi:other';
          if (change === 'workdir') row.workdir = main;
        }
        return row;
      },
      deleteSession: drop,
    });
    expect(code).toBe(1);
    expect(drop).not.toHaveBeenCalled();
    expect(existsSync(wt)).toBe(true);
    expect(git(main, ['branch', '--list', branch]).trim()).toContain(branch);
  });

  it.each([1, 2])('第 %i 次查询协议失败都停止删除', async (badRead) => {
    const { main, wt, branch } = mergedRepo();
    let reads = 0;
    const env = sessionEnv();
    const drop = vi.fn(async () => ({ skipped: false, detail: '不该删' }));
    const code = await mod.closeRun(['--repo', main, '--branch', branch, '--session', 'kimi:bad-frame'], {
      log: () => {},
      sessionRow: async (key) =>
        mod.getSessionRow(
          env,
          () => ({
            code: 0,
            stdout:
              ++reads === badRead
                ? '{"ok":false,"frames":[{"row":null}]}'
                : sessionFrame(key, sessionRow(key, wt)),
            stderr: '',
          }),
          key,
        ),
      deleteSession: drop,
    });
    expect(code).toBe(1);
    expect(drop).not.toHaveBeenCalled();
    expect(existsSync(wt)).toBe(true);
    expect(git(main, ['branch', '--list', branch]).trim()).toContain(branch);
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

  it('工作树删除失败后重跑：已删除会话不再查询，接着清理工作树和分支', async () => {
    const { main, wt, branch } = mergedRepo();
    let dropped = false;
    let firstRemove = true;
    const lines: string[] = [];
    const argv = ['--repo', main, '--branch', branch, '--session', 'kimi:abc'];
    const first = await mod.closeRun(argv, {
      log: (line) => lines.push(line),
      sessionRow: async () => (dropped ? null : sessionRow('kimi:abc', wt)),
      deleteSession: async () => {
        dropped = true;
        return { skipped: false, detail: '已删会话 kimi:abc' };
      },
      exec: (cmd, args) => {
        if (cmd === 'git' && args.includes('worktree') && args.includes('remove') && firstRemove) {
          firstRemove = false;
          return { code: 0, stdout: '', stderr: '' };
        }
        return realGit(cmd, args);
      },
    });
    const firstOut = lines.join('\n');
    expect(first, firstOut).not.toBe(0);
    expect(firstOut).toMatch(/停在：删工作树/);
    expect(firstOut).toContain('已删会话 kimi:abc');
    expect(existsSync(wt)).toBe(true);
    expect(git(main, ['branch', '--list', branch]).trim()).toContain(branch);

    lines.length = 0;
    const second = await mod.closeRun(argv, {
      log: (line) => lines.push(line),
      sessionRow: async () => null,
    });
    const secondOut = lines.join('\n');
    expect(second, secondOut).toBe(0);
    expect(secondOut).toContain('会话已经不在');
    expect(existsSync(wt)).toBe(false);
    expect(git(main, ['branch', '--list', branch]).trim()).toBe('');
  });

  it('登记没了、目录里还有文件：停住不删，主检出还在', async () => {
    const { main, wt, branch } = conventionalRepo(true);
    linkModules(main, wt, process.platform === 'win32' ? 'junction' : 'dir');
    dropAdmin(wt);
    expect(git(main, ['worktree', 'list'])).not.toContain(wt);
    let dropped = false;
    const lines: string[] = [];
    const code = await mod.closeRun(['--repo', main, '--branch', branch, '--session', 'kimi:on-main'], {
      log: (line) => lines.push(line),
      sessionRow: async () => null,
      deleteSession: async () => {
        dropped = true;
        return { skipped: false, detail: '不该删' };
      },
    });
    const out = lines.join('\n');
    expect(code, out).not.toBe(0);
    expect(out).toMatch(/没有删/);
    expect(existsSync(wt)).toBe(true);
    expect(existsSync(join(wt, 'change.txt'))).toBe(true);
    expect(readFileSync(join(main, 'node_modules', 'keep.txt'), 'utf8')).toBe('keep\n');
    expect(readFileSync(join(main, 'readme.txt'), 'utf8')).toBe('ok\n');
    expect(dropped).toBe(false);
  });

  it('登记没了但仍有未提交文件：不删', async () => {
    const { main, wt, branch } = conventionalRepo(true);
    writeFileSync(join(wt, 'dirty.txt'), 'x\n');
    dropAdmin(wt);
    const { code, out } = await runClose(main, branch);
    expect(code, out).not.toBe(0);
    expect(out).toMatch(/没有删/);
    expect(existsSync(join(wt, 'dirty.txt'))).toBe(true);
    expect(existsSync(join(main, 'readme.txt'))).toBe(true);
  });

  it('登记没了且分支还不在默认分支：不删目录', async () => {
    const { main, wt, branch } = conventionalRepo(false);
    dropAdmin(wt);
    const { code, out } = await runClose(main, branch);
    expect(code, out).not.toBe(0);
    expect(out).toMatch(/没有删/);
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
    expect(out).toContain(realpathSync.native(kept));
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

  it('父目录是指到主检出外的联接：不认、不删外面的目录', async () => {
    const base = mkdtempSync(join(tmpdir(), 'close-4099-parent-'));
    roots.push(base);
    const main = join(base, 'main');
    const outside = join(base, 'outside');
    mkdirSync(main);
    git(main, ['init', '-b', 'main']);
    writeFileSync(join(main, 'readme.txt'), 'ok\n');
    git(main, ['add', 'readme.txt']);
    git(main, ['commit', '-m', 'init']);
    mkdirSync(join(main, '.claude'));
    mkdirSync(outside);
    mkdirSync(join(outside, 'case'));
    writeFileSync(join(outside, 'case', 'keep.txt'), 'keep\n');
    symlinkSync(
      outside,
      join(main, '.claude', 'worktrees'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(mod.conventionalWorktreePath(main, 'local/case')).toBeNull();
    const { code, out } = await runClose(main, 'local/case');
    expect(readFileSync(join(outside, 'case', 'keep.txt'), 'utf8'), out).toBe('keep\n');
    expect(existsSync(join(main, '.claude', 'worktrees')), out).toBe(true);
    expect(readFileSync(join(main, 'readme.txt'), 'utf8'), out).toBe('ok\n');
    expect(code, out).toBe(0);
  });
});
