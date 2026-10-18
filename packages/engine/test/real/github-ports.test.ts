// 引擎端口 → github 包：推分支（会话用户打 bundle）、开 PR（照抄需求 issue 的标签和里程碑）、并主线后快进会话的树、
// 在新头上跑测试（= 等 CI）、收树先存档；GitHubError 换成 PortError。github 包本身换成假的（记下每次调用），
// 会话用户的 git 用本地 git。
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubError, renderPrBody } from '@fleet-dao/github';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type PortContext, PortError } from '../../src/ports.ts';
import { localExec } from '../../src/real/exec.ts';
import { createGitHubPorts, type EngineGitHub, toPortError } from '../../src/real/github-ports.ts';
import { checkoutBranch, fetchBundle } from '../../src/real/user-git.ts';
import { runChildOk } from '../child.ts';
import { fakeTrees, git, mirror } from './fixtures.ts';

// 每条用例（和每条用例前建的镜像）都真跑好几次 git（Windows 上一次几百毫秒），机器忙时默认的 5 秒、10 秒不够。
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ctx: PortContext = {
  signal: new AbortController().signal,
  heartbeat() {},
  attempt: 1,
  lastHeartbeat: undefined,
};
const repo = {
  id: 'repo-1',
  owner: 'acme',
  name: 'widgets',
  defaultBranch: 'main',
  testCommand: 'pnpm check',
};
const BRANCH = 'fleet/12-login';

