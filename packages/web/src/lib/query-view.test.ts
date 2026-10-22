import { describe, expect, test, vi } from 'vitest';
import { viewOf } from './query-view';

describe('viewOf：刷新失败但有旧数据不再当 error', () => {
  const refetch = vi.fn();

  test('没数据没错：loading', () => {
    expect(viewOf({ error: null, data: undefined, dataUpdatedAt: 0, refetch })).toEqual({
      status: 'loading',
    });
  });

  test('没数据有错：error（从没读成），带重试', () => {
    const v = viewOf({ error: new Error('连不上'), data: undefined, dataUpdatedAt: 0, refetch });
    expect(v.status).toBe('error');
    if (v.status === 'error') {
      v.retry();
      expect(refetch).toHaveBeenCalledTimes(1);
    }
  });

  test('有数据有错：data 加 stale，旧数据还在，记着上一次读成的时刻', () => {
    const v = viewOf({ error: new Error('超时'), data: { a: 1 }, dataUpdatedAt: 1234, refetch });
    expect(v.status).toBe('data');
    if (v.status === 'data') {
      expect(v.data).toEqual({ a: 1 });
      expect(v.stale?.dataUpdatedAt).toBe(1234);
      expect(v.stale?.error).toEqual(new Error('超时'));
    }
  });

  test('有数据没错：data，没有 stale', () => {
    const v = viewOf({ error: null, data: [], dataUpdatedAt: 1, refetch });
    expect(v).toEqual({ status: 'data', data: [] });
  });
});
