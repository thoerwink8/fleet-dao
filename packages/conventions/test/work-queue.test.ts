// 本机队列（单 #2731）：pnpm work queue [--json] 列本机做的开着的单，每张一个状态和为什么，外加领者、心跳、开着的 PR、挂着的引导。
// 状态按先后判：母单 → 在做（PR、本机工作树 local/<单号>-、本机记下没到期的租约、30 分钟内的心跳）→ 等前置（「前置：」行里还有开着的单）
// → 等人拍 → 可接。收尾钩子（agents/hooks/queue-stop.mjs）读 --json 的 takeable 判挡不挡。gh、git、心跳、租约全换成假的。
// 10-16 第一版只看 PR、心跳、要人拍：主检出上 22 张报可接 19 张，在做（有工作树）、等前置、母单全被当成可接，收尾钩子白挡每一轮。
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Git } from '../src/directives.ts';
import type { GhResult } from '../src/issue-new.ts';
import { work } from '../src/work.ts';
import {
  type BeatLite,
  buildQueue,
  type FranceClaim,
  type LeaseRecord,
  LIVE_MINUTES,
  liveFranceClaims,
  parseFranceClaims,
  parseWorktrees,
  type QueueItem,
  type QueueReport,
  readLeases,
  readLocalBeats,
  removeLease,
  renderQueue,
  writeLease,
} from '../src/work-queue.ts';

const ok = (stdout = ''): GhResult => ({ code: 0, stdout, stderr: '' });
const bad = (stderr: string): GhResult => ({ code: 1, stdout: '', stderr });
const NOW = new Date('2026-10-16T09:00:00Z');
const minsAgo = (m: number) => NOW.getTime() - m * 60_000;
const REPO = 'acme/app';
const L = [{ name: '本机做' }];

const ISSUES = [
  { number: 30, title: '有 PR 在做', body: '', labels: L },
  { number: 10, title: '没人接', body: '原话见引导 20261016162904', labels: L },
  { number: 20, title: '工人刚动过', body: '', labels: L },
  { number: 40, title: '等人拍', body: '', labels: [...L, { name: '要人拍' }] },
  { number: 50, title: '心跳早断了', body: '引导 6173370315', labels: L },
  { number: 60, title: '有工作树', body: '', labels: L },
  { number: 70, title: '租约没到期', body: '', labels: L },
  { number: 71, title: '租约过期了', body: '', labels: L },
  {
    number: 80,
    title: '等前置',
    body: '## 场景\n\n前置：#81、#2 合并后再做。\n正文里别处写 #83 不算前置',
    labels: L,
  },
  { number: 82, title: '前置都关了', body: '前置：#83（已合）', labels: L },
  { number: 90, title: '贴了母单', body: '', labels: [...L, { name: '母单' }] },
  { number: 91, title: '下面挂着子单', body: '', labels: L, subIssuesSummary: { total: 2, completed: 1 } },
  { number: 92, title: '有工作树也写了前置', body: '前置：#81', labels: L },
];
const PULLS = [{ number: 99, body: '**需求**：Closes #30', headRefName: 'feat/x' }];
const BEATS: BeatLite[] = [
  { id: 'aaaaaaaa-1111', branch: 'local/20-fix', worktree: '20-fix', lastSeenMs: minsAgo(3) },
  { id: 'bbbbbbbb-2222', branch: 'local/50-old', worktree: '50-old', lastSeenMs: minsAgo(LIVE_MINUTES + 30) },
  { id: 'cccccccc-3333', branch: 'main', worktree: null, lastSeenMs: minsAgo(1) },
];
const LEASES: LeaseRecord[] = [
  { repo: REPO, issue: 70, leaseUntil: new Date(NOW.getTime() + 3_600_000).toISOString() },
  { repo: REPO, issue: 71, leaseUntil: new Date(NOW.getTime() - 60_000).toISOString() },
  // 别的仓同号的租约不算
  { repo: 'other/repo', issue: 10, leaseUntil: new Date(NOW.getTime() + 3_600_000).toISOString() },
];
const WORKTREES = [
  'worktree /r/fleet-dao',
  'HEAD 1111',
  'branch refs/heads/main',
  '',
  'worktree /r/fleet-dao/.claude/worktrees/60-x',
  'HEAD 2222',
  'branch refs/heads/local/60-x',
  '',
  'worktree /r/fleet-dao/.claude/worktrees/92-y',
  'HEAD 3333',
  'branch refs/heads/local/92-y',
  '',
  'worktree /r/fleet-dao/.claude/worktrees/detached',
  'HEAD 4444',
  'detached',
  '',
].join('\n');
/** 前置单的真状态 */
const STATES: Record<number, string> = { 81: 'OPEN', 2: 'CLOSED', 83: 'MERGED' };
const PENDING_FILE = [
  '# 创始人引导 20261016162904',
  '',
  '- 状态：待处理',
  '- 时间：2026-10-16 16:29 +0800',
  '- 主：无主',
  '- 来源：手填',
  '',
  '## 原话',
  '',
  '本机你可以开任意多个subagent',
  '',
  '## 经过',
  '',
].join('\n');

