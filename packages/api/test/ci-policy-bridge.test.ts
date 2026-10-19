import { generateKeyPairSync } from 'node:crypto';
import { gateGitHub } from '@fleet-dao/conventions';
import { policyReader, readPolicyHttp } from '@fleet-dao/conventions/ci-policy-bridge';
import {
  type AppCredentials,
  createGitHub,
  createPolicyGitHub,
  lockerOver,
  memoryIdempotencyStore,
  memoryLedger,
} from '@fleet-dao/github';
import { createGitHubIntake } from '@fleet-dao/store';
import { describe, expect, it, vi } from 'vitest';
import { withPolicySource } from '../src/ci-policy-bridge.ts';
import { attachPolicyBridge, POLICY_ID, POLICY_SHA } from './ci-policy-helper.ts';
import { deliverGithub, harness, IDS, write } from './harness.ts';

const path = `/api/public/ci-policy/v1/repos/${POLICY_ID}`;
const publicUrl = `https://cockpit.example.test${path}?pr=12&head=${POLICY_SHA}`;
const repo = { owner: 'example', name: 'canary' };
describe('真实 DB 只读桥与保护边界', () => {
  it('同一个旧 source URL 在 DB off -> force 后实际 HTTP 读到 force，响应不公开其它字段', async () => {
    const h = harness();
    attachPolicyBridge(h);
    const s = await h.login();
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => h.cockpit.request(String(url), init));
    await h.cockpit.request(`/api/repos/${IDS.repo}/ci-policy`, write('PUT', s, { mode: 'off' }));
    expect(
      (await readPolicyHttp(publicUrl, { githubId: POLICY_ID, repo: 'example/canary' }, fetchImpl)).ciPolicy,
    ).toBe('off');
    await h.cockpit.request(`/api/repos/${IDS.repo}/ci-policy`, write('PUT', s, { mode: 'force' }));
    expect(
      await readPolicyHttp(publicUrl, { githubId: POLICY_ID, repo: 'example/canary' }, fetchImpl),
    ).toEqual({
      version: 1,
      githubId: POLICY_ID,
      repo: 'example/canary',
      ciPolicy: 'force',
    });
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
    });
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).has('authorization')).toBe(false);
  });
  it('私有/未受管统一拒绝；真实桥未装配503；邻近读写仍需session和CSRF', async () => {
    const h = harness();
    expect((await h.cockpit.request(path)).status).toBe(503);
    const { state } = attachPolicyBridge(h);
    state.public = false;
    const privateReply = await h.cockpit.request(path);
    expect(privateReply.status).toBe(404);
    expect(await privateReply.json()).toEqual(await (await h.cockpit.request(`${path}9`)).json());
    for (const p of ['/api/repos/ci-policy', `/api/repos/${IDS.repo}/ci-policy`]) {
      expect((await h.cockpit.request(p)).status).toBe(401);
    }
    expect((await h.cockpit.request(path, { method: 'PUT' })).status).toBe(401);
    const s = await h.login();
    expect(
      (
        await h.cockpit.request(`/api/repos/${IDS.repo}/ci-policy`, {
          method: 'PUT',
          headers: { cookie: s.cookie, 'content-type': 'application/json' },
          body: '{"mode":"off"}',
        })
      ).status,
    ).toBe(403);
  });
  it.each(['?mode=off', `?pr=12&pr=12&head=${POLICY_SHA}`, `?head=${POLICY_SHA}&pr=12`])(
    '不接受额外/重复/非规范参数 %s',
    async (query) => {
      const h = harness();
      attachPolicyBridge(h);
      expect((await h.cockpit.request(path + query)).status).toBe(400);
    },
  );
});

