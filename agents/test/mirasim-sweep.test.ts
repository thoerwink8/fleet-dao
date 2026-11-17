// sweep.mjs：非 running 的会话按工作树和假 PR 状态判类。默认只列，--apply 才收。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runChildOk } from './child.ts';

interface Pr {
  number: string;
  state: string;
}
interface SweepMod {
  sweepRun(
    argv: string[],
    io?: {
      log?: (line: string) => void;
      exec?: (cmd: string, args: string[]) => { code: number; stdout: string; stderr: string };
      listPrs?: (ctx: { workdir: string; branch: string }) => Promise<Pr[] | null>;
      closeRun?: (argv: string[]) => Promise<number>;
      deleteSession?: (key: string) => Promise<{ skipped: boolean; detail: string }>;
    },
  ): Promise<number>;
  classify(facts: {
    runState: string;
    workdirExists: boolean;
    linked: boolean;
    dirty: boolean;
    unpushed: boolean;
    prs: Pr[] | null;
  }): { kind: string; reason: string; pr: string | null };
}

// 脚本是给 node 直接跑的 .mjs，不在 tsc 的静态图里。和 mirasim-close.test.ts 一样按文件 URL 装。
const mod = (await import(
  new URL('../skills/mirasim-sessions/scripts/sweep.mjs', import.meta.url).href
)) as SweepMod;

vi.setConfig({ testTimeout: 20_000 });

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return runChildOk(
    'git',
    ['-c', 'user.name=sweep-test', '-c', 'user.email=sweep-test@example.com', ...args],
    { cwd },
  );
}

/** 主检出 + 已推到本地 origin 的链接工作树。ahead 时分支上多一个没推的提交。 */
function linkedRepo(ahead: boolean): { wt: string; branch: string } {
  const root = mkdtempSync(join(tmpdir(), 'sweep-4087-'));
  roots.push(root);
  const main = join(root, 'main');
  const bare = join(root, 'origin.git');
  const wt = join(root, 'wt');
  mkdirSync(main);
  git(main, ['init', '-b', 'main']);
  git(main, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(main, 'readme.txt'), 'ok\n');
  git(main, ['add', 'readme.txt']);
  git(main, ['commit', '-m', 'init']);
  git(main, ['init', '--bare', bare]);
  git(main, ['remote', 'add', 'origin', bare]);
  git(main, ['push', '-u', 'origin', 'main']);
  const branch = 'local/demo';
  git(main, ['worktree', 'add', '-b', branch, wt]);
  git(wt, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(wt, 'change.txt'), 'change\n');
  git(wt, ['add', 'change.txt']);
  git(wt, ['commit', '-m', 'change']);
  git(wt, ['push', '-u', 'origin', branch]);
  if (ahead) {
    writeFileSync(join(wt, 'ahead.txt'), 'ahead\n');
    git(wt, ['add', 'ahead.txt']);
    git(wt, ['commit', '-m', 'ahead']);
  }
  return { wt, branch };
}

/** 只有主检出、没有链接工作树。现有用例用它挡住对当前仓的盘点。 */
function emptyRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sweep-empty-'));
  roots.push(root);
  const main = join(root, 'main');
  mkdirSync(main);
  git(main, ['init', '-b', 'main']);
  return main;
}

function session(root: string, id: string, workdir: string, runState: string): void {
  const dir = join(root, 'kimi', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'record.json'),
    JSON.stringify({ agent: 'kimi', sessionId: id, runState, workdir, title: id }),
  );
}

