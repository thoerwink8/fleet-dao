import type { FeedEvent } from './types';

/**
 * 把新来的事件并进已有的：按事件号去重（同一个号只留一条）、按事件号升序。
 * 断线续传补发、整页重取和实时推送可能送来同一条，这里是「不重」的唯一一道关。
 */
export function mergeEvents(current: readonly FeedEvent[], incoming: readonly FeedEvent[]): FeedEvent[] {
  if (incoming.length === 0) return current as FeedEvent[];
  const last = current.at(-1);
  const first = incoming[0];
  // 常见路径：新来的全比现有的新，且自己有序无重复
  if (
    first &&
    (!last || first.id > last.id) &&
    incoming.every((e, i) => i === 0 || e.id > (incoming[i - 1]?.id ?? 0))
  ) {
    return [...current, ...incoming];
  }
  const byId = new Map<number, FeedEvent>();
  for (const e of current) byId.set(e.id, e);
  for (const e of incoming) if (!byId.has(e.id)) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}
