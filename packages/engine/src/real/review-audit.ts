// 所有已合并出口共用同一份正式评审补读：读到未解决CR或未读成均记未送达，写账失败交原活动重试。
import type { RepoRef } from '@fleet-dao/github';
import { errMessage } from '@fleet-dao/shared/util';
import type { PortContext } from '../ports.ts';
import type { ReviewChange } from '../task-contract.ts';
import type { MergeLog } from './merge-receipt.ts';

export interface LateReviewNote {
  repo: RepoRef;
  prNumber: number;
  /** 读到的正式评审；补读没读成为null。 */
  review: ReviewChange | null;
  error?: string;
  workflowId?: string | undefined;
}

export interface ReviewAuditDeps {
  /** 同冷验收及合前读取器；不给只兼容旧测试，生产必给。 */
  reviewChanges?: (repo: RepoRef, prNumber: number) => Promise<ReviewChange[]>;
  /** 未送达明账；写失败必须抛错，不能当成已经记过。生产必给。 */
  onLateReview?: (note: LateReviewNote) => Promise<void>;
}

export function createReviewAudit(deps: ReviewAuditDeps, log: MergeLog) {
  return async (repo: RepoRef, prNumber: number, ctx: PortContext): Promise<void> => {
    if (deps.reviewChanges === undefined) return;
    const workflowId = ctx.workflowId;
    let late: ReviewChange[];
    try {
      late = await deps.reviewChanges(repo, prNumber);
    } catch (error) {
      log('PR 合并后补读正式评审没读成，不知道有没有晚到的「要求改」', {
        prNumber,
        error: errMessage(error),
      });
      await deps.onLateReview?.({ repo, prNumber, review: null, error: errMessage(error), workflowId });
      return;
    }
    for (const review of late) {
      // 写成功后才声称留账；写不成抛错，活动重试仍会再补读及写账。
      await deps.onLateReview?.({ repo, prNumber, review, workflowId });
      log('PR 合并时还挂着正式「要求改」的评审，无法送达下一工人', {
        prNumber,
        reviewId: review.reviewId,
        commitId: review.commitId,
      });
    }
  };
}
