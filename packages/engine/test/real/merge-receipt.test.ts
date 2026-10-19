// 等 CI 时 PR 已经合了（#3018，#2751 那次：waitCi 回 merged 直接收尾，账上只剩每小时对账补的 github.merge_pr_backfill）。
// 真 createGitHub（真 mergePr、真幂等账）接一份受控 HTTP 假服务，waitCi 换成「已合并」：
// 新账记成 github.merge_pr；账上已有正常账、已有 backfill 的原样留着不改来源；重试幂等；从头到尾不发合并请求、不贴状态。
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AppCredentials,
  createGitHub,
  GitHubError,
  type MergeReceipt,
  memoryIdempotencyStore,
  memoryLedger,
  mergeKey,
  reviewMergeHold,
  silentLogger,
} from '@fleet-dao/github';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PortContext } from '../../src/ports.ts';
import { localExec } from '../../src/real/exec.ts';
import { createGitHubPorts, type EngineGitHub } from '../../src/real/github-ports.ts';
import { readMergedTask } from '../../src/real/merge-receipt.ts';
import type { TaskActivitiesDeps } from '../../src/real/task-activities.ts';
import { reviewChangesReader } from '../../src/real/task-verify.ts';
import { fakeTrees } from './fixtures.ts';

const API = 'https://api.github.test';
const PERMISSIONS = {
  contents: 'write',
  pull_requests: 'write',
  issues: 'write',
  checks: 'read',
  actions: 'read',
  statuses: 'write',
  metadata: 'read',
  administration: 'write',
};
const repo = {
  id: 'repo-1',
  owner: 'acme',
  name: 'widgets',
  defaultBranch: 'main',
  testCommand: 'pnpm check',
};
const ref = { owner: 'acme', name: 'widgets' };
const BRANCH = 'fleet/2751-t01a14481';
const HEAD = '78ebe6e4526e42826e5e5c3c182624b832ae9d4c';
const MERGE = '88dfbf760e55013cbf125462b5c5a89f9b206740';
const PR = 2751;
const ENGINE_LOGIN = 'fleet-test-engine[bot]';
const MERGED_AT = '2026-10-16T11:12:42Z';

const ctx: PortContext = {
  signal: new AbortController().signal,
  heartbeat() {},
  attempt: 1,
  lastHeartbeat: undefined,
  workflowId: 'task-ci-merged-late',
};

