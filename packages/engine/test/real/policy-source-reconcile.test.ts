import { findRepoProfile, repos, users } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import type { GitHub, PolicyGitHub } from '@fleet-dao/github';
import {
  createGitHubIntake,
  createPgStore,
  createPolicySourcePublisher,
  pollDeliveryId,
  silentLogger,
  withPolicySource,
} from '@fleet-dao/store';
import type { Client } from '@temporalio/client';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { githubReconcileJob } from '../../src/real/github-reconcile.ts';

const slug = 'example/canary';
const repo = { owner: 'example', name: 'canary' };
const sha = 'a'.repeat(40);
const at = new Date('2026-10-19T18:00:00Z');
const author = { id: 1001, login: 'founder', type: 'User' };
function payload(updated = at.toISOString()) {
  return {
    action: 'synced',
    repository: { full_name: slug },
    pull_request: {
      number: 12,
      updated_at: updated,
      state: 'open',
      user: author,
      head: { repo: { full_name: slug } },
      base: { repo: { full_name: slug } },
    },
  };
}
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
});

async function harness() {
  await t.db.insert(repos).values({ ...repo, githubId: 12345, testCommand: 'pnpm check' });
  await t.db
    .insert(users)
    .values({ displayName: 'Founder', role: 'founder', githubId: 1001, githubLogin: 'founder' });
  const state = { head: sha, open: true, fork: false, fail: false };
  const statuses: { head: string; context: string; state: string; targetUrl?: string | undefined }[] = [];
  const policy: PolicyGitHub = {
    repo: async () => ({ githubId: 12345, repo: slug, public: true }),
    pull: async () => ({ number: 12, head: state.head, open: state.open, fork: state.fork }),
    openPulls: async () => [12],
    latest: async (_r, _id, head, context) => {
      const old = statuses.findLast((s) => s.head === head && s.context === context);
      return old ? { state: old.state, target_url: old.targetUrl } : null;
    },
    write: async (_r, _id, head, status) => {
      if (state.fail) throw new Error('source write failed');
      statuses.push({ head, ...status });
    },
  };
  const accept = vi.fn(async () => {});
  let input = payload();
  // 真工厂、真 intake、真 PG 投递账；GitHub 仅替换外部 IO。
  const gh = {
    eventSink: () => ({ accept }),
    claims: {},
    reconciler: (options: { intake: ReturnType<typeof createGitHubIntake> }) => ({
      redeliverFailed: async () => ({ outcome: 'ok', checked: 0, recovered: 0 }),
      poll: async () => {
        try {
          const result = await options.intake.ingest({
            deliveryId: pollDeliveryId(slug, 'pull', 12, input.pull_request.updated_at),
            event: 'pull_request',
            source: 'poll',
            payload: input,
          });
          return { outcome: 'ok', checked: 1, recovered: result.verdict === 'accepted' ? 1 : 0 };
        } catch (err) {
          return { outcome: 'partial', checked: 1, recovered: 0, why: String(err) };
        }
      },
    }),
  } as unknown as GitHub;
  const wiring = {
    db: t.db,
    gh,
    askIssueKind: async () => ({ judged: false as const, reason: 'unreachable' as const, detail: 'unused' }),
    log: silentLogger,
    now: () => at,
    policySource: { gh: policy, readEnv: () => 'FLEET_PUBLIC_URL=https://cockpit.example.test\n' },
  };
  const job = githubReconcileJob(wiring)({} as Client, 'fleet');
  return {
    state,
    statuses,
    accept,
    job,
    wiring,
    policy,
    setInput: (next: typeof input) => {
      input = next;
    },
    store: createPgStore(t.db, { now: () => at }),
  };
}

it('engine实际装配：poll synced先发布当前source再accepted，重复幂等，新head新版补发', async () => {
  const h = await harness();
  h.accept.mockImplementation(async () => {
    expect(h.statuses.at(-1)?.head).toBe(h.state.head);
  });
  expect((await h.job.reconcile({ since: new Date(0) })).outcome).toBe('ok');
  expect(h.statuses).toHaveLength(1);
  expect(h.statuses[0]).toMatchObject({ head: sha, context: 'fleet-ci-policy-source/pr/12' });
  expect((await h.store.getDelivery(pollDeliveryId(slug, 'pull', 12, at.toISOString())))?.status).toBe(
    'accepted',
  );
  await h.job.reconcile({ since: new Date(0) });
  expect(h.statuses).toHaveLength(1);
  h.state.head = 'b'.repeat(40);
  h.setInput(payload(new Date(at.getTime() + 1000).toISOString()));
  await h.job.reconcile({ since: new Date(0) });
  expect(h.statuses.at(-1)?.head).toBe(h.state.head);
});

