// 账密三个接口的前端那一头（缺陷 D1，#902）：登录、读现状、设 / 改。
// 要钉住的几件事：成功是 204 没有响应体、随后读 /api/me 取 CSRF；输错密码的 401（bad_credentials、bad_current_password）
// 不能当成「登录过期」去跳登录页；返回和请求都按 shared 的约定校验，认不出的明确报错；密码不进错误信息。
import { CSRF_HEADER } from '@fleet-dao/shared';
import { describe, expect, test, vi } from 'vitest';
import { ApiError } from './client';
import { createHttpApi } from './http';

const ME = { user: { id: 'u-a', displayName: '甲', role: 'founder' }, csrfToken: 'tok-1' };
const err = (status: number, code: string, message: string, details?: unknown) => ({
  status,
  body: { error: { code, message, ...(details === undefined ? {} : { details }) } },
});

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(routes: Record<string, (call: Call) => { status?: number; body?: unknown }>) {
  const calls: Call[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const call: Call = {
      method,
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const handler = routes[`${method} ${url}`];
    if (!handler)
      return new Response(JSON.stringify({ error: { code: 'not_found', message: '没有' } }), { status: 404 });
    const res = handler(call);
    return new Response(res.body === undefined ? null : JSON.stringify(res.body), {
      status: res.status ?? 200,
    });
  };
  return { fn, calls };
}

describe('passwordLogin', () => {
  test('POST /auth/password/login 不带 CSRF；成功（204）后读 /api/me 取令牌，之后写请求直接用它', async () => {
    const { fn, calls } = fakeFetch({
      'POST /auth/password/login': () => ({ status: 204 }),
      'GET /api/me': () => ({ body: ME }),
      'PUT /api/me/credentials': () => ({ status: 204 }),
    });
    const api = createHttpApi({ fetch: fn });
    const me = await api.passwordLogin('founder', 'p-a-s-s-w-o-r-d-1');
    expect(me).toEqual(ME);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /auth/password/login', 'GET /api/me']);
    expect(calls[0]?.headers[CSRF_HEADER]).toBeUndefined();
    expect(calls[0]?.body).toEqual({ username: 'founder', password: 'p-a-s-s-w-o-r-d-1' });
    // 密码只在请求体里：地址里没有
    expect(calls.some((c) => c.url.includes('p-a-s-s'))).toBe(false);
    await api.updateCredentials({ username: 'founder2', currentPassword: 'p-a-s-s-w-o-r-d-1' });
    expect(calls.at(-1)?.headers[CSRF_HEADER]).toBe('tok-1');
    expect(calls.filter((c) => c.url === '/api/me')).toHaveLength(1);
  });

  test('【故意造出的失败】密码不对（401 bad_credentials）：抛带 code 的错，不当成登录过期、不调 onUnauthorized', async () => {
    const onUnauthorized = vi.fn();
    const { fn } = fakeFetch({
      'POST /auth/password/login': () => err(401, 'bad_credentials', '用户名或密码不对'),
    });
    const api = createHttpApi({ fetch: fn, onUnauthorized });
    const e = await api.passwordLogin('founder', 'wrong-password-1').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 401, code: 'bad_credentials' });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  test('对照：别的 401（登录过期）照样调 onUnauthorized——放行 bad_credentials 没把整条 401 路放开', async () => {
    const onUnauthorized = vi.fn();
    const { fn } = fakeFetch({
      'GET /api/me': () => err(401, 'unauthenticated', '先登录'),
      'GET /api/me/credentials': () => err(401, 'session_revoked', '会话已作废'),
    });
    const api = createHttpApi({ fetch: fn, onUnauthorized });
    await expect(api.credentials()).rejects.toMatchObject({ code: 'session_revoked' });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  test('【故意造出的失败】锁了（429 locked）：details.until 原样带出来，不调 onUnauthorized', async () => {
    const onUnauthorized = vi.fn();
    const until = '2026-10-05T01:00:00.000Z';
    const { fn } = fakeFetch({
      'POST /auth/password/login': () => err(429, 'locked', '输错次数太多', { until }),
    });
    const api = createHttpApi({ fetch: fn, onUnauthorized });
    await expect(api.passwordLogin('founder', 'x')).rejects.toMatchObject({
      code: 'locked',
      details: { until },
    });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  test('【故意造出的失败】用户名或密码超长：不发请求，报 invalid_request，错误信息里没有密码', async () => {
    const { fn, calls } = fakeFetch({});
    const api = createHttpApi({ fetch: fn });
    const secret = `s3cret-${'x'.repeat(1100)}`;
    const e = (await api.passwordLogin('founder', secret).catch((x: unknown) => x)) as ApiError;
    expect(e).toMatchObject({ code: 'invalid_request' });
    expect(e.message).not.toContain('s3cret');
    expect(JSON.stringify(e.details ?? null)).not.toContain('s3cret');
    expect(calls).toHaveLength(0);
  });

  test('【故意造出的失败】断网：抛 network（status 0），不是密码错', async () => {
    const api = createHttpApi({
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    await expect(api.passwordLogin('founder', 'x')).rejects.toMatchObject({ status: 0, code: 'network' });
  });
});

describe('credentials / updateCredentials', () => {
  const CREDS = {
    hasPassword: true,
    username: 'founder',
    passwordChangedAt: '2026-10-04T00:00:00.000Z',
    canSetWithoutCurrent: false,
  };

  test('读现状：按契约解析', async () => {
    const { fn } = fakeFetch({ 'GET /api/me/credentials': () => ({ body: CREDS }) });
    expect(await createHttpApi({ fetch: fn }).credentials()).toEqual(CREDS);
  });

  test('【故意造出的失败】后端回的现状缺字段：报 bad_response_shape，不拿 undefined 往下走', async () => {
    const { fn } = fakeFetch({ 'GET /api/me/credentials': () => ({ body: { hasPassword: true } }) });
    await expect(createHttpApi({ fetch: fn }).credentials()).rejects.toMatchObject({
      code: 'bad_response_shape',
    });
  });

  test('改账密：PUT 带 CSRF 令牌和请求体，成功 204 没有返回值', async () => {
    const { fn, calls } = fakeFetch({
      'GET /api/me': () => ({ body: ME }),
      'PUT /api/me/credentials': () => ({ status: 204 }),
    });
    const api = createHttpApi({ fetch: fn });
    await expect(
      api.updateCredentials({ newPassword: 'a-long-new-password', currentPassword: 'old' }),
    ).resolves.toBeUndefined();
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.headers[CSRF_HEADER]).toBe('tok-1');
    expect(put?.body).toEqual({ newPassword: 'a-long-new-password', currentPassword: 'old' });
  });

  test('【故意造出的失败】当前密码输错（401 bad_current_password，field=currentPassword）：不当成登录过期、不调 onUnauthorized（否则设置页整页跳走、看不到提示）', async () => {
    const onUnauthorized = vi.fn();
    const { fn } = fakeFetch({
      'GET /api/me': () => ({ body: ME }),
      'PUT /api/me/credentials': () =>
        err(401, 'bad_current_password', '当前密码不对', { field: 'currentPassword' }),
    });
    const api = createHttpApi({ fetch: fn, onUnauthorized });
    await expect(
      api.updateCredentials({ newPassword: 'a-long-new-password', currentPassword: 'oops' }),
    ).rejects.toMatchObject({
      status: 401,
      code: 'bad_current_password',
      details: { field: 'currentPassword' },
    });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  test('【故意造出的失败】请求体超长：不是同步抛、不发请求', async () => {
    const { fn, calls } = fakeFetch({ 'GET /api/me': () => ({ body: ME }) });
    const api = createHttpApi({ fetch: fn });
    const p = api.updateCredentials({ newPassword: 'x'.repeat(1025) });
    await expect(p).rejects.toThrow();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });
});
