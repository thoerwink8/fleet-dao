// 复杂脏工作树：独立恢复对上、原树没变、没人用，才允许清理入口删树。失败留树，人工备份不是回执。
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { confirmDeletionIdle, sweepWorktrees } from '../../src/jobs/worktree-sweep.ts';
import { PortError } from '../../src/ports.ts';
import {
  assertArchiveContainer,
  cleanupLockPath,
  holdCleanupLock,
  ignoreRuleAllowed,
  locateTree,
  type ProcLook,
  recheckPreservedArchive,
  treeProcessUsage,
} from '../../src/real/complex-preserve.ts';
import { localExec, type UserExec } from '../../src/real/exec.ts';
import { preserveThenRemove, preserveWorktree } from '../../src/real/preserve-worktree.ts';
import { PROBE_DIR } from '../../src/real/route-probe.ts';
import { DISPOSABLE, ENVIRONMENT_FILES, treeLeftovers, type UserTree } from '../../src/real/user-git.ts';
import { layout, SESSION_TMP_DIR } from '../../src/real/worktrees.ts';
import { runChild, runChildBytes } from '../child.ts';
import { git } from './fixtures.ts';

const USER = 'fleet-agent-carpool' as const;
const children: ChildProcess[] = [];
let root: string;
let workRoot: string;
let archive: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-complex-'));
  workRoot = join(root, 'work');
  archive = join(root, 'archive');
  mkdirSync(workRoot);
});

afterEach(() => {
  for (const child of children) child.kill('SIGKILL');
  children.length = 0;
  rmSync(root, { recursive: true, force: true });
});

function tree(rel = 'acme_web/12-keep', exec: UserExec = localExec()): UserTree {
  const dir = join(workRoot, rel);
  mkdirSync(dir, { recursive: true });
  return { exec, user: USER, dir, scopePrefix: 'complex-test', git: 'git', sh: 'sh' };
}

function idle(): Promise<'idle'> {
  return Promise.resolve('idle');
}

function forbidMutations(exec: UserExec): UserExec {
  return async (command) => {
    const wipe =
      command.argv.includes('reset') ||
      command.argv.includes('clean') ||
      (command.argv.includes('stash') &&
        command.argv.some((arg) => arg === 'drop' || arg === 'clear' || arg === 'pop'));
    if (wipe) throw new Error(`不许改原树：${command.argv.join(' ')}`);
    return exec(command);
  };
}

function dirtyFile(t: UserTree, name = 'dirty.txt'): void {
  git(t.dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(t.dir, 'base.txt'), 'base\n');
  git(t.dir, 'add', '.');
  git(t.dir, 'commit', '-q', '-m', 'base');
  git(t.dir, 'update-ref', 'refs/fleet/incoming', 'HEAD');
  writeFileSync(join(t.dir, name), 'dirty\n');
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_INDEX_FILE',
    'GIT_NAMESPACE',
  ]) {
    delete env[key];
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_AUTHOR_NAME = 't';
  env.GIT_AUTHOR_EMAIL = 'fleet-test@localhost';
  env.GIT_COMMITTER_NAME = 't';
  env.GIT_COMMITTER_EMAIL = 'fleet-test@localhost';
  return env;
}

function gitClean(cwd: string, args: string[], input?: Buffer): string {
  const result = runChildBytes('git', args, { cwd, env: cleanEnv(), ...(input ? { input } : {}) });
  if (result.status !== 0) {
    throw new Error(result.stderr.toString('utf8').slice(0, 400) || `git ${args[0]} 退出 ${result.status}`);
  }
  return result.stdout.toString('utf8');
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function archives(): string[] {
  if (!existsSync(archive)) return [];
  return readdirSync(archive).filter((name) => name.startsWith('worktree-'));
}

interface SourceFile {
  kind: 'file' | 'symlink' | 'dir';
  mode: number;
  bytes?: Buffer;
  link?: string;
}

function listedOids(dir: string): Set<string> {
  const oids = new Set<string>();
  const add = (text: string) => {
    for (const line of text.split('\n')) {
      const sha = line.split(/[\s]/)[0] ?? '';
      if (/^[0-9a-f]{40}$/.test(sha)) oids.add(sha);
    }
  };
  add(git(dir, 'rev-list', '--objects', '--all', '--reflog'));
  for (const line of git(dir, '-c', 'core.quotePath=false', 'ls-files', '--stage').split('\n')) {
    const sha = line.split(' ')[1] ?? '';
    if (/^[0-9a-f]{40}$/.test(sha)) oids.add(sha);
  }
  const stash = git(dir, 'stash', 'list', '--format=%H').trim();
  if (stash) {
    for (const sha of stash.split('\n')) {
      oids.add(sha);
      for (const parent of git(dir, 'rev-parse', `${sha}^@`).split('\n').filter(Boolean)) oids.add(parent);
      add(git(dir, 'rev-list', '--objects', sha));
    }
  }
  return oids;
}

function cover(dir: string, state: { files: { path: string }[]; ignored: { path: string; rule: string }[] }) {
  const archived = new Set(state.files.map((file) => file.path));
  const ignored = new Map(state.ignored.map((item) => [item.path, item.rule]));
  const walk = (rel: string) => {
    const abs = rel ? join(dir, rel) : dir;
    for (const name of readdirSync(abs)) {
      const path = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(abs, name));
      if (ignored.has(path)) {
        expect(ignoreRuleAllowed(ignored.get(path) ?? '', path, [])).toBe(true);
        continue;
      }
      if (st.isDirectory()) {
        const nested = readdirSync(join(abs, name));
        if (nested.length === 0) expect(archived.has(path), path).toBe(true);
        else walk(path);
        continue;
      }
      expect(archived.has(path), path).toBe(true);
    }
  };
  walk('');
  for (const [path, rule] of ignored) expect(ignoreRuleAllowed(rule, path, [])).toBe(true);
  expect(ignored.get('.git')).toBe('git-metadata');
  expect(archived.has('keep-real.txt')).toBe(true);
  expect(ignored.has('keep-real.txt')).toBe(false);
}

