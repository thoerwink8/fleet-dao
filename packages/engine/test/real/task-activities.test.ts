// 任务工作流里不碰会话的五个真活动（real/task-activities.ts）：读交代、读交付（真 git）、查改标准的路径、
// 挂自动合并（含「GitHub 说已经是 clean」）、等合并（长轮询）。每条读不到、认不出、合不了的路径都故意造一次：
// 要抛明确的错或明确回「没成」，不拿空冒充没事。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubError, type MergePrResult } from '@fleet-dao/github';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toActivityFailure } from '../../src/activities.ts';
import { type PortContext, PortError } from '../../src/ports.ts';
import { localExec } from '../../src/real/exec.ts';
import {
  createTaskActivities,
  MERGE_PENDING_RETRIES,
  type MergeWaitChecks,
  type TaskActivitiesDeps,
} from '../../src/real/task-activities.ts';
import { pinMainline, type UserTree } from '../../src/real/user-git.ts';
import { requirementContract } from '../../src/runner/task-brief.ts';
import type { ReviewChange } from '../../src/task-contract.ts';
import { runChildOk } from '../child.ts';
import { json as httpJson, setup as setupHttp } from '../review-http.ts';

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
  mergeable?: boolean | null;
  mergeableState?: string;
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
  mergeable: o.mergeable === undefined ? true : o.mergeable,
  mergeableState: o.mergeableState ?? 'clean',
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
    updateBranch: pick('updateBranch'),
    claims: {
      readPull: pick('readPull'),
      enableAutoMerge: pick('enableAutoMerge'),
      disableAutoMerge: pick('disableAutoMerge'),
      setStatus: pick('setStatus'),
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
    // 没单独给时当还在跑：老用例里「等必过检查」仍等到时限回 waiting。显式传 undefined 才是没接上。
    readChecks: async () => ({ overall: 'pending', failed: [] }),
    ...over,
  });
  return { acts, logs };
}

describe('正式合同写前核验（#3216）', () => {
  const guard = { issueNumber: 12, expected: requirementContract(BODY) };
  const arm = {
    schemaVersion: 1 as const,
    repo: REPO,
    prNumber: 7,
    expectedHead: HEAD,
    contractGuard: guard,
  };
  const changed = BODY.replace('验收中', '新验收');
  const defaults = {
    readPull: async () => pullFacts({ autoMerge: true }),
    readIssue: async () => ({ number: 12, title: '正式需求', state: 'open', body: changed }),
    readSpecDoc: async () => null,
    disableAutoMerge: async () => undefined,
    setStatus: async () => undefined,
  };
  it('已挂自动合并也要读合同：同head换验收后撤挂并阻合', async () => {
    const { gh, calls } = fakeGh(defaults);
    expect(await make({ gh }).acts.armAutoMerge(arm, ctx())).toMatchObject({
      armed: false,
      merged: false,
      contractChanged: true,
    });
    expect(calls).toContain('disableAutoMerge');
    expect(calls).toContain('setStatus');
    expect(calls).not.toContain('enableAutoMerge');
    expect(calls).not.toContain('mergePr');
  });
  it('最终真实挂写前再次核验，读取期间正文修改不会用旧合同写', async () => {
    let body = BODY;
    let armed = false;
    const { gh, calls } = fakeGh({
      ...defaults,
      readPull: async () => pullFacts({ autoMerge: armed }),
      readIssue: async () => ({ number: 12, title: '需求', state: 'open', body }),
      enableAutoMerge: async () => {
        armed = true;
        body = changed;
      },
    });
    expect(await make({ gh }).acts.armAutoMerge(arm, ctx())).toMatchObject({ contractChanged: true });
    expect(calls.filter((c) => c === 'readIssue')).toHaveLength(2);
    // GitHub已接受的写无法撤回；后读发现修订，显式撤挂，不报告armed。
    expect(calls).toContain('setStatus');
    expect(calls).toContain('disableAutoMerge');
  });
  it.each(['clean-fallback', 'ci-pending-retry'])(
    '%s 每次真实直接合前核合同，不把先前读取当永久许可',
    async (path) => {
      let body = BODY;
      const { gh, calls } = fakeGh({
        ...defaults,
        readPull: async () => pullFacts({ autoMerge: false }),
        readIssue: async () => ({ number: 12, title: '需求', state: 'open', body }),
        enableAutoMerge: async () => {
          if (path === 'clean-fallback') body = changed;
          throw new Error('clean status');
        },
        mergePr: async () => {
          body = changed;
          return { merged: false, reason: 'ci_not_green', detail: '仍在跑', ciPendingOnly: true };
        },
      });
      expect(await make({ gh }).acts.armAutoMerge(arm, ctx())).toMatchObject({
        armed: false,
        merged: false,
        contractChanged: true,
      });
      expect(calls.filter((c) => c === 'mergePr')).toHaveLength(path === 'clean-fallback' ? 0 : 1);
    },
  );
  it('未知规范版本或新版缺读口不能绕过核验', async () => {
    const { gh, calls } = fakeGh(defaults);
    await expect(
      make({ gh }).acts.armAutoMerge(
        { ...arm, contractGuard: { ...guard, expected: { ...guard.expected, version: 2 } as never } },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: 'TASK_CONTRACT_UNREADABLE' });
    expect(calls).not.toContain('enableAutoMerge');
  });
  it('正式正文读失败必须先阻合再失败；撤挂失败不能冒充成功', async () => {
    const readIssue = async () => {
      throw new Error('正文读取断网');
    };
    const { gh, calls } = fakeGh({ ...defaults, readIssue });
    await expect(make({ gh }).acts.armAutoMerge(arm, ctx())).rejects.toMatchObject({
      code: 'TASK_CONTRACT_UNREADABLE',
    });
    expect(calls).toContain('disableAutoMerge');
    const failed = fakeGh({
      ...defaults,
      disableAutoMerge: async () => {
        throw new Error('撤挂未确认');
      },
    });
    await expect(make({ gh: failed.gh }).acts.armAutoMerge(arm, ctx())).rejects.toThrow('撤挂未确认');
    expect(failed.calls).not.toContain('setStatus');
  });
  it('直接合与既有等待合并读取也受相同合同限制', async () => {
    const { gh, calls } = fakeGh(defaults);
    expect(await make({ gh }).acts.mergeNow(arm, ctx())).toMatchObject({
      merged: false,
      contractChanged: true,
    });
    expect(await make({ gh }).acts.waitMerged({ ...arm, minutes: 1 }, ctx())).toEqual({
      state: 'contract_changed',
    });
    expect(calls).not.toContain('mergePr');
  });
});

