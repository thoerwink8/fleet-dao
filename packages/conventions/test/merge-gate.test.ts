import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ghApi } from '../src/gh-api.ts';
import {
  type GateDeps,
  type GateState,
  type GitHubReads,
  gateGitHub,
  gatePr,
  runMergeGate,
} from '../src/merge-gate.ts';
import type { RiskPath } from '../src/merge-gates.ts';

const HEAD = 'a'.repeat(40);
const MERGE = 'b'.repeat(40);
const MAIN = 'c'.repeat(40);
const PLAN = ['# 计划', '', '### P1 核心闭环', '', '- GitHub：两个新机器人。', ''].join('\n');
const RISK: RiskPath[] = [
  { path: 'deploy/', kind: '动生产', why: '真机' },
  { path: 'packages/api/src/auth.ts', kind: '碰安全', why: '登录' },
];
const RISK_TEXT = JSON.stringify({ paths: RISK });

function body(tier: string | null): string {
  return [
    '**做了什么**：试一下',
    '**对应计划**：P1「GitHub：两个新机器人」',
    '**specs**：specs/74-合并检查上GitHub/',
    ...(tier === null ? [] : [`**档位**：${tier}`]),
    '**文档**：不适用',
  ].join('\n');
}

interface World {
  pr: Record<string, unknown>;
  files: string[];
  statuses: unknown[];
  repoFiles: Record<string, Record<string, string>>;
  written: { sha: string; state: GateState; description: string; targetUrl?: string }[];
  refsRead: string[];
  /** 按方法名故意抛错。 */
  broken: Partial<Record<keyof GitHubReads, string>>;
  /** 前几次读 PR 时 mergeable 还是 null。 */
  unknownReads: number;
  open: Record<string, unknown>[];
  forCommit: unknown[];
  /** 每次读主线头依次回这些，读完了一直回最后一个。 */
  mains: string[];
}

function world(
  over: Partial<World> & { prOver?: Record<string, unknown> } = {},
): World & { gh: GitHubReads } {
  const w: World = {
    pr: {
      number: 80,
      labels: [{ name: '杂项' }],
      milestone: { title: 'P1 核心闭环' },
      body: body('直接合——只改文档'),
      head: { sha: HEAD },
      changed_files: 1,
      draft: false,
      mergeable: true,
      merge_commit_sha: MERGE,
      state: 'open',
      ...over.prOver,
    },
    files: ['docs/x.md'],
    statuses: [],
    repoFiles: {
      [MERGE]: { 'docs/plan.md': PLAN, 'specs/74-合并检查上GitHub': '' },
      [HEAD]: { 'docs/plan.md': PLAN, 'specs/74-合并检查上GitHub': '' },
    },
    written: [],
    refsRead: [],
    broken: {},
    unknownReads: 0,
    open: [],
    forCommit: [],
    mains: [MAIN],
    ...over,
  };
  if (over.files && !over.prOver?.changed_files) w.pr.changed_files = over.files.length;
  const boom = (k: keyof GitHubReads) => {
    if (w.broken[k]) throw new Error(w.broken[k]);
  };
  const gh: GitHubReads = {
    async pr(n) {
      boom('pr');
      if (w.unknownReads > 0) {
        w.unknownReads--;
        return { ...w.pr, number: n, mergeable: null };
      }
      return { ...w.pr, number: n };
    },
    async files() {
      boom('files');
      return w.files.map((filename) => ({ filename, status: 'modified' }));
    },
    async statuses() {
      boom('statuses');
      return w.statuses;
    },
    async fileAt(path, ref) {
      boom('fileAt');
      w.refsRead.push(ref);
      return w.repoFiles[ref]?.[path] ?? null;
    },
    async exists(path, ref) {
      boom('exists');
      return path in (w.repoFiles[ref] ?? {});
    },
    async openPrs() {
      boom('openPrs');
      return w.open;
    },
    async prsForCommit() {
      boom('prsForCommit');
      return w.forCommit;
    },
    async mainHead() {
      boom('mainHead');
      return (w.mains.length > 1 ? w.mains.shift() : w.mains[0]) as string;
    },
    async writeStatus(sha, s) {
      boom('writeStatus');
      w.written.push({ sha, ...s });
    },
  };
  return Object.assign(w, { gh });
}