function restoreArchive(saved: string, dest: string): string {
  const state = JSON.parse(readFileSync(join(saved, 'state.json'), 'utf8')) as {
    head: string;
    headRef: string | null;
    indexInfo: string;
    files: { path: string; kind: string; mode: number; sha256: string }[];
    merge: { name: string; sha256: string }[];
    stash: { sha: string; subject: string }[];
    objects: { sha: string; type: string }[];
  };
  const repo = join(dest, 'repo');
  mkdirSync(dest);
  gitClean(dest, ['init', '-q', '-b', 'main', repo]);
  gitClean(repo, ['symbolic-ref', 'HEAD', 'refs/heads/fleet-restore-unborn']);
  gitClean(repo, ['unpack-objects'], readFileSync(join(saved, 'objects.pack')));
  const bundlePath = join(dest, 'recovery.bundle');
  writeFileSync(bundlePath, readFileSync(join(saved, 'recovery.bundle')));
  gitClean(repo, ['bundle', 'verify', bundlePath]);
  gitClean(repo, ['fetch', '--no-tags', '-q', bundlePath, '+refs/*:refs/*', 'HEAD']);
  if (state.headRef) {
    gitClean(repo, ['update-ref', state.headRef, state.head]);
    gitClean(repo, ['symbolic-ref', 'HEAD', state.headRef]);
  } else {
    gitClean(repo, ['update-ref', '--no-deref', 'HEAD', state.head]);
  }
  expect(existsSync(join(repo, '.git', 'objects', 'info', 'alternates'))).toBe(false);
  for (const file of state.files) {
    const buf = readFileSync(join(saved, 'blobs', file.sha256));
    expect(sha256(buf)).toBe(file.sha256);
    const target = join(repo, file.path);
    mkdirSync(join(target, '..'), { recursive: true });
    if (file.kind === 'symlink') symlinkSync(buf.toString('utf8'), target);
    else if (file.kind === 'dir') {
      mkdirSync(target, { recursive: true });
      chmodSync(target, file.mode);
    } else {
      writeFileSync(target, buf);
      chmodSync(target, file.mode);
    }
  }
  gitClean(repo, ['update-index', '--index-info'], Buffer.from(state.indexInfo));
  const gitDir = gitClean(repo, ['rev-parse', '--absolute-git-dir']).trim();
  for (const item of state.merge) {
    const buf = readFileSync(join(saved, 'blobs', item.sha256));
    expect(sha256(buf)).toBe(item.sha256);
    const file = join(gitDir, item.name);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, buf);
  }
  const gitDirStash = gitDir;
  rmSync(join(gitDirStash, 'logs', 'refs', 'stash'), { force: true });
  runChildBytes('git', ['-C', repo, 'update-ref', '-d', 'refs/stash'], { env: cleanEnv() });
  let prev: string | null = null;
  for (const entry of [...state.stash].reverse()) {
    if (prev === null) {
      gitClean(repo, ['update-ref', '--create-reflog', '-m', entry.subject, 'refs/stash', entry.sha]);
    } else {
      gitClean(repo, ['update-ref', '-m', entry.subject, 'refs/stash', entry.sha, prev]);
    }
    prev = entry.sha;
  }
  for (const obj of state.objects) {
    expect(gitClean(repo, ['cat-file', '-t', obj.sha]).trim()).toBe(obj.type);
  }
  return repo;
}

