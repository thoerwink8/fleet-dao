// 对账补漏：轮询、查开放 issue、重投走 @fleet-dao/github 的真代码（对着照 GitHub 接口回话的假服务），
// 补回来的东西走真的 GitHubIntake（同一道门、同一本投递账），落到同一个 Store。
import { generateKeyPairSync } from 'node:crypto';
import { type AppCredentials, createGitHub, memoryLedger } from '@fleet-dao/github';
import { describe, expect, it } from 'vitest';
import { devFixtures, IDS } from '../src/dev-fixtures.ts';
import { createGitHubIntake, pollDeliveryId } from '../src/github.ts';
import type { MemoryData } from '../src/memory-store.ts';
import type { AskRecord, GitHubDelivery } from '../src/ports.ts';
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
  issues: Record<string, unknown>[];
  comments: Record<string, unknown>[];
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

const empty = (): RepoState => ({ issues: [], comments: [], pulls: [] });

/** 只答对账会问的几条：安装、令牌、issue 列表、评论列表、PR 列表、投递日志和重投。since 照 GitHub 的规矩过滤。 */
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
    const since = url.searchParams.get('since');
    const fresh = (x: Record<string, unknown>) => !since || String(x.updated_at) >= since;
    if (url.pathname.endsWith('/installation')) return reply(200, { id: 1 });
    if (url.pathname.endsWith('/access_tokens')) {
      return reply(201, {
        token: 'test-installation-token',
        expires_at: '2099-01-01T00:00:00Z',
        permissions: {},
      });
    }
    const repo = slug ? state.repos[slug] : undefined;
    const rest = repoMatch?.[2];
    if (repo && rest === '/issues') {
      const open = url.searchParams.get('state') === 'open';
      return reply(
        200,
        repo.issues.filter((i) => (open ? i.state === 'open' : fresh(i))),
      );
    }
    if (repo && rest === '/issues/comments') return reply(200, repo.comments.filter(fresh));
    if (repo && rest === '/pulls') return reply(200, repo.pulls);
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

function issue(number: number, minutes: number, over: Record<string, unknown> = {}) {
  return {
    number,
    title: `需求 ${number}`,
    body: `第 ${number} 张的原话`,
    state: 'open',
    user: founderA,
    created_at: at(minutes),
    updated_at: at(minutes),
    ...over,
  };
}

function pull(number: number, minutes: number) {
  return {
    number,
    state: 'open',
    merged_at: null,
    updated_at: at(minutes),
    user: founderA,
    head: { ref: `fleet/${number}-a`, sha: 'a'.repeat(40), repo: { full_name: SLUG } },
    base: { ref: 'main', repo: { full_name: SLUG } },
  };
}

/** 库里已经有的一条投递（seed 进去，当作以前收过的）。 */
function stored(id: string, over: Partial<GitHubDelivery> & Pick<GitHubDelivery, 'payload'>): GitHubDelivery {
  return {
    id,
    event: 'issues',
    action: 'opened',
    source: 'webhook',
    repo: SLUG,
    versions: [],
    status: 'failed',
    reason: 'Temporal 连不上',
    attempts: 1,
    receivedAt: at(-10),
    claimedAt: at(-10),
    finishedAt: at(-10),
    ...over,
  };
}

const opened = (iss: object, sender: object = founderA) => ({
  action: 'opened',
  issue: iss,
  sender,
  repository: { full_name: SLUG },
});

function setup(state: GitHubState, data: Partial<MemoryData> = devFixtures(T0)) {
  data.repos = (data.repos ?? []).map((r) => ({ ...r, autoDispatchSince: at(-60) }));
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
  // 「有没有工作流」按库里有没有这张 issue 的任务算（和生产上 pgLedger 读同一张 tasks 表一样）
  const reconciler = gh.reconciler({
    ...reconcilerOptions({ store: h.store, intake }),
    hasWorkflow: async (repo, n) => {
      const r = (data.repos ?? []).find((x) => `${x.owner}/${x.name}` === repo);
      return r !== undefined && (await h.store.findTaskByIssue(r.id, n)) !== null;
    },
  });
  const run = () =>
    reconcileGitHub({ store: h.store, intake, reconciler, log: h.deps.log, now: () => T0 }, { since: SINCE });
  return { h, run, api };
}

