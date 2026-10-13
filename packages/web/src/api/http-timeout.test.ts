// 请求超时（#2017）：后端接了请求却一直不回时，页面不能永远转圈；到点中止请求、报明确的提示。
// 用假定时器造「永远不回」的请求，不真等。
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createHttpApi, REQUEST_TIMEOUT_MS } from './http';

const ME = {
  user: { id: 'u-a', displayName: '甲', role: 'founder' },
  csrfToken: 'tok-1',
  env: { name: '测试机' },
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('请求超时', () => {
  test('【故意造出的失败】等响应头一直不回：到点报 timeout 和明确提示，并真的中止了请求', async () => {
    let signal: AbortSignal | undefined;
    const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/me') return Response.json(ME);
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }) as typeof fetch;
    const p = createHttpApi({ fetch: fn, timeoutMs: 5_000 })
      .resolveNotification('n-1')
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const err = await p;
    expect(err).toMatchObject({ name: 'ApiError', status: 0, code: 'timeout' });
    expect((err as Error).message).toContain('5 秒没有回应');
    expect((err as Error).message).not.toContain('AbortError');
    expect(signal?.aborted).toBe(true);
  });

  test('【故意造出的失败】响应头回了、响应体读到一半卡住：也算超时', async () => {
    const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/me') return Response.json(ME);
      const body = new ReadableStream({
        start(c) {
          init?.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const p = createHttpApi({ fetch: fn, timeoutMs: 1_000 })
      .jobs()
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await p).toMatchObject({ code: 'timeout' });
  });

  test('正常回来的请求不被超时误伤，计时器也不留着', async () => {
    const fn = (async (input: RequestInfo | URL) => {
      if (String(input) === '/api/me') return Response.json(ME);
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    await createHttpApi({ fetch: fn, timeoutMs: 1_000 }).logout();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('默认超时是 30 秒', () => {
    expect(REQUEST_TIMEOUT_MS).toBe(30_000);
  });
});
