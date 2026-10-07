// 每小时对账的一部分（#1198）：单已经关了、任务工作流还在跑或停着，就给它发现成的「放弃」信号（走 taskAbandonSignal，不新造）。
// 起因：#1182 被 PR 关掉了，它的任务还挂在「卡住了」，占着并发位（MAX_RUNNING_TASKS）、驾驶舱一直当异常报。
// 只有一条规则：单关了才撤。读不到单的状态记「没查成」，不撤、不当成单还开着也不当成已关；工作流已经结束的收不到信号，不算问题。

import type { RepoRef } from '@fleet-dao/github';
import type { AbandonCommand } from '@fleet-dao/shared/task-signals';
import { errMessage } from '@fleet-dao/shared/util';
import type { ReconcileLog, SweepPart } from './reconcile-common.ts';

/** 发「放弃」信号时记的「谁」「为什么」。 */
export const CLOSED_ISSUE_ABANDON_BY = 'engine:hourly-reconcile';
export const CLOSED_ISSUE_ABANDON_REASON = '单已关闭';

export interface ClosedIssueTaskDeps {
  closedIssueTasks: {
    /** 在跑（含停着等人）的任务工作流编号，形如 task:<owner>/<repo>#<号>。列不出来照抛。 */
    runningTaskWorkflowIds(): Promise<string[]>;
    /** 这张单此刻开没开着。读不到、是 PR 都照抛。 */
    issueState(repo: RepoRef, issueNumber: number): Promise<'open' | 'closed'>;
    /** 发放弃信号；收信人不在（刚结束）回 'gone'；别的错照抛。 */
    abandon(workflowId: string, command: AbandonCommand): Promise<'sent' | 'gone'>;
  };
  now: () => Date;
  log: ReconcileLog;
}

/** 工作流编号拆成仓和单号（拼法在 @fleet-dao/shared/workflow-ids 的 taskWorkflowId）；认不出回 null。 */
export function parseTaskWorkflowId(id: string): { repo: RepoRef; issueNumber: number } | null {
  const m = /^task:([^/]+)\/([^#]+)#(\d+)$/.exec(id);
  if (!m?.[1] || !m[2] || !m[3]) return null;
  return { repo: { owner: m[1], name: m[2] }, issueNumber: Number(m[3]) };
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
