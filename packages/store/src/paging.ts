/**
 * 翻页两套 Store 共用的纯逻辑（游标的写法在 ids.ts）。
 * 改这里之前必须知道：翻页一律按 (at, id) 倒序；游标就是上一页最后一条的 `at|id`；
 * 「还有下一页」只看这一页之后还剩不剩（库版多取一条来判，内存版看总数），写法不同、给出的游标必须一样。
 */
import type { Page } from './ports.ts';

export interface AtId {
  at: string;
  id: string;
}

/** 纯数字的编号按数值比，其余按字面比。 */
export function compareIds(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return Number(a) - Number(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 按 (at, id) 正序比。 */
export function byAtThenId(a: AtId, b: AtId): number {
  return a.at.localeCompare(b.at) || compareIds(a.id, b.id);
}

/** 游标：上一页最后一条的 `at|id`。 */
export const cursorOf = (last: AtId): string => `${last.at}|${last.id}`;

/** 下一页的游标：这一页有最后一条、而且后面确实还有，才给。 */
export function nextCursorOf(last: AtId | undefined, hasMore: boolean): string | undefined {
  return last && hasMore ? cursorOf(last) : undefined;
}

/** 在按 (at, id) 倒序排好的列表里，找出严格排在游标之后的第一条；没有游标从头开始，游标之后一条都没有就是列表长度。 */
export function startAfterCursor(sortedDesc: readonly AtId[], cursor: AtId | null): number {
  if (!cursor) return 0;
  const start = sortedDesc.findIndex((x) => byAtThenId(x, cursor) < 0);
  return start === -1 ? sortedDesc.length : start;
}

/** 从倒序排好的整个列表里切一页（内存版整页翻，库版的时间线也是整份取回来再切）。 */
export function pageOfSorted<T extends AtId>(
  sortedDesc: readonly T[],
  cursor: AtId | null,
  limit: number,
): Page<T> {
  const start = startAfterCursor(sortedDesc, cursor);
  const items = sortedDesc.slice(start, start + limit);
  return { items, nextCursor: nextCursorOf(items.at(-1), start + limit < sortedDesc.length) };
}
