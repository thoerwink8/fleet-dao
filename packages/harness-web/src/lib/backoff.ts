// 退避。两种场景两套规矩，都集中在这里：
// 1) 实时流断线重连：指数上限 + 抖动。多个标签页同时断线，各自的等待时间在 [下限, 上限] 里均匀随机，
//    不会在同一时刻一起撞回去（旧坑 G4 的风暴）；连续失败越多，上限越高，封顶 30 秒。
// 2) 列表轮询：后端挂了不要每个周期照打（旧坑 E5，#2282）：失败后间隔翻倍、封顶 60 秒，成功一次立刻恢复原间隔。

export const RECONNECT_FLOOR_MS = 250;
export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_CAP_MS = 30_000;

/** 第 attempt 次失败（从 1 数）之后等多久再连。rng 返回 [0,1)，测试里可以注入。 */
export function reconnectDelay(attempt: number, rng: () => number = Math.random): number {
  const exp = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt - 1));
  const ceil = Math.max(RECONNECT_FLOOR_MS, exp);
  return Math.round(RECONNECT_FLOOR_MS + rng() * (ceil - RECONNECT_FLOOR_MS));
}

export const POLL_CAP_MS = 60_000;

/** 轮询下一次隔多久：连续失败 failures 次后翻倍 failures 次，封顶 60 秒；成功（failures=0）就是原间隔。 */
export function pollInterval(baseMs: number, failures: number): number {
  return Math.min(POLL_CAP_MS, baseMs * 2 ** Math.max(0, failures));
}
