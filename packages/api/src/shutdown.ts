// 优雅停机：发布每次切版本都会重启这个进程（deploy/release.sh 的 systemctl restart）。改这里之前必须知道顺序为什么
// 是这样——先停接新连接（两个 server 都 close；装了 fleet-api.socket 的话，端口这时候还在 systemd 手里排着队，
// 不算丢请求，见 listen.ts）、马上叫醒长轮询（飞书 outbox 那种等在数据库前面的请求，不然它们会撞上下一步正在关的库，
// #364 反复出现的「Failed query」500 就是这么来的）、再给普通请求一个有限的窗口把手上的活做完（这期间的响应带
// `Connection: close`，nginx 那头的 keep-alive 连接不会又把下一个请求派到这个快退出的进程上）、时间到了不管三七
// 二十一收掉剩下的连接（SSE 这类不会自己结束）、最后才去关变更推送、Temporal、数据库——关早了在途的请求会看见
// 「库关着」这种和真实故障分不清的错误。fleet-api.service 的 TimeoutStopSec 要比 drainMs 长，不然 systemd 会在
// 这套流程走完之前就 SIGKILL 掉进程。
import type { Fetch } from './keep-alive.ts';

/** 停机开始之后（stopping() 变真）的响应都补一个 Connection: close；停机之前原样放行，不碰响应。 */
export function closeConnectionWhenStopping(fetch: Fetch, stopping: () => boolean): Fetch {
  return async (request, env) => {
    const res = await fetch(request, env);
    if (!stopping() || !(res instanceof Response)) return res;
    const headers = new Headers(res.headers);
    headers.set('connection', 'close');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}

/** http.Server / http2.Server 都有这几个方法；只声明用得到的，方便测试传假对象。 */
export interface DrainableServer {
  close(callback: () => void): void;
  closeIdleConnections?(): void;
  closeAllConnections?(): void;
}

export interface GracefulShutdownOptions {
  servers: readonly DrainableServer[];
  /** 给长轮询发「要停了」：意图卡的长轮询马上醒、不再查库（deps.shutdownSignal，见 intent-routes.ts）。 */
  notifyLongPollers: () => void;
  /** 在途的普通请求等它们做完的上限；到点了不管做完没做完，直接收掉剩下的连接（SSE 这类不会自己结束）。 */
  drainMs: number;
  /** 停变更推送、Temporal、关库。放在最后——关早了在途请求会看见「库关着」这种和真故障分不清的错误。 */
  close: () => Promise<void>;
  /** close() 失败时喊一声（数据没救了，多等也没用，照样往下退出）。 */
  onCloseError?: (err: unknown) => void;
}

export async function gracefulShutdown(options: GracefulShutdownOptions): Promise<void> {
  const { servers, notifyLongPollers, drainMs, close, onCloseError } = options;
  const drained = Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  notifyLongPollers();
  for (const server of servers) server.closeIdleConnections?.();
  await Promise.race([drained, new Promise((resolve) => setTimeout(resolve, drainMs))]);
  for (const server of servers) server.closeAllConnections?.();
  try {
    await close();
  } catch (err) {
    onCloseError?.(err);
  }
}
