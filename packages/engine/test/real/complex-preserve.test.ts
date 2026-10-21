// 复杂脏工作树：独立恢复对上、原树没变、没人用，才允许清理入口删树。失败留树，人工备份不是回执。
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomFillSync } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { subtaskWorkflowId, taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  confirmDeletionIdle,
  confirmManagedTreeIdle,
  sweepWorktrees,
  type WorktreeSweepDeps,
} from '../../src/jobs/worktree-sweep.ts';
import { PortError } from '../../src/ports.ts';
import {
  archiveFrame,
  assertArchiveContainer,
  cleanupLockPath,
  holdCleanupLock,
  ignoreRuleAllowed,
  locateTree,
  makeArchiveDir,
  type ProcLook,
  recheckPreservedArchive,
  treeProcessUsage,
  writeExclusiveArchive,
} from '../../src/real/complex-preserve.ts';
import { localExec, type UserExec } from '../../src/real/exec.ts';
import { preserveThenRemove, preserveWorktree } from '../../src/real/preserve-worktree.ts';
import { PROBE_DIR } from '../../src/real/route-probe.ts';
import { SnapshotFrameReader } from '../../src/real/snapshot-frame.ts';
import { DISPOSABLE, ENVIRONMENT_FILES, treeLeftovers, type UserTree } from '../../src/real/user-git.ts';
import { layout, SESSION_TMP_DIR } from '../../src/real/worktrees.ts';
import { runChild, runChildBytes } from '../child.ts';
import { fixtureProcLook, git } from './fixtures.ts';

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

/** 没人用的夹具门：工作根、会话和工作流都答没人用，进程看夹具（不跟测试机的进程表走）。 */
function gate() {
  return { workRoot, confirmIdle: idle, processLook: fixtureProcLook };
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
    indexBlob?: string;
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
  const gitDir = gitClean(repo, ['rev-parse', '--absolute-git-dir']).trim();
  if (state.indexBlob) {
    const indexBytes = readFileSync(join(saved, 'blobs', state.indexBlob));
    expect(sha256(indexBytes)).toBe(state.indexBlob);
    writeFileSync(join(gitDir, 'index'), indexBytes);
  } else {
    gitClean(repo, ['update-index', '--index-info'], Buffer.from(state.indexInfo));
  }
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

const deniedCwd = Object.assign(new Error('denied'), { code: 'EACCES' });

function procLook(
  over: Partial<{
    list: () => Promise<readonly string[]>;
    cwd: (pid: number) => Promise<string>;
    uid: (pid: number) => Promise<string | null>;
  }> = {},
): ProcLook {
  return {
    list: over.list ?? (async () => ['1']),
    cwd: over.cwd ?? (async () => '/work/tree/src'),
    uid: over.uid ?? (async () => '1'),
  };
}

function reachableCommits(dir: string): Set<string> {
  const text = git(dir, 'rev-list', '--objects', '--all', '--reflog');
  return new Set(
    text
      .split('\n')
      .map((line) => line.split(/[\s]/)[0] ?? '')
      .filter((sha) => /^[0-9a-f]{40}$/.test(sha)),
  );
}

/** 只解开对象包，不抓成果包。伪引用上的提交、resolve-undo 指的内容必须已经在包里。 */
function assertPackHasCommits(pack: Buffer, shas: readonly string[], label: string, type = 'commit'): void {
  const bare = join(root, `pack-${label}`);
  gitClean(root, ['init', '--bare', '-q', bare]);
  gitClean(bare, ['unpack-objects'], pack);
  for (const sha of shas) {
    expect(gitClean(bare, ['cat-file', '-t', sha]).trim()).toBe(type);
    gitClean(bare, ['cat-file', '-e', sha]);
  }
}

/** 三层冲突只经 resolve-undo 指着：内容另写进对象库，不在引用、reflog、当前索引里。 */
function resolveUndoOnly(t: UserTree): string[] {
  const blobs = ['base', 'ours', 'theirs'].map((side) =>
    gitClean(t.dir, ['hash-object', '-w', '--stdin'], Buffer.from(`reuc-${side}\n`)).trim(),
  );
  const info = blobs.map((sha, i) => `100644 ${sha} ${i + 1}\tconflict.txt\n`).join('');
  gitClean(t.dir, ['update-index', '--index-info'], Buffer.from(info));
  writeFileSync(join(t.dir, 'conflict.txt'), 'resolved\n');
  git(t.dir, 'add', 'conflict.txt');
  expect(gitClean(t.dir, ['ls-files', '--resolve-undo']).split('\n').filter(Boolean)).toEqual(
    blobs.map((sha, i) => `100644 ${sha} ${i + 1}\tconflict.txt`),
  );
  const reachable = reachableCommits(t.dir);
  const staged = gitClean(t.dir, ['ls-files', '--stage']);
  for (const sha of blobs) {
    expect(reachable.has(sha)).toBe(false);
    expect(staged).not.toContain(sha);
  }
  return blobs;
}

function sweepDeps(
  owners: Map<string, typeof USER>,
  remove: (dir: string) => Promise<{ gone: boolean }>,
): WorktreeSweepDeps {
  return {
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
    remove,
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
    workflows: {
      async state() {
        return { state: 'missing' };
      },
    },
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
        return 'not_found';
      },
      async raise() {},
      async insertOnce() {
        return { created: false };
      },
      async updateOpen() {
        return 'ok';
      },
    },
    log() {},
  };
}

