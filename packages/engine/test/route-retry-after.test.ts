// 等路由该睡几秒（real/store-ports.ts 的 routeRetryAfterSeconds）：等额度按清零时刻，别的仍是短间隔。
import { describe, expect, it } from 'vitest';
import {
  MAX_ROUTE_WAIT_SECONDS,
  QUOTA_ROUTE_WAIT_CAP_SECONDS,
  routeRetryAfterSeconds,
} from '../src/real/store-ports.ts';

const NOW = Date.parse('2026-10-15T15:00:00.000Z');
const at = (seconds: number) => new Date(NOW + seconds * 1000).toISOString();

describe('routeRetryAfterSeconds', () => {
  it('等额度、until 在 28 小时后：封顶，不压成 120 秒', () => {
    expect(routeRetryAfterSeconds('quota', at(28 * 60 * 60), NOW)).toBe(QUOTA_ROUTE_WAIT_CAP_SECONDS);
    expect(QUOTA_ROUTE_WAIT_CAP_SECONDS).toBeGreaterThan(MAX_ROUTE_WAIT_SECONDS);
  });

  it('等额度、until 在上限之内：按 until，短于 120 秒的也不拉长', () => {
    expect(routeRetryAfterSeconds('quota', at(45 * 60), NOW)).toBe(45 * 60);
    expect(routeRetryAfterSeconds('quota', at(30), NOW)).toBe(30);
  });

  it('等额度、刚好到上限或再远一秒：都是上限', () => {
    expect(routeRetryAfterSeconds('quota', at(QUOTA_ROUTE_WAIT_CAP_SECONDS), NOW)).toBe(
      QUOTA_ROUTE_WAIT_CAP_SECONDS,
    );
    expect(routeRetryAfterSeconds('quota', at(QUOTA_ROUTE_WAIT_CAP_SECONDS + 1), NOW)).toBe(
      QUOTA_ROUTE_WAIT_CAP_SECONDS,
    );
  });

  it('等额度、时刻已过或认不出：最短 1 秒，或根本不给秒数', () => {
    expect(routeRetryAfterSeconds('quota', at(-10), NOW)).toBe(1);
    expect(routeRetryAfterSeconds('quota', null, NOW)).toBeUndefined();
    expect(routeRetryAfterSeconds('quota', '不是时刻', NOW)).toBeUndefined();
  });

  it('等空位、熔断、切号、探针：28 小时后也最多 120 秒', () => {
    const far = at(28 * 60 * 60);
    for (const waitFor of ['slot', 'breaker', 'org', 'probe'] as const) {
      expect(routeRetryAfterSeconds(waitFor, far, NOW)).toBe(MAX_ROUTE_WAIT_SECONDS);
    }
    expect(routeRetryAfterSeconds('breaker', null, NOW)).toBeUndefined();
  });
});
