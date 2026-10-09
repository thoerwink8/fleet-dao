// 路由页长列表的几个纯函数（#1366 第二部分）：窗口化（只画看得见的行）、拖到容器边缘时的自动滚动速度、
// 置顶 / 置底 / 挪一格 / 放下后的新顺序、搜索和「只看已开启」的筛选。组件里不再自己算这些。

/** 行数不超过这个就全画，不开窗口：几十行一次画完最简单，也不会让拖动出怪事。 */
export const WINDOW_MIN_ROWS = 50;

/** 窗口上下各多画几行，滚得快时不露白。 */
const OVERSCAN = 6;

/** 此刻该画哪几行（左闭右开）。行数不超过 WINDOW_MIN_ROWS 全画。 */
export function windowRange(args: {
  count: number;
  rowHeight: number;
  /** 滚动容器的可视高度。 */
  height: number;
  scrollTop: number;
}): { start: number; end: number } {
  const { count, rowHeight, height, scrollTop } = args;
  if (count <= WINDOW_MIN_ROWS || rowHeight <= 0) return { start: 0, end: count };
  // 滚动位置在内容之外（行数刚变少、容器还没来得及回弹）：按最后一行算，不画出空窗口
  const first = Math.min(count - 1, Math.floor(Math.max(0, scrollTop) / rowHeight));
  const visible = Math.ceil(height / rowHeight);
  return {
    start: Math.max(0, first - OVERSCAN),
    end: Math.min(count, first + visible + OVERSCAN),
  };
}

/** 离容器上下沿多近开始滚（像素）。 */
export const AUTOSCROLL_EDGE = 48;
/** 一帧最多滚多少像素。 */
export const AUTOSCROLL_MAX_STEP = 24;

/**
 * 拖动时指针在容器上下沿附近，这一帧该滚多少：负数往上、正数往下、0 不滚。离沿越近越快；
 * 指针拖出了容器（高于上沿、低于下沿）按最快滚。容器比两个边区还矮时，边区缩成各一半，免得中间永远在滚。
 */
export function autoScrollDelta(
  pointerY: number,
  top: number,
  bottom: number,
  edge: number = AUTOSCROLL_EDGE,
  maxStep: number = AUTOSCROLL_MAX_STEP,
): number {
  const zone = Math.min(edge, Math.max(0, (bottom - top) / 2));
  if (zone <= 0) return 0;
  const speed = (depth: number) => Math.max(1, Math.round(maxStep * Math.min(1, depth / zone)));
  if (pointerY < top + zone) return -speed(top + zone - pointerY);
  if (pointerY > bottom - zone) return speed(pointerY - (bottom - zone));
  return 0;
}

export const sameOrder = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/** 把 movedId 往前 / 往后挪一格；已在头 / 尾、或不在里面返回 null。 */
export function stepOrder(ids: readonly string[], movedId: string, delta: -1 | 1): string[] | null {
  const from = ids.indexOf(movedId);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return null;
  const next = [...ids];
  const swap = next[to];
  if (swap === undefined) return null;
  next[to] = movedId;
  next[from] = swap;
  return next;
}

/** 置顶 / 置底。已经在那儿、或不在里面返回 null（不当成一次改动）。 */
export function moveToEdge(ids: readonly string[], movedId: string, edge: 'top' | 'bottom'): string[] | null {
  const from = ids.indexOf(movedId);
  if (from < 0) return null;
  if (edge === 'top' ? from === 0 : from === ids.length - 1) return null;
  const rest = ids.filter((id) => id !== movedId);
  return edge === 'top' ? [movedId, ...rest] : [...rest, movedId];
}

/** 放在 targetId 的前面或后面。目标就是自己、或不在里面，顺序不变。 */
export function dropOrder(
  ids: readonly string[],
  movedId: string,
  targetId: string,
  edge: 'before' | 'after',
): string[] {
  if (movedId === targetId) return [...ids];
  const rest = ids.filter((id) => id !== movedId);
  const at = rest.indexOf(targetId);
  if (at < 0) return [...ids];
  const next = [...rest];
  next.splice(edge === 'before' ? at : at + 1, 0, movedId);
  return next;
}

export interface ListFilter {
  /** 搜索词，空白不筛。 */
  query: string;
  /** 只看已开启的。 */
  onlyEnabled: boolean;
}

export const NO_FILTER: ListFilter = { query: '', onlyEnabled: false };

export const filterActive = (f: ListFilter): boolean => f.onlyEnabled || f.query.trim() !== '';

/** 搜索不分大小写、按空格拆成几个词，每个词都要在某个字段里出现。 */
export function filterRows<T>(
  rows: readonly T[],
  filter: ListFilter,
  haystack: (row: T) => readonly string[],
  enabledOf: (row: T) => boolean,
): T[] {
  const words = filter.query.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((row) => {
    if (filter.onlyEnabled && !enabledOf(row)) return false;
    if (words.length === 0) return true;
    const text = haystack(row).join('\n').toLowerCase();
    return words.every((w) => text.includes(w));
  });
}
