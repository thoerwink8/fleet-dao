// 任务工作流里不碰会话的五个真活动（real/task-activities.ts）：读交代、读交付（真 git）、查改标准的路径、
// 挂自动合并（含「GitHub 说已经是 clean」）、等合并（长轮询）。每条读不到、认不出、合不了的路径都故意造一次：
// 要抛明确的错或明确回「没成」，不拿空冒充没事。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubError, type MergePrResult } from '@fleet-dao/github';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type PortContext, PortError } from '../../src/ports.ts';
import { localExec } from '../../src/real/exec.ts';
import { createTaskActivities, type TaskActivitiesDeps } from '../../src/real/task-activities.ts';
import { pinMainline, type UserTree } from '../../src/real/user-git.ts';

const REPO = { id: 'r1', owner: 'acme', name: 'demo', defaultBranch: 'main', testCommand: 'pnpm check' };
const HEAD = 'a'.repeat(40);

function ctx(over: Partial<PortContext> = {}): PortContext {
  return {
    signal: new AbortController().signal,
    heartbeat: () => undefined,
    attempt: 1,
    lastHeartbeat: undefined,
    ...over,
  };
}

interface PullOver {
  merged?: boolean;
  state?: 'open' | 'closed';
  headSha?: string;
  autoMerge?: boolean;
}
const pullFacts = (o: PullOver = {}) => ({
  number: 7,
  nodeId: 'PR_7',
  state: o.state ?? 'open',
  merged: o.merged ?? false,
  draft: false,
  title: 't',
  body: '',
  headSha: o.headSha ?? HEAD,
  headRef: 'fleet/12-t1a2b3c4d',
  fromFork: false,
  author: null,
  autoMerge: o.autoMerge ?? false,
});

const mergedOk = (commit = 'c'.repeat(40), already = true): MergePrResult => ({
  merged: true,
  mergeCommit: commit,
  alreadyMerged: already,
  branchDeleted: true,
  mergedBy: 'fleet-dao-engine[bot]',
  mergedByEngine: true,
});

type Gh = TaskActivitiesDeps['gh'];

/** 假 GitHub：每个读都可以换；没换的读了就抛，免得测试悄悄读到不该读的。 */
function fakeGh(over: Partial<Record<string, unknown>> = {}): { gh: Gh; calls: string[] } {
  const calls: string[] = [];
  const unexpected = (name: string) => async () => {
    throw new Error(`测试里没准备 ${name}`);
  };
  const pick = <T>(name: string, fallback?: T): T => {
    const fn = (over[name] ?? fallback ?? unexpected(name)) as (...a: unknown[]) => unknown;
    return ((...args: unknown[]) => {
      calls.push(name);
      return fn(...args);
    }) as T;
  };
  const gh = {
    readIssue: pick('readIssue'),
    readSpecDoc: pick('readSpecDoc'),
    readRepoFile: pick('readRepoFile'),
    pullFiles: pick('pullFiles'),
    mergePr: pick('mergePr'),
    claims: {
      readPull: pick('readPull'),
      enableAutoMerge: pick('enableAutoMerge'),
    },
  } as unknown as Gh;
  return { gh, calls };
}

const BODY = [
  '## 场景',
  '',
  '创始人要在驾驶舱看到每张单走到哪一步。',
  '',
  '## 原话',
  '',
  '「我回来打开驾驶舱，这张单就该在做完的那一栏」',
  '',
  '## 已知的模块',
  '',
  '- `packages/web/src/pages/`：驾驶舱页面',
  '',
  '## 怎么算做完',
  '',
  '1. 页面上能看到「验收中」这个状态',
  '',
].join('\n');

function make(over: Partial<TaskActivitiesDeps> & { gh: Gh }) {
  const logs: { message: string; fields?: Record<string, unknown> }[] = [];
  const acts = createTaskActivities({
    trees: { ownerOf: async () => 'fleet-agent-carpool' },
    exec: localExec(),
    gitBin: 'git',
    shBin: 'sh',
    pollEveryMs: 1,
    sleep: async () => undefined,
    log: (message, fields) => logs.push({ message, ...(fields ? { fields } : {}) }),
    ...over,
  });
  return { acts, logs };
}