let root: string;
let m: ReturnType<typeof mirror>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-gh-ports-'));
  m = mirror(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

type Calls = Record<string, unknown[]>;

function fakeGh(over: Partial<Record<keyof EngineGitHub, (input: never) => unknown>> = {}) {
  const calls: Calls = {};
  const record = (name: keyof EngineGitHub, fallback: (input: never) => unknown) => async (input: never) => {
    const list = calls[name] ?? [];
    list.push(input);
    calls[name] = list;
    const fn = over[name] ?? fallback;
    return fn(input);
  };
  const gh = {
    fetchMainline: record('fetchMainline', () => m.gh.fetchMainline()),
    bundleCommits: record('bundleCommits', (input) => m.gh.bundleCommits(input)),
    commitIdentity: record('commitIdentity', () => m.gh.commitIdentity()),
    pushBranch: record('pushBranch', (input: { bundlePath: string; head: string }) => {
      // 推之前核对一下交来的包是好的：git bundle verify 在镜像里过得了。
      runChildOk('git', ['bundle', 'verify', input.bundlePath], { cwd: m.dir, stdio: 'pipe' });
      return { head: input.head, pushed: true };
    }),
    openPr: record('openPr', () => ({ number: 101, url: 'https://github.com/acme/widgets/pull/101' })),
    // 开 PR 前列开着的 PR（同一张单有没有别人在做，决定 0096）：默认一个都没有；用例给 over.claims 换成要的列表
    claims: {
      openPulls: record('claims', () => []),
      closePull: async (_repo: unknown, number: number) => {
        const list = calls.closePull ?? [];
        list.push(number);
        calls.closePull = list;
      },
      updatePullBody: async (_repo: unknown, number: number, body: unknown) => {
        const list = calls.updatePullBody ?? [];
        list.push({ number, body });
        calls.updatePullBody = list;
      },
    },
    waitCi: record('waitCi', (input: { head: string }) => ({ state: 'green', head: input.head })),
    fetchBranchHead: record('fetchBranchHead', () => ({ head: m.head })),
    syncMainline: record('syncMainline', (input: { head: string }) => ({
      state: 'clean',
      head: input.head,
      merged: false,
      previousHead: input.head,
      mainline: m.head,
    })),
    mergePr: record('mergePr', () => ({ merged: true, mergeCommit: 'c'.repeat(40) })),
    updateIssueProgress: record('updateIssueProgress', () => ({ updated: true })),
    closeIssue: record('closeIssue', () => ({ closed: true })),
    commentPull: record('commentPull', () => ({
      commentId: 1,
      url: 'https://github.com/acme/widgets/pull/101#issuecomment-1',
      created: true,
    })),
    writeSpecDoc: record('writeSpecDoc', (input: { path: string }) => ({
      path: input.path,
      commit: 'd'.repeat(40),
      changed: true,
      url: 'x',
    })),
    readSpecDoc: record('readSpecDoc', (input: { path: string }) => ({
      path: input.path,
      content: '# 需求\n\n对应计划：plan.md P1「工作流」\n',
      url: 'x',
    })),
    readIssuePlan: record('readIssuePlan', () => ({
      state: 'open',
      reopened: false,
      pullRequest: false,
      author: 'fleet-engine[bot]',
      milestone: { number: 8, title: 'v1 Fusion 接活' },
      openMilestones: [{ number: 8, title: 'v1 Fusion 接活' }],
      labels: ['缺陷'],
      parent: null,
      subIssues: 0,
    })),
    readIssue: record('readIssue', () => ({
      number: 12,
      title: '登录',
      body: '',
      state: 'open' as const,
      labels: ['缺陷', '域:engine', '性质:bug'],
    })),
  } as unknown as EngineGitHub;
  return { gh, calls };
}

function setup(over: Parameters<typeof fakeGh>[0] = {}, opts: { heartbeatEveryMs?: number } = {}) {
  const { gh, calls } = fakeGh(over);
  const trees = fakeTrees(join(root, 'work'));
  const ports = createGitHubPorts({
    gh,
    trees: trees.trees,
    exec: localExec(),
    tmpDir: join(root, 'tmp'),
    archiveDir: join(root, 'archive'),
    gitBin: 'git',
    shBin: 'sh',
    now: () => new Date('2026-09-25T08:00:00Z'),
    ...opts,
  });
  return { ports, calls, trees, gh };
}

/** 会话用户那边的树：从镜像取主线头、检出分支（和 sessions.ts 建树一样）。 */
async function seededTree(trees: ReturnType<typeof setup>['trees']) {
  const dir = trees.trees.treeFor(repo, BRANCH);
  await trees.trees.adopt(dir, 'fleet-agent-carpool');
  const t = {
    exec: localExec(),
    user: 'fleet-agent-carpool' as const,
    dir,
    scopePrefix: 'test',
    git: 'git',
    sh: 'sh',
  };
  const out = join(root, `seed-${Date.now()}.bundle`);
  const made = await m.gh.bundleCommits({ tips: [m.head], outPath: out });
  // 提交身份和真建树一样设在树里（sessions.ts 建树时设「干活的」机器人）：推之前并主线要用它提交
  await fetchBundle(t, readFileSync(made.path), made.refs[0]?.ref as string, {
    identity: { name: 't', email: 'fleet-test@localhost' },
  });
  await checkoutBranch(t, BRANCH, m.head);
  return dir;
}

function commitIn(dir: string, file: string) {
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', file), 'export const x = 1;\n');
  git(dir, 'add', '--', 'src');
  git(dir, 'commit', '-q', '-m', `feat: ${file}`);
  return git(dir, 'rev-parse', 'HEAD');
}

/** 直接在镜像里补一个提交（顶替「远端此刻的头」：帅位手推、或 CI 认下的新头，对象要在镜像里才能打包出来）。 */
function commitInMirror(file: string, content: string) {
  writeFileSync(join(m.dir, file), content);
  git(m.dir, 'add', '.');
  git(m.dir, 'commit', '-q', '-m', `on top: ${file}`);
  return git(m.dir, 'rev-parse', 'HEAD');
}

describe('GitHubError → PortError', () => {
  it('卫生检查拦下：命中处排好序拼成稳定的一句（不带值），不可重试', () => {
    const e = toPortError(
      new GitHubError('HYGIENE_BLOCKED', '拦下了', {
        retryable: false,
        details: {
          findings: [
            { path: 'src/b.ts', line: 3, rule: 'token' },
            { path: 'src/a.ts', line: 9, rule: 'webhook' },
          ],
        },
      }),
    ) as PortError;
    expect(e).toBeInstanceOf(PortError);
    expect(e.code).toBe('HYGIENE_BLOCKED');
    expect(e.retryable).toBe(false);
    expect(e.message).toBe('卫生检查拦下了要公开的内容：src/a.ts:9 webhook；src/b.ts:3 token');
  });

  it('workflows 权限的码按引擎的叫法；不是 GitHubError 的原样放行', () => {
    const e = toPortError(new GitHubError('WORKFLOW_PERMISSION', 'x', { retryable: false })) as PortError;
    expect(e.code).toBe('WORKFLOWS_PERMISSION');
    const plain = new Error('别的错');
    expect(toPortError(plain)).toBe(plain);
  });
});

describe('建树、收树', () => {
  it('建树只定位置、记下主线的头；同一位置留着的旧树先删掉', async () => {
    const { ports, trees } = setup();
    const stale = trees.trees.treeFor(repo, BRANCH);
    await trees.trees.adopt(stale, 'fleet-agent-carpool');
    const tree = await ports.createWorktree({ taskId: 't1', repo, branch: BRANCH }, ctx);
    expect(tree).toEqual({ path: stale, branch: BRANCH, baseSha: m.head });
    expect(trees.owners.has(stale)).toBe(false);
  });

  it('建树等 GitHub 的时候照常心跳（setup 一档要心跳：大仓第一次抓进镜像可能要好几分钟）', async () => {
    const { ports } = setup(
      {
        fetchMainline: async () => {
          await new Promise((r) => setTimeout(r, 120));
          return m.gh.fetchMainline();
        },
      },
      { heartbeatEveryMs: 20 },
    );
    let beats = 0;
    const counting: PortContext = {
      ...ctx,
      heartbeat: () => {
        beats += 1;
      },
    };
    await ports.createWorktree({ taskId: 't1', repo, branch: BRANCH }, counting);
    expect(beats).toBeGreaterThanOrEqual(3);
    // 结束就停：之后不再报
    const after = beats;
    await new Promise((r) => setTimeout(r, 60));
    expect(beats).toBe(after);
  });

  it('建树时删同一位置留着的大旧树，删的时候也照常心跳', async () => {
    const { ports, trees } = setup({}, { heartbeatEveryMs: 20 });
    const stale = trees.trees.treeFor(repo, BRANCH);
    await trees.trees.adopt(stale, 'fleet-agent-carpool');
    const remove = trees.trees.remove.bind(trees.trees);
    trees.trees.remove = async (dir) => {
      await new Promise((r) => setTimeout(r, 120));
      return remove(dir);
    };
    let beats = 0;
    let beatsAtRemove = -1;
    const counting: PortContext = {
      ...ctx,
      heartbeat: () => {
        beats += 1;
      },
    };
    const slowRemove = trees.trees.remove;
    trees.trees.remove = async (dir) => {
      beatsAtRemove = beats;
      return slowRemove(dir);
    };
    await ports.createWorktree({ taskId: 't1', repo, branch: BRANCH }, counting);
    expect(beatsAtRemove).toBeGreaterThanOrEqual(1);
    // 删的那 120 毫秒里（每 20 毫秒一次）至少又报了两次
    expect(beats - beatsAtRemove).toBeGreaterThanOrEqual(2);
    expect(trees.owners.has(stale)).toBe(false);
  });

  it('没合并就收：没提交的改动存档成补丁再删；本来就不在的正常返回', async () => {
    const { ports, trees } = setup();
    const dir = await seededTree(trees);
    writeFileSync(join(dir, 'README.md'), '# 改了没提交\n');
    const r = await ports.removeWorktree(
      { taskId: 't1', subtaskKey: 'login', repo, path: dir, branch: BRANCH, archive: true },
      ctx,
    );
    expect(r).toMatchObject({ removed: true, gone: false });
    expect(r.archivedTo && readFileSync(r.archivedTo, 'utf8')).toContain('改了没提交');
    expect(existsSync(dir)).toBe(false);
    expect(
      await ports.removeWorktree({ taskId: 't1', repo, path: dir, branch: BRANCH, archive: true }, ctx),
    ).toEqual({ removed: false, gone: true });
  });
});

describe('收树前核对界面截图（#2983）', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const png = (tag: string) => Buffer.concat([PNG, Buffer.from(tag)]);

  function shotIn(dir: string, rel: string, bytes: Buffer) {
    const file = join(dir, '_tmp', 'shots', rel);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, bytes);
  }

  /** 镜像里放一个只含图片的孤儿提交（顶替远端 shots/<单号> 的头）。 */
  function shotsCommitInMirror(files: Record<string, Buffer>): string {
    const work = join(root, 'shots-src');
    mkdirSync(work, { recursive: true });
    for (const [name, bytes] of Object.entries(files)) writeFileSync(join(work, name), bytes);
    // 提交身份放进环境：CI 的机器上没有全局的 user.name
    const env = {
      ...process.env,
      GIT_INDEX_FILE: join(root, 'shots.idx'),
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 'fleet-test@localhost',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 'fleet-test@localhost',
    };
    runChildOk('git', ['--work-tree', work, 'add', '-f', '.'], { cwd: m.dir, env });
    const t = runChildOk('git', ['write-tree'], { cwd: m.dir, env });
    const c = runChildOk('git', ['commit-tree', t, '-m', '截图'], { cwd: m.dir, env });
    rmSync(work, { recursive: true, force: true });
    rmSync(join(root, 'shots.idx'), { force: true });
    return c;
  }

  const remoteShots = (head: string | null) => (input: { branch: string }) => ({
    head: input.branch === 'shots/12' ? head : m.head,
  });
  const shots = () => ({ issueNumber: 12, head: m.head });

  it('复现 #2969：代码合并了，图片只在树里、远端 shots/12 不在（404）：先存进受限归档、记清单，再删树', async () => {
    const { ports, trees } = setup({ fetchBranchHead: remoteShots(null) });
    const dir = await seededTree(trees);
    shotIn(dir, '12/home-1366-light.png', png('after'));
    const r = await ports.removeWorktree(
      { taskId: 't1', repo, path: dir, branch: BRANCH, archive: false, shots: shots() },
      ctx,
    );
    expect(r).toMatchObject({ removed: true, gone: false, shots: { outcome: 'archived', head: m.head } });
    expect(r.shots?.reason).toContain('404');
    const manifest = JSON.parse(readFileSync(r.shots?.archivedTo as string, 'utf8'));
    expect(manifest.delivery.files[0]).toMatchObject({
      path: '12/home-1366-light.png',
      bytes: png('after').length,
    });
    const stored = readdirSync(join(r.shots?.archivedTo as string, '..')).filter((f) => f.endsWith('.png'));
    expect(stored).toHaveLength(1);
    expect(existsSync(dir)).toBe(false);
  });

  it('远端 shots/12 上读得到同样的 blob：已交付，不存图，照常删树', async () => {
    const remote = shotsCommitInMirror({ 'home-1366-light.png': png('after') });
    const { ports, trees } = setup({ fetchBranchHead: remoteShots(remote) });
    const dir = await seededTree(trees);
    shotIn(dir, '12/home-1366-light.png', png('after'));
    const r = await ports.removeWorktree(
      { taskId: 't1', repo, path: dir, branch: BRANCH, archive: false, shots: shots() },
      ctx,
    );
    expect(r).toMatchObject({ removed: true, shots: { outcome: 'delivered', remoteHead: remote } });
    expect(existsSync(dir)).toBe(false);
  });

  it('【故意造出的失败】远端 shots/12 在、缺这张的 blob（只在本地）：待交付，存进归档', async () => {
    const remote = shotsCommitInMirror({ 'other.png': png('someone-else') });
    const { ports, trees } = setup({ fetchBranchHead: remoteShots(remote) });
    const dir = await seededTree(trees);
    shotIn(dir, '12/mine.png', png('mine'));
    const r = await ports.removeWorktree(
      { taskId: 't1', repo, path: dir, branch: BRANCH, archive: false, shots: shots() },
      ctx,
    );
    expect(r.shots).toMatchObject({ outcome: 'archived', missing: ['12/mine.png'], remoteHead: remote });
  });

  it('【故意造出的失败】归档写不进去：不删树，kept 写原因；修好后重试存上再删，再重试按清单说', async () => {
    const { ports, trees } = setup({ fetchBranchHead: remoteShots(null) });
    const dir = await seededTree(trees);
    shotIn(dir, '12/a.png', png('a'));
    writeFileSync(join(root, 'archive'), '占住了');
    const call = () =>
      ports.removeWorktree(
        { taskId: 't1', repo, path: dir, branch: BRANCH, archive: false, shots: shots() },
        ctx,
      );
    const kept = await call();
    expect(kept).toMatchObject({ removed: false, gone: false, shots: { outcome: 'failed' } });
    expect(kept.kept).toContain('归档没成');
    expect(existsSync(join(dir, '_tmp', 'shots', '12', 'a.png'))).toBe(true);
    rmSync(join(root, 'archive'));
    const done = await call();
    expect(done).toMatchObject({ removed: true, shots: { outcome: 'archived' } });
    expect(existsSync(dir)).toBe(false);
    const again = await call();
    expect(again).toEqual({ removed: false, gone: true, shots: done.shots });
  });

  it('【故意造出的失败】叫停：原样抛，树留着', async () => {
    const { ports, trees } = setup({ fetchBranchHead: remoteShots(null) });
    const dir = await seededTree(trees);
    shotIn(dir, '12/a.png', png('a'));
    const abort = new AbortController();
    abort.abort();
    await expect(
      ports.removeWorktree(
        { taskId: 't1', repo, path: dir, branch: BRANCH, archive: false, shots: shots() },
        { ...ctx, signal: abort.signal },
      ),
    ).rejects.toThrow();
    expect(existsSync(dir)).toBe(true);
  });

  it('老历史、没推过的不带 shots：一样过这一道（按树的 HEAD、分支里的单号看远端），有图存进归档才删；没图结果和原来一样', async () => {
    const { ports, trees, calls } = setup({ fetchBranchHead: remoteShots(null) });
    const dir = await seededTree(trees);
    shotIn(dir, '12/a.png', png('a'));
    const r = await ports.removeWorktree(
      { taskId: 't1', repo, path: dir, branch: BRANCH, archive: true },
      ctx,
    );
    expect(r).toMatchObject({ removed: true, shots: { outcome: 'archived', branch: 'shots/12' } });
    expect(r.shots?.reason).toContain('404');
    expect(calls.fetchBranchHead).toBeDefined();
    expect(existsSync(dir)).toBe(false);

    const plain = await seededTree(trees);
    expect(
      await ports.removeWorktree({ taskId: 't1', repo, path: plain, branch: BRANCH, archive: false }, ctx),
    ).toEqual({ removed: true, gone: false });
  });

  it('【故意造出的失败】不带 shots、归档写不进去：一样不删树，kept 写原因', async () => {
    const { ports, trees } = setup({ fetchBranchHead: remoteShots(null) });
    const dir = await seededTree(trees);
    shotIn(dir, '12/a.png', png('a'));
    writeFileSync(join(root, 'archive'), '占住了');
    const r = await ports.removeWorktree(
      { taskId: 't1', repo, path: dir, branch: BRANCH, archive: true },
      ctx,
    );
    expect(r).toMatchObject({ removed: false, gone: false, shots: { outcome: 'failed' } });
    expect(r.kept).toContain('归档没成');
    expect(existsSync(join(dir, '_tmp', 'shots', '12', 'a.png'))).toBe(true);
  });

  it('建树前删同一位置的旧树：旧树里的图先存进归档再删；存不成不删、明确报 SHOTS_KEPT', async () => {
    const { ports, trees } = setup({ fetchBranchHead: remoteShots(null) });
    const stale = await seededTree(trees);
    shotIn(stale, '12/a.png', png('a'));
    writeFileSync(join(root, 'archive'), '占住了');
    await expect(ports.createWorktree({ taskId: 't1', repo, branch: BRANCH }, ctx)).rejects.toMatchObject({
      code: 'SHOTS_KEPT',
      retryable: false,
      message: expect.stringContaining('归档没成'),
    });
    expect(existsSync(join(stale, '_tmp', 'shots', '12', 'a.png'))).toBe(true);

    rmSync(join(root, 'archive'));
    const tree = await ports.createWorktree({ taskId: 't1', repo, branch: BRANCH }, ctx);
    expect(tree.path).toBe(stale);
    expect(trees.owners.has(stale)).toBe(false);
    const archived = readdirSync(join(root, 'archive', 't1', 'shots'));
    expect(archived).toHaveLength(1);
  });

  it('没有受管图片：none，照常删树，不问远端', async () => {
    const { ports, calls, trees } = setup();
    const dir = await seededTree(trees);
    const r = await ports.removeWorktree(
      { taskId: 't1', repo, path: dir, branch: BRANCH, archive: false, shots: shots() },
      ctx,
    );
    expect(r).toMatchObject({ removed: true, shots: { outcome: 'none' } });
    expect(calls.fetchBranchHead).toBeUndefined();
  });
});

