// 实时推送（SSE）：数据库一变，驾驶舱收到 change 事件（表名 + 主键）自己重拉；推送断过就收到 resync 全量重拉。
import { SSE_EVENTS } from '@fleet-dao/shared';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Deps } from './deps.ts';
import type { CockpitEnv } from './session.ts';

export function eventsHandler(deps: Deps) {
  return (c: Context<CockpitEnv>) => {
    // 让香港 nginx 别攒着不发。
    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (stream) => {
      const closed = new Promise<void>((resolve) => stream.onAbort(resolve));
      // 先订阅再发 ready：前端收到 ready 才全量拉一次，之后的变化一条不漏。
      const unsubscribe = deps.changes.subscribe((event) => {
        void stream.writeSSE(
          event.type === 'resync'
            ? { event: SSE_EVENTS.resync, data: '{}' }
            : { event: SSE_EVENTS.change, data: JSON.stringify({ table: event.table, id: event.id }) },
        );
      });
      const heartbeat = setInterval(() => void stream.write(': ping\n\n'), deps.config.sseHeartbeatMs);
      try {
        await stream.writeSSE({
          event: SSE_EVENTS.ready,
          data: JSON.stringify({ at: deps.now().toISOString() }),
        });
        await closed;
      } finally {
        clearInterval(heartbeat);
        unsubscribe();
      }
    });
  };
}