describe('复杂工作树受管保全', { timeout: 180_000 }, () => {
  it('忽略项只认可丢弃、环境文件、已核对截图和顶层 .git', () => {
    expect(ignoreRuleAllowed('node_modules/', 'node_modules', [])).toBe(true);
    expect(ignoreRuleAllowed('node_modules/', 'pkg/node_modules', [])).toBe(true);
    expect(ignoreRuleAllowed('*.tsbuildinfo', 'tsconfig.tsbuildinfo', [])).toBe(true);
    expect(ignoreRuleAllowed('env:.claude/settings.json', '.claude/settings.json', [])).toBe(true);
    expect(ignoreRuleAllowed('git-metadata', '.git', [])).toBe(true);
    expect(ignoreRuleAllowed('git-metadata', 'nested/.git', [])).toBe(false);
    expect(ignoreRuleAllowed('shot:keep-real.txt', 'keep-real.txt', [])).toBe(false);
    expect(ignoreRuleAllowed('shot:_tmp/shots/a.png', '_tmp/shots/a.png', ['_tmp/shots/a.png'])).toBe(true);
    expect(ignoreRuleAllowed('secret/', 'secret', [])).toBe(false);
    expect(DISPOSABLE.map((item) => item.pattern)).toContain('node_modules/');
    expect(ENVIRONMENT_FILES.map((item) => item.path)).toContain('.claude/settings.json');
  });

  it('进程占用：树内 cwd 算在用，同主读不了算不清，别的用户读不了继续看', async () => {
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    const busy: ProcLook = {
      async list() {
        return ['1'];
      },
      async cwd() {
        return '/work/tree/src';
      },
      async uid() {
        return '1';
      },
    };
    expect(await treeProcessUsage('/work/tree', '9', 10, 11, busy)).toBe('busy');
    const deleted: ProcLook = {
      ...busy,
      async cwd() {
        return '/work/tree (deleted)';
      },
    };
    expect(await treeProcessUsage('/work/tree', '9', 10, 11, deleted)).toBe('busy');
    const unknown: ProcLook = {
      async list() {
        return ['1'];
      },
      async cwd() {
        throw denied;
      },
      async uid() {
        return '9';
      },
    };
    expect(await treeProcessUsage('/work/tree', '9', 10, 11, unknown)).toBe('unknown');
    const unlistable: ProcLook = {
      async list() {
        throw new Error('no proc');
      },
      async cwd() {
        return '/';
      },
      async uid() {
        return '1';
      },
    };
    expect(await treeProcessUsage('/work/tree', '9', 10, 11, unlistable)).toBe('unknown');
    const other: ProcLook = {
      async list() {
        return ['1', '2'];
      },
      async cwd(pid) {
        if (pid === 1) throw denied;
        return '/somewhere/else';
      },
      async uid() {
        return '5';
      },
    };
    expect(await treeProcessUsage('/work/tree', '9', 10, 11, other)).toBe('idle');
  });

  it('清理锁：活着或确认不了的进程不让第二轮清，退出了的锁可以接手', async () => {
    const t = tree();
    dirtyFile(t);
    await assertArchiveContainer(archive);
    const place = await locateTree(t);
    const release = await holdCleanupLock(archive, place);
    await expect(holdCleanupLock(archive, place)).rejects.toMatchObject({ code: 'WORKTREE_PRESERVED' });
    await release();
    const lock = cleanupLockPath(archive, place.dev, place.ino, place.real);
    writeFileSync(lock, `1\n${place.real}\n`);
    await expect(holdCleanupLock(archive, place)).rejects.toMatchObject({ code: 'WORKTREE_PRESERVED' });
    writeFileSync(lock, `2147483647\n${place.real}\n`);
    const again = await holdCleanupLock(archive, place);
    await again();
  });

  it('删树前确认不了路径、会话或在跑的任务，就不算没人用', async () => {
    const workflows = {
      async state(): Promise<{ state: 'missing' }> {
        return { state: 'missing' };
      },
    };
    const issue = async () => null;
    expect(
      await confirmDeletionIdle({
        root: '/work',
        dir: '/etc/passwd',
        openSessions: async () => [],
        workflows,
        issue,
      }),
    ).toBe('unknown');
    expect(
      await confirmDeletionIdle({
        root: '/work',
        dir: '/work/acme_web/12-keep',
        openSessions: async () => {
          throw new Error('会话账读不了');
        },
        workflows,
        issue,
      }),
    ).toBe('unknown');
    expect(
      await confirmDeletionIdle({
        root: '/work',
        dir: '/work/acme_web/12-keep',
        openSessions: async () => [{ path: '/work/acme_web/12-keep' }],
        workflows,
        issue,
      }),
    ).toBe('busy');
    expect(
      await confirmDeletionIdle({
        root: '/work',
        dir: '/work/acme_web/12-keep',
        openSessions: async () => [],
        workflows: {
          async state() {
            return { state: 'running' as const };
          },
        },
        issue,
      }),
    ).toBe('busy');
    expect(
      await confirmDeletionIdle({
        root: '/work',
        dir: '/work/acme_web/12-keep',
        openSessions: async () => [],
        workflows: {
          async state() {
            throw new Error('temporal');
          },
        },
        issue,
      }),
    ).toBe('unknown');
    expect(
      await confirmDeletionIdle({
        root: '/work',
        dir: '/work/acme_web/12-keep',
        openSessions: async () => [],
        workflows,
        issue,
      }),
    ).toBe('idle');
  });

  it('没有工作根或确认不了没人用时，复杂成果仍留树', async () => {
    const t = tree();
    dirtyFile(t);
    const removed: string[] = [];
    await expect(preserveWorktree(t, archive)).rejects.toThrow(/保留原树供接管/);
    await expect(
      preserveThenRemove(
        t,
        archive,
        { workRoot, confirmIdle: async () => 'unknown' },
        undefined,
        async () => {
          removed.push(t.dir);
          return { gone: false };
        },
      ),
    ).rejects.toThrow(/确认不了没人用/);
    await expect(
      preserveThenRemove(t, archive, { workRoot, confirmIdle: async () => 'busy' }, undefined, async () => {
        removed.push(t.dir);
        return { gone: false };
      }),
    ).rejects.toThrow(/仍有任务或会话在用/);
    expect(removed).toEqual([]);
    expect(readFileSync(join(t.dir, 'dirty.txt'), 'utf8')).toBe('dirty\n');
    expect(archives()).toEqual([]);
  });

  it('归档目录或工作树路径越界、符号链接、非 Git 成果都不删', async () => {
    const t = tree();
    dirtyFile(t);
    const secret = join(root, 'secret');
    mkdirSync(secret);
    symlinkSync(secret, archive);
    const removed: string[] = [];
    const remove = async () => {
      removed.push(t.dir);
      return { gone: false };
    };
    await expect(
      preserveThenRemove(t, archive, { workRoot, confirmIdle: idle }, undefined, remove),
    ).rejects.toMatchObject({ code: 'ARCHIVE_FAILED' });
    expect(readdirSync(secret)).toEqual([]);
    rmSync(archive);

    const realParent = join(root, 'real-parent');
    mkdirSync(realParent);
    const linkParent = join(root, 'link-parent');
    symlinkSync(realParent, linkParent);
    await expect(
      preserveThenRemove(t, join(linkParent, 'archive'), { workRoot, confirmIdle: idle }, undefined, remove),
    ).rejects.toMatchObject({ code: 'ARCHIVE_FAILED' });
    expect(existsSync(join(realParent, 'archive'))).toBe(false);

    const outside = tree('solo');
    dirtyFile(outside);
    await expect(
      preserveThenRemove(outside, archive, { workRoot, confirmIdle: idle }, undefined, remove),
    ).rejects.toThrow(/工作根/);
    const link = join(workRoot, 'acme_web', '12-link');
    symlinkSync(t.dir, link);
    await expect(
      preserveThenRemove({ ...t, dir: link }, archive, { workRoot, confirmIdle: idle }, undefined, remove),
    ).rejects.toMatchObject({ code: 'WORKTREE_PRESERVED' });

    const notes = tree('acme_web/12-notes');
    writeFileSync(join(notes.dir, 'hello.txt'), 'keep\n');
    await expect(
      preserveThenRemove(notes, archive, { workRoot, confirmIdle: idle }, undefined, remove),
    ).rejects.toThrow(/保留原树供接管/);
    expect(readFileSync(join(notes.dir, 'hello.txt'), 'utf8')).toBe('keep\n');
    expect(removed).toEqual([]);
    expect(existsSync(join(t.dir, 'dirty.txt'))).toBe(true);
  });

  it('有进程的 cwd 在树里就拒删', async () => {
    const t = tree();
    dirtyFile(t);
    const child = spawn('sleep', ['30'], { cwd: t.dir, stdio: 'ignore' });
    children.push(child);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const removed: string[] = [];
    await expect(
      preserveThenRemove(t, archive, { workRoot, confirmIdle: idle }, undefined, async () => {
        removed.push(t.dir);
        return { gone: false };
      }),
    ).rejects.toThrow(/有进程正用着这棵树/);
    expect(removed).toEqual([]);
    expect(existsSync(join(t.dir, 'dirty.txt'))).toBe(true);
  });

  it('快照不完整、归档被破坏、对象缺失、读不了，都拒删并留下原因', async () => {
    const t = tree();
    dirtyFile(t);
    const real = localExec();
    const removed: string[] = [];
    const remove = async () => {
      removed.push(t.dir);
      return { gone: false };
    };
    const truncate: UserExec = async (command) => {
      const result = await real(command);
      if (command.env?.FLEET_SNAP_MODE === 'capture')
        return { ...result, stdout: result.stdout.subarray(0, 24) };
      return result;
    };
    await expect(
      preserveThenRemove(
        { ...t, exec: truncate },
        archive,
        { workRoot, confirmIdle: idle },
        undefined,
        remove,
      ),
    ).rejects.toThrow(/快照帧/);
    expect(existsSync(join(t.dir, 'dirty.txt'))).toBe(true);

    const corrupt: UserExec = async (command) => {
      const result = await real(command);
      if (command.env?.FLEET_SNAP_MODE === 'inspect') {
        for (const name of archives()) {
          const pack = join(archive, name, 'objects.pack');
          if (existsSync(pack)) writeFileSync(pack, Buffer.from('broken'));
        }
      }
      return result;
    };
    await expect(
      preserveThenRemove(
        { ...t, exec: corrupt },
        archive,
        { workRoot, confirmIdle: idle },
        undefined,
        remove,
      ),
    ).rejects.toThrow(/哈希对不上|独立恢复/);
    expect(existsSync(join(t.dir, 'dirty.txt'))).toBe(true);
    expect(archives().length).toBeGreaterThan(0);

    const dropBlob: UserExec = async (command) => {
      const result = await real(command);
      if (command.env?.FLEET_SNAP_MODE === 'inspect') {
        for (const name of archives()) {
          const blobs = join(archive, name, 'blobs');
          const file = existsSync(blobs) ? readdirSync(blobs)[0] : undefined;
          if (file) rmSync(join(blobs, file));
        }
      }
      return result;
    };
    await expect(
      preserveThenRemove(
        { ...t, exec: dropBlob },
        archive,
        { workRoot, confirmIdle: idle },
        undefined,
        remove,
      ),
    ).rejects.toThrow(/归档缺文件|哈希对不上|读不了/);
    expect(readFileSync(join(t.dir, 'dirty.txt'), 'utf8')).toBe('dirty\n');

    mkdirSync(join(t.dir, 'secret'));
    writeFileSync(join(t.dir, 'secret', 'a.txt'), 'hidden\n');
    chmodSync(join(t.dir, 'secret'), 0);
    try {
      await expect(
        preserveThenRemove(t, archive, { workRoot, confirmIdle: idle }, undefined, remove),
      ).rejects.toMatchObject({ code: 'READ_FAILED', message: expect.stringContaining('读不了') });
    } finally {
      chmodSync(join(t.dir, 'secret'), 0o755);
    }
    expect(readFileSync(join(t.dir, 'secret', 'a.txt'), 'utf8')).toBe('hidden\n');
    expect(removed).toEqual([]);
  });

  it('归档期间或归档后原树变了，旧回执不能放行；伪造路径不会被拿去删', async () => {
    const t = tree();
    dirtyFile(t);
    const real = localExec();
    let snaps = 0;
    const racing: UserExec = async (command) => {
      const result = await real(command);
      if (command.env?.FLEET_SNAP_MODE) {
        snaps += 1;
        if (snaps === 1) writeFileSync(join(t.dir, 'late.txt'), 'late\n');
      }
      return result;
    };
    const removed: string[] = [];
    await expect(
      preserveThenRemove(
        { ...t, exec: racing },
        archive,
        { workRoot, confirmIdle: idle },
        undefined,
        async () => {
          removed.push(t.dir);
          return { gone: false };
        },
      ),
    ).rejects.toThrow(/发生变化|对不上/);
    expect(readFileSync(join(t.dir, 'late.txt'), 'utf8')).toBe('late\n');
    rmSync(join(t.dir, 'late.txt'));

    let calls = 0;
    const flip: UserExec = localExec();
    await expect(
      preserveThenRemove(
        { ...t, exec: flip },
        archive,
        {
          workRoot,
          confirmIdle: async () => {
            calls += 1;
            return calls >= 2 ? 'busy' : 'idle';
          },
        },
        undefined,
        async () => {
          removed.push(t.dir);
          return { gone: false };
        },
      ),
    ).rejects.toThrow(/仍有任务或会话在用/);

    const forged: UserExec = async (command) => {
      const result = await real(command);
      if (command.env?.FLEET_SNAP_MODE !== 'inspect') return result;
      for (const name of archives()) {
        const receiptPath = join(archive, name, 'receipt.json');
        if (!existsSync(receiptPath)) continue;
        const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as {
          originalPath: string;
          ino: string;
        };
        receipt.originalPath = '/etc';
        receipt.ino = '1';
        writeFileSync(receiptPath, JSON.stringify(receipt));
      }
      return result;
    };
    await expect(
      preserveThenRemove(
        { ...t, exec: forged },
        archive,
        { workRoot, confirmIdle: idle },
        undefined,
        async () => {
          removed.push('/etc');
          return { gone: false };
        },
      ),
    ).rejects.toThrow(/对不上|作废/);
    expect(removed).toEqual([]);
    expect(existsSync(join(t.dir, 'dirty.txt'))).toBe(true);

    const saved = await preserveWorktree(t, archive, { workRoot, confirmIdle: idle });
    writeFileSync(join(t.dir, 'after.txt'), 'after\n');
    const place = await locateTree(t);
    await expect(
      recheckPreservedArchive(t, saved as string, { workRoot, confirmIdle: idle }, place, []),
    ).rejects.toThrow(/作废|发生变化|对不上/);
    const both = join(archive, 'both');
    mkdirSync(both);
    writeFileSync(join(both, 'receipt.json'), '{}\n');
    writeFileSync(join(both, 'manifest.json'), '{}\n');
    await expect(recheckPreservedArchive(t, both, { workRoot }, place, [])).rejects.toThrow(/两套回执/);
    const note = join(archive, 'manual');
    mkdirSync(note);
    writeFileSync(join(note, 'backup.tar'), 'not a receipt');
    await expect(recheckPreservedArchive(t, note, { workRoot }, place, [])).rejects.toThrow(
      /不能把旁边的备份当放行依据/,
    );
  });

  it('旁边的人工备份不会被当成干净树的放行回执', async () => {
    const t = tree();
    git(t.dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(t.dir, 'base.txt'), 'base\n');
    git(t.dir, 'add', '.');
    git(t.dir, 'commit', '-q', '-m', 'base');
    git(t.dir, 'update-ref', 'refs/fleet/incoming', 'HEAD');
    writeFileSync(join(t.dir, 'extra.txt'), 'extra\n');
    git(t.dir, 'add', '.');
    git(t.dir, 'commit', '-q', '-m', 'extra');
    mkdirSync(archive, { recursive: true });
    const manual = join(archive, 'manual');
    mkdirSync(manual);
    writeFileSync(
      join(manual, 'manifest.json'),
      JSON.stringify({ version: 1, verified: true, originalPath: '/etc', identity: 'forged' }),
    );
    const removed: string[] = [];
    const result = await preserveThenRemove(
      t,
      archive,
      { workRoot, confirmIdle: idle },
      undefined,
      async () => {
        removed.push(t.dir);
        rmSync(t.dir, { recursive: true, force: true });
        return { gone: false };
      },
    );
    expect(removed).toEqual([t.dir]);
    expect(result.archivedTo).toBeDefined();
    expect(result.archivedTo).not.toBe(manual);
    expect(existsSync(join(manual, 'manifest.json'))).toBe(true);
    expect(existsSync(join(result.archivedTo as string, 'manifest.json'))).toBe(true);
    expect(existsSync(join(result.archivedTo as string, 'receipt.json'))).toBe(false);
  });

  it('同时清理只有一轮能删，另一轮留树', async () => {
    const t = tree();
    dirtyFile(t);
    let removes = 0;
    const remove = async () => {
      removes += 1;
      if (removes === 1) rmSync(t.dir, { recursive: true, force: true });
      return { gone: false };
    };
    const once = () => preserveThenRemove(t, archive, { workRoot, confirmIdle: idle }, undefined, remove);
    const [left, right] = await Promise.allSettled([once(), once()]);
    const fulfilled = [left, right].filter((item) => item.status === 'fulfilled');
    const rejected = [left, right].filter((item) => item.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(removes).toBe(1);
    expect(existsSync(t.dir)).toBe(false);
  });

  it('未推提交、stash、冲突索引、合并状态和工作文件能在独立仓完整恢复后才删除', async () => {
    const t = tree('acme_web/12-keep', forbidMutations(localExec()));
    const dir = t.dir;
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'user.email', 'fleet-test@localhost');
    writeFileSync(join(dir, 'base.txt'), 'base\n');
    writeFileSync(join(dir, 'conflict.txt'), 'ancestor\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'base');
    const base = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'update-ref', 'refs/fleet/incoming', base);
    writeFileSync(join(dir, 'extra.txt'), 'extra\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'extra');
    git(dir, 'tag', 'unpushed-tag');
    writeFileSync(join(dir, 'stash-1.txt'), 's1\n');
    writeFileSync(join(dir, 'stash-untracked.txt'), 'su\n');
    git(dir, 'add', 'stash-1.txt');
    git(dir, 'stash', 'push', '-u', '-m', 'first stash');
    writeFileSync(join(dir, 'stash-2.txt'), 's2\n');
    git(dir, 'add', 'stash-2.txt');
    git(dir, 'stash', 'push', '-m', 'second stash');
    git(dir, 'checkout', '-q', '-b', 'side');
    writeFileSync(join(dir, 'side-only.txt'), 'only\n');
    writeFileSync(join(dir, 'conflict.txt'), 'side\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'side');
    git(dir, 'checkout', '-q', 'main');
    writeFileSync(join(dir, 'conflict.txt'), 'main\n');
    git(dir, 'add', 'conflict.txt');
    git(dir, 'commit', '-q', '-m', 'main side');
    const merged = runChild('git', ['merge', '--no-edit', 'side'], { cwd: dir, env: cleanEnv() });
    expect(merged.status).toBe(1);
    writeFileSync(join(dir, 'base.txt'), 'changed\n');
    writeFileSync(join(dir, 'work.txt'), 'work\n');
    writeFileSync(join(dir, 'staged-new.txt'), 'staged\n');
    git(dir, 'add', 'staged-new.txt');
    writeFileSync(join(dir, 'untracked.txt'), '#!/bin/sh\n');
    chmodSync(join(dir, 'untracked.txt'), 0o755);
    symlinkSync('untracked.txt', join(dir, 'link.txt'));
    writeFileSync(join(dir, 'untracked.bin'), Buffer.from([0, 255, 10]));
    mkdirSync(join(dir, 'empty-dir'));
    mkdirSync(join(dir, 'notes'));
    writeFileSync(join(dir, 'notes', 'keep.txt'), 'note\n');
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules', 'skip.txt'), 'skip\n');
    writeFileSync(join(dir, 'tsconfig.tsbuildinfo'), '{}\n');
    mkdirSync(join(dir, '.fleet-out'));
    writeFileSync(join(dir, '.fleet-out', 'note.md'), 'out\n');
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.json'), '{}\n');
    writeFileSync(join(dir, 'keep-real.txt'), 'keep\n');
    symlinkSync('/etc/hostname', join(dir, 'outside.link'));
    const other = join(root, 'other');
    mkdirSync(other);
    git(other, 'init', '-q', '-b', 'main');
    writeFileSync(join(other, 'borrowed.txt'), 'borrowed\n');
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', 'borrowed');
    const borrowed = git(other, 'rev-parse', 'HEAD');
    mkdirSync(join(dir, '.git', 'objects', 'info'), { recursive: true });
    writeFileSync(join(dir, '.git', 'objects', 'info', 'alternates'), `${join(other, '.git', 'objects')}\n`);
    git(dir, 'update-ref', 'refs/tags/borrowed', borrowed);
    expect(git(dir, 'cat-file', '-t', borrowed)).toBe('commit');
    expect(existsSync(join(dir, '.git', 'objects', borrowed.slice(0, 2), borrowed.slice(2)))).toBe(false);
    chmodSync(dir, 0o700);

    const head = git(dir, 'rev-parse', 'HEAD');
    const index = git(dir, '-c', 'core.quotePath=false', 'ls-files', '--stage');
    expect(index).toMatch(/^100644 [0-9a-f]{40} 1\tconflict\.txt$/m);
    expect(index).toMatch(/^100644 [0-9a-f]{40} 2\tconflict\.txt$/m);
    expect(index).toMatch(/^100644 [0-9a-f]{40} 3\tconflict\.txt$/m);
    expect(index).toMatch(/^100644 [0-9a-f]{40} 0\tside-only\.txt$/m);
    const stashLog = git(dir, 'log', '-g', '--format=%H%x09%gs', 'refs/stash').trim();
    const stashShas = stashLog.split('\n').map((line) => line.split('\t')[0] ?? '');
    const parentCounts = stashShas.map(
      (sha) => git(dir, 'rev-parse', `${sha}^@`).split('\n').filter(Boolean).length,
    );
    expect(parentCounts.sort((a, b) => a - b)).toEqual([2, 3]);
    const untrackedStash = stashShas.find(
      (sha) => git(dir, 'rev-parse', `${sha}^@`).split('\n').filter(Boolean).length === 3,
    );
    const untrackedParent = git(dir, 'rev-parse', `${untrackedStash}^3`).trim();
    expect(git(dir, 'ls-tree', '-r', '--name-only', untrackedParent)).toContain('stash-untracked.txt');
    const parents = new Map(stashShas.map((sha) => [sha, git(dir, 'rev-parse', `${sha}^@`).trim()]));
    const mergeNames = ['MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE', 'ORIG_HEAD', 'AUTO_MERGE'];
    const merge = mergeNames.map((name) => {
      expect(existsSync(join(dir, '.git', name)), name).toBe(true);
      return { name, bytes: readFileSync(join(dir, '.git', name)) };
    });
    const files = new Map<string, SourceFile>();
    const walk = (rel: string) => {
      for (const name of readdirSync(rel ? join(dir, rel) : dir)) {
        const path = rel ? `${rel}/${name}` : name;
        if (path === '.git' || path.startsWith('.git/')) continue;
        const st = lstatSync(join(dir, path));
        if (st.isDirectory()) {
          if (readdirSync(join(dir, path)).length === 0)
            files.set(path, { kind: 'dir', mode: st.mode & 0o777 });
          else walk(path);
          continue;
        }
        if (st.isSymbolicLink()) {
          files.set(path, { kind: 'symlink', mode: st.mode & 0o777, link: readlinkSync(join(dir, path)) });
        } else if (st.isFile()) {
          files.set(path, { kind: 'file', mode: st.mode & 0o777, bytes: readFileSync(join(dir, path)) });
        }
      }
    };
    walk('');
    const oids = listedOids(dir);
    expect(oids.has(borrowed)).toBe(true);
    const removed: string[] = [];
    const result = await preserveThenRemove(
      t,
      archive,
      { workRoot, confirmIdle: idle },
      undefined,
      async () => {
        const saved = archives();
        expect(saved).toHaveLength(1);
        const state = JSON.parse(readFileSync(join(archive, saved[0] as string, 'state.json'), 'utf8')) as {
          files: { path: string }[];
          ignored: { path: string; rule: string }[];
          objects: { sha: string }[];
        };
        cover(dir, state);
        expect(state.objects.some((obj) => obj.sha === borrowed)).toBe(true);
        removed.push(t.dir);
        rmSync(dir, { recursive: true, force: true });
        return { gone: false };
      },
    );
    expect(removed).toEqual([dir]);
    expect(existsSync(dir)).toBe(false);
    rmSync(other, { recursive: true, force: true });
    const restored = restoreArchive(result.archivedTo as string, join(root, 'restored'));
    expect(gitClean(restored, ['rev-parse', 'HEAD']).trim()).toBe(head);
    expect(gitClean(restored, ['symbolic-ref', 'HEAD']).trim()).toBe('refs/heads/main');
    expect(gitClean(restored, ['-c', 'core.quotePath=false', 'ls-files', '--stage']).trim()).toBe(index);
    expect(gitClean(restored, ['log', '-g', '--format=%H%x09%gs', 'refs/stash']).trim()).toBe(stashLog);
    for (const [sha, text] of parents) {
      expect(gitClean(restored, ['rev-parse', `${sha}^@`]).trim()).toBe(text);
    }
    expect(gitClean(restored, ['ls-tree', '-r', '--name-only', untrackedParent])).toContain(
      'stash-untracked.txt',
    );
    expect(gitClean(restored, ['rev-parse', 'unpushed-tag^{commit}']).trim()).not.toBe(head);
    expect(gitClean(restored, ['cat-file', '-t', borrowed]).trim()).toBe('commit');
    for (const sha of oids) gitClean(restored, ['cat-file', '-e', sha]);
    const gitDir = gitClean(restored, ['rev-parse', '--absolute-git-dir']).trim();
    for (const item of merge) expect(readFileSync(join(gitDir, item.name))).toEqual(item.bytes);
    for (const [path, info] of files) {
      if (path === 'node_modules' || path.startsWith('node_modules/')) continue;
      if (path === '.fleet-out' || path.startsWith('.fleet-out/')) continue;
      if (path === 'tsconfig.tsbuildinfo' || path === '.claude/settings.json') continue;
      const abs = join(restored, path);
      const st = lstatSync(abs);
      if (info.kind === 'symlink') expect(readlinkSync(abs)).toBe(info.link);
      else if (info.kind === 'dir') expect(st.isDirectory()).toBe(true);
      else {
        expect(readFileSync(abs)).toEqual(info.bytes);
        expect(st.mode & 0o777).toBe(info.mode);
      }
    }
    expect(readlinkSync(join(restored, 'outside.link'))).toBe('/etc/hostname');
    expect(readFileSync(join(restored, 'keep-real.txt'), 'utf8')).toBe('keep\n');
    expect((lstatSync(join(restored, 'untracked.txt')).mode & 0o777) === 0o755).toBe(true);
    const receipt = JSON.parse(readFileSync(join(result.archivedTo as string, 'receipt.json'), 'utf8')) as {
      kind: string;
      originalPath: string;
      head: string;
      fingerprint: string;
    };
    expect(receipt).toMatchObject({ kind: 'complex', originalPath: dir, head });
    expect(receipt.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  }, 180_000);

  it('链接工作树只删自己，对象不靠主仓也能恢复', async () => {
    const main = tree('acme_web/12-keep');
    git(main.dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(main.dir, 'base.txt'), 'base\n');
    git(main.dir, 'add', '.');
    git(main.dir, 'commit', '-q', '-m', 'base');
    const side = join(workRoot, 'acme_web', '12-side');
    git(main.dir, 'worktree', 'add', '-q', side, 'HEAD');
    writeFileSync(join(side, 'linked-dirty.txt'), 'linked\n');
    const body = readFileSync(join(side, 'linked-dirty.txt'));
    const linked: UserTree = { ...main, dir: side };
    const result = await preserveThenRemove(
      linked,
      archive,
      { workRoot, confirmIdle: idle },
      undefined,
      async () => {
        rmSync(side, { recursive: true, force: true });
        return { gone: false };
      },
    );
    expect(existsSync(main.dir)).toBe(true);
    expect(existsSync(side)).toBe(false);
    rmSync(main.dir, { recursive: true, force: true });
    const restored = restoreArchive(result.archivedTo as string, join(root, 'linked-restored'));
    expect(readFileSync(join(restored, 'linked-dirty.txt'))).toEqual(body);
    expect(existsSync(join(restored, '.git', 'objects', 'info', 'alternates'))).toBe(false);
    expect(gitClean(restored, ['rev-parse', 'HEAD^{commit}']).trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it('标准清扫只在独立恢复通过后删复杂树，确认不了或非 Git 就留着', async () => {
    const owners = new Map<string, typeof USER>();
    const gitDir = join(workRoot, 'acme_web', '12-keep');
    mkdirSync(gitDir, { recursive: true });
    git(gitDir, 'init', '-q', '-b', 'main');
    writeFileSync(join(gitDir, 'base.txt'), 'base\n');
    git(gitDir, 'add', '.');
    git(gitDir, 'commit', '-q', '-m', 'base');
    git(gitDir, 'update-ref', 'refs/fleet/incoming', 'HEAD');
    writeFileSync(join(gitDir, 'half-done.ts'), 'x\n');
    const notes = join(workRoot, 'acme_web', '12-notes');
    mkdirSync(notes, { recursive: true });
    writeFileSync(join(notes, 'hello.txt'), 'keep\n');
    owners.set(gitDir, USER);
    owners.set(notes, USER);
    mkdirSync(join(root, 'real-repo'));
    writeFileSync(join(root, 'real-repo', 'secret.txt'), 'no\n');
    symlinkSync(join(root, 'real-repo'), join(workRoot, 'evil_repo'));
    const removed: string[] = [];
    const workflows = {
      async state(): Promise<{ state: 'missing' }> {
        return { state: 'missing' };
      },
    };
    const run = await sweepWorktrees(
      {
        root: workRoot,
        probeDir: PROBE_DIR,
        sessionTmpDir: SESSION_TMP_DIR,
        machine: '法国',
        async listDir(dir) {
          return readdirSync(dir, { withFileTypes: true }).map((entry) => ({
            name: entry.name,
            isDir: entry.isDirectory(),
          }));
        },
        treeFor: layout(workRoot).treeFor,
        async ownerOf(dir) {
          return owners.get(dir) ?? null;
        },
        leftovers: (dir, user, known, scratch) =>
          treeLeftovers({ exec: localExec(), user, dir, scopePrefix: 'sweep', git: 'git', sh: 'sh' }, known, {
            scratch,
          }),
        async remove(dir) {
          const user = owners.get(dir);
          if (!user) return { gone: true };
          const answer = await confirmDeletionIdle({
            root: workRoot,
            dir,
            openSessions: async () => [],
            workflows,
            issue: async () => null,
          });
          if (answer !== 'idle') {
            throw new PortError('WORKTREE_PRESERVED', `${dir} 删除前确认不了没人用，保留原树`, {
              retryable: false,
            });
          }
          await preserveThenRemove(
            { exec: localExec(), user, dir, scopePrefix: 'sweep-preserve', git: 'git', sh: 'sh' },
            archive,
            {
              workRoot,
              confirmIdle: () =>
                confirmDeletionIdle({
                  root: workRoot,
                  dir,
                  openSessions: async () => [],
                  workflows,
                  issue: async () => null,
                }),
            },
            undefined,
            async () => {
              removed.push(dir);
              owners.delete(dir);
              rmSync(dir, { recursive: true, force: true });
              return { gone: false };
            },
          );
          return { gone: false };
        },
        async keepShots() {
          return { outcome: 'none', head: '', branch: '', files: [] };
        },
        async issue() {
          return null;
        },
        async prHeads() {
          return [];
        },
        async subtaskTrees() {
          return [];
        },
        async openSessions() {
          return [];
        },
        workflows,
        alerts: {
          async listOpen() {
            return { alerts: [], truncated: false };
          },
          async byKey() {
            return null;
          },
          async latestByPrefix() {
            return null;
          },
          async resolve() {
            return 'not_found' as const;
          },
          async raise() {},
          async insertOnce() {
            return { created: false };
          },
          async updateOpen() {
            return 'ok' as const;
          },
        },
        log() {},
      },
      [],
    );
    expect(removed).toEqual([gitDir]);
    expect(run.inventory.removed).toContain('acme_web/12-keep');
    expect(run.inventory.removed).not.toContain('acme_web/12-notes');
    expect(existsSync(gitDir)).toBe(false);
    expect(readFileSync(join(notes, 'hello.txt'), 'utf8')).toBe('keep\n');
    expect(readFileSync(join(root, 'real-repo', 'secret.txt'), 'utf8')).toBe('no\n');
    expect(run.unchecked.join('\n')).toContain('保留原树供接管');
    const saved = archives();
    expect(saved.length).toBeGreaterThan(0);
    const state = JSON.parse(readFileSync(join(archive, saved[0] as string, 'state.json'), 'utf8')) as {
      files: { path: string }[];
    };
    expect(state.files.some((file) => file.path === 'half-done.ts')).toBe(true);

    const again = tree('acme_web/12-keep');
    dirtyFile(again);
    owners.set(again.dir, USER);
    const blocked = await sweepWorktrees(
      {
        root: workRoot,
        probeDir: PROBE_DIR,
        sessionTmpDir: SESSION_TMP_DIR,
        machine: '法国',
        async listDir(dir) {
          return readdirSync(dir, { withFileTypes: true }).map((entry) => ({
            name: entry.name,
            isDir: entry.isDirectory(),
          }));
        },
        treeFor: layout(workRoot).treeFor,
        async ownerOf(dir) {
          return owners.get(dir) ?? null;
        },
        leftovers: (dir, user, known, scratch) =>
          treeLeftovers({ exec: localExec(), user, dir, scopePrefix: 'sweep', git: 'git', sh: 'sh' }, known, {
            scratch,
          }),
        async remove(dir) {
          throw new PortError(
            'WORKTREE_PRESERVED',
            `${await confirmDeletionIdle({
              root: workRoot,
              dir,
              openSessions: async () => {
                throw new Error('会话账读不了');
              },
              workflows,
              issue: async () => null,
            })} 删除前确认不了没人用，保留原树`,
            { retryable: false },
          );
        },
        async keepShots() {
          return { outcome: 'none', head: '', branch: '', files: [] };
        },
        async issue() {
          return null;
        },
        async prHeads() {
          return [];
        },
        async subtaskTrees() {
          return [];
        },
        async openSessions() {
          return [];
        },
        workflows,
        alerts: {
          async listOpen() {
            return { alerts: [], truncated: false };
          },
          async byKey() {
            return null;
          },
          async latestByPrefix() {
            return null;
          },
          async resolve() {
            return 'not_found' as const;
          },
          async raise() {},
          async insertOnce() {
            return { created: false };
          },
          async updateOpen() {
            return 'ok' as const;
          },
        },
        log() {},
      },
      [],
    );
    expect(existsSync(again.dir)).toBe(true);
    expect(blocked.inventory.removed).not.toContain('acme_web/12-keep');
    expect(blocked.unchecked.join('\n')).toContain('unknown');
  });
});
