// 会话目录里的 git（以会话用户的身份跑；这里用本机执行器、真 git、临时目录）：从 bundle 建树、交 bundle、快进，
// 没跑成的明确报错，不拿空结果冒充「没有改动」。
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PortError } from '../../src/ports.ts';
import { localExec } from '../../src/real/exec.ts';
import {
  bundleSince,
  changedFilesSince,
  checkoutBranch,
  checkoutDetached,
  commitsSince,
  fastForward,
  fetchBundle,
  headOf,
  readFileAs,
  type UserTree,
  uncommittedTracked,
} from '../../src/real/user-git.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-user-git-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
};
const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();

/** 引擎这边的「镜像」：主线两次提交，导出成 bundle（引用名和 github 包的 bundleCommits 一样）。 */
function mirror(): { dir: string; head: string; bundle: (tip: string, exclude?: string) => Buffer } {
  const dir = join(root, 'mirror');
  mkdirSync(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), '# demo\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'first');
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'second');
  const head = sh(dir, 'rev-parse', 'HEAD');
  let n = 0;
  return {
    dir,
    head,
    bundle(tip, exclude) {
      n += 1;
      sh(dir, 'update-ref', 'refs/fleet/export/0', tip);
      const file = join(root, `out-${n}.bundle`);
      sh(dir, 'bundle', 'create', file, 'refs/fleet/export/0', ...(exclude ? [`^${exclude}`] : []));
      return execFileSync(
        'node',
        ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(file)}))`],
        {
          maxBuffer: 1 << 26,
        },
      );
    },
  };
}

function tree(name: string): UserTree {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return { exec: localExec(), user: 'fleet-agent-dedicated', dir, scopePrefix: 'test', git: 'git', sh: 'sh' };
}

describe('会话目录里的 git', { timeout: 60_000 }, () => {
  it('从 bundle 建树、检出分支；会话提交后能数出改动、打出 bundle，别的仓能从这个 bundle 取到同一个头', async () => {
    const m = mirror();
    const t = tree('work');
    const fetched = await fetchBundle(t, m.bundle(m.head), 'refs/fleet/export/0', {
      identity: { name: 'fleet-dao-agent[bot]', email: 'bot@example.invalid' },
    });
    expect(fetched).toBe(m.head);
    await checkoutBranch(t, 'fleet/12-a', m.head);
    expect(await headOf(t)).toBe(m.head);
    expect(sh(t.dir, 'config', 'user.name')).toBe('fleet-dao-agent[bot]');

    // 会话干活：改文件、提交。
    writeFileSync(join(t.dir, 'a.ts'), 'export const a = 2;\n');
    writeFileSync(join(t.dir, 'b.ts'), 'export const b = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: t.dir });
    execFileSync('git', ['commit', '-q', '-m', 'change a, add b'], { cwd: t.dir, env: ENV });
    const head = await headOf(t);
    expect(await changedFilesSince(t, m.head)).toEqual(['a.ts', 'b.ts']);
    expect((await commitsSince(t, m.head)).map((l) => l.replace(/^\w+ /, ''))).toEqual(['change a, add b']);
    expect(await uncommittedTracked(t)).toEqual([]);

    const bundle = await bundleSince(t, head, m.head);
    const file = join(root, 'delivered.bundle');
    writeFileSync(file, bundle);
    sh(m.dir, 'fetch', '-q', file, `+${head}:refs/delivered`);
    expect(sh(m.dir, 'rev-parse', 'refs/delivered')).toBe(head);
  });

  it('起会话前的头之后没有新提交：明确报 EMPTY_DELIVERY，不交空包', async () => {
    const m = mirror();
    const t = tree('work');
    await fetchBundle(t, m.bundle(m.head), 'refs/fleet/export/0');
    await checkoutBranch(t, 'fleet/12-a', m.head);
    await expect(bundleSince(t, m.head, m.head)).rejects.toMatchObject({
      code: 'EMPTY_DELIVERY',
      retryable: false,
    });
  });

  it('没提交的已跟踪改动数得出来（交付判据）', async () => {
    const m = mirror();
    const t = tree('work');
    await fetchBundle(t, m.bundle(m.head), 'refs/fleet/export/0');
    await checkoutBranch(t, 'fleet/12-a', m.head);
    writeFileSync(join(t.dir, 'a.ts'), 'export const a = 3;\n');
    expect(await uncommittedTracked(t)).toEqual([' M a.ts']);
  });

  it('并主线之后快进：没有本地新提交就快进到新头；会话又提交了回 diverged；已经是新头回 already', async () => {
    const m = mirror();
    const t = tree('work');
    await fetchBundle(t, m.bundle(m.head), 'refs/fleet/export/0');
    await checkoutBranch(t, 'fleet/12-a', m.head);
    writeFileSync(join(m.dir, 'c.ts'), 'export const c = 1;\n');
    sh(m.dir, 'add', '.');
    sh(m.dir, 'commit', '-q', '-m', 'main moved');
    const next = sh(m.dir, 'rev-parse', 'HEAD');
    expect(await fastForward(t, m.bundle(next, m.head), 'refs/fleet/export/0', next)).toBe('fast-forwarded');
    expect(await headOf(t)).toBe(next);
    expect(await fastForward(t, m.bundle(next, m.head), 'refs/fleet/export/0', next)).toBe('already');

    const u = tree('work2');
    await fetchBundle(u, m.bundle(m.head), 'refs/fleet/export/0');
    await checkoutBranch(u, 'fleet/12-a', m.head);
    writeFileSync(join(u.dir, 'd.ts'), 'x\n');
    execFileSync('git', ['add', '.'], { cwd: u.dir });
    execFileSync('git', ['commit', '-q', '-m', 'local'], { cwd: u.dir, env: ENV });
    expect(await fastForward(u, m.bundle(next, m.head), 'refs/fleet/export/0', next)).toBe('diverged');
  });

  it('只读检出：分离头、清掉上一轮留下的文件', async () => {
    const m = mirror();
    const t = tree('scratch');
    await fetchBundle(t, m.bundle(m.head), 'refs/fleet/export/0');
    await checkoutDetached(t, m.head);
    mkdirSync(join(t.dir, '.fleet-out'));
    writeFileSync(join(t.dir, '.fleet-out', 'triage.json'), '{"clear":true}');
    expect(await readFileAs(t, '.fleet-out/triage.json')).toBe('{"clear":true}');
    await checkoutDetached(t, m.head);
    expect(await readFileAs(t, '.fleet-out/triage.json')).toBeNull();
  });

  it('读结论文件：不在回 null；绝对路径、带 .. 的不读', async () => {
    const t = tree('plain');
    expect(await readFileAs(t, 'missing.json')).toBeNull();
    await expect(readFileAs(t, '/etc/passwd')).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(readFileAs(t, '../x')).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });

  it('git 没跑成（目录里没有仓）：明确报错，不当成「没有改动」', async () => {
    const t = tree('empty');
    await expect(uncommittedTracked(t)).rejects.toBeInstanceOf(PortError);
    await expect(changedFilesSince(t, 'a'.repeat(40))).rejects.toMatchObject({ code: 'GIT_FAILED' });
    await expect(headOf(t)).rejects.toMatchObject({ code: 'GIT_FAILED' });
  });

  it('bundle 里的引用名、提交号不对：起之前就拒', async () => {
    const t = tree('plain');
    await expect(fetchBundle(t, Buffer.from('x'), 'refs/heads/main')).rejects.toMatchObject({
      code: 'BAD_INPUT',
    });
    await expect(checkoutBranch(t, 'b', 'HEAD')).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });
});