it('origin读不到使实际poll和重放保持failed，不调用裸sink，也不泄露配置异常', async () => {
  const h = await harness();
  h.wiring.policySource.readEnv = () => {
    throw new Error('private-secret');
  };
  const job = githubReconcileJob(h.wiring)({} as Client, 'fleet');
  const result = await job.reconcile({ since: new Date(0) });
  expect(result.outcome).not.toBe('ok');
  expect(result.why).not.toContain('private-secret');
  const delivery = await h.store.getDelivery(pollDeliveryId(slug, 'pull', 12, at.toISOString()));
  expect(delivery?.status).toBe('failed');
  expect(delivery?.reason).toContain('origin 未确认');
  expect(delivery?.reason).not.toContain('private-secret');
  expect(h.statuses).toHaveLength(0);
  expect(h.accept).not.toHaveBeenCalled();
});

it('失败原文进入failed，engine重放再次失败仍failed，成功才accepted，不调用裸sink', async () => {
  const h = await harness();
  h.state.fail = true;
  await h.job.reconcile({ since: new Date(0) });
  const id = pollDeliveryId(slug, 'pull', 12, at.toISOString());
  expect((await h.store.getDelivery(id))?.status).toBe('failed');
  expect(h.accept).not.toHaveBeenCalled();
  h.state.fail = false;
  await h.job.reconcile({ since: new Date(0) });
  expect((await h.store.getDelivery(id))?.status).toBe('accepted');
  expect(h.statuses).toHaveLength(1);
});

it('webhook原文从共用publisher失败后由engine实际工厂重放，持续失败不accepted', async () => {
  const h = await harness();
  const ignored = payload();
  ignored.repository.full_name = 'other/unmanaged';
  h.setInput(ignored);
  const publisher = createPolicySourcePublisher({
    origin: 'https://cockpit.example.test',
    gh: h.policy,
    find: (r) => findRepoProfile(t.db, r.owner, r.name),
  });
  // API bridge 的同一 publisher/wrapper 在 api/test/ci-policy-bridge.test.ts 另测实际 webhook 入口。
  const intake = createGitHubIntake({
    store: h.store,
    github: withPolicySource({ accept: h.accept }, publisher),
    log: silentLogger,
    now: () => at,
  });
  const original = { ...payload(), action: 'opened' };
  h.state.fail = true;
  await expect(
    intake.ingest({
      deliveryId: 'webhook-original',
      source: 'webhook',
      event: 'pull_request',
      payload: original,
    }),
  ).rejects.toThrow('source write failed');
  await h.job.reconcile({ since: new Date(0) });
  expect((await h.store.getDelivery('webhook-original'))?.status).toBe('failed');
  expect(h.accept).not.toHaveBeenCalled();
  h.state.fail = false;
  await h.job.reconcile({ since: new Date(0) });
  expect(await h.store.getDelivery('webhook-original')).toMatchObject({
    source: 'webhook',
    action: 'opened',
    status: 'accepted',
    payload: original,
  });
  expect(h.statuses).toHaveLength(1);
  expect(h.accept).toHaveBeenCalledOnce();
});

it.each(['fork', 'closed', 'outsider', 'unmanaged'])('%s不产生source授权', async (kind) => {
  const h = await harness();
  const input = payload();
  if (kind === 'fork') input.pull_request.head.repo.full_name = 'other/fork';
  if (kind === 'closed') {
    input.pull_request.state = 'closed';
    h.state.open = false;
  }
  if (kind === 'outsider') input.pull_request.user = { id: 9009, login: 'outside', type: 'User' };
  if (kind === 'unmanaged') input.repository.full_name = 'other/unmanaged';
  h.setInput(input);
  await h.job.reconcile({ since: new Date(0) });
  expect(h.statuses).toHaveLength(0);
});