describe('读交代', () => {
  it('单子正文写全了：拼出交代，分档、验收条都在', async () => {
    const { gh, calls } = fakeGh({
      readIssue: async () => ({ number: 12, title: '给驾驶舱加状态', body: BODY, state: 'open' }),
    });
    const { acts } = make({ gh });
    const got = await acts.readTaskBrief({ schemaVersion: 1, repo: REPO, issueNumber: 12 }, ctx());
    expect(got).toMatchObject({
      ok: true,
      brief: { issueNumber: 12, acceptance: ['页面上能看到「验收中」这个状态'], tier: { tier: 'medium' } },
    });
    expect(calls).toEqual(['readIssue']);
  });

  it('单子指着需求文档：读主线上那份，交代按文档拼', async () => {
    const asked: string[] = [];
    const { gh } = fakeGh({
      readIssue: async () => ({
        number: 12,
        title: '给驾驶舱加状态',
        body: '概述\n\n文档：`specs/12-驾驶舱状态/需求.md`',
        state: 'open',
      }),
      readSpecDoc: async (input: { path: string }) => {
        asked.push(input.path);
        return { path: input.path, content: BODY, url: 'u' };
      },
    });
    const { acts } = make({ gh });
    const got = await acts.readTaskBrief({ schemaVersion: 1, repo: REPO, issueNumber: 12 }, ctx());
    expect(asked).toEqual(['specs/12-驾驶舱状态/需求.md']);
    expect(got).toMatchObject({ ok: true, brief: { specDir: 'specs/12-驾驶舱状态' } });
  });

  it('【故意造出的失败】指着的需求文档主线上没有：回交代不全（不是空交代）', async () => {
    const { gh } = fakeGh({
      readIssue: async () => ({
        number: 12,
        title: 'x',
        body: '文档：`specs/12-驾驶舱状态/需求.md`',
        state: 'open',
      }),
      readSpecDoc: async () => null,
    });
    const got = await make({ gh }).acts.readTaskBrief(
      { schemaVersion: 1, repo: REPO, issueNumber: 12 },
      ctx(),
    );
    expect(got).toMatchObject({ ok: false, problems: [{ field: '需求文档' }] });
  });

  it('【故意造出的失败】号是 PR / 读单子失败：抛 PortError（码和能不能重试原样带过），不回空交代', async () => {
    const notIssue = fakeGh({
      readIssue: async () => {
        throw new GitHubError('NOT_AN_ISSUE', 'acme/demo #12 是 PR，不是 issue');
      },
    });
    const err = await make({ gh: notIssue.gh })
      .acts.readTaskBrief({ schemaVersion: 1, repo: REPO, issueNumber: 12 }, ctx())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortError);
    expect(err).toMatchObject({ code: 'NOT_AN_ISSUE' });

    const down = fakeGh({
      readIssue: async () => {
        throw new GitHubError('UPSTREAM_ERROR', 'GitHub 502', { retryable: true });
      },
    });
    await expect(
      make({ gh: down.gh }).acts.readTaskBrief({ schemaVersion: 1, repo: REPO, issueNumber: 12 }, ctx()),
    ).rejects.toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true });
  });
});

