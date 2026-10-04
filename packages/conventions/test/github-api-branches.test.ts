// 分支体检读写 GitHub 的那几样（github-api.ts 的 GitHubBranches）：按网址回假数据。读回来认不出的每一样故意造出来，
// 断言是抛（调用方判没查成），不是空列表；删分支时「本来就没了」和「不让删」分得开。
import { describe, expect, it } from 'vitest';
import { liveGitHub, toPullHead } from '../src/github-api.ts';

const API = 'https://api.github.com/repos/o/r';
const SHA = 'a'.repeat(40);
const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), { status: 200, ...init });

function gh(routes: Record<string, (init?: RequestInit) => Response>) {
  const seen: { url: string; method: string; body: string | undefined }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    seen.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
    const route = routes[`${method} ${url}`];
    if (!route) throw new Error(`没料到的请求 ${method} ${url}`);
    return route(init);
  }) as typeof fetch;
  return { client: liveGitHub('o/r', { GITHUB_TOKEN: 't' }, { fetchImpl: impl }), seen };
}

const pull = (extra: Record<string, unknown> = {}) => ({
  number: 5,
  state: 'closed',
  merged_at: '2026-10-01T00:00:00Z',
  head: { ref: 'feat/x', sha: SHA, repo: { full_name: 'o/r' } },
  base: { ref: 'main' },
  ...extra,
});