describe('推分支', () => {
  it('会话用户把新提交打成 bundle 交出来，github 包导入再推；临时文件用完删掉', async () => {
    const { ports, calls, trees } = setup();
    const dir = await seededTree(trees);
    const head = commitIn(dir, 'login.ts');
    expect(
      await ports.pushBranch({ taskId: 't1', repo, worktreePath: dir, branch: BRANCH, head }, ctx),
    ).toEqual({
      head,
      // 推上去的头相对主线的净改动：工作流开 PR 前验证判界面、给验证方的清单按它
      changedFiles: ['src/login.ts'],
      // 同口径的新增行数（#2762 流程健康记账）：commitIn 写了一行
      addedLines: 1,
    });
    expect(calls.pushBranch).toHaveLength(1);
    expect(readdirSync(join(root, 'tmp')).filter((f) => f.startsWith('push-'))).toEqual([]);
  });

  it('树的头不是要推的、有没提交的改动、没有新提交、树不在：明确报错，不推', async () => {
    // 远端分支还不在（第一次推）：树的头就是起会话前的头才是真的空交付
    const { ports, calls, trees } = setup({ fetchBranchHead: () => ({ head: null }) });
    const dir = await seededTree(trees);
    await expect(
      ports.pushBranch({ taskId: 't1', repo, worktreePath: dir, branch: BRANCH, head: 'f'.repeat(40) }, ctx),
    ).rejects.toMatchObject({ code: 'HEAD_MISMATCH' });
    await expect(
      ports.pushBranch({ taskId: 't1', repo, worktreePath: dir, branch: BRANCH, head: m.head }, ctx),
    ).rejects.toMatchObject({ code: 'EMPTY_DELIVERY' });
    const head = commitIn(dir, 'login.ts');
    writeFileSync(join(dir, 'README.md'), '# 没提交\n');
    await expect(
      ports.pushBranch({ taskId: 't1', repo, worktreePath: dir, branch: BRANCH, head }, ctx),
    ).rejects.toMatchObject({ code: 'NOT_DELIVERED' });
    await expect(
      ports.pushBranch({ taskId: 't1', repo, worktreePath: join(root, 'nope'), branch: BRANCH, head }, ctx),
    ).rejects.toMatchObject({ code: 'WORKTREE_MISSING' });
    expect(calls.pushBranch ?? []).toHaveLength(0);
  });

  it('github 包报卫生检查拦下：换成 HYGIENE_BLOCKED 交给失败分流（退回会话）', async () => {
    const { ports, trees } = setup({
      pushBranch: () => {
        throw new GitHubError('HYGIENE_BLOCKED', 'x', {
          retryable: false,
          details: { findings: [{ path: 'src/login.ts', line: 1, rule: 'token' }] },
        });
      },
    });
    const dir = await seededTree(trees);
    const head = commitIn(dir, 'login.ts');
    await expect(
      ports.pushBranch({ taskId: 't1', repo, worktreePath: dir, branch: BRANCH, head }, ctx),
    ).rejects.toMatchObject({ code: 'HYGIENE_BLOCKED', retryable: false });
  });
});