const deps = (w: { gh: GitHubReads }, riskList: GateDeps['riskList'] = RISK): GateDeps => ({
  gh: w.gh,
  riskList,
  sleep: async () => {},
});

const SO_OK = [{ context: 'second-opinion', state: 'success', description: '通过' }];

describe('合并闸：验收场景', () => {
  it('① 不是草稿、没冲突、没改到先审后合的地方 → 通过；plan.md、specs 按合并后的样子读', async () => {
    const w = world();
    const r = await gatePr(80, deps(w));
    expect(r).toMatchObject({ number: 80, head: HEAD, state: 'success', notChecked: false });
    expect(r.lines).toEqual(['能合：不是草稿、没冲突，没改到先审后合的地方。']);
    expect(w.refsRead).toEqual([MERGE]);
  });

  it('② 和主线有冲突 → 不通过（按头读 plan.md 做提醒）', async () => {
    const w = world({ prOver: { mergeable: false, merge_commit_sha: null } });
    const r = await gatePr(80, deps(w));
    expect(r.state).toBe('failure');
    expect(r.lines).toEqual([expect.stringMatching(/^和主线有冲突，合不进去/)]);
    expect(w.refsRead).toEqual([HEAD]);
  });

  it('③ 草稿 → 不通过', async () => {
    const r = await gatePr(80, deps(world({ prOver: { draft: true } })));
    expect(r.state).toBe('failure');
    expect(r.lines).toEqual([expect.stringMatching(/^是草稿/)]);
  });

  it('④ 必填栏缺了（没标签、没里程碑、没档位、对应计划和 specs 都没写）→ 照样通过，只提醒', async () => {
    const r = await gatePr(80, deps(world({ prOver: { labels: [], milestone: null, body: '改了一行' } })));
    expect(r.state).toBe('success');
    expect(r.lines[0]).toBe('能合：不是草稿、没冲突，没改到先审后合的地方。');
    expect(r.lines.slice(1).map((l) => l.slice(0, l.indexOf('：', 3)))).toEqual([
      '提醒：没贴类别标签',
      '提醒：没挂里程碑',
      '提醒：正文里认不出「对应计划」一栏',
      '提醒：正文里认不出「specs」一栏',
      '提醒：正文里认不出「档位」一栏',
    ]);
  });

  it('⑤ 改到先审后合的路径、当前头没有第二意见 → 不通过，报出文件；档位写什么都一样（按路径判）', async () => {
    const files = ['deploy/france.sh', 'docs/x.md'];
    for (const tier of ['先审后合——改部署', '直接合——小改', null]) {
      const r = await gatePr(80, deps(world({ files, prOver: { body: body(tier) } })));
      expect(r.state, String(tier)).toBe('failure');
      expect(r.lines[0]).toMatch(
        /^等第二意见：当前头 aaaaaaa 上还没有 second-opinion 状态，改到了先审后合的地方：deploy\/france\.sh（动生产）/,
      );
    }
    const passed = await gatePr(80, deps(world({ files, statuses: SO_OK })));
    expect(passed.state).toBe('success');
    expect(passed.lines[0]).toBe('能合：不是草稿、没冲突，改到 1 个先审后合的地方，当前头上第二意见已通过。');
  });

  it('没改到那三种地方：档位写「先审后合」也不等第二意见', async () => {
    const r = await gatePr(80, deps(world({ prOver: { body: body('先审后合——拿不准') } })));
    expect(r.state).toBe('success');
  });

  it('第二意见没过、还在跑 → 不通过', async () => {
    const at = (state: string) =>
      gatePr(
        80,
        deps(
          world({ files: ['packages/api/src/auth.ts'], statuses: [{ context: 'second-opinion', state }] }),
        ),
      );
    expect((await at('failure')).lines).toEqual([expect.stringMatching(/^第二意见没过/)]);
    expect((await at('pending')).lines).toEqual([expect.stringMatching(/^等第二意见：.*还在跑/)]);
  });
});

