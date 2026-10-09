// 飞书调用记数：一次端口调用里，每次已经交给飞书的 HTTP（成功、失败、超时、重试）都算一次。
// 假飞书不报次数：包装层按「调了一次」计，抛了也算——请求已经发出，只算成功会把用量算少，八成报警来得晚。
import { AsyncLocalStorage } from 'node:async_hooks';

const dispatched = new AsyncLocalStorage<{ n: number }>();

/** 这一下 HTTP 已经交出去了。不在 measureFeishuCall 里面调用则什么都不记。 */
export function noteFeishuDispatched(): void {
  const box = dispatched.getStore();
  if (box) box.n += 1;
}

/**
 * 跑一次端口调用。结束时（含抛出）把次数交给 onAttempts：
 * 里面报过就用那个数（真飞书的重试）；没报过按 1 次（假飞书）。
 */
export async function measureFeishuCall<T>(
  fn: () => Promise<T>,
  onAttempts: (n: number) => void,
): Promise<T> {
  const box = { n: 0 };
  try {
    return await dispatched.run(box, fn);
  } finally {
    onAttempts(box.n > 0 ? box.n : 1);
  }
}
