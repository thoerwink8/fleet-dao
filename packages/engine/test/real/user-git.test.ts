// 会话目录里的 git（以会话用户的身份跑；这里用本机执行器、真 git、临时目录）：从 bundle 建树、交 bundle、快进，
// 没跑成的明确报错，不拿空结果冒充「没有改动」。
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PortError } from '../../src/ports.ts';
import { localExec } from '../../src/real/exec.ts';
import { OUT_DIR } from '../../src/real/prompts.ts';
import {
  bundleSince,
  changedFilesSince,
  checkoutBranch,
  checkoutDetached,
  commitsSince,
  DISPOSABLE,
  disposableArgs,
  fastForward,
  fetchBundle,
  headOf,
  LEFTOVER_LIST_MAX,
  mainlineRef,
  mergeInto,
  pinMainline,
  readFileAs,
  treeLeftovers,
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

  it('建树时关掉 git 的自动维护：主线一次次取进树里，包还是一个一个的，没有后台的重打包和删树抢', async () => {
    const m = mirror();
    const t = tree('work');
    await fetchBundle(t, m.bundle(m.head), 'refs/fleet/export/0', {
      identity: { name: 'fleet-dao-agent[bot]', email: 'bofleet-test@localhost' },
    });
    expect(sh(t.dir, 'config', 'maintenance.auto')).toBe('false');
    expect(sh(t.dir, 'config', 'gc.auto')).toBe('0');
    // 没关的话：git 2.54 起（CI 上是 2.55）每次取完都跑自动维护，默认的几何重打包取到第三个包就把它们并掉；Linux 上它
    // 脱离前台在后台跑，删树时还在写 .git/objects（github-ports 的用例因此在 CI 上报过 ENOTEMPTY）。这里让它在前台跑，
    // 并没并包就是确定的：上面两行关掉的话这条必红。更老的 git 不自己并包，这条在那儿照样过。
    sh(t.dir, 'config', 'maintenance.autoDetach', 'false');
    let tip = m.head;
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(m.dir, `f${i}.ts`), `export const f${i} = ${i};\n`);
      sh(m.dir, 'add', '.');
      sh(m.dir, 'commit', '-q', '-m', `main: f${i}`);
      const next = sh(m.dir, 'rev-parse', 'HEAD');
      expect(await fetchBundle(t, m.bundle(next, tip), 'refs/fleet/export/0')).toBe(next);
      tip = next;
    }
    const packs = readdirSync(join(t.dir, '.git', 'objects', 'pack')).filter((f) => f.endsWith('.pack'));
    expect(packs).toHaveLength(4);
  });

  it('【故意造出的失败】关自动维护那一步没写成：建树报 GIT_FAILED、说清是哪一步，不带着后台维护接着建', async () => {
    const m = mirror();
    const t = tree('work');
    const real = localExec();
    const exec: UserTree['exec'] = (c) =>
      c.argv.includes('maintenance.auto')
        ? Promise.resolve({
            code: 255,
            stdout: Buffer.alloc(0),
            stderr: 'error: 故意造的写不了配置\n',
            timedOut: false,
            aborted: false,
          })
        : real(c);
    const err = await fetchBundle({ ...t, exec }, m.bundle(m.head), 'refs/fleet/export/0').catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: 'GIT_FAILED', retryable: true });
    expect((err as Error).message).toContain('关掉自动维护');
    expect((err as Error).message).toContain('故意造的写不了配置');
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

