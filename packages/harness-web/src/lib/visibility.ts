// 后台标签页释放实时流（#3818，照搬旧驾驶舱 #1746 的做法）：香港 443 不开 http2，浏览器对同一域名最多 6 条连接、所有标签页共用，
// 后台标签页占着 SSE 不放，前台的读取就要排队。页面隐藏满 10 秒就停掉流（SessionFeed 保留游标），回到前台再接着连：
// 带 Last-Event-ID 续，补不全服务端发 resync、整页重取，现成的路径。

export const HIDDEN_RELEASE_MS = 10_000;

interface Releasable {
  start(): void;
  stop(): void;
}

interface VisibilityDoc {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', fn: () => void): void;
  removeEventListener(type: 'visibilitychange', fn: () => void): void;
}

interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

/** 隐藏满 delayMs 就 stop，可见了就 start（start 对已经在跑的是空操作）。返回解除绑定的函数。 */
export function releaseWhenHidden(
  feed: Releasable,
  doc: VisibilityDoc,
  delayMs = HIDDEN_RELEASE_MS,
  timers: Timers = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id as never),
  },
): () => void {
  let timer: unknown;
  let armed = false;
  const disarm = () => {
    if (armed) timers.clearTimeout(timer);
    armed = false;
  };
  const arm = () => {
    if (armed) return;
    armed = true;
    timer = timers.setTimeout(() => {
      armed = false;
      feed.stop();
    }, delayMs);
  };
  const onChange = () => {
    if (doc.visibilityState === 'hidden') arm();
    else {
      disarm();
      feed.start();
    }
  };
  doc.addEventListener('visibilitychange', onChange);
  if (doc.visibilityState === 'hidden') arm();
  return () => {
    disarm();
    doc.removeEventListener('visibilitychange', onChange);
  };
}
