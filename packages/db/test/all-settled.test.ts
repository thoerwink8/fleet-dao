// 并行查询一条先失败时，不能在其余还在跑的时候就抛（#2181、#2261）：那些查询还占着别的连接和锁。
// 用可控的假查询（手动放行的 Promise）断言返回时刻。
import { describe, expect, it } from 'vitest';
import { allSettledOrThrow } from '../src/queries/all-settled.ts';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (e: unknown) => void } {
  let resolve: (value: T) => void = () => {};
  let reject: (e: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 把已经排上的微任务跑完：该落定的都落定了，还没返回就是在等。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** 记下 p 什么时候落定（成功或失败都算）。 */
function track(p: Promise<unknown>): { done: () => boolean } {
  let settled = false;
  p.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return { done: () => settled };
}

describe('allSettledOrThrow', () => {
  it('一条先失败时，等其余查询都落定才抛错', async () => {
    const fast = deferred<string>();
    const mid = deferred<string>();
    const slow = deferred<string>();
    const pending = allSettledOrThrow([fast.promise, mid.promise, slow.promise]);
    const returned = track(pending);

    fast.reject(new Error('fast-fail'));
    await flush();
    expect(returned.done(), '第一条已失败，另两条还在跑就返回了').toBe(false);

    mid.resolve('mid');
    await flush();
    expect(returned.done(), '还有一条查询没落定就返回了').toBe(false);

    slow.resolve('slow');
    await expect(pending).rejects.toThrow('fast-fail');
  });

  it('对照：Promise.all 在同样情形下第一条失败就返回（这就是要防的）', async () => {
    const fast = deferred<string>();
    const slow = deferred<string>();
    const pending = Promise.all([fast.promise, slow.promise]);
    const returned = track(pending);
    fast.reject(new Error('fast-fail'));
    await flush();
    expect(returned.done()).toBe(true);
    await expect(pending).rejects.toThrow('fast-fail');
    slow.resolve('slow');
  });

  it('几条都失败时抛传入顺序里的第一条，不是最先失败的那条', async () => {
    const a = deferred<string>();
    const b = deferred<string>();
    const pending = allSettledOrThrow([a.promise, b.promise]);
    b.reject(new Error('b'));
    await flush();
    a.reject(new Error('a'));
    await expect(pending).rejects.toThrow('a');
  });

  it('都成功时按传入顺序返回', async () => {
    await expect(allSettledOrThrow([Promise.resolve(1), Promise.resolve('a')])).resolves.toEqual([1, 'a']);
  });
});
