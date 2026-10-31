// 一个会话的实时事件流：先取最新一页历史，再开 SSE，从历史的 head 接着收；
// 断线自动重连，带 Last-Event-ID（= 已收到的最大事件号），抖动退避；收到 resync 就清掉重取最新一页。
// 不用浏览器自带的 EventSource：它的重连间隔固定、没有抖动（多个标签页一起断会一起撞回去），也读不到状态码。
//
// 不漏：重连带 Last-Event-ID，服务端补发其后的全部；补不全它发 resync，我们整页重取。
// 不重：所有进来的事件都经 mergeEvents 按事件号去重。
// 不风暴：重连等待 = 抖动退避（backoff.ts）；resync 后的重取也先等一段随机时间；连得上但很快被断的不重置失败计数。
import { eventsUrl, explainStatus, FatalApiError, getJson, historyUrl, isFatalStatus } from './api';
import { reconnectDelay } from './backoff';
import { mergeEvents } from './merge';
import { SseParser } from './sse-parse';
import type { FeedEvent, FeedState, HistoryPage } from './types';

export interface FeedOptions {
  base: string;
  fetchImpl?: typeof fetch;
  rng?: () => number;
  /** 测试里换成假时钟；默认真 setTimeout。 */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** 连上后多久没收到任何字节（含心跳）就当它死了重连。服务端 15 秒一次心跳，默认 45 秒。 */
  idleMs?: number;
  /** 连上并撑过这么久才算稳了、失败计数清零。默认 5 秒。 */
  stableMs?: number;
  /** 首屏和 resync 重取的页大小。默认 200。 */
  pageSize?: number;
  /** resync 后重取前最多随机等多久（打散多个标签页同时重取）。默认 1500ms。 */
  resyncJitterMs?: number;
}

export function realSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done);
  });
}

const INITIAL: FeedState = {
  status: 'loading',
  events: [],
  hasOlder: false,
  attempt: 0,
  retryInMs: null,
  resyncs: 0,
  error: null,
  errorStatus: null,
};

type Outcome = 'resync' | 'ended';

export class SessionFeed {
  readonly sessionId: string;
  #o: Required<Omit<FeedOptions, 'fetchImpl'>> & { fetchImpl: typeof fetch };
  #state: FeedState = INITIAL;
  #listeners = new Set<() => void>();
  #cursor = 0;
  #loaded = false;
  #ac: AbortController | null = null;