describe('读交付（真 git）', { timeout: 60_000 }, () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fleet-task-delivery-'));
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
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();

  /** 一棵起点已钉成主线的树。同一条用例里要多棵时给不同的名字。 */
  async function tree(name = 'work'): Promise<{ dir: string; base: string }> {
    const dir = join(root, name);
    mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'README.md'), '# demo\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'first');
    const base = git(dir, 'rev-parse', 'HEAD');
    const t: UserTree = {
      exec: localExec(),
      user: 'fleet-agent-carpool',
      dir,
      scopePrefix: 'test',
      git: 'git',
      sh: 'sh',
    };
    await pinMainline(t, 'main', base);
    git(dir, 'checkout', '-q', '-b', 'fleet/12-t1a2b3c4d');
    return { dir, base };
  }

  const input = (dir: string, base: string) => ({
    schemaVersion: 1 as const,
    taskId: 't1',
    repo: REPO,
    worktreePath: dir,
    baseSha: base,
  });

  it('会话提交了两个文件：回头、提交数、改了哪些文件；工作树是干净的 leftover 为空', async () => {
    const { dir, base } = await tree();
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'b.ts'), 'export const b = 1;\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'add a, b');
    const head = git(dir, 'rev-parse', 'HEAD');
    const { acts } = make({ gh: fakeGh().gh });
    expect(await acts.readDelivery(input(dir, base), ctx())).toEqual({
      head,
      commits: 1,
      changedFiles: ['a.ts', 'b.ts'],
      leftover: [],
      conflicts: [],
    });
  });

  it('【故意造出的失败】一个提交都没有、工作树里有改过的和新建没加的文件：commits 是 0，leftover 把它们都列出来', async () => {
    const { dir, base } = await tree();
    writeFileSync(join(dir, 'README.md'), '# changed\n');
    writeFileSync(join(dir, 'new.ts'), 'export {};\n');
    const { acts } = make({ gh: fakeGh().gh });
    const got = await acts.readDelivery(input(dir, base), ctx());
    expect(got.commits).toBe(0);
    expect(got.changedFiles).toEqual([]);
    expect(got.leftover).toEqual([' M README.md', '?? new.ts']);
  });

  it('提交了一部分、还留着没提交的：commits 大于 0 且 leftover 不空（工作流据此不推）', async () => {
    const { dir, base } = await tree();
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'add a');
    writeFileSync(join(dir, 'forgot.ts'), 'export {};\n');
    const got = await make({ gh: fakeGh().gh }).acts.readDelivery(input(dir, base), ctx());
    expect(got).toMatchObject({ commits: 1, changedFiles: ['a.ts'], leftover: ['?? forgot.ts'] });
  });

  it('【故意造出的失败】树没人认领（没建起来 / 已收）：WORKTREE_MISSING，不回「没有改动」', async () => {
    const { dir, base } = await tree();
    const { acts } = make({ gh: fakeGh().gh, trees: { ownerOf: async () => null } });
    await expect(acts.readDelivery(input(dir, base), ctx())).rejects.toMatchObject({
      code: 'WORKTREE_MISSING',
      retryable: false,
    });
  });

  it('【故意造出的失败】树里还有冲突标记（MERGE_HEAD 或 git diff --check）：conflicts 非空，工作流据此不算交活', async () => {
    const { acts } = make({ gh: fakeGh().gh });
    const markers = '<<<<<<< ours\nexport const a = 1;\n=======\nexport const a = 2;\n>>>>>>> theirs\n';

    const merging = await tree('merging');
    writeFileSync(join(merging.dir, 'a.ts'), 'export const a = 1;\n');
    git(merging.dir, 'add', '.');
    git(merging.dir, 'commit', '-q', '-m', 'branch a');
    git(merging.dir, 'checkout', '-q', 'main');
    writeFileSync(join(merging.dir, 'a.ts'), 'export const a = 2;\n');
    git(merging.dir, 'add', '.');
    git(merging.dir, 'commit', '-q', '-m', 'main a');
    git(merging.dir, 'checkout', '-q', 'fleet/12-t1a2b3c4d');
    try {
      git(merging.dir, 'merge', '--no-ff', '--no-edit', 'main');
    } catch {
      // 内容冲突时 git merge 退出码 1，标记留在树里
    }
    expect(existsSync(join(merging.dir, '.git', 'MERGE_HEAD'))).toBe(true);
    const mid = await acts.readDelivery(input(merging.dir, merging.base), ctx());
    expect(mid.conflicts).toContain('a.ts');

    const marked = await tree('marked');
    writeFileSync(join(marked.dir, 'a.ts'), 'export const a = 1;\n');
    git(marked.dir, 'add', '.');
    git(marked.dir, 'commit', '-q', '-m', 'add a');
    writeFileSync(join(marked.dir, 'a.ts'), markers);
    const loose = await acts.readDelivery(input(marked.dir, marked.base), ctx());
    expect(loose.conflicts).toContain('a.ts');

    // 已经 git add、MERGE_HEAD 不在：未暂存的检查是干净的，已暂存的还能看见标记
    const staged = await tree('staged');
    writeFileSync(join(staged.dir, 'a.ts'), 'export const a = 1;\n');
    git(staged.dir, 'add', '.');
    git(staged.dir, 'commit', '-q', '-m', 'add a');
    writeFileSync(join(staged.dir, 'a.ts'), markers);
    git(staged.dir, 'add', '--', 'a.ts');
    expect(existsSync(join(staged.dir, '.git', 'MERGE_HEAD'))).toBe(false);
    const added = await acts.readDelivery(input(staged.dir, staged.base), ctx());
    expect(added.conflicts).toContain('a.ts');

    // 只有行尾空白：diff --check 也会失败，但不是冲突标记
    const space = await tree('space');
    writeFileSync(join(space.dir, 'b.ts'), 'export const b = 1;\n');
    git(space.dir, 'add', '.');
    git(space.dir, 'commit', '-q', '-m', 'add b');
    writeFileSync(join(space.dir, 'b.ts'), 'export const b = 1; \n');
    const ws = await acts.readDelivery(input(space.dir, space.base), ctx());
    expect(ws.conflicts).toEqual([]);
  });

  it('【故意造出的失败】冲突标记被 git add 并提交后，MERGE_HEAD 和两种 diff 都没了：conflicts 仍有那个文件，不算交活', async () => {
    const { dir, base } = await tree('committed');
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'branch a');
    git(dir, 'checkout', '-q', 'main');
    writeFileSync(join(dir, 'a.ts'), 'export const a = 2;\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'main a');
    const main = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'checkout', '-q', 'fleet/12-t1a2b3c4d');
    const t: UserTree = {
      exec: localExec(),
      user: 'fleet-agent-carpool',
      dir,
      scopePrefix: 'test',
      git: 'git',
      sh: 'sh',
    };
    await pinMainline(t, 'main', main);
    try {
      git(dir, 'merge', '--no-ff', '--no-edit', 'main');
    } catch {
      // 内容冲突时 git merge 退出码 1
    }
    git(dir, 'add', '--', 'a.ts');
    git(dir, 'commit', '-q', '-m', 'commit markers');
    expect(existsSync(join(dir, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(git(dir, 'status', '--porcelain')).toBe('');
    const got = await make({ gh: fakeGh().gh }).acts.readDelivery(input(dir, base), ctx());
    expect(got.leftover).toEqual([]);
    expect(got.conflicts).toContain('a.ts');
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toContain('<<<<<<<');
  });

  it('主线原样带进来的文件里就有一行七个等号，会话没改它：不算这次没解的冲突', async () => {
    const { dir, base } = await tree('from-main');
    git(dir, 'checkout', '-q', 'main');
    writeFileSync(join(dir, 'note.md'), '=======\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'main note');
    const main = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'checkout', '-q', 'fleet/12-t1a2b3c4d');
    git(dir, 'merge', '--no-ff', '--no-edit', 'main');
    const t: UserTree = {
      exec: localExec(),
      user: 'fleet-agent-carpool',
      dir,
      scopePrefix: 'test',
      git: 'git',
      sh: 'sh',
    };
    await pinMainline(t, 'main', main);
    const got = await make({ gh: fakeGh().gh }).acts.readDelivery(input(dir, base), ctx());
    expect(got.conflicts).toEqual([]);
    expect(readFileSync(join(dir, 'note.md'), 'utf8')).toBe('=======\n');
  });

  it('【故意造出的失败】树里没钉主线：MAINLINE_MISSING，分不出哪些改动是并进来的主线就不猜', async () => {
    const { dir, base } = await tree();
    git(dir, 'update-ref', '-d', 'refs/remotes/origin/main');
    const { acts } = make({ gh: fakeGh().gh });
    await expect(acts.readDelivery(input(dir, base), ctx())).rejects.toMatchObject({
      code: 'MAINLINE_MISSING',
    });
  });
});