function deps(
  o: {
    issues?: GhResult;
    beats?: () => BeatLite[];
    leases?: () => LeaseRecord[];
    france?: () => Promise<FranceClaim[]>;
    gitFails?: boolean;
    graphqlFails?: boolean;
    repoView?: GhResult;
  } = {},
) {
  const graphql: string[] = [];
  const gh = async (args: string[]): Promise<GhResult> => {
    if (args[0] === 'issue' && args[1] === 'list') return o.issues ?? ok(JSON.stringify(ISSUES));
    if (args[0] === 'pr' && args[1] === 'list') return ok(JSON.stringify(PULLS));
    if (args[0] === 'repo' && args[1] === 'view')
      return o.repoView ?? ok(JSON.stringify({ nameWithOwner: REPO }));
    if (args[0] === 'api' && args[1] === 'graphql') {
      if (o.graphqlFails) return bad('HTTP 502');
      const q = args.find((a) => a.startsWith('query=')) ?? '';
      graphql.push(q);
      const repository: Record<string, { state: string }> = {};
      for (const m of q.matchAll(/n(\d+): issueOrPullRequest\(number: (\d+)\)/g)) {
        repository[`n${m[1]}`] = { state: STATES[Number(m[2])] ?? 'CLOSED' };
      }
      return ok(JSON.stringify({ data: { repository } }));
    }
    return bad(`没想到的 gh：${args.join(' ')}`);
  };
  const git: Git = async (args) => {
    if (o.gitFails) return bad('fatal: not a git repository');
    if (args[0] === 'worktree') return ok(WORKTREES);
    if (args[0] === 'grep') return ok('origin/main:docs/directives/2026-10/20261016162904.md\n');
    if (args[0] === 'show') return ok(PENDING_FILE);
    return bad(`没想到的 git：${args.join(' ')}`);
  };
  return {
    gh,
    git,
    readBeats: o.beats ?? (() => BEATS),
    readLeases: o.leases ?? (() => LEASES),
    readFranceClaims: o.france ?? (async () => []),
    now: () => NOW,
    graphql,
  };
}

const byIssue = (r: QueueReport) => new Map<number, QueueItem>(r.items.map((i) => [i.issue, i]));

