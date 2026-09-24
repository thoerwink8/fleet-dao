// 数据变化的来源：Postgres 的 LISTEN fleet_changes（频道名、会发通知的表、载荷形状都在 @fleet-dao/shared 的 realtime.ts），
// 在进程里分发给所有订阅者（SSE、等回答的 fleet ask）。整个进程只占一条 LISTEN 连接，不是每个浏览器一条。
import type { PgListen } from '@fleet-dao/db';
import { ChangeEventSchema, FLEET_CHANGES_CHANNEL } from '@fleet-dao/shared';
import type { ChangeFeed, FeedEvent, Logger } from './ports.ts';

export interface ChangeHub extends ChangeFeed {
  publish(event: FeedEvent): void;
}

export function createChangeHub(log?: Logger): ChangeHub {
  const listeners = new Set<(event: FeedEvent) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(event) {
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch (err) {
          log?.error('变化订阅者出错', { error: String(err) });
        }
      }
    },
  };
}

/** 载荷不对（不是 JSON、表不在 REALTIME_TABLES 里、缺 id）就返回 null。 */
export function parseChangePayload(raw: string): FeedEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = ChangeEventSchema.safeParse(json);
  return parsed.success ? { type: 'change', table: parsed.data.table, id: parsed.data.id } : null;
}

export interface PgChangeFeed extends ChangeFeed {
  /** 给健康检查：LISTEN 现在接没接上；没接上时带最近一次的错误（只进日志和本机，不对外）。 */
  status(): { listening: boolean; lastError?: string | undefined };
  stop(): Promise<void>;
}

const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/**
 * 接上 LISTEN fleet_changes，接不上就退避重试（库没起来时进程照样起，健康检查报红）。
 * 断过线（重连、或第一次接上之前失败过）接上后广播 resync：断线期间的变化已经丢了，订阅方要全量重拉——「漏收」不能装成「没变化」。
 */
export function startPgChangeFeed(
  listen: PgListen,
  log: Logger,
  options: { retryMinMs?: number; retryMaxMs?: number } = {},
): PgChangeFeed {
  const hub = createChangeHub(log);
  const minMs = options.retryMinMs ?? RETRY_MIN_MS;
  const maxMs = options.retryMaxMs ?? RETRY_MAX_MS;
  let handle: { unlisten: () => Promise<void> } | null = null;
  let listening = false;
  let stopped = false;
  let gap = false;
  let lastError: string | undefined;
  let delay = minMs;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onNotify = (payload: string) => {
    const event = parseChangePayload(payload);
    if (event) hub.publish(event);
    else log.warn('看不懂的 fleet_changes 载荷，丢弃', { payload: payload.slice(0, 200) });
  };
  const onListen = () => {
    if (gap) {
      log.warn('LISTEN fleet_changes 断过线又接上了，通知订阅方全量重拉');
      hub.publish({ type: 'resync' });
    }
    gap = true; // 之后再调 onListen 就是重连。
    listening = true;
    lastError = undefined;
    delay = minMs;
  };
  const connect = async () => {
    if (stopped) return;
    try {
      handle = await listen(FLEET_CHANGES_CHANNEL, onNotify, onListen);
      if (stopped) await handle.unlisten();
    } catch (err) {
      listening = false;
      gap = true;
      lastError = err instanceof Error ? err.message : String(err);
      log.error('LISTEN fleet_changes 没接上，稍后重试', { error: lastError, retryInMs: delay });
      timer = setTimeout(() => void connect(), delay);
      delay = Math.min(delay * 2, maxMs);
    }
  };
  void connect();

  return {
    subscribe: hub.subscribe,
    status: () => ({ listening, lastError }),
    async stop() {
      stopped = true;
      clearTimeout(timer);
      listening = false;
      await handle?.unlisten();
    },
  };
}

/** fleet ask 阻塞等回答：asks 表有变化（答上了）或本进程里有人回答时叫醒等的人，醒了自己回库查。 */
export interface AskWaiters {
  wake(askId: string): void;
  /** 被叫醒、到时间或请求中止，三者先到先返回。 */
  sleep(askId: string, ms: number, signal?: AbortSignal): Promise<void>;
}

export function createAskWaiters(changes: ChangeFeed): AskWaiters {
  const waiting = new Map<string, Set<() => void>>();
  const wake = (askId: string) => {
    for (const fn of [...(waiting.get(askId) ?? [])]) fn();
  };
  changes.subscribe((event) => {
    if (event.type === 'resync') for (const id of [...waiting.keys()]) wake(id);
    else if (event.table === 'asks') wake(event.id);
  });
  return {
    wake,
    sleep(askId, ms, signal) {
      return new Promise<void>((resolve) => {
        const set = waiting.get(askId) ?? new Set<() => void>();
        waiting.set(askId, set);
        const finish = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', finish);
          set.delete(finish);
          if (set.size === 0) waiting.delete(askId);
          resolve();
        };
        const timer = setTimeout(finish, ms);
        set.add(finish);
        signal?.addEventListener('abort', finish, { once: true });
        if (signal?.aborted) finish();
      });
    },
  };
}
