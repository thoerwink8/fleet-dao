// 优雅停机：发布每次切版本都会重启这个进程（deploy/release.sh 的 systemctl restart）。改这里之前必须知道顺序为什么
// 是这样——先停接新连接（server 都 close；装了 fleet-api.socket 的话，端口这时候还在 systemd 手里排着队，
// 不算丢请求，见 listen.ts）、立刻收掉 SSE（它不会自己结束；不收的话每次都等满上限，排队的 /healthz 跟着挂住，#2186）、
// 再给普通请求一个有限的窗口把手上的活做完（这期间的响应带
// `Connection: close`，nginx 那头的 keep-alive 连接不会又把下一个请求派到这个快退出的进程上）、时间到了不管三七
// 二十一收掉剩下的连接、最后才去关变更推送、Temporal、数据库——关早了在途的请求会看见
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
  /** 在途的普通请求等它们做完的上限；到点了不管做完没做完，直接收掉剩下的连接。 */
  drainMs: number;
  /**
   * 收掉不会自己结束的长连接（SSE）。停接新连接后立刻叫：不收的话排空总要等满 drainMs，这段时间端口在 systemd 手里
   * 排队、没人 accept，/healthz 连得上却挂着（#2186）。收完它们的连接变空闲，下面按 IDLE_SWEEP_MS 一轮轮关掉。
   */
  endStreams?: () => void;
  /** 停变更推送、Temporal、关库。放在最后——关早了在途请求会看见「库关着」这种和真故障分不清的错误。 */
  close: () => Promise<void>;
  /** close() 失败时喊一声（数据没救了，多等也没用，照样往下退出）。 */
  onCloseError?: (err: unknown) => void;
}

/** 排空期间每隔这么久关一轮空闲连接：请求做完、SSE 收了场的 keep-alive 连接不会自己断，server.close 只在开头关过一次。 */
export const IDLE_SWEEP_MS = 50;

export async function gracefulShutdown(options: GracefulShutdownOptions): Promise<void> {
  const { servers, drainMs, endStreams, close, onCloseError } = options;
  const drained = Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  endStreams?.();
  const sweepIdle = () => {
    for (const server of servers) server.closeIdleConnections?.();
  };
  sweepIdle();
  const sweep = setInterval(sweepIdle, IDLE_SWEEP_MS);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([drained, new Promise((resolve) => (deadline = setTimeout(resolve, drainMs)))]);
  clearInterval(sweep);
  clearTimeout(deadline);
  for (const server of servers) server.closeAllConnections?.();
  try {
    await close();
  } catch (err) {
    onCloseError?.(err);
  }
}
