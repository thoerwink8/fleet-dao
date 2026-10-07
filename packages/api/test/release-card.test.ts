// /api/france/release-card（#1231，「发版」卡）：主线最新提交和 CI、法国在用的提交、差几个、最近做完的一个任务。
// 故意造出的失败（每条都核「没查成 + 原因」，不拿空、0、「已是最新」顶）：相差 0 个（写「已经是最新」）、相差多个、
// 读不到 GitHub、读不到法国在用的提交、compare 回不是前后关系、最近合并的 PR 读不到、关的单读不到、读超时、没接上。
import type { ReleaseFactsReader } from '@fleet-dao/github';
import { ReleaseCardSchema, ReleasedCommitsSchema, WEB_API_PREFIX, WebRoutes } from '@fleet-dao/shared';
import type { MemoryData } from '@fleet-dao/store';
import { devFixtures } from '@fleet-dao/store';
import { describe, expect, it } from 'vitest';
import {
  buildReleaseCard,
  buildReleasedCommits,
  closesOf,
  deployedAtFromHistory,
  prsFromTitles,
  type ReleaseCardPort,
  releasedFromHistory,
} from '../src/release-card.ts';
import { harness, T0 } from './harness.ts';

const PATH = WEB_API_PREFIX + WebRoutes.franceReleaseCard.path;
const SELF = {
  id: 'a0000000-0000-4000-8000-0000000000fd',
  owner: 'thoerwink8',
  name: 'fleet-dao',
  defaultBranch: 'main',
  testCommand: 'pnpm check',
};
const HEAD = `2005b290${'a'.repeat(32)}`;
const LIVE = `6896b3cb${'b'.repeat(32)}`;
const AT = '2026-10-07T10:00:00.000Z';

function withSelf(): Partial<MemoryData> {
  const data = devFixtures(T0);
  return { ...data, repos: [...(data.repos ?? []), SELF] };
}

function facts(over: Partial<ReleaseFactsReader> = {}): ReleaseFactsReader {
  return {
    async mainlineHead() {
      return { sha: HEAD, title: '刷新 CI 测试耗时表 (#1230)', committedAt: AT };
    },
    async commit(_repo, sha) {
      return { sha, title: '探针每次结论落一条历史 (#1225)', committedAt: AT };
    },
    async mainCi() {
      return { state: 'green', detail: '' };
    },
    async compare() {
      return {
        status: 'ahead',
        aheadBy: 7,
        recent: [
          { sha: 'c1', title: '刷新 CI 测试耗时表 (#1230)' },
          { sha: 'c2', title: '单任务暂停 (#1229)' },
          { sha: 'c3', title: '手工推的提交' },
          { sha: 'c4', title: '额度读取 (#1228)' },
          { sha: 'c5', title: '耗时表 (#1226)' },
          { sha: 'c6', title: '路由 (#1224)' },
          { sha: 'c7', title: '再早的 (#1223)' },
        ],
      };
    },
    async lastMergedPull() {
      return { number: 1230, title: '刷新 CI 测试耗时表', body: '## 需求\nCloses #1192\n', mergedAt: AT };
    },
    async issueTitle(_repo, number) {
      return { number, title: '引擎每周刷新 CI 测试耗时表' };
    },
    ...over,
  };
}

function port(over: Partial<ReleaseCardPort> = {}, f: Partial<ReleaseFactsReader> = {}): ReleaseCardPort {
  return {
    facts: facts(f),
    deployed: () => ({ sha: LIVE }),
    deployedAt: async () => '2026-10-07T05:00:00.000Z',
    ...over,
  };
}

async function card(p: ReleaseCardPort | undefined, opts: { timeoutMs?: number } = {}) {
  const h = harness({ data: withSelf() });
  return buildReleaseCard({ port: p, store: h.store, now: () => T0, ...opts });
}

