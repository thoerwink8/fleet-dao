// 每小时对账的一部分（#1198 / #1816 / #3002）：单已经关了，任务停着等人（phase=parked），或已经停在检查点
// （phase=paused 且 waiting.kind=paused）并且没有开着的会话，就发「放弃」信号（走 taskAbandonSignal，不新造），
// 并撤掉挂起提醒，操作记录写「单已关，自动放弃」。
// 起因：#1182 被 PR 关掉了还挂着；#1795 关单后停下等人的任务没人会再拍；#2928 关单后软暂停停在检查点，
// 只认 parked 的门把放弃跳过，任务一直 running。
// 还在跑（implement / ci / verify / merge）、软暂停还没到检查点、检查点上仍有开着的会话，都不走这一支。
// 发信号前再读一次单状态和停法：中间已经继续、或单又开了，就不动。
// 读不到单的状态、停法、开着的会话数，记「没查成」，不撤；空的会话数不当成没有会话。工作流已经结束的收不到信号，不算问题。
// 收到 GitHub 的 issues.closed 时也走这一个函数（jobs/closed-issue-events.ts），只看那一张单；已经记过的投递由这一轮再看还在跑的工作流。

import { LOCAL_LABEL, MOTHER_LABEL } from '@fleet-dao/conventions';
import { type OpenTaskRow, requireOpenRunCount } from '@fleet-dao/db';
import type { RepoRef } from '@fleet-dao/github';
import type { AbandonCommand } from '@fleet-dao/shared/task-signals';
import { errMessage } from '@fleet-dao/shared/util';
import { parseTaskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import type { ReconcileLog, SweepPart } from './reconcile-common.ts';

export { parseTaskWorkflowId };

/** 发「放弃」信号、撤挂起提醒时记的「谁」「为什么」。 */
export const CLOSED_ISSUE_ABANDON_BY = 'engine:hourly-reconcile';
/** 放弃信号的 reason，也是撤提醒正文「已撤：」和操作记录里的那一句。 */
export const CLOSED_ISSUE_ABANDON_REASON = '单已关，自动放弃';
export const CLOSED_ISSUE_IDLE_STOP_REASON = '单已关闭，没有工作流在跑';
export const NEVER_DISPATCHED_STOP_REASON = '单是母单或本机做，引擎不派';

/**
 * 关单收尾看见的停法。parked＝停着等人，可以放弃。
 * paused＝已经停在检查点（phase=paused 且 waiting.kind=paused），只有 openSessions 是整数 0 才可以放弃。
 * busy＝还在跑、还没到检查点，或认不出，不动。
 */
export type ClosedIssueHold =
  | { kind: 'parked' }
  | { kind: 'paused'; openSessions: number }
  | { kind: 'busy' };

export interface ClosedIssueTaskDeps {
  closedIssueTasks: {
    /** 在跑（含停着等人）的任务工作流编号，形如 task:<owner>/<repo>#<号> 或重做后的 :r2。列不出来照抛。 */
    runningTaskWorkflowIds(): Promise<string[]>;
    /** 这个任务工作流是不是停着等人（phase = parked）。查不到照抛，不当成没挂着。关单收尾在有 holdForClose 时不问它。 */
    isParked(workflowId: string): Promise<boolean>;
    /**
     * 关单收尾用的停法。真装配必须提供。不提供时只看 isParked（旧测试装配）：true＝parked，false＝busy。
     * 查不到、会话数认不出都照抛，不当成没停着、也不当成没有会话。
     */
    holdForClose?(workflowId: string): Promise<ClosedIssueHold>;
    /** 撤掉这个工作流还开着的挂起提醒（task:…:park:N）；why 进正文「已撤：」和操作记录，by 记是谁撤的（不给是每小时对账）。回实际新撤了几条。 */
    resolveParkAlerts(workflowId: string, why: string, by?: string): Promise<number>;
    /** 库里还没到终态的任务行。旧的测试装配可以不提供，真装配必须提供。 */
    openTaskRows?(): Promise<OpenTaskRow[]>;
    /** 把仍未到终态的任务行改成 stopped，返回实际改了几条。 */
    stopRows?(taskIds: readonly string[], reason: string): Promise<number>;
    /** 这张单此刻开没开着。读不到、是 PR 都照抛。 */
    issueState(repo: RepoRef, issueNumber: number): Promise<'open' | 'closed'>;
    /** 这个仓开着的单「号 → 标签」。可不提供（不提供就不收母单、本机做的排队行）；读不到照抛。 */
    openIssueLabels?(repo: RepoRef): Promise<ReadonlyMap<number, readonly string[]>>;
    /** 发放弃信号；收信人不在（刚结束）回 'gone'；别的错照抛。 */
    abandon(workflowId: string, command: AbandonCommand): Promise<'sent' | 'gone'>;
  };
  now: () => Date;
  log: ReconcileLog;
}

/** 只撤某一张单、换个署名时给（收到单关了的事件那一路）；不给就是每小时对账那一轮：看所有在跑的任务。 */
export interface AbandonClosedIssueScope {
  /** 只看这张单的任务工作流（各代都算）；仓名不分大小写。 */
  only?: { repo: RepoRef; issueNumber: number };
  /** 放弃信号、撤提醒记的「谁」；不给是 CLOSED_ISSUE_ABANDON_BY。 */
  by?: string;
  /** 日志开头那几个字，分清是哪一路撤的；不给是「每小时对账」。 */
  label?: string;
}

const sameIssue = (
  ref: { repo: RepoRef; issueNumber: number },
  only: { repo: RepoRef; issueNumber: number },
): boolean =>
  ref.issueNumber === only.issueNumber &&
  `${ref.repo.owner}/${ref.repo.name}`.toLowerCase() === `${only.repo.owner}/${only.repo.name}`.toLowerCase();

/** 可以沿标准放弃收尾：停着等人，或已在检查点且开着的会话数是 0。 */
function isAbandonableHold(hold: ClosedIssueHold): boolean {
  return hold.kind === 'parked' || (hold.kind === 'paused' && hold.openSessions === 0);
}

/** 会话数必须是认得出的非负整数。空、小数、负数都抛，不当成没有会话。 */
function normalizeHold(hold: ClosedIssueHold, slug: string): ClosedIssueHold {
  if (hold.kind === 'parked') return { kind: 'parked' };
  if (hold.kind === 'busy') return { kind: 'busy' };
  if (hold.kind === 'paused') {
    return { kind: 'paused', openSessions: requireOpenRunCount(hold.openSessions, slug) };
  }
  const kind = (hold as { kind?: unknown }).kind;
  throw new Error(`${slug} 停法认不出（${String(kind)}），不动`);
}

export async function abandonClosedIssueTasks(
  deps: ClosedIssueTaskDeps,
  scope: AbandonClosedIssueScope = {},
): Promise<SweepPart> {
  const part: SweepPart = { scanned: 0, found: 0, unchecked: [] };
  const by = scope.by ?? CLOSED_ISSUE_ABANDON_BY;
  const label = scope.label ?? '每小时对账';
  const port = deps.closedIssueTasks;
  let ids: string[];
  try {
    ids = await port.runningTaskWorkflowIds();
  } catch (err) {
    return { ...part, failed: `列在跑的任务工作流没成，单关了没关的这一轮没查：${errMessage(err)}` };
  }
  for (const id of ids) {
    const ref = parseTaskWorkflowId(id);
    if (scope.only && (!ref || !sameIssue(ref, scope.only))) continue;
    part.scanned += 1;
    if (!ref) {
      part.unchecked.push(`任务工作流编号 ${id} 认不出是哪张单，没查`);
      continue;
    }
    const slug = `${ref.repo.owner}/${ref.repo.name}#${ref.issueNumber}`;
    // 有 holdForClose 就只问它（真装配）。没有时维持旧装配：isParked 真＝停着等人，假＝还在跑。
    const readHold = async (): Promise<ClosedIssueHold> => {
      const read = port.holdForClose;
      if (read) return normalizeHold(await read.call(port, id), slug);
      return (await port.isParked(id)) ? { kind: 'parked' } : { kind: 'busy' };
    };

    let hold: ClosedIssueHold;
    try {
      hold = await readHold();
    } catch (err) {
      part.unchecked.push(`${slug} 任务停没停着等人没查成，不动：${errMessage(err)}`);
      continue;
    }
    if (!isAbandonableHold(hold)) continue;

    let state: 'open' | 'closed';
    try {
      state = await port.issueState(ref.repo, ref.issueNumber);
    } catch (err) {
      part.unchecked.push(`${slug} 单现在开没开着没读成，任务不动：${errMessage(err)}`);
      continue;
    }
    if (state !== 'closed') continue;
    // 发信号前再确认：关单和暂停/继续可能交错。再确认读失败留下没查成；已经继续或单又开了就悄悄跳过，不记成功。
    try {
      state = await port.issueState(ref.repo, ref.issueNumber);
    } catch (err) {
      part.unchecked.push(`${slug} 发放弃前再确认没查成，任务不动：${errMessage(err)}`);
      continue;
    }
    if (state !== 'closed') continue;
    try {
      hold = await readHold();
    } catch (err) {
      part.unchecked.push(`${slug} 发放弃前再确认没查成，任务不动：${errMessage(err)}`);
      continue;
    }
    if (!isAbandonableHold(hold)) continue;
    try {
      const sent = await port.abandon(id, { by, reason: CLOSED_ISSUE_ABANDON_REASON });
      if (sent !== 'sent') continue;
      part.found += 1;
      const where = hold.kind === 'paused' ? '已在检查点暂停且没有开着的会话' : '停下等人';
      deps.log('info', `${label}：单已关且${where}，给任务发了放弃信号`, { workflowId: id });
      try {
        const resolved = await port.resolveParkAlerts(id, CLOSED_ISSUE_ABANDON_REASON, by);
        if (resolved > 0) {
          deps.log('info', `${label}：单已关，撤掉停下等人的提醒`, {
            workflowId: id,
            resolved,
          });
        }
      } catch (err) {
        part.unchecked.push(`${slug} 单已关已放弃，挂起提醒没撤成：${errMessage(err)}`);
      }
    } catch (err) {
      part.unchecked.push(`${slug} 单已关闭，放弃信号没发成：${errMessage(err)}`);
    }
  }
  return part;
}

/**
 * 收掉没有任务工作流在跑的非终态任务行，避免主页把遗留行算成开着：单已关的；单开着但贴了母单、本机做的
 * （引擎按规矩永远不派，行会一直排着）。
 */
export async function settleIdleClosedIssueRows(deps: ClosedIssueTaskDeps): Promise<SweepPart> {
  const part: SweepPart = { scanned: 0, found: 0, unchecked: [] };
  const port = deps.closedIssueTasks;
  if (!port.openTaskRows || !port.stopRows) return part;

  let rows: OpenTaskRow[];
  try {
    rows = await port.openTaskRows();
  } catch (err) {
    return { ...part, failed: `列非终态任务行没成，遗留行这一轮没查：${errMessage(err)}` };
  }
  part.scanned = rows.length;

  let ids: string[];
  try {
    ids = await port.runningTaskWorkflowIds();
  } catch (err) {
    return { ...part, failed: `列在跑的任务工作流没成，遗留行这一轮没查：${errMessage(err)}` };
  }
  const runningIssues = new Set(
    ids.flatMap((id) => {
      const ref = parseTaskWorkflowId(id);
      return ref ? [`${ref.repo.owner}/${ref.repo.name}#${ref.issueNumber}`] : [];
    }),
  );

  // 一仓只读一次开着的单的标签；读不到的记下错，这个仓的这类行都不动。
  const labelsByRepo = new Map<
    string,
    Promise<{ labels: ReadonlyMap<number, readonly string[]> } | { error: string }>
  >();
  const readLabels = (repo: RepoRef) => {
    const key = `${repo.owner}/${repo.name}`;
    let hit = labelsByRepo.get(key);
    if (!hit) {
      const read = port.openIssueLabels;
      hit = read
        ? read.call(port, repo).then(
            (labels) => ({ labels }),
            (err: unknown) => ({ error: errMessage(err) }),
          )
        : Promise.resolve({ error: '没有读标签的口子' });
      labelsByRepo.set(key, hit);
    }
    return hit;
  };

  for (const row of rows) {
    const slug = `${row.owner}/${row.name}#${row.issueNumber}`;
    if (runningIssues.has(slug)) continue;

    let state: 'open' | 'closed';
    try {
      state = await port.issueState({ owner: row.owner, name: row.name }, row.issueNumber);
    } catch (err) {
      part.unchecked.push(`${slug} 单现在开没开着没读成，任务行不动：${errMessage(err)}`);
      continue;
    }
    if (state !== 'closed') {
      if (!port.openIssueLabels) continue;
      const repo = { owner: row.owner, name: row.name };
      const read = await readLabels(repo);
      if ('error' in read) {
        part.unchecked.push(`${slug} 单开着，读这个仓开着的单的标签没成，任务行不动：${read.error}`);
        continue;
      }
      const labels = read.labels.get(row.issueNumber);
      if (!labels) {
        part.unchecked.push(`${slug} 单开着，但在这个仓开着的单里没找到，任务行不动`);
        continue;
      }
      if (!labels.includes(MOTHER_LABEL) && !labels.includes(LOCAL_LABEL)) continue;
      try {
        const stopped = await port.stopRows([row.taskId], NEVER_DISPATCHED_STOP_REASON);
        if (stopped > 0) {
          part.found += stopped;
          deps.log('info', '每小时对账：单是母单或本机做、引擎不派，收掉排队的任务行', {
            taskId: row.taskId,
            issue: slug,
          });
        }
      } catch (err) {
        part.unchecked.push(`${slug} 单是母单或本机做，任务行没收成：${errMessage(err)}`);
      }
      continue;
    }

    try {
      const stopped = await port.stopRows([row.taskId], CLOSED_ISSUE_IDLE_STOP_REASON);
      if (stopped > 0) {
        part.found += stopped;
        deps.log('info', '每小时对账：单已关闭且没有工作流在跑，收掉遗留任务行', {
          taskId: row.taskId,
          issue: slug,
        });
      }
    } catch (err) {
      part.unchecked.push(`${slug} 单已关闭，遗留任务行没收成：${errMessage(err)}`);
    }
  }
  return part;
}
