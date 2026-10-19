import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_BUNDLE_BYTES } from '@fleet-dao/github';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { localExec } from '../../src/real/exec.ts';
import { bundleFromMirror, type MirrorGitHub } from '../../src/real/mirror.ts';
import { fetchBundle, type UserTree } from '../../src/real/user-git.ts';
import { runChildBytes, runChildOk } from '../child.ts';
import { git, mirror } from './fixtures.ts';

vi.setConfig({ testTimeout: 60_000 });
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-bundle-proof-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const repo = { owner: 'acme', name: 'widgets', defaultBranch: 'main' };

async function setup() {
  const m = mirror(root);
  const dir = join(root, 'user');
  mkdirSync(dir);
  const t: UserTree = {
    dir,
    user: 'fleet-agent-carpool',
    exec: localExec(),
    scopePrefix: 'bundle-proof',
    git: 'git',
    sh: 'sh',
  };
  const outPath = join(root, 'initial.bundle');
  const made = await m.gh.bundleCommits({ tips: [m.head], outPath });
  const ref = made.refs[0]?.ref;
  if (!ref) throw new Error('fixture bundle lacks ref');
  await fetchBundle(t, readFileSync(outPath), ref);
  const common = commit(m.dir, 'common');
  const previous = commit(m.dir, 'previous');
  git(m.dir, 'checkout', '-q', '-b', 'other', common);
  commit(m.dir, 'other');
  git(m.dir, 'merge', '-q', '--no-ff', previous, '-m', 'merge');
  const tip = git(m.dir, 'rev-parse', 'HEAD');
  m.calls.length = 0;
  return { m, t, previous, tip };
}

function commit(dir: string, name: string) {
  writeFileSync(join(dir, `${name}.txt`), name);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', name);
  return git(dir, 'rev-parse', 'HEAD');
}

it('previousHead 对象存在但闭包缺失：真实 verify 拒绝，完整包回退不改用户引用或文件', async () => {
  const { m, t, previous, tip } = await setup();
  // 只插入 commit 本体，刻意不插入其 tree/parent；cat-file -e 会误认为“已具备”。
  const raw = runChildBytes('git', ['cat-file', 'commit', previous], { cwd: m.dir });
  expect(raw.status).toBe(0);
  runChildOk('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: t.dir, input: raw.stdout });
  expect(git(t.dir, 'cat-file', '-t', previous)).toBe('commit');
  const before = git(t.dir, 'show-ref');
  writeFileSync(join(t.dir, 'untracked'), 'keep');
  const b = await bundleFromMirror(m.gh, join(root, 'tmp'), repo, tip, [previous], undefined, t);
  expect(m.calls.map((c) => c.exclude)).toEqual([[previous], []]);
  expect(git(t.dir, 'show-ref')).toBe(before);
  expect(readFileSync(join(t.dir, 'untracked'), 'utf8')).toBe('keep');
  await expect(fetchBundle(t, b.bytes, b.ref)).resolves.toBe(tip);
  expect(readdirSync(join(t.dir, '.git')).filter((n) => n.startsWith('fleet-verify-'))).toEqual([]);
  expect(readdirSync(join(root, 'tmp'))).toEqual([]);
});

it('完整包仍坏明确失败，不导入、不留下临时包', async () => {
  const { t } = await setup();
  const calls: string[][] = [];
  const gh = {
    bundleCommits: async (input: Parameters<MirrorGitHub['bundleCommits']>[0]) => {
      calls.push(input.exclude ?? []);
      writeFileSync(input.outPath, 'broken');
      return {
        path: input.outPath,
        bytes: 6,
        refs: [{ tip: input.tips[0] ?? '', ref: 'refs/fleet/export/0' }],
      };
    },
  } as MirrorGitHub;
  await expect(
    bundleFromMirror(gh, join(root, 'tmp'), repo, 'a'.repeat(40), ['b'.repeat(40)], undefined, t),
  ).rejects.toMatchObject({ code: 'BUNDLE_INVALID' });
  expect(calls).toHaveLength(2);
  expect(readdirSync(join(root, 'tmp'))).toEqual([]);
});

it('完整回退也执行实际文件大小限制，取消不再打包', async () => {
  const { t } = await setup();
  const gh = {
    bundleCommits: vi.fn(async (input: Parameters<MirrorGitHub['bundleCommits']>[0]) => {
      writeFileSync(input.outPath, '');
      truncateSync(input.outPath, MAX_BUNDLE_BYTES + 1);
      return {
        path: input.outPath,
        bytes: 0,
        refs: [{ tip: input.tips[0] ?? '', ref: 'refs/fleet/export/0' }],
      };
    }),
  } as unknown as MirrorGitHub;
  await expect(
    bundleFromMirror(gh, join(root, 'tmp'), repo, 'a'.repeat(40), [], undefined, t),
  ).rejects.toMatchObject({ code: 'BUNDLE_TOO_LARGE' });
  expect(readdirSync(join(root, 'tmp'))).toEqual([]);
  const controller = new AbortController();
  controller.abort();
  await expect(
    bundleFromMirror(gh, join(root, 'tmp'), repo, 'a'.repeat(40), [], controller.signal, t),
  ).rejects.toThrow();
  expect(gh.bundleCommits).toHaveBeenCalledTimes(1);
});
