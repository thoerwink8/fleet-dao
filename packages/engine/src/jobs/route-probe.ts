// 路由探针（#129，design 第九节「路由探针」）：一轮 = 记下开始 → 读全部路由 → 逐条定探不探 → 该探的真起一次最小会话
// → 每条写一条结论（只有 ok 在线，其余一律不在线、写明原因）→ 结局记进 schedule_runs。
// scanned = 这一轮写下结论的路由条数，found = 其中不在线的条数（驾驶舱「定时任务」页和调度台的在线数对得上）。
// 没跑成、一条都没写进去、只写进去一部分，照实记 failed / unscanned / partial，不记成 ok（没跑成 ≠ 没问题）。
import type { RouteProbeTarget, ScheduleResult } from '@fleet-dao/db';
import {
  type HostId,
  type OrgKind,
  ROUTE_PROBE_EVERY_MINUTES,
  type RouteProbeState,
} from '@fleet-dao/shared';
import type { RouteProbeRun } from '../contract.ts';
import { hostName, ORG_NAMES } from '../routing/names.ts';
import type { ScheduleRunLog } from './github-reconcile.ts';

/** 登记进 scheduled_jobs 的那一行：一次都没跑过也列得出来。 */
export const ROUTE_PROBE_JOB = {
  id: 'route-probe',
  name: '路由探针',
  schedule: '每 15 分钟（每小时 7、22、37、52 分）',
  // 连着三轮没跑成才算过期：一轮探一次 Claude 最长要几分钟，偶尔一轮慢不报。
  expectEveryMinutes: 45,
} as const;

export { ROUTE_PROBE_EVERY_MINUTES };
/** 和对账补漏（整点起每 15 分钟）错开几分钟跑：两样都在整点挤着连库、连 GitHub、起会话。 */
export const ROUTE_PROBE_OFFSET_MINUTES = 7;
/** 没探通、又不是要人修的整池问题：隔这么久在同一轮里再探一次，一次网络抖动不让路由下线。 */
export const ROUTE_PROBE_RETRY_DELAY_MS = 20_000;
/** 同时探几条（每条是一个真会话，占内存）。 */
export const ROUTE_PROBE_CONCURRENCY = 2;
/** 写进库的原因最长多少字：插头的报错原文可能很长，驾驶舱只要能看懂的那一截。 */
export const ROUTE_PROBE_DETAIL_MAX = 600;

export type ProbeTarget = RouteProbeTarget;

/**
 * 真探一次的结果。answered = 答上了；quota = 额度用满被拒——登录、组织、上游都通，额度另有额度那一套挡（选路按额度
 * 等清零），不当成离线（离线在选路里是硬挡，任务会挂起等人点「继续」）；failed = 没探通。
 */
export type ProbeAttempt =
  | { kind: 'answered'; detail: string }
  | { kind: 'quota'; detail: string }
  | {
      kind: 'failed';
      detail: string;
      /** 要人修的整池问题（登录失效、设备被撤销、封号、欠费）：同一轮里不再试，整池暂停、推「要人拍」。 */
      poolHold?: { title: string; body: string };
    };

/** 一种执行方式的探法：起一次最小会话、问一句。不许抛——抛了按「探针自己出错」记成没探通。 */
export type Prober = (target: ProbeTarget) => Promise<ProbeAttempt>;

export interface RouteProbeJobDeps {
  /** 全部路由和探得了探不了的事实（真实现是 @fleet-dao/db 的 routeProbeTargets）。 */
  targets(): Promise<ProbeTarget[]>;
  /** 执行方式 → 探法；没有的执行方式 = 引擎还没接这种插头。 */
  probers: Partial<Record<HostId, Prober>>;
  /** 会话用户此刻挂的组织（store-ports.ts 的 SESSION_USER_ORG；切号 #59 接上后读真实状态）。 */
  liveOrg: OrgKind;
  /** 写一条结论（真实现是 saveRouteProbe）；路由这一轮当中被删了回 route_not_found。 */
  save(write: {
    routeId: string;
    state: RouteProbeState;
    at: Date;
    detail: string;
  }): Promise<'saved' | 'route_not_found'>;
  /** 一条路由真探完（写库之前）：真实现里接整池暂停的报警和撤销。抛了只记日志，不改结论。 */
  afterProbe?(target: ProbeTarget, attempt: ProbeAttempt): Promise<void>;
  runs: ScheduleRunLog;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
  retryDelayMs?: number;
  concurrency?: number;
}

