// 真实 Git/文件系统回归：本地引用不是交付；树收掉以后也不能只信归档清单。
// fixture 只建在系统 tmp，init 后先核独立仓边界，再允许写对象；每次 Git 显式固定仓/工作树并隔离继承的 GIT_*。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, normalize, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserExec } from '../../src/real/exec.ts';
import {
  collectShots,
  gitBlobId,
  keepShotsBeforeRemove,
  preserveShots,
  recordedShots,
  SHOTS_LIMITS,
  shotsArchiveDir,
} from '../../src/real/shots.ts';
import type { UserTree } from '../../src/real/user-git.ts';

vi.setConfig({ testTimeout: 60_000 });

function executable(name: string): string {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const candidate = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(isAbsolute)
    .map((p) => join(p, name + suffix))
    .find(existsSync);
  if (!candidate) throw new Error(`真实 ${name}${suffix} 不在 PATH`);
  return realpathSync(candidate);
}

const GIT = executable('git');
const SH = executable('sh');
const HEAD = 'a'.repeat(40);
const input = { issueNumber: 2983, head: HEAD };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x31]);
let root: string;
let dir: string;
let archive: string;
let gitDir: string;
let env: NodeJS.ProcessEnv;

function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
}

function run(args: string[], bytes?: Buffer, cwd = dir, environment = env): Buffer {
  const r = spawnSync(GIT, args, { cwd, env: environment, input: bytes, timeout: 60_000 });
  if (r.status !== 0)
    throw new Error(`fixture git 失败 ${r.status}: ${r.error?.message ?? r.stderr.toString()}`);
  return r.stdout;
}

function git(args: string[], bytes?: Buffer): string {
  return run([`--git-dir=${gitDir}`, `--work-tree=${dir}`, ...args], bytes)
    .toString('utf8')
    .trim();
}

function assertOwnRepo(candidate: string): void {
  const ownGit = join(candidate, '.git');
  if (!lstatSync(ownGit).isDirectory() || lstatSync(ownGit).isSymbolicLink())
    throw new Error('fixture .git 不独立');
  for (const [flag, expected] of [
    ['--absolute-git-dir', ownGit],
    ['--show-toplevel', candidate],
  ] as const) {
    const got = run(['-C', candidate, 'rev-parse', flag], undefined, candidate).toString('utf8').trim();
    const canonical = (path: string) => {
      const actual = normalize(realpathSync.native(path));
      return process.platform === 'win32' ? actual.toLowerCase() : actual;
    };
    if (canonical(got) !== canonical(expected))
      throw new Error(`fixture 越出独立仓边界：${flag}=${got}，应为 ${expected}`);
  }
}

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fleet-shots-recovery-')));
  dir = join(root, 'tree');
  archive = join(root, 'archive');
  gitDir = join(dir, '.git');
  const emptyConfig = join(root, 'empty-config');
  writeFileSync(emptyConfig, '');
  env = {
    ...cleanEnv(),
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_SYSTEM: emptyConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CEILING_DIRECTORIES: root,
    GIT_DISCOVERY_ACROSS_FILESYSTEM: '0',
    GIT_AUTHOR_NAME: 'fixture',
    GIT_AUTHOR_EMAIL: 'fixture@localhost',
    GIT_COMMITTER_NAME: 'fixture',
    GIT_COMMITTER_EMAIL: 'fixture@localhost',
  };
  run(['init', '-q', '-b', 'main', dir], undefined, root);
  assertOwnRepo(dir);
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  git(['add', 'README.md']);
  git(['commit', '-q', '-m', 'code root']);
});

afterEach(() => {
  const safe = resolve(root);
  const name = safe.split(/[\\/]/).at(-1);
  if (
    !name ||
    safe !== resolve(realpathSync.native(tmpdir()), name) ||
    !name.startsWith('fleet-shots-recovery-')
  )
    throw new Error('fixture 清理越界');
  rmSync(safe, { recursive: true, force: true });
});

