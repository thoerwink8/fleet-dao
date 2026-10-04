// 分支体检（branch-hygiene.ts）：用假的 GitHub 和假的内容跑判法、删、巡检单。每一档一个该判进来的例子和一个不该的；
// 读不到、认不出、删失败的每一条故意造出来，断言是「没查成」或「删失败」、一条没误删。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ContentFacts, MainIndex } from '../src/branch-git.ts';
import {
  ASK_DAYS,
  BOARD_MARKER,
  type BranchCase,
  branchHygiene,
  type HygieneDeps,
  issueNumberIn,
  judge,
  MARK,
  mentionPattern,
  parseBoard,
  renderBoard,
  STALE_DAYS,
} from '../src/branch-hygiene.ts';
import type { BranchActivity, OpenThread, PlanIssue, PullHead, RemoteBranch } from '../src/github-api.ts';

const NOW = new Date('2026-10-20T00:00:00Z');
const DAY = 24 * 3_600_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const sha = (c: string) => c.repeat(40);
const REPO = 'o/r';

function facts(extra: Partial<ContentFacts> = {}): ContentFacts {
  return {
    headDate: ago(30),
    headSubject: '做了点事',
    ahead: 1,
    behind: 5,
    authors: ['o'],
    coAuthors: [],
    output: { kind: 'some', changed: 1, files: ['x.ts'] },
    ...extra,
  };
}

function bcase(extra: Partial<BranchCase> = {}): BranchCase {
  return {
    branch: { name: 'feat/x', sha: sha('a'), protected: false },
    isDefault: false,
    openHeadPrs: [],
    openBasePrs: [],
    mergedExact: undefined,
    mergedOther: [],
    closedPrs: [],
    mentions: [],
    decision: undefined,
    content: facts(),
    activity: [],
    ...extra,
  };
}

