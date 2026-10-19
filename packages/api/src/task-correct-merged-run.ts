// fleet-api task correct-merged 的执行段：现读 GitHub PR、库里任务行、Temporal 已结束身份，交给 decideCorrection 判；
// 通过了再经 casCorrectMerged 在同一事务里把任务行 CAS 改成 done/merged 并写操作记录。
// 幂等：已经是 done/merged 且身份全部对得上，回「已纠正」，不再写第二条。读失败、拒绝、CAS 失配都明确报错，不假装做成。

import { errMessage } from '@fleet-dao/shared/util';
import {
  type CorrectionRequest,
  type ExecutionFacts,
  type PullFacts,
  type TaskFacts,
  alreadyCorrected,
  CORRECTED_BY_PREFIX,
  decideCorrection,
} from './task-correct-merged.ts';

export interface CorrectMergedPorts {
  /** 现读 GitHub 上的 PR（头、合并提交、是否已合）。读不到抛错。 */
  readPull(repo: { owner: string; name: string }, number: number): Promise<PullFacts | null>;
  /** 现读库里的任务行与开着的会话数。 */
  readTask(repo: { owner: string; name: string }, issueNumber: number): Promise<TaskFacts | null>;
  /** 现读原任务工作流的已结束执行身份。读不到抛错。 */
  readExecution(workflowId: string): Promise<ExecutionFacts | null>;
  /**
   * 原子 CAS：仅当任务行仍是 stopped/abandoned 且 updated_at 等于 expectedUpdatedAtMs 时，
   * 改成 done/merged，并在同一事务里写操作记录。CAS 失配回 'stale'，不写。
   */
  casCorrect(input: {
    taskId: string;
    expectedUpdatedAtMs: number;
    audit: { operator: string; reason: string; evidence: Record<string, unknown> };
  }): Promise<'corrected' | 'stale'>;
}

export type CorrectMergedOutcome =
  | { status: 'corrected'; text: string }
  | { status: 'already'; text: string }
  | { status: 'refused'; reason: string };

export async function runCorrectMerged(
  req: CorrectionRequest,
  operator: string,
  reason: string,
  ports: CorrectMergedPorts,
): Promise<CorrectMergedOutcome> {
  const ref = `${req.repo.owner}/${req.repo.name}#${req.issueNumber}`;
  let pr: PullFacts | null;
  let task: TaskFacts | null;
  let execution: ExecutionFacts | null;
  try {
    pr = await ports.readPull(req.repo, req.prNumber);
    task = await ports.readTask(req.repo, req.issueNumber);
    execution = await ports.readExecution(req.workflowId);
  } catch (err) {
    return { status: 'refused', reason: `读取事实没成（${errMessage(err)}），不纠正` };
  }

  // 幂等：已是纠正后的状态，且身份全部对得上（否则不算已纠正）
  if (alreadyCorrected(task) && task && pr && pr.merged && pr.head === req.head && pr.mergeCommit === req.mergeCommit) {
    return { status: 'already', text: `已纠正（之前已做过）：${ref}` };
  }

  const decision = decideCorrection(req, pr, task, execution);
  if (!decision.ok) return { status: 'refused', reason: decision.reason };
  if (!task) return { status: 'refused', reason: '库里没有这张单的任务' };

  const outcome = await ports.casCorrect({
    taskId: task.id,
    expectedUpdatedAtMs: task.updatedAtMs,
    audit: {
      operator: `${CORRECTED_BY_PREFIX}:${operator}`,
      reason,
      evidence: {
        repo: `${req.repo.owner}/${req.repo.name}`,
        issue: req.issueNumber,
        pr: req.prNumber,
        head: req.head,
        mergeCommit: req.mergeCommit,
        workflowId: req.workflowId,
        runId: req.runId,
        before: decision.before,
        after: decision.after,
      },
    },
  });
  if (outcome === 'stale') {
    return { status: 'refused', reason: '任务行在核对之后变了（并发换代或新运行），拒绝覆盖，请重新预检' };
  }
  return { status: 'corrected', text: `已纠正：${ref}（PR #${req.prNumber} 真实已合，改为 done/merged）` };
}
