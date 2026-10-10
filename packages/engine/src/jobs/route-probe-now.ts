// 立即探测（驾驶舱改版，创始人 2026-10-07「渠道状态无法探测」）：驾驶舱上点「立即探测」记一条操作记录，引擎每几秒看一眼，
// 有没人接手的就接手（记 routing.probe.start）、照定时那一轮同一份探法探、写结论（routes 上那一条，和定时那一轮写的同一处），
// 探完把每条的结论记进 routing.probe.done。一次立即探测走到哪由 shared 的 foldRouteProbeRequests 现算，这里和驾驶舱用同一份。
// 改这里之前必须知道：
// - 和定时那一轮共用一把锁（routeProbeLock）：同一时刻引擎里最多一轮在探，不会同一条路由同时起两个会话；定时那一轮在跑，
//   立即探测先记「接手」，等它跑完再探（页面看得到已接手、在等）。
// - 人点的就真探：按一次的成本放慢、上一次探通还没到再探的时候（kept）、不通之后的退避，这里也照探
//   （节奏上把上一次当没有交给 planProbe；连着不通的次数还留着）。
//   没有用途在用的也真探（#1630：就是要在挂进用途之前先看它通不通）。
//   按量计费、整池暂停、插头没接、渠道或模型下架，照规矩不探，结论写明为什么（不是「通」）。
// - 不判切号：切号只在定时那一轮里判（jobs/org-switch.ts），立即探测只探。
// - 总开关关着也接（探针是看家检查，#1086：关着也要看到渠道通不通）。

import {
  foldRouteProbeRequests,
  ROUTE_PROBE_POLL_MS,
  ROUTE_PROBE_REQUEST_TTL_MS,
  type RouteProbeAuditRow,
  type RouteProbeResult,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import { type Conclusion, conclude, ROUTE_PROBE_CONCURRENCY, type RouteProbeJobDeps } from './route-probe.ts';

/** 同一时刻最多一轮在探：定时那一轮和立即探测排队用它。 */
export interface ProbeLock {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createProbeLock(): ProbeLock {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const result = tail.then(fn, fn);
      // 前一轮抛了不挡后一轮
      tail = result.catch(() => undefined);
      return result;
    },
  };
}

/** 引擎进程里只有一份（单实例，见 timers.ts 开头）：定时那一轮（engine-timers.ts）和立即探测都用它。 */
export const routeProbeLock = createProbeLock();

