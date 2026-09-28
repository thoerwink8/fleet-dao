// 两个监听支持 systemd socket activation（sd_listen_fds(3)）：装一个 `fleet-api.socket` 单元、重启服务时监听套接字
// 一直归 systemd 攥着，新连接排在内核队列里，不会被拒。这份代码只管进程这一侧「有 fd 就接、没有就自己 bind」，
// deploy 侧装 socket 单元、改 fleet-api.service 的 Requires/After 不在这个 PR 里（#364 的结果.md 里写了why：动这几个
// 文件会跟另一位工人正在做的引擎排空发布撞车，留给后续单，接的时候这份代码不用再改）——这几条分支目前不会被
// LISTEN_FDS 触发，是给那条后续单接好的口子，不是「已经生效」。改这里之前必须知道：
// - LISTEN_FDS 从 fd 3 开始连续排（sd_listen_fds(3) 的约定），读完要从 process.env 删掉 LISTEN_PID / LISTEN_FDS /
//   LISTEN_FDNAMES（同样是 sd_listen_fds 的 unset 语义），不然子进程会把这几个 fd 也当成「我也有监听套接字」接着用。
// - 一个 socket 单元里两个 ListenStream（驾驶舱接口、fleet 命令接口）的 fd，systemd 按声明顺序传，但
//   FileDescriptorName 对整个单元生效，两个监听分不清谁是谁——这里改成先听上、再拿 server.address() 和配置比地址，
//   不猜顺序、不靠名字。
// - 地址对不上、多一个、少一个、LISTEN_PID 不是自己、LISTEN_FDS 认不出，一律明确报错退出，不悄悄改口自己 bind：
//   那样会把「systemd 传错了」悄悄变成「端口被占用」之类的另一种故障，反而更难查。
// - 没有 LISTEN_FDS（本机开发、测试，或机器上还没装 fleet-api.socket 的生产）照旧自己 bind，这不算错误。
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAdaptorServer, type ServerType, serve } from '@hono/node-server';
import type { Listen } from './config.ts';
import { type Fetch, serveCockpit } from './keep-alive.ts';

export class ListenFdError extends Error {}

export interface ListenTarget {
  /** 只用在报错信息里，不参与匹配（匹配只看地址）。 */
  name: string;
  at: Listen;
  fetch: Fetch;
  /** 设了就在听上以后把这个监听的空闲超时设成它（驾驶舱接口要比香港 nginx 留得久，见 keep-alive.ts）。 */
  keepAliveMs?: number;
}

/**
 * sd_listen_fds(3) 的约定：没有 LISTEN_PID 就是没有走 socket activation（返回 null，调用方照旧自己 bind，这不是错误）；
 * LISTEN_PID 有但不是本进程、LISTEN_FDS 不是正整数，才是明确的配置错误——systemd 传了东西，却传得不对。
 * fd 号从 3 开始连续排 LISTEN_FDS 个。
 */
function listenFds(env: NodeJS.ProcessEnv): number[] | null {
  if (env.LISTEN_PID === undefined) return null;
  if (Number(env.LISTEN_PID) !== process.pid) {
    throw new ListenFdError(
      `LISTEN_PID=${env.LISTEN_PID} 不是本进程（pid ${process.pid}）：systemd 传的监听套接字不是给这个进程的`,
    );
  }
  const n = Number(env.LISTEN_FDS);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ListenFdError(`LISTEN_FDS「${env.LISTEN_FDS}」不是正整数：读不出 systemd 传了几个监听套接字`);
  }
  return Array.from({ length: n }, (_, i) => 3 + i);
}

/** sd_listen_fds 的 unset 语义：读完这几个变量就从环境里删掉，子进程不该把它们当成「我也有监听套接字」接着用。 */
function clearListenEnv(env: NodeJS.ProcessEnv): void {
  delete env.LISTEN_PID;
  delete env.LISTEN_FDS;
  delete env.LISTEN_FDNAMES;
}

const say = (a: { host: string; port: number }) => `${a.host}:${a.port}`;

/**
 * 几个已经听上的地址，按 host:port 和配置的几个目标一一对上号（谁先谁后不管，systemd 传 fd 的顺序不保证；见文件头的
 * 注释）。多出一个、缺一个、地址不是配置里认识的，都明确报错。返回：addresses 的第 i 项对应 targets 的第几项。
 */
