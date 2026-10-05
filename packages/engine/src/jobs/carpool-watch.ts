// 定时盯拼车额度给切号用（#194，方案 v2 4.1、4.4）：引擎的定时器每分钟起一轮，这一条自己按情况定「这一分钟真不真读接口」：
// 平时 5 分钟一次；紧的时候 1 分钟一次（挂着拼车且本人额度剩不到 25%、记着拼车用不了正等恢复、切回宽限中、离恢复时刻不到 15 分钟或
// 已经过了）；读失败按 1 → 2 → 5 分钟退避，不硬砸。读到了交给切号（real/org-switch.ts 的 now）当场判：被拒之后到点、切回、宽限到点
// 都靠它，不等 15 分钟一轮的路由探针。和额度表那个每 15 分钟的读额度（jobs/quota-read.ts）是两回事：那个写额度窗口给选路和驾驶舱看，
// 这个写切号账本（落库的最近几次接口读数）。
//
// 改这里之前必须知道：
// - 读不到、认不出明确失败（读数记成 ok:false 带原因，进账本），不当成「没事」：连着两次没读成报警（#76 同一个规矩），Key 失效、回包认不出
//   当场报；读成了自己撤。
// - 什么都不用判的时候（挂着拼车、没有恢复条件、没到点读）整轮不碰切号，不白起 reclaude org list。