// 每小时对账删一棵没人用的树之前，以会话用户的身份看里面还剩什么：剩着没推的提交、没提交的改动、stash 就不删、交人拍。
// 只会多算不会少算；能重新生成的缓存（DISPOSABLE）是不是 git 仓都不算；git 没跑成、有目录读不了明确报错，不拿空结果
// 冒充「什么都不剩」（那样会把人的活删掉）。
describe('树里还剩什么（每小时对账删树之前看）', { timeout: 60_000 }, () => {
  /** 和引擎建的一样：从 bundle 建树、检出分支、钉主线。 */
  async function checkedOut(name = 'left', from?: ReturnType<typeof mirror>) {
    const m = from ?? mirror();
    const t = tree(name);
    await fetchBundle(t, m.bundle(m.head), 'refs/fleet/export/0');
    await checkoutBranch(t, 'fleet/12-a', m.head);
    await pinMainline(t, 'main', m.head);
    return { m, t };
  }
  const commit = (dir: string, file: string, msg: string) => {
    writeFileSync(join(dir, file), `${msg}\n`);
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', msg], { cwd: dir, env: ENV });
    return sh(dir, 'rev-parse', 'HEAD');
  };

  it('空目录（建树建到一半）：什么都不剩；不是仓却有东西：列出文件，不当成空的', async () => {
    const t = tree('half');
    expect(await treeLeftovers(t, [])).toEqual({ kind: 'empty' });
    writeFileSync(join(t.dir, 'notes.md'), 'x\n');
    expect(await treeLeftovers(t, [])).toEqual({ kind: 'not-repo', files: ['notes.md'], fileCount: 1 });
  });

  /** 在目录里写一个文件（中间各级不在就建）。 */
  const put = (dir: string, rel: string, body = 'x\n') => {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), body);
  };

  it('不是仓、只剩能重新生成的缓存（法国 160-handover-store 只剩两个 tsbuildinfo）：当成什么都不剩；名单里的每一样、哪一层都算，空目录也不算', async () => {
    const t = tree('handover');
    put(t.dir, 'packages/api/tsconfig.tsbuildinfo', '{}');
    put(t.dir, 'packages/db/tsconfig.tsbuildinfo', '{}');
    expect(await treeLeftovers(t, [])).toEqual({ kind: 'empty' });

    put(t.dir, 'node_modules/.pnpm/foo@1.0.0/node_modules/foo/index.js');
    put(t.dir, 'packages/api/dist/index.js');
    put(t.dir, '.turbo/cache/abc.tar.zst');
    put(t.dir, '.vite/deps/_metadata.json');
    put(t.dir, 'packages/db/coverage/lcov.info');
    put(t.dir, `${OUT_DIR}/plan.md`);
    mkdirSync(join(t.dir, 'src', 'empty'), { recursive: true });
    expect(await treeLeftovers(t, [])).toEqual({ kind: 'empty' });
  });

  it('不是仓、缓存以外还有一个源文件：不当成空的，只列那个文件；多了列排好序的前几个、写明一共几个', async () => {
    const t = tree('mixed');
    put(t.dir, 'packages/api/tsconfig.tsbuildinfo', '{}');
    put(t.dir, 'packages/api/dist/index.js');
    put(t.dir, 'packages/api/src/handover.ts');
    expect(await treeLeftovers(t, [])).toEqual({
      kind: 'not-repo',
      files: ['packages/api/src/handover.ts'],
      fileCount: 1,
    });

    const names = Array.from(
      { length: LEFTOVER_LIST_MAX + 2 },
      (_, i) => `f${String(i).padStart(2, '0')}.ts`,
    );
    for (const n of [...names].reverse()) put(t.dir, n);
    const left = await treeLeftovers(t, []);
    expect(left).toMatchObject({ kind: 'not-repo', fileCount: LEFTOVER_LIST_MAX + 3 });
    expect(left.kind === 'not-repo' ? left.files : []).toEqual(names.slice(0, LEFTOVER_LIST_MAX));
  });

  it('git 仓里也一样：没跟踪的缓存（仓里没写 .gitignore）不算剩着；缓存旁边的新文件照算、一个一个列（中文路径原样）；仓里跟踪着的缓存文件改了照算', async () => {
    const { m, t } = await checkedOut();
    put(t.dir, 'packages/api/tsconfig.tsbuildinfo', '{}');
    put(t.dir, 'packages/api/dist/index.js');
    put(t.dir, 'node_modules/foo/index.js');
    put(t.dir, 'coverage/lcov.info');
    put(t.dir, `${OUT_DIR}/review.json`, '{}');
    expect(await treeLeftovers(t, [])).toEqual({
      kind: 'repo',
      dirty: [],
      dirtyCount: 0,
      stashes: 0,
      unpushed: [],
      unpushedCount: 0,
    });

    put(t.dir, 'packages/api/src/handover.ts');
    put(t.dir, 'specs/1-新单/需求.md');
    expect(await treeLeftovers(t, [])).toMatchObject({
      dirty: ['?? packages/api/src/handover.ts', '?? specs/1-新单/需求.md'],
      dirtyCount: 2,
    });

    // 仓把 dist/ 当源码提交了（推上去过）：改了照算
    const u = (await checkedOut('tracked', m)).t;
    put(u.dir, 'dist/keep.js', 'v1\n');
    execFileSync('git', ['add', '.'], { cwd: u.dir });
    execFileSync('git', ['commit', '-q', '-m', 'commit dist'], { cwd: u.dir, env: ENV });
    const pushed = sh(u.dir, 'rev-parse', 'HEAD');
    expect(await treeLeftovers(u, [pushed])).toMatchObject({ dirtyCount: 0, unpushedCount: 0 });
    put(u.dir, 'dist/keep.js', 'v2\n');
    expect(await treeLeftovers(u, [pushed])).toMatchObject({ dirty: [' M dist/keep.js'], dirtyCount: 1 });
  });

  it('不算剩着的名单：每条写了为什么、都是单层名字、含会话的结论文件目录；认不出的写法明确拒，不当成名单是空的', () => {
    expect(DISPOSABLE.map((d) => d.pattern)).toEqual(
      expect.arrayContaining([
        '*.tsbuildinfo',
        'node_modules/',
        'dist/',
        '.turbo/',
        '.vite/',
        'coverage/',
        `${OUT_DIR}/`,
      ]),
    );
    for (const d of DISPOSABLE) expect(d.why, d.pattern).toMatch(/：/);
    expect(disposableArgs(['dist/', 'coverage/', '*.tsbuildinfo'])).toEqual({
      git: ['--exclude=dist/', '--exclude=coverage/', '--exclude=*.tsbuildinfo'],
      find: [
        ...['-type', 'd', '(', '-name', 'dist', '-o', '-name', 'coverage', ')', '-prune', '-o'],
        ...['(', '-name', '*.tsbuildinfo', ')', '-o'],
        ...['!', '-type', 'd', '-print0'],
      ],
    });
    for (const bad of ['*', '*/', '.', '..', '../x', 'a/b', 'src/dist/', '', 'dist //', '-delete']) {
      expect(() => disposableArgs([bad]), bad).toThrow(PortError);
    }
  });

  it('检出好了、会话没动过（写码的树、分离头的检出副本）：什么都不剩——引擎交给它的头、钉的主线都算推过', async () => {
    const { m, t } = await checkedOut();
    expect(await treeLeftovers(t, [])).toEqual({
      kind: 'repo',
      dirty: [],
      dirtyCount: 0,
      stashes: 0,
      unpushed: [],
      unpushedCount: 0,
    });
    const s = tree('scratch');
    await fetchBundle(s, m.bundle(m.head), 'refs/fleet/export/0');
    await checkoutDetached(s, m.head);
    expect(await treeLeftovers(s, [])).toMatchObject({ kind: 'repo', unpushedCount: 0, dirtyCount: 0 });
  });

  it('会话提交了没推：数出来、列出来；推上去过（PR 镜像里的头）就不算', async () => {
    const { t } = await checkedOut();
    commit(t.dir, 'b.ts', 'add b');
    const head = commit(t.dir, 'c.ts', 'add c');
    const left = await treeLeftovers(t, []);
    expect(left).toMatchObject({ kind: 'repo', unpushedCount: 2 });
    expect(left.kind === 'repo' ? left.unpushed.map((l) => l.replace(/^\w+ /, '')) : []).toEqual([
      'add c',
      'add b',
    ]);
    expect(await treeLeftovers(t, [head])).toMatchObject({ kind: 'repo', unpushedCount: 0 });
  });

  it('给的头树里没有：跳过、只会多算（照样算没推）；提交号不对明确拒', async () => {
    const { t } = await checkedOut();
    commit(t.dir, 'b.ts', 'add b');
    expect(await treeLeftovers(t, ['f'.repeat(40)])).toMatchObject({ kind: 'repo', unpushedCount: 1 });
    await expect(treeLeftovers(t, ['HEAD'])).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });

  it('另开的本地分支上的提交、没提交的改动、没跟踪的新文件、stash 都算剩着；被忽略的不算', async () => {
    const { m, t } = await checkedOut();
    sh(t.dir, 'checkout', '-q', '-b', 'side');
    commit(t.dir, 'side.ts', 'on side');
    sh(t.dir, 'checkout', '-q', 'fleet/12-a');
    expect(await treeLeftovers(t, [])).toMatchObject({ unpushedCount: 1 });

    const u = (await checkedOut('dirty', m)).t;
    writeFileSync(join(u.dir, 'a.ts'), 'changed\n');
    writeFileSync(join(u.dir, 'new.ts'), 'new\n');
    writeFileSync(join(u.dir, '.git', 'info', 'exclude'), 'ignored.log\n');
    writeFileSync(join(u.dir, 'ignored.log'), 'noise\n');
    const left = await treeLeftovers(u, []);
    expect(left).toMatchObject({ kind: 'repo', dirtyCount: 2, stashes: 0, unpushedCount: 0 });
    expect(left.kind === 'repo' ? left.dirty : []).toEqual([' M a.ts', '?? new.ts']);

    execFileSync('git', ['stash', '-q', '--include-untracked'], { cwd: u.dir, env: ENV });
    expect(await treeLeftovers(u, [])).toMatchObject({ dirtyCount: 0, stashes: 1 });
  });

  it('git 没跑成、列不了目录：明确报错，不当成什么都不剩', async () => {
    const { t } = await checkedOut();
    const real = localExec();
    const failWith = (code: number, stderr: string) =>
      Promise.resolve({ code, stdout: Buffer.alloc(0), stderr, timedOut: false, aborted: false });
    const statusFails: UserTree['exec'] = (c) =>
      c.argv.includes('status') ? failWith(128, 'fatal: 故意造的读不了索引\n') : real(c);
    await expect(treeLeftovers({ ...t, exec: statusFails }, [])).rejects.toMatchObject({
      code: 'GIT_FAILED',
    });
    const listFails: UserTree['exec'] = (c) => (c.argv[0] === 'sh' ? failWith(2, 'ls: 读不了\n') : real(c));
    await expect(treeLeftovers({ ...tree('half'), exec: listFails }, [])).rejects.toMatchObject({
      code: 'READ_FAILED',
    });
    const bornFails: UserTree['exec'] = (c) =>
      c.argv.includes('HEAD^{commit}') ? failWith(129, 'fatal: 故意造的\n') : real(c);
    await expect(treeLeftovers({ ...t, exec: bornFails }, [])).rejects.toMatchObject({ code: 'GIT_FAILED' });
    const reflogFails: UserTree['exec'] = (c) =>
      c.argv.includes('reflog') ? failWith(128, 'fatal: 故意造的读不了检出记录\n') : real(c);
    await expect(treeLeftovers({ ...t, exec: reflogFails }, [], { scratch: true })).rejects.toMatchObject({
      code: 'GIT_FAILED',
      message: expect.stringContaining('读检出记录'),
    });
  });

  // git 碰上读不了的目录只打一行、照样退出 0；find 照样往下列、最后退出 1。三处都故意造一遍：一律没查成，不当成那里是空的。
  it('有读不了的目录：不是仓的（find 退出 1）、git 只打一行警告的（没跟踪的目录、跟踪着的文件）都明确报 READ_FAILED', async () => {
    const real = localExec();
    const withStderr =
      (match: (argv: string[]) => boolean, code: number, stderr: string): UserTree['exec'] =>
      async (c) => {
        if (!match(c.argv)) return real(c);
        const r = await real(c);
        return { ...r, code, stderr: `${r.stderr}${stderr}` };
      };
    const half = tree('locked-half');
    put(half.dir, 'packages/api/tsconfig.tsbuildinfo', '{}');
    const findDenied = withStderr(
      (a) => a.join(' ').includes('find'),
      1,
      "find: './locked': Permission denied\n",
    );
    await expect(treeLeftovers({ ...half, exec: findDenied }, [])).rejects.toMatchObject({
      code: 'READ_FAILED',
      message: expect.stringMatching(/^列树里的东西：退出码 1（.*Permission denied/),
    });

    const { t } = await checkedOut();
    const lsDenied = withStderr(
      (a) => a.includes('ls-files'),
      0,
      "warning: could not open directory 'locked/': Permission denied\n",
    );
    await expect(treeLeftovers({ ...t, exec: lsDenied }, [])).rejects.toMatchObject({
      code: 'READ_FAILED',
      message:
        "列没跟踪的新文件：有读不了的地方（warning: could not open directory 'locked/': Permission denied）",
    });
    const statusDenied = withStderr((a) => a.includes('status'), 0, 'sub/a.ts: Permission denied\n');
    await expect(treeLeftovers({ ...t, exec: statusDenied }, [])).rejects.toMatchObject({
      code: 'READ_FAILED',
      message: '看有没有没提交的改动：有读不了的地方（sub/a.ts: Permission denied）',
    });
  });

  // 真把目录权限去掉：Windows 上去不掉，root 照样读得了，这两处不跑（CI 是 Linux 普通用户）。
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    '真有读不了的目录（chmod 000）：不是仓的、git 仓里的都没查成，不当成什么都不剩',
    async () => {
      const half = tree('locked-half');
      put(half.dir, 'packages/api/tsconfig.tsbuildinfo', '{}');
      put(half.dir, 'locked/secret.ts');
      const { t } = await checkedOut();
      put(t.dir, 'locked/secret.ts');
      chmodSync(join(half.dir, 'locked'), 0o000);
      chmodSync(join(t.dir, 'locked'), 0o000);
      try {
        await expect(treeLeftovers(half, [])).rejects.toMatchObject({ code: 'READ_FAILED' });
        await expect(treeLeftovers(t, [])).rejects.toBeInstanceOf(PortError);
      } finally {
        chmodSync(join(half.dir, 'locked'), 0o755);
        chmodSync(join(t.dir, 'locked'), 0o755);
      }
    },
  );

  it('检出副本（引擎从镜像检出、会话只写 .fleet-out/）：检出过的提交算推过、结论文件不算剩着；会话自己的提交和别的改动照算', async () => {
    const m = mirror();
    // 子任务分支上一个提交（PR 头），之后主线又往前走了一步
    sh(m.dir, 'checkout', '-q', '-b', 'fleet/12-a');
    writeFileSync(join(m.dir, 'pr.ts'), 'export const pr = 1;\n');
    sh(m.dir, 'add', '.');
    sh(m.dir, 'commit', '-q', '-m', 'pr work');
    const pr = sh(m.dir, 'rev-parse', 'HEAD');
    sh(m.dir, 'checkout', '-q', 'main');
    writeFileSync(join(m.dir, 'main2.ts'), 'export const m = 2;\n');
    sh(m.dir, 'add', '.');
    sh(m.dir, 'commit', '-q', '-m', 'mainline moved');
    const main2 = sh(m.dir, 'rev-parse', 'HEAD');
    // 和引擎给审查会话备的一样：检出 PR 头，主线另取进来再钉（refs/fleet/incoming 换成了主线头）
    const s = tree('12.review.a');
    await fetchBundle(s, m.bundle(pr), 'refs/fleet/export/0');
    await checkoutDetached(s, pr);
    await fetchBundle(s, m.bundle(main2, pr), 'refs/fleet/export/0');
    await pinMainline(s, 'main', main2);
    mkdirSync(join(s.dir, '.fleet-out'));
    writeFileSync(join(s.dir, '.fleet-out', 'review.json'), '{}\n');
    const scratch = { scratch: true };

    // 当成写码的树看：PR 头那个提交算剩着（只会多算）；结论文件哪种树都不算
    expect(await treeLeftovers(s, [])).toMatchObject({ unpushedCount: 1, dirtyCount: 0 });
    expect(await treeLeftovers(s, [], scratch)).toEqual({
      kind: 'repo',
      dirty: [],
      dirtyCount: 0,
      stashes: 0,
      unpushed: [],
      unpushedCount: 0,
    });

    // 会话在副本里自己提交了、还留了别的文件：照算，结论文件照旧不算
    writeFileSync(join(s.dir, 'extra.ts'), 'x\n');
    sh(s.dir, 'add', 'extra.ts');
    sh(s.dir, 'commit', '-q', '-m', 'session commit in scratch');
    writeFileSync(join(s.dir, 'stray.ts'), 'y\n');
    const left = await treeLeftovers(s, [], scratch);
    expect(left).toMatchObject({ kind: 'repo', unpushedCount: 1, dirtyCount: 1, dirty: ['?? stray.ts'] });
    expect(left.kind === 'repo' ? left.unpushed.map((l) => l.replace(/^\w+ /, '')) : []).toEqual([
      'session commit in scratch',
    ]);
  });

  it('建树时 init 之后取包没成（还没有提交的仓）：不报错，只看分支、标签和没提交的文件', async () => {
    const t = tree('unborn');
    sh(t.dir, 'init', '-q');
    expect(await treeLeftovers(t, [])).toEqual({
      kind: 'repo',
      dirty: [],
      dirtyCount: 0,
      stashes: 0,
      unpushed: [],
      unpushedCount: 0,
    });
    expect(await treeLeftovers(t, [], { scratch: true })).toMatchObject({ unpushedCount: 0 });
    writeFileSync(join(t.dir, 'x.ts'), 'x\n');
    expect(await treeLeftovers(t, [])).toMatchObject({ dirtyCount: 1, unpushedCount: 0 });
  });
});
