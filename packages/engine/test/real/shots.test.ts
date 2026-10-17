// 界面验收图片收树前的交付核对和受限归档（#2983）：临时仓 + 本地 git 复现「代码合并了、图片只在树里或没推的孤儿提交里」，
// 核对只认受管图片、远端按 blob 号说话、归档有清单和 hash、幂等、换头不覆盖、容量和过期、叫停。
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localExec } from '../../src/real/exec.ts';
import {
  collectShots,
  gitBlobId,
  imageKind,
  type PreserveShotsDeps,
  preserveShots,
  recordedShots,
  SHOTS_LIMITS,
  shotsArchiveDir,
} from '../../src/real/shots.ts';
import type { UserTree } from '../../src/real/user-git.ts';
import { runChildOk } from '../child.ts';

vi.setConfig({ testTimeout: 60_000 });

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const NOW = new Date('2026-10-17T05:00:00Z');

let root: string;
let dir: string;
let archive: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-shots-'));
  dir = join(root, 'tree');
  archive = join(root, 'archive');
  mkdirSync(dir);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@localhost');
  writeFileSync(join(dir, 'README.md'), '# demo\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function git(...args: string[]): string {
  return runChildOk('git', args, { cwd: dir });
}

function tree(signal?: AbortSignal): UserTree {
  return {
    exec: localExec(),
    user: 'fleet-agent-carpool',
    dir,
    scopePrefix: 'shots-test',
    git: 'git',
    sh: 'sh',
    ...(signal ? { signal } : {}),
  };
}

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (tag: string) => Buffer.concat([PNG_HEAD, Buffer.from(`png:${tag}`)]);
const webp = (tag: string) => Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP'), Buffer.from(tag)]);
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function shot(rel: string, bytes: Buffer) {
  const file = join(dir, '_tmp', 'shots', rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, bytes);
}

/** 照 docs/design/驾驶舱界面.md 第七节的抄法做一个孤儿图片提交（不挂任何引用），再把原图删掉：提交是唯一副本。 */
function orphanCommit(files: Record<string, Buffer>): string {
  const work = join(root, 'orphan-src');
  mkdirSync(work, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(work, name), bytes);
  const env = { ...process.env, GIT_INDEX_FILE: join(root, 'orphan.idx') };
  runChildOk('git', ['--work-tree', work, 'add', '-f', '.'], { cwd: dir, env });
  const t = runChildOk('git', ['write-tree'], { cwd: dir, env });
  const c = runChildOk('git', ['commit-tree', t, '-m', '截图'], { cwd: dir, env });
  rmSync(work, { recursive: true, force: true });
  rmSync(join(root, 'orphan.idx'), { force: true });
  return c;
}

function deps(over: Partial<PreserveShotsDeps> = {}): PreserveShotsDeps {
  return {
    archiveDir: archive,
    taskId: 'task-1',
    now: NOW,
    remote: async () => ({ head: null, blobs: new Set() }),
    ...over,
  };
}

const input = { issueNumber: 2969, head: HEAD };

