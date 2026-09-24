import { CSRF_HEADER } from '@fleet-dao/shared';
import { describe, expect, test, vi } from 'vitest';
import { ApiError, type LiveStatus } from './client';
import { createHttpApi } from './http';
import type { LiveEvent } from './types';

const ME = { user: { id: 'u-a', displayName: '甲', role: 'founder' }, csrfToken: 'tok-1' };

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** 假 fetch：按「方法 路径」查表回话，记下每次请求。 */
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
    const path = url.split('?')[0] ?? url;
    const handler = routes[`${method} ${path}`];
    if (!handler)
      return new Response(JSON.stringify({ error: { code: 'not_found', message: '没有' } }), { status: 404 });
    const res = handler(call);
    return new Response(res.body === undefined ? null : JSON.stringify(res.body), {
      status: res.status ?? 200,
    });
  };
  return { fn, calls };
}

describe('接真后端：请求', () => {
  test('写请求带 X-CSRF-Token（值从 /api/me 来），读请求不带', async () => {
    const { fn, calls } = fakeFetch({
      'GET /api/me': () => ({ body: ME }),
      'POST /api/tasks/t-1/actions': () => ({ body: { ok: true } }),
      'GET /api/repos': () => ({ body: { repos: [] } }),
    });
    const api = createHttpApi({ fetch: fn });
    await api.repos();
    await api.taskAction('t-1', { action: 'pause' });
    const write = calls.find((c) => c.method === 'POST');
    expect(write?.headers[CSRF_HEADER]).toBe('tok-1');
    expect(write?.body).toEqual({ action: 'pause' });
    expect(calls.find((c) => c.url === '/api/repos')?.headers[CSRF_HEADER]).toBeUndefined();
  });

  test('路径参数照 WebRoutes 填，并做转义', async () => {
    const { fn, calls } = fakeFetch({
      'GET /api/repos/r%2F1/board': () => ({
        status: 404,
        body: { error: { code: 'repo_not_found', message: '没有这个仓' } },
      }),
    });
    const api = createHttpApi({ fetch: fn });
    await expect(api.board('r/1')).rejects.toMatchObject({ code: 'repo_not_found', message: '没有这个仓' });
    expect(calls[0]?.url).toBe('/api/repos/r%2F1/board');
  });

  test('登录前的免登请求不带 CSRF，也不先去问 /api/me', async () => {
    const { fn, calls } = fakeFetch({ 'POST /auth/dev-login': () => ({ body: ME }) });
    const api = createHttpApi({ fetch: fn });
    await api.devLogin('u-a');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /auth/dev-login']);
    expect(calls[0]?.headers[CSRF_HEADER]).toBeUndefined();
  });

  test('401 时调 onUnauthorized（跳登录页），错误照后端的 code 和白话', async () => {
    const onUnauthorized = vi.fn();
    const { fn } = fakeFetch({
      'GET /api/me': () => ({ status: 401, body: { error: { code: 'unauthenticated', message: '先登录' } } }),
    });
    const api = createHttpApi({ fetch: fn, onUnauthorized });
    const err = await api.me().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, code: 'unauthenticated', message: '先登录' });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  test('返回不符合 web-api.ts：不将就着用，报 bad_response_shape', async () => {
    const { fn } = fakeFetch({ 'GET /api/repos': () => ({ body: { repos: [{ id: 'r' }] } }) });
    const api = createHttpApi({ fetch: fn });
    await expect(api.repos()).rejects.toMatchObject({ code: 'bad_response_shape' });
  });

  test('CSRF 令牌失效（csrf_token）后，下一次写请求重新拿令牌', async () => {
    let token = 'old';
    let first = true;
    const { fn, calls } = fakeFetch({
      'GET /api/me': () => ({ body: { ...ME, csrfToken: token } }),
      'POST /api/notifications/n-1/resolve': () => {
        if (first) {
          first = false;
          return { status: 403, body: { error: { code: 'csrf_token', message: '令牌不对' } } };
        }
        return { body: { ok: true } };
      },
    });
    const api = createHttpApi({ fetch: fn });
    await expect(api.resolveNotification('n-1')).rejects.toMatchObject({ code: 'csrf_token' });
    token = 'new';
    await api.resolveNotification('n-1');
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.headers[CSRF_HEADER])).toEqual(['old', 'new']);
  });

  test('请求体先按 web-api.ts 校验，不合约定的不发出去', async () => {
    const { fn, calls } = fakeFetch({ 'GET /api/me': () => ({ body: ME }) });
    const api = createHttpApi({ fetch: fn });
    await expect(api.answerAsk('a-1', '')).rejects.toThrow();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });
});

/** 假 EventSource：测试里手动派发事件。 */
class FakeEventSource {
  readyState = 0;
  onerror: (() => void) | null = null;
  readonly listeners = new Map<string, ((ev: MessageEvent<string>) => void)[]>();
  closed = false;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(type: string, fn: (ev: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, data = '') {
    for (const fn of this.listeners.get(type) ?? []) fn({ data } as MessageEvent<string>);
  }
  close() {
    this.closed = true;
  }
}

describe('接真后端：实时推送（SSE）', () => {
  function setup() {
    let es: FakeEventSource | undefined;
    const api = createHttpApi({
      fetch: fakeFetch({}).fn,
      eventSource: (url) => {
        es = new FakeEventSource(url);
        return es as unknown as EventSource;
      },
    });
    const events: LiveEvent[] = [];
    const statuses: LiveStatus[] = [];
    const stop = api.subscribe(
      (e) => events.push(e),
      (s) => statuses.push(s),
    );
    if (!es) throw new Error('没建 EventSource');
    return { es, events, statuses, stop };
  }

  test('连 /api/events；收到 ready 才算连上', () => {
    const { es, events, statuses } = setup();
    expect(es.url).toBe('/api/events');
    expect(statuses).toEqual(['connecting']);
    es.emit('ready');
    expect(statuses).toEqual(['connecting', 'open']);
    expect(events).toEqual([{ type: 'ready' }]);
  });

  test('change 事件按 ChangeEventSchema 解析成「哪张表哪一行」', () => {
    const { es, events } = setup();
    es.emit('change', JSON.stringify({ table: 'tasks', id: 't-1' }));
    expect(events).toEqual([{ type: 'change', table: 'tasks', id: 't-1' }]);
  });

  test('看不懂的 change 当成 resync（全部重拉），不当没发生', () => {
    const { es, events } = setup();
    es.emit('change', '{不是 JSON');
    es.emit('change', JSON.stringify({ table: '' }));
    expect(events).toEqual([{ type: 'resync' }, { type: 'resync' }]);
  });

  test('断线：浏览器在重连时是「连接中」，彻底关了是「断了」；取消订阅会关掉连接', () => {
    const { es, statuses, stop } = setup();
    es.readyState = 0;
    es.onerror?.();
    es.readyState = 2;
    es.onerror?.();
    expect(statuses.slice(-2)).toEqual(['connecting', 'down']);
    stop();
    expect(es.closed).toBe(true);
  });
});
