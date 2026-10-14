// 看门狗（#203；design 第六节「断链怎么被发现」第 5 层「没跑成 ≠ 没问题」）：每 5 分钟按 scheduled_jobs 登记表逐个看定时任务
// 新不新鲜（@fleet-dao/db 的 scheduleHealth，驾驶舱「定时任务」页读的同一张表）。最近一次没跑成（failing），或者过了期望间隔
// 没跑成过（不新鲜：停了、登记了超过期望间隔还从没跑过、一直一个都没扫到）的，往提醒中心推一条卡住报警（飞书照现有的推送发，
// 一件事一张卡）；恢复了自己撤，正文开头写「已撤：为什么」。
// 读不到登记表、跑记录：这一轮记没跑成（不当成都新鲜），不另推一条「看门狗没查成」——那条和下面后端看着看门狗的「看门狗没跑成」
// 是同一件事、写的又是同一个库（#1072 删了）。推、撤提醒没写进去：这一轮记没跑成，下一轮照库里的样子重推（不记「推过了」）。
// 它自己也登记在表上，但不看自己（这一轮在跑就说明它活着）：它自己停了、没跑成，由后端现算（packages/api 的 watchdog-health.ts：
// /healthz 的 watchdog 项，后端每 5 分钟看一次、推「看门狗停了」）。
// 改这里之前必须知道：
// - 一段一条：键是 watchdog:job:<任务>:<这一段从哪次跑成之后算>（after-<schedule_runs 的编号>，从没跑成过是 no-success）。同一段里
//   人点了「处理」的不再打开（人接手了）；之后跑成一次再出事是新的一段、新的一张卡。看门狗自己撤的，同一段里又不对了照样打开。
// - 标题正文不带「多久了」这种每轮都变的话：只写上次跑成的时刻、最近一次的原因，没变就不改卡（飞书免费版每月 1 万次接口调用）。
// - 任务自己报「没跑成」的（键以 <编号>:run 开头，备份脚本就这么报）：它为最近这次没跑成报过（那条在这次开始之后建的或改过，
//   人处理没处理都算），看门狗不为同一件事再报一条，自己那条撤掉写明看哪条；「停了」照报（停了它自己报不了）。
// - 同一轮还看「主线 N 小时没合 PR」（决定 0093，删了全流程巡检换这一条）：判法在 jobs/merge-stall.ts，键 watchdog:merge:…，
//   只读库（PR 镜像、任务、拉单记下的等空位单数），报、撤和上面同一套。
// - 同一轮还看「同一个任务连着没跑全」（jobs/red-streak.ts）：partial 算跑成，所以原来一个任务能连着几百次只跑一半而没人报；
//   最近一次跑全之后连着 3 次以上 partial / failed、且跨过 2 小时的报一张卡（键 watchdog:red:…），已经被上面「没跑成 / 停了」报过的任务不重复报。
// - 同一轮还看「在用的账号池额度读数不超过 30 分钟」（决定 0093 从每小时对账搬来，对账只管和 GitHub 对账）：jobs/watchdog-quota.ts，
//   键还是 reconcile:quota:<池>，只读库。
// - 同一轮还看「发版要人看」「健康页（/healthz）非 200 持续 > 10 分钟」（jobs/release-watch.ts，法国 2026-10-14 发版失败后漏报）：
//   键 watchdog:release:…、watchdog:healthz:…，读法国的发布目录和 /healthz（real/watchdog.ts）；和上面「连着没跑全」互不相干。
// - 同一轮还看「提醒真的推到飞书了」（jobs/watchdog-push.ts）：推送渠道自己坏了靠推送报不出来，键 watchdog:push:feishu、进「要你拍」。
// - 也看「今天的每日简报送到了」（jobs/watchdog-brief.ts）：09:00 以后没送到报 watchdog:brief:<北京日期>（卡住报警），送到了自己撤。

