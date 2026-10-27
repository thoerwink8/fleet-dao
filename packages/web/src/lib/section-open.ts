// 区块收起的开合记在网址参数里（#3707 批次 3）：刷新、发给别人、从别的页回来都还是那几块展开着。
// 一个参数 `?open=`，逗号分开：`alarm,projects` 是展开，`-about` 是收起（默认展开的区块要用它才收得起来）。
// 没列到的按代码里给的默认（`Section` 的 defaultOpen），所以常态网址是干净的：默认怎样就不带参数。
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';

export const OPEN_PARAM = 'open';

/** 网址参数解析出来的开合：显式展开的、显式收起的（前者带 key，后者带 -key）。 */
export interface OpenState {
  opened: ReadonlySet<string>;
  closed: ReadonlySet<string>;
}

const EMPTY: OpenState = { opened: new Set(), closed: new Set() };

export function parseOpen(raw: string | null | undefined): OpenState {
  if (!raw) return EMPTY;
  const opened = new Set<string>();
  const closed = new Set<string>();
  for (const part of raw.split(',')) {
    const key = part.trim();
    if (key === '') continue;
    if (key.startsWith('-')) {
      const bare = key.slice(1).trim();
      if (bare !== '') closed.add(bare);
    } else {
      opened.add(key);
    }
  }
  return { opened, closed };
}

/** 写回网址参数的值；两边都空就返回 null（参数整个删掉，网址回到常态）。 */
export function serializeOpen(state: OpenState): string | null {
  const parts = [...[...state.opened].sort(), ...[...state.closed].sort().map((key) => `-${key}`)];
  return parts.length === 0 ? null : parts.join(',');
}

/** 这一块现在是开是合：显式收起优先，其次显式展开，都没有才用默认。 */
export function isOpenIn(state: OpenState, key: string, defaultOpen: boolean): boolean {
  if (state.closed.has(key)) return false;
  if (state.opened.has(key)) return true;
  return defaultOpen;
}

/** 点一下的结果：翻过来，并且和默认一样就把这一条从网址里去掉（不带多余参数）。 */
export function toggleIn(state: OpenState, key: string, defaultOpen: boolean): OpenState {
  const nowOpen = isOpenIn(state, key, defaultOpen);
  const opened = new Set(state.opened);
  const closed = new Set(state.closed);
  opened.delete(key);
  closed.delete(key);
  if (nowOpen) {
    // 从开到合：默认就是合的，不需要记
    if (defaultOpen) closed.add(key);
  } else if (!defaultOpen) {
    // 从合到开：默认就是开的，不需要记
    opened.add(key);
  }
  return { opened, closed };
}

/** 强制展开（比如点了左边的页内目录跳到收起的那一节）：和默认无关，记成展开。 */
export function openIn(state: OpenState, key: string): OpenState {
  const opened = new Set(state.opened);
  const closed = new Set(state.closed);
  opened.add(key);
  closed.delete(key);
  return { opened, closed };
}

/** 页面用的那套：读网址、点一下写回网址（replace，不往历史里塞一条、不跳滚动位置）。 */
export function useSectionOpen(): {
  isOpen: (key: string, defaultOpen?: boolean) => boolean;
  toggle: (key: string, defaultOpen?: boolean) => void;
  open: (key: string) => void;
} {
  const [params, setParams] = useSearchParams();
  // 参数没变就复用同一份解析结果：上下文每渲染一次都新给一份，会让下面各块白白重绘
  const raw = params.get(OPEN_PARAM);
  const state = useMemo(() => parseOpen(raw), [raw]);
  const write = useCallback(
    (next: OpenState) => {
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          const value = serializeOpen(next);
          if (value === null) p.delete(OPEN_PARAM);
          else p.set(OPEN_PARAM, value);
          return p;
        },
        { replace: true, preventScrollReset: true },
      );
    },
    [setParams],
  );
  return useMemo(
    () => ({
      isOpen: (key: string, defaultOpen = false) => isOpenIn(state, key, defaultOpen),
      toggle: (key: string, defaultOpen = false) => write(toggleIn(state, key, defaultOpen)),
      open: (key: string) => write(openIn(state, key)),
    }),
    [state, write],
  );
}
