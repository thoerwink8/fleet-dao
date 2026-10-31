import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { API_BASE, fetchSessions } from './api';
import { pollInterval } from './backoff';
import { SessionFeed } from './feed';
import type { FeedState, SessionSummary } from './types';

/** 一个会话的实时事件流；会话号变了就换一条（旧的关掉）。 */
export function useSessionFeed(sessionId: string): { feed: SessionFeed; state: FeedState } {
  const feed = useMemo(() => new SessionFeed(sessionId, { base: API_BASE }), [sessionId]);
  useEffect(() => {
    feed.start();
    return () => feed.stop();
  }, [feed]);
  const state = useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  return { feed, state };
}

export const SESSIONS_POLL_MS = 10_000;

export interface SessionsState {
  sessions: SessionSummary[] | null;
  /** 最近一次读失败的原因；成功一次就清空。 */
  error: string | null;
  failures: number;
}

/**
 * 会话列表：每 10 秒读一次；后端挂了间隔翻倍、封顶 60 秒（旧坑 E5），读成功一次立刻恢复 10 秒。
 * 页面不可见时不读（切回来立刻读一次）。
 */
export function useSessions(): SessionsState {
  const [state, setState] = useState<SessionsState>({ sessions: null, error: null, failures: 0 });
  useEffect(() => {
    let stopped = false;
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
        const { sessions } = await fetchSessions(ac.signal);
        failures = 0;
        if (!stopped) setState({ sessions, error: null, failures: 0 });
      } catch (err) {
        if (stopped) return;
        failures += 1;
        setState((s) => ({
          sessions: s.sessions,
          error: err instanceof Error ? err.message : '读不到会话列表',
          failures,
        }));
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
      ac.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return state;
}