describe('buildQueue：本机做的开着的单，每张一个状态', () => {
  it('按单号排；可接 = 没 PR、没工作树、没租约、没活着的心跳、没开着的前置、不是母单、没贴要人拍', async () => {
    const r = await buildQueue(deps());
    expect(r.problems).toEqual([]);
    expect(r.items.map((i) => i.issue)).toEqual([10, 20, 30, 40, 50, 60, 70, 71, 80, 82, 90, 91, 92]);
    expect(r.items.filter((i) => i.takeable).map((i) => i.issue)).toEqual([10, 50, 71, 82]);
    const by = byIssue(r);
    expect(by.get(10)).toMatchObject({
      state: 'takeable',
      pr: null,
      claimers: [],
      directives: ['20261016162904'],
    });
    expect(by.get(30)).toMatchObject({ state: 'working', pr: 99 });
    expect(by.get(30)?.why).toContain('PR #99');
    expect(by.get(40)).toMatchObject({ state: 'waiting-human' });
    // 心跳超过 30 分钟：领者照列，但算没人在做；它写到的引导已经办完（不在待处理里），不列
    expect(by.get(50)).toMatchObject({
      state: 'takeable',
      heartbeatMinutes: LIVE_MINUTES + 30,
      directives: [],
    });
  });

  it('在做之一：本机 git worktree list 里有分支 local/<单号>- 的工作树（子代理工人不报心跳）', async () => {
    const it60 = byIssue(await buildQueue(deps())).get(60);
    expect(it60).toMatchObject({ state: 'working', takeable: false });
    expect(it60?.claimers).toEqual([
      { kind: 'worktree', branch: 'local/60-x', path: '/r/fleet-dao/.claude/worktrees/60-x' },
    ]);
    expect(it60?.why).toBe('在做：工作树 local/60-x');
  });

  it('在做之二：本机记下、没到期的领单租约，领者一栏显示它；过期的、别的仓的不算', async () => {
    const by = byIssue(await buildQueue(deps()));
    const until = LEASES[0]?.leaseUntil ?? '';
    expect(by.get(70)).toMatchObject({
      state: 'working',
      claimers: [{ kind: 'lease', until, source: 'local' }],
    });
    expect(by.get(70)?.why).toBe(`在做：租约到 ${until}`);
    expect(by.get(71)).toMatchObject({ state: 'takeable', claimers: [] });
    expect(by.get(10)?.claimers).toEqual([]);
  });

  it('在做之三：30 分钟内有分支 local/<单号>- 的会话心跳', async () => {
    const it20 = byIssue(await buildQueue(deps())).get(20);
    expect(it20).toMatchObject({ state: 'working', heartbeatMinutes: 3 });
    expect(it20?.claimers).toEqual([
      { kind: 'heartbeat', session: 'aaaaaaaa', worktree: '20-fix', branch: 'local/20-fix', minutesAgo: 3 },
    ]);
  });

  it('等前置：「前置：」那一行提到的单还有开着的就不可接，blockedBy 只列开着的；都关了才可接；别处写的 #N 不算', async () => {
    const d = deps();
    const by = byIssue(await buildQueue(d));
    expect(by.get(80)).toMatchObject({ state: 'blocked', takeable: false, blockedBy: [81] });
    expect(by.get(80)?.why).toBe('等前置 #81（还开着）');
    expect(by.get(82)).toMatchObject({ state: 'takeable', blockedBy: [] });
    // 一次问完所有前置单的状态
    expect(d.graphql).toHaveLength(1);
    // 「前置：」那一行怎么认见 prerequisites.test.ts（解析只有一份，prerequisites.ts）
  });

  describe('日期前置（#2783）：前置：2026-11-12 复查日', () => {
    // NOW 是 2026-10-16（北京时间 17:00）
    const dated = (extra: Record<string, unknown>[]) =>
      ok(
        JSON.stringify([
          { number: 1960, title: '复查日', body: '改完了。\n\n前置：2026-11-12 复查日', labels: L },
          { number: 1961, title: '日期过了', body: '前置：2026-10-16 当天', labels: L },
          ...extra,
        ]),
      );

    it('北京时间到那天之前：不可接，why 写「等到 2026-11-12」；到了那天（含）照常；不用问 GitHub 前置单', async () => {
      const d = deps({ issues: dated([]) });
      const r = await buildQueue(d);
      const by = byIssue(r);
      expect(by.get(1960)).toMatchObject({
        state: 'blocked',
        takeable: false,
        blockedBy: [],
        blockedUntil: '2026-11-12',
      });
      expect(by.get(1960)?.why).toBe('等到 2026-11-12');
      expect(by.get(1961)).toMatchObject({ state: 'takeable', blockedUntil: null });
      expect(d.graphql).toHaveLength(0);
      expect(r.problems).toEqual([]);
    });

    it('北京时间 2026-11-12 0 点（UTC 11-11 16:00）起可接；前一秒仍等', async () => {
      const at = (iso: string) => ({ ...deps({ issues: dated([]) }), now: () => new Date(iso) });
      expect(byIssue(await buildQueue(at('2026-11-11T15:59:59Z'))).get(1960)?.state).toBe('blocked');
      expect(byIssue(await buildQueue(at('2026-11-11T16:00:00Z'))).get(1960)?.state).toBe('takeable');
    });

    it('单号和日期同写：前置单关了、日期没到仍等；日期到了、前置单还开着仍等，why 两样都写', async () => {
      const issues = ok(
        JSON.stringify([
          { number: 1, title: 'a', body: '前置：#83 且 2026-11-12', labels: L },
          { number: 2, title: 'b', body: '前置：#81 且 2026-10-01', labels: L },
        ]),
      );
      const by = byIssue(await buildQueue(deps({ issues })));
      expect(by.get(1)).toMatchObject({ state: 'blocked', blockedBy: [], blockedUntil: '2026-11-12' });
      expect(by.get(2)).toMatchObject({ state: 'blocked', blockedBy: [81], blockedUntil: null });
      const both = ok(
        JSON.stringify([{ number: 3, title: 'c', body: '前置：#81 且 2026-11-12', labels: L }]),
      );
      const three = byIssue(await buildQueue(deps({ issues: both }))).get(3);
      expect(three?.why).toBe('等前置 #81（还开着）；等到 2026-11-12');
    });

    it('文字版：行首写「等到 2026-11-12」，头一行的「等前置」数里算上它', async () => {
      const out: string[] = [];
      const d = deps({ issues: dated([]) });
      await work(['queue'], {
        gh: d.gh,
        post: async () => {
          throw new Error('queue 不该碰法国');
        },
        out: (l) => out.push(l),
        err: () => {},
        queue: {
          git: d.git,
          readBeats: d.readBeats,
          readLeases: d.readLeases,
          readFranceClaims: d.readFranceClaims,
          now: d.now,
        },
      });
      expect(out[0]).toContain('等前置 1');
      expect(out.find((l) => l.includes('#1960 '))).toMatch(
        /^\[等到 2026-11-12\] #1960 复查日 \| 等到 2026-11-12 \|/,
      );
    });

    it('先后：有 PR 在做的单，日期没到也算在做', async () => {
      const issues = ok(JSON.stringify([{ number: 30, title: 'p', body: '前置：2026-11-12', labels: L }]));
      expect(byIssue(await buildQueue(deps({ issues }))).get(30)?.state).toBe('working');
    });
  });

  it('【故意造出的失败】前置单的状态读不成：写了前置的一律按等前置算，不当成都关了；没写前置的照判', async () => {
    const r = await buildQueue(deps({ graphqlFails: true }));
    const by = byIssue(r);
    expect(by.get(82)).toMatchObject({ state: 'blocked', blockedBy: [83] });
    expect(by.get(82)?.why).toContain('没查成');
    expect(by.get(10)?.state).toBe('takeable');
    expect(r.problems.join('\n')).toContain('前置单的状态没读成');
  });

  it('母单：贴了「母单」或下面挂着子单，不可接', async () => {
    const by = byIssue(await buildQueue(deps()));
    expect(by.get(90)).toMatchObject({ state: 'mother', takeable: false });
    expect(by.get(90)?.why).toContain('贴了「母单」');
    expect(by.get(91)).toMatchObject({ state: 'mother' });
    expect(by.get(91)?.why).toContain('挂着 2 张子单');
  });

  it('先后：有工作树又写了没关的前置，算在做（等前一张合的那种已经开工了）', async () => {
    expect(byIssue(await buildQueue(deps())).get(92)?.state).toBe('working');
  });

  it('【故意造出的失败】当前仓没读成：租约和前置不算没有，本来可接的不当成可接', async () => {
    const r = await buildQueue(deps({ repoView: bad('HTTP 502') }));
    const by = byIssue(r);
    expect(r.problems.join('\n')).toContain('没读成');
    expect(r.problems.join('\n')).toContain('不当成可接');
    expect(by.get(10)?.takeable).toBe(false);
    expect(by.get(10)?.why).toContain('不当成没有');
    expect(by.get(30)?.state).toBe('working');
    expect(by.get(82)?.state).toBe('blocked');
    expect(by.get(82)?.why).toContain('没查成');
    expect(by.get(82)?.blockedBy).toEqual([83]);
    expect(r.items.every((i) => i.state !== 'takeable')).toBe(true);
    expect(renderQueue(r).some((l) => l.startsWith('[没查成]'))).toBe(true);
  });

  it('【故意造出的失败】心跳、工作树、租约、引导读不成：照列单，没读成的写进 problems，不当成没有', async () => {
    const r = await buildQueue(
      deps({
        beats: () => {
          throw new Error('EACCES');
        },
        leases: () => {
          throw new Error('EPERM');
        },
        gitFails: true,
      }),
    );
    expect(r.items).toHaveLength(ISSUES.length);
    const p = r.problems.join('\n');
    for (const w of ['心跳没读成', '工作树没读成', '租约没读成', '引导没读成']) expect(p).toContain(w);
    expect(byIssue(r).get(10)?.takeable).toBe(false);
    expect(byIssue(r).get(70)?.why).toContain('不当成没有');
    expect(byIssue(r).get(30)?.state).toBe('working');
  });

  it('【故意造出的失败】单读不成、或到了 200 张没翻全：整条抛，不当成队列空', async () => {
    await expect(buildQueue(deps({ issues: bad('HTTP 502') }))).rejects.toThrow(/没读成/);
    const many = Array.from({ length: 200 }, (_, i) => ({ number: i + 1, title: 't', body: '', labels: [] }));
    await expect(buildQueue(deps({ issues: ok(JSON.stringify(many)) }))).rejects.toThrow(/没翻全/);
  });

  it('parseWorktrees：只认带分支的工作树，分支去掉 refs/heads/', () => {
    expect(parseWorktrees(WORKTREES).map((w) => w.branch)).toEqual(['main', 'local/60-x', 'local/92-y']);
  });
});