describe('分支体检读 GitHub', () => {
  it('默认分支、分支清单（名字、头、受不受保护）', async () => {
    const { client } = gh({
      [`GET ${API}`]: () => json({ default_branch: 'main' }),
      [`GET ${API}/branches?per_page=100`]: () =>
        json([{ name: 'main', commit: { sha: SHA }, protected: true }]),
    });
    expect(await client.defaultBranch()).toBe('main');
    expect(await client.branches()).toEqual([{ name: 'main', sha: SHA, protected: true }]);
  });

  it('分支清单里有一条认不出（头不是 40 位、没有 protected）：抛', async () => {
    const bad = (row: unknown) =>
      gh({ [`GET ${API}/branches?per_page=100`]: () => json([row]) }).client.branches();
    await expect(bad({ name: 'x', commit: { sha: 'abc' }, protected: false })).rejects.toThrow(
      /认不出（commit.sha）/,
    );
    await expect(bad({ name: 'x', commit: { sha: SHA } })).rejects.toThrow(/认不出（protected）/);
    const { client } = gh({ [`GET ${API}`]: () => json({}) });
    await expect(client.defaultBranch()).rejects.toThrow(/认不出（default_branch）/);
  });

  it('PR：头、目标分支、合没合；fork 被删了 head.repo 是 null', async () => {
    expect(toPullHead(pull())).toEqual({
      number: 5,
      state: 'closed',
      merged: true,
      headRef: 'feat/x',
      headSha: SHA,
      headRepo: 'o/r',
      baseRef: 'main',
    });
    expect(
      toPullHead(pull({ merged_at: null, head: { ref: 'y', sha: SHA, repo: null } })).headRepo,
    ).toBeNull();
  });

  it('PR 认不出（merged_at 整个不在、头号不对、state 不认得）：抛，不当成没合并（漏认开着的 PR 会删掉它的分支）', () => {
    const { merged_at: _, ...noMerged } = pull();
    expect(() => toPullHead(noMerged)).toThrow(/merged_at/);
    expect(() => toPullHead(pull({ head: { ref: 'x', sha: 'zz', repo: null } }))).toThrow(/head/);
    expect(() => toPullHead(pull({ state: 'merged' }))).toThrow(/state/);
    expect(() => toPullHead(pull({ head: { ref: 'x', sha: SHA } }))).toThrow(/head.repo/);
  });

  it('开着的单和 PR：正文、评论都带上；评论数是 0 的不去读评论', async () => {
    const { client, seen } = gh({
      [`GET ${API}/issues?state=open&per_page=100`]: () =>
        json([
          {
            number: 1,
            title: 'a',
            state: 'open',
            created_at: 'x',
            labels: [],
            milestone: null,
            body: '正文',
            comments: 2,
          },
          {
            number: 2,
            title: 'b',
            state: 'open',
            created_at: 'x',
            labels: [],
            milestone: null,
            body: null,
            comments: 0,
            pull_request: {},
          },
        ]),
      [`GET ${API}/issues/1/comments?per_page=100`]: () => json([{ body: '评论一' }, { body: '评论二' }]),
    });
    expect(await client.openThreads()).toEqual([
      { number: 1, isPr: false, title: 'a', body: '正文', comments: ['评论一', '评论二'] },
      { number: 2, isPr: true, title: 'b', body: '', comments: [] },
    ]);
    expect(seen.filter((s) => s.url.includes('/comments'))).toHaveLength(1);
  });

  it('开着的单的评论读不到：抛（不拿空当没人提到）', async () => {
    const { client } = gh({
      [`GET ${API}/issues?state=open&per_page=100`]: () =>
        json([
          {
            number: 1,
            title: 'a',
            state: 'open',
            created_at: 'x',
            labels: [],
            milestone: null,
            body: '',
            comments: 1,
          },
        ]),
      [`GET ${API}/issues/1/comments?per_page=100`]: () => new Response('', { status: 502 }),
    });
    await expect(client.openThreads()).rejects.toThrow(/#1 的留言，GitHub 回了 502/);
  });

  it('动态：按分支查，谁、什么时候、干了什么；账号没了 actor 是 null；认不出就抛', async () => {
    const url = `${API}/activity?ref=${encodeURIComponent('refs/heads/fleet/1-x')}&per_page=100`;
    const ok = gh({
      [`GET ${url}`]: () =>
        json([
          { timestamp: '2026-10-01T00:00:00Z', activity_type: 'push', actor: { login: 'o' } },
          { timestamp: '2026-09-30T00:00:00Z', activity_type: 'branch_creation', actor: null },
        ]),
    });
    expect(await ok.client.activity('fleet/1-x')).toEqual([
      { timestamp: '2026-10-01T00:00:00Z', type: 'push', actor: 'o' },
      { timestamp: '2026-09-30T00:00:00Z', type: 'branch_creation', actor: null },
    ]);
    const bad = gh({ [`GET ${url}`]: () => json([{ timestamp: 'x', activity_type: 'push', actor: null }]) });
    await expect(bad.client.activity('fleet/1-x')).rejects.toThrow(/认不出/);
  });
});

describe('分支体检写 GitHub', () => {
  const ref = `${API}/git/ref/heads/feat/a%20b`;
  const refs = `${API}/git/refs/heads/feat/a%20b`;

  it('分支头：在就回号，不在（404）回 undefined；分支名按段转义', async () => {
    const { client } = gh({ [`GET ${ref}`]: () => json({ object: { sha: SHA } }) });
    expect(await client.branchHead('feat/a b')).toBe(SHA);
    const gone = gh({ [`GET ${ref}`]: () => new Response('', { status: 404 }) });
    expect(await gone.client.branchHead('feat/a b')).toBeUndefined();
  });

  it('删分支：204 删了；404 本来就没了；422 回读还在就照报没删成，回读没了才算本来就没了', async () => {
    expect(
      await gh({ [`DELETE ${refs}`]: () => new Response(null, { status: 204 }) }).client.deleteBranch(
        'feat/a b',
      ),
    ).toBe(true);
    expect(
      await gh({ [`DELETE ${refs}`]: () => new Response('', { status: 404 }) }).client.deleteBranch(
        'feat/a b',
      ),
    ).toBe(false);
    const gone = gh({
      [`DELETE ${refs}`]: () => new Response('', { status: 422 }),
      [`GET ${ref}`]: () => new Response('', { status: 404 }),
    });
    expect(await gone.client.deleteBranch('feat/a b')).toBe(false);
    const blocked = gh({
      [`DELETE ${refs}`]: () => new Response('', { status: 422 }),
      [`GET ${ref}`]: () => json({ object: { sha: SHA } }),
    });
    await expect(blocked.client.deleteBranch('feat/a b')).rejects.toThrow(
      /在删分支 feat\/a b 时，GitHub 回了 422/,
    );
  });

  it('开单、改正文：发对内容；GitHub 没回成就抛', async () => {
    const { client, seen } = gh({
      [`POST ${API}/issues`]: () => new Response(JSON.stringify({ number: 77 }), { status: 201 }),
      [`PATCH ${API}/issues/77`]: () => json({}),
    });
    expect(await client.createIssue('题', '正文', ['杂项'])).toBe(77);
    await client.updateIssueBody(77, '新正文');
    expect(seen.map((s) => [s.method, s.body])).toEqual([
      ['POST', JSON.stringify({ title: '题', body: '正文', labels: ['杂项'] })],
      ['PATCH', JSON.stringify({ body: '新正文' })],
    ]);
    const bad = gh({ [`POST ${API}/issues`]: () => new Response('', { status: 403 }) });
    await expect(bad.client.createIssue('题', '正文', [])).rejects.toThrow(/在开单时，GitHub 回了 403/);
  });
});