describe('分支体检：判法（一条分支从上往下，命中就停）', () => {
  it('默认分支、受保护的：留', () => {
    expect(judge(bcase({ isDefault: true }), NOW)).toMatchObject({ kind: 'keep', why: '默认分支' });
    expect(judge(bcase({ branch: { name: 'x', sha: sha('a'), protected: true } }), NOW)).toMatchObject({
      kind: 'keep',
      why: '受保护的分支',
    });
  });

  it('开着的 PR 的头、开着的 PR 以它为目标分支：留；勾了删也不删（删了会把 PR 关掉），写明', () => {
    expect(judge(bcase({ openHeadPrs: [7] }), NOW)).toMatchObject({
      kind: 'keep',
      why: '开着的 PR #7 的分支',
    });
    expect(judge(bcase({ openBasePrs: [8] }), NOW)).toMatchObject({ kind: 'keep' });
    const v = judge(bcase({ openHeadPrs: [7], decision: { action: 'delete', sha: sha('a') } }), NOW);
    expect(v.kind).toBe('keep');
    expect(v.why).toContain('勾了删，但删了会把 PR 关掉，没删');
  });

  it('巡检单上勾了删、勾的就是现在的头：删（人定的），连被单子提到的也删', () => {
    const v = judge(
      bcase({ decision: { action: 'delete', sha: sha('a') }, mentions: [{ number: 5, isPr: false }] }),
      NOW,
    );
    expect(v).toMatchObject({ kind: 'delete', byFounder: true });
  });

  it('勾的是旧的头（分支后来又动过）：不算数，重新判，理由里写明', () => {
    const v = judge(bcase({ decision: { action: 'delete', sha: sha('b') } }), NOW);
    expect(v.kind).toBe('ask');
    expect(v.why).toContain('巡检单上勾过删，那时的头是 bbbbbbb，后来分支又动过，重新判');
  });

  it('巡检单上勾了留：留，不再问', () => {
    expect(judge(bcase({ decision: { action: 'keep', sha: sha('a') } }), NOW)).toMatchObject({
      kind: 'keep',
    });
  });

  it('开着的单或 PR 提到它：留', () => {
    expect(
      judge(
        bcase({
          mentions: [
            { number: 9, isPr: false },
            { number: 10, isPr: true },
          ],
        }),
        NOW,
      ),
    ).toEqual({
      kind: 'keep',
      why: '开着的 #9、PR #10 提到它',
    });
  });

  it('有已合并的 PR、头就是合并时的 PR 头：删（决定 0009），不用看内容', () => {
    const v = judge(bcase({ mergedExact: 3, content: undefined, activity: undefined }), NOW);
    expect(v).toMatchObject({ kind: 'delete', byFounder: false });
    expect(v.why).toContain('#3');
  });

  it(`没产出、满 ${STALE_DAYS} 天没动静：删；不满：留`, () => {
    const none = { kind: 'none' as const, changed: 0 };
    expect(judge(bcase({ content: facts({ output: none }) }), NOW)).toMatchObject({
      kind: 'delete',
      byFounder: false,
    });
    const fresh = facts({ output: none, headDate: ago(STALE_DAYS - 1) });
    expect(judge(bcase({ content: fresh }), NOW)).toMatchObject({ kind: 'keep' });
  });

  it('最后动静取提交时间和推送时间里晚的：旧提交刚被推上来，不算放下了', () => {
    const none = { kind: 'none' as const, changed: 0 };
    const pushed: BranchActivity[] = [{ timestamp: ago(1), type: 'push', actor: 'o' }];
    expect(judge(bcase({ content: facts({ output: none }), activity: pushed }), NOW).kind).toBe('keep');
    // 删分支的动态不算「有人在动它」
    const deleted: BranchActivity[] = [{ timestamp: ago(1), type: 'branch_deletion', actor: 'o' }];
    expect(judge(bcase({ content: facts({ output: none }), activity: deleted }), NOW).kind).toBe('delete');
  });

  it(`有产出、满 ${ASK_DAYS} 天：等人定，理由带产出、PR、最后一次提交；不满：留（还在做）`, () => {
    const v = judge(bcase({ closedPrs: [{ number: 4, headSha: sha('a') }] }), NOW);
    expect(v.kind).toBe('ask');
    expect(v.why).toContain('主线上没有的改动 1 个文件（`x.ts`）');
    expect(v.why).toContain('关掉没合的 PR #4（删了能在 #4 页面点 Restore branch 恢复）');
    expect(v.why).toContain('最后一次提交「做了点事」');
    expect(judge(bcase({ content: facts({ headDate: ago(ASK_DAYS - 1) }) }), NOW).kind).toBe('keep');
  });

  it('和主线没有共同祖先：等人定（判不了），不当成没产出', () => {
    const v = judge(bcase({ content: facts({ output: { kind: 'unrelated' } }) }), NOW);
    expect(v.kind).toBe('ask');
    expect(v.why).toContain('判不了');
  });

  it('内容或动态读不到：没查成，不删也不问', () => {
    expect(judge(bcase({ content: { error: '本地没有提交' } }), NOW)).toMatchObject({ kind: 'unknown' });
    expect(judge(bcase({ activity: { error: 'GitHub 回了 502' } }), NOW)).toMatchObject({ kind: 'unknown' });
    expect(judge(bcase({ content: undefined }), NOW)).toMatchObject({ kind: 'unknown' });
  });
});

describe('分支体检：认分支名', () => {
  it('提到：整段匹配；更长的分支名、文件名里含着它不算', () => {
    const p = mentionPattern('exp/test');
    expect(p.test('分支 `exp/test` 留着')).toBe(true);
    expect(p.test('见 exp/test。')).toBe(true);
    expect(p.test('https://github.com/o/r/compare/main...exp/test')).toBe(true);
    expect(p.test('exp/test-graph')).toBe(false);
    expect(p.test('exp/test/more')).toBe(false);
    expect(p.test('myexp/test')).toBe(false);
    expect(p.test('exp/test.md')).toBe(false);
    expect(mentionPattern('a.b+c').test('a-b+c')).toBe(false);
  });

  it('分支名里像单号的数：日期不算', () => {
    expect(issueNumberIn('fleet/292-f3f3472d3')).toBe(292);
    expect(issueNumberIn('feat/554-3-tier')).toBe(554);
    expect(issueNumberIn('wip/feat/266-grok-host')).toBe(266);
    expect(issueNumberIn('notes/requirements-2026-09-30')).toBeUndefined();
    expect(issueNumberIn('docs/progress-2026-10-02-1040')).toBeUndefined();
    expect(issueNumberIn('worktree-agent-a22d28a53b8ee8bab')).toBeUndefined();
  });
});

