// 派单前探测（#1409）：选路选出要派的那一条之后、起会话之前，上一次探通超过 5 分钟就用定时探针同一份 conclude 再探一次，
// 结论写回 routes 同一处。按量计费和 planProbe 写明不探的照旧不探、不改写，按上一次结论走：上一次不通就不派。
// 组织这会儿定不下来（unsettled）没有新结论：只有上一次探通才派，否则换下一条，不把路由写成不在线。
// 组织认不出是该探却探不了：这一轮当不通，同样不改写。探不通写成 failed（不在线），探通后由原来的恢复路径拉起来。
// 探通但结论写不进 routes：不能当通过去起会话（库里没有这一次的结论，5 分钟内不重复探也保不住），按不通换下一条。

import type { RouteProbeKind } from '@fleet-dao/db';
import type { ProbeCheck } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { LiveOrgReading } from '../routing/types.ts';
import type { ProbeAssignedResult } from '../task-contract.ts';
import {
  type Conclusion,
  conclude,
  DISPATCH_PROBE_FRESH_MS,
  type ProbeTarget,
  planProbe,
  type RouteProbeJobDeps,
} from './route-probe.ts';
import type { ProbeLock } from './route-probe-now.ts';

const NO_CAPTURE = {
  durationMs: null,
  requestText: null,
  responseText: null,
  check: null,
  kind: null,
} as const;

function pass(label: string, detail: string, probed: boolean): ProbeAssignedResult {
  return { kind: 'pass', label, detail, probed };
}

function fail(label: string, detail: string, counted: boolean): ProbeAssignedResult {
  return { kind: 'fail', label, detail, counted };
}

/** 上一次探通、并且距离现在不超过 5 分钟（含刚好 5 分钟）。时钟倒退、没探过、上次没通，都不算新鲜。 */
function freshOk(previous: ProbeTarget['previous'], now: Date): boolean {
  if (previous?.state !== 'ok') return false;
  const age = now.getTime() - previous.at.getTime();
  return age >= 0 && age <= DISPATCH_PROBE_FRESH_MS;
}

type Written = { kind: 'saved' } | { kind: 'route_not_found' } | { kind: 'write_failed'; error: string };

async function writeConclusion(
  deps: RouteProbeJobDeps,
  routeId: string,
  write: {
    state: Conclusion['state'];
    detail: string;
    at: Date;
    org: Conclusion['org'];
    durationMs: number | null;
    requestText: string | null;
    responseText: string | null;
    check?: ProbeCheck | null;
    kind?: RouteProbeKind | null;
  },
): Promise<Written> {
  try {
    const { kind, ...rest } = write;
    const saved = await deps.save({
      routeId,
      ...rest,
      ...(kind !== undefined && kind !== null ? { kind } : {}),
    });
    return saved === 'route_not_found' ? { kind: 'route_not_found' } : { kind: 'saved' };
  } catch (err) {
    return { kind: 'write_failed', error: errMessage(err) };
  }
}

function unwritten(detail: string, error: string): string {
  return `${detail}（这条结论没写进库，路由上还是上一次的样子：${error}）`;
}

/**
 * 这一轮不改写结论时能不能派。上一次是通才派。
 * requireOk：该探却没有新结论（组织定不下来）。还没有结论、或上一次不是通，都不起会话。
 * 按规矩不探（按量、放慢没到点、没接上、下架）：还没有结论不当成不通；上一次是 failed / skipped / not_wired 则不派。
 */
function followPrevious(
  label: string,
  previous: ProbeTarget['previous'],
  detail: string,
  requireOk: boolean,
): ProbeAssignedResult {
  if (previous?.state === 'ok') return pass(label, detail, false);
  if (!requireOk && previous === null) return pass(label, detail, false);
  const why =
    previous?.state === 'failed'
      ? `上一次结论是不通${previous.detail ? `：${previous.detail}` : ''}`
      : previous
        ? `上一次结论是${previous.state}，不是通`
        : '没有探通的上一次结论';
  return fail(label, `${detail}（${why}）`, false);
}

async function probeLocked(
  deps: RouteProbeJobDeps,
  input: { routeId: string; label: string },
): Promise<ProbeAssignedResult> {
  const targets = await deps.targets();
  const target = targets.find((item) => item.routeId === input.routeId);
  if (!target) return fail(input.label, '库里没有这条路由（可能刚被删了）', false);

  let live: LiveOrgReading | null = null;
  if (target.orgKind !== null) {
    try {
      live = await deps.sessionOrg();
    } catch (err) {
      live = { ok: false, why: `读会话用户挂的组织出错：${errMessage(err)}` };
    }
  }
  const now = deps.now();
  const plan = planProbe(target, deps.probers, live, now);
  if (!('probe' in plan)) {
    const detail = 'kept' in plan ? plan.kept : 'unsettled' in plan ? plan.unsettled : plan.detail;
    // 该探却探不了（组织认不出）：这一轮当不通，但不把一条可能还通的路由写成不在线
    if ('state' in plan && plan.state === 'failed') return fail(input.label, detail, false);
    // unsettled 没有新结论，只有上一次探通才派。其余是按规矩不探，按上一次结论走，不改写。
    return followPrevious(input.label, target.previous, detail, 'unsettled' in plan);
  }
  if (freshOk(target.previous, now)) {
    return pass(input.label, target.previous?.detail || '上一次探针结论还在 5 分钟内，不重复探', false);
  }

  let concluded: Conclusion;
  try {
    concluded = await conclude(deps, target);
  } catch (err) {
    const detail = `探针自己出错，没探成：${errMessage(err)}`;
    const written = await writeConclusion(deps, target.routeId, {
      state: 'failed',
      detail,
      at: deps.now(),
      org: null,
      ...NO_CAPTURE,
    });
    if (written.kind === 'route_not_found') return fail(input.label, '探的时候这条路由被删了', false);
    return fail(
      input.label,
      written.kind === 'write_failed' ? unwritten(detail, written.error) : detail,
      true,
    );
  }
  // conclude 会再读一次组织：中途变成不探或定不下来时，和上面同一条口径，不改写。
  if (concluded.kept || concluded.unsettled || (concluded.state !== 'ok' && concluded.state !== 'failed')) {
    return followPrevious(input.label, target.previous, concluded.detail, concluded.unsettled === true);
  }
  // 第二次才认不出组织：没真探，不写成不在线
  if (concluded.state === 'failed' && concluded.detail.startsWith('会话用户挂的组织认不出')) {
    return fail(input.label, concluded.detail, false);
  }

  const written = await writeConclusion(deps, target.routeId, concluded);
  if (written.kind === 'route_not_found') return fail(input.label, '探的时候这条路由被删了', false);
  // 结论没落进 routes 就不能当探通：5 分钟内不重复探靠的是库里这一条。写不进去按不通换下一条，不起会话。
  if (written.kind === 'write_failed') {
    return fail(input.label, unwritten(concluded.detail, written.error), true);
  }
  if (concluded.state === 'ok') return pass(input.label, concluded.detail, true);
  return fail(input.label, concluded.detail, true);
}

/** 当场探这一条。和定时探针、立即探测共用同一把锁，避免同一条路由同时起两个会话。targets 读不到原样抛。 */
export async function probeAssignedRoute(
  deps: RouteProbeJobDeps,
  lock: ProbeLock,
  input: { routeId: string; label: string },
): Promise<ProbeAssignedResult> {
  return lock.run(() => probeLocked(deps, input));
}
