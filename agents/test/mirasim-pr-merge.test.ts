// pr-merge.mjs：PR 合并的唯一入口，整条交给 close.mjs 的收单流程。
// 回归：合并走收单入口（gh pr merge 在 close.mjs 序列里跑，工作树、分支、会话同一条命令收掉），
// 不是裸合远端就完；之前残留的根因（fleet-setup #14/#15、fleet-ade #42/#43）就是入口不是必经。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../skills/mirasim-sessions/scripts/pr-merge.mjs', import.meta.url));
// 动态 import 和 mirasim-close.test.ts 同一个原因：.mjs 没有类型，静态 import 会让 tsc 认不出模块。
const mod = (await import(pathToFileURL(SCRIPT).href)) as {
  prMergeRun: (
    argv: string[],
    io?: {
      exec?: (cmd: string, args: string[], opts?: { cwd?: string }) => ExecResult;
      env?: NodeJS.ProcessEnv;
      log?: (line: string) => void;
      deleteSession?: (key: string) => Promise<{ skipped: boolean; detail: string }>;
    },
  ) => Promise<number>;
  parseArgs: (argv: string[]) => { pr: string; repo: string };
};

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
interface Call {
  cmd: string;
  args: string[];
}

const BRANCH = 'local/99-fix';
const SESSION_ID = '11111111-2222-3333-4444-555555555555';
const SESSION_KEY = `kimi:${SESSION_ID}`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 一棵真实存在的工作树目录（sessionForWorktree 的 samePath 要走 realpath）。 */
function realWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pm-wt-'));
  roots.push(dir);
  return dir;
}

/** 主检出也要是真目录：closeRun 的 snapshotDepCounts 会 realpath 它。 */
function realMain(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pm-main-'));
  roots.push(dir);
  return dir;
}

function sessionHome(workdir: string | null): string {
  const home = mkdtempSync(join(tmpdir(), 'pm-home-'));
  roots.push(home);
  if (workdir !== null) {
    const dir = join(home, '.mirasim', 'sessions', 'kimi', SESSION_ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'record.json'),
      JSON.stringify({ sessionId: SESSION_ID, workdir, runState: 'completed' }),
    );
  }
  return home;
}

interface Rig {
  exec: (cmd: string, args: string[], opts?: { cwd?: string }) => ExecResult;
  calls: Call[];
}

/**
 * 假子进程：应付 pr-merge 的解参和 closeRun 全序列为「PR 开着、分支已推、工作树干净」。
 * dirty 为真时工作树报有未提交改动。
 */
function rig(opts: { main: string; wt: string; dirty?: boolean; prState?: string }): Rig {
  const calls: Call[] = [];
  const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
  const exec = (cmd: string, args: string[]): ExecResult => {
    calls.push({ cmd, args });
    const a = args[0] === '-C' ? args.slice(2).join(' ') : args.join(' ');
    if (a === 'rev-parse --path-format=absolute --git-common-dir') return ok(join(opts.main, '.git'));
    if (a === 'rev-parse --path-format=absolute --git-dir') return ok(join(opts.main, '.git'));
    if (a === 'rev-parse --show-toplevel') return ok(opts.main);
    if (a === 'worktree list --porcelain')
      return ok(
        `worktree ${opts.main}\nHEAD 0000\nbranch refs/heads/main\n\n` +
          `worktree ${opts.wt}\nHEAD 1111\nbranch refs/heads/${BRANCH}\n`,
      );
    if (a === 'status --porcelain --untracked-files=all') return ok(opts.dirty ? ' M dirty.ts\n' : '');
    if (a === 'status --porcelain') return ok('');
    if (a === 'symbolic-ref --short refs/remotes/origin/HEAD') return ok('origin/main');
    if (a === 'remote') return ok('origin\n');
    if (a === 'remote get-url origin') return ok('https://github.com/o/r.git');
    if (a === 'remote get-url --push origin') return ok('https://github.com/o/r.git');
    if (a.startsWith('remote get-url')) return { code: 2, stdout: '', stderr: 'no such remote' };
    if (a === 'fetch origin main') return ok();
    if (a === `merge-base --is-ancestor ${BRANCH} refs/remotes/origin/main`)
      return { code: 1, stdout: '', stderr: '' };
    if (a === `show-ref --verify --quiet refs/heads/${BRANCH}`) return ok();
    if (a === 'rev-parse refs/heads/main') return ok('aaa\n');
    if (a === 'rev-parse refs/remotes/origin/main') return ok('bbb\n');
    if (a === 'rev-parse --abbrev-ref HEAD') return ok('main\n');
    if (a === 'merge --ff-only refs/remotes/origin/main') return ok();
    if (a === 'rev-parse --short HEAD') return ok('bbb\n');
    if (a === `worktree remove ${opts.wt}`) return ok();
    if (a === `branch -D ${BRANCH}`) return ok();
    if (a === `ls-remote --heads origin ${BRANCH}`) return ok('');
    if (cmd === 'gh' && a.startsWith('pr view') && a.includes('headRefName'))
      return ok(JSON.stringify({ headRefName: BRANCH, state: opts.prState ?? 'OPEN' }));
    if (cmd === 'gh' && a.startsWith('pr view')) return ok(JSON.stringify({ state: opts.prState ?? 'OPEN' }));
    if (cmd === 'gh' && a.startsWith('pr merge')) return ok();
    return { code: 1, stdout: '', stderr: `没料到的调用: ${cmd} ${a}` };
  };
  return { exec, calls };
}