let apps: Record<'agent' | 'engine', AppCredentials> | undefined;
function appCredentials(): Record<'agent' | 'engine', AppCredentials> {
  if (apps) return apps;
  const agent = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const engine = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  apps = {
    agent: { role: 'agent', appId: 101, slug: 'fleet-test-agent', privateKey: agent, source: 'test' },
    engine: { role: 'engine', appId: 202, slug: 'fleet-test-engine', privateKey: engine, source: 'test' },
  };
  return apps;
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-merge-receipt-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

type WriterFault =
  | 'open'
  | 'open-merged'
  | 'closed-unmerged'
  | 'wrong-number'
  | 'wrong-head'
  | 'unknown-merged'
  | 'read-failed'
  | 'unknown-actor'
  | 'blank-actor'
  | 'other-actor'
  | { mergeCommit: string | null };

function world(
  fault?: WriterFault,
  late?: { readFails?: boolean; writeFails?: boolean; approved?: boolean },
) {
  const requests: string[] = [];
  const notes: Parameters<NonNullable<TaskActivitiesDeps['onLateReview']>>[0][] = [];
  const author = { login: 'boss', id: 1001, type: 'User' };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const pull = {
    number: PR,
    node_id: `PR_${PR}`,
    html_url: `https://github.test/acme/widgets/pull/${PR}`,
    state: 'closed',
    title: '修登录',
    body: '',
    draft: false,
    merged: true,
    merged_at: MERGED_AT as string | null,
    merge_commit_sha: MERGE as string | null,
    mergeable: true,
    user: { login: 'fleet-test-agent[bot]', id: 7, type: 'Bot' },
    merged_by: { login: ENGINE_LOGIN, id: 9, type: 'Bot' } as {
      login: string;
      id: number;
      type: string;
    } | null,
    head: { ref: BRANCH, sha: HEAD, repo: { full_name: 'acme/widgets' } },
    base: { ref: 'main', sha: 'b'.repeat(40), repo: { full_name: 'acme/widgets' } },
    updated_at: MERGED_AT,
  };
  let pullReads = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    requests.push(`${method} ${path}`);
    if (path === '/repos/acme/widgets/installation') return json(200, { id: 22, permissions: PERMISSIONS });
    if (path === '/app/installations/22/access_tokens') {
      return json(201, {
        token: 'ghs_testengine1xxxxxxxxxxxxxxxx',
        expires_at: '2099-01-01T00:00:00.000Z',
        permissions: PERMISSIONS,
      });
    }
    if (method === 'GET' && path === '/repos/acme/widgets') {
      return json(200, { default_branch: 'main', full_name: 'acme/widgets', private: false });
    }
    if (method === 'GET' && path === `/repos/acme/widgets/pulls/${PR}`) {
      if (++pullReads >= 2 && fault === 'read-failed') return json(502, { message: '读 PR 失败' });
      // 第一次是 claims 的前置核验；第二次才是 writer 真正会拿来写账的响应。
      if (pullReads === 2) {
        if (fault === 'open-merged') pull.state = 'open';
        else if (fault === 'open' || fault === 'closed-unmerged') {
          pull.state = fault === 'open' ? 'open' : 'closed';
          pull.merged = false;
        } else if (fault === 'wrong-number') pull.number += 1;
        else if (fault === 'wrong-head') pull.head.sha = 'e'.repeat(40);
        else if (fault === 'unknown-merged') Reflect.deleteProperty(pull, 'merged');
        else if (fault === 'unknown-actor') pull.merged_by = null;
        else if (fault === 'blank-actor') pull.merged_by = { login: ' \t', id: 42, type: 'User' };
        else if (fault === 'other-actor') pull.merged_by = { login: 'maintainer', id: 42, type: 'User' };
        else if (typeof fault === 'object') pull.merge_commit_sha = fault.mergeCommit;
      }
      return json(200, pull);
    }
    // 如果补账错误退入主动合并，假服务必须具备全绿检查和成功 PUT，负例不能碰巧被缺失夹具挡住。
    if (method === 'GET' && path.includes('/compare/')) return json(200, { behind_by: 0, ahead_by: 1 });
    if (method === 'GET' && path === '/repos/acme/widgets/rules/branches/main') {
      return json(200, [
        { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'check' }] } },
      ]);
    }
    if (method === 'GET' && path === `/repos/acme/widgets/commits/${HEAD}/check-runs`) {
      return json(200, {
        check_runs: [{ id: 1, name: 'check', head_sha: HEAD, status: 'completed', conclusion: 'success' }],
      });
    }
    if (method === 'GET' && path === `/repos/acme/widgets/commits/${HEAD}/status`) {
      return json(200, { statuses: [] });
    }
    if (method === 'PUT' && path === `/repos/acme/widgets/pulls/${PR}/merge`) {
      pull.state = 'closed';
      pull.merged = true;
      return json(200, { merged: true, sha: MERGE });
    }
    if (method === 'GET' && path === `/repos/acme/widgets/pulls/${PR}/reviews`)
      return json(200, [
        {
          id: 99,
          user: author,
          state: late?.approved ? 'APPROVED' : 'CHANGES_REQUESTED',
          body: '具体漏洞见行内评论',
          commit_id: HEAD,
          submitted_at: MERGED_AT,
        },
      ]);
    if (method === 'GET' && path === `/repos/acme/widgets/pulls/${PR}/reviews/99/comments`) {
      if (!url.searchParams.has('page'))
        return new Response('[]', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            link: `<${API}${path}?per_page=100&page=2>; rel="next"`,
          },
        });
      if (late?.readFails) return json(502, { message: 'late inline second page unavailable' });
      return json(200, [
        {
          id: 102,
          pull_request_review_id: 99,
          user: author,
          body: 'LATE_CI_INLINE_UNDELIVERED',
          path: 'src/auth.ts',
          pull_request_url: `${API}/repos/acme/widgets/pulls/${PR}`,
          line: null,
          original_line: 8,
          commit_id: HEAD,
          original_commit_id: HEAD,
          updated_at: MERGED_AT,
        },
      ]);
    }
    // 分支合并后已经删了
    if (method === 'GET' && path.startsWith('/repos/acme/widgets/git/ref/heads/')) {
      return json(404, { message: 'Not Found' });
    }
    return json(404, { message: `假 GitHub 里没有 ${method} ${path}` });
  };
  const store = memoryIdempotencyStore();
  const real = createGitHub({
    ledger: { ...memoryLedger(), idempotency: store },
    apps: appCredentials(),
    apiUrl: API,
    fetch: fetchImpl,
    now: () => new Date('2026-10-17T08:00:00.000Z'),
    sleep: async () => undefined,
    env: {},
    stateDir: join(root, 'gh-state'),
    log: silentLogger,
  });
  const gh = {
    ...real,
    // github 包的 waitCi 等的时候 PR 被合了：closed + merged + 合并提交（#2751 event1044/1051）
    waitCi: async (input: { head: string }) => {
      return {
        state: 'closed',
        head: input.head,
        merged: true,
        mergeCommit: MERGE,
        detail: `PR #${PR} 已经合并了`,
      };
    },
  } as unknown as EngineGitHub;
  const logs: string[] = [];
  const reviewChanges = reviewChangesReader({
    listReviews: real.claims.listReviews,
    listReviewComments: real.claims.listReviewComments,
    whitelist: async () => ({
      userIds: new Set([author.id]),
      botIds: new Set<number>(),
      logins: new Set<string>(),
    }),
  });
  const reviewDeps = late
    ? {
        reviewChanges,
        onLateReview: async (note: (typeof notes)[number]) => {
          if (late.writeFails) throw Error('late ledger unavailable');
          notes.push(note);
        },
      }
    : {};
  const ports = createGitHubPorts({
    gh: late ? real : gh,
    ...reviewDeps,
    trees: fakeTrees(join(root, 'work')).trees,
    exec: localExec(),
    tmpDir: join(root, 'tmp'),
    archiveDir: join(root, 'archive'),
    log: (message) => logs.push(message),
  });
  const waitCi = () => ports.waitCi({ taskId: 't1', repo, prNumber: PR, branch: BRANCH, head: HEAD }, ctx);
  const key = mergeKey(ref, PR, HEAD);
  return { waitCi, store, key, requests, logs, notes, real, pull, author };
}

