// 接真后端：每一个会改服务端状态的请求，发出去的方法、路径、请求头（X-CSRF-Token）、请求体都对；
// 失败时（无权限 403、后端 500、没有 JSON 的错误页、断网）错误原样抛给调用方，不吞、不当成功，也不误跳登录页。
import { CSRF_HEADER } from '@fleet-dao/shared';
import { describe, expect, test, vi } from 'vitest';
import type { FleetApi } from './client';
import { createHttpApi } from './http';

const ME = {
  user: { id: 'u-a', displayName: '甲', role: 'founder' },
  csrfToken: 'tok-1',
  env: { name: '测试机' },
};
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
    name: 'updateRouteEffort',
    call: (api) => api.updateRouteEffort('opus-5.5', 'r-1', { effort: 'high', expected: null }),
    method: 'PUT',
    url: '/api/routing/efforts/opus-5.5/r-1',
    body: { effort: 'high', expected: null },
    ok: { body: { modelId: 'opus-5.5', routeId: 'r-1', effort: 'high' } },
  },
  {
    name: 'routeProbeNow',
    call: (api) => api.routeProbeNow({ routeIds: ['r-1'] }),
    method: 'POST',
    url: '/api/routing/probe',
    body: { routeIds: ['r-1'] },
    ok: {
      body: {
        request: {
          requestId: 'q-1',
          requestedAt: AT,
          by: 'u-a',
          routeIds: ['r-1'],
          state: 'queued',
          results: [],
        },
        engine: { state: 'on' },
      },
    },
  },
  {
    name: 'movePurposeModel',
    call: (api) =>
      api.movePurposeModel('execute', 'opus-5.5', { direction: 'down', expected: ['opus-5.5', 'kimi-k3'] }),
    method: 'PUT',
    url: '/api/routing/purposes/execute/models/opus-5.5',
    body: { direction: 'down', expected: ['opus-5.5', 'kimi-k3'] },
    ok: { body: { purpose: 'execute', order: ['kimi-k3', 'opus-5.5'] } },
  },
  {
    name: 'updateModelRoute（上移 / 下移）',
    call: (api) =>
      api.updateModelRoute('opus-5.5', 'r-1', { op: 'move', direction: 'up', expected: ['r-0', 'r-1'] }),
    method: 'PUT',
    url: '/api/routing/models/opus-5.5/routes/r-1',
    body: { op: 'move', direction: 'up', expected: ['r-0', 'r-1'] },
    ok: { body: { modelId: 'opus-5.5', routeId: 'r-1', order: ['r-1', 'r-0'] } },
  },
  {
    name: 'updateModelRoute（开关）',
    call: (api) => api.updateModelRoute('opus-5.5', 'r-1', { op: 'enable', enabled: false, expected: true }),
    method: 'PUT',
    url: '/api/routing/models/opus-5.5/routes/r-1',
    body: { op: 'enable', enabled: false, expected: true },
    ok: { body: { modelId: 'opus-5.5', routeId: 'r-1', enabled: false } },
  },
  {
    name: 'updateModelRoute（拖到新先后）',
    call: (api) =>
      api.updateModelRoute('opus-5.5', 'r-1', {
        op: 'reorder',
        order: ['r-1', 'r-0'],
        expected: ['r-0', 'r-1'],
      }),
    method: 'PUT',
    url: '/api/routing/models/opus-5.5/routes/r-1',
    body: { op: 'reorder', order: ['r-1', 'r-0'], expected: ['r-0', 'r-1'] },
    ok: { body: { modelId: 'opus-5.5', routeId: 'r-1', order: ['r-1', 'r-0'] } },
  },
  {
    name: 'setModelEnabled',
    call: (api) => api.setModelEnabled('opus-5.5', { enabled: false, expectedEnabled: ['r-0', 'r-1'] }),
    method: 'PUT',
    url: '/api/routing/models/opus-5.5',
    body: { enabled: false, expectedEnabled: ['r-0', 'r-1'] },
    ok: { body: { modelId: 'opus-5.5', enabled: false, enabledRouteIds: [] } },
  },
  {
    name: 'setChannelEnabled',
    call: (api) => api.setChannelEnabled('ch-relay', { enabled: false, expected: true }),
    method: 'PUT',
    url: '/api/routing/channels/ch-relay',
    body: { enabled: false, expected: true },
    ok: { body: { channelId: 'ch-relay', enabled: false } },
  },
  {
    name: 'groomNow',
    call: (api) => api.groomNow('r-orbit', { reason: '老单堆了' }),
    method: 'POST',
    url: '/api/repos/r-orbit/dispatch/groom',
    body: { reason: '老单堆了' },
    ok: {
      body: {
        request: {
          requestId: 'g-1',
          repo: 'acme/orbit',
          source: 'http',
          requestedAt: AT,
          by: 'u-a',
          state: 'queued',
        },
        remainingAfter: 2,
      },
    },
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
    name: 'addPurposeModel',
    call: (api) => api.addPurposeModel('execute', { modelId: 'sonnet-5', version: 0 }),
    method: 'POST',
    url: '/api/routing/purposes/execute/models',
    body: { modelId: 'sonnet-5', version: 0 },
    ok: { body: { purpose: 'execute', version: 1, order: [{ modelId: 'sonnet-5', effort: null }] } },
  },
  {
    name: 'removePurposeModel',
    call: (api) => api.removePurposeModel('execute', 'kimi-k3', { version: 1 }),
    method: 'DELETE',
    url: '/api/routing/purposes/execute/models/kimi-k3',
    body: { version: 1 },
    ok: { body: { purpose: 'execute', version: 2, order: [{ modelId: 'opus-5.5', effort: null }] } },
  },
  {
    name: 'setPurposeModelEffort',
    call: (api) => api.setPurposeModelEffort('verify', 'grok-4.7', { effort: 'high', version: 0 }),
    method: 'PUT',
    url: '/api/routing/purposes/verify/models/grok-4.7/effort',
    body: { effort: 'high', version: 0 },
    ok: { body: { purpose: 'verify', version: 1, order: [{ modelId: 'grok-4.7', effort: 'high' }] } },
  },
  {
    name: 'registerChannelModel',
    call: (api) => api.registerChannelModel('claude-sub', { modelKey: 'claude-x' }),
    method: 'POST',
    url: '/api/routing/channels/claude-sub/models',
    body: { modelKey: 'claude-x' },
    ok: { body: { channelId: 'claude-sub', modelKey: 'claude-x', source: '手工', count: 1 } },
  },
  {
    name: 'revokeChannelModel',
    call: (api) => api.revokeChannelModel('claude-sub', { modelKey: 'claude-x' }),
    method: 'DELETE',
    url: '/api/routing/channels/claude-sub/models',
    body: { modelKey: 'claude-x' },
    ok: { body: { channelId: 'claude-sub', modelKey: 'claude-x', source: '手工', count: 0 } },
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

  test('退出后在飞请求回 401：不调 onUnauthorized（二次跳登录页会打断 e2e 的 goto）', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const onUnauthorized = vi.fn();
    const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url === '/api/me') return respond({ body: ME });
      if (method === 'POST' && url === '/auth/logout') return respond({ status: 204 });
      if (url === '/api/repos') {
        await held;
        return respond({
          status: 401,
          body: { error: { code: 'session_revoked', message: '会话已作废' } },
        });
      }
      return respond({ status: 404, body: { error: { code: 'not_found', message: '没有' } } });
    };
    const api = createHttpApi({ fetch: fn, onUnauthorized });
    const stale = api.repos().catch((e: unknown) => e);
    await api.logout();
    release();
    expect(await stale).toMatchObject({ status: 401, code: 'session_revoked' });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  test.each([
    [
      '档位不在约定里',
      (api: FleetApi) => api.updateRouteEffort('m', 'r', { effort: 'ultra' as never, expected: null }),
    ],
    [
      '调先后没带看到的顺序',
      (api: FleetApi) => api.movePurposeModel('execute', 'opus-5.5', { direction: 'down' } as never),
    ],
    [
      '设置版本号是负数',
      (api: FleetApi) => api.updateSetting('sessions.maxConcurrent', { value: 1, version: -1 }),
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
