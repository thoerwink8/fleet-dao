// 停下等人的单按规则续一次（#3294，法国指挥官第 1/3 片）：不用模型，每 10 分钟看一遍停着的引擎任务。
// 只续两类停法（task-contract.ts 的 AUTO_RETRY_PARK_KINDS）：失败分流认不出、按临时的办（transient），自动合并没挂上（unarmed）。
// 满足任一条件就发一次「继续」：停下之后法国已经发过新版（current 链接切换的时刻晚于停下）；或现读这张 PR 必过检查全绿、
// 头还是停下时那个、可以合（和停在合并这一步自己复核同一个 mergeReady）。
// 改这里之前必须知道：
// - 每次停下最多续一次：「继续」带上停下的编号（parkSeq），工作流只认正停着的那一次、没被引擎续过的（workflows/task-runtime.ts）；
//   同一原文（停法 + 标题 + 原因）引擎续过的再停下，工作流在查询里标 retriedBefore，这里不再续，交人。
// - 额度超预算、体量超预算、改标准等人闸、轮数用尽、别的一律不续。老历史没有停法（status.park 缺），不续。
// - 停法、编号、停在哪个头都现问工作流（taskStatus 查询），不信库里的字。库只用来列 stalled 的引擎任务和它们的工作流编号。
// - 先写操作记录（actor 是引擎、reason 写为什么续）、再发「继续」、最后撤提醒：工作流收到这一次就标「已续」不再重试，
//   所以记录写不进就不发，下一轮再来；发的时候出错，记录已经写了，下一轮可能再写一条（宁可多记不漏记）。一张单出错不挡别的单：记进 problems，这一轮记 partial。
import type { ScheduleResult } from '@fleet-dao/db';
import { errMessage } from '@fleet-dao/shared/util';
import {
  AUTO_RETRY_PARK_KINDS,
  type ContinueCommand,
  PARKED_RETRY_ACTOR,
  type ParkKind,
  type TaskParkInfo,
} from '../task-contract.ts';
import type { ScheduleRunLog } from './github-reconcile.ts';
import { stamp } from './reconcile-common.ts';

export const PARKED_RETRY_EVERY_MINUTES = 10;
/** 和每 5 分钟的看门狗、拉单错开。 */
export const PARKED_RETRY_OFFSET_MINUTES = 4;

export const PARKED_RETRY_JOB = {
  id: 'parked-retry',
  name: '停下等人的单按规则续一次',
  schedule: '每 10 分钟（4 分起）',
  // 连着几轮没跑成才算过期。
  expectEveryMinutes: 60,
} as const;

/** 操作记录的 action。 */
export const PARKED_RETRY_AUDIT = 'task.continue';

const KIND_NAMES: Readonly<Record<ParkKind, string>> = {
  transient: '认不出、按临时的办',
  unarmed: '自动合并没挂上',
  rounds: '轮数用尽',
  quota: '额度超预算',
  size: '体量超预算',
  standard: '改标准等人闸',
  other: '别的',
};

export interface ParkedRetryRow {
  taskId: string;
  owner: string;
  name: string;
  issueNumber: number;
  /** 最近一条记下工作流编号的 runs。没有就不猜。 */
  workflowId: string | null;
  /** 任务行上最近一次卡住的原因（指挥官认老历史的停法用，#3423）；没读到是缺省。 */
  lastProblem?: string | null;
}

/** 现问工作流读到的那几样（taskStatus 查询）。 */
export interface ParkedSnapshot {
  phase: string;
  prNumber: number | null;
  park?: TaskParkInfo | undefined;
}

/** 法国在用的那一版：提交号和 current 切过去的时刻。 */
export interface ReleaseFact {
  sha: string;
  at: Date;
}

