import { useCallback, useState, useSyncExternalStore } from 'react';

// 全页共用的钟：几十个倒计时不各开一个定时器。按走一步的时长各一个（秒钟、半分钟钟）。
function createClock(stepMs: number) {
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let now = Date.now();
  return {
    subscribe(cb: () => void) {
      listeners.add(cb);
      if (!timer) {
        now = Date.now();
        timer = setInterval(() => {
          now = Date.now();
          for (const l of listeners) l();
        }, stepMs);
      }
      return () => {
        listeners.delete(cb);
        if (!listeners.size && timer) {
          clearInterval(timer);
          timer = undefined;
        }
      };
    },
    read: () => now,
  };
}

const secondClock = createClock(1000);

/** 慢钟走一步的时长：只显示到「分钟」的相对时间（合于 N 分钟前）每 30 秒重算一次，不靠重拉数据。 */
export const SLOW_CLOCK_MS = 30_000;
const slowClock = createClock(SLOW_CLOCK_MS);

/** 每秒刷新一次的「现在」。 */
export function useNow(): number {
  return useSyncExternalStore(secondClock.subscribe, secondClock.read, secondClock.read);
}

/** 每 30 秒刷新一次的「现在」：给只精确到分钟的相对时间用，省得几十张卡每秒重绘。 */
export function useSlowNow(): number {
  return useSyncExternalStore(slowClock.subscribe, slowClock.read, slowClock.read);
}

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', cb);
      return () => mql.removeEventListener('change', cb);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** 存在浏览器本地的一小块状态（仓、过滤条件这类个人习惯）。 */
export function useLocalState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        // 存不了就只在这次会话里生效。
      }
    },
    [key],
  );
  return [value, set];
}