describe('发版卡：四行都读到', () => {
  it('相差多个：差 7 个，列最近 5 个 PR（不是 PR 合并的只数个数），主线 CI 绿，最近做完的任务带它关的单', async () => {
    const c = await card(port());
    expect(c.mainline).toEqual({
      state: 'ok',
      commit: { sha: HEAD, short: HEAD.slice(0, 12), title: '刷新 CI 测试耗时表 (#1230)', at: AT },
      ci: { state: 'green' },
    });
    expect(c.deployed).toEqual({
      state: 'ok',
      sha: LIVE,
      short: LIVE.slice(0, 12),
      title: '探针每次结论落一条历史 (#1225)',
      titleWhy: null,
      deployedAt: '2026-10-07T05:00:00.000Z',
      deployedAtWhy: null,
    });
    expect(c.gap).toEqual({
      state: 'ahead',
      count: 7,
      prs: [
        { number: 1230, title: '刷新 CI 测试耗时表' },
        { number: 1229, title: '单任务暂停' },
        { number: 1228, title: '额度读取' },
        { number: 1226, title: '耗时表' },
        { number: 1224, title: '路由' },
      ],
      nonPr: 1,
    });
    expect(c.lastDone).toEqual({
      state: 'ok',
      pr: { number: 1230, title: '刷新 CI 测试耗时表', mergedAt: AT },
      issue: { state: 'ok', number: 1192, title: '引擎每周刷新 CI 测试耗时表', alsoCloses: [] },
    });
    expect(ReleaseCardSchema.safeParse(c).success).toBe(true);
  });

  it('相差 0 个：写「已经是最新」，不去比较、不画差几个', async () => {
    let compared = 0;
    const c = await card(
      port(
        { deployed: () => ({ sha: HEAD }) },
        {
          async compare() {
            compared += 1;
            throw new Error('不该调');
          },
        },
      ),
    );
    expect(c.gap).toEqual({ state: 'same' });
    expect(compared).toBe(0);
  });

  it('主线 CI 红了：带哪一项；还在跑：带说明', async () => {
    const red = await card(port({}, { mainCi: async () => ({ state: 'red', detail: 'failure：单测红' }) }));
    expect(red.mainline).toMatchObject({ state: 'ok', ci: { state: 'red', detail: 'failure：单测红' } });
    const pending = await card(
      port({}, { mainCi: async () => ({ state: 'pending', detail: '汇总检查还在跑' }) }),
    );
    expect(pending.mainline).toMatchObject({ state: 'ok', ci: { state: 'pending' } });
  });

  it('PR 没写 Closes：issue 写 none（不编单号）；写了几张取第一张、其余列出', async () => {
    const none = await card(
      port({}, { lastMergedPull: async () => ({ number: 5, title: 't', body: '没有关单', mergedAt: AT }) }),
    );
    expect(none.lastDone).toMatchObject({ state: 'ok', issue: { state: 'none' } });
    const two = await card(
      port(
        {},
        {
          lastMergedPull: async () => ({ number: 5, title: 't', body: 'Closes #7\nCloses #9', mergedAt: AT }),
        },
      ),
    );
    expect(two.lastDone).toMatchObject({ state: 'ok', issue: { state: 'ok', number: 7, alsoCloses: [9] } });
  });
});

