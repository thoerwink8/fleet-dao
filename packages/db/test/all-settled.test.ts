// 并行查询一条先失败时，不能在其余还在跑的时候就抛（#2181）：那些查询占着别的连接上的锁。
import { describe, expect, it } from 'vitest';
import { allSettledOrThrow } from '../src/queries/all-settled.ts';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** 把已经排上的微任务跑完。慢查询还没落地时，allSettledOrThrow 不该在这里返回。 */
async function microtasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('allSettledOrThrow', () => {
  it('一条先失败时，等其余查询都落定才抛错', async () => {
    const mid = deferred<string>();
    const slow = deferred<string>();
    let midSettled = false;
    let slowSettled = false;
    const midQuery = mid.promise.then((value) => {
      midSettled = true;
      return value;
    });
    const slowQuery = slow.promise.then((value) => {
      slowSettled = true;
      return value;
    });
    const fastQuery = Promise.reject(new Error('fast-fail'));
    const pending = allSettledOrThrow([fastQuery, midQuery, slowQuery]);
    let returned = false;
    pending.then(
      () => {
        returned = true;
      },
      () => {
        returned = true;
      },
    );

    await microtasks();
    expect(returned, '快的那条已经失败，慢的两条还没落地就返回了').toBe(false);
    expect(midSettled).toBe(false);
    expect(slowSettled).toBe(false);

    mid.resolve('mid');
    await microtasks();
    expect(returned, '还有一条查询没落地就返回了').toBe(false);
    expect(midSettled).toBe(true);
    expect(slowSettled).toBe(false);

    slow.resolve('slow');
    await expect(pending).rejects.toThrow('fast-fail');
    expect(slowSettled).toBe(true);
    expect(returned).toBe(true);
  });

  it('都成功时按传入顺序返回', async () => {
    await expect(allSettledOrThrow([Promise.resolve(1), Promise.resolve('a')])).resolves.toEqual([1, 'a']);
  });
});
