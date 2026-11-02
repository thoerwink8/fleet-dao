// 内核发布那一步的 GitHub 写口（#3783）：假 fetch 断言发出去的请求；源码里不许有任何合并的调用（不自动合并）。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  GitHubDefiniteError,
  GitHubUncertainError,
  githubWriter,
  mentionsIssue,
} from '../src/github-write.ts';

type Call = { url: string; method: string; body?: unknown; auth: string };

function api(replies: Record<string, { status?: number; json?: unknown; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    const method = init?.method ?? 'GET';
    calls.push({
      url: String(url),
      method,
      auth: h.get('authorization') ?? '',
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    const key = `${method} ${String(url).replace('https://api.github.com/repos/o/r', '')}`;
    const r = replies[key] ?? { status: 404, json: { message: 'Not Found' } };
    const status = r.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(r.json ?? {}), {
      status,
      headers: r.headers ?? {},
    });
  }) as typeof fetch;
  return { calls, w: githubWriter({ tokenFor: async () => 'ghs_x', fetch: f }) };
}

const rawPr = (n: number, ref: string, over: Record<string, unknown> = {}) => ({
  number: n,
  html_url: `https://github.com/o/r/pull/${n}`,
  state: 'open',
  merged: false,
  body: '',
  head: { ref, sha: 'a'.repeat(40) },
  ...over,
});

describe('githubWriter', () => {
  it('查分支：在回提交号、不在回 null；分支名里的斜杠保留', async () => {
    const { w, calls } = api({
      'GET /git/ref/heads/fleet2/1-d1-a1': { json: { object: { sha: 'b'.repeat(40) } } },
    });
    expect(await w.branchSha('o/r', 'fleet2/1-d1-a1')).toBe('b'.repeat(40));
    expect(await w.branchSha('o/r', 'fleet2/nope')).toBeNull();
    expect(calls[0]?.auth).toBe('Bearer ghs_x');
  });

  it('开 PR：POST /pulls 只带头、底、标题、正文，不带任何合并相关的字段', async () => {
    const { w, calls } = api({ 'POST /pulls': { status: 201, json: rawPr(5, 'fleet2/1-d1-a1') } });
    const pr = await w.openPr('o/r', { head: 'fleet2/1-d1-a1', base: 'main', title: 't', body: 'Closes #1' });
    expect(pr).toMatchObject({ number: 5, state: 'open', url: 'https://github.com/o/r/pull/5' });
    expect(calls[0]?.body).toEqual({ head: 'fleet2/1-d1-a1', base: 'main', title: 't', body: 'Closes #1' });
  });

  it('对面明确拒了（4xx）是确定的错；超时、5xx、限流是「不知道」', async () => {
    const definite = api({ 'POST /pulls': { status: 422, json: { message: 'already exists' } } });
    await expect(
      definite.w.openPr('o/r', { head: 'h', base: 'b', title: 't', body: '' }),
    ).rejects.toBeInstanceOf(GitHubDefiniteError);
    for (const reply of [
      { status: 502 },
      { status: 429 },
      { status: 403, headers: { 'x-ratelimit-remaining': '0' } },
    ]) {
      const a = api({ 'POST /pulls': reply });
      await expect(a.w.openPr('o/r', { head: 'h', base: 'b', title: 't', body: '' })).rejects.toBeInstanceOf(
        GitHubUncertainError,
      );
    }
    const down = githubWriter({
      tokenFor: async () => 't',
      fetch: (async () => {
        throw new Error('ECONNRESET');
      }) as unknown as typeof fetch,
    });
    await expect(down.getPr('o/r', 1)).rejects.toBeInstanceOf(GitHubUncertainError);
  });

  it('找以某分支为头的 PR（含关了的）：只认头分支名一样的', async () => {
    const { w } = api({
      'GET /pulls?state=all&per_page=5&head=o%3Afleet2%2F1-d1-a1': {
        json: [rawPr(9, 'other'), rawPr(8, 'fleet2/1-d1-a1', { state: 'closed', merged_at: '2026-11-02' })],
      },
    });
    expect(await w.prByHead('o/r', 'fleet2/1-d1-a1')).toMatchObject({
      number: 8,
      state: 'closed',
      merged: true,
    });
  });

  it('找提到这张单的开着的 PR：头分支带单号前缀，或正文有关单词', async () => {
    const { w } = api({
      'GET /pulls?state=open&per_page=100&page=1': {
        json: [
          rawPr(1, 'fleet/12-x'),
          rawPr(2, 'misc', { body: 'Fixes #12' }),
          rawPr(3, 'fleet2/120-y'),
          rawPr(4, 'misc', { body: 'see #12' }),
        ],
      },
    });
    expect((await w.openPrsForIssue('o/r', 12)).map((p) => p.number)).toEqual([1, 2]);
    expect(mentionsIssue({ headRef: 'fleet2/12-d1-a1', body: '' }, 12)).toBe(true);
    expect(mentionsIssue({ headRef: 'x', body: 'closes #1' }, 12)).toBe(false);
  });

  it('改名分支：建新名、删旧名；新名已在（422）接着删旧名', async () => {
    const sha = 'c'.repeat(40);
    const { w, calls } = api({
      'GET /git/ref/heads/fleet2/1-d1-a1': { json: { object: { sha } } },
      'POST /git/refs': { status: 422, json: { message: 'Reference already exists' } },
      'DELETE /git/refs/heads/fleet2/1-d1-a1': { status: 204 },
    });
    await w.renameBranch('o/r', 'fleet2/1-d1-a1', 'fleet2-abandoned/1-d1-a1');
    expect(calls.map((c) => `${c.method} ${c.url.split('/repos/o/r')[1]}`)).toEqual([
      'GET /git/ref/heads/fleet2/1-d1-a1',
      'POST /git/refs',
      'DELETE /git/refs/heads/fleet2/1-d1-a1',
    ]);
    expect(calls[1]?.body).toEqual({ ref: 'refs/heads/fleet2-abandoned/1-d1-a1', sha });
  });

  it('每次调用记一笔（旧坑 E1）；仓名不合法直接拒', async () => {
    const seen: string[] = [];
    const w = githubWriter({
      tokenFor: async () => 't',
      fetch: (async () =>
        new Response(JSON.stringify({ default_branch: 'main' }))) as unknown as typeof fetch,
      onCall: (what) => seen.push(what),
    });
    await w.defaultBranch('o/r');
    expect(seen).toEqual(['GET ']);
    await expect(w.defaultBranch('../etc')).rejects.toThrow('仓名不合法');
  });
});

describe('不自动合并', () => {
  it('发布这一步的源码里没有任何合并、挂自动合并的调用', () => {
    const dir = fileURLToPath(new URL('../src', import.meta.url));
    const files = ['github-write.ts', 'publish.ts', 'real-driver.ts', 'switch-back.ts', 'task-claim.ts'];
    expect(readdirSync(dir)).toEqual(expect.arrayContaining(files));
    for (const f of files) {
      const text = readFileSync(join(dir, f), 'utf8');
      // 去掉注释再扫：注释里讲「不合并」不算
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code, f).not.toMatch(
        /\/merge\b|merge_method|enablePullRequestAutoMerge|auto_merge|autoMerge|'github\.merge'/i,
      );
    }
  });
});
