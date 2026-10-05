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

  // 【故意造出的失败】接口没给这两个字段时，别拿空串顶：说明当空串会被读成「说明里没有先后标记」，
  // 对账当成真断裂（退出码 1、留言到单上）；关掉的时间当空会被读成「还开着的版本」。两种都是「没查成」（退出码 2）。
  it.each([
    ['没给 description', { description: undefined }, '认不出（description）'],
    ['没给 closed_at', { closed_at: undefined }, '认不出（closed_at）'],
    ['只给了别的字段', { description: undefined, closed_at: undefined }, '认不出（description）'],
  ])('里程碑%s：抛（不当空串、不当还开着）', async (_name, extra, message) => {
    // 键整个不在（不是值给 undefined）：照接口真省掉字段的样子造
    const raw = ms();
    for (const key of Object.keys(extra)) {
      delete (raw as Record<string, unknown>)[key];
      expect(Object.keys(raw)).not.toContain(key);
    }
    const { impl } = fakeFetch({ [`${API}/milestones?state=all&per_page=100`]: () => json([raw]) });
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

describe('发布收尾要的两样（release.yml 核里程碑、关里程碑）', () => {
  const PULLS = `${API}/pulls?state=closed&head=o:release/v3&per_page=100`;
  const SHA_A = 'a'.repeat(40);
  const pull = (number: number, merged_at: string | null, merge_commit_sha: string | null = SHA_A) => ({
    number,
    merged_at,
    merge_commit_sha,
  });

  it('已合并的发布 PR：按 head=<owner>:<分支> 查、翻页读完，只留合并了的（照 GitHub 回的先后），带合进主线的提交', async () => {
    const page2 = `${PULLS}&page=2`;
    const { impl } = fakeFetch({
      [PULLS]: () =>
        json([pull(731, '2026-10-05T02:00:00Z'), pull(730, null, null)], {
          headers: { link: `<${page2}>; rel="next"` },
        }),
      [page2]: () => json([pull(700, '2026-10-04T00:00:00Z', 'b'.repeat(40))]),
    });
    const gh = liveGitHub('o/r', { GITHUB_TOKEN: TOKEN }, { fetchImpl: impl });
    expect(await gh.mergedPulls('release/v3')).toEqual([
      { number: 731, mergedAt: '2026-10-05T02:00:00Z', mergeCommitSha: SHA_A },
      { number: 700, mergedAt: '2026-10-04T00:00:00Z', mergeCommitSha: 'b'.repeat(40) },
    ]);
  });

  it.each([
    ['merged_at 认不出', [pull(731, '昨天')], /有一条认不出/],
    ['没给 merged_at', [{ number: 731 }], /有一条认不出/],
    ['没有号', [{ merged_at: null }], /有一条认不出/],
    [
      '合并了却没有 merge_commit_sha',
      [pull(731, '2026-10-05T02:00:00Z', null)],
      /#731 认不出（merge_commit_sha）/,
    ],
  ])(
    '故意造出的失败：已合并的发布 PR %s → 抛（不当成「没合并」把它漏掉、不拿空提交去打 tag）',
    async (_name, rows, re) => {
      const { impl } = fakeFetch({ [PULLS]: () => json(rows) });
      await expect(
        liveGitHub('o/r', { GITHUB_TOKEN: TOKEN }, { fetchImpl: impl }).mergedPulls('release/v3'),
      ).rejects.toThrow(re);
    },
  );

  /** 记方法、网址、请求体的假 fetch（按「方法 网址」回）。 */
  function recorder(routes: Record<string, () => Response>) {
    const seen: string[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input)}`;
      seen.push(init?.body ? `${key} ${String(init.body)}` : key);
      const route = routes[key];
      if (!route) throw new Error(`没料到的请求 ${key}`);
      return route();
    }) as typeof fetch;
    return { gh: liveGitHub('o/r', { GITHUB_TOKEN: TOKEN }, { fetchImpl: impl }), seen };
  }
  const notFound = () => new Response('{"message":"Not Found"}', { status: 404 });

  it('tag 指的提交：轻量 tag 直接是提交；附注 tag 再剥一层 tag 对象；不在（404）回 undefined', async () => {
    const { gh } = recorder({
      [`GET ${API}/git/ref/tags/v1`]: () => json({ object: { type: 'commit', sha: SHA_A } }),
      [`GET ${API}/git/ref/tags/v3`]: () => json({ object: { type: 'tag', sha: 'c'.repeat(40) } }),
      [`GET ${API}/git/tags/${'c'.repeat(40)}`]: () =>
        json({ object: { type: 'commit', sha: 'd'.repeat(40) } }),
      [`GET ${API}/git/ref/tags/v9`]: notFound,
    });
    expect(await gh.tagCommit('v1')).toBe(SHA_A);
    expect(await gh.tagCommit('v3')).toBe('d'.repeat(40));
    expect(await gh.tagCommit('v9')).toBeUndefined();
  });

  it('故意造出的失败：读 tag GitHub 回 502、回包认不出、指的不是提交 → 抛（不当成「不在」接着打）', async () => {
    const { gh } = recorder({
      [`GET ${API}/git/ref/tags/v1`]: () => new Response('{}', { status: 502 }),
      [`GET ${API}/git/ref/tags/v2`]: () => json({ object: { type: 'commit' } }),
      [`GET ${API}/git/ref/tags/v3`]: () => json({ object: { type: 'tree', sha: SHA_A } }),
    });
    await expect(gh.tagCommit('v1')).rejects.toThrow('读 tag v1，GitHub 回了 502');
    await expect(gh.tagCommit('v2')).rejects.toThrow('认不出（object）');
    await expect(gh.tagCommit('v3')).rejects.toThrow('指的不是提交（tree）');
  });

  it('打附注 tag：先建 tag 对象、再建 refs/tags/<tag> 指着它', async () => {
    const { gh, seen } = recorder({
      [`POST ${API}/git/tags`]: () => json({ sha: 'c'.repeat(40) }, { status: 201 }),
      [`POST ${API}/git/refs`]: () => json({}, { status: 201 }),
    });
    await gh.createTag('v3', SHA_A, 'v3');
    expect(seen).toEqual([
      `POST ${API}/git/tags {"tag":"v3","message":"v3","object":"${SHA_A}","type":"commit"}`,
      `POST ${API}/git/refs {"ref":"refs/tags/v3","sha":"${'c'.repeat(40)}"}`,
    ]);
  });

  it('故意造出的失败：refs/tags/<tag> 已经有了（422）→ 抛，不当成打好了', async () => {
    const { gh } = recorder({
      [`POST ${API}/git/tags`]: () => json({ sha: 'c'.repeat(40) }, { status: 201 }),
      [`POST ${API}/git/refs`]: () => new Response('{}', { status: 422 }),
    });
    await expect(gh.createTag('v3', SHA_A, 'v3')).rejects.toThrow('在建 refs/tags/v3 时，GitHub 回了 422');
  });

  it('Release：按 tag 读（404 回 undefined、body 是 null 当空串）、建、改正文', async () => {
    const rel = (body: string | null) => ({ id: 7, tag_name: 'v3', body });
    const { gh, seen } = recorder({
      [`GET ${API}/releases/tags/v3`]: () => json(rel(null)),
      [`GET ${API}/releases/tags/v4`]: notFound,
      [`POST ${API}/releases`]: () => json(rel('正文'), { status: 201 }),
      [`PATCH ${API}/releases/7`]: () => json(rel('改过')),
    });
    expect(await gh.release('v3')).toEqual({ id: 7, tagName: 'v3', body: '' });
    expect(await gh.release('v4')).toBeUndefined();
    expect(await gh.createRelease('v3', 'v3', '正文')).toEqual({ id: 7, tagName: 'v3', body: '正文' });
    expect(await gh.updateReleaseBody(7, '改过')).toEqual({ id: 7, tagName: 'v3', body: '改过' });
    expect(seen).toContain(
      `POST ${API}/releases {"tag_name":"v3","name":"v3","body":"正文","draft":false,"prerelease":false}`,
    );
  });

  it('故意造出的失败：读 Release 回 500、回包缺 body → 抛（读挂了不当「不在」接着建）；建 Release 不是 201 → 抛', async () => {
    const { gh } = recorder({
      [`GET ${API}/releases/tags/v3`]: () => new Response('{}', { status: 500 }),
      [`GET ${API}/releases/tags/v4`]: () => json({ id: 7, tag_name: 'v4' }),
      [`POST ${API}/releases`]: () => json({}, { status: 422 }),
    });
    await expect(gh.release('v3')).rejects.toThrow('读 v3 的 Release，GitHub 回了 500');
    await expect(gh.release('v4')).rejects.toThrow('认不出（body）');
    await expect(gh.createRelease('v3', 'v3', 'x')).rejects.toThrow('在建 v3 的 Release 时，GitHub 回了 422');
  });

  it('按提交读文件：base64 解出原文；文件不在（404）回 undefined；不是文件 → 抛', async () => {
    const content = Buffer.from('# Changelog\n中文', 'utf8').toString('base64');
    const { gh } = recorder({
      [`GET ${API}/contents/CHANGELOG.md?ref=${SHA_A}`]: () =>
        json({ type: 'file', encoding: 'base64', content }),
      [`GET ${API}/contents/NOPE.md?ref=${SHA_A}`]: notFound,
      [`GET ${API}/contents/docs?ref=${SHA_A}`]: () => json([{ type: 'file' }]),
    });
    expect(await gh.fileAt('CHANGELOG.md', SHA_A)).toBe('# Changelog\n中文');
    expect(await gh.fileAt('NOPE.md', SHA_A)).toBeUndefined();
    await expect(gh.fileAt('docs', SHA_A)).rejects.toThrow('不是 base64 的文件');
  });

  it('关里程碑：PATCH state=closed，回 GitHub 关完的那一份', async () => {
    const seen: { method: string | undefined; body: string }[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(`${API}/milestones/10`);
      seen.push({ method: init?.method, body: String(init?.body) });
      return json({
        number: 10,
        title: 'v3 三段一条龙',
        state: 'closed',
        description: null,
        closed_at: '2026-10-05T02:01:30Z',
      });
    }) as typeof fetch;
    const r = await liveGitHub('o/r', { GITHUB_TOKEN: TOKEN }, { fetchImpl: impl }).closeMilestone(10);
    expect(seen).toEqual([{ method: 'PATCH', body: '{"state":"closed"}' }]);
    expect(r).toEqual({
      number: 10,
      title: 'v3 三段一条龙',
      state: 'closed',
      description: '',
      closedAt: '2026-10-05T02:01:30Z',
    });
  });

  it('改单挂的里程碑：PATCH milestone=<号>，回改完之后挂的编号；未排期传 null、回 null', async () => {
    const seen: { url: string; method: string | undefined; body: string }[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), method: init?.method, body: String(init?.body) });
      const body = JSON.parse(String(init?.body)) as { milestone: number | null };
      return json({ number: 45, milestone: body.milestone === null ? null : { number: body.milestone } });
    }) as typeof fetch;
    const gh = liveGitHub('o/r', { GITHUB_TOKEN: TOKEN }, { fetchImpl: impl });
    expect(await gh.setIssueMilestone(45, 11)).toBe(11);
    expect(await gh.setIssueMilestone(45, null)).toBeNull();
    expect(seen).toEqual([
      { url: `${API}/issues/45`, method: 'PATCH', body: '{"milestone":11}' },
      { url: `${API}/issues/45`, method: 'PATCH', body: '{"milestone":null}' },
    ]);
  });

  it('故意造出的失败：改里程碑 GitHub 回非 2xx、或回包里 milestone 认得不对 → 抛', async () => {
    const forbidden = (async () => new Response('{}', { status: 403 })) as unknown as typeof fetch;
    await expect(
      liveGitHub('o/r', { GITHUB_TOKEN: TOKEN }, { fetchImpl: forbidden }).setIssueMilestone(45, 11),
    ).rejects.toThrow('在改 #45 挂的里程碑时，GitHub 回了 403');
    const garbled = (async () => json({ milestone: { title: 'v4 下一版' } })) as unknown as typeof fetch;
    await expect(
      liveGitHub('o/r', { GITHUB_TOKEN: TOKEN }, { fetchImpl: garbled }).setIssueMilestone(45, 11),
    ).rejects.toThrow('读改 #45 挂的里程碑的回包，认不出（milestone）');
  });

  it('故意造出的失败：关里程碑 GitHub 回非 2xx、或回包认不出 → 抛', async () => {
    const forbidden = (async () => new Response('{}', { status: 403 })) as unknown as typeof fetch;
    await expect(
      liveGitHub('o/r', { GITHUB_TOKEN: TOKEN }, { fetchImpl: forbidden }).closeMilestone(10),
    ).rejects.toThrow('在关里程碑 #10 时，GitHub 回了 403');
    const garbled = (async () => json({ number: 10 })) as unknown as typeof fetch;
    await expect(
      liveGitHub('o/r', { GITHUB_TOKEN: TOKEN }, { fetchImpl: garbled }).closeMilestone(10),
    ).rejects.toThrow('读里程碑，有一条认不出');
  });
});
