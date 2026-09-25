// 照 postgres.js 的 LISTEN 行为做的替身（postgres 包 src/index.js 的 listen），给 changes.ts 的测试用：
// - listen 先把监听挂上，再发 LISTEN。库连不上时 promise 失败，但监听还挂着；库回来时它自己重连。
// - 同一个频道再调一次 listen，就多挂一个监听：之后每条通知送好几遍。
// - 连接断了不告诉调用方；断开期间的通知丢了。
// - 连接断一次，postgres.js 就给每个监听重排一条 LISTEN；之后每次重连失败再多排一条（onclose 里重新 listen，
//   排着的不作废）。库回来时这些 LISTEN 逐条执行，每条都调一次 onListen——停得越久，恢复时 onListen 调得越多
//   （审查在真 Postgres 17 上看库日志证实：停 20 秒恢复时 4 条，停 120 秒 8 条）。
import type { PgListen } from '@fleet-dao/db';
import type { PgNotify } from '../src/changes.ts';

interface Listener {
  fn: (payload: string) => void;
  onListen: () => void;
  /** 排着、还没执行的 LISTEN 条数。 */
  queued: number;
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

  const all = () => [...channels.values()].flat();
  const deliver = (channel: string, payload: string) => {
    if (!listenUp || !delivering) return;
    for (const l of [...(channels.get(channel) ?? [])]) l.fn(payload);
  };
  /** LISTEN 连接断了：每个监听重排一条 LISTEN。 */
  const dropListen = () => {
    if (listenUp) for (const l of all()) l.queued += 1;
    listenUp = false;
  };

  const listen: PgListen = async (channel, fn, onListen) => {
    listenCalls += 1;
    const listener: Listener = { fn, onListen, queued: 0 };
    channels.set(channel, [...(channels.get(channel) ?? []), listener]);
    await Promise.resolve();
    if (!listenUp) {
      // 这一条失败了，连接关掉时 postgres.js 又给它排了一条。
      listener.queued = 1;
      throw new Error('connect ECONNREFUSED');
    }
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
      dropListen();
    },
    /** 只有 LISTEN 那条连接断了：通知发得出去，收不到。 */
    dropListenConnection() {
      dropListen();
    },
    /** 还没恢复时又重连失败了 times 次：每次给每个监听多排一条 LISTEN。 */
    failReconnects(times: number) {
      if (listenUp) throw new Error('连接没断，谈不上重连失败');
      for (const l of all()) l.queued += times;
    },
    /** 库回来了：查询照常；LISTEN 连接重连上，排着的 LISTEN 逐条执行，每条调一次 onListen。 */
    startDb() {
      queriesUp = true;
      listenUp = true;
      for (const l of all()) {
        const times = l.queued;
        l.queued = 0;
        for (let i = 0; i < times; i++) l.onListen();
      }
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
