// 每小时对账的一部分（#1198）：单已经关了、任务工作流还在跑或停着，就给它发现成的「放弃」信号（走 taskAbandonSignal，不新造）。
// 起因：#1182 被 PR 关掉了，它的任务还挂在「卡住了」，占着并发位（MAX_RUNNING_TASKS）、驾驶舱一直当异常报。
// 只有一条规则：单关了才撤。读不到单的状态记「没查成」，不撤、不当成单还开着也不当成已关；工作流已经结束的收不到信号，不算问题。

import type { OpenTaskRow } from '@fleet-dao/db';
import type { RepoRef } from '@fleet-dao/github';
import type { AbandonCommand } from '@fleet-dao/shared/task-signals';
import { errMessage } from '@fleet-dao/shared/util';
import { parseTaskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import type { ReconcileLog, SweepPart } from './reconcile-common.ts';

export { parseTaskWorkflowId };

/** 发「放弃」信号时记的「谁」「为什么」。 */
export const CLOSED_ISSUE_ABANDON_BY = 'engine:hourly-reconcile';
export const CLOSED_ISSUE_ABANDON_REASON = '单已关闭';
export const CLOSED_ISSUE_IDLE_STOP_REASON = '单已关闭，没有工作流在跑';

export interface ClosedIssueTaskDeps {
  closedIssueTasks: {
    /** 在跑（含停着等人）的任务工作流编号，形如 task:<owner>/<repo>#<号> 或重做后的 :r2。列不出来照抛。 */
    runningTaskWorkflowIds(): Promise<string[]>;
    /** 库里还没到终态的任务行。旧的测试装配可以不提供，真装配必须提供。 */
    openTaskRows?(): Promise<OpenTaskRow[]>;
    /** 把仍未到终态的任务行改成 stopped，返回实际改了几条。 */
    stopRows?(taskIds: readonly string[], reason: string): Promise<number>;
    /** 这张单此刻开没开着。读不到、是 PR 都照抛。 */
    issueState(repo: RepoRef, issueNumber: number): Promise<'open' | 'closed'>;
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
      if (sent === 'sent') {
        part.found += 1;
        deps.log('info', '每小时对账：单已关闭，给还挂着的任务发了放弃信号', { workflowId: id });
      }
    } catch (err) {
      part.unchecked.push(`${slug} 单已关闭，放弃信号没发成：${errMessage(err)}`);
    }
  }
  return part;
}

/** 收掉单已关、但没有任务工作流在跑的非终态任务行，避免主页把遗留行算成开着。 */
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
    if (state !== 'closed') continue;

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