const receipt: MergeReceipt = { number: PR, head: HEAD, mergeCommit: MERGE, mergedBy: ENGINE_LOGIN };
const merged = { state: 'merged', head: HEAD, failedChecks: [], mergeCommit: MERGE };

describe('已合任务精确收尾回执（#3193）', () => {
  const input = { schemaVersion: 1 as const, repo: ref, prNumber: PR, expectedHead: HEAD };
  it('真实 writer onlyBook 记账，重复读取幂等，不发合并请求', async () => {
    const w = world();
    const expected = { repo: ref, prNumber: PR, head: HEAD, mergeCommit: MERGE };
    expect(await readMergedTask(w.real, input, ctx)).toEqual(expected);
    expect(await readMergedTask(w.real, input, ctx)).toEqual(expected);
    expect(mergeKeys(w.store)).toEqual([w.key]);
    noWrites(w.requests);
  });
  it('普通未合 PR 返回 null，也不记成功账', async () => {
    const w = world('open');
    w.pull.state = 'open';
    w.pull.merged = false;
    w.pull.merged_at = null;
    expect(await readMergedTask(w.real, input, ctx)).toBeNull();
    expect(mergeKeys(w.store)).toEqual([]);
    noWrites(w.requests);
  });
  it('第一次 claims 读取合并字段全缺，明确未知，不回 null 授权关单', async () => {
    const w = world();
    const raw = w.pull as unknown as Record<string, unknown>;
    delete raw.merged;
    delete raw.merged_at;
    await expect(readMergedTask(w.real, input, ctx)).rejects.toThrow('合并状态未知');
    expect(mergeKeys(w.store)).toEqual([]);
    noWrites(w.requests);
  });
  it('第一次 claims 的 merged=false 却带真实合并时间，拒绝矛盾而非授权关单', async () => {
    const w = world();
    w.pull.merged = false;
    await expect(readMergedTask(w.real, input, ctx)).rejects.toThrow('合并状态矛盾');
    expect(mergeKeys(w.store)).toEqual([]);
    noWrites(w.requests);
  });
  it.each(['wrong-number', 'wrong-head', 'unknown-merged'] as const)('拒绝 %s', async (fault) => {
    const w = world(fault);
    await expect(readMergedTask(w.real, input, ctx)).rejects.toThrow();
    expect(mergeKeys(w.store)).toEqual([]);
    noWrites(w.requests);
  });
  it('预期合并提交与真实回执不同，不接受停法收尾', async () => {
    const w = world();
    await expect(
      readMergedTask(w.real, { ...input, expectedMergeCommit: 'f'.repeat(40) }, ctx),
    ).rejects.toThrow('真实合并回执');
    noWrites(w.requests);
  });
  it('GitHub 读取失败不能凑未合或已合', async () => {
    const w = world('read-failed');
    await expect(readMergedTask(w.real, input, ctx)).rejects.toThrow();
    expect(mergeKeys(w.store)).toEqual([]);
  });
});