describe('查改标准的路径', () => {
  const STANDARDS = JSON.stringify({
    paths: [
      { path: 'AGENTS.md', section: '通用段', why: '通用段' },
      { path: 'agents/**/*.md', why: '技能说明' },
    ],
  });
  const text = (t: string) => ({ defaultBranch: 'main', commit: HEAD, file: { kind: 'text', text: t } });
  const missing = { defaultBranch: 'main', commit: HEAD, file: { kind: 'missing' } };
  const files =
    (...names: string[]) =>
    async () =>
      names.map((filename) => ({ filename, status: 'modified' }));
  const check = (gh: Gh) =>
    make({ gh }).acts.checkGuarded({ schemaVersion: 1, taskId: 't1', repo: REPO, prNumber: 7 }, ctx());
  const lists = async () => text(STANDARDS);

  it('通配的技能说明、AGENTS.md（带段）算改标准；CI 工作流这类不再有第二道门', async () => {
    const { gh } = fakeGh({
      pullFiles: files('agents/skills/x/SKILL.md', 'AGENTS.md', '.github/workflows/ci.yml', 'src/a.ts'),
      readRepoFile: lists,
    });
    expect(await check(gh)).toEqual({
      standards: [
        'agents/skills/x/SKILL.md（agents/**/*.md）',
        'AGENTS.md（AGENTS.md，只有「通用段」这一段算标准）',
      ],
    });
  });

  it('什么都没碰：空', async () => {
    const { gh } = fakeGh({ pullFiles: files('src/a.ts'), readRepoFile: lists });
    expect(await check(gh)).toEqual({ standards: [] });
  });

  it('这个仓没声明改标准清单（文件不在）：空，不当成读失败', async () => {
    const { gh } = fakeGh({ pullFiles: files('AGENTS.md'), readRepoFile: async () => missing });
    expect(await check(gh)).toEqual({ standards: [] });
  });

  describe('人批过的路径（approved）', () => {
    const checkWith = (gh: Gh, approved: { standards: string[] }) =>
      make({ gh }).acts.checkGuarded(
        { schemaVersion: 1, taskId: 't1', repo: REPO, prNumber: 7, approved },
        ctx(),
      );
    const AGENTS_ENTRY = 'AGENTS.md（AGENTS.md，只有「通用段」这一段算标准）';

    it('原样批过的条目放行', async () => {
      const { gh } = fakeGh({ pullFiles: files('AGENTS.md'), readRepoFile: lists });
      expect(await checkWith(gh, { standards: [AGENTS_ENTRY] })).toEqual({ standards: [] });
    });

    it('【故意造出的失败】批了之后又多出新的路径：没批的照拦，不整个放行', async () => {
      const extra = fakeGh({
        pullFiles: files('AGENTS.md', 'agents/skills/x/SKILL.md'),
        readRepoFile: lists,
      });
      const got = await checkWith(extra.gh, { standards: [AGENTS_ENTRY] });
      expect(got.standards).toEqual(['agents/skills/x/SKILL.md（agents/**/*.md）']);
    });

    it('【故意造出的失败】批准的条目对不上（批的是别的路径）：照拦', async () => {
      const { gh } = fakeGh({ pullFiles: files('AGENTS.md'), readRepoFile: lists });
      const got = await checkWith(gh, { standards: ['别的文件（别的规则）'] });
      expect(got.standards).toEqual([AGENTS_ENTRY]);
    });
  });

  it('【故意造出的失败】清单认不出 / 不是能读的文本 / 读 PR 文件失败：抛明确的错，不当成「没碰到」', async () => {
    const bad = fakeGh({ pullFiles: files('a'), readRepoFile: async () => text('{"paths":[]}') });
    await expect(check(bad.gh)).rejects.toMatchObject({ code: 'GUARD_LIST_INVALID', retryable: false });

    const notFile = fakeGh({
      pullFiles: files('a'),
      readRepoFile: async () => ({
        defaultBranch: 'main',
        commit: HEAD,
        file: { kind: 'not_file', why: '太大' },
      }),
    });
    await expect(check(notFile.gh)).rejects.toMatchObject({ code: 'GUARD_LIST_UNREADABLE' });

    const filesDown = fakeGh({
      pullFiles: async () => {
        throw new GitHubError('UPSTREAM_ERROR', '翻页翻不完', { retryable: true });
      },
      readRepoFile: async () => missing,
    });
    await expect(check(filesDown.gh)).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });
});

