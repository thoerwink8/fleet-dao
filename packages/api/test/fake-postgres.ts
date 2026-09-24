// 照 postgres.js 的 LISTEN 行为做的替身（postgres 包 src/index.js 的 listen），给 changes.ts 的测试用：
// - listen 先把监听挂上，再发 LISTEN。库连不上时 promise 失败，但监听还挂着；库回来时它自己重连，给每个监听调一次 onListen。
// - 同一个频道再调一次 listen，就多挂一个监听：之后每条通知送好几遍，每次重连调好几次 onListen。
// - 连接断了不告诉调用方；断开期间的通知丢了。
import type { PgListen } from '@fleet-dao/db';
import type { PgNotify } from '../src/changes.ts';

interface Listener {
  fn: (payload: string) => void;
  onListen: () => void;
}

export function fakePostgres() {
  const channels = new Map<string, Listener[]>();
  /** 普通查询连接（发 NOTIFY 走这里）。 */
  let queriesUp = true;
  /** LISTEN 那条专用连接。 */
  let listenUp = true;
  /** 连接没断、只是通知暂时送不到（例如很卡）。 */
  let delivering = true;
  let listenCalls = 0;

  const deliver = (channel: string, payload: string) => {
    if (!listenUp || !delivering) return;
    for (const l of [...(channels.get(channel) ?? [])]) l.fn(payload);
  };

  const listen: PgListen = async (channel, fn, onListen) => {
    listenCalls += 1;
    const listener = { fn, onListen };
    channels.set(channel, [...(channels.get(channel) ?? []), listener]);
    await Promise.resolve();
    if (!listenUp) throw new Error('connect ECONNREFUSED');
    onListen();
    return {
      unlisten: async () => {
        channels.set(
          channel,
          (channels.get(channel) ?? []).filter((l) => l !== listener),
        );
      },
    };
  };

  const notify: PgNotify = async (channel, payload) => {
    if (!queriesUp) throw new Error('connect ECONNREFUSED');
    // 通知在提交之后才送到，不在 notify 返回之前。
    setTimeout(() => deliver(channel, payload), 0);
  };

  return {
    listen,
    notify,
    /** 库停了：查询和 LISTEN 两条连接都断。 */
    stopDb() {
      queriesUp = false;
      listenUp = false;
    },
    /** 库回来了：查询照常；LISTEN 连接自己重连，给还挂着的每个监听调一次 onListen。 */
    startDb() {
      queriesUp = true;
      listenUp = true;
      for (const list of channels.values()) for (const l of [...list]) l.onListen();
    },
    /** 只有 LISTEN 那条连接断了：通知发得出去，收不到。 */
    dropListenConnection() {
      listenUp = false;
    },
    setDelivering(on: boolean) {
      delivering = on;
    },
    /** 库里的触发器发了一条通知。 */
    fire(channel: string, payload: string) {
      if (queriesUp) deliver(channel, payload);
    },
    listeners: (channel: string) => channels.get(channel)?.length ?? 0,
    listenCalls: () => listenCalls,
  };
}