describe('发版卡：故意造出的失败，每行各自写没查成 + 原因', () => {
  it('读不到 GitHub：主线、差几个、最近做完三行没查成并带原因；法国在用的那行照常（它不靠 GitHub 读提交号）', async () => {
    const boom = async (): Promise<never> => {
      throw new Error('GitHub 机器人的凭据没读到');
    };
    const c = await card(
      port({}, { mainlineHead: boom, commit: boom, mainCi: boom, compare: boom, lastMergedPull: boom }),
    );
    expect(c.mainline).toEqual({ state: 'unreadable', why: '读主线头失败：GitHub 机器人的凭据没读到' });
    expect(c.gap).toMatchObject({ state: 'unreadable' });
    if (c.gap.state === 'unreadable') expect(c.gap.why).toContain('主线头');
    expect(c.lastDone).toEqual({
      state: 'unreadable',
      why: '读主线最近合并的 PR 失败：GitHub 机器人的凭据没读到',
    });
    // 法国在用的提交号读到了，标题读不到就各自写原因，不拿空串顶
    expect(c.deployed).toMatchObject({
      state: 'ok',
      sha: LIVE,
      title: null,
      titleWhy: '读它的标题失败：GitHub 机器人的凭据没读到',
    });
  });

  it('读不到法国在用的提交：那一行没查成，「差几个」不画成 0 也不写「已是最新」', async () => {
    const c = await card(port({ deployed: () => ({ error: 'EACCES: permission denied' }) }));
    expect(c.deployed).toEqual({
      state: 'unreadable',
      why: '读法国在用的提交失败：EACCES: permission denied',
    });
    expect(c.gap.state).toBe('unreadable');
    if (c.gap.state === 'unreadable') expect(c.gap.why).toContain('法国在用的提交');
    expect(c.mainline.state).toBe('ok');
  });

  it('法国还没发布过（current 不在）和在用的提交号认不出：都没查成、写原因', async () => {
    const none = await card(port({ deployed: () => ({ sha: null }) }));
    expect(none.deployed).toMatchObject({
      state: 'unreadable',
      why: expect.stringContaining('还没有发布过'),
    });
    expect(none.gap.state).toBe('unreadable');
    const bad = await card(port({ deployed: () => ({ sha: 'abc123' }) }));
    expect(bad.deployed).toMatchObject({ state: 'unreadable', why: expect.stringContaining('不是 40 位') });
  });

  it('发布历史读不了：发于何时写没查成 + 原因，在用的提交照给；历史里没这个提交也写出来', async () => {
    const down = await card(
      port({
        deployedAt: async () => {
          throw new Error('ENOENT .history');
        },
      }),
    );
    expect(down.deployed).toMatchObject({
      state: 'ok',
      deployedAt: null,
      deployedAtWhy: '读发布历史失败：ENOENT .history',
    });
    const missing = await card(port({ deployedAt: async () => null }));
    expect(missing.deployed).toMatchObject({ state: 'ok', deployedAt: null });
    if (missing.deployed.state === 'ok')
      expect(missing.deployed.deployedAtWhy).toContain('没有这个提交的记录');
  });

  it('compare 回的不是前后关系（在用的不在主线上）：差几个写没查成，不硬画一个数', async () => {
    const c = await card(port({}, { compare: async () => ({ status: 'diverged', aheadBy: 3, recent: [] }) }));
    expect(c.gap).toMatchObject({ state: 'unreadable', why: expect.stringContaining('diverged') });
  });

  it('compare 读失败：差几个没查成，前两行不受连累', async () => {
    const c = await card(
      port(
        {},
        {
          compare: async () => {
            throw new Error('503');
          },
        },
      ),
    );
    expect(c.gap).toEqual({ state: 'unreadable', why: '比较法国在用的提交和主线头失败：503' });
    expect(c.mainline.state).toBe('ok');
    expect(c.deployed.state).toBe('ok');
  });

  it('主线头的 CI 读不到：CI 那一项没查成，提交那一半照给', async () => {
    const c = await card(
      port(
        {},
        {
          mainCi: async () => {
            throw new Error('403');
          },
        },
      ),
    );
    expect(c.mainline).toMatchObject({
      state: 'ok',
      ci: { state: 'unreadable', why: '读主线头的 CI 失败：403' },
    });
  });

  it('关的单读不到：PR 照给，单那一项写没查成 + 单号', async () => {
    const c = await card(
      port(
        {},
        {
          issueTitle: async () => {
            throw new Error('404');
          },
        },
      ),
    );
    expect(c.lastDone).toMatchObject({
      state: 'ok',
      pr: { number: 1230 },
      issue: { state: 'unreadable', number: 1192, why: '读 #1192 失败：404' },
    });
  });

  it('读超时：没读完的行写「N 秒没读完」，不一直等', async () => {
    const hang = () => new Promise<never>(() => {});
    const c = await card(port({}, { mainlineHead: hang, lastMergedPull: hang }), { timeoutMs: 30 });
    expect(c.mainline).toEqual({ state: 'unreadable', why: '读主线头失败：0.03 秒没读完' });
    expect(c.lastDone).toMatchObject({ state: 'unreadable', why: expect.stringContaining('没读完') });
  });

  it('这台后端没接上（开发、内存版）：四行都写没接上，不画「已是最新」', async () => {
    const c = await card(undefined);
    for (const row of [c.mainline, c.deployed, c.gap, c.lastDone]) {
      expect(row).toMatchObject({ state: 'unreadable', why: expect.stringContaining('没接上') });
    }
  });

  it('受管的仓里没有 fleet-dao：四行都没查成', async () => {
    const h = harness();
    const c = await buildReleaseCard({ port: port(), store: h.store, now: () => T0 });
    expect(c.mainline).toMatchObject({ state: 'unreadable', why: expect.stringContaining('fleet-dao') });
    expect(c.gap.state).toBe('unreadable');
  });
});

