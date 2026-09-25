// 引擎端口 → github 包：推分支（会话用户打 bundle）、开 PR（照抄需求 issue 的标签和里程碑）、并主线后快进会话的树、
// 在新头上跑测试（= 等 CI）、收树先存档；GitHubError 换成 PortError。github 包本身换成假的（记下每次调用），
// 会话用户的 git 用本地 git。
import { execFileSync } from 'node:child_process';
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
import { GitHubError } from '@fleet-dao/github';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type PortContext, PortError } from '../../src/ports.ts';
import { localExec } from '../../src/real/exec.ts';
import { createGitHubPorts, type EngineGitHub, toPortError } from '../../src/real/github-ports.ts';
import { checkoutBranch, fetchBundle } from '../../src/real/user-git.ts';
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
      execFileSync('git', ['bundle', 'verify', input.bundlePath], { cwd: m.dir, stdio: 'pipe' });
      return { head: input.head, pushed: true };
    }),
    openPr: record('openPr', () => ({ number: 101, url: 'https://github.com/acme/widgets/pull/101' })),
    waitCi: record('waitCi', (input: { head: string }) => ({ state: 'green', head: input.head })),
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
  return { ports, calls, trees };
}

/** 会话用户那边的树：从镜像取主线头、检出分支（和 sessions.ts 建树一样）。 */
async function seededTree(trees: ReturnType<typeof setup>['trees']) {
  const dir = trees.trees.treeFor(repo, BRANCH);
  await trees.trees.adopt(dir, 'fleet-agent-dedicated');
  const t = {
    exec: localExec(),
    user: 'fleet-agent-dedicated' as const,
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

describe('GitHubError → PortError', () => {
  it('卫生检查拦下：命中处排好序拼成稳定的一句（不带值），不可重试', () => {
    const e = toPortError(
      new GitHubError('HYGIENE_BLOCKED', '拦下了', {
        retryable: false,
        details: {
          findings: [
            { path: 'src/b.ts', line: 3, rule: 'email' },
            { path: 'src/a.ts', line: 9, rule: 'ip' },
          ],
        },
      }),
    ) as PortError;
    expect(e).toBeInstanceOf(PortError);
    expect(e.code).toBe('HYGIENE_BLOCKED');
    expect(e.retryable).toBe(false);
    expect(e.message).toBe('卫生检查拦下了要公开的内容：src/a.ts:9 ip；src/b.ts:3 email');
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

describe('推分支', () => {
  it('会话用户把新提交打成 bundle 交出来，github 包导入再推；临时文件用完删掉', async () => {
    const { ports, calls, trees } = setup();
    const dir = await seededTree(trees);
    const head = commitIn(dir, 'login.ts');
    expect(
      await ports.pushBranch({ taskId: 't1', repo, worktreePath: dir, branch: BRANCH, head }, ctx),
    ).toEqual({
      head,
    });
    expect(calls.pushBranch).toHaveLength(1);
    expect(readdirSync(join(root, 'tmp')).filter((f) => f.startsWith('push-'))).toEqual([]);
  });

  it('树的头不是要推的、有没提交的改动、没有新提交、树不在：明确报错，不推', async () => {
    const { ports, calls, trees } = setup();
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
          details: { findings: [{ path: 'src/login.ts', line: 1, rule: 'email' }] },
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
    expect(await ports.pushBranch(input, ctx)).toEqual({ head: merged });
    expect(calls.pushBranch?.map((c) => (c as { head: string }).head)).toEqual([merged, merged]);
  });

  it('并出冲突：撤掉这次合并（树回到会话交的头、没有并了一半的状态），报 MERGE_CONFLICT 带冲突的文件，不推', async () => {
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
      details: { mainline: main, conflictFiles: ['a.ts'] },
    });
    expect((err as Error).message).toContain(`git merge ${main}`);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
    // 没有并了一半的文件、没暂存东西（端口那边的 git 在 Windows 上带着系统级的 autocrlf，工作树里的换行符会跟着变：
    // 这里也按 autocrlf 比，只看内容）
    expect(git(dir, 'ls-files', '-u')).toBe('');
    expect(git(dir, '-c', 'core.autocrlf=true', 'status', '--porcelain', '--untracked-files=no')).toBe('');
    expect(existsSync(join(dir, '.git', 'MERGE_HEAD'))).toBe(false);
    // 新主线的提交已经在树里：会话照着 git merge 就能解
    expect(git(dir, 'cat-file', '-t', main)).toBe('commit');
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
      details: { mainline: main, conflictFiles: ['b.ts'] },
    });
    expect((err as Error).message).toContain('b.ts');
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(readFileSync(join(dir, 'b.ts'), 'utf8')).toBe('// 会话的草稿\n');
    expect(existsSync(join(dir, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(calls.pushBranch ?? []).toHaveLength(0);
  });

  it('并的时候 git 自己出错（.git/index.lock 被占着）：报 GIT_FAILED（可重试，不当成冲突），树不动、不推', async () => {
    const { ports, calls, trees } = setup();
    const dir = await seededTree(trees);
    const head = commitIn(dir, 'login.ts');
    advanceMain('b.ts', 'export const b = 2;\n');
    writeFileSync(join(dir, '.git', 'index.lock'), '');
    const err = await ports
      .pushBranch({ taskId: 't1', repo, worktreePath: dir, branch: BRANCH, head }, ctx)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'GIT_FAILED', retryable: true });
    // 原文随 git 的版本、配置不同（锁文件在、或 autostash 写不了索引）：只认是「并」这一步没做成
    expect((err as Error).message).toMatch(/^并 [0-9a-f]{7}：/);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(existsSync(join(dir, '.git', 'MERGE_HEAD'))).toBe(false);
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
    expect(await ports.pushBranch(input, ctx)).toEqual({ head: second });
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

describe('开 PR、CI、合并', () => {
  const body = {
    requirement: 12,
    subtask: 'login 登录',
    did: ['加了验证码'],
    verified: ['pnpm check'],
    specs: 'specs/28-接真端口/',
    changedFiles: ['src/login.ts'],
  };

  it('正文给结构（github 包按模板渲染）；照抄需求 issue 的类别标签和里程碑', async () => {
    const { ports, calls } = setup();
    expect(
      await ports.openPr({ taskId: 't1', repo, branch: BRANCH, head: m.head, title: '登录', body }, ctx),
    ).toEqual({
      prNumber: 101,
      url: 'https://github.com/acme/widgets/pull/101',
    });
    expect(calls.openPr?.[0]).toMatchObject({
      body: {
        requirement: 12,
        did: ['加了验证码'],
        plan: 'plan.md P1「工作流」',
        specs: 'specs/28-接真端口/',
      },
      inheritFrom: { issueNumber: 12 },
    });
    // 「对应计划」是现读主线上那份需求文档里的那一行（人改了文件，下一次开 PR 就跟上）
    expect(calls.readSpecDoc?.[0]).toMatchObject({ path: 'specs/28-接真端口/需求.md' });
    const { ports: p2, calls: c2 } = setup();
    const { requirement: _dropped, ...noIssue } = body;
    await p2.openPr({ taskId: 't1', repo, branch: BRANCH, head: m.head, title: '杂活', body: noIssue }, ctx);
    expect(c2.openPr?.[0]).not.toHaveProperty('inheritFrom');
  });

  it('需求文档没有「对应计划」那一行：不开 PR，明确报错（SPEC_PLAN_MISSING，不重试）', async () => {
    const { ports } = setup({
      readSpecDoc: (input: { path: string }) => ({
        path: input.path,
        content: '# 需求\n要验证码\n',
        url: 'x',
      }),
    });
    await expect(
      ports.openPr({ taskId: 't1', repo, branch: BRANCH, head: m.head, title: '登录', body }, ctx),
    ).rejects.toMatchObject({ code: 'SPEC_PLAN_MISSING', retryable: false });
  });

  it('那一行后面空着：「对应计划」不许填空的，明确报错（不重试）', async () => {
    const { ports } = setup({
      readSpecDoc: (input: { path: string }) => ({
        path: input.path,
        content: '# 需求\n\n对应计划：\n',
        url: 'x',
      }),
    });
    await expect(
      ports.openPr({ taskId: 't1', repo, branch: BRANCH, head: m.head, title: '登录', body }, ctx),
    ).rejects.toMatchObject({ code: 'SPEC_PLAN_MISSING', retryable: false });
  });

  it('需求文档还没进主线（读回 null）：明确报错，不当成空文档', async () => {
    const { ports } = setup({ readSpecDoc: () => null });
    await expect(
      ports.openPr({ taskId: 't1', repo, branch: BRANCH, head: m.head, title: '登录', body }, ctx),
    ).rejects.toMatchObject({ code: 'SPEC_PLAN_MISSING', retryable: false });
  });

  it('读需求文档读不了（403）：原样带过，不当成「没有那一行」', async () => {
    const { ports } = setup({
      readSpecDoc: () => {
        throw new GitHubError('FORBIDDEN', 'Resource not accessible by integration');
      },
    });
    await expect(
      ports.openPr({ taskId: 't1', repo, branch: BRANCH, head: m.head, title: '登录', body }, ctx),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('specs 目录给的是空串：明确报错，连需求文档都不去读', async () => {
    const { ports, calls } = setup();
    await expect(
      ports.openPr(
        { taskId: 't1', repo, branch: BRANCH, head: m.head, title: '登录', body: { ...body, specs: '  ' } },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'SPEC_PLAN_MISSING', retryable: false });
    expect(calls.readSpecDoc).toBeUndefined();
  });

  it('specs 目录末尾没带斜杠：补上（PR 模板里就带斜杠）', async () => {
    const { ports, calls } = setup();
    await ports.openPr(
      {
        taskId: 't1',
        repo,
        branch: BRANCH,
        head: m.head,
        title: '登录',
        body: { ...body, specs: 'specs/28-接真端口' },
      },
      ctx,
    );
    expect(calls.readSpecDoc?.[0]).toMatchObject({ path: 'specs/28-接真端口/需求.md' });
    expect(calls.openPr?.[0]).toMatchObject({ body: { specs: 'specs/28-接真端口/' } });
  });

  it('在新头上跑测试 = 等这个头的 CI：没查成抛 CI_UNKNOWN（不退回会话），红了写明哪几项', async () => {
    const unknown = setup({
      waitCi: (input: { head: string }) => ({ state: 'missing', head: input.head, detail: '一个检查都没有' }),
    });
    await expect(
      unknown.ports.runTests({ taskId: 't1', repo, prNumber: 101, branch: BRANCH, head: m.head }, ctx),
    ).rejects.toMatchObject({ code: 'CI_UNKNOWN' });
    const red = setup({
      waitCi: (input: { head: string }) => ({
        state: 'red',
        head: input.head,
        failedChecks: ['check'],
        digest: '2 个测试没过',
      }),
    });
    expect(
      await red.ports.runTests({ taskId: 't1', repo, prNumber: 101, branch: BRANCH, head: m.head }, ctx),
    ).toEqual({
      passed: false,
      head: m.head,
      summary: '新头上的 CI 红了：check；2 个测试没过',
    });
  });

  it('合不了写明原因；需求文档写到 specs 目录下，提交说明带需求号', async () => {
    const { ports, calls } = setup({
      mergePr: () => ({ merged: false, reason: 'head_moved', detail: '头变了' }),
    });
    expect(await ports.mergePr({ taskId: 't1', repo, prNumber: 101, expectedHead: m.head }, ctx)).toEqual({
      merged: false,
      reason: 'head_moved: 头变了',
    });
    expect(
      await ports.writeSpecDoc(
        { taskId: 't1', repo, issueNumber: 12, specDir: 'specs/12-登录/', doc: 'plan', markdown: '# 方案' },
        ctx,
      ),
    ).toEqual({ path: 'specs/12-登录/方案.md', commit: 'd'.repeat(40) });
    expect(calls.writeSpecDoc?.[0]).toMatchObject({ message: 'docs(spec): #12 方案.md' });
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

  it('树在旧头之后还有没推的提交：快进不了，明确报 WORKTREE_DIVERGED（要人看），不硬并', async () => {
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
    commitIn(dir, 'local.ts');
    await expect(
      s.ports.syncMainline(
        { taskId: 't1', repo, prNumber: 101, branch: BRANCH, head: m.head, worktreePath: dir },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'WORKTREE_DIVERGED' });
  });
});