describe('认图片、算 blob 号', () => {
  it('只认 PNG/JPEG/WebP 的文件头；blob 号和 git hash-object 一样', () => {
    expect(imageKind(png('x'))).toBe('png');
    expect(imageKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(imageKind(webp('x'))).toBe('webp');
    expect(imageKind(Buffer.from('SECRET=1\n'))).toBeNull();
    const file = join(root, 'b.png');
    writeFileSync(file, png('blob'));
    expect(gitBlobId(png('blob'))).toBe(git('hash-object', file));
  });
});

describe('清点：只碰受管图片', () => {
  it('_tmp/shots/<标签>/ 的图收下；链接、层级不对、不是图片的拒收；.env、_tmp 别处、会话目录一概不碰', async () => {
    shot('before/home-1366-light.png', png('before'));
    shot('after/home-1366-light.webp', webp('after'));
    shot('after/fake.png', Buffer.from('TOKEN=abc\n'));
    shot('top.png', png('top'));
    shot('after/sub/deep.png', png('deep'));
    shot('after/notes.txt', Buffer.from('x'));
    writeFileSync(join(dir, '.env'), 'SECRET=1\n');
    symlinkSync(join(dir, '.env'), join(dir, '_tmp', 'shots', 'after', 'link.png'));
    symlinkSync(root, join(dir, '_tmp', 'shots', 'escape'));
    mkdirSync(join(dir, '_tmp', 'other'), { recursive: true });
    writeFileSync(join(dir, '_tmp', 'other', 'log.png'), png('other'));

    const got = await collectShots(tree());
    expect(got.over).toBeUndefined();
    expect(got.found.map((f) => f.record.path).sort()).toEqual([
      'after/home-1366-light.webp',
      'before/home-1366-light.png',
    ]);
    const before = got.found.find((f) => f.record.path.startsWith('before/'));
    expect(before?.record).toMatchObject({
      from: 'tree',
      bytes: png('before').length,
      sha256: sha256(png('before')),
      blob: gitBlobId(png('before')),
    });
    const rejected = got.rejected.join('\n');
    expect(rejected).toContain('after/fake.png：文件头不是');
    expect(rejected).toContain('after/link.png：符号链接');
    expect(rejected).toContain('escape：符号链接');
    expect(rejected).toContain('top.png：不在 <标签>/ 下');
    expect(rejected).toContain('after/sub/：子目录');
    expect(rejected).toContain('after/notes.txt：不是受管图片');
    expect(rejected).not.toContain('.env');
    expect(rejected).not.toContain('other');
  });

  it('_tmp/shots 本身是链接（指到树外）：整个不跟', async () => {
    const outside = join(root, 'outside');
    mkdirSync(join(outside, 'x'), { recursive: true });
    writeFileSync(join(outside, 'x', 'a.png'), png('outside'));
    mkdirSync(join(dir, '_tmp'));
    symlinkSync(outside, join(dir, '_tmp', 'shots'));
    const got = await collectShots(tree());
    expect(got.found).toEqual([]);
    expect(got.rejected.join()).toContain('_tmp/shots：是符号链接');
  });

  it('【故意造出的失败】数量、单张、总量超了上限：算失败，不挑几张存', async () => {
    shot('a/1.png', png('1'));
    shot('a/2.png', png('2'));
    expect((await collectShots(tree(), { ...SHOTS_LIMITS, maxFiles: 1 })).over).toContain('超过上限 1');
    expect((await collectShots(tree(), { ...SHOTS_LIMITS, maxFileBytes: 4 })).over).toContain('单张上限');
    expect((await collectShots(tree(), { ...SHOTS_LIMITS, maxTotalBytes: 20 })).over).toContain('合计');
  });

  it('没推的孤儿图片提交（原图已删）认得出；孤儿提交里混着别的文件、普通的代码提交不算', async () => {
    const c = orphanCommit({ 'home-390-dark.png': png('orphan') });
    orphanCommit({ 'a.png': png('mixed'), '.env': Buffer.from('SECRET=1\n') });
    const got = await collectShots(tree());
    expect(got.found.map((f) => f.record)).toEqual([
      {
        path: `${c.slice(0, 7)}/home-390-dark.png`,
        bytes: png('orphan').length,
        sha256: sha256(png('orphan')),
        blob: gitBlobId(png('orphan')),
        from: c,
      },
    ]);
  });
});

describe('交付核对和受限归档', () => {
  it('复现 #2969：代码合并了，图片只在树里、远端 404：存进归档，清单记代码头、路径、字节、hash、结局', async () => {
    shot('2969/home-1366-light.png', png('before'));
    const c = orphanCommit({ 'home-1366-dark.png': png('after') });
    const r = await preserveShots(tree(), input, deps());
    expect(r.outcome).toBe('archived');
    expect(r.reason).toContain('远端没有 shots/2969（404）');
    expect(r.missing).toHaveLength(2);
    const at = shotsArchiveDir(archive, 'task-1', HEAD);
    expect(r.archivedTo).toBe(join(at, 'manifest.json'));
    expect(readFileSync(join(at, `${sha256(png('before'))}.png`))).toEqual(png('before'));
    expect(readFileSync(join(at, `${sha256(png('after'))}.png`))).toEqual(png('after'));
    const manifest = JSON.parse(readFileSync(join(at, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({
      taskId: 'task-1',
      issueNumber: 2969,
      delivery: { outcome: 'archived', head: HEAD },
    });
    expect(manifest.delivery.files.map((f: { from: string }) => f.from).sort()).toEqual([c, 'tree'].sort());
  });

  it('远端分支上全有（blob 号对上）才算已交付：不存图，只留清单', async () => {
    shot('2969/a.png', png('a'));
    const r = await preserveShots(
      tree(),
      input,
      deps({ remote: async () => ({ head: OTHER_HEAD, blobs: new Set([gitBlobId(png('a'))]) }) }),
    );
    expect(r).toMatchObject({ outcome: 'delivered', remoteHead: OTHER_HEAD });
    expect(readdirSync(shotsArchiveDir(archive, 'task-1', HEAD))).toEqual(['manifest.json']);
  });

  it('【故意造出的失败】远端分支在、缺一张 blob：待交付，列出缺哪张', async () => {
    shot('2969/a.png', png('a'));
    shot('2969/b.png', png('b'));
    const r = await preserveShots(
      tree(),
      input,
      deps({ remote: async () => ({ head: OTHER_HEAD, blobs: new Set([gitBlobId(png('a'))]) }) }),
    );
    expect(r).toMatchObject({
      outcome: 'archived',
      missing: ['2969/b.png'],
      reason: '远端 shots/2969 缺 1 张',
    });
  });

  it('【故意造出的失败】远端没读成（上传、读取失败）：照样归档，原因写明', async () => {
    shot('2969/a.png', png('a'));
    const r = await preserveShots(
      tree(),
      input,
      deps({
        remote: async () => {
          throw new Error('镜像打包失败');
        },
      }),
    );
    expect(r.outcome).toBe('archived');
    expect(r.reason).toContain('没读成：镜像打包失败');
  });

  it('【故意造出的失败】归档写不进去：failed，带原因（调用方据此不删树）', async () => {
    shot('2969/a.png', png('a'));
    writeFileSync(archive, '占住了');
    const r = await preserveShots(tree(), input, deps());
    expect(r.outcome).toBe('failed');
    expect(r.reason).toContain('归档没成');
  });

  it('重复提交：同一张图在树里两处、又在孤儿提交里，只存一份；同一个头重试不重写', async () => {
    shot('before/a.png', png('same'));
    shot('after/a.png', png('same'));
    orphanCommit({ 'a.png': png('same') });
    const first = await preserveShots(tree(), input, deps());
    expect(first.files).toHaveLength(3);
    const at = shotsArchiveDir(archive, 'task-1', HEAD);
    expect(readdirSync(at).sort()).toEqual([`${sha256(png('same'))}.png`, 'manifest.json']);
    const again = await preserveShots(tree(), input, deps({ now: new Date('2026-10-18T00:00:00Z') }));
    expect(again).toEqual(first);
    expect(JSON.parse(readFileSync(join(at, 'manifest.json'), 'utf8')).at).toBe(NOW.toISOString());
  });

  it('不同的头另起目录、别的任务的归档不碰', async () => {
    shot('2969/a.png', png('a'));
    await preserveShots(tree(), input, deps({ taskId: 'task-other' }));
    await preserveShots(tree(), input, deps());
    shot('2969/a.png', png('changed'));
    await preserveShots(tree(), { ...input, head: OTHER_HEAD }, deps());
    expect(readdirSync(shotsArchiveDir(archive, 'task-1', HEAD))).toContain(`${sha256(png('a'))}.png`);
    expect(readdirSync(shotsArchiveDir(archive, 'task-1', OTHER_HEAD))).toContain(
      `${sha256(png('changed'))}.png`,
    );
    expect(readdirSync(shotsArchiveDir(archive, 'task-other', HEAD))).toContain(`${sha256(png('a'))}.png`);
  });

  it('容量：放不下就失败（不删别的任务没过期的）；过期的整目录删掉后放得下', async () => {
    shot('2969/a.png', png('a'));
    const other = shotsArchiveDir(archive, 'task-old', HEAD);
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'x.png'), Buffer.alloc(100));
    const limits = { archiveMaxBytes: 110 };
    const full = await preserveShots(tree(), input, deps({ limits }));
    expect(full.outcome).toBe('failed');
    expect(full.reason).toContain('图片归档满了');
    expect(existsSync(other)).toBe(true);
    const old = new Date(NOW.getTime() - 31 * 24 * 3600 * 1000);
    utimesSync(other, old, old);
    const ok = await preserveShots(tree(), input, deps({ limits }));
    expect(ok.outcome).toBe('archived');
    expect(existsSync(other)).toBe(false);
  });

  it('没有受管图片：none，只留一份清单', async () => {
    const r = await preserveShots(tree(), input, deps());
    expect(r).toMatchObject({ outcome: 'none', files: [] });
  });

  it('已经清理：有清单按清单说，没有清单是 unknown，不当成没有图片', async () => {
    expect((await recordedShots(archive, 'task-1', input)).outcome).toBe('unknown');
    shot('2969/a.png', png('a'));
    const r = await preserveShots(tree(), input, deps());
    rmSync(dir, { recursive: true, force: true });
    expect(await recordedShots(archive, 'task-1', input)).toEqual(r);
  });

  it('【故意造出的失败】叫停：原样抛，不归档', async () => {
    shot('2969/a.png', png('a'));
    const abort = new AbortController();
    abort.abort();
    await expect(preserveShots(tree(abort.signal), input, deps())).rejects.toThrow();
    expect(existsSync(shotsArchiveDir(archive, 'task-1', HEAD))).toBe(false);
  });

  it('任务号、代码头认不出：不拼进路径，算失败', async () => {
    shot('2969/a.png', png('a'));
    expect((await preserveShots(tree(), { ...input, head: '../x' }, deps())).outcome).toBe('failed');
    expect((await preserveShots(tree(), input, deps({ taskId: '../evil' }))).outcome).toBe('failed');
  });
});