/** 账上的合并键（只该有这张 PR 这个头的一把）。 */
function mergeKeys(store: ReturnType<typeof memoryIdempotencyStore>): string[] {
  return [...store.rows.keys()].filter((k) => k.startsWith('gh:merge_pr:'));
}

/** 没发合并请求（PUT …/merge）、没贴提交状态（不补造合前通过）。 */
function noWrites(requests: readonly string[]) {
  expect(
    requests.filter((r) => r.startsWith('PUT ') || r.startsWith('PATCH ') || r.includes('/statuses/')),
  ).toEqual([]);
}

describe('等 CI 看到已合并：走真实回执收口（#3018）', () => {
  it.each([false, true])(
    '事件看到open且未挂合并后外部合并：真实waitCi/HTTP/reader补未送达账，行内读失败=%s',
    async (readFails) => {
      const w = world(undefined, { readFails });
      w.pull.state = 'open';
      w.pull.merged = false;
      w.pull.merged_at = null;
      const eventNotes: unknown[] = [];
      const hold = reviewMergeHold(w.real.claims, undefined, async (note) => {
        eventNotes.push(note);
      });
      const eventPullReads = w.requests.filter((r) => r === `GET /repos/acme/widgets/pulls/${PR}`).length;
      await hold.wake({
        repo: 'acme/widgets',
        prNumbers: [PR],
        deliveryId: 'late-ci-review',
        source: 'webhook',
        event: 'pull_request_review',
        action: 'submitted',
        reviewState: 'changes_requested',
        headRef: BRANCH,
        review: { id: 99, reviewer: w.author.login, commitId: HEAD },
      });
      expect(w.requests.filter((r) => r === `GET /repos/acme/widgets/pulls/${PR}`).length).toBe(
        eventPullReads + 1,
      );
      expect(eventNotes).toEqual([]);
      w.pull.state = 'closed';
      w.pull.merged = true;
      w.pull.merged_at = MERGED_AT;
      expect(await w.waitCi()).toEqual(merged);
      expect(w.notes).toHaveLength(1);
      expect(w.notes[0]?.workflowId).toBe(ctx.workflowId);
      expect(w.notes[0]).toMatchObject(
        readFails
          ? {
              repo: ref,
              prNumber: PR,
              review: null,
              error: expect.stringContaining('late inline second page unavailable'),
            }
          : {
              repo: ref,
              prNumber: PR,
              review: { reviewId: 99, inlineComments: [{ id: 102, body: 'LATE_CI_INLINE_UNDELIVERED' }] },
            },
      );
      noWrites(w.requests);
    },
  );

  it.each([false, true])(
    '真实waitCi已合后的late明账写失败抛出，重试仍尝试记账；APPROVED无误报；读失败=%s',
    async (readFails) => {
      const options = { writeFails: true, readFails };
      const w = world(undefined, options);
      await expect(w.waitCi()).rejects.toThrow('late ledger unavailable');
      options.writeFails = false;
      expect(await w.waitCi()).toEqual(merged);
      expect(w.notes).toHaveLength(1);
      const approved = world(undefined, { approved: true });
      expect(await approved.waitCi()).toEqual(merged);
      expect(approved.notes).toEqual([]);
    },
  );

  it('正常合法路径、账上还没有：记成 github.merge_pr，回执是 GitHub 实际的头、合并提交、合并人；重试幂等', async () => {
    const w = world();
    expect(await w.waitCi()).toEqual(merged);
    const row = w.store.rows.get(w.key);
    expect(row?.action).toBe('github.merge_pr');
    expect(row?.completedAt).toBeInstanceOf(Date);
    expect(row?.result).toEqual(receipt);
    const firstDone = row?.completedAt;

    // 活动重试 / 工作流重放再进来：账不重记、不改，仍不发合并请求
    expect(await w.waitCi()).toEqual(merged);
    expect(w.store.rows.get(w.key)?.completedAt).toBe(firstDone);
    expect(mergeKeys(w.store)).toEqual([w.key]);
    noWrites(w.requests);
    expect(w.logs).toEqual([]);
  });

  it('账上已有真实的正常账（github.merge_pr）：原样留着，不重记', async () => {
    const w = world();
    const at = new Date(MERGED_AT);
    await w.store.claim({ key: w.key, action: 'github.merge_pr', target: `acme/widgets#${PR}` }, at);
    await w.store.complete(w.key, receipt, at);
    expect(await w.waitCi()).toEqual(merged);
    expect(w.store.rows.get(w.key)).toMatchObject({
      action: 'github.merge_pr',
      completedAt: at,
      result: receipt,
    });
    noWrites(w.requests);
  });

  it('账上已有每小时对账补的 github.merge_pr_backfill：来源不升级、不覆盖成 github.merge_pr，回执不动', async () => {
    const w = world();
    const at = new Date(MERGED_AT);
    await w.store.claim({ key: w.key, action: 'github.merge_pr_backfill', target: `acme/widgets#${PR}` }, at);
    await w.store.complete(w.key, receipt, at);
    expect(await w.waitCi()).toEqual(merged);
    expect(await w.waitCi()).toEqual(merged);
    expect(w.store.rows.get(w.key)).toMatchObject({
      action: 'github.merge_pr_backfill',
      completedAt: at,
      result: receipt,
    });
    expect(mergeKeys(w.store)).toEqual([w.key]);
    noWrites(w.requests);
  });
});

