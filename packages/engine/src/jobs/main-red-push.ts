// 主线 ci.yml 变红：每小时对账往飞书推一条（#766）。同一个提交只推一次。
// 转绿推一句「已恢复」，也按提交去重。cancelled、进行中、以及 failure/success 以外的已结束结论不改变上一次结论。
// 没配 webhook、推不出去、运行列表读不到、记不下「推过」：进这一轮的没查成，不当成推过（推不出去时不记已推）。
// 上一次结论从提醒表来：feishu:main-red:<提交号> 是红，feishu:main-recovered:<提交号> 是绿，谁建立得晚听谁的。
import { errMessage } from '@fleet-dao/shared/util';
import type { SweepPart } from './reconcile-common.ts';

export type MainCiVerdict = 'red' | 'green';

/** 这个提交的主线红已经推过。提交号是 40 位 head_sha。 */
export const mainRedPushKey = (sha: string): string => `feishu:main-red:${sha}`;
/** 这个提交上主线转绿、已恢复已经推过。 */
export const mainRecoveredPushKey = (sha: string): string => `feishu:main-recovered:${sha}`;

export const MAIN_RED_KEY_PREFIX = 'feishu:main-red:';
export const MAIN_RECOVERED_KEY_PREFIX = 'feishu:main-recovered:';

export const MAIN_RED_PUSH_TITLE = '主线红了，已推飞书';
export const MAIN_RECOVERED_PUSH_TITLE = '主线已恢复，已推飞书';

/** 主线 ci.yml 的一次 push 运行。列表由调用方按新到旧给。 */
export interface MainPushRun {
  /** GitHub 的 status。completed 才算已结束。 */
  status: string;
  /** 已结束时的 conclusion；进行中是 null。 */
  conclusion: string | null;
  /** 40 位提交号。 */
  sha: string;
  /** 运行页面链接。 */
  url: string;
  /** conclusion 为 failure 的作业名。不判红时是空的。 */
  failedJobs: readonly string[];
}

export interface MainRedPushDeps {
  /** 主线 ci.yml 的 push 运行，新的在前。读不到照抛，不许回空列表冒充「没有」。 */
  listPushRuns: () => Promise<readonly MainPushRun[]>;
  /** 上一次结论；从没推过回 null。读不了照抛。 */
  previousVerdict: () => Promise<MainCiVerdict | null>;
  /** 这个键记下过的正文；没有回 null。读不了照抛。 */
  sentBody: (dedupeKey: string) => Promise<string | null>;
  markSent: (input: { dedupeKey: string; title: string; body: string; link: string }) => Promise<void>;
  /** 没配、推不出去照抛。抛出的话里不带 webhook 地址。 */
  send: (text: string) => Promise<void>;
}

/**
 * 给定主线 ci.yml 最近一次已结束的 push 运行：conclusion 为 failure 判红，success 判绿。
 * cancelled、进行中（status 不是 completed）、以及别的已结束结论（timed_out、skipped……）不改变上一次结论。
 * 没有这一次运行（null）也不改变。
 */
export function judgeMainCi(
  run: { status: string; conclusion: string | null } | null,
  previous: MainCiVerdict | null,
): MainCiVerdict | null {
  if (run === null || run.status !== 'completed') return previous;
  if (run.conclusion === 'failure') return 'red';
  if (run.conclusion === 'success') return 'green';
  return previous;
}

/**
 * 提醒表里红、已恢复各最新一条，谁新听谁的。同一时刻按 id 排（和 latestAlertByPrefix 的次序同一套）。
 * 两条都没有回 null。
 */
export function verdictFromAlerts(
  red: { createdAt: Date; id: string } | null,
  recovered: { createdAt: Date; id: string } | null,
): MainCiVerdict | null {
  if (!red && !recovered) return null;
  if (!red) return 'green';
  if (!recovered) return 'red';
  const delta = red.createdAt.getTime() - recovered.createdAt.getTime();
  if (delta > 0) return 'red';
  if (delta < 0) return 'green';
  return red.id > recovered.id ? 'red' : 'green';
}

function unread(why: string): string {
  return why.includes('没查成') ? why : `没查成：${why}`;
}

