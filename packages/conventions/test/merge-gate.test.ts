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
  { path: 'deploy/', kind: '碰安全', why: '真机' },
  { path: 'packages/api/src/auth.ts', kind: '碰安全', why: '登录' },
];
const RISK_TEXT = JSON.stringify({ paths: RISK });

function body(tier: string | null): string {
  return [
    '**做了什么**：试一下',
    '**这个 PR 做完就关单**：否',
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
  /** 每次读主线头依次回这些，读完了一直回最后一个。 */
  mains: string[];
  /** files 里这几个是删掉的（status removed）。 */
  removed: string[];
  /** 读了几次改动文件。 */
  filesReads: number;
}

function world(
  over: Partial<World> & { prOver?: Record<string, unknown> } = {},
): World & { gh: GitHubReads } {
  const w: World = {
    pr: {
      number: 80,
      title: '试一下',
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
    mains: [MAIN],
    removed: [],
    filesReads: 0,
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
      w.filesReads += 1;
      boom('files');
      return w.files.map((filename) => ({
        filename,
        status: w.removed.includes(filename) ? 'removed' : 'modified',
      }));
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

const baseWorld = world;

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
      '提醒：正文里认不出「这个 PR 做完就关单」一栏',
    ]);
  });

  it('⑤ 改到先审后合的路径、当前头没有第二意见 → 不通过，报出文件；档位写什么都一样（按路径判）', async () => {
    const files = ['deploy/france.sh', 'docs/x.md'];
    for (const tier of ['先审后合——改部署', '直接合——小改', null]) {
      const r = await gatePr(80, deps(world({ files, prOver: { body: body(tier) } })));
      expect(r.state, String(tier)).toBe('failure');
      expect(r.lines[0]).toMatch(
        /^等第二意见：当前头 aaaaaaa 上还没有 second-opinion 状态，改到了先审后合的地方：deploy\/france\.sh（碰安全）/,
      );
    }
    const passed = await gatePr(80, deps(world({ files, statuses: SO_OK })));
    expect(passed.state).toBe('success');
    expect(passed.lines[0]).toBe('能合：不是草稿、没冲突，改到 1 个先审后合的地方，当前头上第二意见已通过。');
  });

  it('没改到先审后合的地方：档位写「先审后合」也不等第二意见', async () => {
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

const ENGINE_BOT = { login: 'fleet-dao-engine[bot]', id: 7, type: 'Bot' };
const claimStatus = (state: string, description: string, creator: unknown = ENGINE_BOT) => ({
  context: '认领对得上',
  state,
  description,
  creator,
});
const claimOk = (n: number) => claimStatus('success', `#${n} 归 本机/w1，认领号对得上（0f0e0d0c）`);
const linkedBody = (n: number) =>
  body('CI 绿就合——只改文档').replace(
    '**这个 PR 做完就关单**：否',
    `**需求**：#${n}\n**这个 PR 做完就关单**：否`,
  );

describe('合并闸：挂了单的 PR 要有引擎机器人贴的、通过的「认领对得上」（#348）', () => {
  const linked = (over: Parameters<typeof world>[0] = {}) =>
    world({ ...over, prOver: { body: linkedBody(12), ...over.prOver } });

  it('没挂单：不看这个状态，也不为它读提交状态', async () => {
    const r = await gatePr(80, deps(world({ broken: { statuses: '不该读' } })));
    expect(r.state).toBe('success');
  });

  it('挂了单、当前头上最新的是引擎贴的通过：通过，结论里写上', async () => {
    const r = await gatePr(80, deps(linked({ statuses: [claimOk(12)] })));
    expect(r.state).toBe('success');
    expect(r.lines[0]).toBe('能合：不是草稿、没冲突，没改到先审后合的地方，#12 的认领对得上。');
  });

  it('标题里的 (#12) 也算挂了单（和 pr-labels 同一个认法）', async () => {
    const r = await gatePr(80, deps(world({ prOver: { title: '修一下 (#12)' } })));
    expect(r.state).toBe('failure');
    expect(r.lines[0]).toMatch(/^等「认领对得上」：PR 挂了 #12/);
  });

  it('【故意造出的失败】挂了单、当前头上还没有：不通过，等引擎贴', async () => {
    const r = await gatePr(80, deps(linked()));
    expect(r).toMatchObject({ state: 'failure', notChecked: false });
    expect(r.lines[0]).toBe(
      '等「认领对得上」：PR 挂了 #12，当前头 aaaaaaa 上还没有引擎机器人贴的这个状态；引擎收到 PR 事件就贴（漏了的每 15 分钟对账补上），贴上合并闸自动重算。',
    );
  });

  it('【故意造出的失败】旧认领号（引擎判的 failure）：不通过，把引擎说的原因带出来', async () => {
    const why = '#12 现在归 本机/w2（认领 1a2b3c4d），PR 上写的是 0f0e0d0c；不是这份认领的 PR 合不进去';
    const r = await gatePr(80, deps(linked({ statuses: [claimStatus('failure', why)] })));
    expect(r.state).toBe('failure');
    expect(r.lines[0]).toBe(`认领对不上（当前头 aaaaaaa 上引擎贴的「认领对得上」是 failure）：${why}。`);
  });

  it('【故意造出的失败】不是引擎机器人贴的（有推送权限的人也贴得出同名的状态）：不认，不通过', async () => {
    const noCreator = { context: '认领对得上', state: 'success', description: '#12 随便' };
    for (const status of [
      claimStatus('success', '#12 随便', { login: 'someone', id: 1, type: 'User' }),
      claimStatus('success', '#12 随便', { login: 'fleet-dao-engine[bot]', id: 1, type: 'User' }),
      claimStatus('success', '#12 随便', { login: 'fleet-dao-agent[bot]', id: 2, type: 'Bot' }),
      claimStatus('success', '#12 随便', null),
      noCreator,
    ]) {
      const r = await gatePr(80, deps(linked({ statuses: [status] })));
      expect(r.state, JSON.stringify(status)).toBe('failure');
      expect(r.lines[0]).toMatch(/最新的「认领对得上」不是引擎机器人贴的，不认/);
    }
  });

  it('【故意造出的失败】最新的一条说了算：引擎贴过通过，后来别人贴的同名状态照样不认', async () => {
    const fake = claimStatus('success', '#12 我说行', { login: 'someone', id: 1, type: 'User' });
    const r = await gatePr(80, deps(linked({ statuses: [fake, claimOk(12)] })));
    expect(r.state).toBe('failure');
    // 反过来：引擎的在最新，前面别人贴过的不影响
    expect((await gatePr(80, deps(linked({ statuses: [claimOk(12), fake] })))).state).toBe('success');
  });

  it('【故意造出的失败】按旧正文判的（说明开头不是现在挂的单）：不通过，等引擎按新正文重判', async () => {
    const r = await gatePr(80, deps(world({ prOver: { body: linkedBody(20) }, statuses: [claimOk(12)] })));
    expect(r.state).toBe('failure');
    expect(r.lines[0]).toMatch(/^「认领对得上」是按旧正文判的（#12 归 本机\/w1.*），PR 现在挂的是 #20/);
    const unlinkedBefore = claimStatus('success', '没挂单，不查认领');
    expect((await gatePr(80, deps(linked({ statuses: [unlinkedBefore] })))).state).toBe('failure');
  });

  it('还是 pending：不通过', async () => {
    const r = await gatePr(80, deps(linked({ statuses: [claimStatus('pending', '#12 在判')] })));
    expect(r.state).toBe('failure');
    expect(r.lines[0]).toMatch(/^等「认领对得上」：当前头 aaaaaaa 上的还是 pending/);
  });

  it('【故意造出的失败】状态认不出、读不到、标题认不出：没查成，不当成对得上', async () => {
    const odd = await gatePr(80, deps(linked({ statuses: [claimStatus('通过', '#12')] })));
    expect(odd).toMatchObject({ state: 'failure', notChecked: true });
    expect(odd.lines[0]).toMatch(/提交状态认不出：认领对得上 的 state「通过」认不出/);
    const blind = await gatePr(80, deps(linked({ broken: { statuses: '502' } })));
    expect(blind).toMatchObject({ state: 'failure', notChecked: true });
    const noTitle = await gatePr(80, deps(world({ prOver: { title: null } })));
    expect(noTitle).toMatchObject({ state: 'failure', notChecked: true });
    expect(noTitle.lines[0]).toMatch(/标题认不出，没法判挂没挂单/);
  });
});

describe('合并闸：写了关单的 PR 要自己带那张单的结果（#325，创始人 2026-09-27 晚拍）', () => {
  const RESULT = 'specs/12-登录/结果.md';
  const closing = (column: string, tail: string) =>
    body('CI 绿就合——只改文档').replace(
      '**这个 PR 做完就关单**：否',
      `**需求**：#12\n**这个 PR 做完就关单**：${column}`,
    ) + (tail ? `\n\n${tail}` : '');
  // 这几条都挂了 #12：引擎贴好了通过的「认领对得上」，只看关单那一段
  const world = (over: Parameters<typeof baseWorld>[0] = {}) =>
    baseWorld({ statuses: [claimOk(12)], ...over });

  it('【故意造出的失败】正文写了 Closes #12、改动里没有 specs/12-*/结果.md：不通过，说清怎么补（改动前的合并闸照样放行）', async () => {
    const r = await gatePr(80, deps(world({ prOver: { body: closing('是', 'Closes #12') } })));
    expect(r).toMatchObject({ state: 'failure', notChecked: false });
    expect(r.lines).toEqual([
      '要关 #12 却没带 specs/12-<短名>/结果.md：结果写进这个 PR；结果不在这里写的，去掉 Closes #12、「这个 PR 做完就关单」改「否」，合完用 pnpm issue:close 12 关。',
    ]);
  });

  it('带了结果：通过（结果写在这个 PR 里、改名进来的都算）', async () => {
    const r = await gatePr(
      80,
      deps(world({ files: ['docs/x.md', RESULT], prOver: { body: closing('是', 'Closes #12') } })),
    );
    expect(r.state).toBe('success');
  });

  it('「这个 PR 做完就关单」写「否」、却在正文写了 fixes #12：GitHub 照样会关，照样要带结果', async () => {
    const r = await gatePr(80, deps(world({ prOver: { body: closing('否', '顺手 fixes #12') } })));
    expect(r.state).toBe('failure');
    expect(r.lines[0]).toMatch(/^要关 #12 却没带/);
  });

  it('结果是这个 PR 删掉的：不算带了', async () => {
    const w = world({ files: [RESULT], removed: [RESULT], prOver: { body: closing('是', 'Closes #12') } });
    expect((await gatePr(80, deps(w))).state).toBe('failure');
  });

  it('【故意造出的失败】填了「是」却一个关单词都没写：GitHub 不关，不通过（结果带了也一样）', async () => {
    const r = await gatePr(80, deps(world({ files: [RESULT], prOver: { body: closing('是', '') } })));
    expect(r.state).toBe('failure');
    expect(r.lines[0]).toBe(
      '「这个 PR 做完就关单」填了「是」，正文里却没写 Closes #<单号>：GitHub 只认关单词，不写合并了也不关；另起一行写上，还不关就改成「否」。',
    );
  });

  it('关好几张：每张都要带自己的结果，缺哪张报哪张', async () => {
    const r = await gatePr(
      80,
      deps(world({ files: [RESULT], prOver: { body: closing('是', 'Closes #12\nCloses #13') } })),
    );
    expect(r.state).toBe('failure');
    expect(r.lines).toEqual([expect.stringMatching(/^要关 #13 却没带 specs\/13-<短名>\/结果\.md/)]);
  });

  it('关单词写的是别的仓：不关这个仓的单，不挡', async () => {
    const r = await gatePr(
      80,
      deps(
        world({
          prOver: { body: closing('否', 'fixes other/repo#12'), base: { repo: { full_name: 'o/r' } } },
        }),
      ),
    );
    expect(r.state).toBe('success');
  });

  it('引擎开的 PR（「否」、关单词改成了「关联」）、不关单的 PR：这一段不多读改动文件，照常通过', async () => {
    const w = world({ prOver: { body: closing('否（引擎合并后第 7 步自己关单）', '关联 #12') } });
    expect((await gatePr(80, deps(w, '读不到'))).lines.filter((l) => l.includes('#12'))).toEqual([]);
    expect(w.filesReads).toBe(0);
  });

  it('【故意造出的失败】要关单、改动文件读不到或读不全：没查成，不当成带了', async () => {
    const broken = await gatePr(
      80,
      deps(world({ broken: { files: 'GitHub 回 502' }, prOver: { body: closing('是', 'Closes #12') } })),
    );
    expect(broken).toMatchObject({ state: 'failure', notChecked: true });
    expect(broken.lines).toContain(
      '没查成：读不到 PR #80 改了哪些文件（GitHub 回 502），没法判要关的 #12 带没带结果。',
    );
    const partial = await gatePr(
      80,
      deps(world({ files: [RESULT], prOver: { changed_files: 3, body: closing('是', 'Closes #12') } })),
    );
    expect(partial).toMatchObject({ state: 'failure', notChecked: true });
    expect(partial.lines).toContain(
      '没查成：PR #80 改了 3 个文件，只读到 1 个，没法判要关的 #12 带没带结果。',
    );
  });

  it('PR 读回来正文认不出：认不出要关哪几张、挂没挂单，没查成', async () => {
    const r = await gatePr(80, deps(world({ prOver: { body: 42 } })));
    expect(r).toMatchObject({ state: 'failure', notChecked: true });
    expect(r.lines).toContain('没查成：PR #80 的正文认不出，没法判它要关哪几张单。');
    expect(r.lines).toContain('没查成：PR #80 的正文认不出，没法判挂没挂单、要不要看「认领对得上」。');
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

  it.each(cases)('%s：没改到先审后合的地方照样通过，提醒里写明没查成', async (_name, over, line) => {
    const r = await gatePr(80, deps(world(over)));
    expect(r.state).toBe('success');
    expect(r.lines.join('\n')).toMatch(line);
  });

  it('改到先审后合的地方、没有第二意见：提醒那一半坏了照样不通过', async () => {
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

  it('第二意见、「认领对得上」状态：开着的 PR 全重算（不只事件里那个头的）；别的 context 不算', async () => {
    const w = world({ open: [{ number: 80 }, { number: 81 }] });
    await run(w, 'status', { context: 'second-opinion', sha: HEAD, state: 'success' });
    expect(w.written).toHaveLength(2);
    // 【故意造出的失败】#351 演练：一轮对账给几个 PR 贴状态，排队组只留最后一次运行、事件里是最后那个 PR 的头——
    // 只算那一个的话，另一个 PR 就一直停在「等认领对得上」；全重算了两个都写上
    await run(w, 'status', { context: '认领对得上', sha: MERGE, state: 'success' });
    expect(w.written).toHaveLength(4);
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

  it('只报不写（--no-write）：能合 0、不能合 1、没查成 2，一条状态都不写', async () => {
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
      run(world({ broken: { openPrs: '502' } }), 'status', { context: 'second-opinion', sha: HEAD }),
      run(w, 'workflow_dispatch', { inputs: { pr: 'x' } }),
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

  it('提交状态读逐条的列表（带 creator：「认领对得上」要看是谁贴的），翻页读全；认不出、翻不完都抛', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ context: `c${i}`, state: 'success' }));
    const f = fakeFetch((url) =>
      url.endsWith('&page=1') ? { json: page1 } : { json: [{ context: 'last', state: 'success' }] },
    );
    await expect(gateGitHub(ghApi(env, f.fn)).statuses(HEAD)).resolves.toHaveLength(101);
    expect(f.calls[0]?.url).toBe(
      `https://api.example/repos/o/r/commits/${HEAD}/statuses?per_page=100&page=1`,
    );
    const junk = fakeFetch(() => ({ json: { sha: HEAD, total_count: 0, statuses: [] } }));
    await expect(gateGitHub(ghApi(env, junk.fn)).statuses(HEAD)).rejects.toThrow('第 1 页认不出（不是列表）');
    const endless = fakeFetch(() => ({ json: page1 }));
    await expect(gateGitHub(ghApi(env, endless.fn)).statuses(HEAD)).rejects.toThrow('没读完');
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
