// 后端挂掉时读页不能按平时的间隔一直打：拿到网关错误或连不上之后，下一次轮询按指数拉长，最长 60 秒；
// 一次成功立刻回到这次查询自己的原间隔。401 和业务错误不参与，间隔保持原样。
//
// 不借用 React Query 的 fetchFailureCount：那是「这一次 fetch」的计数，下一次轮询一开始就被清零，连续失败堆不起来。
// errorUpdateCount 又只增不减，成功之后不会回到 0。所以按查询对象自己记连续的网关失败次数。
// 记的这一下是幂等的：同一次失败（errorUpdateCount 没变）重复算间隔不会再加一，严格模式双渲染也不会翻倍。

/** 退避的上限。原间隔已经不短于这个数就保持原间隔，不缩短。 */
export const POLL_BACKOFF_MAX_MS = 60_000;

export interface PollQuery {
  state: {
    error: unknown;
    errorUpdateCount: number;
    status: string;
  };
}

const streaks = new WeakMap<object, { seen: number; streak: number }>();

/** 502 / 503 / 504，以及根本没拿到 HTTP 响应（断网、客户端把连接掐了）。 */
export function isGatewayError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; status?: unknown; code?: unknown };
  if (e.name !== 'ApiError' || typeof e.status !== 'number') return false;
  if (e.status === 502 || e.status === 503 || e.status === 504) return true;
  return e.status === 0 && (e.code === 'network' || e.code === 'timeout');
}

/**
 * 和根上原来的 `retry: 1` 一样：failureCount 从 0 起，只有第一次失败才再试。
 * 网关错误不再紧接着再打一次——那一下往往要等到网关超时才失败，紧接着再打只会把挂掉的后端再砸一遍。
 */
export function retryUnlessGateway(failureCount: number, err: unknown): boolean {
  return failureCount < 1 && !isGatewayError(err);
}

/**
 * 连续 gatewayFailures 次网关失败之后的间隔：base×2、×4、×8…封顶 60 秒。
 * 0 次就是 base。base 已经不短于 60 秒就保持 base。
 */
export function backedOffPollMs(baseMs: number, gatewayFailures: number): number {
  if (gatewayFailures <= 0 || baseMs >= POLL_BACKOFF_MAX_MS) return baseMs;
  return Math.min(POLL_BACKOFF_MAX_MS, baseMs * 2 ** gatewayFailures);
}

function noteGatewayStreak(query: PollQuery): number {
  const { error, errorUpdateCount, status } = query.state;
  let rec = streaks.get(query);
  if (!rec) {
    rec = { seen: -1, streak: 0 };
    streaks.set(query, rec);
  }
  if (errorUpdateCount !== rec.seen) {
    rec.seen = errorUpdateCount;
    rec.streak = isGatewayError(error) ? rec.streak + 1 : 0;
  } else if (status === 'success' || (error != null && !isGatewayError(error))) {
    // 成功，或这一次是别的错误：连续网关失败断了。进行中的下一次读取会先把 error 清掉、状态变成 pending，
    // 那种不算成功，计数留着，免得请求还在飞就把间隔缩回去。
    rec.streak = 0;
  }
  return rec.streak;
}

/** 没有连续的网关失败就返回 base；有的话拉长。 */
export function gatewayPollInterval(baseMs: number, query: PollQuery): number {
  const streak = noteGatewayStreak(query);
  if (streak <= 0) return baseMs;
  return backedOffPollMs(baseMs, streak);
}

const byBase = new Map<number, (query: PollQuery) => number>();

function intervalFor(baseMs: number): (query: PollQuery) => number {
  let fn = byBase.get(baseMs);
  if (!fn) {
    fn = (query) => gatewayPollInterval(baseMs, query);
    byBase.set(baseMs, fn);
  }
  return fn;
}

/**
 * 把查询上写的 refetchInterval（数字或函数）收成带退避的函数。
 * 同一个数字始终返回同一个函数：推送状态没变时解析出来的毫秒数也不变，定时器不会被清掉重排。
 * false 和空保持原样（会话记录失败后停轮询就是返回 false）。
 */
export function wrapRefetchInterval<T>(interval: T): T {
  if (interval == null || interval === false) return interval;
  if (typeof interval === 'number') return intervalFor(interval) as T;
  if (typeof interval === 'function') {
    const inner = interval as (query: PollQuery) => number | false | undefined;
    return ((query: PollQuery) => {
      const base = inner(query);
      if (typeof base !== 'number') return base;
      return gatewayPollInterval(base, query);
    }) as T;
  }
  return interval;
}