function redText(run: MainPushRun): string {
  const jobs = run.failedJobs.length > 0 ? run.failedJobs.join('、') : '（这一轮没有结论为 failure 的作业）';
  return [`主线红了：提交 ${run.sha.slice(0, 7)}`, `运行：${run.url}`, `失败的作业：${jobs}`].join('\n');
}

function recoveredText(run: MainPushRun): string {
  return [`主线已恢复：提交 ${run.sha.slice(0, 7)}`, `运行：${run.url}`].join('\n');
}

/** 新的在前：第一条 status 为 completed 的就是最近一次已结束的。进行中的跳过。 */
function latestFinished(runs: readonly MainPushRun[]): MainPushRun | null {
  return runs.find((r) => r.status === 'completed') ?? null;
}

function badRun(run: MainPushRun): string | null {
  if (!/^[0-9a-f]{40}$/.test(run.sha)) return `主线 ci.yml 的提交号认不出：${run.sha}`;
  if (!run.url.startsWith('https://')) return '主线 ci.yml 的运行链接认不出';
  return null;
}

async function deliver(
  deps: MainRedPushDeps,
  input: { scanned: number; key: string; title: string; text: string; link: string },
): Promise<SweepPart> {
  let already: string | null;
  try {
    already = await deps.sentBody(input.key);
  } catch (err) {
    return {
      scanned: input.scanned,
      found: 0,
      unchecked: [unread(`主线红：查推过没有：${errMessage(err)}`)],
    };
  }
  if (already !== null) return { scanned: input.scanned, found: 0, unchecked: [] };
  try {
    await deps.send(input.text);
  } catch (err) {
    return {
      scanned: input.scanned,
      found: 0,
      unchecked: [unread(`主线红，飞书没推成：${errMessage(err)}`)],
    };
  }
  try {
    await deps.markSent({
      dedupeKey: input.key,
      title: input.title,
      body: input.text,
      link: input.link,
    });
  } catch (err) {
    return {
      scanned: input.scanned,
      found: 1,
      unchecked: [unread(`主线红的飞书已经推出去了，但没记下（下一小时可能再推一次）：${errMessage(err)}`)],
    };
  }
  return { scanned: input.scanned, found: 1, unchecked: [] };
}

/**
 * 看最近一次已结束的主线 push 运行。变红推一条，转绿（上一次是红）推「已恢复」。
 * 推不出去、读不到：回没查成，不记已推。
 */
export async function pushMainRed(deps: MainRedPushDeps): Promise<SweepPart> {
  let runs: readonly MainPushRun[];
  try {
    runs = await deps.listPushRuns();
  } catch (err) {
    const why = errMessage(err);
    return {
      scanned: 0,
      found: 0,
      unchecked: [unread(why.includes('没查成') ? why : `主线 ci.yml 运行列表读不到：${why}`)],
    };
  }
  if (!Array.isArray(runs)) {
    return { scanned: 0, found: 0, unchecked: [unread('主线 ci.yml 运行列表认不出')] };
  }
  const finished = latestFinished(runs);
  if (!finished) return { scanned: runs.length, found: 0, unchecked: [] };

  let previous: MainCiVerdict | null;
  try {
    previous = await deps.previousVerdict();
  } catch (err) {
    return {
      scanned: runs.length,
      found: 0,
      unchecked: [unread(`主线红：查上一次结论：${errMessage(err)}`)],
    };
  }
  const verdict = judgeMainCi(finished, previous);
  // 还是红、但是另一个提交：要再推一次。同一个提交由去重键挡住。cancelled 判出来仍是上一次，不推。
  const notifyRed = verdict === 'red' && finished.conclusion === 'failure';
  const notifyGreen = verdict === 'green' && previous === 'red' && finished.conclusion === 'success';
  if (!notifyRed && !notifyGreen) return { scanned: runs.length, found: 0, unchecked: [] };
  const problem = badRun(finished);
  if (problem) return { scanned: runs.length, found: 0, unchecked: [unread(problem)] };

  if (notifyGreen) {
    return deliver(deps, {
      scanned: runs.length,
      key: mainRecoveredPushKey(finished.sha),
      title: MAIN_RECOVERED_PUSH_TITLE,
      text: recoveredText(finished),
      link: finished.url,
    });
  }
  return deliver(deps, {
    scanned: runs.length,
    key: mainRedPushKey(finished.sha),
    title: MAIN_RED_PUSH_TITLE,
    text: redText(finished),
    link: finished.url,
  });
}