export function matchListenTargets(
  addresses: readonly { host: string; port: number }[],
  targets: readonly { name: string; at: Listen }[],
): number[] {
  const remaining = new Set(targets.map((_, i) => i));
  const order: number[] = [];
  for (const addr of addresses) {
    const i = targets.findIndex((t) => t.at.host === addr.host && t.at.port === addr.port);
    if (i === -1) {
      throw new ListenFdError(
        `systemd 传的监听套接字里有一个在 ${say(addr)}，配置里没有认识的地址（要 ${targets
          .map((t) => `${t.name} ${say(t.at)}`)
          .join('、')}）`,
      );
    }
    if (!remaining.delete(i)) {
      throw new ListenFdError(
        `systemd 传了不止一个监听套接字在 ${say(addr)}（配置里的 ${targets[i]?.name} 只要一个）`,
      );
    }
    order.push(i);
  }
  if (remaining.size > 0) {
    const missing = [...remaining].map(
      (i) => `${targets[i]?.name} ${say(targets[i]?.at ?? { host: '', port: 0 })}`,
    );
    throw new ListenFdError(
      `systemd 没传监听套接字给：${missing.join('、')}（fleet-api.socket 要跟 fleet-api.service 读的配置一致）`,
    );
  }
  return order;
}

function addressOf(server: ServerType): { host: string; port: number } {
  const addr = server.address() as AddressInfo | string | null;
  if (addr === null || typeof addr === 'string') {
    throw new ListenFdError(`监听地址认不出（不是 TCP 地址：${addr === null ? '没听上' : addr}）`);
  }
  return { host: addr.address, port: addr.port };
}

/**
 * 在一个已经由 systemd 绑好、监听着的 fd 上起一个 http server。这一步还不知道这个 fd 对应哪个配置（要听上以后按地址
 * 才认得出，见 matchListenTargets），先用一个「还没决定发给谁」的转发函数占位——避免同一个 fd 听两次：Node 的
 * `listen({ fd })` 会把这个 fd 交给 libuv 的 handle 管，`close()` 一次这个 fd 就没了，systemd 传来的这一份不会再有第二次。
 */
function listenOnFd(fd: number): Promise<{ server: ServerType; setReal: (fetch: Fetch) => void }> {
  let real: Fetch | undefined;
  const dispatch: Fetch = (req, env) => {
    if (!real) throw new Error('fd 的监听地址还没和配置对上号，不该有请求进来（listen.ts 的 bug）');
    return real(req, env);
  };
  return new Promise((resolve, reject) => {
    const server = createAdaptorServer({ fetch: dispatch });
    const onError = (err: unknown) => reject(err instanceof Error ? err : new Error(String(err)));
    server.once('error', onError);
    server.once('listening', () => {
      server.off('error', onError);
      resolve({ server, setReal: (fetch) => (real = fetch) });
    });
    server.listen({ fd });
  });
}

/**
 * 起两个监听：systemd 传了监听套接字（LISTEN_PID / LISTEN_FDS）就用它们（发布重启时连接排队、不拒连，见
 * deploy/france/fleet-api.socket）；没传就照旧自己 bind（本机开发、测试，或机器上还没装 socket 单元的生产）。
 */
export async function startListeners(
  targets: readonly ListenTarget[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<ServerType[]> {
  const fds = listenFds(env);
  if (fds === null) {
    return targets.map((t) =>
      t.keepAliveMs !== undefined
        ? serveCockpit(t.fetch, t.at, t.keepAliveMs)
        : serve({ fetch: t.fetch, hostname: t.at.host, port: t.at.port }),
    );
  }
  if (fds.length !== targets.length) {
    clearListenEnv(env);
    throw new ListenFdError(
      `systemd 传了 ${fds.length} 个监听套接字，配置要 ${targets.length} 个（${targets.map((t) => t.name).join('、')}）`,
    );
  }
  clearListenEnv(env);
  const opened = await Promise.all(fds.map((fd) => listenOnFd(fd)));
  const order = matchListenTargets(
    opened.map(({ server }) => addressOf(server)),
    targets,
  );
  const bySlot: ServerType[] = new Array(targets.length);
  order.forEach((targetIndex, fdIndex) => {
    const target = targets[targetIndex];
    const slot = opened[fdIndex];
    if (!target || !slot) throw new ListenFdError('fd 和配置对号时下标越界（listen.ts 的 bug）');
    slot.setReal(target.fetch);
    if (target.keepAliveMs !== undefined) (slot.server as Server).keepAliveTimeout = target.keepAliveMs;
    bySlot[targetIndex] = slot.server;
  });
  return bySlot;
}