describe('推之前把最新主线并进会话的树', () => {
  /** 会话干活期间主线又进了一个提交。 */
  function advanceMain(file: string, content: string) {
    writeFileSync(join(m.dir, file), content);
    git(m.dir, 'add', '--', file);
    git(m.dir, 'commit', '-q', '-m', `main: ${file}`);
    return git(m.dir, 'rev-parse', 'HEAD');
  }
  const parentsOf = (dir: string, sha: string) =>
    git(dir, 'rev-list', '--parents', '-n', '1', sha).split(' ').slice(1);

  it('主线动过：先并进来（--no-ff，第一个父提交是会话交的头）再推并出来的头；推的包从新主线头起', async () => {
    const { ports, calls, trees } = setup();
    const dir = await seededTree(trees);
    const head = commitIn(dir, 'login.ts');
    const main = advanceMain('b.ts', 'export const b = 2;\n');
    const r = await ports.pushBranch({ taskId: 't1', repo, worktreePath: dir, branch: BRANCH, head }, ctx);
    expect(r.head).not.toBe(head);
    expect(parentsOf(dir, r.head)).toEqual([head, main]);
    expect(git(dir, 'rev-parse', 'refs/fleet/incoming')).toBe(main);
    expect(calls.pushBranch?.[0]).toMatchObject({ head: r.head });
    // 主线跟着钉到新头：返工时 pnpm test:changed 只算分支自己的改动，不把并进来的主线也算上
    expect(git(dir, 'rev-parse', 'refs/remotes/origin/main')).toBe(main);
    expect(git(dir, 'diff', '--name-only', 'origin/main...HEAD')).toBe('src/login.ts');
    // 【#293】交回的改动清单是推上去的头相对主线的净改动：并进来的主线（b.ts）不算。原来工作流按会话交的累计，
    // 并进来的主线改了页面代码就被当成这张单改了页面、按界面类派验证
    expect(git(dir, 'diff', '--name-only', head, r.head)).toBe('b.ts');
    expect(r.changedFiles).toEqual(['src/login.ts']);
  });

  it('并完、推没成、活动重试：头是上一次并出来的（第一个父提交是会话交的头）就接着推它，不判头对不上', async () => {
    let n = 0;
    const { ports, calls, trees } = setup({
      pushBranch: (input: { head: string }) => {
        n += 1;
        if (n === 1) throw new GitHubError('GIT_FAILED', '网断了', { retryable: true });
        return { head: input.head, pushed: true };
      },
    });
    const dir = await seededTree(trees);
    const head = commitIn(dir, 'login.ts');
    advanceMain('b.ts', 'export const b = 2;\n');
    const input = { taskId: 't1', repo, worktreePath: dir, branch: BRANCH, head };
    await expect(ports.pushBranch(input, ctx)).rejects.toMatchObject({ code: 'GIT_FAILED', retryable: true });
    const merged = git(dir, 'rev-parse', 'HEAD');
    expect(await ports.pushBranch(input, ctx)).toEqual({
      head: merged,
      changedFiles: ['src/login.ts'],
      addedLines: 1,
    });
    expect(calls.pushBranch?.map((c) => (c as { head: string }).head)).toEqual([merged, merged]);
  });

  it('并出冲突：留下冲突标记和 MERGE_HEAD，报 MERGE_CONFLICT 带冲突的文件，不推', async () => {
    const { ports, calls, trees } = setup();
    const dir = await seededTree(trees);
    writeFileSync(join(dir, 'a.ts'), 'export const a = 100;\n');
    git(dir, 'add', '--', 'a.ts');
    git(dir, 'commit', '-q', '-m', 'feat: a');
    const head = git(dir, 'rev-parse', 'HEAD');
    const main = advanceMain('a.ts', 'export const a = 2;\n');
    const err = await ports
      .pushBranch({ taskId: 't1', repo, worktreePath: dir, branch: BRANCH, head }, ctx)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'MERGE_CONFLICT',
      retryable: false,
      details: { mainline: main, conflictFiles: ['a.ts'], pending: true },
    });
    expect((err as Error).message).toContain('解完 `git add` 并提交');
    expect((err as Error).message).toContain('a.ts');
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
    // 冲突状态原样留给会话：撤掉的话会话看到干净的树，不知道冲突在哪
    expect(existsSync(join(dir, '.git', 'MERGE_HEAD'))).toBe(true);
    expect(git(dir, 'ls-files', '-u')).toContain('a.ts');
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toContain('<<<<<<<');
    // 新主线的提交已经在树里；origin/main 也钉到了它（test:changed 和它比）
    expect(git(dir, 'cat-file', '-t', main)).toBe('commit');
    expect(git(dir, 'rev-parse', 'refs/remotes/origin/main')).toBe(main);
    expect(calls.pushBranch ?? []).toHaveLength(0);
  });

  it('没跟踪的文件挡着并（主线加了同名文件）：撤掉、报 MERGE_CONFLICT 带挡着的文件名，树和那个文件都不动，不推', async () => {
    const { ports, calls, trees } = setup();
    const dir = await seededTree(trees);
    const head = commitIn(dir, 'login.ts');
    // 会话没提交、也没跟踪的草稿，和主线新加的文件同名
    writeFileSync(join(dir, 'b.ts'), '// 会话的草稿\n');
    const main = advanceMain('b.ts', 'export const b = 2;\n');
    const err = await ports
      .pushBranch({ taskId: 't1', repo, worktreePath: dir, branch: BRANCH, head }, ctx)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'MERGE_CONFLICT',
      retryable: false,
      details: { mainline: main, conflictFiles: ['b.ts'], pending: false },
    });
    expect((err as Error).message).toContain('b.ts');
    expect((err as Error).message).toContain(`git merge ${main}`);
    expect((err as Error).message).not.toContain('树里留着冲突标记');
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(readFileSync(join(dir, 'b.ts'), 'utf8')).toBe('// 会话的草稿\n');
    expect(existsSync(join(dir, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(calls.pushBranch ?? []).toHaveLength(0);
  });

  it('并的时候 git 自己出错（.git/index.lock 被占着）：报 GIT_FAILED（可重试，不当成冲突），以「并」开头，树里留下的照实写，不推', async () => {
    const { ports, calls, trees } = setup();
    const dir = await seededTree(trees);
    const head = commitIn(dir, 'login.ts');
    const main = advanceMain('b.ts', 'export const b = 2;\n');
    writeFileSync(join(dir, '.git', 'index.lock'), '');
    const err = await ports
      .pushBranch({ taskId: 't1', repo, worktreePath: dir, branch: BRANCH, head }, ctx)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'GIT_FAILED', retryable: true });
    // git 2.45 及以前（法国的 2.43）写不了索引时留下 MERGE_HEAD、撤销又被同一把锁挡住；2.46 起直接退出、什么都不留。
    // 原文也随版本、配置不同（锁文件在、或 autostash 写不了索引）。哪种都以「并」这一步开头，留没留下 MERGE_HEAD 和报的对得上
    const message = (err as Error).message;
    expect(message).toMatch(new RegExp(`^并 ${main.slice(0, 7)}：`));
    expect(message.includes('还留着没并完的合并')).toBe(existsSync(join(dir, '.git', 'MERGE_HEAD')));
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(existsSync(join(dir, 'b.ts'))).toBe(false);
    expect(calls.pushBranch ?? []).toHaveLength(0);
  });

  it('连着两次推没成、主线每次都动过（并了两层）：第三次认得出头是会话交的头之后只有并提交的一串，接着推', async () => {
    let n = 0;
    const { ports, calls, trees } = setup({
      pushBranch: (input: { head: string }) => {
        n += 1;
        if (n <= 2) throw new GitHubError('GIT_FAILED', '网断了', { retryable: true });
        return { head: input.head, pushed: true };
      },
    });
    const dir = await seededTree(trees);
    const head = commitIn(dir, 'login.ts');
    const input = { taskId: 't1', repo, worktreePath: dir, branch: BRANCH, head };
    advanceMain('b.ts', 'export const b = 2;\n');
    await expect(ports.pushBranch(input, ctx)).rejects.toMatchObject({ code: 'GIT_FAILED' });
    const first = git(dir, 'rev-parse', 'HEAD');
    expect(parentsOf(dir, first)[0]).toBe(head);
    const main = advanceMain('c.ts', 'export const c = 3;\n');
    await expect(ports.pushBranch(input, ctx)).rejects.toMatchObject({ code: 'GIT_FAILED' });
    const second = git(dir, 'rev-parse', 'HEAD');
    expect(parentsOf(dir, second)).toEqual([first, main]);
    expect(await ports.pushBranch(input, ctx)).toEqual({
      head: second,
      changedFiles: ['src/login.ts'],
      addedLines: 1,
    });
    expect(calls.pushBranch?.map((c) => (c as { head: string }).head)).toEqual([first, second, second]);
  });

  it('并提交的那一串里夹着一个普通提交（交活之后树里又多了东西）：不认，HEAD_MISMATCH，不推', async () => {
    let n = 0;
    const { ports, calls, trees } = setup({
      pushBranch: (input: { head: string }) => {
        n += 1;
        if (n === 1) throw new GitHubError('GIT_FAILED', '网断了', { retryable: true });
        return { head: input.head, pushed: true };
      },
    });
    const dir = await seededTree(trees);
    const head = commitIn(dir, 'login.ts');
    const input = { taskId: 't1', repo, worktreePath: dir, branch: BRANCH, head };
    advanceMain('b.ts', 'export const b = 2;\n');
    await expect(ports.pushBranch(input, ctx)).rejects.toMatchObject({ code: 'GIT_FAILED' });
    commitIn(dir, 'extra.ts');
    await expect(ports.pushBranch(input, ctx)).rejects.toMatchObject({ code: 'HEAD_MISMATCH' });
    expect(calls.pushBranch).toHaveLength(1);
  });

  it('github 包报 BEHIND_MAINLINE（并完到推之间主线又动了）：到引擎这层改成可重试，重来一遍会再并', async () => {
    const { ports, trees } = setup({
      pushBranch: () => {
        throw new GitHubError('BEHIND_MAINLINE', '不包含最新主线：先同步主线再推', { retryable: false });
      },
    });
    const dir = await seededTree(trees);
    const head = commitIn(dir, 'login.ts');
    await expect(
      ports.pushBranch({ taskId: 't1', repo, worktreePath: dir, branch: BRANCH, head }, ctx),
    ).rejects.toMatchObject({ code: 'BEHIND_MAINLINE', retryable: true });
  });
});

