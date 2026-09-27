// /healthz 的 watchdog 项（健康页写「看门狗」，#203）和后端看着看门狗的那一下。看门狗是引擎的定时任务（每 5 分钟按登记表看
// 各定时任务新不新鲜，packages/engine 的 jobs/watchdog.ts）；它自己停了、没跑成，它自己报不了，只能从外面看：这里按登记表上
// 它那一行现算（@fleet-dao/db 的 scheduleHealth，和看门狗、驾驶舱「定时任务」页同一个判法）——健康检查读的时候算；后端
// 每 5 分钟算一次，不对就推一条「看门狗停了」，好了自己撤、写明为什么。引擎整个停了，这一下照样在后端里跑。
// 改这里之前必须知道：
// - 一段一条：键是 watchdog-down:<这一段从看门狗哪次跑成之后算>（after-<编号>，从没跑成过是 no-success）；同一段里人点了「处理」的
//   不再打开，之后看门狗跑成一轮再出事是新的一张卡。标题正文不带「多久了」（每 5 分钟改一次卡，飞书免费版每月 1 万次接口调用）。
// - 公网看得到 /healthz：对外只说看门狗几点跑完一轮、查了几个、几个没按期跑成，不带任务名和原因原文（原因只进日志和提醒正文）。
// - 不在法国的正式机器上（开发、测试）报「未接」、不看。这一项跟着看门狗自己变红，发版脚本只标待处理、不退回
//   （deploy/release.sh 的 DRIFTING_HEALTH_ITEMS）。
import {
  alertByKey,
  type Db,
  type JobHealth,
  openAlertsByPrefix,
  resolveAlertWithReason,
  scheduleHealth,
  upsertAlert,
  WATCHDOG_JOB_ID,
} from '@fleet-dao/db';
import { PublicHealthError } from './health.ts';
import type { Logger } from './ports.ts';

/** 不在法国的正式机器上：这一项报「未接」（公网看得到）。 */
export const WATCHDOG_NOT_HERE = '只在法国的正式机器上跑';
/** 「看门狗停了」那条：watchdog-down:<after-<编号> | no-success>。 */
export const WATCHDOG_DOWN_PREFIX = 'watchdog-down:';
/** 撤「看门狗停了」、记操作记录时的「谁」；也用它认出哪些是这里自己撤的（同一段里又不对了照样打开）。 */
export const WATCHDOG_WATCH_ACTOR = 'api:watchdog';
/** 后端多久看一次看门狗。 */
export const WATCHDOG_WATCH_EVERY_MS = 5 * 60_000;

const BEIJING_OFFSET_MS = 8 * 60 * 60_000;

/** 北京时间「09-27 20:26」。 */
function stamp(at: Date): string {
  const s = new Date(at.getTime() + BEIJING_OFFSET_MS).toISOString();
  return `${s.slice(5, 10)} ${s.slice(11, 16)}`;
}

export type WatchdogHealth =
  | { ok: true; note: string }
  | { ok: false; code: string; message: string; detail: string | undefined };

/**
 * 纯判断：登记表上看门狗那一行 → 好不好、对外说什么。最近一轮没跑成、过了期望间隔没跑完一轮、最近一轮一个定时任务都没查到、
 * 没登记：红。刚登记、还在第一个期望间隔里：好（写明还没跑完第一轮），和看门狗对别的任务一个判法。
 */
export function watchdogHealth(h: JobHealth | undefined): WatchdogHealth {
  if (!h) {
    return {
      ok: false,
      code: 'watchdog_unregistered',
      message: '看门狗还没登记',
      detail: '登记表 scheduled_jobs 里没有 watchdog 这一行：引擎起来时登记',
    };
  }
  const every = h.job.expectEveryMinutes;
  if (h.status === 'failing') {
    const at = h.lastFinished?.endedAt;
    return {
      ok: false,
      code: 'watchdog_failing',
      message: `看门狗最近一轮${at ? `（${stamp(at)}）` : ''}没跑成`,
      detail: h.lastFinished?.why ?? undefined,
    };
  }
  if (!h.fresh) {
    const last = h.lastSuccess?.endedAt;
    return {
      ok: false,
      code: 'watchdog_stale',
      message: last
        ? `看门狗 ${stamp(last)} 之后超过 ${every} 分钟没跑完一轮`
        : h.lastRun
          ? `看门狗登记后超过 ${every} 分钟没跑完过一轮`
          : `看门狗登记后超过 ${every} 分钟还没跑过一轮`,
      detail: undefined,
    };
  }
  if (h.status === 'no-samples') {
    return {
      ok: false,
      code: 'watchdog_unscanned',
      message: '看门狗最近一轮一个定时任务都没查到',
      detail: h.lastFinished?.why ?? undefined,
    };
  }
  const last = h.lastSuccess;
  if (h.status !== 'ok' || !last?.endedAt) return { ok: true, note: '刚登记，第一轮还没跑完' };
  const found = last.found ?? 0;
  return {
    ok: true,
    note: `最近一轮 ${stamp(last.endedAt)} 跑完：查了 ${last.scanned ?? 0} 个定时任务，${found === 0 ? '都按期跑成' : `${found} 个没按期跑成`}`,
  };
}