describe('pnpm work queue [--json]', () => {
  const run = async (argv: string[], d = deps()) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await work(argv, {
      gh: d.gh,
      post: async () => {
        throw new Error('queue 不该碰法国');
      },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      queue: {
        git: d.git,
        readBeats: d.readBeats,
        readLeases: d.readLeases,
        readFranceClaims: d.readFranceClaims,
        now: d.now,
      },
    });
    return { code, out, err };
  };

  it('文字版：头一行写各状态的数，一张一行先写状态（等前置带单号）再写为什么', async () => {
    const r = await run(['queue']);
    expect(r.code).toBe(0);
    expect(r.out[0]).toBe('本机队列：13 张本机做的开着的单，可接 4、在做 5、等前置 1、母单 2、等人拍 1');
    const line = (n: number) => r.out.find((l) => l.includes(`#${n} `)) ?? '';
    expect(line(10)).toMatch(/^\[可接\] #10 没人接 \| 可接：/);
    expect(line(60)).toContain('[在做] #60 有工作树 | 在做：工作树 local/60-x | 领者：工作树 local/60-x');
    expect(line(70)).toContain('领者：租约到');
    expect(line(80)).toMatch(/^\[等前置 #81\] #80 等前置 \| 等前置 #81（还开着）/);
    expect(line(90)).toMatch(/^\[母单\] #90 /);
    expect(line(40)).toMatch(/^\[等人拍\] #40 /);
  });

  it('--json：每张带结构化的 state、why、blockedBy；收尾钩子读的 takeable 也在', async () => {
    const r = await run(['queue', '--json']);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out.join('')) as QueueReport;
    const by = byIssue(report);
    expect(by.get(80)).toMatchObject({ state: 'blocked', blockedBy: [81], takeable: false });
    expect(by.get(91)).toMatchObject({ state: 'mother', takeable: false });
    expect(report.items.filter((i) => i.takeable).map((i) => i.issue)).toEqual([10, 50, 71, 82]);
    expect(report.problems).toEqual([]);
  });

  it('【故意造出的失败】gh 出错：退出码 1，原因在 stderr；认不出的参数也是 1', async () => {
    const r = await run(['queue'], deps({ issues: bad('could not resolve host') }));
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('could not resolve host');
    expect((await run(['queue', '--all'])).code).toBe(1);
  });
});

describe('法国全部机器的租约（#3389）', () => {
  const future = new Date(NOW.getTime() + 3_600_000).toISOString();
  const past = new Date(NOW.getTime() - 60_000).toISOString();
  const franceClaims: FranceClaim[] = [
    { repo: REPO, issue: 10, claimedBy: 'founder-pc', leaseUntil: future },
    { repo: REPO, issue: 50, claimedBy: 'old-box', leaseUntil: past },
    { repo: 'other/repo', issue: 82, claimedBy: 'other-box', leaseUntil: future },
  ];
  const wire = (claims: unknown) => JSON.stringify({ claims });
  const TOKEN = ['pass', 'xyz', '123'].join('-');
  const ep = () => ({ url: 'https://fr.example/', token: TOKEN });
  const res = (status: number, body: string) => async () => new Response(body, { status });

  it('别的机器的有效租约判在做，领者写它的编号和到期、来源 france；过期的、别的仓的不算', async () => {
    const r = await buildQueue(deps({ france: async () => franceClaims }));
    const by = byIssue(r);
    expect(r.problems).toEqual([]);
    expect(by.get(10)).toMatchObject({
      state: 'working',
      takeable: false,
      claimers: [{ kind: 'lease', until: future, source: 'france', claimedBy: 'founder-pc' }],
    });
    expect(by.get(10)?.why).toBe(`在做：founder-pc 的租约到 ${future}`);
    expect(by.get(50)).toMatchObject({
      state: 'takeable',
      claimers: [expect.objectContaining({ kind: 'heartbeat' })],
    });
    expect(by.get(82)?.state).toBe('takeable');
    expect(renderQueue(r).find((l) => l.includes('#10 '))).toContain(`领者：founder-pc 租约到 ${future}`);
  });

  it('法国和本机文件都有同一张单的租约：只列法国的，本机文件只作补充', async () => {
    const france = async () => [{ repo: REPO, issue: 70, claimedBy: 'mac', leaseUntil: future }];
    const by = byIssue(await buildQueue(deps({ france })));
    expect(by.get(70)?.claimers).toEqual([
      { kind: 'lease', until: future, source: 'france', claimedBy: 'mac' },
    ]);
    // 法国没有、本机文件有：仍判在做
    expect(byIssue(await buildQueue(deps({ france: async () => [] }))).get(70)?.state).toBe('working');
  });

  it('读不到法国：领者写没查成、原本可接的改判不可接、problems 照报；有 PR 的仍在做', async () => {
    const r = await buildQueue(
      deps({
        france: async () => {
          throw new Error('法国回 HTTP 503（nodes_disabled）');
        },
      }),
    );
    const by = byIssue(r);
    expect(r.items.some((i) => i.takeable)).toBe(false);
    expect(by.get(10)).toMatchObject({
      state: 'blocked',
      claimers: [{ kind: 'unchecked', reason: '法国回 HTTP 503（nodes_disabled）' }],
    });
    expect(by.get(10)?.why).toContain('没查成：法国回 HTTP 503');
    expect(by.get(30)?.state).toBe('working');
    expect(r.problems.join('\n')).toContain('法国的租约没查成');
    const lines = renderQueue(r);
    expect(lines.find((l) => l.includes('#10 '))).toMatch(/^\[没查成\] #10 .*领者：没查成：法国回 HTTP 503/);
  });

  it('--json 带领者编号和来源；读不到时带没查成的原因', async () => {
    const d = deps({ france: async () => franceClaims });
    const out: string[] = [];
    await work(['queue', '--json'], {
      gh: d.gh,
      post: async () => {
        throw new Error('queue 不该 POST');
      },
      out: (l) => out.push(l),
      err: () => {},
      queue: {
        git: d.git,
        readBeats: d.readBeats,
        readLeases: d.readLeases,
        readFranceClaims: d.readFranceClaims,
        now: d.now,
      },
    });
    const rep = JSON.parse(out.join('')) as QueueReport;
    expect(byIssue(rep).get(10)?.claimers).toEqual([
      { kind: 'lease', until: future, source: 'france', claimedBy: 'founder-pc' },
    ]);
  });

  describe('liveFranceClaims：真读（注入 fetch）', () => {
    it('GET /api/nodes/claims，通行证在请求头；200 严格解析；去掉地址尾斜杠', async () => {
      const calls: { url: string; init: RequestInit }[] = [];
      const fetchImpl = (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(wire([{ repo: REPO, issue: 10, claimedBy: 'x', leaseUntil: future }]), {
          status: 200,
        });
      }) as unknown as typeof fetch;
      const got = await liveFranceClaims(ep, fetchImpl)();
      expect(got).toEqual([{ repo: REPO, issue: 10, claimedBy: 'x', leaseUntil: future }]);
      expect(calls[0]?.url).toBe('https://fr.example/api/nodes/claims');
      expect(calls[0]?.init.method).toBe('GET');
      const headers = (calls[0]?.init.headers ?? {}) as Record<string, string>;
      expect(headers['X-Fleet-Node-Token']).toBe(TOKEN);
      expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    });

    it('没装配置：endpoint 抛的话原样成为没查成的原因', async () => {
      const run = liveFranceClaims(
        () => {
          throw new Error('读不到 config.json：先装本机会话上报');
        },
        res(200, wire([])),
      );
      await expect(run()).rejects.toThrow('读不到 config.json');
      const r = await buildQueue(deps({ france: run }));
      expect(r.items.some((i) => i.takeable)).toBe(false);
      expect(r.problems.join('\n')).toContain('读不到 config.json');
    });

    it.each([
      [401, '{"error":"invalid_token"}', 'HTTP 401（invalid_token）'],
      [503, '{"error":"nodes_disabled"}', 'HTTP 503（nodes_disabled）'],
      [404, '<html>nope</html>', 'HTTP 404'],
    ])('HTTP %i：没查成，写状态和错误码，不带 body 和通行证', async (status, body, want) => {
      const r = await buildQueue(deps({ france: liveFranceClaims(ep, res(status, body)) }));
      expect(r.items.some((i) => i.takeable)).toBe(false);
      const all = JSON.stringify(r) + renderQueue(r).join('\n');
      expect(all).toContain(want);
      expect(all).not.toContain(TOKEN);
      expect(all).not.toContain('<html>');
    });

    it('超时：没查成「超时」，不判可接', async () => {
      const fetchImpl = ((_u: string, init: RequestInit) =>
        new Promise((_res, rej) => {
          init.signal?.addEventListener('abort', () => rej(init.signal?.reason));
        })) as unknown as typeof fetch;
      const r = await buildQueue(deps({ france: liveFranceClaims(ep, fetchImpl, 20) }));
      expect(r.items.some((i) => i.takeable)).toBe(false);
      expect(r.problems.join('\n')).toContain('超时');
    });

    it('连不上：原因里的通行证被抹掉', async () => {
      const fetchImpl = (async () => {
        throw new Error(`connect ECONNREFUSED ${TOKEN}`);
      }) as unknown as typeof fetch;
      const r = await buildQueue(deps({ france: liveFranceClaims(ep, fetchImpl) }));
      expect(r.problems.join('\n')).toContain('连不上法国');
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    });

    it.each([
      ['坏 JSON', '{not json'],
      ['不是对象', '[]'],
      ['多顶层字段', JSON.stringify({ claims: [], extra: 1 })],
      ['缺 claims', '{}'],
      ['claims 不是数组', JSON.stringify({ claims: {} })],
      [
        '条目多字段',
        wire([{ repo: REPO, issue: 1, claimedBy: 'a', leaseUntil: '2026-10-20T05:00:00.000Z', x: 1 }]),
      ],
      ['条目缺字段', wire([{ repo: REPO, issue: 1, claimedBy: 'a' }])],
      [
        'issue 是字符串',
        wire([{ repo: REPO, issue: '1', claimedBy: 'a', leaseUntil: '2026-10-20T05:00:00.000Z' }]),
      ],
      [
        'issue 非正整数',
        wire([{ repo: REPO, issue: 0, claimedBy: 'a', leaseUntil: '2026-10-20T05:00:00.000Z' }]),
      ],
      ['时刻不是时间', wire([{ repo: REPO, issue: 1, claimedBy: 'a', leaseUntil: 'soon' }])],
      [
        'claimedBy 为空',
        wire([{ repo: REPO, issue: 1, claimedBy: '', leaseUntil: '2026-10-20T05:00:00.000Z' }]),
      ],
      [
        'repo 不是 owner/name',
        wire([{ repo: 'x', issue: 1, claimedBy: 'a', leaseUntil: '2026-10-20T05:00:00.000Z' }]),
      ],
    ])('认不出（%s）：没查成，不判可接', async (_name, body) => {
      expect(() => parseFranceClaims(body)).toThrow();
      const r = await buildQueue(deps({ france: liveFranceClaims(ep, res(200, body)) }));
      expect(r.items.some((i) => i.takeable)).toBe(false);
      expect(r.problems.join('\n')).toContain('法国的租约没查成');
    });

    it('空表合法：没有别的机器的租约，照常判', async () => {
      const r = await buildQueue(deps({ france: liveFranceClaims(ep, res(200, wire([]))) }));
      expect(r.problems).toEqual([]);
      expect(r.items.filter((i) => i.takeable).map((i) => i.issue)).toEqual([10, 50, 71, 82]);
    });
  });
});

describe('pnpm work claim / renew / done：本机记下租约，队列才认得在做', () => {
  const lease = {
    ok: true,
    taskId: 't1',
    state: 'running',
    executor: 'local',
    leaseUntil: '2026-10-16T12:00:00.000Z',
  };
  const run = async (argv: string[], post = lease) => {
    const writes: LeaseRecord[] = [];
    const removes: [string, number][] = [];
    const err: string[] = [];
    const code = await work(argv, {
      gh: async (args) => {
        if (args[0] === 'repo') return ok(JSON.stringify({ nameWithOwner: REPO }));
        if (args[0] === 'issue' && args[1] === 'view')
          return ok(JSON.stringify({ title: 'T', state: 'OPEN' }));
        if (args[0] === 'pr' && args[1] === 'list') return ok('[]');
        if (args[0] === 'issue' && args[1] === 'edit') return ok();
        return bad(`没想到的 gh：${args.join(' ')}`);
      },
      post: async () => ({ status: 200, text: JSON.stringify(post) }),
      out: () => {},
      err: (l) => err.push(l),
      leases: {
        write: (rec) => writes.push(rec),
        remove: (repo, issue) => removes.push([repo, issue]),
      },
    });
    return { code, writes, removes, err };
  };

  it('claim、renew 成了记一份租约；done 删掉', async () => {
    for (const a of ['claim', 'renew']) {
      const r = await run([a, '42']);
      expect(r.code, a).toBe(0);
      expect(r.writes, a).toEqual([{ repo: REPO, issue: 42, leaseUntil: '2026-10-16T12:00:00.000Z' }]);
    }
    const done = await run(['done', '42'], { ...lease, leaseUntil: null as unknown as string });
    expect(done.code).toBe(0);
    expect(done.removes).toEqual([[REPO, 42]]);
  });

  it('租约文件：写、读、删；坏文件跳过；目录不在是空', () => {
    const dir = mkdtempSync(join(tmpdir(), 'queue-leases-'));
    made.push(dir);
    expect(readLeases(join(dir, 'none'))).toEqual([]);
    writeLease({ repo: REPO, issue: 7, leaseUntil: '2026-10-16T12:00:00.000Z' }, dir);
    writeFileSync(join(dir, 'bad.json'), '{坏的');
    expect(readLeases(dir)).toEqual([{ repo: REPO, issue: 7, leaseUntil: '2026-10-16T12:00:00.000Z' }]);
    removeLease(REPO, 7, dir);
    expect(readLeases(dir)).toEqual([]);
  });
});

const made: string[] = [];
beforeEach(() => {
  vi.stubEnv('GH_REPO', '');
  vi.stubEnv('GITHUB_REPOSITORY', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('readLocalBeats：本机会话心跳', () => {
  it('读会话号、分支、工作树名；最后一次动取心跳和会话记录修改时间里晚的那个；坏文件跳过；目录不在是空', () => {
    const home = mkdtempSync(join(tmpdir(), 'queue-home-'));
    made.push(home);
    expect(readLocalBeats(home, join(home, '.claude'))).toEqual([]);
    const dir = join(home, '.fleet-dao', 'local-sessions', 'sessions');
    mkdirSync(dir, { recursive: true });
    const seen = '2026-10-16T08:00:00.000Z';
    writeFileSync(
      join(dir, 's1.json'),
      JSON.stringify({ id: 's1', branch: 'local/7-x', worktree: '7-x', lastSeenAt: seen }),
    );
    writeFileSync(join(dir, 'bad.json'), '{坏的');
    const projects = join(home, '.claude', 'projects', 'D--frank-fleet-dao');
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, 's1.jsonl'), '{}\n');
    const later = new Date('2026-10-16T08:30:00.000Z');
    utimesSync(join(projects, 's1.jsonl'), later, later);
    expect(readLocalBeats(home, join(home, '.claude'))).toEqual([
      { id: 's1', branch: 'local/7-x', worktree: '7-x', lastSeenMs: later.getTime() },
    ]);
  });
});
