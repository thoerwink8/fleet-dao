// 实时推送（SSE）：数据库一变，驾驶舱收到 change 事件（表名 + 主键）自己重拉；可能漏了就收到 resync 全量重拉。
// 断线重连不漏：每条事件带 id（`本进程轮次.序号`），最近的事件留在缓冲里；浏览器重连时（EventSource 自动带 Last-Event-ID）
// 补发断开期间的事件。补不全（后端重启过、断开太久挤出了缓冲、id 看不懂）就先发一条 resync，让前端全量重拉。
import { SSE_EVENTS } from '@fleet-dao/shared';
import type { Context } from 'hono';
import { type SSEMessage, streamSSE } from 'hono/streaming';
import type { Deps } from './deps.ts';
import type { ChangeFeed, FeedEvent } from './ports.ts';
import type { CockpitEnv } from './session.ts';
import { randomToken } from './tokens.ts';

export interface StampedEvent {
  /** SSE 的 id：`轮次.序号`。 */
  id: string;
  seq: number;
  event: FeedEvent;
}

export interface SseRelay {
  subscribe(listener: (event: StampedEvent) => void): () => void;
  /** 现在开着几条 SSE 连接。 */
  connections(): number;
  /** 最后一条事件的 id；还没有事件时是 `轮次.0`。 */
  latestId(): string;
  /** lastEventId 之后的事件（按顺序）；补不全就返回 null。 */
  since(lastEventId: string): StampedEvent[] | null;
}

/** 缓冲留最近这么多条；忙的时候大约是几分钟的变化，断开更久就走 resync。 */
const DEFAULT_BUFFER = 1000;

/** 整个进程一个：订阅一次数据变化，给每条盖上序号、留进缓冲，再分给各个浏览器连接。 */
export function createSseRelay(feed: ChangeFeed, options: { bufferSize?: number } = {}): SseRelay {
  const epoch = randomToken(6);
  const size = options.bufferSize ?? DEFAULT_BUFFER;
  const buffer: StampedEvent[] = [];
  const listeners = new Set<(event: StampedEvent) => void>();
  let seq = 0;
  feed.subscribe((event) => {
    seq += 1;
    const stamped = { id: `${epoch}.${seq}`, seq, event };
    buffer.push(stamped);
    if (buffer.length > size) buffer.shift();
    for (const listener of [...listeners]) listener(stamped);
  });
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    connections: () => listeners.size,
    latestId: () => `${epoch}.${seq}`,
    since(lastEventId) {
      const dot = lastEventId.lastIndexOf('.');
      const n = Number(lastEventId.slice(dot + 1));
      if (lastEventId.slice(0, dot) !== epoch || !Number.isInteger(n) || n < 0 || n > seq) return null;
      const oldest = buffer[0]?.seq ?? seq + 1;
      // n 之后的第一条（n+1）已经挤出缓冲：中间有补不回来的。
      if (n + 1 < oldest) return null;
      return buffer.filter((e) => e.seq > n);
    },
  };
}

function message(stamped: StampedEvent): SSEMessage {
  return stamped.event.type === 'resync'
    ? { event: SSE_EVENTS.resync, id: stamped.id, data: '{}' }
    : {
        event: SSE_EVENTS.change,
        id: stamped.id,
        data: JSON.stringify({ table: stamped.event.table, id: stamped.event.id }),
      };
}

export function eventsHandler(deps: Deps, relay: SseRelay) {
  return (c: Context<CockpitEnv>) => {
    // 让香港 nginx 别攒着不发。
    c.header('X-Accel-Buffering', 'no');
    const lastEventId = c.req.header('last-event-id');
    return streamSSE(c, async (stream) => {
      const closed = new Promise<void>((resolve) => stream.onAbort(resolve));
      // 所有写入排成一条链，按调用先后发出，补发的和新来的不会交错。
      let chain: Promise<unknown> = Promise.resolve();
      const send = (msg: SSEMessage) => {
        chain = chain.then(() => stream.writeSSE(msg)).catch(() => undefined);
      };
      const unsubscribe = relay.subscribe((stamped) => send(message(stamped)));
      // 订阅和算补发之间没有 await：这中间不会有新事件插进来，所以不漏也不重。
      if (lastEventId === undefined) {
        send({
          event: SSE_EVENTS.ready,
          id: relay.latestId(),
          data: JSON.stringify({ at: deps.now().toISOString() }),
        });
      } else {
        const replay = relay.since(lastEventId);
        if (replay === null) send({ event: SSE_EVENTS.resync, id: relay.latestId(), data: '{}' });
        else for (const stamped of replay) send(message(stamped));
      }
      const heartbeat = setInterval(() => {
        chain = chain.then(() => stream.write(': ping\n\n')).catch(() => undefined);
      }, deps.config.sseHeartbeatMs);
      try {
        await closed;
      } finally {
        clearInterval(heartbeat);
        unsubscribe();
      }
    });
  };
}
