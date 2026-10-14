// 优雅停机：发布每次切版本都会重启这个进程（deploy/release.sh 的 systemctl restart）。改这里之前必须知道顺序为什么
// 是这样——
// 1. 入口（boot.ts）先等停机前就已经在处理的请求做完（waitLegacy，上限 drainMs）。这段时间服务器继续 accept：
//    /healthz 照常答，别的新请求由 drainGate 立刻回「正在停」。装了 fleet-api.socket 时，一停 accept 内核仍会把
//    TCP 握完、HTTP 堆在队列里，外面看就是端口通、请求挂起——所以这段不能先 server.close()。
// 2. 再到 gracefulShutdown：这时才停接新连接（两个 server 都 close），给还粘着的连接一个短窗口，到点收掉
//    （SSE 这类不会自己结束），最后才去关变更推送、Temporal、数据库。关库早了，在途请求会看见「库关着」这种和
//    真实故障分不清的错误。fleet-api.service 的 TimeoutStopSec 要比两段加起来长，不然 systemd 会先 SIGKILL。
import type { Fetch } from './keep-alive.ts';

/** 停机前已经在处理的请求还剩几个。停机之后进来的不计（它们要么立刻 503，要么是 /healthz）。 */
export interface LegacyInflight {
  n: number;
}

const STOPPING_BODY = JSON.stringify({
  error: { code: 'stopping', message: '正在停，请再试一次' },
});

function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return new URL(url, 'http://127.0.0.1').pathname;
  }
}

/**
 * 套在正式处理外面：停机前的请求计入 legacy，做完减一。停机之后，/healthz 仍交给里面（探测要有应答），
 * 别的路径立刻 503，不进业务、不计 legacy。停机之后的响应补 Connection: close。
 */
export function drainGate(fetch: Fetch, stopping: () => boolean, legacy: LegacyInflight): Fetch {
  return async (request, env) => {
    const late = stopping();
    if (!late) legacy.n += 1;
    try {
      if (late && pathnameOf(request.url) !== '/healthz') {
        return new Response(STOPPING_BODY, {
          status: 503,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            connection: 'close',
          },
        });
      }
      const res = await fetch(request, env);
      if (!late || !(res instanceof Response)) return res;
      const headers = new Headers(res.headers);
      headers.set('connection', 'close');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    } finally {
      if (!late) legacy.n -= 1;
    }
  };
}

/** 等到停机前的请求都做完，或到了 drainMs。到点还有没做完的，调用方照样往下停。 */
export async function waitLegacy(legacy: LegacyInflight, drainMs: number): Promise<void> {
  const start = Date.now();
  while (legacy.n > 0 && Date.now() - start < drainMs) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

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
  /** 在途的普通请求等它们做完的上限；到点了不管做完没做完，直接收掉剩下的连接（SSE 这类不会自己结束）。 */
  drainMs: number;
  /** 停变更推送、Temporal、关库。放在最后——关早了在途请求会看见「库关着」这种和真故障分不清的错误。 */
  close: () => Promise<void>;
  /** close() 失败时喊一声（数据没救了，多等也没用，照样往下退出）。 */
  onCloseError?: (err: unknown) => void;
}

export async function gracefulShutdown(options: GracefulShutdownOptions): Promise<void> {
  const { servers, drainMs, close, onCloseError } = options;
  const drained = Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  for (const server of servers) server.closeIdleConnections?.();
  await Promise.race([drained, new Promise((resolve) => setTimeout(resolve, drainMs))]);
  for (const server of servers) server.closeAllConnections?.();
  try {
    await close();
  } catch (err) {
    onCloseError?.(err);
  }
}
