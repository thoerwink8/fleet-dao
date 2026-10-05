// 看板多机：选中的环境记在网址参数 ?node=（分享出去、刷新都还是它），没有这个参数就是本台。
// 远程环境的新鲜度按「收到快照的时刻」和现在的钟现算，不等下一次重拉：推送停了没有事件，页面不能一直写「刚报过」。
import { NODE_FRESH_MS, type NodeFreshness } from '@fleet-dao/shared';
import { useCallback } from 'react';
import { useSearchParams } from 'react-router';
import { formatAgo, formatDuration } from './format';

export const NODE_PARAM = 'node';

/** 选中的远程环境编号；选的是本台（没有 ?node=）是 null。 */
export function useSelectedNodeId(): string | null {
  const [params] = useSearchParams();
  const id = params.get(NODE_PARAM);
  return id === null || id === '' ? null : id;
}

/** 选中的环境和换环境的办法：换的时候留在当前这一页、别的网址参数不动；选 null 回本台。 */
export function useNodeSelection(): { nodeId: string | null; select(id: string | null): void } {
  const [params, setParams] = useSearchParams();
  const raw = params.get(NODE_PARAM);
  const nodeId = raw === null || raw === '' ? null : raw;
  const select = useCallback(
    (id: string | null) => {
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        if (id === null) next.delete(NODE_PARAM);
        else next.set(NODE_PARAM, id);
        return next;
      });
    },
    [setParams],
  );
  return { nodeId, select };
}

/** 站内路径带上当前选中的环境（侧栏换页时不丢掉选择）。已经带了别的参数就用 & 接。 */
export function withNode(to: string, nodeId: string | null): string {
  if (nodeId === null) return to;
  return `${to}${to.includes('?') ? '&' : '?'}${NODE_PARAM}=${encodeURIComponent(nodeId)}`;
}

/** 远程环境这一刻新不新鲜：没收到过是 never；收到过的按收到的时刻和现在的钟现算（和后端 nodeFreshness 同一个门槛）。 */
export function freshnessNow(item: { receivedAt?: string | undefined }, now: number): NodeFreshness {
  if (item.receivedAt === undefined) return 'never';
  const at = Date.parse(item.receivedAt);
  if (Number.isNaN(at)) return 'never';
  return now - at < NODE_FRESH_MS ? 'fresh' : 'stale';
}

/**
 * 一个远程环境的「上报于 / 失联多久」白话：fresh 写「N 分钟前报的」，stale 写「失联 N 分钟」（从最后一次收到算起），
 * never 写「从没收到过它的快照」。
 */
export function nodeAgeText(item: { receivedAt?: string | undefined }, now: number): string {
  const f = freshnessNow(item, now);
  if (f === 'never' || item.receivedAt === undefined) return '从没收到过它的快照';
  if (f === 'fresh') return `${formatAgo(item.receivedAt, now)}报的`;
  return `失联 ${formatDuration(now - Date.parse(item.receivedAt))}`;
}