  constructor(sessionId: string, options: FeedOptions) {
    this.sessionId = sessionId;
    this.#o = {
      base: options.base,
      fetchImpl: options.fetchImpl ?? ((...a) => fetch(...a)),
      rng: options.rng ?? Math.random,
      sleep: options.sleep ?? realSleep,
      idleMs: options.idleMs ?? 45_000,
      stableMs: options.stableMs ?? 5_000,
      pageSize: options.pageSize ?? 200,
      resyncJitterMs: options.resyncJitterMs ?? 1_500,
    };
  }

  subscribe = (fn: () => void): (() => void) => {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  };

  getSnapshot = (): FeedState => this.#state;

  #set(patch: Partial<FeedState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const fn of this.#listeners) fn();
  }

  start(): void {
    if (this.#ac) return;
    const ac = new AbortController();
    this.#ac = ac;
    void this.#run(ac.signal);
  }

  stop(): void {
    this.#ac?.abort();
    this.#ac = null;
  }

  /** 往上翻：取比已加载的最老一条更老的一页。 */
  async loadOlder(): Promise<void> {
    const oldest = this.#state.events[0];
    if (!oldest || !this.#state.hasOlder) return;
    const page = await getJson<HistoryPage>(
      historyUrl(this.#o.base, this.sessionId, { before: oldest.id, limit: this.#o.pageSize }),
      undefined,
      this.#o.fetchImpl,
    );
    this.#set({ events: mergeEvents(this.#state.events, page.events), hasOlder: page.hasMore });
  }

  async #loadTail(signal: AbortSignal): Promise<void> {
    const page = await getJson<HistoryPage>(
      historyUrl(this.#o.base, this.sessionId, { limit: this.#o.pageSize }),
      signal,
      this.#o.fetchImpl,
    );
    this.#cursor = Math.max(this.#cursor, page.head);
    this.#set({
      events: mergeEvents(this.#state.events, page.events),
      hasOlder: this.#hasOlderAfterTail(page),
    });
    this.#loaded = true;
  }

  #hasOlderAfterTail(page: HistoryPage): boolean {
    // 已经往上翻过的不要因为重连把「还有更老的」标记洗成 false
    const oldestKept = this.#state.events[0];
    const oldestNew = page.events[0];
    if (oldestKept && oldestNew && oldestKept.id < oldestNew.id) return this.#state.hasOlder;
    return page.hasMore;
  }

  async #run(signal: AbortSignal): Promise<void> {
    let attempt = 0;
    while (!signal.aborted) {
      let stable = false;
      try {
        if (!this.#loaded) await this.#loadTail(signal);
        const r = await this.#stream(signal, () => {
          stable = true;
        });
        if (signal.aborted) return;
        if (r === 'resync') {
          // 补不全：整页重取。先随机等一会儿，几个标签页同时 resync 不会同一刻一起重取。
          this.#set({ resyncs: this.#state.resyncs + 1, status: 'loading', retryInMs: null });
          this.#loaded = false;
          this.#set({ events: [], hasOlder: false });
          this.#cursor = 0;
          await this.#o.sleep(Math.round(this.#o.rng() * this.#o.resyncJitterMs), signal);
          attempt = 0;
          continue;
        }
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof FatalApiError) {
          this.#set({ status: 'failed', error: err.message, errorStatus: err.status, retryInMs: null });
          return;
        }
      }
      if (signal.aborted) return;
      attempt = stable ? 1 : attempt + 1;
      const wait = reconnectDelay(attempt, this.#o.rng);
      this.#set({ status: 'reconnecting', attempt, retryInMs: wait });
      await this.#o.sleep(wait, signal);
    }
  }

  async #stream(signal: AbortSignal, onStable: () => void): Promise<Outcome> {
    const inner = new AbortController();
    const onOuter = () => inner.abort();
    signal.addEventListener('abort', onOuter);
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let stableTimer: ReturnType<typeof setTimeout> | undefined;
    const kick = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => inner.abort(), this.#o.idleMs);
    };
    try {
      kick();
      const res = await this.#o.fetchImpl(eventsUrl(this.#o.base, this.sessionId), {
        headers: { accept: 'text/event-stream', 'Last-Event-ID': String(this.#cursor) },
        signal: inner.signal,
      });
      if (!res.ok || !res.body) {
        if (isFatalStatus(res.status)) throw new FatalApiError(res.status, explainStatus(res.status));
        throw new Error(`HTTP ${res.status}`);
      }
      this.#set({ status: 'live', retryInMs: null });
      stableTimer = setTimeout(() => {
        onStable();
        this.#set({ attempt: 0 });
      }, this.#o.stableMs);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      const parser = new SseParser();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return 'ended';
        kick();
        const { frames } = parser.push(dec.decode(value, { stream: true }));
        const batch: FeedEvent[] = [];
        for (const f of frames) {
          if (f.event === 'resync') {
            await reader.cancel().catch(() => undefined);
            return 'resync';
          }
          if (f.event === 'ready' || f.event === undefined) continue;
          const id = Number(f.id);
          if (!Number.isSafeInteger(id)) continue;
          let body: { seq?: number; payload?: Record<string, unknown>; createdAt?: string };
          try {
            body = JSON.parse(f.data);
          } catch {
            continue;
          }
          batch.push({
            id,
            seq: body.seq ?? 0,
            type: f.event,
            payload: body.payload ?? {},
            createdAt: body.createdAt ?? new Date().toISOString(),
          });
          this.#cursor = Math.max(this.#cursor, id);
        }
        if (batch.length > 0) this.#set({ events: mergeEvents(this.#state.events, batch) });
      }
    } finally {
      clearTimeout(idleTimer);
      clearTimeout(stableTimer);
      signal.removeEventListener('abort', onOuter);
      inner.abort();
    }
  }
}