describe('停法收尾活动的真实空闲核验（#3193）', () => {
  const input = {
    schemaVersion: 1 as const,
    repo: REPO,
    prNumber: 7,
    expectedHead: HEAD,
    idle: { issueNumber: 12, workflowId: 'task:acme/demo#12' },
  };
  it.each([1, -1, Number.NaN])('会话数 %s 不允许读成功回执', async (count) => {
    const { gh, calls } = fakeGh({ readPull: async () => pullFacts({ merged: true, state: 'closed' }) });
    const { acts } = make({ gh, openRunsForIssue: async () => count });
    await expect(acts.readMergedTask(input, ctx())).rejects.toMatchObject({ code: 'TASK_BUSY' });
    expect(calls).toEqual(['readPull']);
  });
  it('缺活动会话读取装配或读取失败不能默认为零', async () => {
    const { gh, calls } = fakeGh({ readPull: async () => pullFacts({ merged: true, state: 'closed' }) });
    await expect(make({ gh }).acts.readMergedTask(input, ctx())).rejects.toMatchObject({
      code: 'TASK_NOT_CONFIGURED',
    });
    await expect(
      make({
        gh,
        openRunsForIssue: async () => {
          throw new Error('DB offline');
        },
      }).acts.readMergedTask(input, ctx()),
    ).rejects.toThrow('DB offline');
    expect(calls).toEqual(['readPull', 'readPull']);
  });
  it('OPEN PR 即使有 detached 活会话也返回 null，不查 idle、不记 onlyBook', async () => {
    const { gh, calls } = fakeGh({ readPull: async () => pullFacts() });
    let counted = 0;
    const { acts } = make({
      gh,
      openRunsForIssue: async () => {
        counted++;
        return 1;
      },
    });
    expect(await acts.readMergedTask(input, ctx())).toBeNull();
    expect(counted).toBe(0);
    expect(calls).toEqual(['readPull']);
    await expect(
      acts.readMergedTask({ ...input, idle: { ...input.idle, includeOpen: true } }, ctx()),
    ).rejects.toMatchObject({ code: 'TASK_BUSY' });
    expect(counted).toBe(1);
  });
  it('确认为零才现读 PR 和真实 onlyBook 回执', async () => {
    let onlyBook: boolean | undefined;
    const { gh, calls } = fakeGh({
      readPull: async () => pullFacts({ merged: true, state: 'closed' }),
      mergePr: async (request: { onlyBook?: boolean }) => {
        onlyBook = request.onlyBook;
        return mergedOk();
      },
    });
    const { acts } = make({
      gh,
      openRunsForIssue: async (repo, issue, workflowId) => {
        expect({ repo, issue, workflowId }).toEqual({
          repo: REPO,
          issue: 12,
          workflowId: input.idle.workflowId,
        });
        return 0;
      },
    });
    expect(await acts.readMergedTask(input, ctx())).toMatchObject({
      prNumber: 7,
      head: HEAD,
      mergeCommit: 'c'.repeat(40),
    });
    expect(onlyBook).toBe(true);
    expect(calls).toEqual(['readPull', 'mergePr']);
  });
});

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
    runChildOk('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();

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
      // 相对钉住的主线新增几行（#2755 体量预算）：两个文件各一行
      addedLines: 2,
    });
  });

  it('本仓小改动不启动例外核验；当前raw读取失败抛错，不冒充老历史缺字段', async () => {
    const { dir, base } = await tree();
    writeFileSync(join(dir, 'small.ts'), 'export const small = true;\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'small');
    const real = localExec();
    const { acts } = make({
      gh: fakeGh().gh,
      exec: (command) => {
        if (command.argv.includes('merge-base') && command.argv.includes('--no-replace-objects'))
          throw new Error('小改动不应进入快照预算');
        return real(command);
      },
    });
    const readInput = { ...input(dir, base), repo: { ...REPO, owner: 'thoerwink8', name: 'fleet-dao' } };
    expect(await acts.readDelivery(readInput, ctx())).toMatchObject({ addedLines: 1 });
    const broken = make({
      gh: fakeGh().gh,
      exec: (command) =>
        command.argv.includes('--numstat')
          ? Promise.resolve({
              code: 1,
              stdout: Buffer.alloc(0),
              stderr: '真实计数失败',
              timedOut: false,
              aborted: false,
            })
          : real(command),
    }).acts;
    await expect(broken.readDelivery(readInput, ctx())).rejects.toMatchObject({ code: 'GIT_FAILED' });
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

  // #2721：近 7 天 55 轮只因开会话的钩子改了 .claude/settings.json 被判返工，会话其实提交了。
  it('一次提交、加一个被钩子改过的 settings（跟踪着的改了、没跟踪的新建了）：先还原再剔除，核对结果没有剩的', async () => {
    const { dir } = await tree();
    mkdirSync(join(dir, '.claude'));
    const original = '{\n  "env": {}\n}\n';
    writeFileSync(join(dir, '.claude', 'settings.json'), original);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'project settings');
    const repinned = git(dir, 'rev-parse', 'HEAD');
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'add a');
    // 钩子改了跟踪着的项目设置；引擎给 Mirasim 写的挡子代理设置（仓里没忽略）没跟踪
    writeFileSync(join(dir, '.claude', 'settings.json'), '{\n  "hooks": {}\n}\n');
    writeFileSync(join(dir, '.claude', 'settings.local.json'), '{}\n');
    const got = await make({ gh: fakeGh().gh }).acts.readDelivery(input(dir, repinned), ctx());
    expect(got).toMatchObject({ commits: 1, changedFiles: ['a.ts'], leftover: [] });
    // 跟踪着的还原成 HEAD 的样子；没跟踪的留着（删了 Mirasim 会话就挡不住子代理）
    // 换行按 git 的检出设置（Windows 上 autocrlf 检出成 CRLF），只比内容
    expect(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8').replaceAll('\r\n', '\n')).toBe(
      original,
    );
    expect(existsSync(join(dir, '.claude', 'settings.local.json'))).toBe(true);
    expect(git(dir, 'diff', '--ignore-cr-at-eol', '--name-only', 'HEAD')).toBe('');

    // 仓里原来没有 .claude/（git 只报一行 ?? .claude/）：钩子新建的项目设置也不算；别的没提交的照算
    const fresh = await tree('fresh');
    writeFileSync(join(fresh.dir, 'b.ts'), 'export const b = 1;\n');
    git(fresh.dir, 'add', '.');
    git(fresh.dir, 'commit', '-q', '-m', 'add b');
    mkdirSync(join(fresh.dir, '.claude'));
    writeFileSync(join(fresh.dir, '.claude', 'settings.json'), '{}\n');
    const clean = await make({ gh: fakeGh().gh }).acts.readDelivery(input(fresh.dir, fresh.base), ctx());
    expect(clean.leftover).toEqual([]);
    writeFileSync(join(fresh.dir, 'README.md'), '# changed\n');
    writeFileSync(join(fresh.dir, '.claude', 'notes.md'), 'x\n');
    const dirty = await make({ gh: fakeGh().gh }).acts.readDelivery(input(fresh.dir, fresh.base), ctx());
    expect(dirty.leftover).toEqual([' M README.md', '?? .claude/notes.md']);
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

  it('【故意造出的失败】删掉标记并 git add、没提交：MERGE_HEAD 还在，conflicts 是冲突文件名，不是占位', async () => {
    const { dir, base } = await tree('added-uncommitted');
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
    writeFileSync(join(dir, 'a.ts'), 'export const a = 3;\n');
    git(dir, 'add', '--', 'a.ts');
    expect(existsSync(join(dir, '.git', 'MERGE_HEAD'))).toBe(true);
    expect(git(dir, 'diff', '--name-only', '--diff-filter=U')).toBe('');
    const got = await make({ gh: fakeGh().gh }).acts.readDelivery(input(dir, base), ctx());
    expect(got.conflicts).toEqual(['a.ts']);
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

  /** 评审反例里的将来截止：取消不能靠「还没到点」放行。 */
  const futureDeadlines = (): Pick<PortContext, 'attemptDeadlineMs' | 'scheduleDeadlineMs'> => {
    const now = Date.now();
    return { attemptDeadlineMs: now + 600_000, scheduleDeadlineMs: now + 1_200_000 };
  };

  /** 只读先挂住，测试在挂住期间取消，再放行。entered 在开始等待时就完成，避免和取消赛跑。 */
  function holdThen<T>(value: () => T): {
    entered: Promise<void>;
    release: () => void;
    run: () => Promise<T>;
  } {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    return {
      entered,
      release: releaseGate,
      run: async () => {
        markEntered();
        await gate;
        return value();
      },
    };
  }

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

  it('期限已过：先读 PR，不再向 GitHub 发起新的挂合并', async () => {
    const f = fakeGh({
      readPull: async () => pullFacts(),
      enableAutoMerge: async () => undefined,
      mergePr: async () => mergedOk(),
    });
    const { acts } = make({ gh: f.gh });
    const past = Date.now() - 1_000;
    await expect(
      acts.armAutoMerge(
        { schemaVersion: 1, repo: REPO, prNumber: 7, expectedHead: HEAD },
        ctx({ attemptDeadlineMs: past, scheduleDeadlineMs: past }),
      ),
    ).rejects.toMatchObject({ code: 'ARM_DEADLINE_PASSED', retryable: false });
    expect(f.calls).toEqual(['readPull']);
  });

  it('期限已过但读到已经挂上：当挂上了，不再写一次', async () => {
    const f = fakeGh({
      readPull: async () => pullFacts({ autoMerge: true }),
      enableAutoMerge: async () => undefined,
    });
    const { acts } = make({ gh: f.gh });
    const past = Date.now() - 1_000;
    expect(
      await acts.armAutoMerge(
        { schemaVersion: 1, repo: REPO, prNumber: 7, expectedHead: HEAD },
        ctx({ scheduleDeadlineMs: past }),
      ),
    ).toEqual({ armed: true, merged: false });
    expect(f.calls).toEqual(['readPull']);
  });

  it('没取消、数值截止还在将来：照常挂上', async () => {
    const f = fakeGh({ readPull: async () => pullFacts(), enableAutoMerge: async () => undefined });
    const { acts } = make({ gh: f.gh });
    expect(
      await acts.armAutoMerge(
        { schemaVersion: 1, repo: REPO, prNumber: 7, expectedHead: HEAD },
        ctx(futureDeadlines()),
      ),
    ).toEqual({ armed: true, merged: false });
    expect(f.calls).toEqual(['readPull', 'enableAutoMerge']);
  });

  it('读 PR 期间被取消、数值截止还在将来：放行后不挂合并、不直接合', async () => {
    const ac = new AbortController();
    const held = holdThen(() => pullFacts());
    const f = fakeGh({
      readPull: held.run,
      enableAutoMerge: async () => undefined,
      mergePr: async () => mergedOk(),
    });
    const { acts } = make({ gh: f.gh });
    const pending = acts.armAutoMerge(
      { schemaVersion: 1, repo: REPO, prNumber: 7, expectedHead: HEAD },
      ctx({ signal: ac.signal, ...futureDeadlines() }),
    );
    await held.entered;
    ac.abort(new Error('活动已取消'));
    held.release();
    await expect(pending).rejects.toThrow('活动已取消');
    expect(ac.signal.aborted).toBe(true);
    expect(f.calls).toEqual(['readPull']);
  });

  it('读正式评审期间被取消、数值截止还在将来：放行后不挂合并、不直接合', async () => {
    const ac = new AbortController();
    const held = holdThen(() => [] as ReviewChange[]);
    const f = fakeGh({
      readPull: async () => pullFacts(),
      enableAutoMerge: async () => undefined,
      mergePr: async () => mergedOk(),
    });
    const { acts } = make({
      gh: f.gh,
      reviewChanges: held.run,
    });
    const pending = acts.armAutoMerge(
      { schemaVersion: 1, repo: REPO, prNumber: 7, expectedHead: HEAD },
      ctx({ signal: ac.signal, ...futureDeadlines() }),
    );
    await held.entered;
    ac.abort(new Error('活动已取消'));
    held.release();
    await expect(pending).rejects.toThrow('活动已取消');
    expect(ac.signal.aborted).toBe(true);
    expect(f.calls).toEqual(['readPull']);
  });

  it('挂合并返回 clean 时上下文已取消、数值截止还在将来：不再直接合', async () => {
    const ac = new AbortController();
    const f = fakeGh({
      readPull: async () => pullFacts(),
      enableAutoMerge: async () => {
        ac.abort(new Error('活动已取消'));
        throw new GitHubError('GRAPHQL_ERROR', 'Pull request is in clean status');
      },
      mergePr: async () => mergedOk(),
    });
    const { acts } = make({ gh: f.gh });
    await expect(
      acts.armAutoMerge(
        { schemaVersion: 1, repo: REPO, prNumber: 7, expectedHead: HEAD },
        ctx({ signal: ac.signal, ...futureDeadlines() }),
      ),
    ).rejects.toThrow('活动已取消');
    expect(f.calls).toEqual(['readPull', 'enableAutoMerge']);
  });

  it('现读检查期间被取消、放行后已是绿、数值截止还在将来：不再第二次直接合', async () => {
    const ac = new AbortController();
    const held = holdThen(
      (): MergeWaitChecks => ({
        overall: 'green',
        failed: [],
      }),
    );
    let merges = 0;
    const f = fakeGh({
      readPull: async () => pullFacts(),
      enableAutoMerge: async () => {
        throw new GitHubError('GRAPHQL_ERROR', 'Pull request is in clean status');
      },
      mergePr: async () => {
        merges += 1;
        return { merged: false, reason: 'ci_not_green' as const, detail: '没跑完：merge-gate' };
      },
    });
    // 第一次是挂之前的核验（绿），挂住的是 clean 之后的那次现读
    let reads = 0;
    const { acts } = make({
      gh: f.gh,
      readChecks: async () => {
        reads += 1;
        return reads === 1 ? { overall: 'green', failed: [] } : held.run();
      },
    });
    const pending = acts.armAutoMerge(
      { schemaVersion: 1, repo: REPO, prNumber: 7, expectedHead: HEAD },
      ctx({ signal: ac.signal, ...futureDeadlines() }),
    );
    await held.entered;
    ac.abort(new Error('活动已取消'));
    held.release();
    await expect(pending).rejects.toThrow('活动已取消');
    expect(merges).toBe(1);
    expect(f.calls.filter((call) => call === 'mergePr')).toHaveLength(1);
    expect(f.calls).toEqual(['readPull', 'enableAutoMerge', 'mergePr']);
  });

  it('挂合并那一下把期限用完、GitHub 说已经是 clean：不再直接合', async () => {
    const f = fakeGh({
      readPull: async () => pullFacts(),
      enableAutoMerge: async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        throw new GitHubError('GRAPHQL_ERROR', 'Pull request is in clean status');
      },
      mergePr: async () => mergedOk('e'.repeat(40), false),
    });
    const { acts } = make({ gh: f.gh });
    const deadline = Date.now() + 30;
    await expect(
      acts.armAutoMerge(
        { schemaVersion: 1, repo: REPO, prNumber: 7, expectedHead: HEAD },
        ctx({ attemptDeadlineMs: deadline, scheduleDeadlineMs: deadline }),
      ),
    ).rejects.toMatchObject({ code: 'ARM_DEADLINE_PASSED', retryable: false });
    expect(f.calls).toEqual(['readPull', 'enableAutoMerge']);
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

  const cleanButBehind = (over: Partial<Record<string, unknown>> = {}) =>
    fakeGh({
      readPull: async () => pullFacts(),
      enableAutoMerge: async () => {
        throw new GitHubError('GRAPHQL_ERROR', 'Pull request is in clean status');
      },
      mergePr: async () => ({ merged: false, reason: 'behind_main', detail: '主线比 PR 多 2 个提交' }),
      ...over,
    });
  const runWith = (gh: Gh, syncedBehind?: number) =>
    make({ gh }).acts.armAutoMerge(
      {
        schemaVersion: 1,
        repo: REPO,
        prNumber: 7,
        expectedHead: HEAD,
        ...(syncedBehind === undefined ? {} : { syncedBehind }),
      },
      ctx(),
    );

  const cleanCiRefused = (
    detail: string,
    readChecks: TaskActivitiesDeps['readChecks'],
    merge?: (n: number) => Awaited<ReturnType<Gh['mergePr']>> | Promise<Awaited<ReturnType<Gh['mergePr']>>>,
  ) => {
    let merges = 0;
    const f = cleanButBehind({
      mergePr: async () => {
        merges += 1;
        if (merge) return merge(merges);
        return { merged: false, reason: 'ci_not_green' as const, detail };
      },
    });
    const seen: string[] = [];
    let gated = false;
    const { acts } = make({
      gh: f.gh,
      readChecks: async (repo, sha) => {
        // 第一次是挂之前的核验（绿，放行去挂）；之后才是 clean 被拒之后的现读，下面的用例测的是它
        if (!gated) {
          gated = true;
          return { overall: 'green', failed: [] };
        }
        seen.push(`${repo.owner}/${repo.name}@${sha}`);
        if (!readChecks) throw new Error('测试没接上读检查');
        return readChecks(repo, sha, new AbortController().signal);
      },
    });
    return { f, acts, seen, merges: () => merges };
  };

  it('【故意造出的失败】clean 时直接合被拒、现读是真红：交 checksRed，不当成还在跑，不去同步主线', async () => {
    const { f, acts, seen } = cleanCiRefused('CI 红：check', async () => ({
      overall: 'red',
      failed: [{ name: 'check', detail: 'CI 红：check' }],
    }));
    const got = await acts.armAutoMerge(
      { schemaVersion: 1, repo: REPO, prNumber: 7, expectedHead: HEAD },
      ctx(),
    );
    expect(got).toMatchObject({
      armed: false,
      merged: false,
      checksRed: { failedChecks: ['check'], head: HEAD, detail: 'check：CI 红：check' },
    });
    expect(got.checksPending).toBeUndefined();
    expect(got.why).toContain('ci_not_green');
    expect(got.why).toContain('CI 红：check');
    expect(got.mainSyncBudgetExhausted).toBeUndefined();
    expect(got.headMoved).toBeUndefined();
    expect(f.calls).toEqual(['readPull', 'enableAutoMerge', 'mergePr']);
    expect(seen).toEqual([`${REPO.owner}/${REPO.name}@${HEAD}`]);
  });

  it('原文写着没跑完、现读却是真红：仍是 checksRed，不因为句子里有「没跑完」就去等', async () => {
    const { f, acts } = cleanCiRefused(
      'PR #7 的 CI 在 aaaaaaa 上不是全绿（没跑完：merge-gate）',
      async () => ({
        overall: 'red',
        failed: [{ name: 'merge-gate', detail: 'cold-verify 没过' }],
      }),
    );
    const got = await acts.armAutoMerge(
      { schemaVersion: 1, repo: REPO, prNumber: 7, expectedHead: HEAD },
      ctx(),
    );
    expect(got.checksPending).toBeUndefined();
    expect(got.checksRed).toMatchObject({
      failedChecks: ['merge-gate'],
      head: HEAD,
      detail: 'merge-gate：cold-verify 没过',
    });
    expect(f.calls.filter((call) => call === 'mergePr')).toHaveLength(1);
  });

  it('精确头上 merge-gate 还在跑：交 checksPending，只合这一次，不再直接合', async () => {
    const detail = 'PR #7 的 CI 在 aaaaaaa 上不是全绿（没跑完：merge-gate）';
    const { f, acts, seen } = cleanCiRefused(detail, async () => ({
      overall: 'pending',
      failed: [],
      pending: [{ name: 'merge-gate' }],
    }));
    const got = await acts.armAutoMerge(
      { schemaVersion: 1, repo: REPO, prNumber: 7, expectedHead: HEAD },
      ctx(),
    );
    expect(got).toMatchObject({
      armed: false,
      merged: false,
      checksPending: { names: ['merge-gate'], head: HEAD },
    });
    expect(got.checksPending?.detail).toContain('ci_not_green');
    expect(got.checksPending?.detail).toContain('没跑完：merge-gate');
    expect(got.checksRed).toBeUndefined();
    expect(got.headMoved).toBeUndefined();
    expect(f.calls).toEqual(['readPull', 'enableAutoMerge', 'mergePr']);
    expect(seen).toEqual([`${REPO.owner}/${REPO.name}@${HEAD}`]);
  });

  it('原文写着 CI 红、现读却是 merge-gate 还在跑：以现读为准，进入 checksPending', async () => {
    const { acts } = cleanCiRefused('CI 红：check', async () => ({
      overall: 'pending',
      failed: [],
      pending: [{ name: 'merge-gate' }],
    }));
    const got = await acts.armAutoMerge(
      { schemaVersion: 1, repo: REPO, prNumber: 7, expectedHead: HEAD },
      ctx(),
    );
    expect(got.checksPending?.names).toEqual(['merge-gate']);
    expect(got.checksRed).toBeUndefined();
  });

  it('【故意造出的失败】ci_not_green 但没有还在跑的检查名：写明没查成，不进入等待', async () => {
    const { acts } = cleanCiRefused('没跑完：merge-gate', async () => ({ overall: 'pending', failed: [] }));
    const got = await acts.armAutoMerge(
      { schemaVersion: 1, repo: REPO, prNumber: 7, expectedHead: HEAD },
      ctx(),
    );
    expect(got.checksPending).toBeUndefined();
    expect(got.checksRed).toBeUndefined();
    expect(got.why).toContain('没查成');
    expect(got.why).toContain('没跑完：merge-gate');
  });

  it('【故意造出的失败】merge-gate 在跑、cold-verify 跑完却是 stale：写明没查成和原词，不进入等待', async () => {
    const { f, acts } = cleanCiRefused('没跑完：merge-gate', async () => ({
      overall: 'pending',
      failed: [],
      unsettled: [{ name: 'cold-verify', conclusion: 'stale' }],
    }));
    const got = await acts.armAutoMerge(
      { schemaVersion: 1, repo: REPO, prNumber: 7, expectedHead: HEAD },
      ctx(),
    );
    expect(got.checksPending).toBeUndefined();
    expect(got.checksRed).toBeUndefined();
    expect(got.why).toContain('没查成');
    expect(got.why).toContain('cold-verify（stale）');
    expect(f.calls.filter((call) => call === 'mergePr')).toHaveLength(1);
  });

  it('【故意造出的失败】pending 名字和没出结论的一起给：仍按没查成，不拿在跑的那几条去等', async () => {
    const { acts } = cleanCiRefused('没跑完：merge-gate', async () => ({
      overall: 'pending',
      failed: [],
      pending: [{ name: 'merge-gate' }],
      unsettled: [{ name: 'check', conclusion: 'unknown' }],
    }));
    const got = await acts.armAutoMerge(
      { schemaVersion: 1, repo: REPO, prNumber: 7, expectedHead: HEAD },
      ctx(),
    );
    expect(got.checksPending).toBeUndefined();
    expect(got.why).toContain('check（unknown）');
  });

  it('【故意造出的失败】一个检查在跑、另一个必过检查没出现：写明没查成，不进入等待', async () => {
    const { f, acts } = cleanCiRefused('没跑完：merge-gate', async () => ({
      overall: 'pending',
      failed: [],
      pending: [{ name: 'merge-gate' }],
      missing: [{ name: 'check' }],
    }));
    const got = await acts.armAutoMerge(
      { schemaVersion: 1, repo: REPO, prNumber: 7, expectedHead: HEAD },
      ctx(),
    );
    expect(got.checksPending).toBeUndefined();
    expect(got.checksRed).toBeUndefined();
    expect(got.why).toContain('没查成');
    expect(got.why).toContain('check 没出现');
    expect(got.why).not.toContain('等检查');
    expect(f.calls.filter((call) => call === 'mergePr')).toHaveLength(1);
  });

  it('【故意造出的失败】没出现和没出结论一起给：都写进没查成，不拿在跑的去等', async () => {
    const { acts } = cleanCiRefused('没跑完：merge-gate', async () => ({
      overall: 'pending',
      failed: [],
      pending: [{ name: 'merge-gate' }],
      missing: [{ name: 'lint' }],
      unsettled: [{ name: 'check', conclusion: 'stale' }],
    }));
    const got = await acts.armAutoMerge(
      { schemaVersion: 1, repo: REPO, prNumber: 7, expectedHead: HEAD },
      ctx(),
    );
    expect(got.checksPending).toBeUndefined();
    expect(got.why).toContain('没查成');
    expect(got.why).toContain('lint 没出现');
    expect(got.why).toContain('check（stale）');
  });

  it('【故意造出的失败】真红和没出现一起给：按真红，不写成没查成', async () => {
    const { acts } = cleanCiRefused('没跑完：merge-gate', async () => ({
      overall: 'pending',
      failed: [{ name: 'check', detail: '失败' }],
      pending: [{ name: 'merge-gate' }],
      missing: [{ name: 'lint' }],
    }));
    const got = await acts.armAutoMerge(
      { schemaVersion: 1, repo: REPO, prNumber: 7, expectedHead: HEAD },
      ctx(),
    );
    expect(got.checksPending).toBeUndefined();
    expect(got.checksRed).toMatchObject({ failedChecks: ['check'], head: HEAD, detail: 'check：失败' });
    expect(got.why).not.toContain('没出现');
  });

  it('【故意造出的失败】检查一个都没出现：写明没查成，不当成还在跑', async () => {
    const { acts } = cleanCiRefused('没出现：merge-gate', async () => ({ overall: 'none', failed: [] }));
    const got = await acts.armAutoMerge(
      { schemaVersion: 1, repo: REPO, prNumber: 7, expectedHead: HEAD },
      ctx(),
    );
    expect(got.checksPending).toBeUndefined();
    expect(got.checksRed).toBeUndefined();
    expect(got.why).toContain('没查成');
    expect(got.why).toContain('none');
  });

  it('【故意造出的失败】既有还在跑的、又有点名的失败：按真红，不进入等待', async () => {
    const { f, acts } = cleanCiRefused('没跑完：merge-gate', async () => ({
      overall: 'pending',
      failed: [{ name: 'check', detail: '失败' }],
      pending: [{ name: 'merge-gate' }],
    }));
    const got = await acts.armAutoMerge(
      { schemaVersion: 1, repo: REPO, prNumber: 7, expectedHead: HEAD },
      ctx(),
    );
    expect(got.checksPending).toBeUndefined();
    expect(got.checksRed).toMatchObject({ failedChecks: ['check'], head: HEAD, detail: 'check：失败' });
    expect(f.calls.filter((call) => call === 'mergePr')).toHaveLength(1);
  });

  it('【故意造出的失败】读检查失败：写明没查成，不当成还在跑', async () => {
    const { f, acts } = cleanCiRefused('没跑完：merge-gate', async () => {
      throw new PortError('UPSTREAM_ERROR', '检查列表翻不完', { retryable: true });
    });
    const got = await acts.armAutoMerge(
      { schemaVersion: 1, repo: REPO, prNumber: 7, expectedHead: HEAD },
      ctx(),
    );
    expect(got).toMatchObject({ armed: false, merged: false });
    expect(got.checksPending).toBeUndefined();
    expect(got.why).toContain('没查成');
    expect(got.why).toContain('检查列表翻不完');
    expect(f.calls.filter((call) => call === 'mergePr')).toHaveLength(1);
  });

  it('【故意造出的失败】读检查碰到认证失败：写明没查成，不重复合', async () => {
    const { f, acts } = cleanCiRefused('没跑完：merge-gate', async () => {
      throw new GitHubError('UNAUTHORIZED', 'Bad credentials', { retryable: false });
    });
    const got = await acts.armAutoMerge(
      { schemaVersion: 1, repo: REPO, prNumber: 7, expectedHead: HEAD },
      ctx(),
    );
    expect(got.checksPending).toBeUndefined();
    expect(got.why).toContain('没查成');
    expect(got.why).toContain('Bad credentials');
    expect(f.calls.filter((call) => call === 'mergePr')).toHaveLength(1);
  });

  it('【故意造出的失败】clean 后直接合本身认证失败：抛错，不装成检查还在跑', async () => {
    const f = cleanButBehind({
      mergePr: async () => {
        throw new GitHubError('UNAUTHORIZED', 'Bad credentials', { retryable: false });
      },
    });
    await expect(run(f.gh)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(f.calls).toEqual(['readPull', 'enableAutoMerge', 'mergePr']);
  });

  it('现读已经全绿：再走一次同一个直接合，合上了就带回合并提交', async () => {
    let merges = 0;
    const f = cleanButBehind({
      mergePr: async () => {
        merges += 1;
        if (merges === 1)
          return { merged: false, reason: 'ci_not_green' as const, detail: '没跑完：merge-gate' };
        return mergedOk('e'.repeat(40), false);
      },
    });
    const { acts } = make({
      gh: f.gh,
      readChecks: async () => ({ overall: 'green', failed: [] }),
    });
    const got = await acts.armAutoMerge(
      { schemaVersion: 1, repo: REPO, prNumber: 7, expectedHead: HEAD },
      ctx(),
    );
    expect(got).toEqual({ armed: false, merged: true, mergeCommit: 'e'.repeat(40) });
    expect(merges).toBe(2);
    expect(f.calls.filter((call) => call === 'mergePr')).toHaveLength(2);
  });

  it('【故意造出的失败】连着两次现读都是绿、直接合仍被拒：不再合第三次，也不进入等待', async () => {
    let reads = 0;
    const f = cleanButBehind({
      mergePr: async () => ({ merged: false, reason: 'ci_not_green' as const, detail: '没跑完：merge-gate' }),
    });
    const { acts } = make({
      gh: f.gh,
      readChecks: async () => {
        reads += 1;
        return { overall: 'green', failed: [] } satisfies MergeWaitChecks;
      },
    });
    const got = await acts.armAutoMerge(
      { schemaVersion: 1, repo: REPO, prNumber: 7, expectedHead: HEAD },
      ctx(),
    );
    expect(got.checksPending).toBeUndefined();
    expect(got.why).toContain('读着是绿');
    expect(got.why).toContain('仍被拒');
    expect(reads).toBe(3); // 挂之前 1 次，clean 被拒后 2 次
    expect(f.calls.filter((call) => call === 'mergePr')).toHaveLength(2);
  });

  it('【故意造出的失败】正式「要求改」还挂着：不挂、不合，也不当成检查还在跑', async () => {
    const held: ReviewChange = {
      reviewId: 42,
      reviewer: 'frank',
      commitId: HEAD,
      submittedAt: '2026-10-18T00:00:00Z',
      body: '请改这里',
    };
    const f = fakeGh({ readPull: async () => pullFacts() });
    const { acts } = make({
      gh: f.gh,
      reviewChanges: async () => [held],
    });
    const got = await acts.armAutoMerge(
      { schemaVersion: 1, repo: REPO, prNumber: 7, expectedHead: HEAD },
      ctx(),
    );
    expect(got).toMatchObject({ armed: false, merged: false, reviewChanges: [held] });
    expect(got.checksPending).toBeUndefined();
    expect(got.checksRed).toBeUndefined();
    expect(f.calls).toEqual(['readPull']);
  });

  it('clean 时直接合被拒、只是合并闸没跑完（#3165）：在这一步里隔一会儿再合，合上就回合并提交，不交回去停下', async () => {
    let tries = 0;
    const f = cleanButBehind({
      mergePr: async () => {
        tries += 1;
        return tries < 3
          ? { merged: false, reason: 'ci_not_green', detail: '没跑完：merge-gate', ciPendingOnly: true }
          : mergedOk('f'.repeat(40), false);
      },
    });
    expect(await run(f.gh)).toEqual({ armed: false, merged: true, mergeCommit: 'f'.repeat(40) });
    expect(f.calls).toEqual(['readPull', 'enableAutoMerge', 'mergePr', 'mergePr', 'mergePr']);
  });

  it('【故意造出的失败】clean 时直接合被拒、有红的检查（没标 ciPendingOnly）：不等、不再合，原因原样交回', async () => {
    const f = cleanButBehind({
      mergePr: async () => ({
        merged: false,
        reason: 'ci_not_green',
        detail: '红：check；没跑完：merge-gate',
      }),
    });
    const got = await run(f.gh);
    expect(got).toMatchObject({ armed: false, merged: false });
    expect(got.why).toContain('红：check');
    expect(f.calls).toEqual(['readPull', 'enableAutoMerge', 'mergePr']);
  });

  it('【故意造出的失败】合并闸一直没跑完：最多再试 MERGE_PENDING_RETRIES 次，到点把「没跑完」交回，不当成合了', async () => {
    const f = cleanButBehind({
      mergePr: async () => ({
        merged: false,
        reason: 'ci_not_green',
        detail: '没跑完：merge-gate',
        ciPendingOnly: true,
      }),
    });
    const got = await run(f.gh);
    expect(got).toMatchObject({ armed: false, merged: false });
    expect(got.why).toContain('没跑完：merge-gate');
    expect(f.calls.filter((c) => c === 'mergePr')).toHaveLength(1 + MERGE_PENDING_RETRIES);
  });

  it('直接合被拒、因为落后主线：调一次 updateBranch 把 PR 同步到最新主线，新头当 headMoved 交回去（标明是自己同步的）', async () => {
    const NEW = 'c'.repeat(40);
    let asked: unknown;
    const f = cleanButBehind({
      updateBranch: async (input: unknown) => {
        asked = input;
        return { updated: true, head: NEW };
      },
    });
    const got = await run(f.gh);
    expect(got).toMatchObject({ armed: false, merged: false, headMoved: NEW, syncedMain: true });
    expect(got.why).toContain('第 1 次');
    expect(f.calls).toEqual(['readPull', 'enableAutoMerge', 'mergePr', 'updateBranch']);
    expect(asked).toMatchObject({
      repo: { owner: REPO.owner, name: REPO.name },
      prNumber: 7,
      expectedHead: HEAD,
    });
  });

  it('落后主线要同步时，把同一截止和取消交给 updateBranch', async () => {
    const ac = new AbortController();
    const deadlines = futureDeadlines();
    let passed: unknown;
    const f = cleanButBehind({
      updateBranch: async (_input: unknown, context: unknown) => {
        passed = context;
        return { updated: true, head: 'e'.repeat(40) };
      },
    });
    const got = await make({ gh: f.gh }).acts.armAutoMerge(
      { schemaVersion: 1, repo: REPO, prNumber: 7, expectedHead: HEAD },
      ctx({ signal: ac.signal, ...deadlines }),
    );
    expect(got).toMatchObject({ syncedMain: true, headMoved: 'e'.repeat(40) });
    expect(passed).toMatchObject({
      signal: ac.signal,
      attemptDeadlineMs: deadlines.attemptDeadlineMs,
      scheduleDeadlineMs: deadlines.scheduleDeadlineMs,
    });
  });

  it('【故意造出的失败】已经同步满 3 次还是落后：不再同步，原样交出原因，写明「连着 3 次同步主线后仍落后」', async () => {
    const f = cleanButBehind();
    const got = await runWith(f.gh, 3);
    expect(got).toMatchObject({ armed: false, merged: false });
    expect(got.why).toContain('连着 3 次同步主线后仍落后');
    expect(got.why).toContain('主线比 PR 多 2 个提交');
    expect(got.mainSyncBudgetExhausted).toEqual({ prNumber: 7, headSha: HEAD, used: 3 });
    expect(got.headMoved).toBeUndefined();
    expect(got.syncedMain).toBeUndefined();
    expect(f.calls).not.toContain('updateBranch');
    // 第 3 次还能同步（已同步 2 次）
    const again = cleanButBehind({ updateBranch: async () => ({ updated: true, head: 'd'.repeat(40) }) });
    expect(await runWith(again.gh, 2)).toMatchObject({ syncedMain: true });
  });

  it('不强制 CI 的直接合并透传精确预算耗尽身份，不再尝试同步', async () => {
    const f = cleanButBehind();
    const got = await make({ gh: f.gh }).acts.mergeNow(
      {
        schemaVersion: 1,
        repo: REPO,
        prNumber: 7,
        expectedHead: HEAD,
        syncedBehind: 3,
      },
      ctx(),
    );
    expect(got).toMatchObject({
      merged: false,
      reason: 'behind_main',
      mainSyncBudgetExhausted: { prNumber: 7, headSha: HEAD, used: 3 },
    });
    expect(f.calls).not.toContain('updateBranch');
  });

  it('【故意造出的失败】同步主线时冲突：不当成同步成了，说清原因停下（没有 headMoved）', async () => {
    const f = cleanButBehind({
      updateBranch: async () => ({
        updated: false,
        reason: 'conflict',
        detail: '和主线冲突（merge conflict）',
      }),
    });
    const got = await run(f.gh);
    expect(got).toMatchObject({ armed: false, merged: false });
    expect(got.why).toContain('同步主线没成');
    expect(got.mainSyncBudgetExhausted).toBeUndefined();
    expect(got.why).toContain('conflict');
    expect(got.headMoved).toBeUndefined();
    expect(got.syncedMain).toBeUndefined();
  });

  it('同步前 PR 的头先被别人改了：新头当 headMoved 交回去，但不标自己同步（工作流照旧停下等人看）', async () => {
    const f = cleanButBehind({
      updateBranch: async () => ({
        updated: false,
        reason: 'head_moved',
        detail: '头变了',
        head: 'e'.repeat(40),
      }),
    });
    const got = await run(f.gh);
    expect(got).toMatchObject({ armed: false, merged: false, headMoved: 'e'.repeat(40) });
    expect(got.syncedMain).toBeUndefined();
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

describe('停在合并这一步后的复核（mergeReady，#3281）', () => {
  const ready = (gh: Gh, over: Partial<TaskActivitiesDeps> = {}) =>
    make({ gh, ...over }).acts.mergeReady(
      { schemaVersion: 1, repo: REPO, prNumber: 7, expectedHead: HEAD },
      ctx(),
    );

  it('开着、头没变、没有要求改、必过检查全绿：满足；只读，不挂、不撤、不合', async () => {
    const f = fakeGh({ readPull: async () => pullFacts() });
    const got = await ready(f.gh, {
      readChecks: async () => ({ overall: 'green', failed: [] }),
      reviewChanges: async () => [],
    });
    expect(got.ready).toBe(true);
    expect(f.calls.filter((c) => c !== 'readPull')).toEqual([]);
  });

  it('已经合并了：算满足（醒来重挂时现读到已合、照常记账收尾）', async () => {
    const f = fakeGh({ readPull: async () => pullFacts({ merged: true }) });
    expect((await ready(f.gh)).ready).toBe(true);
  });

  it('【故意造出的失败】关了 / 换了头 / 挂着要求改 / 检查还在跑或红了：都不满足，写明哪一条', async () => {
    const green = { readChecks: async () => ({ overall: 'green' as const, failed: [] }) };
    const closed = await ready(fakeGh({ readPull: async () => pullFacts({ state: 'closed' }) }).gh, green);
    expect(closed).toMatchObject({ ready: false, why: expect.stringContaining('被关了') });
    const moved = await ready(
      fakeGh({ readPull: async () => pullFacts({ headSha: 'b'.repeat(40) }) }).gh,
      green,
    );
    expect(moved).toMatchObject({ ready: false, why: expect.stringContaining('头换了') });
    const held = await ready(fakeGh({ readPull: async () => pullFacts() }).gh, {
      ...green,
      reviewChanges: async () => [
        { reviewId: 1, reviewer: 'r', commitId: HEAD, body: '改一下', submittedAt: '2026-10-19T00:00:00Z' },
      ],
    });
    expect(held).toMatchObject({ ready: false, why: expect.stringContaining('要求改') });
    const running = await ready(fakeGh({ readPull: async () => pullFacts() }).gh, {
      readChecks: async () => ({ overall: 'pending', failed: [], pending: [{ name: 'merge-gate (1)' }] }),
    });
    expect(running).toMatchObject({ ready: false, why: expect.stringContaining('还在跑：merge-gate (1)') });
    const red = await ready(fakeGh({ readPull: async () => pullFacts() }).gh, {
      readChecks: async () => ({ overall: 'red', failed: [{ name: 'cold-verify' }] }),
    });
    expect(red).toMatchObject({ ready: false, why: expect.stringContaining('红：cold-verify') });
  });

  it('【故意造出的失败】读检查没接上 / 读 PR 失败：抛错，不当成满足', async () => {
    await expect(
      ready(fakeGh({ readPull: async () => pullFacts() }).gh, { readChecks: undefined }),
    ).rejects.toThrow('没接上读检查');
    await expect(
      ready(
        fakeGh({
          readPull: async () => {
            throw new GitHubError('UPSTREAM_ERROR', 'GitHub 502', { retryable: true });
          },
        }).gh,
      ),
    ).rejects.toThrow('502');
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

  it('挂着自动合并、PR 和主线冲突（mergeable=dirty）：当场回 conflict，不干等到超时（#1838：#1824 卡了 7 小时 45 分）', async () => {
    let n = 0;
    const f = fakeGh({
      readPull: async () => {
        n += 1;
        return pullFacts({ autoMerge: true, mergeable: false, mergeableState: 'dirty' });
      },
    });
    const got = await wait(f.gh);
    expect(got.state).toBe('conflict');
    expect(got).toMatchObject({ state: 'conflict', detail: expect.stringContaining('和主线冲突') });
    expect(n).toBe(1); // 第一次看就回，不接着轮询
  });

  it('GitHub 只说不能合（mergeable=false）、细分状态没给：一样回 conflict，不干等', async () => {
    // mergeable=false 就是「合不了」（github 包的 mergePr / waitCi 也这么判）：细分状态认不出时不能当「还在排队」接着等
    const f = fakeGh({
      readPull: async () => pullFacts({ autoMerge: true, mergeable: false, mergeableState: 'unknown' }),
    });
    expect(await wait(f.gh)).toMatchObject({ state: 'conflict' });
  });

  it('挂着自动合并、必过检查转红：当场回 checks_red（检查名和原因），不干等到长轮询时限（#1983）', async () => {
    let clock = 0;
    let reads = 0;
    const f = fakeGh({
      readPull: async () => pullFacts({ autoMerge: true, mergeable: true, mergeableState: 'blocked' }),
    });
    const got = await wait(
      f.gh,
      {
        now: () => new Date(clock),
        sleep: async (ms) => {
          clock += ms * 1000;
        },
        readChecks: async () => {
          reads += 1;
          return { overall: 'red', failed: [{ name: 'merge-gate', detail: 'cold-verify 没过' }] };
        },
      },
      ctx(),
      15,
    );
    expect(got).toMatchObject({
      state: 'checks_red',
      failedChecks: ['merge-gate'],
      detail: expect.stringContaining('cold-verify 没过'),
    });
    expect(reads).toBe(1);
    expect(clock).toBe(0);
  });

  it('必过检查没出现：当场报没查成，不接着轮询', async () => {
    let reads = 0;
    let slept = 0;
    const f = fakeGh({
      readPull: async () => pullFacts({ autoMerge: true, mergeable: true, mergeableState: 'blocked' }),
    });
    const got = await wait(f.gh, {
      sleep: async () => {
        slept += 1;
      },
      readChecks: async () => {
        reads += 1;
        return {
          overall: 'pending',
          failed: [],
          missing: [{ name: 'merge-gate' }],
          pending: [{ name: 'lint' }],
        };
      },
    });
    expect(got).toMatchObject({
      state: 'checks_unreadable',
      detail: expect.stringContaining('必过检查没查成'),
    });
    expect(got.state === 'checks_unreadable' ? got.detail : '').toContain('merge-gate 没出现');
    expect(reads).toBe(1);
    expect(slept).toBe(0);
  });

  it('检查没出结论：当场报没查成，不接着轮询', async () => {
    let reads = 0;
    const f = fakeGh({ readPull: async () => pullFacts({ autoMerge: true }) });
    const got = await wait(f.gh, {
      readChecks: async () => {
        reads += 1;
        return {
          overall: 'pending',
          failed: [],
          unsettled: [{ name: 'cold-verify', conclusion: 'stale' }],
        };
      },
    });
    expect(got.state).toBe('checks_unreadable');
    if (got.state === 'checks_unreadable') {
      expect(got.detail).toContain('cold-verify（stale）');
      expect(got.detail).toContain('没查成');
    }
    expect(reads).toBe(1);
  });

  it('【故意造出的失败】会接着等、却没接上读检查：抛错，不回 waiting', async () => {
    let clock = 0;
    const f = fakeGh({
      readPull: async () => pullFacts({ autoMerge: true, mergeable: true, mergeableState: 'blocked' }),
    });
    await expect(
      wait(
        f.gh,
        {
          now: () => new Date(clock),
          sleep: async (ms) => {
            clock += ms * 1000;
          },
          readChecks: undefined,
        },
        ctx(),
        1,
      ),
    ).rejects.toMatchObject({ code: 'MERGE_CHECKS_UNWIRED' });
    expect(clock).toBe(0);
  });

  it('等必过检查（mergeable_state=blocked、mergeable=true）：仍是 waiting，不当成冲突（#1838 别把排队当冲突）', async () => {
    let clock = 0;
    const f = fakeGh({
      readPull: async () => pullFacts({ autoMerge: true, mergeable: true, mergeableState: 'blocked' }),
    });
    const got = await wait(f.gh, {
      now: () => new Date(clock),
      sleep: async (ms) => {
        clock += ms * 1000;
      },
    });
    expect(got).toMatchObject({ state: 'waiting' });
    expect(f.calls.filter((c) => c === 'readPull').length).toBeGreaterThan(1);
  });

  it('GitHub 还没算完（mergeable=null）：仍是 waiting，不猜成冲突', async () => {
    let clock = 0;
    const f = fakeGh({
      readPull: async () => pullFacts({ autoMerge: true, mergeable: null, mergeableState: 'unknown' }),
    });
    const got = await wait(f.gh, {
      now: () => new Date(clock),
      sleep: async (ms) => {
        clock += ms * 1000;
      },
    });
    expect(got).toMatchObject({ state: 'waiting' });
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

describe('挂自动合并：enablePullRequestAutoMerge 的 unstable 临时拒绝（#3198，真 enableAutoMerge + 原样 GitHub errors）', () => {
  /** #3198 事件 254 的原样 errors。 */
  const unstable = {
    type: 'UNPROCESSABLE',
    path: ['enablePullRequestAutoMerge'],
    message: 'Pull request Pull request is in unstable status',
  };
  const green: MergeWaitChecks = { overall: 'green', failed: [] };
  const pullJson = (pull: ReturnType<typeof pullFacts>) => ({
    number: 7,
    node_id: 'PR_7',
    html_url: 'https://github.test/acme/widgets/pulls/7',
    state: pull.state,
    title: pull.title,
    body: pull.body,
    draft: pull.draft,
    merged: pull.merged,
    merged_at: null,
    merge_commit_sha: null,
    mergeable: pull.mergeable,
    mergeable_state: pull.mergeableState,
    user: null,
    merged_by: null,
    head: { ref: pull.headRef, sha: pull.headSha, repo: { full_name: 'acme/widgets' } },
    base: { ref: 'main', sha: 'b'.repeat(40), repo: { full_name: 'acme/widgets' } },
    updated_at: '2026-10-19T00:00:00Z',
    auto_merge: pull.autoMerge ? { merge_method: 'squash' } : null,
  });
  /**
   * 一次活动调度：replies 按次序回 graphql（null = 挂成功，数组 = 原样 errors，用尽后一直回最后一个），
   * pulls 按次序给每次重入现读到的 PR。attempt(n) 模拟 Temporal 第 n 次尝试重入同一个活动。
   */
  function arm(
    replies: (unknown[] | null)[],
    opts: {
      pulls?: ReturnType<typeof pullFacts>[];
      readChecks?: TaskActivitiesDeps['readChecks'];
      mergePr?: () => Promise<ReturnType<typeof mergedOk>>;
    } = {},
  ) {
    const real = setupHttp();
    const pulls = opts.pulls ?? [pullFacts()];
    real.fake.before.push((r) =>
      r.path === '/repos/acme/widgets/pulls/7' ? httpJson(200, pullJson(pulls[0]!)) : undefined,
    );
    let sent = 0;
    real.fake.before.push((r) => {
      if (r.path !== '/graphql') return undefined;
      const reply = replies[Math.min(sent, replies.length - 1)];
      sent += 1;
      return reply === null
        ? httpJson(200, {
            data: {
              enablePullRequestAutoMerge: {
                pullRequest: {
                  id: 'PR_7',
                  number: 7,
                  autoMergeRequest: {
                    commitHeadline: 't (#7)',
                    commitBody: '由 fleet 引擎经合并队列 squash 合并（PR #7）。',
                    mergeMethod: 'SQUASH',
                  },
                },
              },
            },
          })
        : httpJson(200, { data: { enablePullRequestAutoMerge: null }, errors: reply });
    });
    let reads = 0;
    let merges = 0;
    const f = fakeGh({
      readPull: async () => pulls[Math.min(reads++, pulls.length - 1)],
      mergePr: async () => {
        merges += 1;
        return opts.mergePr ? opts.mergePr() : mergedOk();
      },
    });
    (f.gh.claims as { enableAutoMerge: unknown }).enableAutoMerge = real.gh.claims.enableAutoMerge;
    const { acts } = make({
      gh: f.gh,
      readChecks: 'readChecks' in opts ? opts.readChecks : async () => green,
    });
    const attempt = (n: number, over: Partial<PortContext> = {}) =>
      acts.armAutoMerge(
        // 受控 HTTP 夹具只认 acme/widgets
        { schemaVersion: 1, repo: { ...REPO, name: 'widgets' }, prNumber: 7, expectedHead: HEAD },
        ctx({ attempt: n, ...over }),
      );
    return { attempt, sent: () => sent, reads: () => reads, merges: () => merges };
  }

  // #3281：unstable 是「必过检查已满足、只是非必过的还在跑或红了」，PR 现在就能合，和 clean 一样没东西可等。
  // 走同一条直接合（mergePr 只核必过检查、头、不落后主线），不再交活动重试、重试完停下等人（#3208、#3257）。
  it('unstable：不抛、不重试，直接合上；只挂了一次', async () => {
    const a = arm([[unstable]]);
    expect(await a.attempt(1)).toMatchObject({ armed: false, merged: true });
    expect([a.sent(), a.merges()]).toEqual([1, 1]);
  });

  it('unstable、非必过检查红而必过检查绿：照样直接合上', async () => {
    const a = arm([[unstable]], {
      readChecks: async () => ({ overall: 'green', failed: [] }),
    });
    expect(await a.attempt(1)).toMatchObject({ merged: true });
    expect(a.merges()).toBe(1);
  });

  it.each([
    ['别的 path', [{ ...unstable, path: ['disablePullRequestAutoMerge'] }], 'GRAPHQL_ERROR'],
    ['别的 type', [{ ...unstable, type: 'STALE_DATA' }], 'GRAPHQL_ERROR'],
    ['只带 unstable 子串', [{ ...unstable, message: 'Merge queue is unstable' }], 'GRAPHQL_ERROR'],
    ['混合多条 errors', [unstable, { ...unstable, message: 'Auto merge is not allowed' }], 'GRAPHQL_ERROR'],
    [
      '权限拒绝',
      [{ type: 'FORBIDDEN', path: unstable.path, message: 'Resource not accessible by integration' }],
      'FORBIDDEN',
    ],
    [
      '策略拒绝',
      [{ ...unstable, message: 'Auto merge is not allowed for this repository' }],
      'GRAPHQL_ERROR',
    ],
  ])('%s：原样抛、不可重试，转成活动失败也是 nonRetryable', async (_name, errors, code) => {
    const a = arm([errors]);
    const err = await a.attempt(1).catch((e: unknown) => e);
    expect(err).toMatchObject({ code, retryable: false });
    expect(toActivityFailure(err)).toMatchObject({ type: code, nonRetryable: true });
    expect(a.sent()).toBe(1);
  });

  it('现读到已关 / 草稿 / 换头：各自明确结果，不写', async () => {
    const cases = [
      { pull: pullFacts({ state: 'closed' }), want: { armed: false, merged: false, why: 'PR #7 已经关了' } },
      { pull: { ...pullFacts(), draft: true }, want: { armed: false, why: expect.stringContaining('草稿') } },
      { pull: pullFacts({ headSha: 'b'.repeat(40) }), want: { armed: false, headMoved: 'b'.repeat(40) } },
    ];
    for (const c of cases) {
      const a = arm([[unstable]], { pulls: [c.pull] });
      expect(await a.attempt(2)).toMatchObject(c.want);
      expect([a.sent(), a.merges()]).toEqual([0, 0]);
    }
  });

  it('上一次结果未知、重入时现读到已挂上：照实回报，不再写', async () => {
    const armed = arm([[unstable]], { pulls: [pullFacts({ autoMerge: true })] });
    expect(await armed.attempt(2)).toEqual({ armed: true, merged: false });
    expect([armed.sent(), armed.merges()]).toEqual([0, 0]);
  });

  it('已取消 / 期限已过：不写', async () => {
    const cancelled = arm([[unstable]]);
    const ac = new AbortController();
    ac.abort(new Error('活动已取消'));
    await expect(
      cancelled.attempt(2, { signal: ac.signal, attemptDeadlineMs: Date.now() + 600_000 }),
    ).rejects.toThrow('活动已取消');
    expect([cancelled.sent(), cancelled.merges()]).toEqual([0, 0]);

    const late = arm([[unstable]]);
    await expect(late.attempt(2, { attemptDeadlineMs: Date.now() - 1 })).rejects.toMatchObject({
      code: 'ARM_DEADLINE_PASSED',
      retryable: false,
    });
    expect([late.sent(), late.merges()]).toEqual([0, 0]);
  });

  describe('每次挂之前现读必过检查：真红不写', () => {
    it('首次挂之前就是真红：交 checksRed，一次都不写', async () => {
      const a = arm([null], {
        readChecks: async () => ({ overall: 'red', failed: [{ name: 'check', detail: '挂了' }] }),
      });
      expect(await a.attempt(1)).toMatchObject({
        armed: false,
        merged: false,
        checksRed: { failedChecks: ['check'], head: HEAD, detail: 'check：挂了' },
      });
      expect(a.sent()).toBe(0);
    });

    it('有点名的失败、旁边还有在跑的：按真红，不写', async () => {
      const a = arm([null], {
        readChecks: async () => ({
          overall: 'pending',
          failed: [{ name: 'check', detail: '失败' }],
          pending: [{ name: 'merge-gate' }],
        }),
      });
      expect(await a.attempt(1)).toMatchObject({ armed: false, checksRed: { failedChecks: ['check'] } });
      expect(a.sent()).toBe(0);
    });

    it('读检查失败：照抛、不写；没接上读检查：明说没挂、不写', async () => {
      const broken = arm([null], {
        readChecks: async () => {
          throw new GitHubError('UPSTREAM_ERROR', '读检查 500', { retryable: true });
        },
      });
      await expect(broken.attempt(1)).rejects.toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true });
      expect(broken.sent()).toBe(0);

      const unwired = arm([null], { readChecks: undefined });
      expect(await unwired.attempt(1)).toMatchObject({
        armed: false,
        why: expect.stringContaining('没接上读检查'),
      });
      expect(unwired.sent()).toBe(0);
    });

    it('还在跑 / 没出现不拦：照常挂（自动合并本来就是等它们）', async () => {
      const a = arm([null], {
        readChecks: async () => ({
          overall: 'pending',
          failed: [],
          pending: [{ name: 'merge-gate' }],
          missing: [{ name: 'cold-verify' }],
        }),
      });
      expect(await a.attempt(1)).toEqual({ armed: true, merged: false });
      expect(a.sent()).toBe(1);
    });
  });
});