describe('已合并观察的 writer 只记账边界（#3026）', () => {
  function noMergeOrReceipt(w: ReturnType<typeof world>) {
    noWrites(w.requests);
    expect(mergeKeys(w.store)).toEqual([]);
  }

  it.each(['open', 'open-merged', 'closed-unmerged'] as const)(
    '前置读已合并，writer 重读 %s：明确失败，零合并请求、零成功回执',
    async (state) => {
      const w = world(state);
      await expect(w.waitCi()).rejects.toMatchObject({
        code: 'MERGE_RECEIPT_FAILED',
        retryable: state !== 'closed-unmerged',
        details: { cause: 'READBACK_MISMATCH' },
      });
      noMergeOrReceipt(w);
      expect(w.logs).toContainEqual(expect.stringContaining('记合并回执没成'));
    },
  );

  it('前置 PR 号正确，writer 响应另一个号：写账前拒绝，不生成混合身份回执', async () => {
    const w = world('wrong-number');
    await expect(w.waitCi()).rejects.toMatchObject({
      code: 'MERGE_RECEIPT_FAILED',
      details: { cause: 'UNEXPECTED_RESPONSE' },
    });
    noMergeOrReceipt(w);
  });

  it('writer 头变了：明确回 unknown，不记账、不冒称合上 CI 查过的头', async () => {
    const w = world('wrong-head');
    expect(await w.waitCi()).toMatchObject({ state: 'unknown', head: HEAD });
    noMergeOrReceipt(w);
  });

  it('writer 不给 merged 事实：明确失败，不能把未知当已合并', async () => {
    const w = world('unknown-merged');
    await expect(w.waitCi()).rejects.toMatchObject({
      code: 'MERGE_RECEIPT_FAILED',
      details: { cause: 'READBACK_MISMATCH' },
    });
    noMergeOrReceipt(w);
  });

  it.each([null, '', '不是提交', 'c'.repeat(41)])(
    'writer 合并提交不完整（%s）：写账前失败',
    async (mergeCommit) => {
      const w = world({ mergeCommit });
      await expect(w.waitCi()).rejects.toMatchObject({
        code: 'MERGE_RECEIPT_FAILED',
        details: { cause: 'UNEXPECTED_RESPONSE' },
      });
      noMergeOrReceipt(w);
    },
  );

  it.each(['unknown-actor', 'blank-actor'] as const)(
    'writer 合并人未知（%s）：不先写成功回执再声称记账完成',
    async (fault) => {
      const w = world(fault);
      await expect(w.waitCi()).rejects.toMatchObject({
        code: 'MERGE_RECEIPT_FAILED',
        details: { cause: 'UNEXPECTED_RESPONSE' },
      });
      noMergeOrReceipt(w);
    },
  );

  it('writer 读取失败：原错误进入明确失败结果，不写账', async () => {
    const w = world('read-failed');
    await expect(w.waitCi()).rejects.toMatchObject({ code: 'MERGE_RECEIPT_FAILED', retryable: true });
    noMergeOrReceipt(w);
  });

  it('实际合并者已知但不是引擎：保留真实 actor 和告警，不伪造引擎身份', async () => {
    const w = world('other-actor');
    expect(await w.waitCi()).toEqual(merged);
    expect(w.store.rows.get(w.key)?.result).toMatchObject({ mergedBy: 'maintainer' });
    expect(w.logs).toContainEqual(expect.stringContaining('不是「引擎」机器人合的'));
    noWrites(w.requests);
  });

  it('真实 ledger 写失败：不回 merged，不生成成功回执；重试仍只记账', async () => {
    const w = world();
    const complete = w.store.complete;
    w.store.complete = async () => {
      throw new GitHubError('UPSTREAM_ERROR', '回执存储不可用', { retryable: true });
    };
    await expect(w.waitCi()).rejects.toMatchObject({ code: 'MERGE_RECEIPT_FAILED', retryable: true });
    expect(w.store.rows.get(w.key)?.completedAt).toBeUndefined();
    w.store.complete = complete;
    expect(await w.waitCi()).toEqual(merged);
    expect(w.store.rows.get(w.key)?.result).toEqual(receipt);
    noWrites(w.requests);
  });
});