function has(calls: Call[], needle: string): boolean {
  return calls.some((c) => `${c.cmd} ${c.args.join(' ')}`.includes(needle));
}

describe('pr-merge 走收单入口', () => {
  it('合并、删工作树、删分支、删会话一条做完', async () => {
    const main = realMain();
    const wt = realWorktree();
    const home = sessionHome(wt);
    const { exec, calls } = rig({ main, wt });
    const deleted: string[] = [];
    const code = await mod.prMergeRun(['42', '--repo', main], {
      exec,
      env: { ...process.env, USERPROFILE: home },
      log: () => {},
      deleteSession: async (key) => {
        deleted.push(key);
        return { skipped: false, detail: `已删会话 ${key}` };
      },
    });
    expect(code).toBe(0);
    // 合并在收单序列里：close.mjs 的 gh pr merge --squash
    expect(has(calls, 'gh pr merge 42 --repo o/r --squash')).toBe(true);
    expect(has(calls, `worktree remove ${wt}`)).toBe(true);
    expect(has(calls, `branch -D ${BRANCH}`)).toBe(true);
    expect(deleted).toEqual([SESSION_KEY]);
  });

  it('对不上工作树的会话不删', async () => {
    const main = realMain();
    const wt = realWorktree();
    const home = sessionHome('C:\\elsewhere\\other-wt');
    const { exec, calls } = rig({ main, wt });
    const deleted: string[] = [];
    const code = await mod.prMergeRun(['42', '--repo', main], {
      exec,
      env: { ...process.env, USERPROFILE: home },
      log: () => {},
      deleteSession: async (key) => {
        deleted.push(key);
        return { skipped: false, detail: '' };
      },
    });
    expect(code).toBe(0);
    expect(has(calls, 'gh pr merge 42')).toBe(true);
    expect(deleted).toEqual([]);
  });

  it('工作树有未提交改动：不合并、不删', async () => {
    const main = realMain();
    const wt = realWorktree();
    const home = sessionHome(wt);
    const { exec, calls } = rig({ main, wt, dirty: true });
    const code = await mod.prMergeRun(['42', '--repo', main], {
      exec,
      env: { ...process.env, USERPROFILE: home },
      log: () => {},
      deleteSession: async () => ({ skipped: false, detail: '' }),
    });
    expect(code).toBe(1);
    expect(has(calls, 'gh pr merge')).toBe(false);
    expect(has(calls, 'worktree remove')).toBe(false);
  });
});

describe('parseArgs', () => {
  it('PR 号必须是正整数', () => {
    expect(() => mod.parseArgs(['abc'])).toThrowError(/正整数/);
    expect(mod.parseArgs(['42']).pr).toBe('42');
  });
});