describe('setter 撤绿、失败与重试', () => {
  it('真实GitHub回读可见较新actions success时返回503，旧engine pending不能让DB提交', async () => {
    const h = harness();
    const { gh } = attachPolicyBridge(h);
    const session = await h.login();
    expect(
      (await h.cockpit.request(`/api/repos/${IDS.repo}/ci-policy`, write('PUT', session, { mode: 'off' })))
        .status,
    ).toBe(200);
    const commit = vi.spyOn(h.store, 'setCiPolicy');
    const engine: AppCredentials = {
      role: 'engine',
      appId: 202,
      clientId: 'Iv1.test-engine',
      slug: 'fleet-dao-engine',
      privateKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey,
      source: 'test',
    };
    const pending = {
      id: 1,
      context: 'merge-gate',
      state: 'pending',
      creator: { id: 9002, type: 'Bot', login: 'fleet-dao-engine[bot]' },
      url: `https://api.github.test/repos/example/canary/statuses/${POLICY_SHA}`,
      target_url: null,
    };
    const posts: unknown[] = [];
    const statuses = [
      {
        ...pending,
        id: 2,
        state: 'success',
        creator: { id: 41882, type: 'Bot', login: 'github-actions[bot]' },
      },
      pending,
    ];
    const readback = vi.fn(() => statuses);
    const real = createGitHub({
      ledger: memoryLedger(),
      apps: { engine, agent: { ...engine, role: 'agent' } },
      apiUrl: 'https://api.github.test',
      env: {},
      writeSpacingMs: 0,
      fetch: async (url, init) => {
        const p = new URL(String(url)).pathname;
        let data: unknown;
        if (p.endsWith('/installation')) data = { id: 20, permissions: { statuses: 'write' } };
        else if (p.endsWith('/access_tokens'))
          data = {
            token: 'test-engine-token',
            expires_at: '2099-01-01T00:00:00Z',
            permissions: { statuses: 'write' },
          };
        else if (p.startsWith('/users/')) data = pending.creator;
        else if (p === `/repos/example/canary/statuses/${POLICY_SHA}` && init?.method === 'POST') {
          const posted = JSON.parse(String(init.body));
          posts.push(posted);
          const recorded = { ...pending, ...posted, id: posts.length + 2 };
          data = recorded;
          if (posted.context !== 'merge-gate') statuses.unshift(recorded);
        } else if (p === `/repos/example/canary/commits/${POLICY_SHA}/statuses`) data = readback();
        else throw new Error(`unexpected GitHub ${init?.method} ${p}`);
        return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
      },
    });
    gh.write = createPolicyGitHub(real.deps).write;
    const response = await h.cockpit.request(
      `/api/repos/${IDS.repo}/ci-policy`,
      write('PUT', session, { mode: 'force' }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: {
        code: 'ci_policy_sync_incomplete',
        details: {
          dbState: 'not-attempted',
          oldGreen: 'unconfirmed',
          source: 'not-applicable',
          finalGate: 'not-awaited',
        },
      },
    });
    expect(readback).toHaveBeenCalledOnce();
    expect(posts).toEqual([expect.objectContaining({ context: 'merge-gate', state: 'pending' })]);
    expect(commit).not.toHaveBeenCalled();
    expect((await h.store.findRepoByName(repo.owner, repo.name))?.ciPolicy).toBe('off');
  });
  it('没有适用的 open PR 时不冒称已排 source 事件，也不冒称最终 gate 通过', async () => {
    const h = harness();
    const { bridge, state, writes } = attachPolicyBridge(h);
    state.numbers = [];
    expect(
      (await bridge.set(repo, 'force', async () => ({ changed: false, ciPolicy: 'force' }))).sync,
    ).toEqual({ oldGreen: 'revoked', source: 'not-applicable', finalGate: 'not-awaited' });
    expect(writes).toEqual([]);
  });
  it('共享 SHA 的 PR17/18 发布与真实 HTTP 读取互不覆盖，17最新坏不回退且18仍可读', async () => {
    const h = harness();
    const { bridge, writes, state } = attachPolicyBridge(h);
    state.numbers = [17, 18];
    const session = await h.login();
    expect(
      (await h.cockpit.request(`/api/repos/${IDS.repo}/ci-policy`, write('PUT', session, { mode: 'off' })))
        .status,
    ).toBe(200);
    writes.length = 0;
    await bridge.refresh(repo, true);
    expect(writes.map((s) => s.context)).toEqual([
      'fleet-ci-policy-source/pr/17',
      'fleet-ci-policy-source/pr/18',
    ]);
    const statuses = () =>
      writes
        .map((s, i) => ({
          id: i + 1,
          context: s.context,
          state: s.state,
          target_url: s.targetUrl,
          url: `https://api.github.com/repos/example/canary/statuses/${POLICY_SHA}`,
          creator: { id: 99, type: 'Bot' },
        }))
        .reverse();
    const api = {
      get: async (p: string) => {
        if (p === '') return { id: POLICY_ID, full_name: 'example/canary', private: false };
        const match = /^\/pulls\/(17|18)$/.exec(p);
        if (match)
          return {
            number: Number(match[1]),
            state: 'open',
            head: { sha: POLICY_SHA, repo: { id: POLICY_ID, full_name: 'example/canary' } },
            base: {
              ref: match[1] === '17' ? 'main' : 'release',
              repo: { id: POLICY_ID, full_name: 'example/canary' },
            },
          };
        if (p.includes('/statuses?')) return statuses();
        throw new Error(`unexpected ${p}`);
      },
      globalGet: async () => ({ id: 99, type: 'Bot', login: 'fleet-dao-engine[bot]' }),
      getOrNull: async () => null,
      post: async () => {
        throw new Error('reader不可写');
      },
    };
    const read = policyReader(api, gateGitHub(api), 'example/canary', async (url, init) =>
      h.cockpit.request(String(url), init),
    );
    expect(await read(17, POLICY_SHA)).toBe('off');
    expect(await read(18, POLICY_SHA)).toBe('off');
    const first = writes[0];
    if (!first) throw new Error('source 未发布');
    writes.push({ ...first, state: 'failure' });
    await expect(read(17, POLICY_SHA)).rejects.toThrow();
    expect(await read(18, POLICY_SHA)).toBe('off');
  });
  it('真实生产 lockerOver 释放失锁后，HTTP 不得返回切换成功', async () => {
    const h = harness();
    const store = memoryIdempotencyStore();
    const { gh } = attachPolicyBridge(h, lockerOver(store, { strict: true }));
    const writeSource = gh.write;
    gh.write = async (...args) => {
      await writeSource(...args);
      if (args[3].context === 'fleet-ci-policy-source/pr/12') {
        const key = 'gh:lock:ci-policy:example/canary';
        const held = await store.peek(key);
        expect(held).not.toBeNull();
        if (!held) throw new Error('锁未持有');
        await store.takeOver(key, held.claimedAt, new Date(held.claimedAt.getTime() + 1));
      }
    };
    const session = await h.login();
    const response = await h.cockpit.request(
      `/api/repos/${IDS.repo}/ci-policy`,
      write('PUT', session, { mode: 'force' }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: {
        code: 'ci_policy_sync_incomplete',
        details: { dbState: 'committed', oldGreen: 'revoked', source: 'queued', finalGate: 'not-awaited' },
      },
    });
  });
  it('force unchanged仍先pending再刷新；明确只排重算，不伪造最终success', async () => {
    const h = harness();
    const { bridge, writes } = attachPolicyBridge(h);
    const commit = vi.fn(async () => {
      expect(writes.map((w) => w.state)).toEqual(['pending']);
      return { changed: false, ciPolicy: 'force' as const };
    });
    const result = await bridge.set(repo, 'force', commit);
    expect(result.sync).toEqual({ oldGreen: 'revoked', source: 'queued', finalGate: 'not-awaited' });
    expect(writes.map((w) => [w.context, w.state])).toEqual([
      ['merge-gate', 'pending'],
      ['merge-gate', 'pending'],
      ['fleet-ci-policy-source/pr/12', 'success'],
    ]);
    expect(writes.at(-1)?.targetUrl).not.toContain('off');
  });
  it('pending失败不调用DB；DB提交失败保留pending；后置发布失败如实标DB已提交', async () => {
    const h = harness();
    const { bridge, state, writes, gh } = attachPolicyBridge(h);
    state.failWrite = true;
    const commit = vi.fn(async () => ({ changed: false, ciPolicy: 'force' as const }));
    await expect(bridge.set(repo, 'force', commit)).rejects.toMatchObject({
      details: { dbState: 'not-attempted', oldGreen: 'unconfirmed' },
    });
    expect(commit).not.toHaveBeenCalled();
    state.failWrite = false;
    await expect(
      bridge.set(repo, 'force', async () => {
        throw new Error('transaction failed');
      }),
    ).rejects.toMatchObject({ details: { dbState: 'unconfirmed', oldGreen: 'revoked' } });
    expect(writes.at(-1)?.state).toBe('pending');
    const original = gh.write;
    gh.write = async (...args) => {
      if (args[3].context === 'fleet-ci-policy-source/pr/12') throw new Error('source write failed');
      await original(...args);
    };
    await expect(bridge.set(repo, 'force', commit)).rejects.toMatchObject({
      details: { dbState: 'committed', source: 'unconfirmed' },
    });
  });
  it('私有force保留原DB路径；私有off拒绝且不提交、不公开source', async () => {
    const h = harness();
    const { bridge, state, writes } = attachPolicyBridge(h);
    state.public = false;
    expect(
      (await bridge.set(repo, 'force', async () => ({ changed: false, ciPolicy: 'force' }))).sync.source,
    ).toBe('not-applicable');
    const commit = vi.fn();
    await expect(bridge.set(repo, 'off', commit)).rejects.toMatchObject({ code: 'private_off_unsupported' });
    expect(commit).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
  it('普通重复PR事件幂等，显式refresh必须重发source事件；旧事件使用当前头', async () => {
    const h = harness();
    const { bridge, state, writes } = attachPolicyBridge(h);
    await bridge.publish(repo, 12);
    await bridge.publish(repo, 12);
    expect(writes).toHaveLength(1);
    await bridge.refresh(repo, true);
    expect(writes).toHaveLength(2);
    state.sha = 'b'.repeat(40);
    await bridge.publish(repo, 12);
    expect(writes.at(-1)?.sha).toBe(state.sha);
    state.fork = true;
    await bridge.publish(repo, 12);
    expect(writes).toHaveLength(3);
  });
});

describe('签名 webhook -> intake await publisher -> 失败账重放', () => {
  it('自家Bot wake=false仍发布；发布失败保留failed，重放成功才accepted；status不循环', async () => {
    const h = harness();
    const { bridge, state, writes } = attachPolicyBridge(h);
    h.deps.github = withPolicySource(h.deps.github, bridge);
    const bot = { login: 'fleet-worker[bot]', id: 9001, type: 'Bot' };
    const payload = {
      action: 'opened',
      repository: { full_name: 'example/canary' },
      sender: bot,
      pull_request: {
        number: 12,
        user: bot,
        state: 'open',
        title: 'change',
        updated_at: '2026-09-25T07:59:00Z',
        head: { ref: 'fleet/12-t12345678', repo: { full_name: 'example/canary' } },
        base: { repo: { full_name: 'example/canary' } },
      },
    };
    state.failWrite = true;
    expect((await deliverGithub(h, 'pull_request', payload, { delivery: 'policy-replay' })).status).toBe(500);
    expect((await h.store.getDelivery('policy-replay'))?.status).toBe('failed');
    await expect(createGitHubIntake(h.deps).replay('policy-replay', { force: true })).rejects.toThrow(
      'GitHub write unavailable',
    );
    expect((await h.store.getDelivery('policy-replay'))?.status).toBe('failed');
    state.failWrite = false;
    expect(await createGitHubIntake(h.deps).replay('policy-replay', { force: true })).toMatchObject({
      verdict: 'accepted',
      wake: false,
    });
    expect((await h.store.getDelivery('policy-replay'))?.status).toBe('accepted');
    expect(writes).toHaveLength(1);
    const count = writes.length;
    await h.deps.github.accept({
      deliveryId: 'source',
      source: 'webhook',
      event: 'status',
      repo: 'example/canary',
      wake: false,
      receivedAt: new Date().toISOString(),
      payload: { context: 'fleet-ci-policy-source/pr/12' },
    });
    expect(writes).toHaveLength(count);
  });
});