/** 这一轮没跑成（读不到路由、一条都没写进去）：结局已经记进 schedule_runs，活动照样报失败，Temporal 里也看得见。 */
export class RouteProbeFailedError extends Error {
  readonly runId: number;
  constructor(runId: number, message: string) {
    super(message);
    this.name = 'RouteProbeFailedError';
    this.runId = runId;
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const clip = (text: string, max = ROUTE_PROBE_DETAIL_MAX) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

export type ProbePlan = { probe: Prober } | { state: 'not_wired' | 'skipped'; detail: string };

/**
 * 这条路由这一轮探不探。先后就是优先级：按量计费 → 插头没接 → 渠道下架 → 模型下架 → 没有阶段在用 → 会话用户挂着别的组织。
 * 按量计费排第一：不管插头接没接都不探（判断阶段的 Jev 就是按量的，它不经会话插头，说「派不了」反而误导）。
 * 不探的一律不在线（写明原因）；要探的交给这种执行方式的探法。
 */
export function planProbe(
  t: ProbeTarget,
  probers: Partial<Record<HostId, Prober>>,
  liveOrg: OrgKind,
  now: Date,
): ProbePlan {
  if (t.billing === 'metered') {
    return {
      state: 'skipped',
      detail: '按量计费的渠道不自动探：探一次就多一笔账（design 第三节第 21 条）',
    };
  }
  const probe = probers[t.hostId];
  if (!probe) {
    return {
      state: 'not_wired',
      detail: `执行方式「${hostName(t.hostId)}」的插头引擎还没接（现在只接了 Claude Code）：探不了，派工也派不到它`,
    };
  }
  if (!t.channelEnabled) return { state: 'skipped', detail: `渠道「${t.channelName}」已下架，不探` };
  if (t.modelRetiredAt !== null && t.modelRetiredAt.getTime() <= now.getTime()) {
    return { state: 'skipped', detail: `模型「${t.modelName}」已下架，不探` };
  }
  if (!t.inUse) {
    return {
      state: 'skipped',
      detail: '没有哪个阶段在用这条路由（挂着但关着的不算），不花额度去探；哪个阶段用上它，下一轮就探',
    };
  }
  if (t.orgKind !== null && t.orgKind !== liveOrg) {
    const live = ORG_NAMES[liveOrg];
    return {
      state: 'skipped',
      detail: `会话用户现在挂的是${live}组织：这时探${ORG_NAMES[t.orgKind]}池，扣的是${live}的额度、探的也是${live}，不探（切号见 #59）`,
    };
  }
  return { probe };
}

async function attemptOf(probe: Prober, t: ProbeTarget): Promise<ProbeAttempt> {
  try {
    return await probe(t);
  } catch (err) {
    return { kind: 'failed', detail: `探针自己出错，没探成：${message(err)}` };
  }
}

interface Conclusion {
  target: ProbeTarget;
  state: RouteProbeState;
  detail: string;
  at: Date;
}

async function conclude(deps: RouteProbeJobDeps, t: ProbeTarget): Promise<Conclusion> {
  const plan = planProbe(t, deps.probers, deps.liveOrg, deps.now());
  if (!('probe' in plan)) return { target: t, state: plan.state, detail: plan.detail, at: deps.now() };
  let attempt = await attemptOf(plan.probe, t);
  if (attempt.kind === 'failed' && !attempt.poolHold) {
    const first = attempt.detail;
    deps.log('warn', '路由探针：第一次没探通，隔一会儿再探一次', { routeId: t.routeId, detail: first });
    await deps.sleep(deps.retryDelayMs ?? ROUTE_PROBE_RETRY_DELAY_MS);
    const second = await attemptOf(plan.probe, t);
    attempt =
      second.kind === 'failed'
        ? { ...second, detail: `连探两次都没通：${second.detail}（第一次：${first}）` }
        : { ...second, detail: `${second.detail}（第一次没通：${first}）` };
  }
  if (deps.afterProbe) {
    try {
      await deps.afterProbe(t, attempt);
    } catch (err) {
      deps.log('error', '路由探针：整池暂停的报警没写进库（结论照写）', {
        routeId: t.routeId,
        error: message(err),
      });
    }
  }
  return {
    target: t,
    state: attempt.kind === 'failed' ? 'failed' : 'ok',
    detail: clip(attempt.detail),
    at: deps.now(),
  };
}

/** 最多同时 n 个，结果按输入的顺序。 */
async function mapLimit<T, R>(items: readonly T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return out;
}

async function probeRound(deps: RouteProbeJobDeps): Promise<{ result: ScheduleResult; online: string[] }> {
  let targets: ProbeTarget[];
  try {
    targets = await deps.targets();
  } catch (err) {
    return { result: { outcome: 'failed', why: `读路由表没成：${message(err)}` }, online: [] };
  }
  if (targets.length === 0) {
    return {
      result: {
        outcome: 'unscanned',
        why: '库里一条路由都没有（目录还没装进库？见 docs/ops.md「目录配置」）',
      },
      online: [],
    };
  }
  const conclusions = await mapLimit(targets, deps.concurrency ?? ROUTE_PROBE_CONCURRENCY, (t) =>
    conclude(deps, t),
  );
  const online: string[] = [];
  const unsaved: string[] = [];
  const gone: string[] = [];
  let offline = 0;
  for (const c of conclusions) {
    let saved: 'saved' | 'route_not_found';
    try {
      saved = await deps.save({ routeId: c.target.routeId, state: c.state, at: c.at, detail: c.detail });
    } catch (err) {
      unsaved.push(`${c.target.routeId}：${message(err)}`);
      continue;
    }
    if (saved === 'route_not_found') {
      gone.push(c.target.routeId);
      continue;
    }
    if (c.state === 'ok') online.push(c.target.routeId);
    else offline += 1;
  }
  const written = online.length + offline;
  const goneNote = gone.length > 0 ? `；探的时候被删掉的路由：${gone.join('、')}` : '';
  if (written === 0) {
    return {
      result:
        unsaved.length > 0
          ? { outcome: 'failed', why: `一条结论都没写进库：${unsaved.join('；')}${goneNote}` }
          : { outcome: 'unscanned', why: `要探的路由这一轮当中都被删了${goneNote}` },
      online,
    };
  }
  if (unsaved.length > 0) {
    return {
      result: {
        outcome: 'partial',
        why: `${unsaved.length} 条路由的结论没写进库（它们还是上一轮的样子）：${unsaved.join('；')}${goneNote}`,
        scanned: written,
        found: offline,
      },
      online,
    };
  }
  return { result: { outcome: 'ok', scanned: written, found: offline }, online };
}

/**
 * 跑一轮。记开始就失败（库连不上、没登记）：原样抛出，这一轮在库里没有记录——登记表上它会变成过期，看门狗照样看得见。
 * 没跑成（读不到路由、一条都没写进去）：记成 failed 再抛 RouteProbeFailedError。记结局失败：原样抛出。
 */
export async function runRouteProbeJob(deps: RouteProbeJobDeps): Promise<RouteProbeRun> {
  const runId = await deps.runs.start(ROUTE_PROBE_JOB.id, deps.now());
  let round: { result: ScheduleResult; online: string[] };
  try {
    round = await probeRound(deps);
  } catch (err) {
    round = { result: { outcome: 'failed', why: `路由探针没跑成：${message(err)}` }, online: [] };
  }
  const { result } = round;
  await deps.runs.finish(runId, result, deps.now());
  const run: RouteProbeRun = {
    runId,
    outcome: result.outcome,
    scanned: result.outcome === 'unscanned' ? 0 : (result.scanned ?? 0),
    found: result.outcome === 'unscanned' ? 0 : (result.found ?? 0),
    online: round.online,
    ...('why' in result ? { why: result.why } : {}),
  };
  const fields = { runId, outcome: run.outcome, scanned: run.scanned, found: run.found, online: run.online };
  if (run.outcome === 'failed') {
    deps.log('error', '路由探针这一轮没跑成', { ...fields, why: run.why });
    throw new RouteProbeFailedError(runId, run.why ?? '路由探针没跑成');
  }
  if (run.outcome === 'ok') deps.log('info', '路由探针跑完了', fields);
  else deps.log('warn', '路由探针这一轮没探全', { ...fields, why: run.why });
  return run;
}
