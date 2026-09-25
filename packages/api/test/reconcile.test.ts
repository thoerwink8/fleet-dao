// 对账补漏：轮询、查开放 issue、重投走 @fleet-dao/github 的真代码（对着照 GitHub 接口回话的假服务），
// 补回来的东西走真的 GitHubIntake（同一道门、同一本投递账），落到同一个 Store。
import { generateKeyPairSync } from 'node:crypto';
import { type AppCredentials, createGitHub, memoryLedger } from '@fleet-dao/github';
import { describe, expect, it } from 'vitest';
import { devFixtures, IDS } from '../src/dev-fixtures.ts';
import { createGitHubIntake, pollDeliveryId } from '../src/github.ts';
import type { MemoryData } from '../src/memory-store.ts';
import type { GitHubDelivery } from '../src/ports.ts';
import { MAX_AUTO_REPLAYS, reconcileGitHub } from '../src/reconcile.ts';
import { deliverGithub as deliver, harness, T0 } from './harness.ts';

const API = 'https://api.github.test';
const SLUG = 'example/canary';
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

interface GitHubState {
  issues: Record<string, unknown>[];
  comments: Record<string, unknown>[];
  /** 设了就所有接口都这样回（读不到 GitHub）。 */
  down?: number;
}

/** 只答对账会问的几条：安装、令牌、issue 列表、评论列表、PR 列表、投递日志。since 照 GitHub 的规矩过滤。 */
function githubApi(state: GitHubState) {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    const reply = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (state.down) return reply(state.down, { message: 'Resource not accessible by integration' });
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
    if (url.pathname === `/repos/${SLUG}/issues`) {
      const open = url.searchParams.get('state') === 'open';
      return reply(
        200,
        state.issues.filter((i) => (open ? i.state === 'open' : fresh(i))),
      );
    }
    if (url.pathname === `/repos/${SLUG}/issues/comments`) return reply(200, state.comments.filter(fresh));
    if (url.pathname === `/repos/${SLUG}/pulls`) return reply(200, []);
    if (url.pathname === '/app/hook/deliveries') return reply(200, []);
    return reply(404, { message: `假 GitHub 里没有 ${url.pathname}` });
  };
  return { fetchImpl, calls };
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

function setup(state: GitHubState, data: Partial<MemoryData> = devFixtures(T0)) {
  data.repos = (data.repos ?? []).map((r) => ({ ...r, autoDispatchSince: at(-60) }));
  const h = harness({ data });
  const intake = createGitHubIntake(h.deps);
  const api = githubApi(state);
  const gh = createGitHub({
    ledger: memoryLedger({ repos: [{ id: IDS.repo, owner: 'example', name: 'canary' }] }),
    apps: apps(),
    apiUrl: API,
    fetch: api.fetchImpl,
    now: () => T0,
    sleep: async () => {},
    env: {},
  });
  // 「有没有工作流」按库里有没有这张 issue 的任务算（和生产上 pgLedger 读同一张 tasks 表一样）
  const reconciler = gh.reconciler({
    intake,
    pollDeliveryId,
    hasWorkflow: async (_repo, n) => (await h.store.findTaskByIssue(IDS.repo, n)) !== null,
  });
  const run = () =>
    reconcileGitHub({ store: h.store, intake, reconciler, log: h.deps.log, now: () => T0 }, { since: SINCE });
  return { h, run, api };
}

describe('对账补漏', () => {
  it('对账补回一条漏的：webhook 漏掉的 issue 由轮询送进门，建任务、拉起工作流；webhook 收过的同一版认得出，不重做', async () => {
    const seen = issue(40, -30);
    const missed = issue(41, -20);
    const { h, run } = setup({ issues: [seen, missed], comments: [] });
    await deliver(h, 'issues', {
      action: 'opened',
      issue: seen,
      sender: founderA,
      repository: { full_name: SLUG },
    });
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

  it('改动早于这一轮、轮询看不到的开放 issue：查开放 issue 时发现没有任务，补上；陌生人开的不算', async () => {
    const quiet = issue(42, -50);
    const strangers = issue(43, -50, { user: stranger });
    const { h, run } = setup({ issues: [quiet, strangers], comments: [] });
    const result = await run();
    expect(result).toMatchObject({ outcome: 'ok', scanned: 1, found: 1 });
    expect(result.steps.find((s) => s.step === 'audit')).toMatchObject({
      recovered: 1,
      why: '#42 是白名单作者开的，却没有工作流（已重新送进引擎）',
    });
    expect(await h.store.findTaskByIssue(IDS.repo, 42)).toMatchObject({ state: 'queued' });
    expect(await h.store.findTaskByIssue(IDS.repo, 43)).toBeNull();
    expect(h.starts.map((s) => s.issueNumber)).toEqual([42]);
  });

  it('库里出错、卡住的投递按原文重放；重放到头还不成的不再重放，报出来要人看', async () => {
    const payload = (n: number) => ({
      action: 'opened',
      issue: issue(n, -10),
      sender: founderA,
      repository: { full_name: SLUG },
    });
    const failed = (id: string, n: number, attempts: number): GitHubDelivery => ({
      id,
      event: 'issues',
      action: 'opened',
      source: 'webhook',
      repo: SLUG,
      payload: payload(n),
      status: 'failed',
      reason: 'Temporal 连不上',
      attempts,
      receivedAt: at(-10),
      claimedAt: at(-10),
      finishedAt: at(-10),
    });
    const data = devFixtures(T0);
    data.githubEvents = new Map([
      ['retry-me', failed('retry-me', 44, 1)],
      ['hopeless', failed('hopeless', 45, MAX_AUTO_REPLAYS)],
    ]);
    const { h, run } = setup({ issues: [], comments: [] }, data);
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

  it('GitHub 读不到：这一轮报没查成（unscanned），不报 ok', async () => {
    const { run } = setup({ issues: [], comments: [], down: 403 });
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
    const { run } = setup({ issues: [], comments: [] }, data);
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
      [
        'still-broken',
        {
          id: 'still-broken',
          event: 'issues',
          action: 'opened',
          source: 'webhook',
          repo: 'example/gone',
          payload: {
            action: 'opened',
            issue: issue(46, -10),
            sender: founderA,
            repository: { full_name: SLUG },
          },
          status: 'failed',
          reason: '上次也没成',
          attempts: 1,
          receivedAt: at(-10),
          claimedAt: at(-10),
          finishedAt: at(-10),
        },
      ],
    ]);
    const { h, run } = setup({ issues: [], comments: [] }, data);
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
