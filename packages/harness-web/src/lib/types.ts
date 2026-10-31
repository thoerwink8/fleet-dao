// 前端读到的数据形状。事件的形状和接口层（packages/harness-api）一一对应：id 就是 fleet2.events.id，SSE 的事件号也是它。
import type { EventType } from '@fleet-dao/harness-contract';
import type { TailEvent } from './session-state';

export interface FeedEvent {
  id: number;
  seq: number;
  /** 契约里认识的类型，或者将来新加的（读到不认识的照样展示，不丢）。 */
  type: EventType | (string & {});
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface HistoryPage {
  events: FeedEvent[];
  head: number;
  hasMore: boolean;
}

export interface SessionSummary {
  id: string;
  eventCount: number;
  lastEventId: number;
  lastAt: string;
  lastType: string;
  /** 最后一条事件的载荷（列表取一句摘要用，不用拉整条流）。 */
  lastPayload: Record<string, unknown>;
  /** 最近一批事件的瘦身版（最旧在前），列表按它推工人状态；旧接口没有这个字段时当空。 */
  tail?: TailEvent[];
}

export interface SessionsPage {
  sessions: SessionSummary[];
  /** 非空 = 还有更老的会话，下一页把它当 before 传。 */
  nextBefore: number | null;
}

export type FeedStatus = 'loading' | 'live' | 'reconnecting' | 'failed';

export interface FeedState {
  status: FeedStatus;
  events: readonly FeedEvent[];
  /** 比已加载的最老一条更老的还有没有。 */
  hasOlder: boolean;
  /** 连续失败了几次（0 = 连着）。 */
  attempt: number;
  /** 下一次重连大约多少毫秒后（只在 reconnecting 时有）。 */
  retryInMs: number | null;
  /** 整页重取过几次（收到 resync）。 */
  resyncs: number;
  /** failed 时的原因，人话。 */
  error: string | null;
  /** failed 时服务返回的状态码（401 = 没登录，页面给登录入口）。 */
  errorStatus: number | null;
}