import type { JobHealth, MergeStallFacts, RedStreak, ScheduleResult } from '@fleet-dao/db';
import { WATCHDOG_JOB_ID } from '@fleet-dao/db';
import { errMessage } from '@fleet-dao/shared/util';
import type { WatchdogRun } from '../contract.ts';
import type { ScheduleRunLog } from './github-reconcile.ts';
import {
  judgeMergeStalls,
  MERGE_STALL_ALERT_PREFIX,
  MERGE_STALL_LINK,
  mergeStallRetireWhy,
  repoOfMergeStallKey,
} from './merge-stall.ts';
import { clip, stamp } from './reconcile-common.ts';
import { jobIdOfRedKey, judgeRedStreak, RED_STREAK_ALERT_PREFIX, RED_STREAK_LINK } from './red-streak.ts';
import {
  HEALTHZ_ALERT_PREFIX,
  type HealthzProbe,
  judgeHealthz,
  judgeReleaseAttention,
  RELEASE_ATTENTION_ALERT_PREFIX,
  RELEASE_WATCH_LINK,
  type ReleaseFacts,
} from './release-watch.ts';
import { type BriefWatchDeps, watchDailyBrief } from './watchdog-brief.ts';
import { type PushWatchDeps, watchFeishuPush } from './watchdog-push.ts';
import { type QuotaWatchDeps, watchQuotaFreshness } from './watchdog-quota.ts';

/** 登记进 scheduled_jobs 的那一行。 */
export const WATCHDOG_JOB = {
  id: WATCHDOG_JOB_ID,
  name: '看门狗（定时任务新不新鲜）',
  schedule: '每 5 分钟',
  // 漏两轮不报，连着三轮没跑成才算过期：后端的健康检查和看守按这一行判看门狗自己停没停
  expectEveryMinutes: 15,
} as const;

export const WATCHDOG_EVERY_MINUTES = 5;
/** 和对账补漏（整点起每 15 分钟）、路由探针（7、22、37、52 分）错开：每小时 4、9、14……分。 */
export const WATCHDOG_OFFSET_MINUTES = 4;
/** 撤提醒、记操作记录时的「谁」；也用它认出哪些是看门狗自己撤的（同一段里又不对了照样打开）。 */
export const WATCHDOG_ACTOR = 'engine:watchdog';
/** 某个定时任务不对的那条：watchdog:job:<任务>:<after-<编号> | no-success>。 */
export const WATCHDOG_JOB_ALERT_PREFIX = 'watchdog:job:';
/** 提醒点进去看驾驶舱「定时任务」页。 */
export const WATCHDOG_LINK = '/schedules';
/** why 最长多少字。 */
export const WATCHDOG_WHY_MAX = 1500;

type RunRow = NonNullable<JobHealth['lastRun']>;

/** 提醒的读写（真实现是 @fleet-dao/db 的同名查询，real/watchdog.ts）。 */
export interface WatchdogAlerts {
  /** 还开着的、键以 prefix 开头的（openAlertsByPrefix）。 */
  openByPrefix(prefix: string): Promise<{ dedupeKey: string; title: string; body: string }[]>;
  /** 键以 prefix 开头的最新一条，处理没处理都算（latestAlertByPrefix）；没有是 null。 */
  latestByPrefix(prefix: string): Promise<{ title: string; updatedAt: Date } | null>;
  /** 这个键的那一条，处理没处理都给（alertByKey）；没有是 null。 */
  byKey(dedupeKey: string): Promise<{
    title: string;
    body: string;
    resolvedAt: Date | null;
    resolvedBy: string | null;
  } | null>;
  /** 报：没有就建、开着的原地改、处理过的重新打开（upsertAlert；不给 level 是卡住报警这一级）。 */
  raise(input: {
    dedupeKey: string;
    title: string;
    body: string;
    link: string;
    level?: 'alert' | 'decision';
  }): Promise<void>;
  /** 撤：处理人记 WATCHDOG_ACTOR，正文开头写「已撤：why」，进操作记录（resolveAlertWithReason）。 */
  resolve(input: { dedupeKey: string; why: string }): Promise<'ok' | 'already_resolved' | 'not_found'>;
}

