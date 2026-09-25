import { describe, expect, it } from 'vitest';
import { liveGitHub, repoName, toIssue } from '../src/github-api.ts';

const TOKEN = 'test-token-value';

function row(number: number, extra: Record<string, unknown> = {}) {
  return {
    number,
    title: `单 ${number}`,
    state: 'open',
    created_at: '2026-09-25T00:00:00Z',
    labels: [{ name: '需求' }],
    milestone: { title: 'P1 核心闭环' },
    ...extra,
  };
}

/** 假 fetch：按网址回；记下每次请求的网址和令牌头。 */
function fakeFetch(routes: Record<string, () => Response>) {
  const seen: { url: string; auth: string | undefined }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ url, auth: headers.authorization });
    const route = routes[url];
    if (!route) throw new Error(`没料到的请求 ${url}`);
    return route();
  }) as typeof fetch;
  return { impl, seen };
}

const API = 'https://api.github.com/repos/o/r';
const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), { status: 200, ...init });

describe('读 GitHub：开着的 issue', () => {
  it('按 Link 头翻页读完，去掉 PR；令牌放在请求头里', async () => {
    const page2 = `${API}/issues?state=open&per_page=100&page=2`;
    const { impl, seen } = fakeFetch({
      [`${API}/issues?state=open&per_page=100`]: () =>
        json([row(28), row(53, { pull_request: {} })], { headers: { link: `<${page2}>; rel="next"` } }),
      [page2]: () => json([row(67)]),
    });
    const gh = liveGitHub('o/r', { GITHUB_TOKEN: TOKEN }, { fetchImpl: impl });
    expect((await gh.openIssues()).map((i) => i.number)).toEqual([28, 67]);
    expect(seen.map((s) => s.auth)).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
  });

  it('没有 GITHUB_TOKEN、GH_TOKEN：用 gh auth token 的；都没有就不带', async () => {
    const { impl, seen } = fakeFetch({ [`${API}/issues?state=open&per_page=100`]: () => json([]) });
    await liveGitHub('o/r', {}, { fetchImpl: impl, token: () => 'from-gh' }).openIssues();
    await liveGitHub('o/r', {}, { fetchImpl: impl, token: () => undefined }).openIssues();
    expect(seen.map((s) => s.auth)).toEqual(['Bearer from-gh', undefined]);
  });

  it('翻了 50 页还有下一页：抛，不当成读完了', async () => {
    const url = `${API}/issues?state=open&per_page=100`;
    const { impl } = fakeFetch({ [url]: () => json([], { headers: { link: `<${url}>; rel="next"` } }) });
    await expect(
      liveGitHub('o/r', {}, { fetchImpl: impl, token: () => undefined }).openIssues(),
    ).rejects.toThrow('翻了 50 页还没完');
  });
});

describe('读 GitHub：读不到、认不出都抛（调用方判没查成）', () => {
  const url = `${API}/issues?state=open&per_page=100`;
  const read = (route: () => Response, env: Record<string, string> = {}) =>
    liveGitHub('o/r', env, {
      fetchImpl: fakeFetch({ [url]: route }).impl,
      token: () => undefined,
    }).openIssues();

  it('连不上', async () => {
    const impl = (async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    }) as unknown as typeof fetch;
    await expect(
      liveGitHub('o/r', {}, { fetchImpl: impl, token: () => undefined }).openIssues(),
    ).rejects.toThrow('连不上 GitHub（fetch failed：ECONNRESET）');
  });

  it('回了 500：报状态码', async () => {
    await expect(read(() => new Response('oops', { status: 500 }))).rejects.toThrow(
      '读开着的 issue，GitHub 回了 500',
    );
  });

  it('被限流、又没带令牌：说清怎么办；报错里不带令牌', async () => {
    const limited = () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
    await expect(read(limited)).rejects.toThrow(
      '没带令牌时每小时 60 次；设 GITHUB_TOKEN，或本机 gh auth login',
    );
    const err = await read(limited, { GITHUB_TOKEN: TOKEN }).catch((e: Error) => e.message);
    expect(err).toBe('读开着的 issue，GitHub 回了 403：被限流了');
    expect(err).not.toContain(TOKEN);
  });

  it('不是 JSON', async () => {
    await expect(read(() => new Response('<html>', { status: 200 }))).rejects.toThrow('读回来的不是 JSON');
  });

  it('不是列表', async () => {
    await expect(read(() => json({ message: 'x' }))).rejects.toThrow('读回来的不是列表');
  });

  it.each([
    ['没有 number', { number: 'x' }, 'number'],
    ['state 不认得', { state: 'merged' }, 'state'],
    ['labels 不是带 name 的列表', { labels: ['需求'] }, 'labels'],
    ['milestone 不是 null 也不是带 title 的', { milestone: 'P1' }, 'milestone'],
    ['没有 created_at', { created_at: undefined }, 'created_at'],
  ])('有一条%s', async (_name, extra, field) => {
    await expect(read(() => json([row(1, extra)]))).rejects.toThrow(`有一条认不出（${field}）`);
  });
});