describe('挂自动合并', () => {
  const run = (gh: Gh) =>
    make({ gh }).acts.armAutoMerge({ schemaVersion: 1, repo: REPO, prNumber: 7, expectedHead: HEAD }, ctx());

  it('开着、头对得上、没挂：挂上', async () => {
    const f = fakeGh({ readPull: async () => pullFacts(), enableAutoMerge: async () => undefined });
    expect(await run(f.gh)).toEqual({ armed: true, merged: false });
    expect(f.calls).toEqual(['readPull', 'enableAutoMerge']);
  });

  it('本来就挂着：不重复挂', async () => {
    const f = fakeGh({ readPull: async () => pullFacts({ autoMerge: true }) });
    expect(await run(f.gh)).toEqual({ armed: true, merged: false });
    expect(f.calls).toEqual(['readPull']);
  });

  it('【故意造出的失败】PR 关了 / 头被别人改了：不挂，说清楚为什么', async () => {
    const closed = fakeGh({ readPull: async () => pullFacts({ state: 'closed' }) });
    expect(await run(closed.gh)).toMatchObject({
      armed: false,
      merged: false,
      why: expect.stringContaining('关了'),
    });
    expect(closed.calls).toEqual(['readPull']);

    const moved = fakeGh({ readPull: async () => pullFacts({ headSha: 'b'.repeat(40) }) });
    const got = await run(moved.gh);
    expect(got).toMatchObject({ armed: false, merged: false });
    expect(got.why).toContain('bbbbbbb');
    expect(moved.calls).toEqual(['readPull']);
  });

  it('已经合了：补合并记录，回合并提交', async () => {
    const f = fakeGh({
      readPull: async () => pullFacts({ merged: true }),
      mergePr: async () => mergedOk('d'.repeat(40)),
    });
    expect(await run(f.gh)).toEqual({ armed: false, merged: true, mergeCommit: 'd'.repeat(40) });
    expect(f.calls).toEqual(['readPull', 'mergePr']);
  });

  it('GitHub 说已经是 clean（没什么可等的）：直接合，回合并提交', async () => {
    const f = fakeGh({
      readPull: async () => pullFacts(),
      enableAutoMerge: async () => {
        throw new GitHubError('GRAPHQL_ERROR', 'GraphQL: Pull request Pull request is in clean status');
      },
      mergePr: async () => mergedOk('e'.repeat(40), false),
    });
    expect(await run(f.gh)).toEqual({ armed: false, merged: true, mergeCommit: 'e'.repeat(40) });
    expect(f.calls).toEqual(['readPull', 'enableAutoMerge', 'mergePr']);
  });

  it('【故意造出的失败】clean 时直接合被拒（落后主线）：不当成合了，把拒绝的原因原样交出去', async () => {
    const f = fakeGh({
      readPull: async () => pullFacts(),
      enableAutoMerge: async () => {
        throw new GitHubError('GRAPHQL_ERROR', 'Pull request is in clean status');
      },
      mergePr: async () => ({ merged: false, reason: 'behind_main', detail: '主线比 PR 多 2 个提交' }),
    });
    const got = await run(f.gh);
    expect(got).toMatchObject({ armed: false, merged: false });
    expect(got.why).toContain('behind_main');
    expect(got.why).toContain('主线比 PR 多 2 个提交');
  });

  it('【故意造出的失败】别的挂不上的报错（权限不够）：原样抛，不当成挂上了，也不乱走直接合', async () => {
    const f = fakeGh({
      readPull: async () => pullFacts(),
      enableAutoMerge: async () => {
        throw new GitHubError('FORBIDDEN', 'Resource not accessible by integration', { retryable: false });
      },
    });
    await expect(run(f.gh)).rejects.toMatchObject({ code: 'FORBIDDEN', retryable: false });
    expect(f.calls).toEqual(['readPull', 'enableAutoMerge']);
  });
});