describe('分支体检：巡检单正文', () => {
  it('写出来的勾选框勾上以后读得回：删、留各对哪个头；同一个头两个都勾了不算数', () => {
    const body = renderBoard({
      reports: [
        {
          name: 'exp/a',
          sha: sha('a'),
          verdict: { kind: 'ask', why: '有产出' },
          who: 'o',
          decision: undefined,
        },
        {
          name: 'x`y',
          sha: sha('b'),
          verdict: { kind: 'ask', why: '有产出' },
          who: 'o',
          decision: undefined,
        },
      ],
      deleted: [],
      failed: [],
      skipped: [],
      conflicts: [],
      now: NOW,
    });
    expect(body.startsWith(BOARD_MARKER)).toBe(true);
    expect(parseBoard(body).decisions.size).toBe(0);
    expect([...parseBoard(body).listed].sort()).toEqual(['exp/a', 'x`y']);
    const lines = body.split('\n');
    const tick = (word: string, name: string) => {
      const i = lines.findIndex((l) => l.includes(`${MARK} ${word} ${encodeURIComponent(name)} `));
      lines[i] = (lines[i] ?? '').replace('[ ]', '[x]');
    };
    tick('delete', 'exp/a');
    tick('keep', 'x`y');
    tick('delete', 'x`y');
    const parsed = parseBoard(lines.join('\n'));
    expect(parsed.decisions.get('exp/a')).toEqual({ action: 'delete', sha: sha('a') });
    expect(parsed.decisions.has('x`y')).toBe(false);
    expect(parsed.conflicts).toEqual(['x`y']);
  });

  it('没带记号的勾选行、记号坏了的行：不算数', () => {
    const body = [
      '- [x] 删 exp/a',
      `- [x] 删 <!-- ${MARK} delete %E0%A4%A ${sha('a')} -->`,
      `- [x] 删 <!-- ${MARK} delete exp%2Fa 1234 -->`,
    ].join('\n');
    expect(parseBoard(body).decisions.size).toBe(0);
  });
});

// ---- 整轮：假的 GitHub、假的内容
interface World {
  defaultBranch: string;
  branches: RemoteBranch[];
  pulls: PullHead[];
  threads: OpenThread[];
  activity: Record<string, BranchActivity[]>;
  /** 删之前回读的头；没写就是 branches 里的。 */
  heads?: Record<string, string | undefined>;
  issues?: Record<number, PlanIssue>;
  content: Record<string, ContentFacts>;
}

type FailKey =
  | 'defaultBranch'
  | 'branches'
  | 'pulls'
  | 'openThreads'
  | 'activity'
  | 'branchHead'
  | 'deleteBranch'
  | 'createIssue'
  | 'updateIssueBody'
  | 'comment'
  | 'index';