export interface ParkedRetryDeps {
  /** state=stalled、executor=engine 的任务。读不到照抛。 */
  tasks(): Promise<ParkedRetryRow[]>;
  /** 现问工作流；工作流已经没了回 gone。别的错照抛。 */
  status(workflowId: string): Promise<ParkedSnapshot | 'gone'>;
  /** 法国在用的版本；这台不是法国、current 不在回 null。读不到照抛。 */
  release(): Promise<ReleaseFact | null>;
  /** 现读 PR（只读）：开着、头还是 expectedHead、没有挂着的「要求改」、必过检查全绿。读不到照抛。 */
  mergeReady(
    repo: { owner: string; name: string },
    prNumber: number,
    expectedHead: string,
  ): Promise<{ ready: boolean; why: string }>;
  /** 发「继续」；工作流已经没了回 gone。 */
  continueTask(workflowId: string, command: ContinueCommand): Promise<'sent' | 'gone'>;
  /** 写操作记录（发「继续」之前写）。写不进照抛，这一轮就不发。 */
  audit(entry: { row: ParkedRetryRow; workflowId: string; park: TaskParkInfo; why: string }): Promise<void>;
  /** 「继续」发出去之后撤这一次停下的提醒。 */
  resolveAlert(entry: {
    row: ParkedRetryRow;
    workflowId: string;
    park: TaskParkInfo;
    why: string;
  }): Promise<void>;
  runs: ScheduleRunLog;
  now: () => Date;
  log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

export interface ParkedRetryResult {
  /** 库里列出的 stalled 引擎任务数。 */
  listed: number;
  /** 正停着、记了停法、拿去判的单数。 */
  scanned: number;
  continued: { ref: string; workflowId: string; why: string }[];
  problems: string[];
}

export type ParkedRetryVerdict =
  | { kind: 'skip'; why: string }
  /** 要现读 PR 才判得出来。 */
  | { kind: 'check-pr'; prNumber: number; head: string }
  | { kind: 'continue'; why: string };

/** 一次停下续不续（纯函数）。release 是 null：不知道法国有没有发新版，只看 PR。 */
export function judgeParked(snap: ParkedSnapshot, release: ReleaseFact | null): ParkedRetryVerdict {
  const park = snap.park;
  if (snap.phase !== 'parked' || !park) return { kind: 'skip', why: '没停着，或老历史没记停法' };
  if (!AUTO_RETRY_PARK_KINDS.includes(park.kind))
    return { kind: 'skip', why: `停法是「${KIND_NAMES[park.kind]}」，引擎不续` };
  if (park.retriedBefore) return { kind: 'skip', why: '同一原文引擎已经续过一次，交人' };
  const parkedAt = Date.parse(park.at);
  if (release && Number.isFinite(parkedAt) && release.at.getTime() > parkedAt) {
    return {
      kind: 'continue',
      why: `停下（${stamp(new Date(parkedAt))}）之后法国发了新版 ${release.sha.slice(0, 12)}（${stamp(release.at)}）`,
    };
  }
  if (snap.prNumber !== null && park.head !== null)
    return { kind: 'check-pr', prNumber: snap.prNumber, head: park.head };
  return { kind: 'skip', why: '停下之后没发新版，也没有 PR 可现读' };
}

function refOf(row: ParkedRetryRow): string {
  return `${row.owner}/${row.name}#${row.issueNumber}`;
}

/** SDK 外层错误不含 RPC 原因（#3659）；有界保留 cause，不展开任意对象或循环。 */
export function failureDetail(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while ((current !== undefined || parts.length === 0) && !seen.has(current) && parts.length < 4) {
    seen.add(current);
    const message = errMessage(current);
    parts.push(message.length > 240 ? `${message.slice(0, 239)}…` : message);
    current =
      typeof current === 'object' && current !== null && 'cause' in current ? current.cause : undefined;
  }
  return parts.join(' → ');
}

/** 判一张、要续就续。出错照抛，由调用方记进 problems。 */
async function retryOne(
  deps: ParkedRetryDeps,
  row: ParkedRetryRow,
  workflowId: string,
  release: ReleaseFact | null,
  result: ParkedRetryResult,
): Promise<void> {
  const snap = await deps.status(workflowId);
  if (snap === 'gone' || snap.phase !== 'parked' || !snap.park) return;
  result.scanned += 1;
  const park = snap.park;
  let verdict = judgeParked(snap, release);
  if (verdict.kind === 'check-pr') {
    const got = await deps.mergeReady({ owner: row.owner, name: row.name }, verdict.prNumber, verdict.head);
    verdict = got.ready
      ? { kind: 'continue', why: `现读 PR #${verdict.prNumber}：${got.why}，可以合` }
      : { kind: 'skip', why: `现读 PR #${verdict.prNumber}：${got.why}` };
  }
  if (verdict.kind !== 'continue') {
    deps.log('info', '引擎续停：这一张不续', { ref: refOf(row), workflowId, why: verdict.why });
    return;
  }
  const why = `引擎续的（停法「${KIND_NAMES[park.kind]}」，第 ${park.seq} 次停下「${park.title}」）：${verdict.why}`;
  // 先记操作记录、再发继续：工作流收到这一次就标「已续」，之后不会再续；记录写不进就不发，留到下一轮再试，不留下没记录的续
  try {
    await deps.audit({ row, workflowId, park, why });
  } catch (err) {
    result.problems.push(`${refOf(row)} 操作记录没写进，没发继续，下一轮再试：${failureDetail(err)}`);
    return;
  }
  const sent = await deps.continueTask(workflowId, { by: PARKED_RETRY_ACTOR, note: why, parkSeq: park.seq });
  if (sent === 'gone') return;
  result.continued.push({ ref: refOf(row), workflowId, why });
  deps.log('info', '引擎续停：已发继续', { ref: refOf(row), workflowId, why });
  // 继续发出去了才撤这一次停下的提醒
  try {
    await deps.resolveAlert({ row, workflowId, park, why });
  } catch (err) {
    result.problems.push(`${refOf(row)} 已续，但这一次停下的提醒没撤掉：${failureDetail(err)}`);
  }
}

/** 过一遍停着的引擎任务。列不出、读不到法国版本照抛。 */
export async function retryParkedTasks(deps: ParkedRetryDeps): Promise<ParkedRetryResult> {
  const rows = await deps.tasks();
  const release = await deps.release();
  const result: ParkedRetryResult = { listed: rows.length, scanned: 0, continued: [], problems: [] };
  for (const row of rows) {
    if (!row.workflowId) continue;
    try {
      await retryOne(deps, row, row.workflowId, release, result);
    } catch (err) {
      result.problems.push(`${refOf(row)} 没判成：${failureDetail(err)}`);
    }
  }
  return result;
}

export class ParkedRetryFailedError extends Error {
  readonly runId: number;
  constructor(runId: number, message: string) {
    super(message);
    this.name = 'ParkedRetryFailedError';
    this.runId = runId;
  }
}

/** 跑一轮。记开始就失败（库连不上）原样抛；没跑成记 failed 再抛 ParkedRetryFailedError。 */
export async function runParkedRetryJob(deps: ParkedRetryDeps): Promise<ScheduleResult> {
  const runId = await deps.runs.start(PARKED_RETRY_JOB.id, deps.now());
  let result: ScheduleResult;
  let got: ParkedRetryResult | undefined;
  try {
    got = await retryParkedTasks(deps);
    const line = `停着的引擎任务 ${got.listed} 张，记了停法正停着的 ${got.scanned} 张，续了 ${got.continued.length} 张`;
    // 没有停着的单是常态，不记 unscanned（那样看门狗会当成一直没跑成）：列过一遍就算扫了一样，和 cli-upgrade 同一个记法
    result =
      got.problems.length > 0
        ? { outcome: 'partial', why: `${line}；${got.problems.slice(0, 3).join('；')}` }
        : { outcome: 'ok', scanned: Math.max(1, got.listed), found: got.continued.length, why: line };
  } catch (err) {
    result = { outcome: 'failed', why: `引擎续停没跑成：${failureDetail(err)}` };
  }
  await deps.runs.finish(runId, result, deps.now());
  if (result.outcome === 'failed') {
    deps.log('error', '引擎续停这一轮没跑成', { runId, why: result.why });
    throw new ParkedRetryFailedError(runId, result.why);
  }
  deps.log('info', '引擎续停跑完', { runId, continued: got?.continued ?? [], problems: got?.problems ?? [] });
  return result;
}
