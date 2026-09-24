import { useCallback, useState, useSyncExternalStore } from 'react';

// 全页共用一个秒表：几十个倒计时不各开一个定时器。
const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | undefined;
let clockNow = Date.now();

function subscribeClock(cb: () => void) {
  clockListeners.add(cb);
  if (!clockTimer) {
    clockNow = Date.now();
    clockTimer = setInterval(() => {
      clockNow = Date.now();
      for (const l of clockListeners) l();
    }, 1000);
  }
  return () => {
    clockListeners.delete(cb);
    if (!clockListeners.size && clockTimer) {
      clearInterval(clockTimer);
      clockTimer = undefined;
    }
  };
}

/** 每秒刷新一次的「现在」。 */
export function useNow(): number {
  return useSyncExternalStore(
    subscribeClock,
    () => clockNow,
    () => clockNow,
  );
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

/** 手机宽度：看板退化成可折叠的树形列表。 */
export function useIsMobile(): boolean {
  return useMediaQuery('(max-width: 767px)');
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