describe('sweep.mjs 五种判类', () => {
  it('已合并、已关闭、没有 PR、有未推提交、孤儿；在跑的不列', async () => {
    const merged = linkedRepo(false);
    const closed = linkedRepo(false);
    const none = linkedRepo(false);
    const ahead = linkedRepo(true);
    const sessions = mkdtempSync(join(tmpdir(), 'sweep-sessions-'));
    roots.push(sessions);
    const ids = {
      merged: 'aaaaaaaa-1111-4111-8111-111111111111',
      closed: 'bbbbbbbb-2222-4222-8222-222222222222',
      none: 'cccccccc-3333-4333-8333-333333333333',
      ahead: 'dddddddd-4444-4444-8444-444444444444',
      orphan: 'eeeeeeee-5555-4555-8555-555555555555',
      running: 'ffffffff-6666-4666-8666-666666666666',
    };
    session(sessions, ids.merged, merged.wt, 'completed');
    session(sessions, ids.closed, closed.wt, 'completed');
    session(sessions, ids.none, none.wt, 'completed');
    session(sessions, ids.ahead, ahead.wt, 'incomplete');
    session(sessions, ids.orphan, join(sessions, 'gone-workdir'), 'completed');
    session(sessions, ids.running, join(sessions, 'also-gone'), 'running');
    const lines: string[] = [];
    const code = await mod.sweepRun(['--root', sessions, '--repo', emptyRepo()], {
      log: (line) => lines.push(line),
      listPrs: async ({ workdir }) => {
        if (workdir === merged.wt) return [{ number: '11', state: 'MERGED' }];
        if (workdir === closed.wt) return [{ number: '12', state: 'CLOSED' }];
        if (workdir === ahead.wt) return [{ number: '13', state: 'MERGED' }];
        return [];
      },
    });
    const out = lines.join('\n');
    expect(code, out).toBe(0);
    expect(out).toContain(`可收 kimi:aaaaaaaa ${merged.branch} PR #11 已合并`);
    expect(out).toContain(`可收 kimi:bbbbbbbb ${closed.branch} PR #12 已关闭`);
    expect(out).toContain(`要人看 kimi:cccccccc ${none.branch} 没有 PR`);
    expect(out).toContain(`要人看 kimi:dddddddd ${ahead.branch} 有未推提交`);
    expect(out).toContain('孤儿 kimi:eeeeeeee 工作树和会话工作目录都已不在');
    expect(out).not.toContain('ffffffff');
    expect(lines[0]?.startsWith('可收')).toBe(true);
  });

  it('默认不收；--apply 只把可收交给 close.mjs、孤儿交给删会话', async () => {
    const closable = linkedRepo(false);
    const keep = linkedRepo(false);
    const sessions = mkdtempSync(join(tmpdir(), 'sweep-apply-'));
    roots.push(sessions);
    const closableId = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const keepId = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const orphanId = '33333333-cccc-4ccc-8ccc-cccccccccccc';
    session(sessions, closableId, closable.wt, 'completed');
    session(sessions, keepId, keep.wt, 'completed');
    session(sessions, orphanId, join(sessions, 'missing'), 'completed');
    const listPrs = async ({ workdir }: { workdir: string }) =>
      workdir === closable.wt ? [{ number: '21', state: 'MERGED' }] : [];
    const quiet = emptyRepo();
    const idle: string[] = [];
    const listed = await mod.sweepRun(['--root', sessions, '--repo', quiet], {
      log: () => {},
      listPrs,
      closeRun: async (argv) => {
        idle.push(argv.join(' '));
        return 0;
      },
      deleteSession: async (key) => {
        idle.push(key);
        return { skipped: false, detail: key };
      },
    });
    expect(listed).toBe(0);
    expect(idle).toEqual([]);

    const closed: string[] = [];
    const dropped: string[] = [];
    const lines: string[] = [];
    const code = await mod.sweepRun(['--root', sessions, '--repo', quiet, '--apply'], {
      log: (line) => lines.push(line),
      listPrs,
      closeRun: async (argv) => {
        closed.push(argv.join(' '));
        return 0;
      },
      deleteSession: async (key) => {
        dropped.push(key);
        return { skipped: false, detail: `已删会话 ${key}` };
      },
    });
    const out = lines.join('\n');
    expect(code, out).toBe(0);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toContain(`--branch ${closable.branch}`);
    expect(closed[0]).toContain('--pr 21');
    expect(closed[0]).toContain(`--session kimi:${closableId}`);
    expect(closed[0]).not.toContain(keepId);
    expect(dropped).toEqual([`kimi:${orphanId}`]);
    expect(out).toContain(`[删会话] 已删会话 kimi:${orphanId}`);
  });

  it('没有会话认领的工作树按同一套判类列出，--apply 不带会话', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sweep-unowned-'));
    roots.push(root);
    const main = join(root, 'main');
    const bare = join(root, 'origin.git');
    mkdirSync(main);
    git(main, ['init', '-b', 'main']);
    git(main, ['config', 'core.autocrlf', 'false']);
    writeFileSync(join(main, 'readme.txt'), 'ok\n');
    git(main, ['add', 'readme.txt']);
    git(main, ['commit', '-m', 'init']);
    git(main, ['init', '--bare', bare]);
    git(main, ['remote', 'add', 'origin', bare]);
    git(main, ['push', '-u', 'origin', 'main']);
    const trees = { merged: '', dirty: '', open: '', none: '', owned: '' };
    for (const name of ['merged', 'dirty', 'open', 'none', 'owned'] as const) {
      const wt = join(root, name);
      git(main, ['worktree', 'add', '-b', `local/${name}`, wt]);
      git(wt, ['config', 'core.autocrlf', 'false']);
      writeFileSync(join(wt, 'change.txt'), `${name}\n`);
      git(wt, ['add', 'change.txt']);
      git(wt, ['commit', '-m', name]);
      git(wt, ['push', '-u', 'origin', `local/${name}`]);
      trees[name] = wt;
    }
    writeFileSync(join(trees.dirty, 'dirty.txt'), 'dirty\n');
    git(main, ['worktree', 'add', '--detach', join(root, 'detached'), 'HEAD']);
    const sessions = mkdtempSync(join(tmpdir(), 'sweep-unowned-sessions-'));
    roots.push(sessions);
    const ownedId = 'aaaaaaaa-7777-4777-8777-777777777777';
    session(sessions, ownedId, trees.owned, 'completed');
    const listPrs = async ({ branch }: { branch: string }) => {
      if (branch === 'local/merged') return [{ number: '31', state: 'MERGED' }];
      if (branch === 'local/open') return [{ number: '32', state: 'OPEN' }];
      if (branch === 'local/owned') return [{ number: '33', state: 'MERGED' }];
      return [];
    };
    const lines: string[] = [];
    const listed = await mod.sweepRun(['--root', sessions, '--repo', main], {
      log: (line) => lines.push(line),
      listPrs,
    });
    const out = lines.join('\n');
    expect(listed, out).toBe(0);
    expect(out).toContain('可收 工作树 local/merged PR #31 已合并');
    expect(out).toContain('要人看 工作树 local/dirty 有真实未提交改动');
    expect(out).toContain('还开着 工作树 local/open PR #32');
    expect(out).toContain('要人看 工作树 local/none 没有 PR');
    expect(out).toContain('要人看 工作树 (游离) 认不出分支');
    expect(out).toContain(`可收 kimi:${ownedId.slice(0, 8)} local/owned PR #33 已合并`);
    expect(out).not.toContain('工作树 local/owned');
    expect(out).not.toContain('工作树 main');
    expect(out.split('\n').filter((line) => line.startsWith('可收'))).toHaveLength(2);

    const closed: string[] = [];
    const code = await mod.sweepRun(['--root', sessions, '--repo', main, '--apply'], {
      log: () => {},
      listPrs,
      closeRun: async (argv) => {
        closed.push(argv.join(' '));
        return 0;
      },
      deleteSession: async () => {
        throw new Error('没人认的工作树不该删会话');
      },
    });
    expect(code, closed.join('\n')).toBe(0);
    const sessionClose = closed.find((line) => line.includes('--session'));
    const treeClose = closed.find((line) => !line.includes('--session'));
    expect(closed).toHaveLength(2);
    expect(sessionClose).toContain('--pr 33');
    expect(sessionClose).toContain(`--session kimi:${ownedId}`);
    expect(treeClose).toContain('--branch local/merged');
    expect(treeClose).toContain('--pr 31');
    expect(treeClose).not.toContain('--session');
    expect(closed.join('\n')).not.toContain('local/dirty');
    expect(closed.join('\n')).not.toContain('local/open');
    expect(closed.join('\n')).not.toContain('local/none');
  });

  it('列工作树失败仍列出会话', async () => {
    const sessions = mkdtempSync(join(tmpdir(), 'sweep-norepo-'));
    roots.push(sessions);
    const id = '99999999-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    session(sessions, id, join(sessions, 'missing'), 'completed');
    const lines: string[] = [];
    const code = await mod.sweepRun(['--root', sessions, '--repo', sessions], {
      log: (line) => lines.push(line),
    });
    const out = lines.join('\n');
    expect(code, out).toBe(0);
    expect(out).toContain('列工作树没成');
    expect(out).toContain('孤儿 kimi:99999999');
  });

  it('--repo 缺值就停', async () => {
    const lines: string[] = [];
    const code = await mod.sweepRun(['--repo'], { log: (line) => lines.push(line) });
    expect(code).toBe(2);
    expect(lines.join('\n')).toContain('--repo 缺值');
  });


  it('工作目录不是 git 仓库时不列成要人看，别的仓的链接工作树仍列', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sweep-home-'));
    roots.push(home);
    writeFileSync(join(home, 'note.txt'), 'not a repo\n');
    const linked = linkedRepo(false);
    const sessions = mkdtempSync(join(tmpdir(), 'sweep-notgit-'));
    roots.push(sessions);
    const homeId = 'aaaaaaaa-9999-4999-8999-999999999999';
    const linkedId = 'bbbbbbbb-8888-4888-8888-888888888888';
    session(sessions, homeId, home, 'completed');
    session(sessions, linkedId, linked.wt, 'completed');
    const lines: string[] = [];
    const code = await mod.sweepRun(['--root', sessions, '--repo', emptyRepo()], {
      log: (line) => lines.push(line),
      listPrs: async () => [],
    });
    const out = lines.join('\n');
    expect(code, out).toBe(0);
    expect(out).not.toContain(homeId.slice(0, 8));
    expect(out).not.toContain('不是 git 工作树');
    expect(out).toContain(`要人看 kimi:${linkedId.slice(0, 8)} ${linked.branch} 没有 PR`);
  });

  it('git 因权限失败仍要人看', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sweep-perm-'));
    roots.push(dir);
    const sessions = mkdtempSync(join(tmpdir(), 'sweep-perm-sessions-'));
    roots.push(sessions);
    const id = 'cccccccc-7777-4777-8777-777777777777';
    session(sessions, id, dir, 'completed');
    const lines: string[] = [];
    const code = await mod.sweepRun(['--root', sessions, '--repo', emptyRepo()], {
      log: (line) => lines.push(line),
      exec: () => ({ code: 1, stdout: '', stderr: 'permission denied' }),
    });
    const out = lines.join('\n');
    expect(code, out).toBe(0);
    expect(out).toContain(`要人看 kimi:${id.slice(0, 8)}`);
    expect(out).toContain('工作目录不是 git 工作树');
  });
});