describe('读 GitHub：单张、里程碑', () => {
  it('404、410 = 没有这张；别的错抛；PR 认得出', async () => {
    const { impl } = fakeFetch({
      [`${API}/issues/1`]: () => new Response('{}', { status: 404 }),
      [`${API}/issues/2`]: () => new Response('{}', { status: 410 }),
      [`${API}/issues/3`]: () => new Response('{}', { status: 502 }),
      [`${API}/issues/4`]: () => json(row(4, { pull_request: { url: 'x' }, state: 'closed' })),
    });
    const gh = liveGitHub('o/r', {}, { fetchImpl: impl, token: () => undefined });
    expect(await gh.issue(1)).toBeUndefined();
    expect(await gh.issue(2)).toBeUndefined();
    await expect(gh.issue(3)).rejects.toThrow('读 #3 ，GitHub 回了 502');
    expect(await gh.issue(4)).toMatchObject({ number: 4, isPr: true, state: 'closed' });
  });

  it('里程碑和里程碑里开着的单', async () => {
    const { impl } = fakeFetch({
      [`${API}/milestones?state=all&per_page=100`]: () =>
        json([{ number: 2, title: 'P1 核心闭环', state: 'open' }]),
      [`${API}/issues?milestone=2&state=open&per_page=100`]: () =>
        json([row(28), row(56, { pull_request: {} })]),
    });
    const gh = liveGitHub('o/r', {}, { fetchImpl: impl, token: () => undefined });
    expect(await gh.milestones()).toEqual([{ number: 2, title: 'P1 核心闭环', state: 'open' }]);
    expect((await gh.openInMilestone(2)).map((i) => [i.number, i.isPr])).toEqual([
      [28, false],
      [56, true],
    ]);
  });

  it('里程碑认不出：抛', async () => {
    const { impl } = fakeFetch({
      [`${API}/milestones?state=all&per_page=100`]: () => json([{ title: 'P1' }]),
    });
    await expect(
      liveGitHub('o/r', {}, { fetchImpl: impl, token: () => undefined }).milestones(),
    ).rejects.toThrow('读里程碑，有一条认不出');
  });

  it('toIssue：milestone 为 null 也行', () => {
    expect(toIssue(row(9, { milestone: null })).milestone).toBeNull();
  });
});

describe('读 GitHub：认是哪个仓', () => {
  it('GITHUB_REPOSITORY 优先；不像 owner/名字 的不认', () => {
    expect(repoName({ GITHUB_REPOSITORY: 'o/r' }, '.', () => undefined)).toBe('o/r');
    expect(repoName({ GITHUB_REPOSITORY: 'o/r/x' }, '.', () => undefined)).toBeUndefined();
  });

  it('从 origin 的地址认（https、ssh，带不带 .git）；不是 GitHub 的不认', () => {
    const origin = (url: string | undefined) => repoName({}, '.', () => url);
    expect(origin('https://github.com/o/r.git\n')).toBe('o/r');
    expect(origin('git@github.com:o/r.git')).toBe('o/r');
    expect(origin('https://github.com/o/r')).toBe('o/r');
    expect(origin('https://gitlab.com/o/r.git')).toBeUndefined();
    expect(origin(undefined)).toBeUndefined();
  });
});
