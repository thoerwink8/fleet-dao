// 数据变化的来源：Postgres 的 LISTEN fleet_changes（载荷 {"table":…,"id":…}），在进程里分发给所有订阅者（SSE、等回答的 fleet ask）。
// 整个进程只占一条 LISTEN 连接，不是每个浏览器一条。
import { ChangeEventSchema } from '@fleet-dao/shared';
import { z } from 'zod';
import type { ChangeFeed, FeedEvent, Logger } from './ports.ts';

export const CHANGES_CHANNEL = 'fleet_changes';

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

/** 主键可能是数字（NEW.id 没转成文本），统一成字符串。 */
const Payload = ChangeEventSchema.extend({ id: z.union([z.string().min(1).max(200), z.number()]) });

export function parseChangePayload(raw: string): FeedEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = Payload.safeParse(json);
  return parsed.success ? { type: 'change', table: parsed.data.table, id: String(parsed.data.id) } : null;
}

/**
 * 驱动无关的 LISTEN：数据库包按所用驱动提供。形状照 postgres.js 的 `sql.listen(channel, onNotify, onListen)`：
 * 每次（重新）连上并 LISTEN 成功都调 onListen；断线期间的 NOTIFY 会丢。
 */
export type PgListen = (
  channel: string,
  onNotify: (payload: string) => void,
  onListen: () => void,
) => Promise<{ unlisten: () => Promise<void> }>;

/** 接上 LISTEN。第二次起的 onListen 说明断过线，广播 resync 让订阅方全量重拉——「漏收」不能装成「没变化」。 */
export async function startPgChangeFeed(
  listen: PgListen,
  log: Logger,
): Promise<ChangeFeed & { stop: () => Promise<void> }> {
  const hub = createChangeHub(log);
  let connects = 0;
  const handle = await listen(
    CHANGES_CHANNEL,
    (payload) => {
      const event = parseChangePayload(payload);
      if (event) hub.publish(event);
      else log.warn('看不懂的 fleet_changes 载荷，丢弃', { payload: payload.slice(0, 200) });
    },
    () => {
      connects += 1;
      if (connects > 1) {
        log.warn('LISTEN 重连了，通知前端全量重拉');
        hub.publish({ type: 'resync' });
      }
    },
  );
  return { subscribe: hub.subscribe, stop: () => handle.unlisten() };
}

/** fleet ask 阻塞等回答：数据变化或本进程里有人回答时叫醒等的人，醒了自己回库查。 */
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
    if (event.type === 'change') wake(event.id);
    else for (const id of [...waiting.keys()]) wake(id);
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