describe('GET /api/france/release-card', () => {
  it('登录后读得到，形状过校验', async () => {
    const h = harness({ data: withSelf(), releaseCard: port() });
    const { cookie } = await h.login();
    const res = await h.cockpit.request(PATH, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(ReleaseCardSchema.parse(await res.json()).gap.state).toBe('ahead');
  });

  it('没登录：401，不泄漏提交', async () => {
    const h = harness({ data: withSelf(), releaseCard: port() });
    const res = await h.cockpit.request(PATH);
    expect(res.status).toBe(401);
  });

  it('没接上：200，四行写没接上', async () => {
    const h = harness({ data: withSelf() });
    const { cookie } = await h.login();
    const res = await h.cockpit.request(PATH, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(ReleaseCardSchema.parse(await res.json()).mainline.state).toBe('unreadable');
  });
});

// —— 更新日志页「已发布的提交」（#1255，GET /api/france/released-commits）——

const RELEASED_PATH = WEB_API_PREFIX + WebRoutes.franceReleasedCommits.path;
const OLD = `3d9c0b1a${'d'.repeat(32)}`;
const HISTORY = [
  `2026-10-05T01:00:00Z ${OLD} release`,
  `2026-10-06T01:00:00Z ${LIVE} release`,
  `2026-10-06T02:00:00Z ${LIVE} unhealthy`,
  `2026-10-06T03:00:00Z ${HEAD} release unmerged`,
  `2026-10-06T04:00:00Z ${LIVE} rollback`,
  `2026-10-06T05:00:00Z ${LIVE} recovered`,
].join('\n');

async function released(p: ReleaseCardPort | undefined, opts: { timeoutMs?: number } = {}) {
  const h = harness({ data: withSelf() });
  return buildReleasedCommits({ port: p, store: h.store, now: () => T0, ...opts });
}

describe('已发布的提交：读到', () => {
  it('只取切上去的三种事件（发布、回滚、自动回滚），新的在前，每条带全号、短号、标题、时间', async () => {
    const r = await released(port({ history: async () => HISTORY }));
    if (r.state !== 'ok') throw new Error(`应该读到：${JSON.stringify(r)}`);
    expect(r.commits.map((c) => [c.sha, c.event, c.at])).toEqual([
      [LIVE, 'rollback', '2026-10-06T04:00:00Z'],
      [HEAD, 'release', '2026-10-06T03:00:00Z'],
      [LIVE, 'release', '2026-10-06T01:00:00Z'],
      [OLD, 'release', '2026-10-05T01:00:00Z'],
    ]);
    expect(r.commits[0]).toMatchObject({
      short: LIVE.slice(0, 12),
      title: '探针每次结论落一条历史 (#1225)',
      titleWhy: null,
    });
    expect(ReleasedCommitsSchema.safeParse(r).success).toBe(true);
  });

  it('历史是空的：读成了、一条都没有（不写没查成）', async () => {
    const r = await released(port({ history: async () => '' }));
    expect(r).toEqual({ state: 'ok', commits: [], asOf: T0.toISOString() });
  });

  it('同一个提交出现几次只去 GitHub 读一次标题；只列最近 20 条', async () => {
    let reads = 0;
    const many = Array.from(
      { length: 30 },
      (_, i) => `2026-10-06T${String(i % 24).padStart(2, '0')}:00:00Z ${LIVE} release`,
    ).join('\n');
    const r = await released(
      port(
        { history: async () => many },
        {
          async commit(_repo, sha) {
            reads += 1;
            return { sha, title: 't', committedAt: AT };
          },
        },
      ),
    );
    if (r.state !== 'ok') throw new Error('应该读到');
    expect(r.commits).toHaveLength(20);
    expect(reads).toBe(1);
  });
});

describe('已发布的提交：故意造出的失败照实说', () => {
  it('这台后端没接上发布历史（开发、内存版）：整份没查成 + 原因，不给空列表', async () => {
    for (const p of [undefined, port()]) {
      const r = await released(p);
      expect(r).toMatchObject({ state: 'unreadable', why: expect.stringContaining('没接上') });
      expect('commits' in r).toBe(false);
    }
  });

  it('读发布历史失败：整份没查成，写原因', async () => {
    const r = await released(
      port({
        history: async () => {
          throw new Error('ENOENT .history');
        },
      }),
    );
    expect(r).toMatchObject({ state: 'unreadable', why: '读法国发布历史失败：ENOENT .history' });
  });

  it('历史里有认不出的行（时间坏了、提交号不是 40 位）：整份没查成，不悄悄跳过', async () => {
    const badTime = await released(port({ history: async () => `坏时间 ${LIVE} release` }));
    expect(badTime).toMatchObject({ state: 'unreadable', why: expect.stringContaining('时间认不出') });
    const badSha = await released(port({ history: async () => '2026-10-06T01:00:00Z abc123 release' }));
    expect(badSha).toMatchObject({ state: 'unreadable', why: expect.stringContaining('不是 40 位') });
  });

  it('某一条的标题读不到：那一条 title 为 null、写原因，别的条照常', async () => {
    const r = await released(
      port(
        { history: async () => HISTORY },
        {
          async commit(_repo, sha) {
            if (sha === HEAD) throw new Error('403');
            return { sha, title: '好的标题', committedAt: AT };
          },
        },
      ),
    );
    if (r.state !== 'ok') throw new Error('应该读到');
    const head = r.commits.find((c) => c.sha === HEAD);
    expect(head).toMatchObject({ title: null, titleWhy: '读标题失败：403' });
    expect(r.commits.filter((c) => c.sha !== HEAD).every((c) => c.title === '好的标题')).toBe(true);
  });

  it('受管的仓里没有 fleet-dao：列表照给，每条标题写没查成和原因', async () => {
    const h = harness();
    const r = await buildReleasedCommits({
      port: port({ history: async () => HISTORY }),
      store: h.store,
      now: () => T0,
    });
    if (r.state !== 'ok') throw new Error('应该读到');
    expect(r.commits.length).toBeGreaterThan(0);
    for (const c of r.commits) {
      expect(c.title).toBeNull();
      expect(c.titleWhy).toContain('fleet-dao');
    }
  });

  it('读超时：写「N 秒没读完」，不一直等', async () => {
    const r = await released(port({ history: () => new Promise<never>(() => {}) }), { timeoutMs: 30 });
    expect(r).toMatchObject({ state: 'unreadable', why: expect.stringContaining('0.03 秒没读完') });
  });
});

describe('releasedFromHistory', () => {
  it('unhealthy、recovered 不算；后写的在前；limit 管条数', () => {
    expect(releasedFromHistory(HISTORY, 2).map((c) => c.event)).toEqual(['rollback', 'release']);
    expect(releasedFromHistory('')).toEqual([]);
  });

  it('只有 unhealthy 一行时不当成发布过', () => {
    expect(releasedFromHistory(`2026-10-06T02:00:00Z ${LIVE} unhealthy`)).toEqual([]);
  });
});

describe('GET /api/france/released-commits', () => {
  it('登录后读得到，形状过校验', async () => {
    const h = harness({ data: withSelf(), releaseCard: port({ history: async () => HISTORY }) });
    const { cookie } = await h.login();
    const res = await h.cockpit.request(RELEASED_PATH, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = ReleasedCommitsSchema.parse(await res.json());
    expect(body.state).toBe('ok');
  });

  it('没登录：401，不泄漏提交', async () => {
    const h = harness({ data: withSelf(), releaseCard: port({ history: async () => HISTORY }) });
    const res = await h.cockpit.request(RELEASED_PATH);
    expect(res.status).toBe(401);
  });

  it('没接上：200，整份写没接上（不是空列表）', async () => {
    const h = harness({ data: withSelf() });
    const { cookie } = await h.login();
    const res = await h.cockpit.request(RELEASED_PATH, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(ReleasedCommitsSchema.parse(await res.json()).state).toBe('unreadable');
  });
});

describe('小零件', () => {
  it('prsFromTitles：只认末尾的 (#号)，标题里间的 #号不算；超过 5 个只列 5 个', () => {
    expect(prsFromTitles([{ title: '修 #12 的问题' }, { title: '改 (#34) 之后 (#56)' }])).toEqual({
      prs: [{ number: 56, title: '改 (#34) 之后' }],
      nonPr: 1,
    });
    const many = Array.from({ length: 8 }, (_, i) => ({ title: `t${i} (#${100 + i})` }));
    expect(prsFromTitles(many).prs).toHaveLength(5);
  });

  it('closesOf：认 Closes/Fixes/Resolves，去重；正文里只是提到 #号不算', () => {
    expect(closesOf('Closes #5\nfixes #6, 另见 #7\nCloses #5')).toEqual([5, 6]);
    expect(closesOf('只是提到 #7')).toEqual([]);
  });

  it('deployedAtFromHistory：取这个提交最近一次切上去的时间；unhealthy、recovered 不算切版本；没有回 null；时间坏了抛错', () => {
    const h = [
      `2026-10-06T01:00:00Z ${LIVE} release`,
      `2026-10-06T02:00:00Z ${LIVE} unhealthy`,
      `2026-10-06T03:00:00Z ${HEAD} release unmerged`,
      `2026-10-06T04:00:00Z ${LIVE} rollback`,
      `2026-10-06T05:00:00Z ${LIVE} recovered`,
    ].join('\n');
    expect(deployedAtFromHistory(h, LIVE)).toBe('2026-10-06T04:00:00Z');
    expect(deployedAtFromHistory(h, 'c'.repeat(40))).toBeNull();
    expect(() => deployedAtFromHistory(`坏时间 ${LIVE} release`, LIVE)).toThrow(/不是时间/);
  });
});
