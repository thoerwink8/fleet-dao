import { describe, expect, test } from 'vitest';
import { ApiError } from './client';
import {
  backedOffPollMs,
  gatewayPollInterval,
  isGatewayError,
  POLL_BACKOFF_MAX_MS,
  type PollQuery,
  retryUnlessGateway,
  wrapRefetchInterval,
} from './poll-backoff';

function query(): PollQuery {
  return { state: { error: null, errorUpdateCount: 0, status: 'pending' } };
}

function fail(q: PollQuery, status: number, code: string) {
  q.state.errorUpdateCount += 1;
  q.state.error = new ApiError(status, code, 'x');
  q.state.status = 'error';
}

describe('网关错误', () => {
  test('502、503、504、断网、超时算；401、业务错误、500、普通异常不算', () => {
    expect(isGatewayError(new ApiError(502, 'http_502', 'x'))).toBe(true);
    expect(isGatewayError(new ApiError(503, 'requests_unavailable', 'x'))).toBe(true);
    expect(isGatewayError(new ApiError(504, 'http_504', 'x'))).toBe(true);
    expect(isGatewayError(new ApiError(0, 'network', '连不上'))).toBe(true);
    expect(isGatewayError(new ApiError(0, 'timeout', '超时'))).toBe(true);
    expect(isGatewayError(new ApiError(401, 'unauthenticated', '要先登录'))).toBe(false);
    expect(isGatewayError(new ApiError(409, 'conflict', '刚被改过'))).toBe(false);
    expect(isGatewayError(new ApiError(500, 'internal', '后端出错了'))).toBe(false);
    expect(isGatewayError(new Error('boom'))).toBe(false);
    expect(isGatewayError(null)).toBe(false);
  });

  test('网关错误不紧接着重试；其余仍只再试一次', () => {
    expect(retryUnlessGateway(0, new ApiError(504, 'http_504', 'x'))).toBe(false);
    expect(retryUnlessGateway(0, new ApiError(0, 'network', '连不上'))).toBe(false);
    expect(retryUnlessGateway(0, new ApiError(401, 'unauthenticated', '要先登录'))).toBe(true);
    expect(retryUnlessGateway(0, new ApiError(409, 'conflict', '刚被改过'))).toBe(true);
    expect(retryUnlessGateway(0, new ApiError(500, 'internal', '后端出错了'))).toBe(true);
    expect(retryUnlessGateway(1, new ApiError(401, 'unauthenticated', '要先登录'))).toBe(false);
  });
});

describe('轮询间隔', () => {
  test('连续 504 从 10 秒拉到 20、40、60 封顶；成功回到 10 秒，下一次失败重新从 20 秒起', () => {
    const q = query();
    const base = 10_000;
    expect(gatewayPollInterval(base, q)).toBe(base);

    fail(q, 504, 'http_504');
    expect(gatewayPollInterval(base, q)).toBe(20_000);
    // 同一次失败重复算间隔，不能再加一
    expect(gatewayPollInterval(base, q)).toBe(20_000);

    // 下一次读取已经发出、上一笔错误被清掉：间隔先别缩回去
    q.state.error = null;
    q.state.status = 'pending';
    expect(gatewayPollInterval(base, q)).toBe(20_000);

    fail(q, 504, 'http_504');
    expect(gatewayPollInterval(base, q)).toBe(40_000);
    fail(q, 504, 'http_504');
    expect(gatewayPollInterval(base, q)).toBe(POLL_BACKOFF_MAX_MS);
    fail(q, 504, 'http_504');
    expect(gatewayPollInterval(base, q)).toBe(60_000);

    q.state.error = null;
    q.state.status = 'success';
    expect(gatewayPollInterval(base, q)).toBe(10_000);

    fail(q, 504, 'http_504');
    expect(gatewayPollInterval(base, q)).toBe(20_000);
  });

  test('401、409、500 连续失败也停在原间隔', () => {
    for (const [status, code] of [
      [401, 'unauthenticated'],
      [409, 'conflict'],
      [500, 'internal'],
    ] as const) {
      const q = query();
      fail(q, status, code);
      expect(gatewayPollInterval(10_000, q)).toBe(10_000);
      fail(q, status, code);
      expect(gatewayPollInterval(10_000, q)).toBe(10_000);
    }
  });

  test('网关失败夹一次 401，连续计数清掉，再 504 从 20 秒重新起', () => {
    const q = query();
    // 每次失败后观察者都会重算间隔；不观察的话中间那次记不上
    fail(q, 504, 'http_504');
    expect(gatewayPollInterval(10_000, q)).toBe(20_000);
    fail(q, 504, 'http_504');
    expect(gatewayPollInterval(10_000, q)).toBe(40_000);
    fail(q, 401, 'unauthenticated');
    expect(gatewayPollInterval(10_000, q)).toBe(10_000);
    fail(q, 504, 'http_504');
    expect(gatewayPollInterval(10_000, q)).toBe(20_000);
  });

  test('原间隔已经不短于 60 秒就保持，不缩短', () => {
    const q = query();
    fail(q, 503, 'http_503');
    fail(q, 503, 'http_503');
    expect(gatewayPollInterval(60_000, q)).toBe(60_000);
    expect(gatewayPollInterval(300_000, q)).toBe(300_000);
    expect(backedOffPollMs(30_000, 1)).toBe(60_000);
    expect(backedOffPollMs(30_000, 4)).toBe(60_000);
  });

  test('同一个数字共用一个函数；返回 false 的间隔继续停', () => {
    expect(wrapRefetchInterval(10_000)).toBe(wrapRefetchInterval(10_000));
    const q = query();
    fail(q, 504, 'http_504');
    const stopped = wrapRefetchInterval((_query: PollQuery) => false as const);
    expect(stopped(q)).toBe(false);
  });
});
