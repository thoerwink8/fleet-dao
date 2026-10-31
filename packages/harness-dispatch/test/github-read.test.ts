// 新内核读 GitHub（#3811）：只发 GET 和 GraphQL 查询；读单变六项指示，查合并 PR 和 diff。fetch 换成桩。
import { describe, expect, it } from 'vitest';
import { githubReader } from '../src/github-read.ts';

type Call = { url: string; method: string; accept: string; body?: string };

function stub(routes: Record<string, () => Response>) {
  const calls: Call[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      accept: h.get('accept') ?? '',
      body: init?.body as string,
    });
    const hit = Object.entries(routes).find(([k]) => String(url).endsWith(k));
    return hit ? hit[1]() : new Response('nope', { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}
const json = (v: unknown) => () => new Response(JSON.stringify(v), { status: 200 });
const item = { repo: 'o/r', issue: 7, baseSha: 'a'.repeat(40), snapshotAt: new Date() };

describe('读单', () => {
  it('标题和正文变成六项指示，资料截到上限；不发写', async () => {
    const { f, calls } = stub({
      '/repos/o/r/issues/7': json({ title: '修一个错', body: 'x'.repeat(30_000) }),
    });
    const six = await githubReader({ token: 't', fetch: f }).taskFor(item);
    expect(six.task).toBe('做 o/r#7：修一个错');
    expect(six.context.length).toBe(20_000);
    expect(six.must_not).toContain('不推送');
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('是 PR、没标题、HTTP 错都抛', async () => {
    const pr = stub({ '/repos/o/r/issues/7': json({ title: 'x', pull_request: {} }) });
    await expect(githubReader({ token: 't', fetch: pr.f }).taskFor(item)).rejects.toThrow('是 PR');
    const blank = stub({ '/repos/o/r/issues/7': json({ title: ' ' }) });
    await expect(githubReader({ token: 't', fetch: blank.f }).taskFor(item)).rejects.toThrow('没有标题');
    const down = stub({ '/repos/o/r/issues/7': () => new Response('', { status: 503 }) });
    await expect(githubReader({ token: 't', fetch: down.f }).taskFor(item)).rejects.toThrow('HTTP 503');
  });
});

describe('读合并结果', () => {
  const graph = (nodes: unknown[]) =>
    json({ data: { repository: { issue: { closedByPullRequestsReferences: { nodes } } } } });

  it('有合了的 PR：回号、合并提交、diff（按 diff 格式要）', async () => {
    const { f, calls } = stub({
      '/graphql': graph([
        { number: 9, merged: false, mergeCommit: null },
        { number: 10, merged: true, mergeCommit: { oid: 'b'.repeat(40) } },
      ]),
      '/repos/o/r/pulls/10': () => new Response('diff --git a/x b/x\n', { status: 200 }),
    });
    expect(await githubReader({ token: 't', fetch: f }).readMerged('o/r', 7)).toEqual({
      pr: 10,
      sha: 'b'.repeat(40),
      diff: 'diff --git a/x b/x\n',
    });
    expect(calls[0]?.body).toContain('closedByPullRequestsReferences');
    expect(calls[0]?.body).not.toMatch(/mutation/);
    expect(calls[1]?.accept).toBe('application/vnd.github.diff');
  });

  it('还没合：回 undefined；GraphQL 报错、形状认不出：抛', async () => {
    const open = stub({ '/graphql': graph([{ number: 9, merged: false, mergeCommit: null }]) });
    expect(await githubReader({ token: 't', fetch: open.f }).readMerged('o/r', 7)).toBeUndefined();
    const err = stub({ '/graphql': json({ errors: [{ message: 'rate limited' }] }) });
    await expect(githubReader({ token: 't', fetch: err.f }).readMerged('o/r', 7)).rejects.toThrow(
      'rate limited',
    );
    const odd = stub({ '/graphql': json({ data: {} }) });
    await expect(githubReader({ token: 't', fetch: odd.f }).readMerged('o/r', 7)).rejects.toThrow('认不出');
  });
});
