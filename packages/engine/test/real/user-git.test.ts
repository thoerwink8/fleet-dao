// 会话目录里的 git（以会话用户的身份跑；这里用本机执行器、真 git、临时目录）：从 bundle 建树、交 bundle、快进，
// 没跑成的明确报错，不拿空结果冒充「没有改动」。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  mainlineRef,
  mergeInto,
  pinMainline,
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
  GIT_AUTHOR_EMAIL: 'fleet-test@localhost',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 'fleet-test@localhost',
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
  return { exec: localExec(), user: 'fleet-agent-carpool', dir, scopePrefix: 'test', git: 'git', sh: 'sh' };
}

describe('会话目录里的 git', { timeout: 60_000 }, () => {
  it('从 bundle 建树、检出分支；会话提交后能数出改动、打出 bundle，别的仓能从这个 bundle 取到同一个头', async () => {
    const m = mirror();
    const t = tree('work');
    const fetched = await fetchBundle(t, m.bundle(m.head), 'refs/fleet/export/0', {
      identity: { name: 'fleet-dao-agent[bot]', email: 'bofleet-test@localhost' },
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

  it('【故意造出的失败】中文文件名原样列出：改动清单、没提交的改动都不带 git 默认的转义和引号（方案.md 要对得上）', async () => {
    const m = mirror();
    const t = tree('work');
    await fetchBundle(t, m.bundle(m.head), 'refs/fleet/export/0');
    await checkoutBranch(t, 'fleet/12-a', m.head);
    mkdirSync(join(t.dir, 'specs', '12-登录'), { recursive: true });
    writeFileSync(join(t.dir, 'specs', '12-登录', '方案.md'), '# 方案\n');
    execFileSync('git', ['add', '--', 'specs'], { cwd: t.dir });
    execFileSync('git', ['commit', '-q', '-m', 'docs: 方案'], { cwd: t.dir, env: ENV });
    // 不关转义的话 git 列出来的是 "specs/12-\347\231\273\345\275\225/\346\226\271\346\241\210.md"
    expect(sh(t.dir, '-c', 'core.quotePath=true', 'diff', '--name-only', m.head, 'HEAD')).toContain('\\');
    expect(await changedFilesSince(t, m.head)).toEqual(['specs/12-登录/方案.md']);
    writeFileSync(join(t.dir, 'specs', '12-登录', '方案.md'), '# 改了没提交\n');
    expect(await uncommittedTracked(t)).toEqual([' M specs/12-登录/方案.md']);
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

  it('钉主线：origin/main 指到给的主线提交，git diff origin/main...HEAD 只列分支自己的改动（pnpm test:changed 靠它）', async () => {
    const m = mirror();
    const t = tree('work');
    await fetchBundle(t, m.bundle(m.head), 'refs/fleet/export/0');
    await checkoutBranch(t, 'fleet/12-a', m.head);
    expect(() => sh(t.dir, 'rev-parse', '--verify', '--quiet', 'origin/main')).toThrow();
    await pinMainline(t, 'main', m.head);
    expect(sh(t.dir, 'rev-parse', 'origin/main')).toBe(m.head);
    expect(mainlineRef('main')).toBe('refs/remotes/origin/main');

    writeFileSync(join(t.dir, 'b.ts'), 'export const b = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: t.dir });
    execFileSync('git', ['commit', '-q', '-m', 'add b'], { cwd: t.dir, env: ENV });
    expect(sh(t.dir, 'diff', '--name-only', 'origin/main...HEAD')).toBe('b.ts');
  });

  it('钉主线：提交不在树里、提交号不对、分支名不对都明确报错，原来钉的不动', async () => {
    const m = mirror();
    const t = tree('work');
    await fetchBundle(t, m.bundle(m.head), 'refs/fleet/export/0');
    await checkoutBranch(t, 'fleet/12-a', m.head);
    await pinMainline(t, 'main', m.head);
    await expect(pinMainline(t, 'main', 'f'.repeat(40))).rejects.toMatchObject({ code: 'GIT_FAILED' });
    await expect(pinMainline(t, 'main', 'HEAD')).rejects.toMatchObject({ code: 'BAD_INPUT' });
    for (const bad of ['../evil', 'main..x', '-main', 'a b', 'x.lock', '']) {
      await expect(pinMainline(t, bad, m.head), bad).rejects.toMatchObject({ code: 'BAD_INPUT' });
    }
    expect(sh(t.dir, 'rev-parse', 'origin/main')).toBe(m.head);
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

// 并主线没并成、又不是冲突：报错以「并」这一步开头，撤销没成附在后面，树里留下什么照实写。
// 「没并成却留下 MERGE_HEAD」这种状态不靠某一版 git 造：锁被占着时 git 2.45 及以前才留（法国的 2.43），2.46 起不留，
// CI 和本机的 git 都比法国新。这里用 pre-merge-commit 钩子造——钩子失败时 git 各版都停在「并好了、没提交」，
// 留下 MERGE_HEAD（钩子自 2.24 起有）；钩子顺手占住索引锁，就是法国那次「撤销被同一把锁挡住」。
describe('并主线没并成（不是冲突）', { timeout: 60_000 }, () => {
  /** 会话的树：分支上交了一个提交，主线另进了 c.ts，新主线的提交已经取进树里（和推分支之前一样）。
   * 提交身份和引擎建树时一样写进树的配置：并主线要生成合并提交，CI 上没有全局的 git 身份，没写就先死在「身份为空」。 */
  async function diverged(): Promise<{ t: UserTree; head: string; main: string }> {
    const m = mirror();
    const t = tree('work');
    await fetchBundle(t, m.bundle(m.head), 'refs/fleet/export/0', {
      identity: { name: 't', email: 'fleet-test@localhost' },
    });
    await checkoutBranch(t, 'fleet/12-a', m.head);
    writeFileSync(join(t.dir, 'b.ts'), 'export const b = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: t.dir });
    execFileSync('git', ['commit', '-q', '-m', 'add b'], { cwd: t.dir, env: ENV });
    writeFileSync(join(m.dir, 'c.ts'), 'export const c = 1;\n');
    sh(m.dir, 'add', '.');
    sh(m.dir, 'commit', '-q', '-m', 'main moved');
    const main = sh(m.dir, 'rev-parse', 'HEAD');
    await fetchBundle(t, m.bundle(main, m.head), 'refs/fleet/export/0');
    return { t, head: await headOf(t), main };
  }
  /** 树里装一个 pre-merge-commit 钩子（钩子目录设在树自己的配置里，盖过全局的 core.hooksPath）。 */
  function hook(t: UserTree, body: string) {
    const hooks = join(root, 'hooks');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, 'pre-merge-commit'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    sh(t.dir, 'config', 'core.hooksPath', hooks);
  }
  const mergeHeadLeft = (t: UserTree) => existsSync(join(t.dir, '.git', 'MERGE_HEAD'));

  it('留下了 MERGE_HEAD、撤销成了：报 GIT_FAILED（可重试），以「并」开头、写明已撤掉；树回到并之前', async () => {
    const { t, head, main } = await diverged();
    hook(t, 'exit 1');
    const err = await mergeInto(t, main).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortError);
    expect(err).toMatchObject({ code: 'GIT_FAILED', retryable: true });
    const message = (err as Error).message;
    expect(message).toMatch(new RegExp(`^并 ${main.slice(0, 7)}：退出码 1（`));
    expect(message).toContain('没并成的合并已撤掉');
    expect(message).not.toContain('还留着没并完的合并');
    expect(mergeHeadLeft(t)).toBe(false);
    expect(await headOf(t)).toBe(head);
    expect(existsSync(join(t.dir, 'c.ts'))).toBe(false);
    expect(await uncommittedTracked(t)).toEqual([]);
  });

  it('留下了 MERGE_HEAD、撤销被锁挡住（法国 git 2.43 上锁被占着就是这样）：仍以「并」开头，撤销的原因和留下的状态附在后面', async () => {
    const { t, head, main } = await diverged();
    hook(t, ': > .git/index.lock\nexit 1');
    const err = await mergeInto(t, main).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'GIT_FAILED', retryable: true });
    const message = (err as Error).message;
    const parts = message.split('；');
    expect(parts[0]).toMatch(new RegExp(`^并 ${main.slice(0, 7)}：退出码 1（`));
    // 撤销没成的原因引 git 自己的错误行（是哪把锁），不是后面那几行劝人的话
    expect(parts[1]).toMatch(
      /^撤掉没并成的合并：退出码 128（fatal: Unable to create '.*index\.lock': File exists\.）$/,
    );
    expect(parts[2]).toContain('还留着没并完的合并');
    // 报的和树里真留下的对得上
    expect(mergeHeadLeft(t)).toBe(true);
    expect(await headOf(t)).toBe(head);
  });

  it('看 MERGE_HEAD 没查成：不当成「没留下」，写明没查成、没撤', async () => {
    const { t, main } = await diverged();
    hook(t, 'exit 1');
    // 只让「看 MERGE_HEAD」那一步出错（git 的退出码 128），别的照常跑真 git
    const real = localExec();
    const exec: UserTree['exec'] = (c) =>
      c.argv.includes('MERGE_HEAD')
        ? Promise.resolve({
            code: 128,
            stdout: Buffer.alloc(0),
            stderr: 'fatal: 故意造的读不了\n',
            timedOut: false,
            aborted: false,
          })
        : real(c);
    const err = await mergeInto({ ...t, exec }, main).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'GIT_FAILED' });
    const message = (err as Error).message;
    expect(message).toMatch(new RegExp(`^并 ${main.slice(0, 7)}：`));
    expect(message).toContain('有没有留下没并完的合并没查成');
    expect(message).toContain('故意造的读不了');
    expect(message).not.toContain('已撤掉');
  });
});