function run(
  w: World,
  opts: { delete?: boolean; board?: boolean; fail?: Partial<Record<FailKey, Error>> } = {},
) {
  const calls = {
    deleted: [] as string[],
    created: [] as { title: string; body: string; labels: string[] }[],
    updated: [] as { n: number; body: string }[],
    comments: [] as { n: number; body: string }[],
  };
  const fail = opts.fail ?? {};
  const boom = (k: FailKey) => {
    const e = fail[k];
    if (e) throw e;
  };
  const gh: HygieneDeps['gh'] = {
    async defaultBranch() {
      boom('defaultBranch');
      return w.defaultBranch;
    },
    async branches() {
      boom('branches');
      return w.branches;
    },
    async pulls() {
      boom('pulls');
      return w.pulls;
    },
    async openThreads() {
      boom('openThreads');
      return w.threads;
    },
    async activity(b) {
      boom('activity');
      return w.activity[b] ?? [];
    },
    async branchHead(b) {
      boom('branchHead');
      if (w.heads && b in w.heads) return w.heads[b];
      return w.branches.find((x) => x.name === b)?.sha;
    },
    async deleteBranch(b) {
      boom('deleteBranch');
      calls.deleted.push(b);
      return true;
    },
    async createIssue(title, body, labels) {
      boom('createIssue');
      calls.created.push({ title, body, labels });
      return 900;
    },
    async updateIssueBody(n, body) {
      boom('updateIssueBody');
      calls.updated.push({ n, body });
    },
    async comments() {
      return [];
    },
    async comment(n, body) {
      boom('comment');
      calls.comments.push({ n, body });
    },
    async issue(n) {
      return w.issues?.[n];
    },
  };
  const index: MainIndex = { sha: sha('m'), current: new Map(), history: new Set() };
  const deps: HygieneDeps = {
    gh,
    git: () => {
      throw new Error('测试里不该跑 git');
    },
    repo: REPO,
    now: NOW,
    facts: {
      index() {
        boom('index');
        return index;
      },
      content(_idx, head) {
        const f = Object.entries(w.content).find(
          ([name]) => w.branches.find((b) => b.name === name)?.sha === head,
        );
        if (!f) throw new Error(`本地没有提交 ${head.slice(0, 9)}`);
        return f[1];
      },
    },
  };
  return {
    promise: branchHygiene(deps, { delete: opts.delete ?? false, board: opts.board ?? false }),
    calls,
  };
}

const pr = (n: number, extra: Partial<PullHead>): PullHead => ({
  number: n,
  state: 'closed',
  merged: false,
  headRef: 'x',
  headSha: sha('0'),
  headRepo: REPO,
  baseRef: 'main',
  ...extra,
});
const thread = (n: number, body: string, comments: string[] = [], isPr = false): OpenThread => ({
  number: n,
  isPr,
  title: `单 ${n}`,
  body,
  comments,
});

/** 一份齐全的：每一档各一条。 */
function world(): World {
  const none = { kind: 'none' as const, changed: 0 };
  return {
    defaultBranch: 'main',
    branches: [
      { name: 'main', sha: sha('m'), protected: true },
      { name: 'merged', sha: sha('1'), protected: false },
      { name: 'open-pr', sha: sha('2'), protected: false },
      { name: 'mentioned', sha: sha('3'), protected: false },
      { name: 'empty-old', sha: sha('4'), protected: false },
      { name: 'empty-new', sha: sha('5'), protected: false },
      { name: 'output-old', sha: sha('6'), protected: false },
      { name: 'output-new', sha: sha('7'), protected: false },
      { name: 'fleet/292-f3f3472d3', sha: sha('8'), protected: false },
    ],
    pulls: [
      pr(11, { merged: true, headRef: 'merged', headSha: sha('1') }),
      pr(12, { state: 'open', headRef: 'open-pr', headSha: sha('2') }),
      // fork 来的同名分支的 PR 不算本仓这条分支的 PR
      pr(13, { state: 'open', headRef: 'output-old', headSha: sha('6'), headRepo: 'fork/r' }),
    ],
    threads: [
      thread(20, '这张单要用分支 mentioned 上的东西'),
      // 带体检记号的清单不算提到
      thread(21, '清单', [`<!-- ${MARK} -->\n- \`output-old\``]),
    ],
    activity: {},
    issues: {
      292: {
        number: 292,
        title: '外部看门狗',
        state: 'closed',
        isPr: false,
        createdAt: ago(40),
        labels: [],
        milestone: null,
        stateReason: 'completed',
        subIssues: 0,
      },
    },
    content: {
      'empty-old': facts({ output: none }),
      'empty-new': facts({ output: none, headDate: ago(1) }),
      'output-old': facts(),
      'output-new': facts({ headDate: ago(1) }),
      'fleet/292-f3f3472d3': facts({ authors: ['fleet-dao-agent[bot]'] }),
    },
  };
}

const kinds = (r: Awaited<ReturnType<typeof run>['promise']>) =>
  Object.fromEntries(r.reports.map((x) => [x.name, x.verdict.kind]));

