// 主线 ci.yml 变红：每小时对账往飞书推一条（#766）。同一个提交只推一次。
// 转绿推一句「已恢复」，也按提交去重。cancelled、进行中、以及 failure/success 以外的已结束结论不改变上一次结论。
// 没配 webhook、推不出去、运行列表读不到、记不下「推过」：进这一轮的没查成，不当成推过（推不出去时不记已推）。
// 上一次结论单独记在 feishu:main-ci-verdict（正文 red / green）。推送键谁建立得晚不能当结论：
// 同一个提交再次变红时去重键还在，不再推，但结论必须改回红，否则接下来别的提交转绿会漏掉「已恢复」。
// 推不出去、记不下推送时不改这一行，下一轮照旧再推。还没有这一行时，退回红 / 已恢复谁建立得晚（旧数据）。
import { errMessage } from '@fleet-dao/shared/util';
import type { SweepPart } from './reconcile-common.ts';

export type MainCiVerdict = 'red' | 'green';

/** 这个提交的主线红已经推过。提交号是 40 位 head_sha。 */
export const mainRedPushKey = (sha: string): string => `feishu:main-red:${sha}`;
/** 这个提交上主线转绿、已恢复已经推过。 */
export const mainRecoveredPushKey = (sha: string): string => `feishu:main-recovered:${sha}`;

export const MAIN_RED_KEY_PREFIX = 'feishu:main-red:';
export const MAIN_RECOVERED_KEY_PREFIX = 'feishu:main-recovered:';

/** 当前结论。正文是 red 或 green；和「这个提交推过没有」不是同一行。 */
export const MAIN_CI_VERDICT_KEY = 'feishu:main-ci-verdict';

export const MAIN_RED_PUSH_TITLE = '主线红了，已推飞书';
export const MAIN_RECOVERED_PUSH_TITLE = '主线已恢复，已推飞书';

export function mainCiVerdictTitle(verdict: MainCiVerdict): string {
  return verdict === 'red' ? '主线当前是红的' : '主线当前是绿的';
}

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
  /** 上一次结论；没有记下过回 null。读不了照抛。 */
  previousVerdict: () => Promise<MainCiVerdict | null>;
  /** 这个键记下过的正文；没有回 null。读不了照抛。 */
  sentBody: (dedupeKey: string) => Promise<string | null>;
  markSent: (input: { dedupeKey: string; title: string; body: string; link: string }) => Promise<void>;
  /**
   * 把这次结论写进 MAIN_CI_VERDICT_KEY。同一个提交已经推过、不再推时也要写，
   * 否则上一次结论停在上一次推出去的颜色。写不进照抛。
   */
  rememberVerdict: (input: { verdict: MainCiVerdict; link: string }) => Promise<void>;
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
 * 结论行的正文。过期撤掉时正文前面会加「已撤：…」，原来的 red / green 还在最后，照样认。
 * 认不出回 null（调用方退回推送键谁新）。
 */
export function verdictFromBody(body: string | null | undefined): MainCiVerdict | null {
  if (body == null || body === '') return null;
  let found: MainCiVerdict | null = null;
  for (const line of body.split('\n')) {
    const text = line.trim();
    if (text === 'red' || text === 'green') found = text;
  }
  return found;
}

/**
 * 有认得出的结论行就听它（同一个提交去重之后改写的那一行）。没有，或正文认不出，听红 / 已恢复谁建立得晚。
 */
export function storedMainCiVerdict(
  body: string | null | undefined,
  red: { createdAt: Date; id: string } | null,
  recovered: { createdAt: Date; id: string } | null,
): MainCiVerdict | null {
  return verdictFromBody(body) ?? verdictFromAlerts(red, recovered);
}

/**
 * 提醒表里红、已恢复各最新一条，谁新听谁的。同一时刻按 id 排（和 latestAlertByPrefix 的次序同一套）。
 * 两条都没有回 null。没有结论行时才用这个。
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

/** 该推的已经了结（推成了，或这个提交推过、不再推）之后，结论和上次不同就改写结论行。推没了结的不改。 */
async function rememberIfMoved(
  deps: MainRedPushDeps,
  input: {
    scanned: number;
    found: number;
    previous: MainCiVerdict | null;
    verdict: MainCiVerdict;
    link: string;
  },
): Promise<SweepPart> {
  if (input.previous === input.verdict) {
    return { scanned: input.scanned, found: input.found, unchecked: [] };
  }
  try {
    await deps.rememberVerdict({ verdict: input.verdict, link: input.link });
  } catch (err) {
    return {
      scanned: input.scanned,
      found: input.found,
      unchecked: [unread(`主线红：记下这次结论没成：${errMessage(err)}`)],
    };
  }
  return { scanned: input.scanned, found: input.found, unchecked: [] };
}

/**
 * 看最近一次已结束的主线 push 运行。变红推一条，转绿（上一次是红）推「已恢复」。
 * 同一个提交已经推过就不再推，但结论变了仍改写结论行。
 * 推不出去、读不到：回没查成，不记已推，也不改结论。
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
  // cancelled、进行中、别的已结束结论：judgeMainCi 原样交回上一次，这里不推也不改结论行。
  const conclusive =
    finished.status === 'completed' &&
    (finished.conclusion === 'failure' || finished.conclusion === 'success');
  if (!conclusive || verdict === null) return { scanned: runs.length, found: 0, unchecked: [] };

  // 还是红、但是另一个提交：要再推一次。同一个提交由去重键挡住，结论仍要改写。
  const notifyRed = verdict === 'red';
  const notifyGreen = verdict === 'green' && previous === 'red';
  // 本来就是绿的、或还停在同一种颜色且这一轮没有要推的：不记结论行。
  if (!notifyRed && !notifyGreen) return { scanned: runs.length, found: 0, unchecked: [] };
  const problem = badRun(finished);
  if (problem) return { scanned: runs.length, found: 0, unchecked: [unread(problem)] };

  const part = await deliver(
    deps,
    notifyGreen
      ? {
          scanned: runs.length,
          key: mainRecoveredPushKey(finished.sha),
          title: MAIN_RECOVERED_PUSH_TITLE,
          text: recoveredText(finished),
          link: finished.url,
        }
      : {
          scanned: runs.length,
          key: mainRedPushKey(finished.sha),
          title: MAIN_RED_PUSH_TITLE,
          text: redText(finished),
          link: finished.url,
        },
  );
  if (part.failed || part.unchecked.length > 0) return part;
  return rememberIfMoved(deps, {
    scanned: part.scanned,
    found: part.found,
    previous,
    verdict,
    link: finished.url,
  });
}
