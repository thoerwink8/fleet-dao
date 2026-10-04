// 接真后端：每一个会改服务端状态的请求，发出去的方法、路径、请求头（X-CSRF-Token）、请求体都对；
// 失败时（无权限 403、后端 500、没有 JSON 的错误页、断网）错误原样抛给调用方，不吞、不当成功，也不误跳登录页。
import { CSRF_HEADER } from '@fleet-dao/shared';
import { describe, expect, test, vi } from 'vitest';
import type { FleetApi } from './client';
import { createHttpApi } from './http';

const ME = { user: { id: 'u-a', displayName: '甲', role: 'founder' }, csrfToken: 'tok-1' };
const HEX = 'a'.repeat(64);
const AT = '2026-10-04T00:00:00Z';

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** 假 fetch：/api/me 照常回；别的请求交给 reply，记下每次请求。 */
function fakeFetch(reply: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    if (call.method === 'GET' && call.url === '/api/me') return Response.json(ME);
    return reply(call);
  };
  return { fn, calls, writes: () => calls.filter((c) => c.method !== 'GET') };
}

interface Write {
  name: string;
  call(api: FleetApi): Promise<unknown>;
  method: string;
  url: string;
  body?: unknown;
  ok: { status?: number; body?: unknown };
}

const OK = { body: { ok: true } };

const WRITES: Write[] = [
  {
    name: 'taskAction（换模型，指定子任务）',
    call: (api) => api.taskAction('t-1', { action: 'reroute', routeId: 'r-1', subtaskId: 's-1' }),
    method: 'POST',
    url: '/api/tasks/t-1/actions',
    body: { action: 'reroute', routeId: 'r-1', subtaskId: 's-1' },
    ok: OK,
  },
  {
    name: 'answerAsk',
    call: (api) => api.answerAsk('ask-1', '5 分钟'),
    method: 'POST',
    url: '/api/asks/ask-1/answer',
    body: { answer: '5 分钟' },
    ok: OK,
  },
  {
    name: 'updateChannel',
    call: (api) => api.updateChannel('ch-1', { enabled: false, reason: '额度用完了' }),
    method: 'PATCH',
    url: '/api/routing/channels/ch-1',
    body: { enabled: false, reason: '额度用完了' },
    ok: OK,
  },
  {
    name: 'updateRouteEffort',
    call: (api) => api.updateRouteEffort('opus-5.5', 'r-1', { effort: 'high', expected: null }),
    method: 'PUT',
    url: '/api/routing/efforts/opus-5.5/r-1',
    body: { effort: 'high', expected: null },
    ok: { body: { modelId: 'opus-5.5', routeId: 'r-1', effort: 'high' } },
  },
  {
    name: 'resolveNotification',
    call: (api) => api.resolveNotification('n-1'),
    method: 'POST',
    url: '/api/notifications/n-1/resolve',
    ok: OK,
  },
  {
    name: 'updateSetting',
    call: (api) => api.updateSetting('sessions.maxConcurrent', { value: 8, version: 1 }),
    method: 'PUT',
    url: '/api/settings/sessions.maxConcurrent',
    body: { value: 8, version: 1 },
    ok: { body: { setting: { key: 'sessions.maxConcurrent', value: 8, version: 2 } } },
  },
  {
    name: 'createDemoLink',
    call: (api) =>
      api.createDemoLink({ modules: ['board'], detail: 'status', expiresInDays: 7, note: '给投资人看' }),
    method: 'POST',
    url: '/api/demo/links',
    body: { modules: ['board'], detail: 'status', expiresInDays: 7, note: '给投资人看' },
    ok: {
      body: {
        link: { id: HEX, modules: ['board'], detail: 'status', expiresAt: AT, createdAt: AT, expired: false },
        token: 'x'.repeat(43),
      },
    },
  },
  {
    name: 'revokeDemoLink',
    call: (api) => api.revokeDemoLink(HEX),
    method: 'DELETE',
    url: `/api/demo/links/${HEX}`,
    ok: OK,
  },
  {
    name: 'updateDemoDefault',
    call: (api) => api.updateDemoDefault({ modules: ['board'], detail: 'status' }),
    method: 'PUT',
    url: '/api/demo/default',
    body: { modules: ['board'], detail: 'status' },
    ok: { body: { defaultScope: { v: 1, modules: ['board'], detail: 'status' } } },
  },
  {
    name: 'logout',
    call: (api) => api.logout(),
    method: 'POST',
    url: '/auth/logout',
    ok: { status: 204 },
  },
];

const respond = (r: { status?: number; body?: unknown }) =>
  new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status ?? 200 });