const exec: UserExec = async (command) => {
  const environment = {
    ...env,
    ...command.env,
    GIT_DIR: gitDir,
    GIT_COMMON_DIR: gitDir,
    GIT_WORK_TREE: dir,
    GIT_INDEX_FILE: join(gitDir, 'index'),
    GIT_OBJECT_DIRECTORY: join(gitDir, 'objects'),
  };
  const [program, ...args] = command.argv;
  if (!program) throw new Error('空 fixture 命令');
  const r = spawnSync(program, args, {
    cwd: command.cwd,
    env: environment,
    input: command.stdin,
    timeout: command.timeoutMs,
  });
  return {
    code: r.status,
    stdout: r.stdout ?? Buffer.alloc(0),
    stderr: r.stderr?.toString() ?? '',
    timedOut: (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT',
    aborted: false,
    ...(r.error ? { spawnError: r.error.message } : {}),
  };
};

function tree(): UserTree {
  return { exec, user: 'fleet-agent-carpool', dir, scopePrefix: 'shots-recovery-test', git: GIT, sh: SH };
}

function rootCommit(files: Record<string, Buffer> = { 'screen.png': PNG }, parent?: string): string {
  const entries = Object.entries(files)
    .map(([name, bytes]) => {
      const blob = git(['hash-object', '-w', '--stdin'], bytes);
      return `100644 blob ${blob}\t${name}\n`;
    })
    .join('');
  const treeId = git(['mktree'], Buffer.from(entries));
  return git([
    'commit-tree',
    treeId,
    ...(parent ? ['-p', parent] : []),
    '-m',
    `image ${Object.keys(files).join()}`,
  ]);
}

function deps() {
  return {
    archiveDir: archive,
    taskId: 'task-recovery',
    now: new Date('2026-10-18T00:00:00Z'),
    remote: async () => ({ head: null, blobs: new Set<string>() }),
  };
}

async function archived() {
  mkdirSync(join(dir, '_tmp/shots/after'), { recursive: true });
  // 原名 .jpg，实物 PNG：重试不能拿原名推断归档后缀。
  writeFileSync(join(dir, '_tmp/shots/after/screen.jpg'), PNG);
  const result = await preserveShots(tree(), input, deps());
  expect(result.outcome).toBe('archived');
  const location = shotsArchiveDir(archive, deps().taskId, HEAD);
  const manifest = join(location, 'manifest.json');
  const first = result.files[0];
  if (!first) throw new Error('fixture 归档漏图');
  const blob = join(location, `${first.sha256}.png`);
  rmSync(dir, { recursive: true, force: true });
  return { result, location, manifest, blob };
}

describe('本地引用中的图片根提交', () => {
  it('真实 Git 配置损坏时保留树，不能把仓探测失败当成没有图片', async () => {
    const commit = rootCommit();
    git(['update-ref', 'refs/heads/local-shots', commit]);
    writeFileSync(join(gitDir, 'config'), '[broken\n');
    const got = await keepShotsBeforeRemove(tree(), { ...deps(), issueNumber: input.issueNumber });
    expect(got.outcome).toBe('failed');
    expect(got.reason).toContain('bad config');
    expect(existsSync(dir)).toBe(true);
  });

  it('允许的最长图片名归档后仍能回读', async () => {
    const name = `${'s'.repeat(100)}.png`;
    mkdirSync(join(dir, '_tmp/shots/after'), { recursive: true });
    writeFileSync(join(dir, '_tmp/shots/after', name), PNG);
    const got = await preserveShots(tree(), input, deps());
    expect(got.outcome).toBe('archived');
    expect(got.files[0]?.path).toBe(`after/${name}`);
    expect(await recordedShots(archive, deps().taskId, input)).toEqual(got);
  });

  it.each(['refs/heads/local-shots', 'refs/tags/local-shots', 'refs/fleet/local-shots'])(
    '%s 指着的唯一图片副本仍归档，引用不算远端交付',
    async (ref) => {
      const commit = rootCommit();
      git(['update-ref', ref, commit]);
      const got = await preserveShots(tree(), input, deps());
      expect(got.outcome).toBe('archived');
      expect(got.files).toEqual([expect.objectContaining({ from: commit, blob: gitBlobId(PNG) })]);
      expect(await recordedShots(archive, deps().taskId, input)).toEqual(got);
    },
  );

  it('annotated tag、经子提交可达的根和多引用去重都收齐', async () => {
    const commit = rootCommit();
    const child = rootCommit({ 'child.png': Buffer.concat([PNG, Buffer.from('child')]) }, commit);
    git(['update-ref', 'refs/heads/local-shots', child]);
    git(['tag', '-a', 'shots-local', '-m', 'only local', commit]);
    git(['update-ref', 'refs/fleet/also-shots', commit]);
    const got = await collectShots(tree(), { ...SHOTS_LIMITS, maxOrphanCommits: 1 });
    expect(got.over).toBeUndefined();
    expect(got.found.map((f) => f.record.from)).toEqual([commit]);
  });

  it('detached HEAD 中的图片根也收，远端 blob 核过才算 delivered', async () => {
    const commit = rootCommit();
    git(['update-ref', '--no-deref', 'HEAD', commit]);
    const got = await preserveShots(tree(), input, {
      ...deps(),
      remote: async () => ({ head: commit, blobs: new Set([gitBlobId(PNG)]) }),
    });
    expect(got.outcome).toBe('delivered');
    expect(got.files[0]?.from).toBe(commit);
  });

  it('引用可达/不可达根共同受图片提交上限约束，不静默漏掉任一边', async () => {
    const reachable = rootCommit();
    git(['update-ref', 'refs/heads/local-shots', reachable]);
    rootCommit({ 'other.png': Buffer.concat([PNG, Buffer.from('other')]) });
    expect((await collectShots(tree(), { ...SHOTS_LIMITS, maxOrphanCommits: 1 })).over).toContain('超过 1');
  });

  it('带父图片提交和混代码/.env的根不收', async () => {
    const parent = git(['rev-parse', 'HEAD']);
    const child = rootCommit({ 'screen.png': PNG }, parent);
    const mixed = rootCommit({ 'screen.png': PNG, '.env': Buffer.from('SECRET=x') });
    git(['update-ref', 'refs/heads/child', child]);
    git(['update-ref', 'refs/heads/mixed', mixed]);
    expect((await collectShots(tree())).found).toEqual([]);
  });

  it('引用根读取失败不能当成没有图片', async () => {
    const t = tree();
    t.exec = async (command) =>
      command.argv.includes('rev-list')
        ? { code: 1, stdout: Buffer.alloc(0), stderr: 'broken refs', timedOut: false, aborted: false }
        : exec(command);
    expect((await preserveShots(t, input, deps())).outcome).toBe('failed');
  });

  it('合并后的根候选超过清点上限就明确失败，不挑前200个', async () => {
    const t = tree();
    const roots = Array.from({ length: 201 }, (_, n) => (n + 1).toString(16).padStart(40, '0'));
    t.exec = async (command) =>
      command.argv.includes('rev-list')
        ? {
            code: 0,
            stdout: Buffer.from(`${roots.join('\n')}\n`),
            stderr: '',
            timedOut: false,
            aborted: false,
          }
        : exec(command);
    const got = await preserveShots(t, input, deps());
    expect(got.outcome).toBe('failed');
    expect(got.reason).toContain('201 个，超过清点上限 200');
  });

  it('安全护栏拒绝假子目录借用父仓，父仓配置不变', () => {
    const child = join(dir, 'child');
    mkdirSync(child);
    const before = readFileSync(join(gitDir, 'config'));
    expect(() => assertOwnRepo(child)).toThrow();
    expect(readFileSync(join(gitDir, 'config'))).toEqual(before);
  });
});

describe('树已收后的归档实物核验', () => {
  it('旧清单无 kind、原名 .jpg 而实物 .png，完好归档仍原样回 archived', async () => {
    const { result } = await archived();
    expect(await recordedShots(archive, deps().taskId, input)).toEqual(result);
  });

  it.each(['missing', 'corrupt', 'directory', 'symlink', 'oversize'] as const)(
    '归档图片 %s 时回 unknown，保留已知清单',
    async (damage) => {
      const { result, blob } = await archived();
      rmSync(blob);
      if (damage === 'corrupt') writeFileSync(blob, Buffer.from('not an image'));
      if (damage === 'directory') mkdirSync(blob);
      if (damage === 'symlink') {
        const outside = join(root, 'outside.png');
        writeFileSync(outside, PNG);
        symlinkSync(outside, blob);
      }
      if (damage === 'oversize') {
        writeFileSync(blob, PNG);
        truncateSync(blob, SHOTS_LIMITS.maxFileBytes + 1);
      }
      const got = await recordedShots(archive, deps().taskId, input);
      expect(got.outcome).toBe('unknown');
      expect(got.files).toEqual(result.files);
      expect(got.reason).toContain('缺失、损坏');
    },
  );

  it.each([
    'task',
    'issue',
    'head',
    'branch',
    'sha256',
    'blob',
    'size',
    'path',
    'empty',
    'from',
    'remoteHead',
    'rejected',
    'missing',
  ] as const)('清单 %s 不一致时拒绝伪报 archived', async (damage) => {
    const { manifest } = await archived();
    const m = JSON.parse(readFileSync(manifest, 'utf8'));
    if (damage === 'task') m.taskId = 'another-task';
    if (damage === 'issue') m.issueNumber = 999;
    if (damage === 'head') m.delivery.head = 'b'.repeat(40);
    if (damage === 'branch') m.delivery.branch = 'shots/999';
    if (damage === 'sha256') m.delivery.files[0].sha256 = '../escape';
    if (damage === 'blob') m.delivery.files[0].blob = 'b'.repeat(40);
    if (damage === 'size') m.delivery.files[0].bytes += 1;
    if (damage === 'path') m.delivery.files[0].path = '../../secret.png';
    if (damage === 'empty') m.delivery.files = [];
    if (damage === 'from') m.delivery.files[0].from = '../escape';
    if (damage === 'remoteHead') m.delivery.remoteHead = {};
    if (damage === 'rejected') m.delivery.rejected = { length: 1 };
    if (damage === 'missing') m.delivery.missing = [null];
    writeFileSync(manifest, JSON.stringify(m));
    expect((await recordedShots(archive, deps().taskId, input)).outcome).toBe('unknown');
  });

  it('字节/hash/blob都一致但文件头不是图片，也不能报 archived', async () => {
    const { manifest, location, blob } = await archived();
    const bytes = Buffer.from('NOT-IMAGE');
    const m = JSON.parse(readFileSync(manifest, 'utf8'));
    const hash = createHash('sha256').update(bytes).digest('hex');
    Object.assign(m.delivery.files[0], { bytes: bytes.length, sha256: hash, blob: gitBlobId(bytes) });
    rmSync(blob);
    writeFileSync(join(location, `${hash}.png`), bytes);
    writeFileSync(manifest, JSON.stringify(m));
    expect((await recordedShots(archive, deps().taskId, input)).outcome).toBe('unknown');
  });

  it.each(['missing', 'invalid-json', 'oversize', 'symlink'] as const)(
    '清单 %s 时明确回 unknown',
    async (damage) => {
      const { manifest } = await archived();
      const bytes = readFileSync(manifest);
      rmSync(manifest);
      if (damage === 'invalid-json') writeFileSync(manifest, '{');
      if (damage === 'oversize') {
        writeFileSync(manifest, bytes);
        truncateSync(manifest, 1024 * 1024 + 1);
      }
      if (damage === 'symlink') {
        const outside = join(root, 'outside-manifest.json');
        writeFileSync(outside, bytes);
        symlinkSync(outside, manifest);
      }
      const got = await recordedShots(archive, deps().taskId, input);
      expect(got.outcome).toBe('unknown');
      expect(got.reason).toContain('没有有效且身份一致');
    },
  );

  it('delivered 的历史核对无需本地图片，none 空清单仍为 none', async () => {
    const { result, manifest, blob } = await archived();
    const m = JSON.parse(readFileSync(manifest, 'utf8'));
    m.delivery.outcome = 'delivered';
    rmSync(blob);
    writeFileSync(manifest, JSON.stringify(m));
    expect((await recordedShots(archive, deps().taskId, input)).outcome).toBe('delivered');
    m.delivery.outcome = 'none';
    m.delivery.files = [];
    writeFileSync(manifest, JSON.stringify(m));
    expect(await recordedShots(archive, deps().taskId, input)).toEqual({
      ...result,
      outcome: 'none',
      files: [],
    });
  });
});
