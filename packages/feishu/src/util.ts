import { createHash } from 'node:crypto';

/** 在途的后台活：收事件的回调立刻返回，活放这里跑；停机时等它们做完再退。 */
export class Inflight {
  private readonly running = new Set<Promise<unknown>>();
  private readonly onError: (err: unknown) => void;

  /** onError：活自己没接住的错（本不该有），记日志用。 */
  constructor(onError: (err: unknown) => void) {
    this.onError = onError;
  }

  track(work: Promise<unknown>): void {
    const p: Promise<unknown> = work.catch(this.onError).finally(() => this.running.delete(p));
    this.running.add(p);
  }

  get size(): number {
    return this.running.size;
  }

  /** 等到手上没有活（活里又派出的新活也等）。 */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
  }

  /** 最多等 ms 毫秒；返回还没做完的数量。 */
  async drain(ms: number): Promise<number> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.idle(), new Promise<void>((r) => (timer = setTimeout(r, ms)))]);
    clearTimeout(timer);
    return this.running.size;
  }
}

/** 只留最近的 max 个。 */
export class Lru<K, V> {
  private readonly map = new Map<K, V>();
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
  has(key: K): boolean {
    return this.map.has(key);
  }
}

/** 飞书发消息的 uuid（同值 1 小时内只发一条）：同一件事、同一版内容算出同一个值，重试不重复发。最长 50 字符。 */
export function uuidFor(...parts: Array<string | number>): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
}

let counter = 0;
/** 每次渲染卡片一个新值，写进按钮回传值（见 cards.ts 开头）。 */
export function nextNonce(now: number): string {
  counter = (counter + 1) % 1_000_000;
  return `${now.toString(36)}${counter.toString(36)}`;
}

/** 可被叫停的等待。 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