export interface RouteProbeNowDeps {
  /** since 之后 routing:probe 的操作记录（真实现 @fleet-dao/db 的 routeProbeAuditRows）。读不到抛。 */
  rows(since: Date): Promise<RouteProbeAuditRow[]>;
  /** 记「接手了」。写不进抛：没记上就不探（不然驾驶舱一直看到没人接手，引擎下一眼又接一次）。 */
  start(requestId: string, at: Date): Promise<void>;
  /** 记「探完了」；ok=false 必须带 error。 */
  done(
    input: { requestId: string; at: Date; results: RouteProbeResult[] } & (
      | { ok: true }
      | { ok: false; error: string }
    ),
  ): Promise<void>;
  /** 和定时那一轮同一份探法、同一份写库（real/route-probe.ts 的 routeProbeJob）。 */
  probe: () => RouteProbeJobDeps;
  lock: ProbeLock;
  now: () => Date;
  log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

async function eachLimit<T>(items: readonly T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
}

/** 一条路由这一次：探、写库、翻成给驾驶舱看的结论。不抛（写不进库的写进原文）。 */
async function probeOne(
  probe: RouteProbeJobDeps,
  target: Parameters<typeof conclude>[1],
  now: () => Date,
): Promise<RouteProbeResult> {
  const startedAt = now().getTime();
  // 人点的就真探：节奏上把上一次当没有（放慢、退避都不挡）。次数还留着，探完照旧往上加，不把退避清零。
  let c: Conclusion;
  try {
    c = await conclude(probe, target, { bypassPace: true });
  } catch (err) {
    return {
      routeId: target.routeId,
      outcome: 'failed',
      detail: `探针自己出错，没探成：${errMessage(err)}`,
      at: now().toISOString(),
    };
  }
  const durationMs = Math.max(0, now().getTime() - startedAt);
  const timed = c.state === 'ok' || c.state === 'failed' ? { durationMs } : {};
  if (c.unsettled) {
    return { routeId: target.routeId, outcome: 'unsettled', detail: c.detail, at: c.at.toISOString() };
  }
  // 和定时那一轮同一份写法：结论里除了这三样，余下的字段原样交给 save（探针结论以后多了字段，这里不用跟着改）
  const { target: _t, kept: _k, unsettled: _u, backingOff: _b, onDemand: _o, ...rest } = c;
  try {
    const saved = await probe.save({ routeId: target.routeId, ...rest });
    if (saved === 'route_not_found') {
      return {
        routeId: target.routeId,
        outcome: 'gone',
        detail: '探的时候这条路由被删了',
        at: c.at.toISOString(),
      };
    }
  } catch (err) {
    return {
      routeId: target.routeId,
      outcome: c.state,
      detail: `${c.detail}（这条结论没写进库，路由上还是上一次的样子：${errMessage(err)}）`,
      at: c.at.toISOString(),
      ...timed,
    };
  }
  return { routeId: target.routeId, outcome: c.state, detail: c.detail, at: c.at.toISOString(), ...timed };
}

/**
 * 看一眼：有没人接手的立即探测就接手、探、回结论。返回这一眼接手了几次。
 * 读操作记录读不到原样抛（调用方记日志，下一眼再看）；一次的「接手」记不上也抛，不探。
 */
export async function runRouteProbeRequests(deps: RouteProbeNowDeps): Promise<number> {
  const now = deps.now();
  const { requests, unreadable } = foldRouteProbeRequests(
    await deps.rows(new Date(now.getTime() - ROUTE_PROBE_REQUEST_TTL_MS)),
    now,
  );
  if (unreadable > 0) deps.log('warn', '立即探测：有操作记录认不出', { unreadable });
  // 先点的先接
  const pending = requests.filter((r) => r.state === 'queued').reverse();
  if (pending.length === 0) return 0;
  for (const r of pending) await deps.start(r.requestId, deps.now());
  deps.log('info', '立即探测：接手', { requests: pending.map((r) => r.requestId) });

  await deps.lock.run(async () => {
    const probe = deps.probe();
    let targets: Awaited<ReturnType<RouteProbeJobDeps['targets']>>;
    try {
      targets = await probe.targets();
    } catch (err) {
      const error = `读路由表没成：${errMessage(err)}`;
      for (const r of pending) await finish(deps, { requestId: r.requestId, ok: false, error, results: [] });
      return;
    }
    const byId = new Map(targets.map((t) => [t.routeId, t]));
    const all = pending.some((r) => r.routeIds === undefined);
    const wanted = all
      ? targets.map((t) => t.routeId)
      : [...new Set(pending.flatMap((r) => r.routeIds ?? []))];
    const results = new Map<string, RouteProbeResult>();
    await eachLimit(
      wanted.filter((id) => byId.has(id)),
      probe.concurrency ?? ROUTE_PROBE_CONCURRENCY,
      async (id) => {
        results.set(id, await probeOne(probe, byId.get(id) as (typeof targets)[number], deps.now));
      },
    );
    for (const id of wanted) {
      if (!results.has(id)) {
        results.set(id, {
          routeId: id,
          outcome: 'gone',
          detail: '库里没有这条路由（可能刚被删了）',
          at: deps.now().toISOString(),
        });
      }
    }
    for (const r of pending) {
      const ids = r.routeIds ?? wanted;
      await finish(deps, {
        requestId: r.requestId,
        ok: true,
        results: ids.flatMap((id) => results.get(id) ?? []),
      });
    }
  });
  return pending.length;
}

async function finish(
  deps: RouteProbeNowDeps,
  input: { requestId: string; results: RouteProbeResult[] } & ({ ok: true } | { ok: false; error: string }),
): Promise<void> {
  try {
    await deps.done({ ...input, at: deps.now() });
  } catch (err) {
    // 结论已经写在路由上了，只是这一次的回执没记上：驾驶舱会在接手 20 分钟后把它标成没探成，记日志让人看得到
    deps.log('error', '立即探测：探完的回执没记进操作记录', {
      requestId: input.requestId,
      error: errMessage(err),
    });
  }
}

export interface RouteProbeNowPoller {
  /** 不再看新的；在探的那一次不等（会话由停机时的收尾一起收，没回执的驾驶舱过时自己标没探成）。 */
  stop(): void;
}

/** 每 everyMs 看一眼（上一眼还没完就跳过这一眼）。出错只记日志，下一眼照看。 */
export function startRouteProbeRequests(
  deps: () => RouteProbeNowDeps,
  options: { everyMs?: number } = {},
): RouteProbeNowPoller {
  let running: Promise<void> | null = null;
  let stopped = false;
  const tick = () => {
    if (stopped || running) return;
    const d = deps();
    running = runRouteProbeRequests(d)
      .then(() => undefined)
      .catch((err: unknown) => d.log('error', '立即探测：这一眼没看成', { error: errMessage(err) }))
      .finally(() => {
        running = null;
      });
  };
  const handle = setInterval(tick, options.everyMs ?? ROUTE_PROBE_POLL_MS);
  return {
    stop() {
      stopped = true;
      clearInterval(handle);
    },
  };
}