describe('分支体检：整轮', () => {
  it('每一档各判进来；不带 --delete 一条不删、不带 --board 不碰单子', async () => {
    const { promise, calls } = run(world());
    const r = await promise;
    expect(kinds(r)).toEqual({
      'empty-new': 'keep',
      'empty-old': 'delete',
      'fleet/292-f3f3472d3': 'ask',
      main: 'keep',
      mentioned: 'keep',
      merged: 'delete',
      'open-pr': 'keep',
      'output-new': 'keep',
      'output-old': 'ask',
    });
    expect(r.notQueried).toEqual([]);
    expect(calls.deleted).toEqual([]);
    expect(calls.created).toEqual([]);
    const fleet = r.reports.find((x) => x.name === 'fleet/292-f3f3472d3');
    expect(fleet?.verdict.why).toContain('名字里的 #292 是单「外部看门狗」，已关');
    expect(fleet?.who).toContain('法国引擎（Fusion，旧流程）');
  });

  it('--delete：只删判了删的；删之前再读一次头', async () => {
    const { promise, calls } = run(world(), { delete: true });
    const r = await promise;
    expect(calls.deleted.sort()).toEqual(['empty-old', 'merged']);
    expect(r.deleted.sort()).toEqual(['empty-old', 'merged']);
  });

  it('判完到删之间头变了：不删，下一轮重判；删的时候已经不在了：记「已不在」', async () => {
    const w = world();
    w.heads = { merged: sha('9'), 'empty-old': undefined };
    const { promise, calls } = run(w, { delete: true });
    const r = await promise;
    expect(calls.deleted).toEqual([]);
    expect(r.skipped).toEqual([{ name: 'merged', why: expect.stringContaining('没删，下一轮重判') }]);
    expect(r.gone).toEqual(['empty-old']);
  });

  it('一条删失败：记下来、接着删别的，不当成删了', async () => {
    const { promise } = run(world(), { delete: true, fail: { deleteBranch: new Error('GitHub 回了 500') } });
    const r = await promise;
    expect(r.deleted).toEqual([]);
    expect(r.failed.map((f) => f.name).sort()).toEqual(['empty-old', 'merged']);
  });

  for (const key of ['defaultBranch', 'branches', 'pulls', 'openThreads'] as const) {
    it(`整份清单读不到（${key}）：没查成，一条没判、一条没删、单子没碰`, async () => {
      const { promise, calls } = run(world(), {
        delete: true,
        board: true,
        fail: { [key]: new Error('连不上 GitHub') },
      });
      const r = await promise;
      expect(r.reports).toEqual([]);
      expect(r.notQueried).toEqual([expect.stringContaining('读不到 GitHub（连不上 GitHub）')]);
      expect(calls.deleted).toEqual([]);
      expect(calls.created).toEqual([]);
    });
  }

  it('读回来的分支里没有默认分支：认不出，一条没判', async () => {
    const w = world();
    w.branches = w.branches.filter((b) => b.name !== 'main');
    const { promise, calls } = run(w, { delete: true });
    const r = await promise;
    expect(r.notQueried).toEqual([expect.stringContaining('没有默认分支 main')]);
    expect(calls.deleted).toEqual([]);
  });

  it('主线没读成：要看内容的都判没查成、不删，只报一次；结构上判得了的照删', async () => {
    const { promise, calls } = run(world(), { delete: true, fail: { index: new Error('git 跑不起来') } });
    const r = await promise;
    expect(kinds(r)['empty-old']).toBe('unknown');
    expect(kinds(r)['output-old']).toBe('unknown');
    expect(calls.deleted).toEqual(['merged']);
    expect(r.notQueried).toEqual([
      expect.stringContaining('主线没读成（git 跑不起来）：要看内容的 5 条分支都没判'),
    ]);
  });

  it('一条分支的动态读不到：这一条没查成、不删，报出来', async () => {
    const { promise, calls } = run(world(), {
      delete: true,
      fail: { activity: new Error('GitHub 回了 502') },
    });
    const r = await promise;
    expect(kinds(r)['empty-old']).toBe('unknown');
    expect(calls.deleted).toEqual(['merged']);
    expect(r.notQueried.some((x) => x.startsWith('empty-old：GitHub 动态没查成'))).toBe(true);
  });

  it('--board，还没有巡检单：开一张（贴杂项），正文里有等人定的勾选框；新列的另留一条言（带体检记号）', async () => {
    const { promise, calls } = run(world(), { board: true });
    const r = await promise;
    expect(calls.created).toHaveLength(1);
    const made = calls.created[0];
    expect(made?.labels).toEqual(['杂项']);
    expect(made?.body).toContain(BOARD_MARKER);
    // 说给人看的天数就是判法用的那两个（改了天数正文跟着变）
    expect(made?.body).toContain(`满 ${ASK_DAYS} 天没动静`);
    expect(made?.body).toContain(`机器满 ${STALE_DAYS} 天自己删`);
    expect([...parseBoard(made?.body ?? '').listed].sort()).toEqual(['fleet/292-f3f3472d3', 'output-old']);
    expect(r.board).toEqual({ number: 900, created: true, newAsks: ['fleet/292-f3f3472d3', 'output-old'] });
    expect(calls.comments).toHaveLength(1);
    expect(calls.comments[0]?.body).toContain(`<!-- ${MARK} -->`);
  });

  it('巡检单上勾了删（就是现在的头）：下一轮照删；勾了留：留着、不再列进等你定；巡检单本身提到的不算提到', async () => {
    const w = world();
    const first = run(w, { board: true });
    await first.promise;
    const body = first.calls.created[0]?.body ?? '';
    const ticked = body
      .split('\n')
      .map((l) =>
        l.includes(`${MARK} delete output-old `) ||
        l.includes(`${MARK} keep ${encodeURIComponent('fleet/292-f3f3472d3')} `)
          ? l.replace('[ ]', '[x]')
          : l,
      )
      .join('\n');
    w.threads.push(thread(900, ticked));
    const second = run(w, { delete: true, board: true });
    const r = await second.promise;
    expect(kinds(r)['output-old']).toBe('delete');
    expect(r.reports.find((x) => x.name === 'output-old')?.verdict).toMatchObject({ byFounder: true });
    expect(kinds(r)['fleet/292-f3f3472d3']).toBe('keep');
    expect(second.calls.deleted.sort()).toEqual(['empty-old', 'merged', 'output-old']);
    expect(second.calls.created).toEqual([]);
    const updated = second.calls.updated[0]?.body ?? '';
    expect(parseBoard(updated).decisions.get('fleet/292-f3f3472d3')).toEqual({
      action: 'keep',
      sha: sha('8'),
    });
    expect(updated).toContain('## 这一轮删掉的');
    expect(updated).not.toContain('## 等你定');
    // 没有新列的：不再留言
    expect(second.calls.comments).toEqual([]);
  });

  it('巡检单没写成：记没查成（红），删照删', async () => {
    const { promise } = run(world(), {
      delete: true,
      board: true,
      fail: { createIssue: new Error('GitHub 回了 403') },
    });
    const r = await promise;
    expect(r.notQueried).toEqual([expect.stringContaining('巡检单没写成（GitHub 回了 403）')]);
    expect(r.deleted.sort()).toEqual(['empty-old', 'merged']);
  });
});

describe('分支体检：只跑在定时任务里，不挡 PR（#87）', () => {
  const read = (rel: string) => readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8');

  it('github-audit.yml 的 branches：检出全部历史、只有它能删分支、带 --delete --board；pnpm branch:hygiene 默认只判', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['branch:hygiene']).toBe('node packages/conventions/src/bin/branch-hygiene.ts');
    expect(pkg.scripts.check).not.toContain('branch-hygiene');
    const yml = read('.github/workflows/github-audit.yml');
    expect(yml).not.toMatch(/^ {2}pull_request(?:_target)?:/m);
    expect(yml).not.toMatch(/^ {2}push:/m);
    const branches = yml.slice(yml.indexOf('\n  branches:'));
    const audit = yml.slice(yml.indexOf('\n  audit:'), yml.indexOf('\n  branches:'));
    expect(branches).toMatch(/fetch-depth: 0/);
    expect(branches).toMatch(/contents: write/);
    expect(audit).not.toMatch(/contents: write/);
    expect(branches).toMatch(
      /run: node packages\/conventions\/src\/bin\/branch-hygiene\.ts --delete --board\s*$/m,
    );
  });
});