async function readWatchdogHealth(db: Db, at: Date): Promise<JobHealth | undefined> {
  return (await scheduleHealth(db, at)).find((h) => h.job.id === WATCHDOG_JOB_ID);
}

/** 健康检查：现读库；读不到照抛（报「连不上」，不当成没问题）。好的时候带一句说明。 */
export function watchdogHealthCheck(db: Db, now: () => Date = () => new Date()): () => Promise<string> {
  return async () => {
    const got = watchdogHealth(await readWatchdogHealth(db, now()));
    if (!got.ok) throw new PublicHealthError(got.code, got.message, got.detail);
    return got.note;
  };
}

const TITLES: Readonly<Record<string, string>> = {
  watchdog_unregistered: '看门狗没登记：定时任务没人盯着',
  watchdog_failing: '看门狗没跑成：定时任务没人盯着',
  watchdog_stale: '看门狗停了：定时任务没人盯着',
  watchdog_unscanned: '看门狗一个定时任务都没查到',
};

/**
 * 判一次：看门狗不对就推一条（一段一条；同一段人处理过的不再打开），好了、这一段过去了就撤、写明为什么。读不到登记表照抛
 * （库出事了，健康页「数据库」一项会红；这里也写不进提醒）。回做了什么（测试直接调）。
 */
export async function watchdogWatchOnce(deps: {
  db: Db;
  now: () => Date;
}): Promise<'raised' | 'same' | 'handled' | 'fine'> {
  const at = deps.now();
  const h = await readWatchdogHealth(deps.db, at);
  const got = watchdogHealth(h);
  const open = await openAlertsByPrefix(deps.db, WATCHDOG_DOWN_PREFIX);
  const resolve = (dedupeKey: string, why: string) =>
    resolveAlertWithReason(deps.db, { dedupeKey, by: WATCHDOG_WATCH_ACTOR, why, at });
  if (got.ok) {
    for (const a of open) await resolve(a.dedupeKey, `看门狗恢复了：${got.note}`);
    return 'fine';
  }
  const key = `${WATCHDOG_DOWN_PREFIX}${h?.lastSuccess ? `after-${h.lastSuccess.id}` : 'no-success'}`;
  for (const a of open) {
    if (a.dedupeKey !== key) {
      await resolve(a.dedupeKey, '看门狗中间跑成过一轮，这一段过去了；现在的情况另报了一条');
    }
  }
  const title = TITLES[got.code] ?? '看门狗不对：定时任务没人盯着';
  const body = [
    `${got.message}${got.detail ? `：${got.detail}` : ''}。`,
    '看门狗（引擎的定时任务 watchdog，每 5 分钟一轮）不在按期跑，别的定时任务没跑成、停了就没人推提醒。先看引擎在不在：健康页的「引擎工人」一项、' +
      "journalctl -u fleet-engine --since '-1h' | grep 看门狗；手动跑一轮：fleet-temporal schedule trigger --schedule-id watchdog。",
    '看门狗按期跑完一轮，这条自己撤。',
  ].join('\n');
  const existing = await alertByKey(deps.db, key);
  if (existing?.resolvedAt && existing.resolvedBy !== WATCHDOG_WATCH_ACTOR) return 'handled';
  if (existing && !existing.resolvedAt && existing.title === title && existing.body === body) return 'same';
  await upsertAlert(deps.db, {
    dedupeKey: key,
    level: 'alert',
    taskId: null,
    title,
    body,
    link: '/schedules',
  });
  return 'raised';
}

/** 后端每 5 分钟看一次看门狗（只在法国的正式机器上起）。这一轮没做成只记日志，下一轮再来。返回停止的函数。 */
export function startWatchdogWatch(deps: {
  db: Db;
  now: () => Date;
  log: Logger;
  everyMs?: number;
}): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const done = await watchdogWatchOnce(deps);
      if (done === 'raised') deps.log.warn('看门狗不对：推了一条「看门狗停了」');
    } catch (err) {
      deps.log.warn('看着看门狗：这一轮没做成', { error: String(err) });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), deps.everyMs ?? WATCHDOG_WATCH_EVERY_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