describe('对账补漏', () => {
  it('对账补回一条漏的：webhook 漏掉的 issue 由轮询送进门，建任务、拉起工作流；webhook 收过的同一版认得出，不重做', async () => {
    const seen = issue(40, -30);
    const missed = issue(41, -20);
    const { h, run } = setup({ repos: { [SLUG]: { ...empty(), issues: [seen, missed] } } });
    await deliver(h, 'issues', opened(seen));
    expect(h.starts.map((s) => s.issueNumber)).toEqual([40]);

    const result = await run();
    expect(result).toMatchObject({ outcome: 'ok', scanned: 1, found: 1 });
    expect(h.starts.map((s) => s.issueNumber)).toEqual([40, 41]);
    const task = await h.store.findTaskByIssue(IDS.repo, 41);
    expect(task).toMatchObject({ title: '需求 41', rawRequest: '第 41 张的原话', requestedBy: IDS.founderA });
    expect(await h.store.getDelivery(pollDeliveryId(SLUG, 'issue', 41, missed.updated_at))).toMatchObject({
      source: 'poll',
      status: 'accepted',
      note: 'task=created, workflow=started',
    });
    // webhook 收过的那一版：轮询不再落一行、不再处理
    expect(await h.store.getDelivery(pollDeliveryId(SLUG, 'issue', 40, seen.updated_at))).toBeNull();
    expect(h.store.data.tasks.filter((t) => t.issueNumber === 40 || t.issueNumber === 41)).toHaveLength(2);

    // 再跑一轮：没有新的，查了、0 个
    expect(await run()).toMatchObject({ outcome: 'ok', scanned: 1, found: 0 });
    expect(h.starts).toHaveLength(2);
  });

  it('评论把 issue 顶新、审查把 PR 顶新：webhook 带过那一版，轮询认得出，不算漏收', async () => {
    const bumped = issue(40, -20, { created_at: at(-30) });
    const commentAt = at(-20);
    const { h, run } = setup({
      repos: {
        [SLUG]: {
          issues: [bumped],
          comments: [
            {
              id: 900,
              body: '补一句',
              user: founderA,
              created_at: commentAt,
              updated_at: commentAt,
              issue_url: `${API}/repos/${SLUG}/issues/40`,
            },
          ],
          pulls: [pull(5, -15)],
        },
      },
    });
    await deliver(h, 'issues', opened(issue(40, -30)));
    await deliver(h, 'issue_comment', {
      action: 'created',
      issue: bumped,
      comment: { id: 900, body: '补一句', user: founderA, created_at: commentAt, updated_at: commentAt },
      sender: founderA,
      repository: { full_name: SLUG },
    });
    const pr = pull(5, -15);
    await deliver(h, 'pull_request_review', {
      action: 'submitted',
      review: { user: founderA },
      pull_request: { ...pr, head: { repo: { full_name: SLUG } }, base: { repo: { full_name: SLUG } } },
      sender: founderA,
      repository: { full_name: SLUG },
    });

    const result = await run();
    expect(result).toMatchObject({ outcome: 'ok', scanned: 1, found: 0 });
    expect(result.steps.find((s) => s.step === 'poll')).toMatchObject({ checked: 3, recovered: 0 });
  });

  it('改动早于这一轮、轮询看不到的开放 issue：查开放 issue 时发现没有任务，补上；陌生人开的不算', async () => {
    const quiet = issue(42, -50);
    const strangers = issue(43, -50, { user: stranger });
    const { h, run } = setup({ repos: { [SLUG]: { ...empty(), issues: [quiet, strangers] } } });
    const result = await run();
    expect(result).toMatchObject({ outcome: 'ok', scanned: 1, found: 1 });
    expect(result.steps.find((s) => s.step === 'audit')).toMatchObject({
      recovered: 1,
      why: '#42 是白名单作者开的，却没有工作流（已重新送进引擎）',
    });
    expect(await h.store.findTaskByIssue(IDS.repo, 42)).toMatchObject({ state: 'queued' });
    expect(await h.store.findTaskByIssue(IDS.repo, 43)).toBeNull();
    expect(h.starts.map((s) => s.issueNumber)).toEqual([42]);
    // 陌生人那张每轮都来核对，投递账里也只留一条（编号按 issue 的这一版起）
    await run();
    const strangerRows = [...h.store.data.githubEvents.keys()].filter((id) =>
      id.includes(':issue-audit:43:'),
    );
    expect(strangerRows).toHaveLength(1);
  });

  it('库里出错、卡住的投递按原文重放；重放到头还不成的不再重放，报出来要人看', async () => {
    const data = devFixtures(T0);
    data.githubEvents = new Map([
      ['retry-me', stored('retry-me', { payload: opened(issue(44, -10)) })],
      ['hopeless', stored('hopeless', { payload: opened(issue(45, -10)), attempts: MAX_AUTO_REPLAYS })],
    ]);
    const { h, run } = setup({ repos: { [SLUG]: empty() } }, data);
    const result = await run();
    expect(await h.store.getDelivery('retry-me')).toMatchObject({ status: 'accepted', attempts: 2 });
    expect(await h.store.findTaskByIssue(IDS.repo, 44)).not.toBeNull();
    expect(await h.store.getDelivery('hopeless')).toMatchObject({
      status: 'failed',
      attempts: MAX_AUTO_REPLAYS,
    });
    expect(await h.store.findTaskByIssue(IDS.repo, 45)).toBeNull();
    expect(result).toMatchObject({ outcome: 'ok', scanned: 1, found: 2 });
    expect(result.why).toContain(`重放了 ${MAX_AUTO_REPLAYS} 次都没成`);
    expect(result.why).toContain('hopeless');
    expect(h.logs.some((l) => l.level === 'warn' && l.message.includes('重放到头'))).toBe(true);
  });

  it('GitHub 投递日志里没送成的：库里有原文的不重投、交给重放（只算一次），库里没有的才叫 GitHub 重投', async () => {
    const data = devFixtures(T0);
    data.githubEvents = new Map([['g-stored', stored('g-stored', { payload: opened(issue(44, -10)) })]]);
    const { h, run, api } = setup(
      {
        repos: { [SLUG]: empty() },
        deliveries: [
          { id: 12, guid: 'g-missing', delivered_at: at(-5), status_code: 502, event: 'issues' },
          { id: 11, guid: 'g-stored', delivered_at: at(-10), status_code: 500, event: 'issues' },
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
        stored('from-stranger', { payload: opened(issue(47, -10, { user: stranger }), stranger) }),
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

  it('外人改了白名单作者的评论、改评论的 webhook 丢了：补收看到的是改过的评论，不当回答、不记在作者名下', async () => {
    const ask: AskRecord = {
      id: 'f1000000-0000-4000-8000-000000000001',
      taskId: IDS.task12,
      question: '验证码几分钟过期？',
      options: [],
      askedAt: at(-60),
    };
    const data = devFixtures(T0);
    data.asks = [ask];
    const { h, run } = setup(
      {
        repos: {
          [SLUG]: {
            ...empty(),
            comments: [
              {
                id: 900,
                body: '外人改后的内容',
                user: founderA,
                created_at: at(-30),
                updated_at: at(-5),
                issue_url: `${API}/repos/${SLUG}/issues/12`,
              },
            ],
          },
        },
      },
      data,
    );
    await run();
    expect((await h.store.getAsk(ask.id))?.answer).toBeUndefined();
    expect(h.signals).toEqual([]);
    const row = await h.store.getDelivery(pollDeliveryId(SLUG, 'comment', 900, at(-5)));
    expect(row).toMatchObject({ status: 'accepted', note: 'skip=edited' });
    // 改过的评论看不出是谁改的：补收时不带 sender
    expect(row?.payload).not.toHaveProperty('sender');
    const audits = await h.store.listAudit({ target: `task:${IDS.task12}`, limit: 20 });
    expect(audits.items.filter((a) => a.action === 'ask.answer')).toEqual([]);
  });

  it('几个仓里有一个读不到：这一轮算做了一部分（partial），查成的照样补', async () => {
    const data = devFixtures(T0);
    data.repos = [
      ...(data.repos ?? []),
      { id: OTHER_ID, owner: 'example', name: 'other', defaultBranch: 'main', testCommand: 'pnpm check' },
    ];
    const { h, run } = setup(
      { repos: { [SLUG]: { ...empty(), issues: [issue(48, -10)] }, [OTHER]: empty() }, downRepos: [OTHER] },
      data,
    );
    const result = await run();
    expect(result).toMatchObject({ outcome: 'partial', scanned: 1, found: 1 });
    expect(result.why).toContain('example/other');
    expect(await h.store.findTaskByIssue(IDS.repo, 48)).not.toBeNull();
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

  it('重放时还是没处理成：这一轮算做了一部分（partial），出错的原因写进去', async () => {
    const data = devFixtures(T0);
    data.githubEvents = new Map([
      ['still-broken', stored('still-broken', { payload: opened(issue(46, -10)), reason: '上次也没成' })],
    ]);
    const { h, run } = setup({ repos: { [SLUG]: empty() } }, data);
    // 拉起工作流一直连不上：重放照样失败
    h.deps.requirements.start = async () => {
      throw new Error('Temporal 还是连不上');
    };
    const result = await run();
    expect(result).toMatchObject({ outcome: 'partial', scanned: 1 });
    expect(result.why).toContain('重放 1 条还是没处理成');
    expect(await h.store.getDelivery('still-broken')).toMatchObject({ status: 'failed', attempts: 2 });
  });
});