describe('复杂工作树受管保全', { timeout: 180_000 }, () => {
  it('BUNDLE完整也不能补坏PACK，超大对象头及缺END均从真实verify入口拒绝留源', async () => {
    const t = tree('bad-stream/3213-keep');
    dirtyFile(t);
    const fixture = JSON.parse(
      readFileSync(new URL('./snapshot-fixtures/v3-2b81d9ae.json', import.meta.url), 'utf8'),
    );
    const components = new Map<string, Buffer>();
    let name = '';
    let chunks: Buffer[] = [];
    const parser = new SnapshotFrameReader({
      begin: async (component) => {
        name = component.name;
        chunks = [];
      },
      write: async (chunk) => {
        chunks.push(Buffer.from(chunk));
      },
      end: async () => {
        components.set(name, Buffer.concat(chunks));
      },
    });
    await parser.write(Buffer.from(fixture.frameBase64, 'base64'));
    parser.finish();
    const frame = (pack?: Buffer) => {
      const parts: Buffer[] = [];
      for (const [key, bytes] of components) {
        const value = key === 'PACK' && pack ? pack : bytes;
        parts.push(Buffer.from(`${key} ${value.length}\n`), value);
      }
      parts.push(Buffer.from('END\n'));
      return Buffer.concat(parts);
    };
    const bundle = components.get('BUNDLE');
    if (!bundle) throw new Error('旧夹具缺BUNDLE');
    const bundlePath = join(root, 'intact.bundle');
    writeFileSync(bundlePath, bundle);
    gitClean(t.dir, ['bundle', 'verify', bundlePath]);
    const head = gitClean(t.dir, ['rev-parse', 'HEAD']);
    const script = readFileSync(new URL('../../src/real/complex-snapshot.mjs', import.meta.url), 'utf8');
    const objectHeader = [0x31 | 0x80];
    let size = Math.floor((256 * 1024 * 1024 + 1) / 16);
    while (size) {
      const part = size & 127;
      size = Math.floor(size / 128);
      objectHeader.push(part | (size ? 128 : 0));
    }
    const huge = Buffer.concat([
      Buffer.from('5041434b0000000200000003', 'hex'),
      Buffer.from(objectHeader),
      Buffer.alloc(20),
    ]);
    for (const [input, error] of [
      [frame(Buffer.from('broken independent pack')), /对象包头非法/],
      [frame(huge), /256MiB/],
      [frame().subarray(0, frame().length - 4), /帧不完整/],
      [Buffer.from('JSON 33554433\n'), /长度越界/],
    ] as const) {
      const result = await localExec()({
        user: USER,
        cwd: t.dir,
        argv: [process.execPath, '--input-type=module', '-e', script],
        stdin: input,
        timeoutMs: 10_000,
        scopeId: 'bad-snapshot-3213',
        env: { FLEET_SNAP_MODE: 'verify', FLEET_GIT: 'git' },
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(error);
      expect(readFileSync(join(t.dir, 'dirty.txt'), 'utf8')).toBe('dirty\n');
      expect(gitClean(t.dir, ['rev-parse', 'HEAD'])).toBe(head);
    }
  });
  it('capture超时SIGKILL后仍按本次身份回收大临时件，半归档没有receipt', async () => {
    const real = localExec();
    let scratch = '';
    const exec: UserExec = async (command) => {
      if (command.env?.FLEET_SNAP_MODE !== 'capture') return real(command);
      scratch = JSON.parse(command.env.FLEET_SNAP_TEMP ?? '{}').path;
      return real({
        ...command,
        timeoutMs: 150,
        argv: [
          process.execPath,
          '--input-type=module',
          '-e',
          `import{writeFileSync}from'node:fs';const t=JSON.parse(process.env.FLEET_SNAP_TEMP);writeFileSync(t.path+'/partial',Buffer.alloc(1048576));process.stdout.write('JSON 2\\n{');setInterval(()=>{},1000);`,
        ],
      });
    };
    const t = tree('timeout/3213-keep', exec);
    dirtyFile(t);
    await expect(preserveWorktree(t, archive, gate())).rejects.toThrow(/超时/);
    expect(scratch).not.toBe('');
    expect(existsSync(scratch)).toBe(false);
    for (const name of archives()) expect(existsSync(join(archive, name, 'receipt.json'))).toBe(false);
    expect(readFileSync(join(t.dir, 'dirty.txt'), 'utf8')).toBe('dirty\n');
  });

  it('临时事务被替换为源树链接时清理拒绝，绝不跟随链接删源', async () => {
    const real = localExec();
    let moved = '';
    let replacement = '';
    const t = tree('temp-swap/3213-keep');
    dirtyFile(t);
    const exec: UserExec = async (command) => {
      if (command.env?.FLEET_SNAP_TEMP_ACTION === 'cleanup' && !moved) {
        replacement = JSON.parse(command.env.FLEET_SNAP_TEMP ?? '{}').path;
        moved = `${replacement}-fixture-held`;
        renameSync(replacement, moved);
        symlinkSync(t.dir, replacement);
      }
      return real(command);
    };
    try {
      await expect(preserveWorktree({ ...t, exec }, archive, gate())).rejects.toThrow(/身份变化|未清理/);
      expect(readFileSync(join(t.dir, 'dirty.txt'), 'utf8')).toBe('dirty\n');
      expect(lstatSync(replacement).isSymbolicLink()).toBe(true);
    } finally {
      if (replacement) rmSync(replacement, { force: true, recursive: true });
      if (moved) rmSync(moved, { recursive: true, force: true });
    }
  });
  it('真实旧2b81d9ae helper生成的v3持久组件可由新reader回读并恢复', async () => {
    const fixture = JSON.parse(
      readFileSync(new URL('./snapshot-fixtures/v3-2b81d9ae.json', import.meta.url), 'utf8'),
    );
    expect(fixture.sourceHead).toBe('2b81d9ae15ba223525de7343bb0b5ef2c2ded9ca');
    const original = Buffer.from(fixture.frameBase64, 'base64');
    const saved = join(archive, 'worktree-legacy-v3');
    await assertArchiveContainer(archive);
    await makeArchiveDir(saved);
    await makeArchiveDir(join(saved, 'blobs'));
    const sums = new Map<string, string>();
    let name = '';
    let chunks: Buffer[] = [];
    const parser = new SnapshotFrameReader({
      begin: async (component) => {
        name = component.name;
        chunks = [];
      },
      write: async (chunk) => {
        chunks.push(Buffer.from(chunk));
      },
      end: async () => {
        const bytes = Buffer.concat(chunks);
        sums.set(name, sha256(bytes));
        const path =
          name === 'JSON'
            ? 'state.json'
            : name === 'PACK'
              ? 'objects.pack'
              : name === 'BUNDLE'
                ? 'recovery.bundle'
                : `blobs/${name.slice(5)}`;
        await writeExclusiveArchive(join(saved, path), bytes);
      },
    });
    await parser.write(original);
    parser.finish();
    const dir = restoreArchive(saved, join(workRoot, 'legacy-source'));
    const t: UserTree = {
      exec: localExec(),
      user: USER,
      dir,
      scopePrefix: 'legacy-v3',
      git: 'git',
      sh: 'sh',
    };
    const place = await locateTree(t);
    const state = JSON.parse(readFileSync(join(saved, 'state.json'), 'utf8'));
    const { ignored, ...comparable } = state;
    const artifacts = {
      state: sums.get('JSON'),
      pack: sums.get('PACK'),
      bundle: sums.get('BUNDLE'),
      blobs: [...sums.keys()]
        .filter((key) => key.startsWith('BLOB '))
        .map((key) => key.slice(5))
        .sort(),
    };
    // 夹具重新挂到本轮临时目录，只重绑定物理身份，保留旧状态/字节/指纹。
    await writeExclusiveArchive(
      join(saved, 'receipt.json'),
      Buffer.from(
        JSON.stringify({
          version: 3,
          kind: 'complex',
          originalPath: dir,
          realPath: place.real,
          dev: place.dev,
          ino: place.ino,
          uid: place.uid,
          head: state.head,
          fingerprint: sha256(Buffer.from(JSON.stringify(comparable))),
          ignored,
          preservedPaths: [],
          ignoreRules: [],
          artifacts,
        }),
      ),
    );
    const streamed: Buffer[] = [];
    for await (const bytes of archiveFrame(saved, artifacts as Parameters<typeof archiveFrame>[1]))
      streamed.push(bytes);
    expect(Buffer.concat(streamed)).toEqual(original);
    await recheckPreservedArchive(t, saved, gate(), place, []);
    expect(readFileSync(join(dir, 'unpublished.txt'), 'utf8')).toBe('legacy unpublished work\n');
  });
  it('40MiB随机成果跨旧110MiB帧界，capture/verify/recheck全通且原树不变', async () => {
    const real = localExec();
    let captured = 0;
    let verified = 0;
    const exec: UserExec = async (command) => {
      const output = command.snapshotStream?.output;
      if (command.env?.FLEET_SNAP_MODE === 'verify') verified += 1;
      if (command.env?.FLEET_SNAP_MODE !== 'capture' || !output) return real(command);
      return real({
        ...command,
        snapshotStream: {
          output: async (chunk, signal) => {
            captured += chunk.length;
            await output(chunk, signal);
          },
        },
      });
    };
    const t = tree('large/3213-keep', exec);
    git(t.dir, 'init', '-q', '-b', 'main');
    const payload = join(t.dir, 'payload.bin');
    const hash = createHash('sha256');
    const block = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < 40; i += 1) {
      randomFillSync(block);
      hash.update(block);
      appendFileSync(payload, block);
    }
    const expected = hash.digest('hex');
    git(t.dir, 'add', '.');
    git(t.dir, 'commit', '-q', '-m', 'large fixture');
    writeFileSync(join(t.dir, 'unpublished.txt'), 'must survive\n');
    const head = gitClean(t.dir, ['rev-parse', 'HEAD']);
    const saved = await preserveWorktree(t, archive, gate());
    if (!saved) throw new Error('未产生快照回执');
    expect(captured).toBeGreaterThan(110 * 1024 * 1024);
    await recheckPreservedArchive(t, saved, gate(), await locateTree(t), []);
    expect(verified).toBe(2);
    expect(sha256(readFileSync(payload))).toBe(expected);
    expect(gitClean(t.dir, ['rev-parse', 'HEAD'])).toBe(head);
    expect(readFileSync(join(t.dir, 'unpublished.txt'), 'utf8')).toBe('must survive\n');
    const receipt = JSON.parse(readFileSync(join(saved, 'receipt.json'), 'utf8'));
    expect(receipt.version).toBe(3);
  });

  it('旧v3组件的流reader与原buildFrame字节逐一相同', async () => {
    const t = tree();
    dirtyFile(t);
    const saved = await preserveWorktree(t, archive, gate());
    if (!saved) throw new Error('未产生快照回执');
    const receipt = JSON.parse(readFileSync(join(saved, 'receipt.json'), 'utf8'));
    // 原buildFrame算法原样作为oracle，只在这个小夹具里整包拼接。
    const parts: Buffer[] = [];
    const add = (name: string, bytes: Buffer) => {
      parts.push(Buffer.from(`${name} ${bytes.length}\n`), bytes);
    };
    add('JSON', readFileSync(join(saved, 'state.json')));
    add('PACK', readFileSync(join(saved, 'objects.pack')));
    add('BUNDLE', readFileSync(join(saved, 'recovery.bundle')));
    for (const sum of [...receipt.artifacts.blobs].sort())
      add(`BLOB ${sum}`, readFileSync(join(saved, 'blobs', sum)));
    parts.push(Buffer.from('END\n'));
    const streamed: Buffer[] = [];
    for await (const bytes of archiveFrame(saved, receipt.artifacts)) streamed.push(bytes);
    expect(Buffer.concat(streamed)).toEqual(Buffer.concat(parts));
    await recheckPreservedArchive(t, saved, gate(), await locateTree(t), []);
  });
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

  it('进程占用：树内 cwd 算在用；同主或树主读不了 cwd 算不清；别的用户读不到不算在用', async () => {
    const use = (look: ProcLook) => treeProcessUsage('/work/tree', '9', 10, 11, look);
    const deny = async () => Promise.reject(deniedCwd);
    expect(await use(procLook())).toBe('busy');
    expect(await use(procLook({ cwd: async () => '/work/tree (deleted)' }))).toBe('busy');
    expect(await use(procLook({ cwd: deny, uid: async () => '9' }))).toBe('unknown');
    expect(
      await use(
        procLook({
          cwd: deny,
          uid: async () => Promise.reject(Object.assign(new Error('status'), { code: 'EIO' })),
        }),
      ),
    ).toBe('unknown');
    expect(
      await use(
        procLook({
          list: async () => ['1', '2'],
          cwd: async (pid) => (pid === 1 ? deny() : '/work/tree/file'),
          uid: async () => '9',
        }),
      ),
    ).toBe('busy');
    expect(await use(procLook({ list: async () => Promise.reject(new Error('no proc')) }))).toBe('unknown');
    expect(
      await use(
        procLook({
          list: async () => ['1', '2'],
          cwd: async (pid) => (pid === 1 ? deny() : '/somewhere/else'),
          uid: async () => '5',
        }),
      ),
    ).toBe('idle');
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
    const missing = {
      async state(): Promise<{ state: 'missing' }> {
        return { state: 'missing' };
      },
    };
    const ask = (over: Partial<Parameters<typeof confirmDeletionIdle>[0]> = {}) =>
      confirmDeletionIdle({
        root: '/work',
        dir: '/work/acme_web/12-keep',
        openSessions: async () => [],
        workflows: missing,
        issue: async () => null,
        ...over,
      });
    expect(await ask({ dir: '/etc/passwd' })).toBe('unknown');
    expect(
      await ask({
        openSessions: async () => {
          throw new Error('会话账读不了');
        },
      }),
    ).toBe('unknown');
    expect(await ask({ openSessions: async () => [{ path: '/work/acme_web/12-keep' }] })).toBe('busy');
    expect(
      await ask({
        workflows: {
          async state() {
            return { state: 'running' as const };
          },
        },
      }),
    ).toBe('busy');
    expect(
      await ask({
        workflows: {
          async state() {
            throw new Error('temporal');
          },
        },
      }),
    ).toBe('unknown');
    expect(await ask()).toBe('idle');
    const taskId = taskWorkflowId({ owner: 'acme', name: 'web' }, 12);
    const redoId = taskWorkflowId({ owner: 'acme', name: 'web' }, 12, 2);
    const subId = subtaskWorkflowId('abc');
    const facts = async () => ({
      taskId: 't',
      state: 'queued' as const,
      subtasks: [{ id: 'abc', key: 'keep' }],
    });
    expect(
      await ask({
        exceptWorkflowId: taskId,
        issue: facts,
        workflows: {
          async state(id) {
            return id === taskId || id === subId
              ? { state: 'running' as const }
              : { state: 'missing' as const };
          },
        },
      }),
    ).toBe('busy');
    expect(
      await ask({
        exceptWorkflowId: taskId,
        issue: async () => null,
        workflows: {
          async state(id) {
            return id === taskId ? { state: 'running' as const } : { state: 'missing' as const };
          },
        },
      }),
    ).toBe('idle');
    expect(
      await ask({
        exceptWorkflowId: redoId,
        workflows: {
          async state(id) {
            return id === taskId ? { state: 'running' as const } : { state: 'missing' as const };
          },
        },
      }),
    ).toBe('busy');
    expect(
      await ask({
        exceptWorkflowId: subId,
        issue: facts,
        workflows: {
          async state(id) {
            return id === taskId ? { state: 'running' as const } : { state: 'missing' as const };
          },
        },
      }),
    ).toBe('busy');
    expect(
      await ask({
        exceptWorkflowId: subId,
        issue: facts,
        workflows: {
          async state(id) {
            return id === subId ? { state: 'running' as const } : { state: 'missing' as const };
          },
        },
      }),
    ).toBe('idle');
    expect(
      await confirmManagedTreeIdle({
        root: '/work',
        dir: '/work/acme_web/12-keep',
        openSessions: async () => [],
        issue: async () => null,
      }),
    ).toBe('unknown');
    expect(
      await confirmManagedTreeIdle({
        root: '/work',
        dir: '/work/acme_web/12-keep',
        openSessions: async () => [{ path: '/work/acme_web/12-keep' }],
        issue: async () => null,
      }),
    ).toBe('busy');
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
        { workRoot, confirmIdle: async () => 'unknown', processLook: fixtureProcLook },
        undefined,
        async () => {
          removed.push(t.dir);
          return { gone: false };
        },
      ),
    ).rejects.toThrow(/确认不了没人用/);
    await expect(
      preserveThenRemove(
        t,
        archive,
        { workRoot, confirmIdle: async () => 'busy', processLook: fixtureProcLook },
        undefined,
        async () => {
          removed.push(t.dir);
          return { gone: false };
        },
      ),
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
    await expect(preserveThenRemove(t, archive, gate(), undefined, remove)).rejects.toMatchObject({
      code: 'ARCHIVE_FAILED',
    });
    expect(readdirSync(secret)).toEqual([]);
    rmSync(archive, { recursive: true });

    const realParent = join(root, 'real-parent');
    mkdirSync(realParent);
    const linkParent = join(root, 'link-parent');
    symlinkSync(realParent, linkParent);
    await expect(
      preserveThenRemove(t, join(linkParent, 'archive'), gate(), undefined, remove),
    ).rejects.toMatchObject({ code: 'ARCHIVE_FAILED' });
    expect(existsSync(join(realParent, 'archive'))).toBe(false);

    const outside = tree('solo');
    dirtyFile(outside);
    await expect(preserveThenRemove(outside, archive, gate(), undefined, remove)).rejects.toThrow(/工作根/);
    const link = join(workRoot, 'acme_web', '12-link');
    symlinkSync(t.dir, link);
    await expect(
      preserveThenRemove({ ...t, dir: link }, archive, gate(), undefined, remove),
    ).rejects.toMatchObject({ code: 'WORKTREE_PRESERVED' });

    const notes = tree('acme_web/12-notes');
    writeFileSync(join(notes.dir, 'hello.txt'), 'keep\n');
    await expect(preserveThenRemove(notes, archive, gate(), undefined, remove)).rejects.toThrow(
      /保留原树供接管/,
    );
    expect(readFileSync(join(notes.dir, 'hello.txt'), 'utf8')).toBe('keep\n');
    expect(removed).toEqual([]);
    expect(existsSync(join(t.dir, 'dirty.txt'))).toBe(true);
  });

  it('有进程的 cwd 在树里就拒删（明示真实子进程夹具，root全表扫描另测）', async () => {
    const t = tree();
    dirtyFile(t);
    const child = spawn('sleep', ['30'], { cwd: t.dir, stdio: 'ignore' });
    children.push(child);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const removed: string[] = [];
    await expect(
      preserveThenRemove(
        t,
        archive,
        {
          workRoot,
          confirmIdle: idle,
          processLook: procLook({
            list: async () => [String(child.pid)],
            cwd: async (pid) => readlinkSync('/proc/' + pid + '/cwd'),
          }),
        },
        undefined,
        async () => {
          removed.push(t.dir);
          return { gone: false };
        },
      ),
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
      if (command.env?.FLEET_SNAP_MODE !== 'capture') return real(command);
      const output = command.snapshotStream?.output;
      if (!output) throw new Error('capture 必须走快照流');
      let left = 24;
      return real({
        ...command,
        snapshotStream: {
          output: async (chunk, signal) => {
            const take = Math.min(left, chunk.length);
            left -= take;
            if (take) await output(chunk.subarray(0, take), signal);
          },
        },
      });
    };
    await expect(
      preserveThenRemove({ ...t, exec: truncate }, archive, gate(), undefined, remove),
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
      preserveThenRemove({ ...t, exec: corrupt }, archive, gate(), undefined, remove),
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
      preserveThenRemove({ ...t, exec: dropBlob }, archive, gate(), undefined, remove),
    ).rejects.toThrow(/归档缺文件|哈希对不上|读不了/);
    expect(readFileSync(join(t.dir, 'dirty.txt'), 'utf8')).toBe('dirty\n');

    mkdirSync(join(t.dir, 'secret'));
    writeFileSync(join(t.dir, 'secret', 'a.txt'), 'hidden\n');
    chmodSync(join(t.dir, 'secret'), 0);
    try {
      await expect(preserveThenRemove(t, archive, gate(), undefined, remove)).rejects.toMatchObject({
        code: 'READ_FAILED',
        message: expect.stringContaining('读不了'),
      });
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
      preserveThenRemove({ ...t, exec: racing }, archive, gate(), undefined, async () => {
        removed.push(t.dir);
        return { gone: false };
      }),
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
          processLook: fixtureProcLook,
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
      preserveThenRemove({ ...t, exec: forged }, archive, gate(), undefined, async () => {
        removed.push('/etc');
        return { gone: false };
      }),
    ).rejects.toThrow(/对不上|作废/);
    expect(removed).toEqual([]);
    expect(existsSync(join(t.dir, 'dirty.txt'))).toBe(true);

    const saved = await preserveWorktree(t, archive, gate());
    writeFileSync(join(t.dir, 'after.txt'), 'after\n');
    const place = await locateTree(t);
    await expect(recheckPreservedArchive(t, saved as string, gate(), place, [])).rejects.toThrow(
      /作废|发生变化|对不上/,
    );
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
    const result = await preserveThenRemove(t, archive, gate(), undefined, async () => {
      removed.push(t.dir);
      rmSync(t.dir, { recursive: true, force: true });
      return { gone: false };
    });
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
    const once = () => preserveThenRemove(t, archive, gate(), undefined, remove);
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
    const result = await preserveThenRemove(t, archive, gate(), undefined, async () => {
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
    });
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
    const result = await preserveThenRemove(linked, archive, gate(), undefined, async () => {
      rmSync(side, { recursive: true, force: true });
      return { gone: false };
    });
    expect(existsSync(main.dir)).toBe(true);
    expect(existsSync(side)).toBe(false);
    rmSync(main.dir, { recursive: true, force: true });
    const restored = restoreArchive(result.archivedTo as string, join(root, 'linked-restored'));
    expect(readFileSync(join(restored, 'linked-dirty.txt'))).toEqual(body);
    expect(existsSync(join(restored, '.git', 'objects', 'info', 'alternates'))).toBe(false);
    expect(gitClean(restored, ['rev-parse', 'HEAD^{commit}']).trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it('浅克隆里有未提交文件：保全入口在采集前拒绝，不留回执、不删原树', async () => {
    const origin = join(root, 'shallow-origin');
    mkdirSync(origin);
    git(origin, 'init', '-q', '-b', 'main');
    for (const n of [1, 2, 3]) {
      writeFileSync(join(origin, 'a.txt'), `v${n}\n`);
      git(origin, 'add', '.');
      git(origin, 'commit', '-q', '-m', `c${n}`);
    }
    const t = tree('acme_web/12-shallow');
    rmSync(t.dir, { recursive: true, force: true });
    git(root, 'clone', '-q', '--depth=1', `file://${origin}`, t.dir);
    expect(git(t.dir, 'rev-parse', '--is-shallow-repository').trim()).toBe('true');
    writeFileSync(join(t.dir, 'dirty.txt'), 'dirty\n');
    const removed: string[] = [];
    await expect(
      preserveThenRemove(t, archive, gate(), undefined, async () => {
        removed.push(t.dir);
        return { gone: false };
      }),
    ).rejects.toThrow(/浅仓不能自包含保全，保留原树/);
    expect(removed).toEqual([]);
    expect(readFileSync(join(t.dir, 'dirty.txt'), 'utf8')).toBe('dirty\n');
    for (const name of archives()) expect(existsSync(join(archive, name, 'receipt.json'))).toBe(false);
  });

  it('多行 MERGE_HEAD 引用的提交进对象包，独立解包后还能 cat-file', async () => {
    const t = tree('acme_web/12-merge');
    dirtyFile(t);
    const treeHash = git(t.dir, 'rev-parse', 'HEAD^{tree}');
    const a = git(t.dir, 'commit-tree', treeHash, '-m', 'only-a');
    const b = git(t.dir, 'commit-tree', treeHash, '-m', 'only-b');
    writeFileSync(join(t.dir, '.git', 'MERGE_HEAD'), `${a}\n${b}\n`);
    git(t.dir, 'reflog', 'expire', '--expire=all', '--all');
    rmSync(join(t.dir, '.git', 'logs'), { recursive: true, force: true });
    const reachable = reachableCommits(t.dir);
    expect(reachable.has(a)).toBe(false);
    expect(reachable.has(b)).toBe(false);
    const saved = await preserveWorktree(t, archive, gate());
    assertPackHasCommits(readFileSync(join(saved as string, 'objects.pack')), [a, b], 'merge');
    expect(readFileSync(join(t.dir, 'dirty.txt'), 'utf8')).toBe('dirty\n');
  });

  it('cherry-pick 序列里没有别的引用的后续提交也会进对象包', async () => {
    const t = tree('acme_web/12-pick');
    const dir = t.dir;
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'user.email', 'fleet-test@localhost');
    writeFileSync(join(dir, 'base.txt'), 'base\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'base');
    git(dir, 'checkout', '-q', '-b', 'side');
    writeFileSync(join(dir, 'base.txt'), 'a\n');
    git(dir, 'commit', '-aq', '-m', 'A');
    const a = git(dir, 'rev-parse', 'HEAD');
    writeFileSync(join(dir, 'only-b.txt'), 'b\n');
    git(dir, 'add', 'only-b.txt');
    git(dir, 'commit', '-q', '-m', 'B');
    const b = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'checkout', '-q', 'main');
    writeFileSync(join(dir, 'base.txt'), 'main\n');
    git(dir, 'commit', '-aq', '-m', 'main');
    git(dir, 'update-ref', 'refs/fleet/incoming', 'HEAD');
    const picked = runChild('git', ['cherry-pick', a, b], { cwd: dir, env: cleanEnv() });
    expect(picked.status).not.toBe(0);
    expect(readFileSync(join(dir, '.git', 'sequencer', 'todo'), 'utf8')).toContain(b.slice(0, 7));
    git(dir, 'branch', '-D', 'side');
    git(dir, 'reflog', 'expire', '--expire=all', '--all');
    rmSync(join(dir, '.git', 'logs'), { recursive: true, force: true });
    expect(reachableCommits(dir).has(b)).toBe(false);
    const saved = await preserveWorktree(t, archive, gate());
    assertPackHasCommits(readFileSync(join(saved as string, 'objects.pack')), [a, b], 'pick');
    expect(existsSync(join(dir, 'base.txt'))).toBe(true);
  });

  it('只被 resolve-undo 指着的三层内容进对象包，独立恢复后还能把冲突找回来', async () => {
    const t = tree('acme_web/12-reuc');
    dirtyFile(t);
    const blobs = resolveUndoOnly(t);
    const saved = await preserveWorktree(t, archive, gate());
    assertPackHasCommits(readFileSync(join(saved as string, 'objects.pack')), blobs, 'reuc', 'blob');
    const state = JSON.parse(readFileSync(join(saved as string, 'state.json'), 'utf8')) as {
      resolveUndo: string;
      objects: { sha: string }[];
    };
    expect(state.resolveUndo).toBe(`conflict.txt\t${blobs.map((sha) => `100644 ${sha}`).join(' ')}`);
    for (const sha of blobs) expect(state.objects.map((item) => item.sha)).toContain(sha);
    const restored = restoreArchive(saved as string, join(root, 'reuc-restored'));
    gitClean(restored, ['checkout', '-m', '--', 'conflict.txt']);
    expect(gitClean(restored, ['ls-files', '-u']).split('\n').filter(Boolean)).toEqual(
      blobs.map((sha, i) => `100644 ${sha} ${i + 1}\tconflict.txt`),
    );
    expect(readFileSync(join(restored, 'conflict.txt'), 'utf8')).toContain('reuc-theirs');
    expect(readFileSync(join(t.dir, 'conflict.txt'), 'utf8')).toBe('resolved\n');
  });

  it('resolve-undo 指的内容在原仓缺了，拒删并留下原树', async () => {
    const t = tree('acme_web/12-reuc-gone');
    dirtyFile(t);
    const [, ours] = resolveUndoOnly(t);
    rmSync(join(t.dir, '.git', 'objects', (ours as string).slice(0, 2), (ours as string).slice(2)));
    const removed: string[] = [];
    await expect(
      preserveThenRemove(t, archive, gate(), undefined, async () => {
        removed.push(t.dir);
        return { gone: false };
      }),
    ).rejects.toThrow(/resolve-undo 指的对象缺失/);
    expect(removed).toEqual([]);
    expect(readFileSync(join(t.dir, 'conflict.txt'), 'utf8')).toBe('resolved\n');
  });

  it('认不出的序列状态拒绝删除并留下原树', async () => {
    const t = tree('acme_web/12-seq');
    dirtyFile(t);
    mkdirSync(join(t.dir, '.git', 'sequencer'));
    writeFileSync(join(t.dir, '.git', 'sequencer', 'message'), '不是提交\n');
    const removed: string[] = [];
    await expect(
      preserveThenRemove(t, archive, gate(), undefined, async () => {
        removed.push(t.dir);
        return { gone: false };
      }),
    ).rejects.toThrow(/不支持的序列状态/);
    expect(removed).toEqual([]);
    expect(readFileSync(join(t.dir, 'dirty.txt'), 'utf8')).toBe('dirty\n');
  });

  it('工作区干净但合并没做完：走完整快照，合并头和它的提交独立恢复后还在；没给门就留树', async () => {
    const t = tree('acme_web/12-merging');
    dirtyFile(t);
    rmSync(join(t.dir, 'dirty.txt'));
    git(t.dir, 'checkout', '-q', '-b', 'side');
    writeFileSync(join(t.dir, 'side.txt'), 'side\n');
    git(t.dir, 'add', 'side.txt');
    git(t.dir, 'commit', '-q', '-m', 'side');
    const side = git(t.dir, 'rev-parse', 'HEAD');
    git(t.dir, 'checkout', '-q', 'main');
    git(t.dir, 'merge', '--no-ff', '--no-commit', '-s', 'ours', 'side');
    git(t.dir, 'branch', '-D', 'side');
    const left = await treeLeftovers(t, []);
    expect(left).toMatchObject({ kind: 'repo', dirtyCount: 0, stashes: 0, unpushedCount: 0 });
    await expect(preserveWorktree(t, archive)).rejects.toThrow(/没做完的 git 操作/);
    const removed: string[] = [];
    const result = await preserveThenRemove(t, archive, gate(), undefined, async () => {
      removed.push(t.dir);
      return { gone: false };
    });
    expect(removed).toEqual([t.dir]);
    const saved = result.archivedTo as string;
    expect(JSON.parse(readFileSync(join(saved, 'receipt.json'), 'utf8')).kind).toBe('complex');
    assertPackHasCommits(readFileSync(join(saved, 'objects.pack')), [side], 'merging');
    const restored = restoreArchive(saved, join(root, 'merging-restored'));
    expect(gitClean(restored, ['rev-parse', 'MERGE_HEAD']).trim()).toBe(side);
    expect(gitClean(restored, ['status'])).toContain('All conflicts fixed but you are still merging');
  });

  it('干净成果包存好后又冒出没做完的操作，删除前拒绝', async () => {
    const t = tree('acme_web/12-late-merge');
    dirtyFile(t);
    rmSync(join(t.dir, 'dirty.txt'));
    writeFileSync(join(t.dir, 'work.txt'), 'work\n');
    git(t.dir, 'add', 'work.txt');
    git(t.dir, 'commit', '-q', '-m', 'unpushed');
    const saved = await preserveWorktree(t, archive, gate());
    expect(existsSync(join(saved as string, 'manifest.json'))).toBe(true);
    writeFileSync(join(t.dir, '.git', 'MERGE_HEAD'), `${git(t.dir, 'rev-parse', 'HEAD~1')}\n`);
    const place = await locateTree(t);
    await expect(recheckPreservedArchive(t, saved as string, gate(), place, [])).rejects.toThrow(
      /没做完的 git 操作/,
    );
    rmSync(join(t.dir, '.git', 'MERGE_HEAD'));
    git(t.dir, 'update-ref', 'refs/fleet/incoming', 'HEAD');
    writeFileSync(join(t.dir, '.git', 'CHERRY_PICK_HEAD'), `${git(t.dir, 'rev-parse', 'HEAD')}\n`);
    await expect(preserveWorktree(t, archive)).rejects.toThrow(/没做完的 git 操作/);
    expect(existsSync(join(t.dir, '.git', 'CHERRY_PICK_HEAD'))).toBe(true);
  });

  it('干净树和干净未推提交在删除点也现核进程：有人在树里或看不清就留树', async () => {
    const t = tree('acme_web/12-clean-busy');
    dirtyFile(t);
    rmSync(join(t.dir, 'dirty.txt'));
    const removed: string[] = [];
    const remove = async () => {
      removed.push(t.dir);
      return { gone: false };
    };
    const child = spawn('sleep', ['30'], { cwd: t.dir, stdio: 'ignore' });
    children.push(child);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(
      preserveThenRemove(
        t,
        archive,
        {
          workRoot,
          confirmIdle: idle,
          processLook: procLook({
            list: async () => [String(child.pid)],
            cwd: async (pid) => readlinkSync('/proc/' + pid + '/cwd'),
          }),
        },
        undefined,
        remove,
      ),
    ).rejects.toThrow(/有进程正用着这棵树/);
    child.kill('SIGKILL');
    const unreadable = procLook({
      list: async () => ['1'],
      cwd: async () => Promise.reject(deniedCwd),
      uid: async () => String(process.getuid?.() ?? 0),
    });
    await expect(
      preserveThenRemove(t, archive, { ...gate(), processLook: unreadable }, undefined, remove),
    ).rejects.toThrow(/确认不了有没有进程/);
    writeFileSync(join(t.dir, 'work.txt'), 'work\n');
    git(t.dir, 'add', 'work.txt');
    git(t.dir, 'commit', '-q', '-m', 'unpushed');
    await expect(
      preserveThenRemove(t, archive, { ...gate(), processLook: unreadable }, undefined, remove),
    ).rejects.toThrow(/确认不了有没有进程/);
    expect(removed).toEqual([]);
    expect(readFileSync(join(t.dir, 'work.txt'), 'utf8')).toBe('work\n');
    const done = await preserveThenRemove(t, archive, gate(), undefined, remove);
    expect(removed).toEqual([t.dir]);
    expect(existsSync(join(done.archivedTo as string, 'manifest.json'))).toBe(true);
  });

  it('变基做到一半：变基目录进快照名单，认不全就拒删，不静默漏掉', async () => {
    const t = tree('acme_web/12-rebase');
    dirtyFile(t);
    rmSync(join(t.dir, 'dirty.txt'));
    git(t.dir, 'checkout', '-q', '-b', 'side');
    writeFileSync(join(t.dir, 'base.txt'), 'side\n');
    git(t.dir, 'commit', '-qam', 'side');
    git(t.dir, 'checkout', '-q', 'main');
    writeFileSync(join(t.dir, 'base.txt'), 'main\n');
    git(t.dir, 'commit', '-qam', 'main');
    git(t.dir, 'checkout', '-q', 'side');
    const rebased = runChild('git', ['rebase', 'main'], { cwd: t.dir, env: cleanEnv() });
    expect(rebased.status).not.toBe(0);
    expect(existsSync(join(t.dir, '.git', 'rebase-merge'))).toBe(true);
    const removed: string[] = [];
    await expect(
      preserveThenRemove(t, archive, gate(), undefined, async () => {
        removed.push(t.dir);
        return { gone: false };
      }),
    ).rejects.toThrow(/不支持的序列状态 rebase-merge/);
    expect(removed).toEqual([]);
    expect(existsSync(join(t.dir, '.git', 'rebase-merge'))).toBe(true);
  });

  it('intent-to-add 和索引标志按原始索引恢复，标志变了旧回执作废', async () => {
    const t = tree('acme_web/12-intent');
    dirtyFile(t);
    writeFileSync(join(t.dir, 'kept.txt'), 'kept\n');
    git(t.dir, 'add', 'kept.txt');
    git(t.dir, 'commit', '-q', '-m', 'kept');
    git(t.dir, 'update-ref', 'refs/fleet/incoming', 'HEAD');
    writeFileSync(join(t.dir, 'new.txt'), 'intent\n');
    git(t.dir, 'add', '-N', 'new.txt');
    git(t.dir, 'update-index', '--skip-worktree', 'kept.txt');
    expect(gitClean(t.dir, ['status', '--porcelain', '--', 'new.txt'])).toBe(' A new.txt\n');
    const saved = await preserveWorktree(t, archive, gate());
    const restored = restoreArchive(saved as string, join(root, 'intent-restored'));
    expect(gitClean(restored, ['status', '--porcelain', '--', 'new.txt'])).toBe(' A new.txt\n');
    const flags = gitClean(restored, ['ls-files', '--debug']);
    expect(flags).toContain('flags: 20004000');
    expect(flags).toContain('flags: 40004000');
    git(t.dir, 'update-index', '--assume-unchanged', 'base.txt');
    const place = await locateTree(t);
    await expect(recheckPreservedArchive(t, saved as string, gate(), place, [])).rejects.toThrow(
      /作废|对不上/,
    );
    expect(readFileSync(join(t.dir, 'new.txt'), 'utf8')).toBe('intent\n');
    expect(gitClean(t.dir, ['ls-files', '--debug', '--', 'base.txt'])).toContain('flags: 8000');
  });

  it('只改回执里的 HEAD、指纹不动，删除前也拒绝', async () => {
    const t = tree();
    dirtyFile(t);
    const saved = await preserveWorktree(t, archive, gate());
    const receiptPath = join(saved as string, 'receipt.json');
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as { head: string; version: number };
    const realHead = receipt.head;
    receipt.head = 'a'.repeat(40);
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    const place = await locateTree(t);
    await expect(recheckPreservedArchive(t, saved as string, gate(), place, [])).rejects.toThrow(/HEAD/);
    expect(existsSync(join(t.dir, 'dirty.txt'))).toBe(true);
    receipt.version = 2;
    receipt.head = realHead;
    const old = join(archive, 'old-receipt');
    mkdirSync(old);
    writeFileSync(join(old, 'receipt.json'), `${JSON.stringify(receipt)}\n`);
    await expect(recheckPreservedArchive(t, old, gate(), place, [])).rejects.toThrow(/认不出/);
  });

  it('归档子目录或父路径换成指向树外的符号链接时拒写拒读，不删原树', async () => {
    const t = tree();
    dirtyFile(t);
    const outside = join(root, 'outside');
    mkdirSync(outside);
    const saved = await preserveWorktree(t, archive, gate());
    const blobs = join(saved as string, 'blobs');
    rmSync(blobs, { recursive: true, force: true });
    symlinkSync(outside, blobs);
    const place = await locateTree(t);
    await expect(recheckPreservedArchive(t, saved as string, gate(), place, [])).rejects.toThrow(/符号链接/);
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(t.dir, 'dirty.txt'))).toBe(true);

    symlinkSync(outside, join(archive, 'nested'));
    await expect(makeArchiveDir(join(archive, 'nested', 'child'))).rejects.toThrow(/符号链接/);
    await expect(
      writeExclusiveArchive(join(archive, 'nested', 'evil.txt'), Buffer.from('no')),
    ).rejects.toThrow(/符号链接/);
    expect(existsSync(join(outside, 'child'))).toBe(false);
    expect(existsSync(join(outside, 'evil.txt'))).toBe(false);

    const locks = join(archive, '.locks');
    if (existsSync(locks)) rmSync(locks, { recursive: true, force: true });
    symlinkSync(outside, locks);
    await expect(holdCleanupLock(archive, place)).rejects.toThrow(/符号链接/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('生产删树前问工作流，并且只豁免调用方自己的编号', () => {
    const index = readFileSync(fileURLToPath(new URL('../../src/real/index.ts', import.meta.url)), 'utf8');
    expect(index).toContain('confirmManagedTreeIdle');
    expect(index).toContain('exceptWorkflowId: caller.workflowId');
    const ports = readFileSync(
      fileURLToPath(new URL('../../src/real/github-ports.ts', import.meta.url)),
      'utf8',
    );
    expect(ports).toContain('confirmTreeIdle(tree.dir, { workflowId: ctx.workflowId })');
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
    const idleAnswer = (dir: string, openSessions: () => Promise<readonly { path: string }[]>) =>
      confirmDeletionIdle({ root: workRoot, dir, openSessions, workflows, issue: async () => null });
    const run = await sweepWorktrees(
      sweepDeps(owners, async (dir) => {
        const user = owners.get(dir);
        if (!user) return { gone: true };
        if ((await idleAnswer(dir, async () => [])) !== 'idle') {
          throw new PortError('WORKTREE_PRESERVED', `${dir} 删除前确认不了没人用，保留原树`, {
            retryable: false,
          });
        }
        await preserveThenRemove(
          { exec: localExec(), user, dir, scopePrefix: 'sweep-preserve', git: 'git', sh: 'sh' },
          archive,
          { workRoot, confirmIdle: () => idleAnswer(dir, async () => []), processLook: fixtureProcLook },
          undefined,
          async () => {
            removed.push(dir);
            owners.delete(dir);
            rmSync(dir, { recursive: true, force: true });
            return { gone: false };
          },
        );
        return { gone: false };
      }),
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
      sweepDeps(owners, async (dir) => {
        const answer = await idleAnswer(dir, async () => {
          throw new Error('会话账读不了');
        });
        throw new PortError('WORKTREE_PRESERVED', `${answer} 删除前确认不了没人用，保留原树`, {
          retryable: false,
        });
      }),
      [],
    );
    expect(existsSync(again.dir)).toBe(true);
    expect(blocked.inventory.removed).not.toContain('acme_web/12-keep');
    expect(blocked.unchecked.join('\n')).toContain('unknown');
  });
});
