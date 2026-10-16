// 契约（#2749）：把仓加进、移出 App 安装，GitHub 只有单仓接口 PUT/DELETE /user/installations/{id}/repositories/{repo}，
// 没有请求体。原来调的是不带仓号的地址、带一串仓号，从上线起一次都没成过（audit_log 里没有一条 github.install.repo）。
import { describe, expect, it } from 'vitest';
import { GitHubClient } from '../src/client.ts';
import { createGitHubUserApi } from '../src/user-repos.ts';
import { API, testApps } from './fake-github.ts';

function setup() {
  const calls: { method: string; path: string; body: string | null; auth: string | null }[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      body: init?.body === undefined || init.body === null ? null : String(init.body),
      auth: headers.get('authorization'),
    });
    return new Response(null, { status: 204 });
  };
  const client = new GitHubClient({
    apps: testApps(),
    apiUrl: API,
    fetch: fakeFetch,
    sleep: async () => {},
    writeSpacingMs: 0,
  });
  const api = createGitHubUserApi(client, {
    appCredentials: { agent: { slug: 'fleet-test-agent' }, engine: { slug: 'fleet-test-engine' } },
  });
  return { api, calls };
}

describe('装仓、卸仓走单仓接口', () => {
  it('加两个仓：两次 PUT /user/installations/{id}/repositories/{repo}，没有请求体，用的是本人令牌', async () => {
    const { api, calls } = setup();
    await api.addReposToInstallation('ghu_user', 164544168, [1418484822, 7]);
    expect(calls.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      { method: 'PUT', path: '/user/installations/164544168/repositories/1418484822', body: null },
      { method: 'PUT', path: '/user/installations/164544168/repositories/7', body: null },
    ]);
    expect(calls.every((c) => c.auth?.endsWith('ghu_user'))).toBe(true);
  });

  it('移出：DELETE 同一个单仓地址，没有请求体；空列表一个请求都不发', async () => {
    const { api, calls } = setup();
    await api.removeReposFromInstallation('ghu_user', 5, [9]);
    await api.addReposToInstallation('ghu_user', 5, []);
    expect(calls.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      { method: 'DELETE', path: '/user/installations/5/repositories/9', body: null },
    ]);
  });
});