describe('推被拒（DIVERGED / REMOTE_AHEAD）：先认领远端新头，判断是良性前进还是真被改写（#307/#389 那次真事）', () => {
  const parentsOf = (dir: string, sha: string) =>
    git(dir, 'rev-list', '--parents', '-n', '1', sha).split(' ').slice(1);

  /** 在镜像里另开一条不碰 main 的分支，往 main 此刻的头上加一个提交（模拟帅位手推的、良性前进的远端头）；用完删分支，对象留着。 */
  function commitOffMain(file: string, content: string) {
    const branch = `scratch-${Math.random().toString(36).slice(2, 7)}`;
    git(m.dir, 'checkout', '-q', '-b', branch);
    writeFileSync(join(m.dir, file), content);
    git(m.dir, 'add', '.');
    git(m.dir, 'commit', '-q', '-m', `remote: ${file}`);
    const sha = git(m.dir, 'rev-parse', 'HEAD');
    git(m.dir, 'checkout', '-q', 'main');
    git(m.dir, 'branch', '-q', '-D', branch);
    return sha;
  }

  /** 把 headSha（只存在于会话树 dir 里）导进镜像、在它上面再加一层提交（模拟远端已经含着我们要推的这个头、还往前走了）。 */
  function extendHeadInMirror(dir: string, headSha: string, file: string, content: string) {
    const tmp = `tmp-${headSha.slice(0, 7)}`;
    git(m.dir, 'fetch', '-q', dir, `${headSha}:refs/heads/${tmp}`);
    git(m.dir, 'checkout', '-q', tmp);
    writeFileSync(join(m.dir, file), content);
    git(m.dir, 'add', '.');
    git(m.dir, 'commit', '-q', '-m', `remote extends: ${file}`);
    const sha = git(m.dir, 'rev-parse', 'HEAD');
    git(m.dir, 'checkout', '-q', 'main');
    git(m.dir, 'branch', '-q', '-D', tmp);
    return sha;
  }

  /** 从主线的根提交另开一条分支（不含 main 此刻的头）：模拟历史被改写过的远端头。 */
  function commitRewrittenHistory(file: string, content: string) {
    const root = git(m.dir, 'rev-list', '--max-parents=0', 'HEAD').trim();
    const branch = `scratch-rewrite-${Math.random().toString(36).slice(2, 7)}`;
    git(m.dir, 'checkout', '-q', '-b', branch, root);
    writeFileSync(join(m.dir, file), content);
    git(m.dir, 'add', '.');
    git(m.dir, 'commit', '-q', '-m', `rewritten: ${file}`);
    const sha = git(m.dir, 'rev-parse', 'HEAD');
    git(m.dir, 'checkout', '-q', 'main');
    git(m.dir, 'branch', '-q', '-D', branch);
    return sha;
  }

  it('DIVERGED、远端含着起会话前的头（良性前进）：认领、并一次、改用新头重推，不当成改写', async () => {
    const remoteHead = commitOffMain('manual-merge.ts', 'export const m = 1;\n');
    const pushed: string[] = [];
    const { ports, trees } = setup({
      pushBranch: (input: { head: string }) => {
        pushed.push(input.head);
        if (pushed.length === 1) {
          throw new GitHubError('DIVERGED', '分叉了', { retryable: false, details: { remoteHead } });
        }
        return { head: input.head, pushed: true };
      },
      fetchBranchHead: () => ({ head: remoteHead }),
    });
    const dir = await seededTree(trees);
    const head = commitIn(dir, 'login.ts');
    const r = await ports.pushBranch({ taskId: 't1', repo, worktreePath: dir, branch: BRANCH, head }, ctx);
    expect(pushed).toEqual([head, r.head]);
    expect(r.head).not.toBe(head);
    expect(parentsOf(dir, r.head)).toEqual([head, remoteHead]);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(r.head);
    expect([...(r.changedFiles ?? [])].sort()).toEqual(['manual-merge.ts', 'src/login.ts']);
  });

  it('REMOTE_AHEAD（远端已经含着我们要推的头、还往前走了）：认领远端的新头，不用再推一次', async () => {
    let remoteHead = '';
    const { ports, trees, calls } = setup({
      pushBranch: () => {
        throw new GitHubError('REMOTE_AHEAD', '远端已经在这个头之上被推进了', {
          retryable: false,
          details: { remoteHead },
        });
      },
      fetchBranchHead: () => ({ head: remoteHead }),
    });
    const dir = await seededTree(trees);
    const head = commitIn(dir, 'login.ts');
    remoteHead = extendHeadInMirror(dir, head, 'someone-else.ts', 'export const s = 1;\n');
    const r = await ports.pushBranch({ taskId: 't1', repo, worktreePath: dir, branch: BRANCH, head }, ctx);
    expect(r.head).toBe(remoteHead);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(remoteHead);
    // 认领不用重推：pushBranch（低层的推）总共只被真调用了一次（那一次就是报 REMOTE_AHEAD 的那次）
    expect(calls.pushBranch).toHaveLength(1);
  });

  it('推之前远端分支就在起会话前的头上、树里没有新提交（#1554）：不推、不抛，回远端头', async () => {
    const { ports, calls, trees } = setup({ fetchBranchHead: () => ({ head: m.head }) });
    const dir = await seededTree(trees);
    const r = await ports.pushBranch(
      { taskId: 't1', repo, worktreePath: dir, branch: BRANCH, head: m.head },
      ctx,
    );
    expect(r.head).toBe(m.head);
    expect(r.changedFiles).toEqual([]);
    expect(calls.pushBranch ?? []).toHaveLength(0);
  });

  it('【故意造出的失败】推被拒、再看远端头就是起会话前的头（#1454）：不向镜像要空包，不报 GIT_FAILED；本地有新提交就带 needsPush 重推本地头', async () => {
    let first = true;
    const { ports, calls, trees } = setup({
      pushBranch: (input: { head: string }) => {
        if (first) {
          first = false;
          throw new GitHubError('REMOTE_AHEAD', '远端已经在这个头之上被推进了', {
            retryable: false,
            details: { remoteHead: m.head },
          });
        }
        return { head: input.head, pushed: true };
      },
      fetchBranchHead: () => ({ head: m.head }),
    });
    const dir = await seededTree(trees);
    const head = commitIn(dir, 'login.ts');
    const err = await ports
      .pushBranch({ taskId: 't1', repo, worktreePath: dir, branch: BRANCH, head }, ctx)
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(Error);
    expect(JSON.stringify(err)).not.toContain('Refusing to create empty bundle');
    expect(err).toMatchObject({ head });
    // 没有向镜像要「远端头减起会话前的头」的空包：只有推前并主线那一次不会要（主线已在树里）
    expect(
      (calls.bundleCommits ?? []).filter((c) => (c as { tips: string[] }).tips.includes(m.head)),
    ).toHaveLength(0);
    expect(calls.pushBranch).toHaveLength(2);
  });

  it('推被拒、远端头已经在树里且就是要推的头：不再取包、不再推，回这个头', async () => {
    let remoteHead = '';
    const { ports, calls, trees } = setup({
      pushBranch: () => {
        throw new GitHubError('REMOTE_AHEAD', '远端已经在这个头之上被推进了', {
          retryable: false,
          details: { remoteHead },
        });
      },
      fetchBranchHead: () => ({ head: remoteHead }),
    });
    const dir = await seededTree(trees);
    const head = commitIn(dir, 'login.ts');
    remoteHead = head;
    const r = await ports.pushBranch({ taskId: 't1', repo, worktreePath: dir, branch: BRANCH, head }, ctx);
    expect(r.head).toBe(head);
    expect(calls.pushBranch).toHaveLength(1);
  });

  it('推被拒、远端头已经在树里（树的头在它之前）：不取包，merge --ff-only 快进过去，不再推', async () => {
    let remoteHead = '';
    const { ports, calls, trees } = setup({
      pushBranch: () => {
        throw new GitHubError('REMOTE_AHEAD', '远端已经在这个头之上被推进了', {
          retryable: false,
          details: { remoteHead },
        });
      },
      fetchBranchHead: () => ({ head: remoteHead }),
    });
    const dir = await seededTree(trees);
    const head = commitIn(dir, 'login.ts');
    remoteHead = commitIn(dir, 'extra.ts');
    git(dir, 'reset', '-q', '--hard', head);
    const r = await ports.pushBranch({ taskId: 't1', repo, worktreePath: dir, branch: BRANCH, head }, ctx);
    expect(r.head).toBe(remoteHead);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(remoteHead);
    expect(calls.pushBranch).toHaveLength(1);
  });

  it('【故意造出的失败】DIVERGED、远端不含起会话前的头（历史被改写过）：不试着并，原样报出去，明确写「不含」', async () => {
    const remoteHead = commitRewrittenHistory('force-pushed.ts', 'export const f = 1;\n');
    const { ports, trees } = setup({
      pushBranch: () => {
        throw new GitHubError('DIVERGED', '分叉了', { retryable: false, details: { remoteHead } });
      },
      fetchBranchHead: () => ({ head: remoteHead }),
    });
    const dir = await seededTree(trees);
    const head = commitIn(dir, 'login.ts');
    const err = await ports
      .pushBranch({ taskId: 't1', repo, worktreePath: dir, branch: BRANCH, head }, ctx)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'DIVERGED', retryable: false });
    expect((err as Error).message).toContain('不含起会话前的头');
    // 没有乱动工作树：还在会话交的那个头上，没有半途而废的并
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('【故意造出的失败】远端分支已经不在了（被人删了）：不当成改写，写清「不见了」', async () => {
    const { ports, trees } = setup({
      pushBranch: () => {
        throw new GitHubError('DIVERGED', '分叉了', {
          retryable: false,
          details: { remoteHead: 'f'.repeat(40) },
        });
      },
      fetchBranchHead: () => ({ head: null }),
    });
    const dir = await seededTree(trees);
    const head = commitIn(dir, 'login.ts');
    const err = await ports
      .pushBranch({ taskId: 't1', repo, worktreePath: dir, branch: BRANCH, head }, ctx)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'DIVERGED', retryable: false });
    expect((err as Error).message).toContain('不在了');
  });
});

