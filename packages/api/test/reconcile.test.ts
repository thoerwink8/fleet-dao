// 对账补漏：轮询、重投走 @fleet-dao/github 的真代码（对着照 GitHub 接口回话的假服务），
// 补回来的东西走真的 GitHubIntake（同一道门、同一本投递账），落到同一个 Store。
// 只收 PR 和 CI 的事件（issue、评论不收，#556）：单子由引擎每 5 分钟自己去 GitHub 上拉，对账不管它们。
import { generateKeyPairSync } from 'node:crypto';
import { type AppCredentials, createGitHub, memoryLedger } from '@fleet-dao/github';
import { describe, expect, it } from 'vitest';
import { devFixtures } from '../src/dev-fixtures.ts';
import { createGitHubIntake, githubEventsCheck, pollDeliveryId } from '../src/github.ts';
import type { MemoryData } from '../src/memory-store.ts';
import type { GitHubDelivery } from '../src/ports.ts';
import { MAX_AUTO_REPLAYS, reconcileGitHub, reconcilerOptions } from '../src/reconcile.ts';
import { deliverGithub as deliver, harness, T0 } from './harness.ts';

const API = 'https://api.github.test';
const SLUG = 'example/canary';
/** 第二个受管的仓（只在「有一个仓读不到」那条里用）。 */
const OTHER = 'example/other';
const OTHER_ID = 'a0000000-0000-4000-8000-000000000002';
const founderA = { login: 'founder-a', id: 1001, type: 'User' };
const stranger = { login: 'stranger', id: 4242, type: 'User' };
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000).toISOString().replace('.000Z', 'Z');
/** 这一轮往回看到这里。 */
const SINCE = new Date(T0.getTime() - 40 * 60_000);

let keys: Record<'agent' | 'engine', AppCredentials['privateKey']> | undefined;
function apps(): Record<'agent' | 'engine', AppCredentials> {
  keys ??= {
    agent: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey,
    engine: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey,
  };
  return {
    agent: { role: 'agent', appId: 101, slug: 'fleet-test-agent', privateKey: keys.agent, source: 'test' },
    engine: {
      role: 'engine',
      appId: 202,
      slug: 'fleet-test-engine',
      privateKey: keys.engine,
      source: 'test',
    },
  };
}

interface RepoState {
  pulls: Record<string, unknown>[];
}

interface GitHubState {
  repos: Record<string, RepoState>;
  /** GitHub 的投递日志（新的在前）。 */
  deliveries?: { id: number; guid: string; delivered_at: string; status_code: number; event: string }[];
  /** 设了就所有接口都这样回（读不到 GitHub）。 */
  down?: number;
  /** 这几个仓的接口一律 403（这几个仓读不到）。 */
  downRepos?: string[];
}

const empty = (): RepoState => ({ pulls: [] });

/**
 * 只答对账会问的几条：安装、令牌、PR 列表、投递日志和重投。别的路径一律 404——对账要是还去拉 issue、评论，
 * 这一轮就会算没做完，测试跟着红。
 */
function githubApi(state: GitHubState) {
  const redelivered: number[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    const reply = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (state.down) return reply(state.down, { message: 'Resource not accessible by integration' });
    const repoMatch = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(url.pathname);
    const slug = repoMatch?.[1];
    if (slug && state.downRepos?.includes(slug)) {
      return reply(403, { message: 'Resource not accessible by integration' });
    }
    if (url.pathname.endsWith('/installation')) return reply(200, { id: 1 });
    if (url.pathname.endsWith('/access_tokens')) {
      return reply(201, {
        token: 'test-installation-token',
        expires_at: '2099-01-01T00:00:00Z',
        permissions: {},
      });
    }
    const repo = slug ? state.repos[slug] : undefined;
    if (repo && repoMatch?.[2] === '/pulls') {
      // 和 GitHub 一样：按更新时间新的在前
      return reply(
        200,
        [...repo.pulls].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))),
      );
    }
    if (url.pathname === '/app/hook/deliveries') return reply(200, state.deliveries ?? []);
    const attempt = /^\/app\/hook\/deliveries\/(\d+)\/attempts$/.exec(url.pathname);
    if (attempt && method === 'POST') {
      redelivered.push(Number(attempt[1]));
      return reply(202, {});
    }
    return reply(404, { message: `假 GitHub 里没有 ${method} ${url.pathname}` });
  };
  return { fetchImpl, redelivered };
}

function pull(number: number, minutes: number, over: Record<string, unknown> = {}) {
  return {
    number,
    state: 'open',
    merged_at: null,
    updated_at: at(minutes),
    user: founderA,
    head: { ref: `fleet/${number}-a`, sha: 'a'.repeat(40), repo: { full_name: SLUG } },
    base: { ref: 'main', repo: { full_name: SLUG } },
    ...over,
  };
}

/** 库里已经有的一条投递（seed 进去，当作以前收过的）。 */
function stored(id: string, over: Partial<GitHubDelivery> & Pick<GitHubDelivery, 'payload'>): GitHubDelivery {
  return {
    id,
    event: 'pull_request',
    action: 'opened',
    source: 'webhook',
    repo: SLUG,
    versions: [],
    status: 'failed',
    reason: '镜像写不进去',
    attempts: 1,
    receivedAt: at(-10),
    claimedAt: at(-10),
    finishedAt: at(-10),
    ...over,
  };
}

