// 请求超时（#2017）：到点就停，提示写明等了多久。用假定时器，不真等。
import { afterEach, expect, test, vi } from 'vitest';
import { ApiError } from './client';
import { createHttpApi } from './http';

afterEach(() => {
  vi.useRealTimers();
});

test('假定时器拨过时限：请求停在超时，不再挂着', async () => {
  const http = await import('./http');
  expect(typeof http.REQUEST_TIMEOUT_MS).toBe('number');
  const limit = http.REQUEST_TIMEOUT_MS;
  vi.useFakeTimers();
  let sawSignal = false;
  const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    sawSignal = init?.signal instanceof AbortSignal;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      signal.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    });
  });
  const api = createHttpApi({ fetch });
  const settled = api.repos().then(
    () => 'ok' as const,
    (e: unknown) => e,
  );
  await vi.advanceTimersByTimeAsync(limit);
  const raced = await Promise.race([settled, Promise.resolve('still-pending' as const)]);
  expect(raced).not.toBe('still-pending');
  expect(sawSignal).toBe(true);
  expect(raced).toBeInstanceOf(ApiError);
  const err = raced as ApiError;
  expect(err.code).toBe('timeout');
  expect(err.message).toContain(`${limit / 1000}`);
  expect(err.message).toMatch(/再试/);
  expect(err.message).not.toContain('AbortError');
  expect(err.message).not.toContain('The operation was aborted');
});