describe.each(WRITES)('写请求 $name', (w) => {
  test('方法、路径、CSRF 令牌、请求体都对；成功就成功', async () => {
    const { fn, writes } = fakeFetch(() => respond(w.ok));
    await w.call(createHttpApi({ fetch: fn }));
    const sent = writes();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: w.method, url: w.url, body: w.body });
    expect(sent[0]?.headers[CSRF_HEADER]).toBe('tok-1');
  });

  test('【故意造出的失败】无权限（403）：错误带后端的 code 和白话抛出来，不调 onUnauthorized（不是没登录）', async () => {
    const onUnauthorized = vi.fn();
    const { fn } = fakeFetch(() =>
      respond({ status: 403, body: { error: { code: 'forbidden', message: '你没有这个权限' } } }),
    );
    const err = await w.call(createHttpApi({ fetch: fn, onUnauthorized })).catch((e: unknown) => e);
    expect(err).toMatchObject({
      name: 'ApiError',
      status: 403,
      code: 'forbidden',
      message: '你没有这个权限',
    });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  test('【故意造出的失败】后端回一个没有 JSON 的 500 页：照实报「后端返回 500」，不当成功', async () => {
    const { fn } = fakeFetch(() => new Response('<html>oops</html>', { status: 500 }));
    const err = await w.call(createHttpApi({ fetch: fn })).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 500, code: 'http_500', message: '后端返回 500' });
  });

  test('【故意造出的失败】断网：报「连不上驾驶舱后端」，不当成功', async () => {
    const { fn } = fakeFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const err = await w.call(createHttpApi({ fetch: fn })).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 0, code: 'network' });
    expect((err as Error).message).toContain('连不上驾驶舱后端');
  });
});

describe('写请求：令牌与校验', () => {
  test('【故意造出的失败】没登录时（/api/me 回 401）写请求发不出去，错误抛出并跳登录页，不在没令牌的情况下硬发', async () => {
    const onUnauthorized = vi.fn();
    const calls: string[] = [];
    const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
      return respond({ status: 401, body: { error: { code: 'unauthenticated', message: '要先登录' } } });
    };
    const err = await createHttpApi({ fetch: fn, onUnauthorized })
      .resolveNotification('n-1')
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 401, code: 'unauthenticated' });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['GET /api/me']);
  });

  test('退出之后令牌作废：下一次写请求重新问 /api/me 拿新令牌', async () => {
    const { fn, calls } = fakeFetch(() => respond(OK));
    const api = createHttpApi({ fetch: fn });
    await api.resolveNotification('n-1');
    await api.logout();
    await api.resolveNotification('n-2');
    expect(calls.filter((c) => c.url === '/api/me')).toHaveLength(2);
  });

  test.each([
    ['回答是空串', (api: FleetApi) => api.answerAsk('ask-1', '')],
    [
      '档位不在约定里',
      (api: FleetApi) => api.updateRouteEffort('m', 'r', { effort: 'ultra' as never, expected: null }),
    ],
    [
      '设置版本号是负数',
      (api: FleetApi) => api.updateSetting('sessions.maxConcurrent', { value: 1, version: -1 }),
    ],
    [
      '演示链接一个模块都没开',
      (api: FleetApi) => api.createDemoLink({ modules: [], detail: 'status', expiresInDays: 7 }),
    ],
    [
      '演示链接有效期 0 天',
      (api: FleetApi) => api.createDemoLink({ modules: ['board'], detail: 'status', expiresInDays: 0 }),
    ],
    [
      '演示默认范围的详细程度不在约定里',
      (api: FleetApi) => api.updateDemoDefault({ modules: ['board'], detail: 'everything' as never }),
    ],
    ['换模型没带路由', (api: FleetApi) => api.taskAction('t-1', { action: 'reroute' } as never)],
  ])(
    '【故意造出的失败】请求体不合约定（%s）：返回被拒的 Promise（不是同步抛），一个写请求都没发出去',
    async (_name, call) => {
      const { fn, writes } = fakeFetch(() => respond(OK));
      // 直接调、不套任何包装：同步抛的话调用方的 .catch 接不到（#857），这里先把「同步抛」单独抓出来判失败。
      let returned: Promise<unknown> | undefined;
      let syncThrown: unknown;
      try {
        returned = call(createHttpApi({ fetch: fn }));
      } catch (e) {
        syncThrown = e;
      }
      expect(syncThrown, '写方法同步抛错了，应当返回被拒的 Promise').toBeUndefined();
      const err = await (returned as Promise<unknown>).then(
        () => undefined,
        (e: unknown) => e ?? new Error('被拒但没有错误'),
      );
      // 调用方的 .catch 接得到：这就是页面走错误显示的那条路
      expect(err).toBeInstanceOf(Error);
      expect(writes()).toEqual([]);
    },
  );
});