export interface WatchdogDeps {
  /** 登记表上每个定时任务的健康度（@fleet-dao/db 的 scheduleHealth）。读不到照抛：这一轮记没查成，不当成都新鲜。 */
  health(now: Date): Promise<JobHealth[]>;
  alerts: WatchdogAlerts;
  runs: ScheduleRunLog;
  /**
   * 「主线 N 小时没合 PR」要的事实（@fleet-dao/db 的 mergeStallFacts）。读不到照抛：这一轮记没查成，开着的不撤。
   * 不给（只测定时任务那部分的单测）就不看这一条。
   */
  mergeStall?: () => Promise<MergeStallFacts>;
  /**
   * 「在用的账号池额度读数不超过 30 分钟」要的读（jobs/watchdog-quota.ts，决定 0093 从每小时对账搬来）。读不到照抛：这一轮记没查成，
   * 开着的不撤。不给（只测别的部分的单测）就不看这一条。
   */
  quota?: Pick<QuotaWatchDeps, 'quotaPools' | 'quotaNotRead'>;
  /**
   * 每个任务当前连着没跑全的那一段（@fleet-dao/db 的 scheduleRedStreaks）。读不到照抛：这一轮记没查成，开着的不撤。
   * 不给（只测别的部分的单测）就不看这一项。
   */
  redStreaks?: (now: Date) => Promise<RedStreak[]>;
  /**
   * 发版和健康页（jobs/release-watch.ts）。facts 回 null = 这台不是法国（没有发布目录），这一项不看；读不到照抛：这一轮记没查成，
   * 开着的不撤。不给（只测别的部分的单测）就不看这一项。
   */
  releaseWatch?: {
    facts(): Promise<ReleaseFacts | null>;
    /** 问 /healthz；连不上、超时也要回 { ok: false }，不许抛成「没查」。 */
    probe(): Promise<HealthzProbe>;
    /** 这一段不健康从几点起（设置表）：读、第一次不健康时记、健康了清。 */
    badSince: { read(): Promise<Date | null>; write(since: Date): Promise<void>; clear(): Promise<void> };
  };
  /**
   * 「提醒真的推到飞书了」要的读（jobs/watchdog-push.ts）。读不到照抛：这一轮记没查成，开着的不撤。不给（只测别的部分的单测）就不看这一条。
   */
  push?: Pick<PushWatchDeps, 'facts'>;
  /**
   * 「今天的每日简报送到了」要的读（jobs/watchdog-brief.ts）。读不到照抛：这一轮记没查成，开着的不撤。不给（只测别的部分的单测）就不看这一条。
   */
  brief?: Pick<BriefWatchDeps, 'status' | 'here'>;
  now: () => Date;
  log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

/** 这一轮没跑成：结局已经记进 schedule_runs，活动照样报失败，Temporal 里也看得见。 */
export class WatchdogFailedError extends Error {
  readonly runId: number;
  constructor(runId: number, message: string) {
    super(message);
    this.name = 'WatchdogFailedError';
    this.runId = runId;
  }
}

/** 期望间隔说成人话：「45 分钟」「2 小时 30 分钟」「26 小时」「7 天 2 小时」。 */
export function spokenMinutes(total: number): string {
  if (total < 60) return `${total} 分钟`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h < 48) return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} 天 ${h % 24} 小时` : `${d} 天`;
}

/** 一次运行给人看的样子：北京时间、结局、扫了几个或原因。 */
export function describeRun(r: RunRow): string {
  if (r.outcome === null) return `${stamp(r.startedAt)} 开始，还没跑完`;
  const at = stamp(r.endedAt ?? r.startedAt);
  const why = r.why ?? '没写原因';
  switch (r.outcome) {
    case 'ok':
      return `${at} 跑完：扫了 ${r.scanned ?? 0} 个、发现 ${r.found ?? 0} 个问题`;
    case 'partial':
      return `${at} 跑完、只查了一部分：${why}`;
    case 'unscanned':
      return `${at} 跑完、一个都没扫到：${why}`;
    case 'failed':
      return `${at} 没跑成：${why}`;
  }
}

export type JobVerdict =
  /** 按期跑成了（或刚登记、还在第一个期望间隔里）：why 是撤掉之前那条时写的原因。 */
  | { kind: 'fine'; job: JobHealth['job']; why: string }
  /**
   * 要人知道：这一段的键、标题、正文。failedRunStartedAt：最近一次没跑成的那次几点开始的（不是「没跑成」是 null）——
   * 任务自己在这之后报过，看门狗就不报第二条。
   */
  | {
      kind: 'alert';
      job: JobHealth['job'];
      key: string;
      title: string;
      body: string;
      failedRunStartedAt: Date | null;
    };

/** 这一段的键：从哪次跑成之后算（从没跑成过是 no-success）。 */
export function watchdogAlertKey(jobId: string, lastSuccess: RunRow | null): string {
  return `${WATCHDOG_JOB_ALERT_PREFIX}${jobId}:${lastSuccess ? `after-${lastSuccess.id}` : 'no-success'}`;
}

/** 键里的任务编号（任务编号里有冒号也认得出：最后一段是 after-<编号> 或 no-success）。 */
export function jobIdOfKey(key: string): string {
  return key.slice(WATCHDOG_JOB_ALERT_PREFIX.length, key.lastIndexOf(':'));
}

/** 不新鲜时最近一次是什么样：只写不会每轮都变的（停着的写时刻，还在一轮轮跑的只写原因）。 */
function recentLine(h: JobHealth): string | null {
  const { lastRun, lastFinished, lastSuccess } = h;
  if (h.status === 'no-samples') return `最近一次跑完了，但一个都没扫到：${lastFinished?.why ?? '没写原因'}`;
  if (!lastRun || lastRun.id === lastSuccess?.id) return null;
  if (lastRun.outcome === null) return `最近一次 ${stamp(lastRun.startedAt)} 开始，到现在没跑完`;
  return `最近一次：${describeRun(lastRun)}`;
}

/** 按期跑成了：撤之前那条时写的原因。 */
function fineWhy(h: JobHealth): string {
  const name = `「${h.job.name}」`;
  if (h.lastSuccess) {
    const later =
      h.lastFinished && h.lastFinished.id !== h.lastSuccess.id
        ? `；最近一次：${describeRun(h.lastFinished)}`
        : '';
    return `${name}按期跑成了：${describeRun(h.lastSuccess)}${later}`;
  }
  return `${name}还在登记后的第一个期望间隔里，最近一次不是没跑成（${h.lastFinished ? describeRun(h.lastFinished) : '还没跑完过一轮'}）`;
}

/**
 * 一个定时任务要不要人知道（纯函数）：最近一次没跑成，或者不新鲜（过了期望间隔没跑成过：停了、从没跑过、一直没扫到东西），
 * 就要；按期跑成了的、刚登记还在第一个期望间隔里的不要。
 * 最近一次没跑成、之后过了期望间隔再没开跑过的，按「停了」报：它停了就报不了自己，任务自己报过没跑成也不算数。
 */
export function judgeJob(h: JobHealth, now: Date): JobVerdict {
  const { job, lastRun, lastFinished, lastSuccess } = h;
  if (h.status !== 'failing' && h.fresh) return { kind: 'fine', job, why: fineWhy(h) };
  const windowMs = job.expectEveryMinutes * 60_000;
  /** 期望间隔里开跑过（还在一轮轮跑）。 */
  const alive = lastRun !== null && now.getTime() - lastRun.startedAt.getTime() <= windowMs;
  const failing = h.status === 'failing' && (alive || h.fresh);
  const name = `「${job.name}」`;
  const every = spokenMinutes(job.expectEveryMinutes);
  const lines: string[] = [];
  let title: string;
  if (failing) {
    title = `定时任务${name}没跑成`;
    lines.push(
      `最近一次没跑成：${lastFinished?.why ?? '没写原因'}`,
      `上次跑成：${lastSuccess?.endedAt ? stamp(lastSuccess.endedAt) : '从没跑成过'}`,
    );
  } else if (lastRun === null) {
    title = `定时任务${name}从没跑过`;
    lines.push(
      `${stamp(job.registeredAt)} 登记的，过了期望间隔（${every}）还一次都没跑过：定时器可能没排上、没在响。`,
    );
  } else if (lastSuccess?.endedAt == null) {
    title = `定时任务${name}从没跑成过`;
    lines.push(`${stamp(job.registeredAt)} 登记的，过了期望间隔（${every}）还没跑成过一次。`);
  } else {
    title = alive ? `定时任务${name}超过 ${every}没跑成` : `定时任务${name}停了：超过 ${every}没跑`;
    lines.push(`上次跑成是 ${stamp(lastSuccess.endedAt)}，之后过了期望间隔（${every}）没再跑成。`);
  }
  if (!failing) {
    const recent = recentLine(h);
    if (recent) lines.push(recent);
  }
  lines.push(
    `这个任务：${job.id}，${job.schedule}。看驾驶舱「定时任务」页这一行；按期跑成一次，这条自己撤。`,
  );
  return {
    kind: 'alert',
    job,
    key: watchdogAlertKey(job.id, lastSuccess),
    title: clip(title, 300),
    body: lines.join('\n'),
    failedRunStartedAt: failing ? (lastFinished?.startedAt ?? null) : null,
  };
}

type Wanted = Extract<JobVerdict, { kind: 'alert' }>;

/**
 * 报一条：同一段里人处理过的不再打开（人接手了，回 handled）；开着的、标题正文都没变的不动（回 same，不改卡）；
 * 别的（没有、开着要改、看门狗自己撤过的）报出去。
 */
async function raiseOnce(
  alerts: WatchdogAlerts,
  input: { dedupeKey: string; title: string; body: string; link?: string },
): Promise<'raised' | 'same' | 'handled'> {
  const existing = await alerts.byKey(input.dedupeKey);
  if (existing?.resolvedAt && existing.resolvedBy !== WATCHDOG_ACTOR) return 'handled';
  if (existing && !existing.resolvedAt && existing.title === input.title && existing.body === input.body) {
    return 'same';
  }
  await alerts.raise({ ...input, link: input.link ?? WATCHDOG_LINK });
  return 'raised';
}

/** 为什么撤一条看门狗的提醒（它这一轮不在要报的里面）。 */
function retireWhy(jobId: string, verdict: JobVerdict | undefined, ownTitle: string | undefined): string {
  if (!verdict) return `「${jobId}」不在定时任务登记表上了（不再要求它按期跑）`;
  const name = `「${verdict.job.name}」`;
  if (verdict.kind === 'fine') return verdict.why;
  if (ownTitle !== undefined) return `${name}自己报了没跑成（${ownTitle}），这一段看那一条`;
  return `${name}这一段过去了（中间跑成过一次），现在的情况另报了一条`;
}

interface RoundState {
  deps: WatchdogDeps;
  /** 推、撤没写进去的，一条一句：这一轮记没跑成，下一轮照库里的样子重来。 */
  problems: string[];
}

/** 做一件事；没做成的记进 problems（一条一句），回 failed，不抛。 */
async function attempt<T>(
  s: RoundState,
  what: string,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    s.problems.push(`${what}：${errMessage(err)}`);
    return { ok: false };
  }
}

async function round(deps: WatchdogDeps): Promise<ScheduleResult> {
  const now = deps.now();
  let health: JobHealth[];
  try {
    health = await deps.health(now);
  } catch (err) {
    // 这一轮不知道各定时任务新不新鲜（不当成都新鲜，开着的报警一条都不撤）：记没跑成，后端看着看门狗的那一下会报
    return {
      outcome: 'failed',
      why: clip(`读不到定时任务的登记表或跑记录：${errMessage(err)}`, WATCHDOG_WHY_MAX),
    };
  }
  const s: RoundState = { deps, problems: [] };
  const others = health.filter((h) => h.job.id !== WATCHDOG_JOB.id);

  // 每个任务判一遍：要人知道的报（一段一条）；任务自己为这次没跑成报过的不报第二条
  const verdicts = others.map((h) => judgeJob(h, now));
  const wanted = new Map<string, Wanted>();
  const ownTitles = new Map<string, string>();
  let found = 0;
  for (const v of verdicts) {
    if (v.kind !== 'alert') continue;
    found += 1;
    const failedAt = v.failedRunStartedAt;
    if (failedAt) {
      // 查不成照报：宁可多一张卡，不漏
      const own = await attempt(s, `没查成「${v.job.name}」自己报没报没跑成`, () =>
        deps.alerts.latestByPrefix(`${v.job.id}:run`),
      );
      if (own.ok && own.value && own.value.updatedAt.getTime() >= failedAt.getTime()) {
        ownTitles.set(v.job.id, own.value.title);
        continue;
      }
    }
    wanted.set(v.key, v);
    const got = await attempt(s, `「${v.job.name}」的提醒没写进去`, () =>
      raiseOnce(deps.alerts, { dedupeKey: v.key, title: v.title, body: v.body }),
    );
    if (got.ok && got.value === 'raised')
      deps.log('warn', '看门狗：推了一条', { dedupeKey: v.key, title: v.title });
  }

  // 不用再报的撤掉：恢复了、这一段过去了、任务自己报了、不在登记表上了
  const open = await attempt(s, '列不了看门狗开着的提醒（恢复了的这一轮撤不了）', () =>
    deps.alerts.openByPrefix(WATCHDOG_JOB_ALERT_PREFIX),
  );
  const byJob = new Map(verdicts.map((v) => [v.job.id, v]));
  for (const a of open.ok ? open.value : []) {
    if (wanted.has(a.dedupeKey)) continue;
    const jobId = jobIdOfKey(a.dedupeKey);
    const why = retireWhy(jobId, byJob.get(jobId), ownTitles.get(jobId));
    const done = await attempt(s, `提醒 ${a.dedupeKey} 没撤掉`, () =>
      deps.alerts.resolve({ dedupeKey: a.dedupeKey, why }),
    );
    if (done.ok) deps.log('info', '看门狗：撤了一条', { dedupeKey: a.dedupeKey, why });
  }

  const reds = deps.redStreaks
    ? await redStreakRound(
        s,
        deps.redStreaks,
        others,
        new Set(verdicts.filter((v) => v.kind === 'alert').map((v) => v.job.id)),
        now,
      )
    : { scanned: 0, found: 0 };
  found += reds.found;

  const merges: MergesRound = deps.mergeStall
    ? await mergeStallRound(s, deps.mergeStall, now)
    : { scanned: 0, found: 0, repos: null };
  found += merges.found;
  let quotaScanned = 0;
  if (deps.quota) {
    const q = await watchQuotaFreshness({ ...deps.quota, alerts: deps.alerts, log: deps.log }, now);
    s.problems.push(...q.problems);
    found += q.found;
    quotaScanned = q.scanned;
  }
  const releases = deps.releaseWatch
    ? await releaseWatchRound(s, deps.releaseWatch, now)
    : { scanned: 0, found: 0 };
  found += releases.found;
  let pushScanned = 0;
  if (deps.push) {
    const p = await watchFeishuPush({ ...deps.push, alerts: deps.alerts, log: deps.log }, now);
    s.problems.push(...p.problems);
    found += p.found;
    pushScanned = p.scanned;
  }
  let briefScanned = 0;
  if (deps.brief) {
    const b = await watchDailyBrief({ ...deps.brief, alerts: deps.alerts, log: deps.log }, now);
    s.problems.push(...b.problems);
    found += b.found;
    briefScanned = b.scanned;
  }
  const scanned =
    others.length +
    merges.scanned +
    quotaScanned +
    reds.scanned +
    releases.scanned +
    pushScanned +
    briefScanned;

  if (s.problems.length > 0) {
    const why = `${s.problems.length > 1 ? `${s.problems.length} 处没做成：` : ''}${s.problems.join('；')}`;
    return { outcome: 'failed', why: clip(why, WATCHDOG_WHY_MAX), scanned, found };
  }
  // 「没东西可看」要说清是哪两样都没有（#prune：原来只写定时任务登记表，看不出哪些仓空着、看不出一个仓都没开着「让 AI 接活」）
  if (scanned === 0)
    return { outcome: 'unscanned', why: clip(emptyWhy(others.length, merges.repos), WATCHDOG_WHY_MAX) };
  return { outcome: 'ok', scanned, found };
}

/** 撤掉前缀下不在 wanted 里的提醒，写明为什么；列不了、撤不掉记没查成。 */
async function retireOthers(
  s: RoundState,
  prefix: string,
  wanted: ReadonlySet<string>,
  why: string,
  what: string,
): Promise<void> {
  const open = await attempt(s, `列不了「${what}」开着的提醒（恢复了的这一轮撤不了）`, () =>
    s.deps.alerts.openByPrefix(prefix),
  );
  for (const a of open.ok ? open.value : []) {
    if (wanted.has(a.dedupeKey)) continue;
    const done = await attempt(s, `提醒 ${a.dedupeKey} 没撤掉`, () =>
      s.deps.alerts.resolve({ dedupeKey: a.dedupeKey, why }),
    );
    if (done.ok) s.deps.log('info', '看门狗：撤了一条', { dedupeKey: a.dedupeKey, why });
  }
}

/**
 * 「发版要人看」「健康页非 200 持续 > 10 分钟」这一部分：报该报的、撤不用再报的。读不到记没查成，开着的一条都不撤。
 * 这台不是法国（facts 回 null）整块不看，也不问 /healthz。
 */
async function releaseWatchRound(
  s: RoundState,
  rw: NonNullable<WatchdogDeps['releaseWatch']>,
  now: Date,
): Promise<{ scanned: number; found: number }> {
  const facts = await attempt(s, '读不到法国的发布目录（发版要不要人看这一轮没查成）', () => rw.facts());
  if (!facts.ok) return { scanned: 0, found: 0 };
  if (facts.value === null) return { scanned: 0, found: 0 };
  let found = 0;
  const raise = async (v: { key: string; title: string; body: string }, what: string) => {
    const got = await attempt(s, `${what}的提醒没写进去`, () =>
      raiseOnce(s.deps.alerts, { dedupeKey: v.key, title: v.title, body: v.body, link: RELEASE_WATCH_LINK }),
    );
    if (got.ok && got.value === 'raised')
      s.deps.log('warn', '看门狗：推了一条', { dedupeKey: v.key, title: v.title });
  };

  const rel = judgeReleaseAttention(facts.value, now);
  const wantedRelease = new Set<string>();
  if (rel.kind === 'alert') {
    found += 1;
    wantedRelease.add(rel.key);
    await raise(rel, '发版要人看');
  }
  await retireOthers(
    s,
    RELEASE_ATTENTION_ALERT_PREFIX,
    wantedRelease,
    '发版现在不用人看了（最近一次发版成功，或进度记录收尾了）',
    '发版要人看',
  );

  // 健康页：问一次；非 200 记第一次的时刻，持续过了 HEALTHZ_DOWN_MS 才报；200 清掉记的时刻
  const probe = await attempt(s, '问不了 /healthz（这一轮没查成）', () => rw.probe());
  if (!probe.ok) return { scanned: 1, found };
  const wantedHealthz = new Set<string>();
  let since: Date | null = null;
  const read = await attempt(s, '读不到健康页「从几点起不健康」的记录', () => rw.badSince.read());
  if (read.ok) since = read.value;
  if (probe.value.ok) {
    if (read.ok && since !== null) await attempt(s, '清不掉健康页的不健康记录', () => rw.badSince.clear());
  } else if (read.ok && since === null) {
    since = now;
    await attempt(s, '记不下健康页第一次不健康的时刻', () => rw.badSince.write(now));
  }
  if (!read.ok) return { scanned: 2, found };
  const h = judgeHealthz(probe.value, since, now);
  if (h.kind === 'alert') {
    found += 1;
    wantedHealthz.add(h.key);
    await raise(h, '健康页非 200');
  }
  // 还没到时限（pending）的、或根本是好的：开着的撤；非 200 持续着的（alert）保留
  await retireOthers(
    s,
    HEALTHZ_ALERT_PREFIX,
    wantedHealthz,
    probe.value.ok ? '/healthz 回 200 了' : '这一段不健康还没到 10 分钟（只在持续超过时报）',
    '健康页非 200',
  );
  return { scanned: 2, found };
}

/** 「没东西可看」（一个都没扫到）时写清两样：定时任务登记表上几个任务，哪些仓开着「让 AI 接活」（repos 是 null = 这一轮没读仓）。 */
export function emptyWhy(otherJobs: number, repos: string[] | null): string {
  const jobs =
    otherJobs === 0
      ? '定时任务登记表上除了看门狗自己没有别的任务'
      : `定时任务登记表上有 ${otherJobs} 个任务（都没到该看的时候）`;
  if (repos === null) return `${jobs}；这一轮没读各仓`;
  if (repos.length === 0) return `${jobs}；也没有哪个仓开着「让 AI 接活」，没有仓可看`;
  return `${jobs}；开着「让 AI 接活」的仓：${repos.join('、')}`;
}

/**
 * 「同一个任务连着没跑全」这一部分：报该报的、撤不用再报的。读不到记没查成，开着的一条都不撤。
 * reported：上面已经按「没跑成 / 停了」报了的任务，这里不再为它们报第二张（开着的这一项的也撤掉，写明看另一条）。
 */
async function redStreakRound(
  s: RoundState,
  read: (now: Date) => Promise<RedStreak[]>,
  jobs: readonly JobHealth[],
  reported: ReadonlySet<string>,
  now: Date,
): Promise<{ scanned: number; found: number }> {
  const streaks = await attempt(s, '读不到各任务连着没跑全的记录（这一项这一轮没查成）', () => read(now));
  if (!streaks.ok) return { scanned: 0, found: 0 };
  const names = new Map(jobs.map((h) => [h.job.id, h.job.name]));
  const wanted = new Set<string>();
  let found = 0;
  for (const streak of streaks.value) {
    const name = names.get(streak.job);
    if (name === undefined || reported.has(streak.job)) continue;
    const v = judgeRedStreak(streak, name);
    if (v.kind !== 'alert') continue;
    found += 1;
    wanted.add(v.key);
    const got = await attempt(s, `「${name}」连着没跑全的提醒没写进去`, () =>
      raiseOnce(s.deps.alerts, { dedupeKey: v.key, title: v.title, body: v.body, link: RED_STREAK_LINK }),
    );
    if (got.ok && got.value === 'raised')
      s.deps.log('warn', '看门狗：推了一条', { dedupeKey: v.key, title: v.title });
  }
  const open = await attempt(s, '列不了「连着没跑全」开着的提醒（恢复了的这一轮撤不了）', () =>
    s.deps.alerts.openByPrefix(RED_STREAK_ALERT_PREFIX),
  );
  for (const a of open.ok ? open.value : []) {
    if (wanted.has(a.dedupeKey)) continue;
    const jobId = jobIdOfRedKey(a.dedupeKey);
    const why = reported.has(jobId)
      ? `「${names.get(jobId) ?? jobId}」另报了没跑成或停了，这一段看那一条`
      : `「${names.get(jobId) ?? jobId}」跑全了一次（或这一段不再够报），不再连着没跑全`;
    const done = await attempt(s, `提醒 ${a.dedupeKey} 没撤掉`, () =>
      s.deps.alerts.resolve({ dedupeKey: a.dedupeKey, why }),
    );
    if (done.ok) s.deps.log('info', '看门狗：撤了一条', { dedupeKey: a.dedupeKey, why });
  }
  // scanned 不加：这一项看的就是上面已经数过的那些任务
  return { scanned: 0, found };
}

/** 「主线 N 小时没合 PR」这一部分：报该报的、撤不用再报的。读不到事实记没查成，开着的一条都不撤。 */
/** 「主线 N 小时没合 PR」这一部分的结果。repos：这一轮读了哪些开着「让 AI 接活」的仓（读不到是 null）。 */
interface MergesRound {
  scanned: number;
  found: number;
  repos: string[] | null;
}

/** 「主线 N 小时没合 PR」这一部分：报该报的、撤不用再报的。读不到事实记没查成，开着的一条都不撤。 */
async function mergeStallRound(
  s: RoundState,
  read: () => Promise<MergeStallFacts>,
  now: Date,
): Promise<MergesRound> {
  const facts = await attempt(s, '读不到各仓最近一次合并、在做的单（主线多久没合 PR 这一轮没查成）', read);
  if (!facts.ok) return { scanned: 0, found: 0, repos: null };
  const verdicts = judgeMergeStalls(facts.value, now);
  const wanted = new Set<string>();
  let found = 0;
  for (const v of verdicts.values()) {
    if (v.kind !== 'alert') continue;
    found += 1;
    wanted.add(v.key);
    const got = await attempt(s, `「${v.repo}」多久没合 PR 的提醒没写进去`, () =>
      raiseOnce(s.deps.alerts, { dedupeKey: v.key, title: v.title, body: v.body, link: MERGE_STALL_LINK }),
    );
    if (got.ok && got.value === 'raised')
      s.deps.log('warn', '看门狗：推了一条', { dedupeKey: v.key, title: v.title });
  }
  const open = await attempt(s, '列不了「多久没合 PR」开着的提醒（恢复了的这一轮撤不了）', () =>
    s.deps.alerts.openByPrefix(MERGE_STALL_ALERT_PREFIX),
  );
  for (const a of open.ok ? open.value : []) {
    if (wanted.has(a.dedupeKey)) continue;
    const repo = repoOfMergeStallKey(a.dedupeKey);
    const why = mergeStallRetireWhy(repo, verdicts.get(repo));
    const done = await attempt(s, `提醒 ${a.dedupeKey} 没撤掉`, () =>
      s.deps.alerts.resolve({ dedupeKey: a.dedupeKey, why }),
    );
    if (done.ok) s.deps.log('info', '看门狗：撤了一条', { dedupeKey: a.dedupeKey, why });
  }
  return { scanned: facts.value.repos.length, found, repos: facts.value.repos.map((r) => r.repo) };
}

/**
 * 跑一轮。记开始就失败（库连不上、没登记）：原样抛出，这一轮在库里没有记录——登记表上它会过期，后端的健康检查和看守看得见。
 * 没跑成（读不到登记表、推撤提醒没写进去）：记成 failed 再抛 WatchdogFailedError。记结局失败：原样抛出。
 */
export async function runWatchdogJob(deps: WatchdogDeps): Promise<WatchdogRun> {
  const runId = await deps.runs.start(WATCHDOG_JOB.id, deps.now());
  let result: ScheduleResult;
  try {
    result = await round(deps);
  } catch (err) {
    result = { outcome: 'failed', why: clip(`看门狗没跑成：${errMessage(err)}`, WATCHDOG_WHY_MAX) };
  }
  await deps.runs.finish(runId, result, deps.now());
  const run: WatchdogRun = {
    runId,
    outcome: result.outcome,
    scanned: result.outcome === 'unscanned' ? 0 : (result.scanned ?? 0),
    found: result.outcome === 'unscanned' ? 0 : (result.found ?? 0),
    ...('why' in result ? { why: result.why } : {}),
  };
  const fields = { runId, outcome: run.outcome, scanned: run.scanned, found: run.found, why: run.why };
  if (run.outcome === 'failed') {
    deps.log('error', '看门狗这一轮没跑成', fields);
    throw new WatchdogFailedError(runId, run.why ?? '看门狗没跑成');
  }
  if (run.outcome === 'ok') deps.log('info', '看门狗看完一轮', fields);
  else deps.log('warn', '看门狗这一轮没东西可看', fields);
  return run;
}