describe('等合并', () => {
  const wait = (gh: Gh, over: Partial<TaskActivitiesDeps> = {}, c: PortContext = ctx(), minutes = 15) =>
    make({ gh, ...over }).acts.waitMerged(
      { schemaVersion: 1, repo: REPO, prNumber: 7, expectedHead: HEAD, minutes },
      c,
    );

  it('挂着、看了两次才合：补合并记录，回合并提交；每次看之前都报了心跳', async () => {
    let n = 0;
    let beats = 0;
    const f = fakeGh({
      readPull: async () => {
        n += 1;
        return n < 3 ? pullFacts({ autoMerge: true }) : pullFacts({ merged: true });
      },
      mergePr: async () => mergedOk('f'.repeat(40)),
    });
    const got = await wait(f.gh, {}, ctx({ heartbeat: () => (beats += 1) }));
    expect(got).toEqual({ state: 'merged', mergeCommit: 'f'.repeat(40) });
    expect(n).toBe(3);
    expect(beats).toBe(3);
    expect(f.calls.filter((c) => c === 'mergePr')).toHaveLength(1);
  });

  it('合了但补记录失败：照样回合并了（记录对账会补），只记日志', async () => {
    const f = fakeGh({
      readPull: async () => pullFacts({ merged: true }),
      mergePr: async () => {
        throw new GitHubError('UPSTREAM_ERROR', '删分支 502', { retryable: true });
      },
    });
    const { acts, logs } = make({ gh: f.gh });
    const got = await acts.waitMerged(
      { schemaVersion: 1, repo: REPO, prNumber: 7, expectedHead: HEAD, minutes: 1 },
      ctx(),
    );
    expect(got).toEqual({ state: 'merged' });
    expect(logs[0]?.message).toContain('补合并记录');
  });

  it('【故意造出的失败】PR 被关 / 头被改 / 合进去的不是引擎推的头 / 自动合并被撤：各回各的状态', async () => {
    expect(await wait(fakeGh({ readPull: async () => pullFacts({ state: 'closed' }) }).gh)).toEqual({
      state: 'closed',
    });
    expect(
      await wait(
        fakeGh({ readPull: async () => pullFacts({ headSha: 'b'.repeat(40), autoMerge: true }) }).gh,
      ),
    ).toEqual({ state: 'head_moved', head: 'b'.repeat(40) });
    expect(
      await wait(fakeGh({ readPull: async () => pullFacts({ merged: true, headSha: 'c'.repeat(40) }) }).gh),
    ).toEqual({ state: 'head_moved', head: 'c'.repeat(40) });
    expect(await wait(fakeGh({ readPull: async () => pullFacts({ autoMerge: false }) }).gh)).toEqual({
      state: 'unarmed',
    });
  });

  it('到点还没合：回 waiting（工作流再来一轮），不是 merged', async () => {
    let clock = 0;
    const f = fakeGh({ readPull: async () => pullFacts({ autoMerge: true }) });
    const got = await wait(f.gh, {
      now: () => new Date(clock),
      sleep: async (ms) => {
        clock += ms * 1000; // 每次休眠快进，十几次就过了 15 分钟
      },
    });
    expect(got).toMatchObject({ state: 'waiting' });
    expect(f.calls.filter((c) => c === 'readPull').length).toBeGreaterThan(1);
  });

  it('【故意造出的失败】叫停：休眠被打断，活动抛出取消，不吞成「还在等」', async () => {
    const ac = new AbortController();
    const f = fakeGh({ readPull: async () => pullFacts({ autoMerge: true }) });
    const { acts } = make({
      gh: f.gh,
      sleep: async (_ms, signal) => {
        ac.abort(new Error('被叫停了'));
        if (signal.aborted) throw signal.reason;
      },
    });
    await expect(
      acts.waitMerged(
        { schemaVersion: 1, repo: REPO, prNumber: 7, expectedHead: HEAD, minutes: 15 },
        ctx({ signal: ac.signal }),
      ),
    ).rejects.toThrow('被叫停了');
  });

  it('【故意造出的失败】读 PR 失败：抛 PortError（码带过去），不回「还在等」', async () => {
    const f = fakeGh({
      readPull: async () => {
        throw new GitHubError('UPSTREAM_ERROR', 'GitHub 502', { retryable: true });
      },
    });
    await expect(wait(f.gh)).rejects.toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true });
  });
});
