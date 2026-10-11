// 每小时对账的一部分（#1198 / #1816）：单已经关了、任务还停着等人（parked/stalled），就发「放弃」信号
// （走 taskAbandonSignal，不新造），并撤掉「动手 N 轮都没过」那条挂起提醒，操作记录写「单已关，自动放弃」。
// 起因：#1182 被 PR 关掉了还挂着；#1795 关单后停下等人的任务没人会再拍，巡查和提醒一直挂着。
// 只有停下等人的才撤：还在跑（不是 parked）的不走这一支——人刚关单时会话可能还在交活。
// 读不到单的状态记「没查成」，不撤、不当成单还开着也不当成已关；工作流已经结束的收不到信号，不算问题。

import { LOCAL_LABEL, MOTHER_LABEL } from '@fleet-dao/conventions';
import type { OpenTaskRow } from '@fleet-dao/db';
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

export interface ClosedIssueTaskDeps {
  closedIssueTasks: {
    /** 在跑（含停着等人）的任务工作流编号，形如 task:<owner>/<repo>#<号> 或重做后的 :r2。列不出来照抛。 */
    runningTaskWorkflowIds(): Promise<string[]>;
    /** 这个任务工作流是不是停着等人（phase = parked）。查不到照抛，不当成没挂着。 */
    isParked(workflowId: string): Promise<boolean>;
    /** 撤掉这个工作流还开着的挂起提醒（task:…:park:N）；why 进正文「已撤：」和操作记录。回实际新撤了几条。 */
    resolveParkAlerts(workflowId: string, why: string): Promise<number>;
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

export async function abandonClosedIssueTasks(deps: ClosedIssueTaskDeps): Promise<SweepPart> {
  const part: SweepPart = { scanned: 0, found: 0, unchecked: [] };
  const port = deps.closedIssueTasks;
  let ids: string[];
  try {
    ids = await port.runningTaskWorkflowIds();
  } catch (err) {
    return { ...part, failed: `列在跑的任务工作流没成，单关了没关的这一轮没查：${errMessage(err)}` };
  }
  for (const id of ids) {
    part.scanned += 1;
    const ref = parseTaskWorkflowId(id);
    if (!ref) {
      part.unchecked.push(`任务工作流编号 ${id} 认不出是哪张单，没查`);
      continue;
    }
    const slug = `${ref.repo.owner}/${ref.repo.name}#${ref.issueNumber}`;

    let parked: boolean;
    try {
      parked = await port.isParked(id);
    } catch (err) {
      part.unchecked.push(`${slug} 任务停没停着等人没查成，不动：${errMessage(err)}`);
      continue;
    }
    if (!parked) continue;

    let state: 'open' | 'closed';
    try {
      state = await port.issueState(ref.repo, ref.issueNumber);
    } catch (err) {
      part.unchecked.push(`${slug} 单现在开没开着没读成，任务不动：${errMessage(err)}`);
      continue;
    }
    if (state !== 'closed') continue;
    try {
      const sent = await port.abandon(id, {
        by: CLOSED_ISSUE_ABANDON_BY,
        reason: CLOSED_ISSUE_ABANDON_REASON,
      });
      if (sent !== 'sent') continue;
      part.found += 1;
      deps.log('info', '每小时对账：单已关且停下等人，给任务发了放弃信号', { workflowId: id });
      try {
        const resolved = await port.resolveParkAlerts(id, CLOSED_ISSUE_ABANDON_REASON);
        if (resolved > 0) {
          deps.log('info', '每小时对账：单已关，撤掉停下等人的提醒', {
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
