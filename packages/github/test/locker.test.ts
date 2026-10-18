import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryIdempotencyStore } from '../src/idempotency.ts';
import { lockerOver } from '../src/ledger.ts';

afterEach(() => vi.useRealTimers());

describe('生产共享租约锁的严格确认', () => {
  it('释放 CAS 已被接走时 strict 拒绝返回成功，默认调用保持原语义', async () => {
    for (const strict of [true, false]) {
      const store = memoryIdempotencyStore();
      const now = new Date('2026-10-18T00:00:00Z');
      const locker = lockerOver(store, { strict, now: () => now });
      const result = locker.withLock('policy', async () => {
        expect(await store.takeOver('gh:lock:policy', now, new Date(now.getTime() + 1))).toBe(true);
        return 'written';
      });
      if (strict) await expect(result).rejects.toMatchObject({ code: 'LOCK_LOST', retryable: true });
      else await expect(result).resolves.toBe('written');
      expect(await store.peek('gh:lock:policy')).not.toBeNull();
    }
  });

  it('定时续租发现失锁，函数最终完成也不能报成功', async () => {
    vi.useFakeTimers();
    const store = memoryIdempotencyStore();
    const now = new Date('2026-10-18T00:00:00Z');
    const locker = lockerOver(store, { strict: true, now: () => now, renewEveryMs: 10 });
    await expect(
      locker.withLock('policy', async () => {
        await store.takeOver('gh:lock:policy', now, new Date(now.getTime() + 1));
        await vi.advanceTimersByTimeAsync(10);
        return 'written';
      }),
    ).rejects.toMatchObject({ code: 'LOCK_LOST' });
  });

  it('释放数据库报错也不能确认完整持锁', async () => {
    const store = memoryIdempotencyStore();
    store.release = async () => {
      throw new Error('db unavailable');
    };
    await expect(
      lockerOver(store, { strict: true }).withLock('policy', async () => 'written'),
    ).rejects.toMatchObject({ code: 'LOCK_LOST' });
  });
});
