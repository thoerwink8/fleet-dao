// 任务页的取数（#3784）：轮询，整份快照整体替换，不做逐条推送（OmO 的做法也是整份快照替换，见 PR「参照了什么」）。
// 间隔和退避照会话列表（useSessions）：10 秒一次，读失败间隔翻倍、封顶 60 秒，成功一次立刻回 10 秒；页面不可见时不读；401 停下来给登录入口。
import type { BatchesPage, WorkGraph } from '@fleet-dao/harness-contract/work-graph';
import { useEffect, useRef, useState } from 'react';
import { API_BASE, getJson, isUnauthorized } from './api';
import { pollInterval } from './backoff';

export const WORK_POLL_MS = 10_000;
export const BATCHES_POLL_MS = 60_000;

export const batchesUrl = (base: string, q: { limit?: number; before?: string } = {}): string => {
  const p = new URLSearchParams();
  if (q.limit !== undefined) p.set('limit', String(q.limit));
  if (q.before !== undefined) p.set('before', q.before);
  const qs = p.toString();
  return `${base}/work/batches${qs ? `?${qs}` : ''}`;
};
export const batchUrl = (base: string, batchId: string): string =>
  `${base}/work/batches/${encodeURIComponent(batchId)}`;

export interface Polled<T> {
  data: T | null;
  /** 最近一次读失败的原因；成功一次就清空（旧数据照旧显示）。 */
  error: string | null;
  failures: number;
  unauthorized: boolean;
  /** 还没读到第一份。 */
  loading: boolean;
  /** 最近一次读成功的时刻（毫秒）。 */
  updatedAt: number | null;
}

/** 通用轮询：key 变了就丢掉旧数据重新读（不同批次的快照不混）。 */
export function usePolled<T>(
  key: string | null,
  load: (signal: AbortSignal) => Promise<T>,
  baseMs: number,
): Polled<T> {
  const [state, setState] = useState<Polled<T>>({
    data: null,
    error: null,
    failures: 0,
    unauthorized: false,
    loading: key !== null,
    updatedAt: null,
  });
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    setState({
      data: null,
      error: null,
      failures: 0,
      unauthorized: false,
      loading: key !== null,
      updatedAt: null,
    });
    if (key === null) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const ac = new AbortController();
    const tick = async (): Promise<void> => {
      if (stopped) return;
      if (document.visibilityState === 'hidden') {
        timer = setTimeout(() => void tick(), baseMs);
        return;
      }
      try {
        const data = await loadRef.current(ac.signal);
        failures = 0;
        if (!stopped)
          setState({
            data,
            error: null,
            failures: 0,
            unauthorized: false,
            loading: false,
            updatedAt: Date.now(),
          });
      } catch (err) {
        if (stopped) return;
        if (isUnauthorized(err)) {
          setState((s) => ({
            ...s,
            loading: false,
            unauthorized: true,
            error: err instanceof Error ? err.message : '没登录',
          }));
          return;
        }
        failures += 1;
        const f = failures;
        setState((s) => ({
          ...s,
          loading: false,
          failures: f,
          error: err instanceof Error ? err.message : '读不到',
        }));
      }
      if (!stopped) timer = setTimeout(() => void tick(), pollInterval(baseMs, failures));
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
  }, [key, baseMs]);

  return state;
}

export function useBatches(): Polled<BatchesPage> {
  return usePolled(
    'batches',
    (signal) => getJson<BatchesPage>(batchesUrl(API_BASE, { limit: 30 }), signal),
    BATCHES_POLL_MS,
  );
}

export function useBatchGraph(batchId: string | null): Polled<WorkGraph> {
  return usePolled(
    batchId,
    (signal) => getJson<WorkGraph>(batchUrl(API_BASE, batchId as string), signal),
    WORK_POLL_MS,
  );
}

/** 每秒走一次的「现在」；没有在跑的节点时不走（active=false）。 */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function useMediaQuery(query: string): boolean {
  const [on, setOn] = useState(() => (typeof matchMedia === 'undefined' ? false : matchMedia(query).matches));
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const mq = matchMedia(query);
    const h = () => setOn(mq.matches);
    h();
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, [query]);
  return on;
}

const VIEW_KEY = 'fleet.next.work.view';
export type WorkView = 'graph' | 'list';

export function readView(): WorkView | null {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === 'graph' || v === 'list' ? v : null;
  } catch {
    return null;
  }
}
export function writeView(v: WorkView): void {
  try {
    localStorage.setItem(VIEW_KEY, v);
  } catch {
    // 存不了就只管这一次
  }
}
