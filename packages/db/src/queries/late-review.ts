// 正式评审（#2991）没能交到工人手里的记录：PR 已经合了才到的「要求改」，或合并后补读评审没读成（不知道有没有）。
// 这是「未送达 / 未消费」的明账，写成驾驶舱报警：键里带仓、PR 号、review id，重复写（重投、活动重试、事件和合并后补读各写一次）
// 落在同一条上，人处理掉的不会被打开。写不进库抛错，调用方不能当成记过了。
import type { Db } from '../client.ts';
import { insertAlertOnce } from './alerts.ts';

export interface LateReviewNote {
  /** owner/name。 */
  repo: string;
  prNumber: number;
  /** 谁先发现的：事件到时 PR 已合（event），还是合并后补读（merge-audit）。 */
  source: 'event' | 'merge-audit';
  /** 读到的那条评审；补读没读成（不知道有没有）时为 null。 */
  review: { reviewId: number; reviewer?: string | undefined; commitId?: string | null | undefined } | null;
  /** 补读没读成的原因（review 为 null 时写）。 */
  error?: string | undefined;
  /** 对应任务的工作流编号（有才带）和触发的投递编号，用来从报警找回任务。 */
  workflowId?: string | undefined;
  deliveryId?: string | undefined;
}

/** 报警的键：同一条评审只有一条，读不成的按 PR 一条。 */
export function lateReviewKey(n: Pick<LateReviewNote, 'repo' | 'prNumber' | 'review'>): string {
  return n.review === null
    ? `late-review-unread:${n.repo}#${n.prNumber}`
    : `late-review:${n.repo}#${n.prNumber}:${n.review.reviewId}`;
}

/**
 * GitHub 事件到时 PR 已合并（@fleet-dao/github 的 reviewMergeHold 的 onMerged）：记同一份明账。事件没带评审编号（不该发生）记 0，
 * 键仍按仓、PR 区分，不丢。
 */
export function raiseMergedReviewEvent(
  db: Db,
  note: {
    repo: string;
    prNumber: number;
    deliveryId: string;
    review: { id: number; reviewer?: string | undefined; commitId?: string | null | undefined } | null;
  },
): Promise<{ id: string; created: boolean }> {
  return raiseLateReview(db, {
    repo: note.repo,
    prNumber: note.prNumber,
    source: 'event',
    deliveryId: note.deliveryId,
    review: {
      reviewId: note.review?.id ?? 0,
      reviewer: note.review?.reviewer,
      commitId: note.review?.commitId,
    },
  });
}

/** 记一条「评审没交到工人」。已有（开着或人处理过）的不动。 */
export async function raiseLateReview(db: Db, n: LateReviewNote): Promise<{ id: string; created: boolean }> {
  const where = `${n.repo}#${n.prNumber}`;
  const trace = [
    n.workflowId ? `任务工作流 ${n.workflowId}` : '任务工作流不明',
    n.deliveryId ? `投递 ${n.deliveryId}` : null,
    n.source === 'event' ? '来源：评审事件到时 PR 已合并' : '来源：合并后补读评审',
  ]
    .filter((x) => x !== null)
    .join('；');
  if (n.review === null) {
    return insertAlertOnce(db, {
      dedupeKey: lateReviewKey(n),
      level: 'alert',
      taskId: null,
      title: `${where} 合并后没读成正式评审，不知道有没有没交给工人的「要求改」`,
      body: `PR ${where} 已经合并，合并后补读评审失败：${n.error ?? '原因没记'}。\n请到 PR 上看有没有认可审查者的「要求改」；有的话它没能再交给工人（未消费），需要人跟进（另开单）。\n${trace}`,
    });
  }
  const r = n.review;
  return insertAlertOnce(db, {
    dedupeKey: lateReviewKey(n),
    level: 'alert',
    taskId: null,
    title: `${where} 合并后才到的正式「要求改」没交给工人（review ${r.reviewId}）`,
    body: `PR ${where} 上 review ${r.reviewId}（审查者 ${r.reviewer ?? '不明'}，审的提交 ${r.commitId ?? '不明'}）要求改，但 PR 已经合并，这条评审合并时仍没被复审或撤销，引擎来不及（或没能）再交给工人：按未消费处理，可能前面某一轮交过，但意见没落地。\n需要人跟进：另开单修，或到 PR 上回复。\n${trace}`,
  });
}
