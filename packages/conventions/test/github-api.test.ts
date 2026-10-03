import { describe, expect, it } from 'vitest';
import { githubToken, liveGitHub, repoName, toIssue } from '../src/github-api.ts';

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

  it('toIssue：正文带着就读（null 是空正文）；没带的不拿空串顶；【失败】不是字符串的认不出', () => {
    expect(toIssue(row(9, { body: '## 怎么算做完\n\n- a\n' })).body).toBe('## 怎么算做完\n\n- a\n');
    expect(toIssue(row(9, { body: null })).body).toBe('');
    expect(toIssue(row(9))).not.toHaveProperty('body');
    expect(() => toIssue(row(9, { body: 42 }))).toThrow('认不出（body）');
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

describe('读 GitHub：单上的留言（欠账的定时任务用）', () => {
  it('读留言正文；留言用 POST、带 JSON，回 201 才算留成', async () => {
    const posts: { method: string | undefined; body: string | undefined }[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === `${API}/issues/29/comments?per_page=100`) return json([{ body: '甲' }, { body: '乙' }]);
      if (url === `${API}/issues/29/comments`) {
        posts.push({ method: init?.method, body: init?.body as string | undefined });
        return new Response('{}', { status: 201 });
      }
      if (url === `${API}/issues/30/comments`) return new Response('{}', { status: 403 });
      throw new Error(`没料到的请求 ${url}`);
    }) as typeof fetch;
    const gh = liveGitHub('o/r', { GITHUB_TOKEN: TOKEN }, { fetchImpl: impl });
    expect(await gh.comments(29)).toEqual(['甲', '乙']);
    await gh.comment(29, '欠账');
    expect(posts).toEqual([{ method: 'POST', body: JSON.stringify({ body: '欠账' }) }]);
    await expect(gh.comment(30, 'x')).rejects.toThrow('在 #30 上留言，GitHub 回了 403');
  });

  it('留言认不出：抛', async () => {
    const { impl } = fakeFetch({ [`${API}/issues/1/comments?per_page=100`]: () => json([{ id: 1 }]) });
    await expect(
      liveGitHub('o/r', {}, { fetchImpl: impl, token: () => undefined }).comments(1),
    ).rejects.toThrow('读 #1 的留言，有一条认不出（body）');
  });
});

