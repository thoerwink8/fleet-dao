// 设置页「整池暂停」（#746）用的纯函数：从现状拼出要存的整份值、校验新建的表单、说到期状态。
// 存的永远是整份 {池编号: {reason, decidedBy, revokeWhen, reviewBy, owner}}，在认得出的那些上加、改、删；认不出的项带不进去
// （服务端的 schema 整份校验），要先撤掉（撤要写原因，进操作记录）。负责人没写时视图已补成「指挥官」，存的时候带上。
import { DEFAULT_POOL_HOLD_OWNER, PoolHoldSchema } from '@fleet-dao/shared';
import type { PoolHoldFactView, PoolHolds } from '../api/types';

export interface HoldDraft {
  poolId: string;
  reason: string;
  decidedBy: string;
  revokeWhen: string;
  reviewBy: string;
  owner: string;
}

export const EMPTY_DRAFT: HoldDraft = {
  poolId: '',
  reason: '',
  decidedBy: '',
  revokeWhen: '',
  reviewBy: '',
  owner: DEFAULT_POOL_HOLD_OWNER,
};

type Entries = Record<
  string,
  { reason: string; decidedBy: string; revokeWhen: string; reviewBy: string; owner: string }
>;

/** 现状里认得出的暂停，还原成设置里存的形状（不带 poolId、overdue 这些现算的）。 */
export function entriesOf(holds: readonly PoolHoldFactView[]): Entries {
  return Object.fromEntries(
    holds.map(({ poolId, reason, decidedBy, revokeWhen, reviewBy, owner }) => [
      poolId,
      { reason, decidedBy, revokeWhen, reviewBy, owner },
    ]),
  );
}

const FIELD_NAMES = {
  reason: '为什么停',
  decidedBy: '谁拍的（原话加日期）',
  revokeWhen: '什么条件下撤',
  reviewBy: '最迟复查日期',
  owner: '负责人',
} as const;

/** 新建表单：选了池、四项和负责人都填且合格才行。返回 null = 可以存，否则是缺什么、哪项不对。 */
export function draftProblem(d: HoldDraft, existing: readonly string[]): string | null {
  if (d.poolId.trim() === '') return '先选哪个账号池';
  if (existing.includes(d.poolId)) return `${d.poolId} 已经有一条暂停了，要改请用它那一行的「续期」`;
  const parsed = PoolHoldSchema.safeParse({
    reason: d.reason,
    decidedBy: d.decidedBy,
    revokeWhen: d.revokeWhen,
    reviewBy: d.reviewBy,
    owner: d.owner,
  });
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  const field = issue?.path[0];
  const name =
    typeof field === 'string' && field in FIELD_NAMES
      ? FIELD_NAMES[field as keyof typeof FIELD_NAMES]
      : '这一项';
  return `${name}：${issue?.message ?? '不符合约定'}`;
}

/** 加一条（或换掉同一个池的）。 */
export function withHold(holds: readonly PoolHoldFactView[], d: HoldDraft): Entries {
  return {
    ...entriesOf(holds),
    [d.poolId]: {
      reason: d.reason.trim(),
      decidedBy: d.decidedBy.trim(),
      revokeWhen: d.revokeWhen.trim(),
      reviewBy: d.reviewBy,
      owner: d.owner.trim(),
    },
  };
}

/** 撤掉一个池（只撤认得出的那些里的；认不出的项由 withoutBroken 一起清）。 */
export function withoutHold(holds: readonly PoolHoldFactView[], poolId: string): Entries {
  const next = entriesOf(holds);
  delete next[poolId];
  return next;
}

/** 改一个池的复查日期（续期）。 */
export function withReviewBy(holds: readonly PoolHoldFactView[], poolId: string, reviewBy: string): Entries {
  const next = entriesOf(holds);
  const mine = next[poolId];
  if (mine) next[poolId] = { ...mine, reviewBy };
  return next;
}

/** 改一个池的负责人。 */
export function withOwner(holds: readonly PoolHoldFactView[], poolId: string, owner: string): Entries {
  const next = entriesOf(holds);
  const mine = next[poolId];
  if (mine) next[poolId] = { ...mine, owner: owner.trim() };
  return next;
}

/** 到期状态的白话：没到期给「还有几天」不了解就不说，到期当天、已过几天。 */
export function reviewWords(h: Pick<PoolHoldFactView, 'overdue' | 'overdueDays'>): string | null {
  if (!h.overdue) return null;
  return h.overdueDays === 0 ? '今天要复查' : `已过复查日期 ${h.overdueDays} 天`;
}

/** 整页现状里有没有要人看的红：到期的、认不出的、整份认不出。 */
export function holdsNeedAttention(v: PoolHolds): boolean {
  return v.holdAll || v.problems.length > 0 || v.holds.some((h) => h.overdue);
}

/**
 * 这个池现在算暂停：认得出的、那一项认不出的、整份认不出、还靠旧 pool-hold 提醒顶着的。
 * 引擎选路避开的就是这些；路由页据此不让单独开路由。
 */
export function poolIsHeld(v: PoolHolds, poolId: string): boolean {
  if (v.holdAll) return true;
  if (v.holds.some((h) => h.poolId === poolId)) return true;
  if (v.problems.some((p) => p.poolId === poolId)) return true;
  return v.legacy.some((l) => l.poolId === poolId);
}
