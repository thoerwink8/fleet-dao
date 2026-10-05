// 谁叫引擎排空、到点怎么停（drain.ts 管状态）：每 DRAIN_POLL_MS 看一次发布脚本写的排空请求（deploy/release.sh 发布一开始写，
// /srv/fleet-dao-releases/.drain-request），认了就不起新会话；到了截止，把还在跑的会话按切号那一套停下（交回 engine_stop，
// 新引擎起来按编号续上）。请求撤了（发布没成、切完了）马上接着派。开始排空、撤掉排空各报一次提醒（驾驶舱看得到在排空、最晚
// 几点照发），新引擎起来把上一次的提醒撤掉。
// 改这里之前必须知道：
// - 请求只在发布锁（/srv/fleet-dao-releases/.lock，发布脚本整个发布都占着）被占着时才算数：发布脚本中途没了，锁跟着放掉，
//   引擎不会一直停着不派。锁查不成时只信没过期的请求（截止之后 REQUEST_STALE_MS 以内）；请求认不出、锁又没占着或查不成，
//   不认、照实记日志。
// - 请求要发的就是这个引擎在跑的版本（切完新引擎起来那一下请求还没撤）：不认。
// - 提醒只在开始、撤掉时各写一次，不写会变的倒计时（飞书卡片每改一次都算接口调用，design 15.4）；「还剩几分钟」按截止算。

import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { errMessage } from '@fleet-dao/shared/util';
import {
  type Cordon,
  DRAIN_POLL_MS,
  deadlineFrom,
  type EngineDrain,
  type InFlightSession,
  RELEASE_GRACE_MS,
} from './drain.ts';

/** 发布脚本写的排空请求，在发布目录下（deploy/release.sh 的 DRAIN_REQUEST）。 */
export const DRAIN_REQUEST_NAME = '.drain-request';
/** 发布锁查不成时，请求过了截止这么久就不再认：到点发布脚本早该停引擎了，还没停就是它中途没了。 */
export const REQUEST_STALE_MS = 30 * 60_000;

export interface DrainRequest {
  /** 要切到的提交。 */
  sha: string;
  requestedAt: string;
  /** 截止：在跑的会话最晚做到这一刻。 */
  until: string;
  /** 谁要发：auto（自动发布）、manual（人跑 release.sh）、rollback（退回）。 */
  by: string;
}

export type RequestSeen =
  | { kind: 'none' }
  | { kind: 'ok'; request: DrainRequest }
  /** 文件在，但读不成、认不出。 */
  | { kind: 'bad'; why: string };

const SHA = /^[0-9a-f]{40}$/;
const short = (sha: string) => sha.slice(0, 12);

/** 认一份排空请求；哪一项不对都抛，写明是哪一项。 */
export function parseDrainRequest(text: string): DrainRequest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`不是 JSON（${errMessage(err)}）`);
  }
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  if (o.schema !== 1) throw new Error(`schema 应为 1，现在是 ${JSON.stringify(o.schema)}`);
  const { sha, requestedAt, until, by } = o;
  if (typeof sha !== 'string' || !SHA.test(sha)) throw new Error('sha 不是 40 位提交号');
  for (const [name, v] of [
    ['requestedAt', requestedAt],
    ['until', until],
  ] as const) {
    if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw new Error(`${name} 不是时间`);
  }
  if (typeof by !== 'string' || by.trim() === '') throw new Error('by 是空的');
  return { sha, requestedAt: requestedAt as string, until: until as string, by };
}