describe('读 GitHub：计划和对账要的几样（里程碑说明、关单原因、母子单）', () => {
  const ms = (extra: Record<string, unknown> = {}) => ({
    number: 8,
    title: 'v1 接活',
    state: 'open',
    description: '目标',
    closed_at: null,
    ...extra,
  });

  it('里程碑带说明、关掉的时间；说明是 null 当空', async () => {
    const { impl } = fakeFetch({
      [`${API}/milestones?state=all&per_page=100`]: () =>
        json([
          ms(),
          ms({
            number: 9,
            title: 'v0',
            state: 'closed',
            description: null,
            closed_at: '2026-09-20T16:30:00Z',
          }),
        ]),
    });
    const gh = liveGitHub('o/r', { GITHUB_TOKEN: TOKEN }, { fetchImpl: impl });
    expect(await gh.milestones()).toEqual([
      { number: 8, title: 'v1 接活', state: 'open', description: '目标', closedAt: null },
      { number: 9, title: 'v0', state: 'closed', description: '', closedAt: '2026-09-20T16:30:00Z' },
    ]);
  });

  it.each([
    ['说明不是字', { description: 5 }, '认不出（description）'],
    ['关掉的时间认不出', { closed_at: '昨天' }, '认不出（closed_at）'],
    ['没有 title', { title: undefined }, '读里程碑，有一条认不出'],
  ])('里程碑%s：抛', async (_name, extra, message) => {
    const { impl } = fakeFetch({ [`${API}/milestones?state=all&per_page=100`]: () => json([ms(extra)]) });
    await expect(
      liveGitHub('o/r', { GITHUB_TOKEN: TOKEN }, { fetchImpl: impl }).milestones(),
    ).rejects.toThrow(message);
  });

  it('开着的单、版本里的单：去掉 PR，带上关单原因、子单数、已关的子单数、母单号（没给是 undefined）', async () => {
    const { impl, seen } = fakeFetch({
      [`${API}/issues?state=open&per_page=100`]: () =>
        json([
          row(191, { sub_issues_summary: { total: 2, completed: 1, percent_completed: 50 } }),
          row(200, { pull_request: {}, sub_issues_summary: null }),
          row(43, { parent_issue_url: 'https://api.github.com/repos/o/r/issues/191' }),
        ]),
      [`${API}/issues?milestone=8&state=all&per_page=100`]: () =>
        json([
          row(164, {
            state: 'closed',
            state_reason: 'completed',
            sub_issues_summary: { total: 0, completed: 0, percent_completed: 0 },
          }),
        ]),
    });
    const gh = liveGitHub('o/r', { GITHUB_TOKEN: TOKEN }, { fetchImpl: impl });
    expect(
      (await gh.openIssues()).map((i) => [i.number, i.subIssues, i.subIssuesDone, i.parent, i.stateReason]),
    ).toEqual([
      [191, 2, 1, undefined, null],
      [43, undefined, undefined, 191, null],
    ]);
    expect(await gh.milestoneIssues(8)).toMatchObject([
      { number: 164, state: 'closed', stateReason: 'completed', subIssues: 0 },
    ]);
    expect(seen.map((s) => s.auth)).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
  });

  it.each([
    ['子单数不是整数', { sub_issues_summary: { total: '2', completed: 0 } }, 'sub_issues_summary'],
    ['子单数是负的', { sub_issues_summary: { total: -1, completed: 0 } }, 'sub_issues_summary'],
    ['没给已关的子单数', { sub_issues_summary: { total: 2 } }, 'sub_issues_summary'],
    ['已关的比总数还多', { sub_issues_summary: { total: 1, completed: 2 } }, 'sub_issues_summary'],
    ['母单地址认不出', { parent_issue_url: 'https://example.com/x' }, 'parent_issue_url'],
    ['母单地址不是字', { parent_issue_url: 5 }, 'parent_issue_url'],
    ['关单原因不是字', { state_reason: 3 }, 'state_reason'],
  ])('单子%s：抛', async (_name, extra, field) => {
    const { impl } = fakeFetch({ [`${API}/issues?state=open&per_page=100`]: () => json([row(1, extra)]) });
    await expect(
      liveGitHub('o/r', { GITHUB_TOKEN: TOKEN }, { fetchImpl: impl }).openIssues(),
    ).rejects.toThrow(`有一条认不出（${field}）`);
  });

  it('子单按 Link 头翻页读完，顺序照 GitHub 回的；读不到就抛', async () => {
    const page2 = 'https://api.github.com/repositories/1/issues/197/sub_issues?per_page=100&page=2';
    const { impl } = fakeFetch({
      [`${API}/issues/197/sub_issues?per_page=100`]: () =>
        json([row(44), row(45)], { headers: { link: `<${page2}>; rel="next"` } }),
      [page2]: () => json([row(31)]),
      [`${API}/issues/198/sub_issues?per_page=100`]: () => new Response('{}', { status: 404 }),
    });
    const gh = liveGitHub('o/r', { GITHUB_TOKEN: TOKEN }, { fetchImpl: impl });
    expect((await gh.subIssues(197)).map((i) => i.number)).toEqual([44, 45, 31]);
    await expect(gh.subIssues(198)).rejects.toThrow('读 #198 的子单，GitHub 回了 404');
  });

  it('令牌：GITHUB_TOKEN → GH_TOKEN → gh auth token；都没有是 undefined（没登录）', () => {
    expect(githubToken({ GITHUB_TOKEN: 'a', GH_TOKEN: 'b' }, () => 'c')).toBe('a');
    expect(githubToken({ GH_TOKEN: 'b' }, () => 'c')).toBe('b');
    expect(githubToken({ GITHUB_TOKEN: '' }, () => 'c')).toBe('c');
    expect(githubToken({}, () => undefined)).toBeUndefined();
    expect(githubToken({ GITHUB_TOKEN: '' }, () => '')).toBeUndefined();
  });
});