describe('开 PR、CI、合并', () => {
  const body = {
    requirement: 12,
    subtask: 'login 登录',
    did: ['加了验证码'],
    verified: ['pnpm check'],
  };

  it('正文给结构（github 包按模板渲染）；不抄需求 issue 的类别标签和里程碑、不读需求文档、不读单子挂的版本（#654）', async () => {
    const { ports, calls } = setup();
    expect(
      await ports.openPr({ taskId: 't1', repo, branch: BRANCH, head: m.head, title: '登录', body }, ctx),
    ).toEqual({
      prNumber: 101,
      url: 'https://github.com/acme/widgets/pull/101',
    });
    expect(calls.openPr?.[0]).toMatchObject({ body: { requirement: 12, did: ['加了验证码'] } });
    expect(calls.openPr?.[0]).toMatchObject({ labels: ['域:engine', '性质:bug'] });
    expect(calls.openPr?.[0]).not.toHaveProperty('inheritFrom');
    expect(calls.readSpecDoc).toBeUndefined();
    expect(calls.readIssuePlan).toBeUndefined();
  });

  it('【故意造出的失败】同一张单已有别的开着的 PR（本机 local/12-…，或需求栏 Closes #12）：不开第二个，ISSUE_CLAIMED 不重试', async () => {
    for (const other of [
      { number: 88, body: '', headRef: 'local/12-login' },
      { number: 89, body: '**需求**：\nCloses #12\n', headRef: 'feat/x' },
    ]) {
      const { ports, calls } = setup({ claims: () => [other] });
      const err = await ports
        .openPr({ taskId: 't1', repo, branch: BRANCH, head: m.head, title: '登录', body }, ctx)
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'ISSUE_CLAIMED', retryable: false });
      expect(String((err as Error).message)).toContain(`#${other.number}`);
      expect(calls.openPr).toBeUndefined();
    }
  });

  it('重做的新一代：上一代任务分支上开着的 PR 关掉并留言，再开新的', async () => {
    const previous = 'fleet/12-t01234567';
    const current = 'fleet/12-taabbccdd';
    const { ports, calls } = setup({
      claims: () => [{ number: 77, body: '**需求**：\nCloses #12\n', headRef: previous }],
    });
    await ports.openPr(
      {
        taskId: 't1',
        repo,
        branch: current,
        head: m.head,
        title: '登录',
        body,
        generation: 2,
      },
      ctx,
    );
    expect(calls.commentPull).toEqual([
      expect.objectContaining({
        prNumber: 77,
        key: 'redo-supersede:2',
        body: '被第 2 代重做取代',
      }),
    ]);
    expect(calls.closePull).toEqual([77]);
    expect(calls.openPr).toHaveLength(1);
  });

  it('别人开着的 PR 不关，仍是 ISSUE_CLAIMED；和上一代的 PR 混在一起时上一代的也不关', async () => {
    const previous = 'fleet/12-t01234567';
    const current = 'fleet/12-taabbccdd';
    for (const others of [
      [{ number: 88, body: '', headRef: 'local/12-login' }],
      [
        { number: 77, body: '', headRef: previous },
        { number: 89, body: '**需求**：\nCloses #12\n', headRef: 'feat/x' },
      ],
    ]) {
      const { ports, calls } = setup({ claims: () => others });
      const err = await ports
        .openPr(
          {
            taskId: 't1',
            repo,
            branch: current,
            head: m.head,
            title: '登录',
            body,
            generation: 2,
          },
          ctx,
        )
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'ISSUE_CLAIMED', retryable: false });
      expect(calls.closePull ?? []).toEqual([]);
      expect(calls.commentPull ?? []).toEqual([]);
      expect(calls.openPr).toBeUndefined();
    }
  });

  it('改 PR 正文（#2723）：同一份结构交给 github 包，按 PR 号改', async () => {
    const { ports, calls } = setup();
    await ports.updatePrBody({ taskId: 't1', repo, prNumber: 101, body }, ctx);
    expect(calls.updatePullBody).toEqual([
      { number: 101, body: expect.objectContaining({ requirement: 12, did: ['加了验证码'] }) },
    ]);
  });

  it('待验分片写后现读正文；旧正文或读失败明确拒绝，不能当已改', async () => {
    const { ports, gh } = setup();
    const kept = { ...body, requirementRefs: true };
    const actual = {
      number: 101,
      nodeId: 'p',
      state: 'open' as const,
      merged: false,
      draft: false,
      title: 't',
      body: '',
      headSha: m.head,
      headRef: BRANCH,
      fromFork: false,
      author: null,
      autoMerge: false,
    };
    gh.claims.readPull = async () => actual;
    await expect(ports.updatePrBody({ taskId: 't1', repo, prNumber: 101, body: kept }, ctx)).rejects.toThrow(
      /Refs/,
    );
    gh.claims.readPull = async () => {
      throw new Error('read failed');
    };
    await expect(ports.updatePrBody({ taskId: 't1', repo, prNumber: 101, body: kept }, ctx)).rejects.toThrow(
      /read failed/,
    );
    gh.claims.readPull = async () => ({ ...actual, body: renderPrBody(kept) });
    await expect(
      ports.updatePrBody({ taskId: 't1', repo, prNumber: 101, body: kept }, ctx),
    ).resolves.toBeUndefined();
  });

  it('自己这条分支上已经开着的 PR 不算（重放幂等）', async () => {
    const { ports, calls } = setup({ claims: () => [{ number: 101, body: '', headRef: BRANCH }] });
    await ports.openPr({ taskId: 't1', repo, branch: BRANCH, head: m.head, title: '登录', body }, ctx);
    expect(calls.openPr).toHaveLength(1);
  });

  it('单上的查询轴照抄到 PR：恰好一个域、一个性质；类别不抄。两个域就这一轴不抄', async () => {
    const read = (labels: string[]) => () => ({
      number: 12,
      title: '登录',
      body: '',
      state: 'open' as const,
      labels,
    });
    const one = setup({ readIssue: read(['缺陷', '性质:bug', '域:mirasim', '母单']) });
    await one.ports.openPr({ taskId: 't1', repo, branch: BRANCH, head: m.head, title: '登录', body }, ctx);
    expect(one.calls.openPr?.[0]).toMatchObject({ labels: ['域:mirasim', '性质:bug'] });

    const both = setup({ readIssue: read(['域:engine', '域:api', '性质:perf']) });
    await expect(
      both.ports.openPr({ taskId: 't1', repo, branch: BRANCH, head: m.head, title: '登录', body }, ctx),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', retryable: false });
    expect(both.calls.openPr).toBeUndefined();
  });

  it('正文无需求号时从任务分支现读来源；无来源的杂活拒开漏轴 PR', async () => {
    const { ports, calls } = setup();
    const { requirement: _dropped, ...noIssue } = body;
    await ports.openPr(
      { taskId: 't1', repo, branch: BRANCH, head: m.head, title: '杂活', body: noIssue },
      ctx,
    );
    expect(calls.openPr?.[0]).toMatchObject({ body: { did: ['加了验证码'] } });
    expect(calls.readIssue).toBeDefined();
    await expect(
      ports.openPr(
        { taskId: 't1', repo, branch: 'chore/unknown', head: m.head, title: '杂活', body: noIssue },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(calls.openPr).toHaveLength(1);
  });

  it('「按推荐先做了」（#259）照传给正文生成：漏传了 PR 正文里就没有那一栏', async () => {
    const { ports, calls } = setup();
    const assumed = ['验证码几位？ → 先按推荐做了「6 位」，创始人还没回'];
    await ports.openPr(
      { taskId: 't1', repo, branch: BRANCH, head: m.head, title: '登录', body: { ...body, assumed } },
      ctx,
    );
    expect(calls.openPr?.[0]).toMatchObject({ body: { assumed } });
  });
});

describe('CI 认了新头：工作树跟着并（#307/#389 那次真事补上的）', () => {
  it('新头含着老头（帅位手推、或引擎自己另一轮先推成了）：工作树快进过去，不止是查 CI 的结论', async () => {
    const newHead = commitInMirror('adopted.ts', 'export const x = 1;\n');
    const { ports, trees, calls } = setup({
      waitCi: (_input: { head: string }) => ({ state: 'green', head: newHead, checks: [] }),
    });
    const dir = await seededTree(trees);
    const result = await ports.waitCi(
      { taskId: 't1', repo, prNumber: 101, branch: BRANCH, head: m.head, worktreePath: dir },
      ctx,
    );
    expect(result).toEqual({ state: 'green', head: newHead, failedChecks: [] });
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(newHead);
    expect(calls.fetchBranchHead?.[0]).toMatchObject({ branch: BRANCH });
  });

  it('等 CI 不把合并闸算进必过检查：验收（cold-verify）在等 CI 之后，合并闸这时必红', async () => {
    const { ports, calls } = setup();
    await ports.waitCi({ taskId: 't1', repo, prNumber: 101, branch: BRANCH, head: m.head }, ctx);
    expect(calls.waitCi?.[0]).toMatchObject({ prNumber: 101, excludeChecks: ['merge-gate'] });
  });

  it('CI 红了：github 包给的红 job 名（failedChecks）、摘要、日志尾巴原样交回，会话的返工意见靠它们（#2795）', async () => {
    const { ports } = setup({
      waitCi: (input: { head: string }) => ({
        state: 'red',
        head: input.head,
        checks: [],
        failedChecks: ['check', 'lint'],
        digest: 'check：failure：红的 job：lint',
        detail: '红的 job：lint、check\n\n【lint】failure\n日志尾巴：\nFound 6 errors.',
      }),
    });
    const result = await ports.waitCi(
      { taskId: 't1', repo, prNumber: 101, branch: BRANCH, head: m.head },
      ctx,
    );
    expect(result).toEqual({
      state: 'red',
      head: m.head,
      failedChecks: ['check', 'lint'],
      digest: 'check：failure：红的 job：lint',
      detail: '红的 job：lint、check\n\n【lint】failure\n日志尾巴：\nFound 6 errors.',
    });
  });

  it('没给工作树（合并队列没有工作树）：只回查 CI 的结论，不碰工作树、不抓分支', async () => {
    const newHead = commitInMirror('adopted2.ts', 'export const x = 2;\n');
    const { ports, calls } = setup({
      waitCi: (_input: { head: string }) => ({ state: 'green', head: newHead, checks: [] }),
    });
    const result = await ports.waitCi(
      { taskId: 't1', repo, prNumber: 101, branch: BRANCH, head: m.head },
      ctx,
    );
    expect(result).toEqual({ state: 'green', head: newHead, failedChecks: [] });
    expect(calls.fetchBranchHead ?? []).toHaveLength(0);
  });

  it('【故意造出的失败】会话在跑（工作树有没提交的改动）：不并，跳过、不抛，等下一轮再试', async () => {
    const newHead = commitInMirror('adopted3.ts', 'export const x = 3;\n');
    const { ports, trees, calls } = setup({
      waitCi: (_input: { head: string }) => ({ state: 'green', head: newHead, checks: [] }),
    });
    const dir = await seededTree(trees);
    // 改一个已跟踪的文件、不提交（未跟踪的新文件 uncommittedTracked 不算数，见 user-git.ts）：模拟会话正编辑到一半。
    writeFileSync(join(dir, 'README.md'), '会话还没提交这一份\n');
    const result = await ports.waitCi(
      { taskId: 't1', repo, prNumber: 101, branch: BRANCH, head: m.head, worktreePath: dir },
      ctx,
    );
    // 查 CI 的结论照样查得成、照样回给调用方：工作树跟不跟得上不耽误这一步的判断。
    expect(result).toEqual({ state: 'green', head: newHead, failedChecks: [] });
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(m.head);
    expect(calls.fetchBranchHead ?? []).toHaveLength(0);
  });

  it('【故意造出的失败】diverged（新头不含老头）：不试着并工作树，交回去要人看，不碰工作树', async () => {
    const { ports, trees, calls } = setup({
      waitCi: (input: { head: string }) => ({
        state: 'head_moved',
        head: input.head,
        actualHead: 'f'.repeat(40),
        detail: '被强推改写了',
      }),
    });
    const dir = await seededTree(trees);
    const result = await ports.waitCi(
      { taskId: 't1', repo, prNumber: 101, branch: BRANCH, head: m.head, worktreePath: dir },
      ctx,
    );
    expect(result.state).toBe('diverged');
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(m.head);
    expect(calls.fetchBranchHead ?? []).toHaveLength(0);
  });
});

describe('并主线', () => {
  it('并好了：会话的树快进到并出来的新头；冲突原样交回；分支头被别人动过明确报错', async () => {
    const setupTree = async (over: Parameters<typeof fakeGh>[0]) => {
      const s = setup(over);
      const dir = await seededTree(s.trees);
      return { ...s, dir };
    };
    // 镜像里在旧头上多了一个提交（顶替并主线推上去的合并提交）。
    writeFileSync(join(m.dir, 'b.ts'), 'export const b = 2;\n');
    git(m.dir, 'add', '.');
    git(m.dir, 'commit', '-q', '-m', 'merge main');
    const merged = git(m.dir, 'rev-parse', 'HEAD');
    const clean = await setupTree({
      syncMainline: () => ({
        state: 'clean',
        head: merged,
        merged: true,
        previousHead: m.head,
        mainline: merged,
      }),
    });
    expect(
      await clean.ports.syncMainline(
        { taskId: 't1', repo, prNumber: 101, branch: BRANCH, head: m.head, worktreePath: clean.dir },
        ctx,
      ),
    ).toEqual({ state: 'clean', head: merged, conflictFiles: [] });
    expect(git(clean.dir, 'rev-parse', 'HEAD')).toBe(merged);
    // 并进来的主线钉成 origin/main
    expect(git(clean.dir, 'rev-parse', 'refs/remotes/origin/main')).toBe(merged);

    const conflict = await setupTree({
      syncMainline: () => ({ state: 'conflict', head: m.head, conflictFiles: ['a.ts'], mainline: merged }),
    });
    expect(
      await conflict.ports.syncMainline(
        { taskId: 't1', repo, prNumber: 101, branch: BRANCH, head: m.head },
        ctx,
      ),
    ).toEqual({ state: 'conflict', head: m.head, conflictFiles: ['a.ts'] });

    const moved = await setupTree({
      syncMainline: () => ({ state: 'head_moved', head: merged, expectedHead: m.head }),
    });
    await expect(
      moved.ports.syncMainline({ taskId: 't1', repo, prNumber: 101, branch: BRANCH, head: m.head }, ctx),
    ).rejects.toMatchObject({ code: 'HEAD_MOVED', retryable: false });
  });

  it('并出冲突、给了会话的树（#1249）：新主线的提交取进树里、origin/main 钉到新头，会话里 git merge 直接可用；树的头不动', async () => {
    writeFileSync(join(m.dir, 'b.ts'), 'export const b = 2;\n');
    git(m.dir, 'add', '.');
    git(m.dir, 'commit', '-q', '-m', 'main moved');
    const newMain = git(m.dir, 'rev-parse', 'HEAD');
    const s = setup({
      syncMainline: () => ({ state: 'conflict', head: m.head, conflictFiles: ['a.ts'], mainline: newMain }),
    });
    const dir = await seededTree(s.trees);
    // 建树时钉的是旧主线（这个夹具没钉：什么都没有也是「树里没有新主线」）
    expect(git(dir, 'for-each-ref', 'refs/remotes/origin/main')).not.toContain(newMain);
    expect(git(dir, 'rev-list', '--all')).not.toContain(newMain);
    const got = await s.ports.syncMainline(
      { taskId: 't1', repo, prNumber: 101, branch: BRANCH, head: m.head, worktreePath: dir },
      ctx,
    );
    expect(got).toEqual({ state: 'conflict', head: m.head, conflictFiles: ['a.ts'] });
    expect(git(dir, 'rev-parse', 'refs/remotes/origin/main')).toBe(newMain);
    expect(git(dir, 'cat-file', '-t', newMain)).toBe('commit');
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(m.head);
  });

  it('【故意造出的失败】并出冲突但新主线取不进树（镜像打包失败）：不抛、不装成已是最新，回 mainlineStale 写明原因，origin/main 仍是旧的', async () => {
    const s = setup({
      syncMainline: () => ({
        state: 'conflict',
        head: m.head,
        conflictFiles: ['a.ts'],
        mainline: 'e'.repeat(40),
      }),
      bundleCommits: () => {
        throw new GitHubError('MIRROR_FAILED', '镜像打包失败了', { retryable: true });
      },
    });
    const dir = await seededTree(s.trees);
    const before = git(dir, 'for-each-ref', 'refs/remotes/origin/main');
    const got = await s.ports.syncMainline(
      { taskId: 't1', repo, prNumber: 101, branch: BRANCH, head: m.head, worktreePath: dir },
      ctx,
    );
    expect(got).toMatchObject({ state: 'conflict', conflictFiles: ['a.ts'] });
    expect(got.mainlineStale).toContain('镜像打包失败了');
    expect(git(dir, 'for-each-ref', 'refs/remotes/origin/main')).toBe(before);
  });

  it('工作树比远端多一个提交、远端同时多一个并主线提交：本地并上再推，本地那个提交还在', async () => {
    writeFileSync(join(m.dir, 'b.ts'), 'export const b = 2;\n');
    git(m.dir, 'add', '.');
    git(m.dir, 'commit', '-q', '-m', 'merge main');
    const merged = git(m.dir, 'rev-parse', 'HEAD');
    const s = setup({
      syncMainline: () => ({
        state: 'clean',
        head: merged,
        merged: true,
        previousHead: m.head,
        mainline: merged,
      }),
      pushBranch: (input: { bundlePath: string; head: string }) => {
        git(m.dir, 'fetch', '--no-tags', input.bundlePath, 'refs/fleet/outgoing:refs/fleet/reconciled');
        return { head: input.head, pushed: true };
      },
    });
    const dir = await seededTree(s.trees);
    const local = commitIn(dir, 'local.ts');
    const got = await s.ports.syncMainline(
      { taskId: 't1', repo, prNumber: 101, branch: BRANCH, head: m.head, worktreePath: dir },
      ctx,
    );
    const head = git(dir, 'rev-parse', 'HEAD');
    expect(got).toEqual({ state: 'clean', head, conflictFiles: [] });
    expect(head).toBe(git(m.dir, 'rev-parse', 'refs/fleet/reconciled'));
    expect(git(dir, 'rev-parse', 'HEAD^1')).toBe(local);
    expect(git(dir, 'rev-parse', 'HEAD^2')).toBe(merged);
    git(dir, 'merge-base', '--is-ancestor', local, 'HEAD');
    expect(s.calls.commentPull).toBeUndefined();
    expect(git(dir, 'rev-parse', 'refs/remotes/origin/main')).toBe(merged);
    expect(git(dir, 'rev-parse', 'refs/fleet/incoming')).toBe(head);
  });

  it('两边改了同一处：交回冲突，不推、不留言，本地那个提交还是头', async () => {
    writeFileSync(join(m.dir, 'README.md'), '# demo\nremote\n');
    git(m.dir, 'add', '.');
    git(m.dir, 'commit', '-q', '-m', 'merge main');
    const merged = git(m.dir, 'rev-parse', 'HEAD');
    const s = setup({
      syncMainline: () => ({
        state: 'clean',
        head: merged,
        merged: true,
        previousHead: m.head,
        mainline: merged,
      }),
    });
    const dir = await seededTree(s.trees);
    writeFileSync(join(dir, 'README.md'), '# demo\nlocal\n');
    git(dir, 'add', 'README.md');
    git(dir, 'commit', '-q', '-m', 'local readme');
    const local = git(dir, 'rev-parse', 'HEAD');
    const got = await s.ports.syncMainline(
      { taskId: 't1', repo, prNumber: 101, branch: BRANCH, head: m.head, worktreePath: dir },
      ctx,
    );
    expect(got.state).toBe('conflict');
    expect(got.conflictFiles).toContain('README.md');
    expect(got.head).toBe(merged);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(local);
    expect(git(dir, 'rev-parse', 'MERGE_HEAD')).toBe(merged);
    expect(s.calls.pushBranch).toBeUndefined();
    expect(s.calls.commentPull).toBeUndefined();
  });

  it('本地历史和旧头接不上：并不上，报 WORKTREE_DIVERGED，PR 上写明工作树和没推的提交', async () => {
    writeFileSync(join(m.dir, 'b.ts'), 'export const b = 2;\n');
    git(m.dir, 'add', '.');
    git(m.dir, 'commit', '-q', '-m', 'merge main');
    const merged = git(m.dir, 'rev-parse', 'HEAD');
    const s = setup({
      syncMainline: () => ({
        state: 'clean',
        head: merged,
        merged: true,
        previousHead: m.head,
        mainline: merged,
      }),
    });
    const dir = await seededTree(s.trees);
    const tree = git(dir, 'write-tree');
    const alien = git(dir, 'commit-tree', tree, '-m', 'rewritten');
    git(dir, 'reset', '--hard', alien);
    const err = await s.ports
      .syncMainline(
        { taskId: 't1', repo, prNumber: 101, branch: BRANCH, head: m.head, worktreePath: dir },
        ctx,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortError);
    expect(err).toMatchObject({ code: 'WORKTREE_DIVERGED', retryable: false });
    expect((err as PortError).message).toContain(dir);
    expect((err as PortError).message).toContain(alien.slice(0, 7));
    const comment = s.calls.commentPull?.[0] as { prNumber: number; body: string };
    expect(comment.prNumber).toBe(101);
    expect(comment.body).toContain(dir);
    expect(comment.body).toContain(alien);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(alien);
    expect(s.calls.pushBranch).toBeUndefined();
  });

  it('回执丢了再进来、远端头已经是工作树的头：当这次并成了，不再报头被别人推过', async () => {
    const s = setup({
      syncMainline: () => ({ state: 'head_moved', head: m.head, expectedHead: 'a'.repeat(40) }),
    });
    const dir = await seededTree(s.trees);
    const got = await s.ports.syncMainline(
      { taskId: 't1', repo, prNumber: 101, branch: BRANCH, head: 'a'.repeat(40), worktreePath: dir },
      ctx,
    );
    expect(got).toEqual({ state: 'clean', head: m.head, conflictFiles: [] });
  });
});

describe('等 CI 时 PR 已经合了：先核实、记合并回执再回 merged（#3018，#2751 只剩 backfill 那次）', () => {
  const MERGE = '8'.repeat(40);
  const pullOf = (o: { merged?: boolean; state?: 'open' | 'closed'; headSha?: string } = {}) => ({
    number: 101,
    nodeId: 'PR_101',
    state: o.state ?? 'closed',
    merged: o.merged ?? true,
    draft: false,
    title: '登录',
    body: '',
    headSha: o.headSha ?? m.head,
    headRef: BRANCH,
    fromFork: false,
    author: null,
    autoMerge: false,
  });
  const engineMerged = {
    merged: true,
    mergeCommit: MERGE,
    alreadyMerged: true,
    branchDeleted: true,
    mergedBy: 'fleet-dao-engine[bot]',
    mergedByEngine: true,
  };

  function mergedSetup(o: { readPull?: () => unknown; mergePr?: () => unknown }) {
    const { gh, calls } = fakeGh({
      waitCi: (input: { head: string }) => ({
        state: 'closed',
        head: input.head,
        merged: true,
        mergeCommit: MERGE,
        detail: 'PR #101 已经合并了',
      }),
      mergePr: o.mergePr ?? (() => engineMerged),
    });
    const reads: number[] = [];
    const claims = {
      ...gh.claims,
      readPull: async (_repo: unknown, number: number) => {
        reads.push(number);
        return (o.readPull ?? (() => pullOf()))();
      },
    };
    const logs: { message: string; fields?: Record<string, unknown> }[] = [];
    const ports = createGitHubPorts({
      gh: { ...gh, claims } as unknown as EngineGitHub,
      trees: fakeTrees(join(root, 'work')).trees,
      exec: localExec(),
      tmpDir: join(root, 'tmp'),
      archiveDir: join(root, 'archive'),
      log: (message, fields) => logs.push({ message, ...(fields ? { fields } : {}) }),
    });
    const run = () => ports.waitCi({ taskId: 't1', repo, prNumber: 101, branch: BRANCH, head: m.head }, ctx);
    return { run, calls, reads, logs };
  }

  it('同一 PR、CI 查过的头就是合的头：现读核实，走 mergePr 记回执（不再合），回实际的头和合并提交', async () => {
    const s = mergedSetup({});
    expect(await s.run()).toEqual({ state: 'merged', head: m.head, failedChecks: [], mergeCommit: MERGE });
    expect(s.reads).toEqual([101]);
    expect(s.calls.mergePr).toEqual([
      { repo: { owner: 'acme', name: 'widgets' }, prNumber: 101, expectedHead: m.head, onlyBook: true },
    ]);
    expect(s.logs).toEqual([]);
  });

  it('【故意造出的失败】合的不是 CI 查过的头：不记账、不回 merged，头仍是查过的那个（不拿实际头顶），写明要人看', async () => {
    const other = 'e'.repeat(40);
    const s = mergedSetup({ readPull: () => pullOf({ headSha: other }) });
    const got = await s.run();
    expect(got).toMatchObject({ state: 'unknown', head: m.head });
    expect(got.detail).toMatch(/^PR 被关了：/);
    expect(got.detail).toContain('eeeeeee');
    expect(s.calls.mergePr).toBeUndefined();
    expect(s.logs[0]?.fields).toMatchObject({ prNumber: 101, actualHead: other });
  });

  it('【故意造出的失败】现读是关了没合 / 还开着没合：不记账；关了的停下等人，开着的让工作流重查', async () => {
    const closed = mergedSetup({ readPull: () => pullOf({ merged: false }) });
    const c = await closed.run();
    expect(c).toMatchObject({ state: 'unknown', head: m.head });
    expect(c.detail).toMatch(/^PR 被关了：.*关了没合/);
    expect(closed.calls.mergePr).toBeUndefined();

    const open = mergedSetup({ readPull: () => pullOf({ merged: false, state: 'open' }) });
    const o = await open.run();
    expect(o).toMatchObject({ state: 'unknown', head: m.head });
    expect(o.detail).toContain('还开着');
    expect(o.detail).not.toContain('PR 被关了');
    expect(open.calls.mergePr).toBeUndefined();
    expect(open.logs).toHaveLength(1);
  });

  it('【故意造出的失败】mergePr 说合的是别的头（merged_other_head）：不当成合上了', async () => {
    const s = mergedSetup({
      mergePr: () => ({ merged: false, reason: 'merged_other_head', detail: '合的头是 fffffff' }),
    });
    const got = await s.run();
    expect(got).toMatchObject({ state: 'unknown', head: m.head });
    expect(got.detail).toMatch(/^PR 被关了：.*fffffff/);
  });

  it('【故意造出的失败】现读读不到：照抛（可重试），不记账、不当成合上了，日志写明', async () => {
    const s = mergedSetup({
      readPull: () => {
        throw new GitHubError('UPSTREAM_ERROR', '读 PR 502', { retryable: true });
      },
    });
    await expect(s.run()).rejects.toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true });
    expect(s.calls.mergePr).toBeUndefined();
    expect(s.logs[0]?.message).toContain('没读成');
    expect(s.logs[0]?.fields).toMatchObject({ prNumber: 101, error: '读 PR 502' });
  });

  it('【故意造出的失败】记回执没成：抛 MERGE_RECEIPT_FAILED（带 PR、头、合并提交，按原错能不能重试），不回 merged、不留给对账补', async () => {
    const s = mergedSetup({
      mergePr: () => {
        throw new GitHubError('IN_FLIGHT', '同一个写操作别处正在做', { retryable: true });
      },
    });
    const err = await s.run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortError);
    expect(err).toMatchObject({
      code: 'MERGE_RECEIPT_FAILED',
      retryable: true,
      details: { prNumber: 101, head: m.head, cause: 'IN_FLIGHT' },
    });
    expect((err as PortError).message).toContain(MERGE.slice(0, 7));
    expect(s.logs[0]?.message).toContain('记合并回执没成');

    const fatal = mergedSetup({
      mergePr: () => {
        throw new GitHubError('UNEXPECTED_RESPONSE', '读 PR #101 的合并提交', { retryable: false });
      },
    });
    await expect(fatal.run()).rejects.toMatchObject({ code: 'MERGE_RECEIPT_FAILED', retryable: false });
  });

  it('回执是已知的非引擎合并人：保留实际 merged 事实，日志写明合并人', async () => {
    const human = mergedSetup({
      mergePr: () => ({ ...engineMerged, mergedBy: 'someone', mergedByEngine: false }),
    });
    expect(await human.run()).toMatchObject({ state: 'merged', mergeCommit: MERGE });
    expect(human.logs[0]?.fields).toMatchObject({ mergedBy: 'someone' });
  });
});