export async function readDrainRequest(
  file: string,
  readText: (path: string) => Promise<string> = (p) => readFile(p, 'utf8'),
): Promise<RequestSeen> {
  let text: string;
  try {
    text = await readText(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { kind: 'none' };
    return { kind: 'bad', why: `${file} 读不成（${errMessage(err)}）` };
  }
  try {
    return { kind: 'ok', request: parseDrainRequest(text) };
  } catch (err) {
    return { kind: 'bad', why: `${file} 认不出：${errMessage(err)}` };
  }
}

export type RequestVerdict =
  | { kind: 'absent' }
  | { kind: 'cordon'; cordon: Cordon; note?: string }
  | { kind: 'ignore'; why: string };

/** 这份请求认不认：见文件头。lock：发布锁占着 true、空着 false、没查成 undefined。 */
export function judgeRequest(
  seen: RequestSeen,
  lock: boolean | undefined,
  ownSha: string | null,
  nowMs: number,
  graceMs: number = RELEASE_GRACE_MS,
): RequestVerdict {
  if (seen.kind === 'none') return { kind: 'absent' };
  if (seen.kind === 'bad') {
    if (lock !== true) {
      return {
        kind: 'ignore',
        why: `排空请求${seen.why}；发布锁${lock === false ? '空着（发布已经结束或中途没了）' : '也没查成'}：不认`,
      };
    }
    // 发布在跑、请求认不出：照默认宽限排空（截止只提前不推后，每一轮算出来的不会把它往后挪）
    return {
      kind: 'cordon',
      cordon: {
        source: 'release',
        since: new Date(nowMs).toISOString(),
        until: deadlineFrom(nowMs, graceMs),
        why: '发布在跑（排空请求认不出，按默认宽限）',
      },
      note: `排空请求${seen.why}：发布锁占着，按默认宽限排空`,
    };
  }
  const r = seen.request;
  if (ownSha && r.sha === ownSha)
    return { kind: 'ignore', why: `排空请求要切到的就是在跑的这一版 ${short(r.sha)}：不认` };
  if (lock === false) {
    return { kind: 'ignore', why: `排空请求（${short(r.sha)}）还在，但发布锁空着：是没收尾的旧请求，不认` };
  }
  let note: string | undefined;
  if (lock === undefined) {
    if (nowMs > Date.parse(r.until) + REQUEST_STALE_MS) {
      return {
        kind: 'ignore',
        why: `发布锁没查成，排空请求（${short(r.sha)}）截止 ${r.until} 已过去太久：不认`,
      };
    }
    note = `发布锁没查成，排空请求（${short(r.sha)}）还没过期，照它排空`;
  }
  return {
    kind: 'cordon',
    cordon: {
      source: 'release',
      since: r.requestedAt,
      until: r.until,
      why: `发布 ${short(r.sha)}（${r.by}）`,
      sha: r.sha,
    },
    ...(note ? { note } : {}),
  };
}

export type DrainEvent =
  /** 开始排空（驾驶舱提醒）。 */
  | { kind: 'start'; cordon: Cordon; inFlight: InFlightSession[] }
  /** 发布的排空撤了：接着派。 */
  | { kind: 'lift'; why: string }
  /** 引擎起来了：上一个引擎留下的排空提醒撤掉。 */
  | { kind: 'resume'; ownSha: string | null };

export interface DrainControlDeps {
  drain: EngineDrain;
  readRequest(): Promise<RequestSeen>;
  /** 发布锁此刻有没有人占着：true 占着、false 空着、undefined 没查成。 */
  releaseLockBusy(): Promise<boolean | undefined>;
  /** 这个引擎在跑的版本（它的目录名）；认不出是 null。 */
  ownSha: string | null;
  /** 到截止停下还在跑的会话（real/sessions.ts 的 drainStop）；返回这次叫停的。 */
  stopSessions(why: string): string[];
  /** 报给驾驶舱（提醒）；写不进去只记日志，不挡排空。 */
  notify?(event: DrainEvent): Promise<void>;
  log(message: string): void;
  now?: () => number;
  graceMs?: number;
}

export interface DrainControl {
  /** 看一次：请求认不认、截止到没到。不抛。 */
  tick(): Promise<void>;
  /** 引擎起来时：把上一个引擎留下的排空提醒撤掉。 */
  resumed(): Promise<void>;
  /** 每 pollMs 看一次；返回停下的办法。 */
  start(pollMs?: number): () => void;
}

export function createDrainControl(deps: DrainControlDeps): DrainControl {
  const now = deps.now ?? (() => Date.now());
  let lastNote = '';
  const noteOnce = (text: string) => {
    if (text === lastNote) return;
    lastNote = text;
    deps.log(text);
  };
  const notify = async (event: DrainEvent) => {
    if (!deps.notify) return;
    try {
      await deps.notify(event);
    } catch (err) {
      deps.log(`排空的提醒没写进去（排空照做）：${errMessage(err)}`);
    }
  };
  let ticking: Promise<void> | null = null;

  async function once(): Promise<void> {
    const t = now();
    const before = deps.drain.stopping();
    let seen: RequestSeen;
    try {
      seen = await deps.readRequest();
    } catch (err) {
      seen = { kind: 'bad', why: `读不成（${errMessage(err)}）` };
    }
    let lock: boolean | undefined;
    if (seen.kind !== 'none') {
      try {
        lock = await deps.releaseLockBusy();
      } catch {
        lock = undefined;
      }
    }
    const verdict = judgeRequest(seen, lock, deps.ownSha, t, deps.graceMs);
    if (verdict.kind === 'cordon') {
      if (verdict.note) noteOnce(verdict.note);
      else lastNote = '';
      const changed = deps.drain.cordon(verdict.cordon);
      const c = deps.drain.stopping();
      if (changed && c && !before) {
        const inFlight = deps.drain.inFlight();
        deps.log(
          `开始排空：${c.why}，不起新会话；在跑的 ${inFlight.length} 个会话最晚做到 ${c.until}，到点没做完的停下、新引擎起来按编号续上`,
        );
        await notify({ kind: 'start', cordon: c, inFlight });
      } else if (changed && c) {
        deps.log(`排空更新：${c.why}，截止 ${c.until}`);
      }
    } else {
      if (verdict.kind === 'ignore') noteOnce(verdict.why);
      else lastNote = '';
      if (before?.source === 'release' && deps.drain.lift()) {
        const why =
          verdict.kind === 'absent'
            ? '发布请求撤了（发布没成、或者切版本之前撤了）'
            : `发布请求不再算数（${verdict.why}）`;
        deps.log(`撤掉排空，接着派：${why}`);
        await notify({ kind: 'lift', why });
      }
    }
    const c = deps.drain.stopping();
    if (c && deps.drain.overdue(t)) {
      const stopped = deps.stopSessions(`到了发布宽限的截止（${c.until}）`);
      if (stopped.length > 0) {
        deps.log(
          `到了排空截止 ${c.until}：停下还在跑的会话（交回 engine_stop，新引擎起来按编号续上）：${stopped.join('、')}`,
        );
      }
    }
  }

  const tick = () => {
    // 同一时刻只看一次：上一次还没看完（读文件、查锁卡住）就不叠着看
    ticking ??= once().finally(() => {
      ticking = null;
    });
    return ticking;
  };

  return {
    tick,
    resumed: () => notify({ kind: 'resume', ownSha: deps.ownSha }),
    start(pollMs = DRAIN_POLL_MS) {
      const timer = setInterval(() => void tick(), pollMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },
  };
}

/** 引擎在跑哪一版：发布目录下的 <提交号> 目录（systemd 起进程时 current 解成它）；认不出就是 null。 */
export function shaOfDir(dir: string): string | null {
  const name =
    dir
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? '';
  return SHA.test(name) ? name : null;
}

/**
 * 这个进程在跑哪一版：systemd 起进程时 WorkingDirectory（current）解成的 <提交号> 目录，认不出是 null（开发机、测试）。
 * jobs/flow-config.ts 靠它判「流程配置副本里这版认不出的新字段，是不是配置比引擎新」。
 */
export function ownReleaseSha(cwd: string = process.cwd()): string | null {
  try {
    return shaOfDir(realpathSync(cwd));
  } catch {
    return null;
  }
}

export function drainRequestFile(releasesDir: string): string {
  return join(releasesDir, DRAIN_REQUEST_NAME);
}