import {
  type BurnEstimate,
  type BurnRead,
  estimateBurn,
  type OrgKind,
  type ScheduleOutcome,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { CarpoolWatchRun } from '../contract.ts';
import type { LiveOrgReading } from '../routing/types.ts';
import type { CarpoolApiRead } from './carpool-outage.ts';
import type { ScheduleRunLog } from './github-reconcile.ts';
import { lastOkRead, type OrgLedger } from './org-ledger.ts';
import type { OrgSwitchTrigger } from './org-switch.ts';

/** 登记进 scheduled_jobs 的那一行：一次都没跑过也列得出来。 */
export const CARPOOL_WATCH_JOB = {
  id: 'carpool-watch',
  name: '拼车额度盯读（切号用）',
  schedule: '每分钟（按情况 1～5 分钟真读一次接口）',
  // 每分钟一轮，连着 10 轮没跑成才算过期
  expectEveryMinutes: 10,
} as const;

export const CARPOOL_WATCH_EVERY_MINUTES = 1;

const MIN = 60_000;

export interface WatchPolicy {
  /** 平时多久读一次。 */
  baseMs: number;
  /** 紧的时候多久读一次。 */
  hotMs: number;
  /** 连着读失败后下一次等多久（第 1 次失败等第 1 档……封顶）。 */
  failBackoffMs: readonly number[];
  /** 挂着拼车、本人额度剩余比例低于这个算紧。 */
  hotRemaining: number;
  /** 离预计恢复时刻不到这么久（或已经过了）算紧。 */
  hotBeforeResetMs: number;
  /** 挂着拼车、照最近的烧速预计不到这么多分钟用满算紧（和「剩不到 25%」是或的关系，哪个先到算哪个）。 */
  hotBurnMinutes: number;
  /** 连着这么多次没读成才报警（Key 失效、回包认不出当场报）。 */
  alertAfterFailures: number;
}

/**
 * 读频率的全部阈值集中在这一处（创始人 2026-10-04：额度相关的线不许散落写死、要能配）。出处：方案 v2 4.1（specs/194-拼车自动切换/方案-v2.md）——
 * 平时 5 分钟、紧时 1 分钟、读失败 1 → 2 → 5 分钟退避（接口限流文档没写，按业界常规退避）、剩不到 25%、离恢复时刻不到 15 分钟、
 * 预计 20 分钟内用满（烧速的窗口和门槛在 shared 的 carpool-burn.ts，同样集中成 DEFAULT_BURN_POLICY）。
 * 调整只改这一处；要驾驶舱可配，沿用「设置键」那套（engine.soloPaused 同款）另起一单，目前这些数还是编译进去的默认值。
 */
export const DEFAULT_WATCH_POLICY: Readonly<WatchPolicy> = Object.freeze({
  baseMs: 5 * MIN,
  hotMs: 1 * MIN,
  failBackoffMs: [1 * MIN, 2 * MIN, 5 * MIN],
  hotRemaining: 0.25,
  hotBeforeResetMs: 15 * MIN,
  hotBurnMinutes: 20,
  alertAfterFailures: 2,
});

/** 末尾连着读失败几次。 */
export function trailingFailures(ledger: OrgLedger): number {
  let n = 0;
  for (let i = ledger.reads.length - 1; i >= 0; i--) {
    if (ledger.reads[i]?.ok) break;
    n += 1;
  }
  return n;
}

/** 连着失败 fails 次之后下一次要等多久（1 → 2 → 5 分钟，封顶）。fails 为 0 不退避。 */
export function backoffMsFor(fails: number, policy: WatchPolicy = DEFAULT_WATCH_POLICY): number {
  if (fails <= 0) return 0;
  return policy.failBackoffMs[Math.min(fails - 1, policy.failBackoffMs.length - 1)] ?? policy.baseMs;
}

/**
 * 现在是不是在退避期：末尾连着读失败，且最近一次失败离现在还没到退避的间隔。退避期里谁都不许再砸接口——定时盯读（readSchedule）、
 * 被拒当场判、切号前后各读一次（real/org-switch.ts）都看它；这时读不到按「读不到」办：不当拼车能用、也不当额度满。
 * 账本里的读数不按时间排好的不用管：withRead 入库时已按发请求的时刻排好。
 */
export function readBackoff(
  ledger: OrgLedger,
  now: Date,
  policy: WatchPolicy = DEFAULT_WATCH_POLICY,
): { active: false } | { active: true; until: Date; fails: number } {
  const fails = trailingFailures(ledger);
  const last = ledger.reads.at(-1);
  if (fails === 0 || !last) return { active: false };
  const until = new Date(last.requestedAt.getTime() + backoffMsFor(fails, policy));
  return now.getTime() < until.getTime() ? { active: true, until, fails } : { active: false };
}

/** 账本里最近这些读数转成烧速要的样本（读成了、有额度的才算）。 */
export function burnOfLedger(ledger: OrgLedger, now: Date): BurnEstimate {
  const samples: BurnRead[] = [];
  for (const r of ledger.reads) {
    if (!r.ok || !r.quota) continue;
    samples.push({
      requestedAt: r.requestedAt,
      serverDate: r.serverDate,
      ageSeconds: r.ageSeconds,
      usedUsd: r.quota.usedUsd,
      limitUsd: r.quota.limitUsd,
    });
  }
  return estimateBurn(samples, now);
}

/**
 * 这一分钟要不要真读接口，间隔是多少、为什么。live 读不到（认不出）按平时的节奏。
 * 紧：记着拼车用不了（正等恢复，或还没切走）、切回宽限中、挂着拼车且本人额度剩不到 25%、挂着独享且离恢复时刻不到 15 分钟或已过。
 * 连着读失败：按退避档（1 → 2 → 5 分钟），比紧的节奏优先——接口在抖，别硬砸。
 */
export function readSchedule(
  ledger: OrgLedger,
  live: LiveOrgReading,
  now: Date,
  policy: WatchPolicy = DEFAULT_WATCH_POLICY,
): { due: boolean; everyMs: number; why: string } {
  const last = ledger.reads.at(-1);
  const fails = trailingFailures(ledger);
  let everyMs = policy.baseMs;
  let why = '平时 5 分钟一次';
  if (fails > 0) {
    everyMs = backoffMsFor(fails, policy);
    why = `连着 ${fails} 次没读成，退避`;
  } else {
    const hot = hotReason(ledger, live, now, policy);
    if (hot) {
      everyMs = policy.hotMs;
      why = hot;
    }
  }
  const due = !last || now.getTime() - last.requestedAt.getTime() >= everyMs;
  return { due, everyMs, why };
}

function hotReason(ledger: OrgLedger, live: LiveOrgReading, now: Date, policy: WatchPolicy): string | null {
  if (ledger.outage) {
    const at = ledger.outage.resetsAt;
    if (live.ok && live.org === 'solo' && at && at.getTime() - now.getTime() > policy.hotBeforeResetMs) {
      return null;
    }
    return '记着拼车用不了，正等恢复（或还没切走）';
  }
  if (ledger.backPending) return '切回宽限中';
  if (live.ok && live.org === 'carpool') {
    const q = lastOkRead(ledger)?.quota;
    if (
      q &&
      Number.isFinite(q.limitUsd) &&
      q.limitUsd > 0 &&
      1 - q.usedUsd / q.limitUsd < policy.hotRemaining
    ) {
      return `本人额度剩不到 ${Math.round(policy.hotRemaining * 100)}%`;
    }
    // 剩得还多、可烧得快：照最近的烧速预计 20 分钟内用满也提到 1 分钟一次。算不出（读数少、间隔不合理、花费为负）不提，不拿猜的数定
    const burn = burnOfLedger(ledger, now);
    if (burn.state === 'known' && burn.minutesLeft !== null && burn.minutesLeft <= policy.hotBurnMinutes) {
      return `照现在的烧速约 ${Math.ceil(burn.minutesLeft)} 分钟后用满（不到 ${policy.hotBurnMinutes} 分钟）`;
    }
  }
  return null;
}

/** 切号要不要判一次：有读数、有记着的恢复条件、宽限中、或挂着独享（该看着什么时候切回）。挂着拼车且什么都没记着、没新读数就不用。 */
export function needsSwitchCheck(ledger: OrgLedger, live: LiveOrgReading, justRead: boolean): boolean {
  if (justRead || ledger.outage || ledger.backPending) return true;
  return live.ok && live.org === 'solo';
}

export interface CarpoolWatchDeps {
  /** 读账本；认不出抛（OrgLedgerError），这一轮记没跑成。 */
  loadLedger(): Promise<OrgLedger>;
  /** 会话用户此刻挂的组织（和选路、切号同一个读法）。不许抛。 */
  liveOrg(): Promise<LiveOrgReading>;
  /** 读一次开放接口。不许抛，读不到回 ok:false。 */
  read(): Promise<CarpoolApiRead>;
  /** 交给切号当场判（real/org-switch.ts 的 now）。不许抛。 */
  switchNow(trigger: OrgSwitchTrigger): Promise<OrgKind | null>;
  raise(alert: { key: string; title: string; body: string }): Promise<void>;
  resolve(key: string): Promise<void>;
  runs: ScheduleRunLog;
  now: () => Date;
  log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
  policy?: WatchPolicy;
}

export const carpoolApiAlertKey = () => 'carpool-api';

/** 这一轮没跑成（账本认不出、库读不了）：结局已记进 schedule_runs，活动照样报失败。 */
export class CarpoolWatchFailedError extends Error {
  readonly runId: number;
  constructor(runId: number, message: string) {
    super(message);
    this.name = 'CarpoolWatchFailedError';
    this.runId = runId;
  }
}

/** 这一次读失败要不要报：Key 失效、回包认不出当场报；别的连着 alertAfterFailures 次才报。 */
export function apiFailureAlert(
  read: Extract<CarpoolApiRead, { ok: false }>,
  failuresSoFar: number,
  policy: WatchPolicy,
): { title: string; body: string } | null {
  const immediate = read.code === 'auth' || read.code === 'bad_response';
  if (!immediate && failuresSoFar < policy.alertAfterFailures) return null;
  return {
    title: '拼车额度接口读不到（切号用）',
    body: `reclaude 开放接口这一次没读成（${read.code}）：${read.why}。${
      immediate ? '这种要人动手（换 Key、查回包格式），不会自己好。' : `连着 ${failuresSoFar} 次没读成了。`
    }读不到不当成「拼车能用」也不当成「拼车恢复了」：挂着拼车照用、靠被拒兜底，挂着独享不据此切回；读成了自己撤。`,
  };
}

async function round(
  deps: CarpoolWatchDeps,
): Promise<{ outcome: ScheduleOutcome; why?: string; found: number }> {
  const policy = deps.policy ?? DEFAULT_WATCH_POLICY;
  const ledger = await deps.loadLedger();
  const live = await deps.liveOrg();
  const now = deps.now();
  const sched = readSchedule(ledger, live, now, policy);
  let read: CarpoolApiRead | undefined;
  let found = 0;
  let problem: string | undefined;
  if (sched.due) {
    read = await deps.read();
    if (read.ok) {
      await deps.resolve(carpoolApiAlertKey());
    } else {
      const alert = apiFailureAlert(read, trailingFailures(ledger) + 1, policy);
      if (alert) {
        found = 1;
        await deps.raise({ key: carpoolApiAlertKey(), ...alert });
      }
      problem = `这一次没读成（${read.code}）：${read.why}`;
    }
  }
  // 读到了的（成不成）一律交给切号：读数要进账本（挂着拼车没记着什么也要存，下一次判用得上）；没读的只在有事要判时才叫
  if (needsSwitchCheck(ledger, live, read !== undefined)) {
    await deps.switchNow({ by: '定时读接口', ...(read ? { read } : {}) });
  }
  return problem ? { outcome: 'partial', why: problem, found } : { outcome: 'ok', found };
}

/** 跑一轮。账本认不出、库读不了：记成 failed 再抛 CarpoolWatchFailedError。 */
export async function runCarpoolWatchJob(deps: CarpoolWatchDeps): Promise<CarpoolWatchRun> {
  const runId = await deps.runs.start(CARPOOL_WATCH_JOB.id, deps.now());
  let r: Awaited<ReturnType<typeof round>>;
  try {
    r = await round(deps);
  } catch (err) {
    r = { outcome: 'failed', why: `拼车盯读没跑成：${errMessage(err)}`, found: 0 };
  }
  await deps.runs.finish(
    runId,
    r.outcome === 'ok'
      ? { outcome: 'ok', scanned: 1, found: r.found }
      : r.outcome === 'partial'
        ? { outcome: 'partial', why: r.why ?? '', scanned: 1, found: r.found }
        : { outcome: 'failed', why: r.why ?? '' },
    deps.now(),
  );
  const run: CarpoolWatchRun = {
    runId,
    outcome: r.outcome,
    scanned: r.outcome === 'failed' ? 0 : 1,
    found: r.found,
    ...(r.why ? { why: r.why } : {}),
  };
  if (r.outcome === 'failed') {
    deps.log('error', '拼车盯读这一轮没跑成', { runId, why: r.why });
    throw new CarpoolWatchFailedError(runId, r.why ?? '拼车盯读没跑成');
  }
  if (r.outcome === 'partial') deps.log('warn', '拼车盯读这一轮读接口没成', { runId, why: r.why });
  return run;
}