describe('合并闸：GitHub 还在算冲突', () => {
  it('先是 null、再读几次算出来了 → 照常判', async () => {
    const w = world({ unknownReads: 2 });
    expect((await gatePr(80, deps(w))).state).toBe('success');
  });

  it('一直算不出来 → pending，不当通过', async () => {
    const w = world({ unknownReads: 99 });
    const r = await gatePr(80, { ...deps(w), mergeablePolls: 3 });
    expect(r).toMatchObject({ state: 'pending', notChecked: false });
    expect(r.lines[0]).toMatch(/^GitHub 还没算完/);
  });
});

describe('合并闸：决定结论的读不到、认不出都是「没查成」，写 failure，不当通过', () => {
  const RISKY = ['deploy/france.sh'];
  const cases: [string, Parameters<typeof world>[0], GateDeps['riskList'] | undefined, RegExp][] = [
    [
      'PR 读不到',
      { broken: { pr: 'GitHub 回了 502' } },
      undefined,
      /^没查成：读不到 PR #80 现在的样子（GitHub 回了 502）/,
    ],
    ['PR 没有头', { prOver: { head: {} } }, undefined, /head\.sha 认不出/],
    ['PR 的 draft 认不出', { prOver: { draft: 'no' } }, undefined, /draft 认不出/],
    ['改动文件读不到', { broken: { files: '500' } }, undefined, /读不到 PR #80 改了哪些文件（500）/],
    ['改动文件没读全', { prOver: { changed_files: 3001 } }, undefined, /改了 3001 个文件，只读到 1 个/],
    ['先审后合的清单读不到', {}, '读不到', /路径清单 .* 读不到/],
    [
      '提交状态读不到',
      { files: RISKY, broken: { statuses: '502' } },
      undefined,
      /读不到当前头 aaaaaaa 的提交状态（502）/,
    ],
    [
      '提交状态认不出',
      { files: RISKY, statuses: [{ context: 'second-opinion', state: '通过' }] },
      undefined,
      /提交状态认不出/,
    ],
  ];

  it.each(cases)('%s', async (_name, over, riskList, line) => {
    const r = await gatePr(80, deps(world(over), riskList ?? RISK));
    expect(r.state).toBe('failure');
    expect(r.notChecked).toBe(true);
    expect(r.lines[0]).toMatch(/^没查成：/);
    expect(r.lines.join('\n')).toMatch(line);
  });

  it('PR 读回来没有号：没查成', async () => {
    const w = world();
    const gh = { ...w.gh, pr: async () => ({ ...w.pr, number: 'x' }) };
    const r = await gatePr(80, { ...deps(w), gh });
    expect(r).toMatchObject({ state: 'failure', notChecked: true });
    expect(r.lines[0]).toBe('没查成：PR #80 读回来认不出：number 认不出。');
  });

  it('PR 读回来号不对：没查成', async () => {
    const w = world();
    const gh = { ...w.gh, pr: async () => ({ ...w.pr, number: 81 }) };
    const r = await gatePr(80, { ...deps(w), gh });
    expect(r.lines[0]).toBe('没查成：要的是 PR #80，读回来的是 #81。');
  });
});

describe('合并闸：提醒那一半坏了也改不了结论（所以必填栏的判法不在先审后合清单里）', () => {
  const cases: [string, Parameters<typeof world>[0], RegExp][] = [
    ['标签认不出', { prOver: { labels: 'x' } }, /提醒：必填栏没查成：.*labels 认不出/],
    ['plan.md 读不到', { repoFiles: {} }, /提醒：必填栏没查成：这个 PR 里读不到 docs\/plan\.md/],
    ['plan.md 没有阶段', { repoFiles: { [MERGE]: { 'docs/plan.md': '# 空' } } }, /一个阶段.*也没认出来/],
    ['plan.md 读的时候出错', { broken: { fileAt: '超时' } }, /或 specs 目录（超时）/],
    ['specs 目录问的时候出错', { broken: { exists: '403' } }, /或 specs 目录（403）/],
  ];

  it.each(cases)('%s：没改到那三种地方照样通过，提醒里写明没查成', async (_name, over, line) => {
    const r = await gatePr(80, deps(world(over)));
    expect(r.state).toBe('success');
    expect(r.lines.join('\n')).toMatch(line);
  });

  it('改到那三种地方、没有第二意见：提醒那一半坏了照样不通过', async () => {
    const r = await gatePr(80, deps(world({ files: ['deploy/x.sh'], broken: { fileAt: '超时' } })));
    expect(r.state).toBe('failure');
    expect(r.lines[0]).toMatch(/^等第二意见/);
  });
});

describe('入口：认出要算哪些 PR、写状态、退出码', () => {
  function eventFile(event: unknown): string {
    const path = join(mkdtempSync(join(tmpdir(), 'fleet-gate-event-')), 'event.json');
    writeFileSync(path, typeof event === 'string' ? event : JSON.stringify(event));
    return path;
  }
  const run = (
    w: { gh: GitHubReads },
    eventName: string,
    event: unknown,
    over: { write?: boolean; risk?: string | undefined } = {},
  ) =>
    runMergeGate({
      eventName,
      eventPath: eventFile(event),
      riskListText: 'risk' in over ? over.risk : RISK_TEXT,
      gh: w.gh,
      write: over.write ?? true,
      targetUrl: 'https://github.com/o/r/actions/runs/1',
      sleep: async () => {},
    });

  it('PR 事件：算这一个，写到当前头上（通过也写，带详情链接）', async () => {
    const w = world();
    const r = await run(w, 'pull_request_target', { pull_request: { number: 80 } });
    expect(r.code).toBe(0);
    expect(w.written).toEqual([
      {
        sha: HEAD,
        state: 'success',
        description: '能合：不是草稿、没冲突，没改到先审后合的地方。',
        targetUrl: 'https://github.com/o/r/actions/runs/1',
      },
    ]);
  });

  it('不通过也写（failure），退出码 0：算成了、写上了；没查成写 failure、退出码 2', async () => {
    const draft = world({ prOver: { draft: true } });
    expect((await run(draft, 'pull_request_target', { pull_request: { number: 80 } })).code).toBe(0);
    expect(draft.written[0]).toMatchObject({
      state: 'failure',
      description: expect.stringMatching(/^是草稿/),
    });

    const noList = world();
    expect(
      (await run(noList, 'pull_request_target', { pull_request: { number: 80 } }, { risk: undefined })).code,
    ).toBe(2);
    expect(noList.written[0]).toMatchObject({
      state: 'failure',
      description: expect.stringMatching(/^没查成/),
    });
  });

  it('主线推送：逐个算所有开着的 PR；关了的不写', async () => {
    const w = world({ open: [{ number: 80 }, { number: 81 }] });
    const r = await run(w, 'push', { ref: 'refs/heads/main' });
    expect(r.code).toBe(0);
    expect(w.written).toHaveLength(2);
    const closed = world({ open: [{ number: 80 }], prOver: { state: 'closed' } });
    expect((await run(closed, 'push', {})).lines).toEqual(['PR #80 已经关了，不算。']);
    expect(closed.written).toEqual([]);
  });

  it('第二意见状态：按 sha 找头是它、开着的 PR；别的 context 不算', async () => {
    const w = world({
      forCommit: [
        { number: 80, state: 'open', head: { sha: HEAD } },
        { number: 79, state: 'open', head: { sha: MERGE } },
        { number: 78, state: 'closed', head: { sha: HEAD } },
      ],
    });
    await run(w, 'status', { context: 'second-opinion', sha: HEAD, state: 'success' });
    expect(w.written.map((s) => s.sha)).toEqual([HEAD]);
    const other = world();
    expect(await run(other, 'status', { context: 'ci', sha: HEAD })).toEqual({
      code: 0,
      lines: ['这次没有要算的 PR。'],
    });
  });

  it('手动运行：填号算那一个，留空算全部', async () => {
    const w = world({ open: [{ number: 80 }, { number: 81 }] });
    await run(w, 'workflow_dispatch', { inputs: { pr: '80' } });
    expect(w.written).toHaveLength(1);
    await run(w, 'workflow_dispatch', { inputs: { pr: '' } });
    expect(w.written).toHaveLength(3);
  });

  it('只报不写（pr.yml）：能合 0、不能合 1、没查成 2，一条状态都不写', async () => {
    const ev = { pull_request: { number: 80 } };
    const ok = world();
    expect((await run(ok, 'pull_request', ev, { write: false })).code).toBe(0);
    expect((await run(world({ prOver: { draft: true } }), 'pull_request', ev, { write: false })).code).toBe(
      1,
    );
    expect((await run(world({ broken: { files: 'x' } }), 'pull_request', ev, { write: false })).code).toBe(2);
    expect(ok.written).toEqual([]);
  });

  it('故意坏掉的：事件读不到、认不出、事件名不认得、PR 列表读不到、手动填的号认不出、状态写不上、PR 都没读到', async () => {
    const w = world();
    const bad = await Promise.all([
      runMergeGate({
        eventName: undefined,
        eventPath: undefined,
        riskListText: RISK_TEXT,
        gh: w.gh,
        write: true,
      }),
      run(w, 'pull_request_target', '{不是 json'),
      run(w, 'pull_request_target', { issue: {} }),
      run(w, 'issue_comment', {}),
      run(world({ broken: { openPrs: '502' } }), 'push', {}),
      run(world({ broken: { prsForCommit: '502' } }), 'status', { context: 'second-opinion', sha: HEAD }),
      run(w, 'status', { context: 'second-opinion', sha: 'xyz' }),
      run(w, 'workflow_dispatch', { inputs: { pr: '#80' } }),
      run(world({ broken: { writeStatus: 'GitHub 回了 403' } }), 'pull_request_target', {
        pull_request: { number: 80 },
      }),
      run(world({ broken: { pr: 'GitHub 回了 502' } }), 'pull_request_target', {
        pull_request: { number: 80 },
      }),
    ]);
    for (const r of bad) expect(r.code).toBe(2);
    expect(bad[8]?.lines).toContain('  没写上状态（GitHub 回了 403）。');
    expect(bad[9]?.lines).toContain('  没写上状态：连 PR 的头都没读到。');
    expect(w.written).toEqual([]);
  });

  it('第二意见状态：PR 列表里有一条认不出，判没查成，不筛掉了当成没事', async () => {
    for (const junk of [
      { number: 80 },
      { number: 80, state: 'open', head: {} },
      { number: 82, state: 'open', head: { sha: 'abc' } },
      'x',
    ]) {
      const w = world({ forCommit: [{ number: 81, state: 'open', head: { sha: HEAD } }, junk] });
      const r = await run(w, 'status', { context: 'second-opinion', sha: HEAD });
      expect(r.code, JSON.stringify(junk)).toBe(2);
      expect(r.lines[0]).toMatch(/PR 列表里有一条认不出/);
      expect(w.written).toEqual([]);
    }
  });

  it('主线在这次运行里变了：不写回（旧结果不盖新结果）；读不到主线头：没查成、一条都不写', async () => {
    const moved = world({ open: [{ number: 80 }, { number: 81 }], mains: [MAIN, MAIN, MERGE] });
    const r = await run(moved, 'push', {});
    expect(r.code).toBe(0);
    expect(moved.written.map((x) => x.sha)).toEqual([HEAD]);
    expect(r.lines.at(-1)).toMatch(/^主线在这次运行里变了（ccccccc → bbbbbbb），剩下的不写回/);

    const blind = world({ broken: { mainHead: 'GitHub 回了 502' } });
    const b = await run(blind, 'pull_request_target', { pull_request: { number: 80 } });
    expect(b.code).toBe(2);
    expect(b.lines[0]).toMatch(/^没查成：读不到主线现在的头（GitHub 回了 502）/);
    expect(blind.written).toEqual([]);
  });
});

describe('读写 GitHub（假的 fetch）', () => {
  type Call = { url: string; method: string; body: unknown; auth: string | null };
  function fakeFetch(respond: (url: string, method: string) => { status?: number; json?: unknown }) {
    const calls: Call[] = [];
    const fn = (async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({
        url: String(url),
        method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        auth: new Headers(init?.headers).get('authorization'),
      });
      const r = respond(String(url), method);
      return new Response(r.json === undefined ? null : JSON.stringify(r.json), { status: r.status ?? 200 });
    }) as typeof fetch;
    return { fn, calls };
  }
  const env = {
    GITHUB_TOKEN: 'token-for-test',
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_API_URL: 'https://api.example/',
  };

  it('按仓拼地址，令牌只在请求头；404 在问「在不在」时回 null；写状态发 JSON', async () => {
    const f = fakeFetch((url) => (url.includes('/contents/') ? { status: 404 } : { json: { number: 80 } }));
    const gh = gateGitHub(ghApi(env, f.fn));
    await expect(gh.pr(80)).resolves.toEqual({ number: 80 });
    expect(f.calls[0]).toMatchObject({
      url: 'https://api.example/repos/o/r/pulls/80',
      auth: 'Bearer token-for-test',
    });
    await expect(gh.exists('specs/74-合并检查上GitHub', HEAD)).resolves.toBe(false);
    expect(f.calls[1]?.url).toBe(
      `https://api.example/repos/o/r/contents/specs/${encodeURIComponent('74-合并检查上GitHub')}?ref=${HEAD}`,
    );
    await expect(gh.fileAt('docs/plan.md', HEAD)).resolves.toBeNull();
    await gh.writeStatus(HEAD, { state: 'failure', description: '是草稿', targetUrl: 'https://x' });
    expect(f.calls.at(-1)).toMatchObject({
      url: `https://api.example/repos/o/r/statuses/${HEAD}`,
      method: 'POST',
      body: { state: 'failure', context: 'merge-gate', description: '是草稿', target_url: 'https://x' },
    });
  });

  it('文件内容按 base64 解开；不是文件的认不出', async () => {
    const content = Buffer.from('# 计划', 'utf8').toString('base64');
    const ok = gateGitHub(
      ghApi(env, fakeFetch(() => ({ json: { type: 'file', encoding: 'base64', content } })).fn),
    );
    await expect(ok.fileAt('docs/plan.md', HEAD)).resolves.toBe('# 计划');
    const dir = gateGitHub(ghApi(env, fakeFetch(() => ({ json: [] })).fn));
    await expect(dir.fileAt('docs', HEAD)).rejects.toThrow('docs 读回来认不出');
  });

  it('改动文件翻页读全，状态、改动内容、改名前的名字都收；认不出的一条抛', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}`, status: 'modified' }));
    const f = fakeFetch((url) =>
      url.endsWith('&page=1')
        ? { json: page1 }
        : {
            json: [
              { filename: 'new.ts', status: 'renamed', previous_filename: 'deploy/old.sh', patch: '+x' },
            ],
          },
    );
    const got = await gateGitHub(ghApi(env, f.fn)).files(80);
    expect(got).toHaveLength(101);
    expect(got[100]).toEqual({
      filename: 'new.ts',
      status: 'renamed',
      previous: 'deploy/old.sh',
      patch: '+x',
    });
    const bad = gateGitHub(ghApi(env, fakeFetch(() => ({ json: [{ name: 'x' }] })).fn));
    await expect(bad.files(80)).rejects.toThrow('没有 filename、status');
    const notList = gateGitHub(ghApi(env, fakeFetch(() => ({ json: { message: 'x' } })).fn));
    await expect(notList.files(80)).rejects.toThrow('不是列表');
  });

  it('提交状态翻页读全；sha 对不上、少了、认不出都抛', async () => {
    const one = (page: number) => ({
      sha: HEAD,
      total_count: 2,
      statuses: [{ context: `c${page}`, state: 'success' }],
    });
    const f = fakeFetch((url) => ({ json: one(url.endsWith('&page=1') ? 1 : 2) }));
    await expect(gateGitHub(ghApi(env, f.fn)).statuses(HEAD)).resolves.toHaveLength(2);
    const other = fakeFetch(() => ({ json: { ...one(1), sha: MERGE } }));
    await expect(gateGitHub(ghApi(env, other.fn)).statuses(HEAD)).rejects.toThrow('读回来的是 bbbbbbb');
    const short = fakeFetch(() => ({ json: { sha: HEAD, total_count: 5, statuses: [] } }));
    await expect(gateGitHub(ghApi(env, short.fn)).statuses(HEAD)).rejects.toThrow('只读到 0 条');
    const junk = fakeFetch(() => ({ json: [] }));
    await expect(gateGitHub(ghApi(env, junk.fn)).statuses(HEAD)).rejects.toThrow('认不出');
  });

  it('提交关联的 PR 翻页读完；某一页认不出、翻不完都抛（调用方判没查成）', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ number: i + 1 }));
    const f = fakeFetch((url) => (url.endsWith('&page=1') ? { json: page1 } : { json: [{ number: 999 }] }));
    const got = await gateGitHub(ghApi(env, f.fn)).prsForCommit(HEAD);
    expect(got).toHaveLength(101);
    expect(got.at(-1)).toEqual({ number: 999 });
    const junk = fakeFetch((url) => (url.endsWith('&page=1') ? { json: page1 } : { json: { message: 'x' } }));
    await expect(gateGitHub(ghApi(env, junk.fn)).prsForCommit(HEAD)).rejects.toThrow('第 2 页认不出');
    const endless = fakeFetch(() => ({ json: page1 }));
    await expect(gateGitHub(ghApi(env, endless.fn)).prsForCommit(HEAD)).rejects.toThrow('没读完');
  });

  it('主线头：先问默认分支再读它的头；认不出的抛', async () => {
    const answer = (repo: unknown, ref: unknown) =>
      fakeFetch((url) => (url.endsWith('/repos/o/r') ? { json: repo } : { json: ref }));
    const ok = answer({ default_branch: 'main' }, { object: { sha: MAIN } });
    await expect(gateGitHub(ghApi(env, ok.fn)).mainHead()).resolves.toBe(MAIN);
    expect(ok.calls.map((c) => c.url)).toEqual([
      'https://api.example/repos/o/r',
      'https://api.example/repos/o/r/git/ref/heads/main',
    ]);
    await expect(gateGitHub(ghApi(env, answer({}, {}).fn)).mainHead()).rejects.toThrow(
      'default_branch 认不出',
    );
    await expect(
      gateGitHub(ghApi(env, answer({ default_branch: 'main' }, { object: {} }).fn)).mainHead(),
    ).rejects.toThrow('主线 main 的头认不出');
  });

  it('没有令牌、没有仓名、GitHub 回错都抛，报错里不带令牌', async () => {
    const ok = fakeFetch(() => ({ json: {} })).fn;
    const errors = await Promise.all([
      ghApi(env, fakeFetch(() => ({ status: 500 })).fn)
        .get('/pulls/1')
        .catch((e: Error) => e.message),
      ghApi({ ...env, GITHUB_TOKEN: '' }, ok)
        .get('/pulls/1')
        .catch((e: Error) => e.message),
      ghApi({ ...env, GITHUB_REPOSITORY: undefined }, ok)
        .get('/pulls/1')
        .catch((e: Error) => e.message),
      ghApi(env, fakeFetch(() => ({ status: 403 })).fn)
        .post('/statuses/x', {})
        .catch((e: Error) => e.message),
      ghApi(env, fakeFetch(() => ({ status: 500 })).fn)
        .getOrNull('/contents/x')
        .catch((e: Error) => e.message),
    ]);
    expect(errors).toEqual([
      'GitHub 回了 500（GET /pulls/1）',
      '没有 GITHUB_TOKEN',
      '没有 GITHUB_REPOSITORY（owner/名字）',
      'GitHub 回了 403（POST /statuses/x）',
      'GitHub 回了 500（GET /contents/x）',
    ]);
    for (const m of errors) expect(m).not.toContain('token-for-test');
  });
});