const opened = (pr: object, sender: object = founderA) => ({
  action: 'opened',
  pull_request: pr,
  sender,
  repository: { full_name: SLUG },
});

function setup(state: GitHubState, data: Partial<MemoryData> = devFixtures(T0)) {
  const h = harness({ data });
  const intake = createGitHubIntake(h.deps);
  const api = githubApi(state);
  const gh = createGitHub({
    ledger: memoryLedger({
      repos: (data.repos ?? []).map((r) => ({ id: r.id, owner: r.owner, name: r.name })),
    }),
    apps: apps(),
    apiUrl: API,
    fetch: api.fetchImpl,
    now: () => T0,
    sleep: async () => {},
    env: {},
  });
  const reconciler = gh.reconciler(reconcilerOptions({ store: h.store, intake }));
  const run = () =>
    reconcileGitHub({ store: h.store, intake, reconciler, log: h.deps.log, now: () => T0 }, { since: SINCE });
  return { h, run, api };
}

describe('对账补漏', () => {
  it('对账补回一条漏的：webhook 漏掉的 PR 由轮询送进门；webhook 收过的同一版认得出，不重做', async () => {
    const seen = pull(5, -30);
    const missed = pull(6, -20);
    const { h, run } = setup({ repos: { [SLUG]: { pulls: [missed, seen] } } });
    await deliver(h, 'pull_request', opened(seen));
    expect(h.accepted.map((e) => e.event)).toEqual(['pull_request']);

    const result = await run();
    expect(result).toMatchObject({ outcome: 'ok', scanned: 1, found: 1 });
    expect(h.accepted).toHaveLength(2);
    expect(await h.store.getDelivery(pollDeliveryId(SLUG, 'pull', 6, missed.updated_at))).toMatchObject({
      source: 'poll',
      status: 'accepted',
    });
    // webhook 收过的那一版：轮询不再落一行、不再处理
    expect(await h.store.getDelivery(pollDeliveryId(SLUG, 'pull', 5, seen.updated_at))).toBeNull();

    // 再跑一轮：没有新的，查了、0 个
    expect(await run()).toMatchObject({ outcome: 'ok', scanned: 1, found: 0 });
    expect(h.accepted).toHaveLength(2);
  });

  it('审查把 PR 顶新：webhook 带过那一版，轮询认得出，不算漏收', async () => {
    const pr = pull(5, -15);
    const { h, run } = setup({ repos: { [SLUG]: { pulls: [pr] } } });
    await deliver(h, 'pull_request_review', {
      action: 'submitted',
      review: { user: founderA },
      pull_request: pr,
      sender: founderA,
      repository: { full_name: SLUG },
    });
    const result = await run();
    expect(result).toMatchObject({ outcome: 'ok', scanned: 1, found: 0 });
    expect(result.steps.find((s) => s.step === 'poll')).toMatchObject({ checked: 1, recovered: 0 });
  });

  it('issue、评论的事件门口不收：记成「不处理的事件」，不落工作、也不算补回（单子由引擎自己拉，#632）', async () => {
    const { h } = setup({ repos: { [SLUG]: empty() } });
    const res = await deliver(
      h,
      'issues',
      {
        action: 'opened',
        issue: { number: 40, title: 'x', state: 'open', created_at: at(-5), user: founderA },
        sender: founderA,
        repository: { full_name: SLUG },
      },
      { delivery: 'issue-1' },
    );
    expect(await res.json()).toMatchObject({ ok: true, verdict: 'ignored', reason: 'event_not_handled' });
    expect(await h.store.getDelivery('issue-1')).toMatchObject({
      status: 'ignored',
      reason: 'event_not_handled',
    });
    expect(h.accepted).toHaveLength(0);
  });

  it('库里出错、卡住的投递按原文重放；重放到头还不成的不再重放，报出来要人看', async () => {
    const data = devFixtures(T0);
    data.githubEvents = new Map([
      ['retry-me', stored('retry-me', { payload: opened(pull(44, -10)) })],
      ['hopeless', stored('hopeless', { payload: opened(pull(45, -10)), attempts: MAX_AUTO_REPLAYS })],
    ]);
    const { h, run } = setup({ repos: { [SLUG]: empty() } }, data);
    const result = await run();
    expect(await h.store.getDelivery('retry-me')).toMatchObject({ status: 'accepted', attempts: 2 });
    expect(h.accepted.map((e) => e.deliveryId)).toEqual(['retry-me']);
    expect(await h.store.getDelivery('hopeless')).toMatchObject({
      status: 'failed',
      attempts: MAX_AUTO_REPLAYS,
    });
    expect(result).toMatchObject({ outcome: 'ok', scanned: 1, found: 2 });
    expect(result.why).toContain(`重放了 ${MAX_AUTO_REPLAYS} 次都没成`);
    expect(result.why).toContain('hopeless');
    expect(h.logs.some((l) => l.level === 'warn' && l.message.includes('重放到头'))).toBe(true);
  });

  it('GitHub 投递日志里没送成的：库里有原文的不重投、交给重放（只算一次），库里没有的才叫 GitHub 重投', async () => {
    const data = devFixtures(T0);
    data.githubEvents = new Map([['g-stored', stored('g-stored', { payload: opened(pull(44, -10)) })]]);
    const { h, run, api } = setup(
      {
        repos: { [SLUG]: empty() },
        deliveries: [
          { id: 12, guid: 'g-missing', delivered_at: at(-5), status_code: 502, event: 'pull_request' },
          { id: 11, guid: 'g-stored', delivered_at: at(-10), status_code: 500, event: 'pull_request' },
        ],
      },
      data,
    );
    const result = await run();
    expect(api.redelivered).toEqual([12]);
    expect(result.steps.find((s) => s.step === 'redeliver')).toMatchObject({ outcome: 'ok', recovered: 1 });
    expect(result.steps.find((s) => s.step === 'replay')).toMatchObject({ recovered: 1 });
    expect(result).toMatchObject({ outcome: 'ok', found: 2 });
    expect(await h.store.getDelivery('g-stored')).toMatchObject({ status: 'accepted' });
  });

  it('重放后不收的（门挡掉）处理完了，但不算补回', async () => {
    const data = devFixtures(T0);
    data.githubEvents = new Map([
      [
        'from-stranger',
        stored('from-stranger', {
          payload: opened(pull(47, -10, { user: stranger }), stranger),
        }),
      ],
    ]);
    const { h, run } = setup({ repos: { [SLUG]: empty() } }, data);
    const result = await run();
    expect(await h.store.getDelivery('from-stranger')).toMatchObject({
      status: 'ignored',
      reason: 'author_not_whitelisted',
    });
    expect(result.steps.find((s) => s.step === 'replay')).toMatchObject({ checked: 1, recovered: 0 });
    expect(result).toMatchObject({ outcome: 'ok', found: 0 });
  });

  it('几个仓里有一个读不到：这一轮算做了一部分（partial），查成的照样补', async () => {
    const data = devFixtures(T0);
    data.repos = [
      ...(data.repos ?? []),
      { id: OTHER_ID, owner: 'example', name: 'other', defaultBranch: 'main', testCommand: 'pnpm check' },
    ];
    const { h, run } = setup(
      { repos: { [SLUG]: { pulls: [pull(48, -10)] }, [OTHER]: empty() }, downRepos: [OTHER] },
      data,
    );
    const result = await run();
    expect(result).toMatchObject({ outcome: 'partial', scanned: 1, found: 1 });
    expect(result.why).toContain('example/other');
    expect(h.accepted.map((e) => e.deliveryId)).toEqual([
      pollDeliveryId(SLUG, 'pull', 48, pull(48, -10).updated_at),
    ]);
  });

  it('GitHub 读不到：这一轮报没查成（unscanned），不报 ok', async () => {
    const { run } = setup({ repos: { [SLUG]: empty() }, down: 403 });
    const result = await run();
    expect(result).toMatchObject({ outcome: 'unscanned', scanned: 0, found: 0 });
    expect(result.why).toContain('轮询 example/canary 没做完');
  });

  it('没有受管的仓：没查成（unscanned），写明为什么', async () => {
    const data = devFixtures(T0);
    data.repos = [];
    data.tasks = [];
    data.subtasks = [];
    data.runs = [];
    data.progress = [];
    data.notifications = [];
    data.specs = [];
    const { run } = setup({ repos: {} }, data);
    expect(await run()).toEqual({
      outcome: 'unscanned',
      scanned: 0,
      found: 0,
      why: '没有受管的仓（repos 表是空的）',
      steps: [],
    });
  });

  it('【故意造出的失败】重放时还是没处理成：这一轮算做了一部分（partial），出错的原因写进去', async () => {
    const data = devFixtures(T0);
    data.githubEvents = new Map([
      ['still-broken', stored('still-broken', { payload: opened(pull(46, -10)), reason: '上次也没成' })],
    ]);
    const { h, run } = setup({ repos: { [SLUG]: empty() } }, data);
    // 镜像一直写不进去：重放照样失败
    h.deps.github.accept = async () => {
      throw new Error('镜像还是写不进去');
    };
    const result = await run();
    expect(result).toMatchObject({ outcome: 'partial', scanned: 1 });
    expect(result.why).toContain('重放 1 条还是没处理成');
    expect(await h.store.getDelivery('still-broken')).toMatchObject({ status: 'failed', attempts: 2 });
  });

  it('对账出错的投递报在健康检查里：重放到头还不成的 → github_events 报红，只说条数', async () => {
    const data = devFixtures(T0);
    data.githubEvents = new Map([
      ['hopeless', stored('hopeless', { payload: opened(pull(45, -10)), attempts: MAX_AUTO_REPLAYS })],
    ]);
    const { h } = setup({ repos: { [SLUG]: empty() } }, data);
    await expect(githubEventsCheck({ store: h.store, now: () => T0 })()).rejects.toThrow(
      /有 GitHub 投递没处理成/,
    );
  });
});
