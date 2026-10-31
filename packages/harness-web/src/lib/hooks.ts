import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { API_BASE, fetchSessions, isUnauthorized } from './api';
import { pollInterval } from './backoff';
import { SessionFeed } from './feed';
import type { FeedState, SessionSummary, SessionsPage } from './types';
import { releaseWhenHidden } from './visibility';

/**
 * 一个会话的实时事件流；会话号变了就换一条（旧的关掉）。
 * 标签页隐藏满 10 秒放掉连接，回到前台带 Last-Event-ID 续上（visibility.ts）。
 */
export function useSessionFeed(sessionId: string): { feed: SessionFeed; state: FeedState } {
  const feed = useMemo(() => new SessionFeed(sessionId, { base: API_BASE }), [sessionId]);
  useEffect(() => {
    feed.start();
    const release = releaseWhenHidden(feed, document);
    return () => {
      release();
      feed.stop();
    };
  }, [feed]);
  const state = useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  return { feed, state };
}

const NO_FEED_STATE: FeedState = {
  status: 'live',
  events: [],
  hasOlder: false,
  attempt: 0,
  retryInMs: null,
  resyncs: 0,
  error: null,
  errorStatus: null,
};
const noSubscribe = () => () => undefined;
const noSnapshot = () => NO_FEED_STATE;

/**
 * 一次工人运行的过程流（transcript:<runId>，#3781）；runId 为 null 时什么都不连（普通会话页没有过程）。
 * 连接策略和会话流一样：先取最新一页、再开 SSE 续上，标签页隐藏满 10 秒放掉连接。
 */
export function useTranscriptFeed(runId: string | null): { feed: SessionFeed | null; state: FeedState } {
  const feed = useMemo(
    () => (runId ? new SessionFeed(runId, { base: API_BASE, kind: 'transcripts' }) : null),
    [runId],
  );
  useEffect(() => {
    if (!feed) return;
    feed.start();
    const release = releaseWhenHidden(feed, document);
    return () => {
      release();
      feed.stop();
    };
  }, [feed]);
  const state = useSyncExternalStore(
    feed ? feed.subscribe : noSubscribe,
    feed ? feed.getSnapshot : noSnapshot,
  );
  return { feed, state };
}

export const SESSIONS_POLL_MS = 10_000;

export interface SessionsState {
  sessions: SessionSummary[] | null;
  /** 服务端算的「卡住」个数（全库，不受翻页影响）；旧接口没有这个字段或还没读到时是 null，页面不显示，不自己数。 */
  stuckCount: number | null;
  /** 最近一次读失败的原因；成功一次就清空。 */
  error: string | null;
  failures: number;
  /** 没登录或登录过期（401）：不再轮询，页面给登录入口。 */
  unauthorized: boolean;
  /** 还有更老的会话没加载。 */
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
}

/**
 * 会话列表：每 10 秒读一次最新一页；后端挂了间隔翻倍、封顶 60 秒（旧坑 E5），读成功一次立刻恢复 10 秒。
 * 页面不可见时不读（切回来立刻读一次）。「加载更多」用 nextBefore 往更老翻，翻出来的接在后面，
 * 轮询刷新的是最新一页（同一个会话以最新一页里的为准，不重复）。
 */
export function useSessions(): SessionsState {
  const [head, setHead] = useState<SessionsPage | null>(null);
  // 见过的全部会话（按号去重，同一个会话以最新读到的为准）：最新一页被新会话顶下去的，不会从列表里消失
  const [known, setKnown] = useState<ReadonlyMap<string, SessionSummary>>(new Map());
  const remember = useCallback((list: SessionSummary[]) => {
    setKnown((prev) => {
      const next = new Map(prev);
      for (const s of list) next.set(s.id, s);
      return next;
    });
  }, []);
  const [olderNext, setOlderNext] = useState<number | null | undefined>(undefined); // undefined = 还没翻过
  const [loadingMore, setLoadingMore] = useState(false);
  const [meta, setMeta] = useState({ error: null as string | null, failures: 0, unauthorized: false });
  const cursor = useRef<number | null>(null);
  const stoppedRef = useRef(false);

  useEffect(() => {
    let stopped = false;
    stoppedRef.current = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const ac = new AbortController();
    const tick = async (): Promise<void> => {
      if (stopped) return;
      if (document.visibilityState === 'hidden') {
        timer = setTimeout(() => void tick(), SESSIONS_POLL_MS);
        return;
      }
      try {
        const page = await fetchSessions(ac.signal);
        failures = 0;
        if (!stopped) {
          setHead(page);
          remember(page.sessions);
          setMeta({ error: null, failures: 0, unauthorized: false });
        }
      } catch (err) {
        if (stopped) return;
        if (isUnauthorized(err)) {
          // 没登录：重试没用，停下来等人登录后刷新页面
          setMeta({ error: err instanceof Error ? err.message : '没登录', failures, unauthorized: true });
          return;
        }
        failures += 1;
        setMeta({
          error: err instanceof Error ? err.message : '读不到会话列表',
          failures,
          unauthorized: false,
        });
      }
      if (!stopped) timer = setTimeout(() => void tick(), pollInterval(SESSIONS_POLL_MS, failures));
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    void tick();
    return () => {
      stopped = true;
      stoppedRef.current = true;
      ac.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [remember]);

  const nextBefore = olderNext !== undefined ? olderNext : (head?.nextBefore ?? null);
  cursor.current = nextBefore;
  const loadMore = useCallback(() => {
    const before = cursor.current;
    if (before === null || loadingMore) return;
    setLoadingMore(true);
    fetchSessions(undefined, before)
      .then((page) => {
        if (stoppedRef.current) return;
        remember(page.sessions);
        setOlderNext(page.nextBefore);
      })
      .catch((err) => {
        if (stoppedRef.current) return;
        setMeta((m) => ({
          ...m,
          error: err instanceof Error ? err.message : '读不到更多会话',
          unauthorized: isUnauthorized(err),
        }));
      })
      .finally(() => setLoadingMore(false));
  }, [loadingMore, remember]);

  const sessions = useMemo(
    () => (head ? [...known.values()].sort((a, b) => b.lastEventId - a.lastEventId) : null),
    [head, known],
  );

  return {
    sessions,
    stuckCount: head?.stuckCount ?? null,
    ...meta,
    hasMore: nextBefore !== null,
    loadingMore,
    loadMore,
  };
}
