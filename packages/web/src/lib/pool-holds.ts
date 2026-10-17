// 额度页每个池那一行的停用开关（设置 engine.poolHolds）：从现状拼出要存的整份值、校验这一行要填的原因。
// 认得出的还原成 {池编号: {reason, decidedBy, revokeWhen, reviewBy?, owner?}}。认不出的原值（视图的 opaque）必须原样写回，
// 不然关的是这一个池，别的认不出的池会被放开。复查日期可不填。谁拍的、撤回条件由开关代填，人只写一句原因。
import { BeijingDateSchema } from '@fleet-dao/shared';
import type { PoolHoldFactView, PoolHolds } from '../api/types';

/** 额度页关掉池时代填：人只写原因。 */
export const SWITCH_DECIDED_BY = '创始人';
/** 额度页关掉池时代填的撤回条件：打开就是在这一行把开关拨回去。 */
export const SWITCH_REVOKE_WHEN = '创始人在额度页打开这个池';

type HoldEntry = {
  reason: string;
  decidedBy: string;
  revokeWhen: string;
  reviewBy?: string;
  owner?: string;
};

export type HoldEntries = Record<string, HoldEntry>;

function entryOf(h: PoolHoldFactView): HoldEntry {
  return {
    reason: h.reason,
    decidedBy: h.decidedBy,
    revokeWhen: h.revokeWhen,
    ...(h.owner ? { owner: h.owner } : {}),
    ...(h.reviewBy ? { reviewBy: h.reviewBy } : {}),
  };
}

/** 现状里认得出的暂停，还原成设置里存的形状（不带 poolId、overdue 这些现算的）。没填的复查日期不写回去。 */
export function entriesOf(holds: readonly PoolHoldFactView[]): HoldEntries {
  return Object.fromEntries(holds.map((h) => [h.poolId, entryOf(h)]));
}

/**
 * 撤掉一个池。认得出的留下，认不出的原值（opaque）也留下；只删正在打开的这一个。
 * 不传 opaque 时只动认得出的（调用方没拿到原值就不能假装留住了）。
 */
export function withoutHold(
  holds: readonly PoolHoldFactView[],
  poolId: string,
  opaque: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...opaque, ...entriesOf(holds) };
  delete next[poolId];
  return next;
}

/**
 * 额度页关掉一个池：只收原因和可选的复查日期。谁拍的、撤回条件由这一行代填，不写负责人（视图按指挥官）。
 * 别的池认得出的暂停原样留下；认不出的原值（opaque）也原样留下，不能因为关这一个池把它们丢掉。
 */
export function withPause(
  holds: readonly PoolHoldFactView[],
  poolId: string,
  input: { reason: string; reviewBy: string },
  opaque: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return withPauseMany(holds, [poolId], input, opaque);
}

/**
 * 整渠道暂停：给一串池一起写同一条暂停，写法同 withPause。只写传进来的池；
 * 别的池认得出的暂停、认不出的原值（opaque）都原样留下，不重写、不放开。
 */
export function withPauseMany(
  holds: readonly PoolHoldFactView[],
  poolIds: readonly string[],
  input: { reason: string; reviewBy: string },
  opaque: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const reviewBy = input.reviewBy.trim();
  const entry: HoldEntry = {
    reason: input.reason.trim(),
    decidedBy: SWITCH_DECIDED_BY,
    revokeWhen: SWITCH_REVOKE_WHEN,
    ...(reviewBy ? { reviewBy } : {}),
  };
  const next: Record<string, unknown> = { ...opaque, ...entriesOf(holds) };
  for (const id of poolIds) next[id] = { ...entry };
  return next;
}

/**
 * 整渠道放开：只撤传进来的、而且是认得出的暂停。认不出的原值（opaque）一律原样留下——
 * 看不懂的东西不替人解除；封号这类只在旧提醒里的状态根本不在这份设置里，也碰不到。
 */
export function withoutHolds(
  holds: readonly PoolHoldFactView[],
  poolIds: readonly string[],
  opaque: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const drop = new Set(poolIds);
  return { ...opaque, ...entriesOf(holds.filter((h) => !drop.has(h.poolId))) };
}

/** 额度页一个渠道下各池的暂停分布：整渠道暂停 / 放开能动哪几个、哪几个只能原样留着。 */
export interface ChannelHoldSummary {
  /** 渠道下全部池。 */
  poolIds: string[];
  /** 设置里没有条目：整渠道暂停会写这些。 */
  free: string[];
  /** 认得出的暂停：整渠道放开会撤这些。 */
  held: string[];
  /** 认不出的那一项：两个操作都原样留着，引擎仍按暂停办。 */
  opaque: string[];
  /** 还挂着引擎自己的封号、登录失效等提醒：不在设置里，两个操作都碰不到。 */
  legacy: string[];
  /** on = 一个都没停；paused = 每个池都停着（含认不出的）；mixed = 部分。 */
  state: 'on' | 'paused' | 'mixed';
}

export function channelHoldSummary(v: PoolHolds, poolIds: readonly string[]): ChannelHoldSummary {
  const heldIds = new Set(v.holds.map((h) => h.poolId));
  const opaqueIds = new Set(v.problems.flatMap((p) => (p.poolId ? [p.poolId] : [])));
  const legacyIds = new Set(v.legacy.map((l) => l.poolId));
  const held = poolIds.filter((id) => heldIds.has(id));
  const opaque = poolIds.filter((id) => !heldIds.has(id) && opaqueIds.has(id));
  const free = poolIds.filter((id) => !heldIds.has(id) && !opaqueIds.has(id));
  const stopped = held.length + opaque.length;
  return {
    poolIds: [...poolIds],
    free,
    held,
    opaque,
    legacy: poolIds.filter((id) => legacyIds.has(id)),
    state: stopped === 0 ? 'on' : stopped === poolIds.length ? 'paused' : 'mixed',
  };
}

/** 关掉开关：原因必填；复查日期空着可以，填了必须是日历上的一天。返回 null = 可以存。 */
export function pauseProblem(reason: string, reviewBy: string): string | null {
  if (reason.trim() === '') return '先写一句原因';
  const date = reviewBy.trim();
  if (date === '') return null;
  const parsed = BeijingDateSchema.safeParse(date);
  if (parsed.success) return null;
  return `复查日期：${parsed.error.issues[0]?.message ?? '不符合约定'}`;
}

/** 到期状态的白话：没到期不说，到期当天、已过几天。 */
export function reviewWords(h: Pick<PoolHoldFactView, 'overdue' | 'overdueDays'>): string | null {
  if (!h.overdue) return null;
  return h.overdueDays === 0 ? '今天要复查' : `已过复查日期 ${h.overdueDays} 天`;
}

/**
 * 引擎自己写的 pool-hold 提醒，在额度页收成一个短状态。封号、登录失效都写「封号」；
 * 别的（欠费、设备被撤销）取标题最后一个冒号后面的那截，免得设置页删了之后看不见。
 */
export function legacyRowStatus(title: string): string {
  if (title.includes('封号') || title.includes('登录失效')) return '封号';
  const tail = title.split('：').pop()?.trim() ?? '';
  return tail === '' || tail === title ? '要人看' : tail;
}

/**
 * 这一行的暂停设置读不成：查询失败、整份认不出、这一项认不出。还在读（没有数据也没有错）不算。
 * 引擎那边读不到仍按暂停办；这里只决定要不要标「没查成」。
 */
export function poolSettingUnread(v: PoolHolds | undefined, error: boolean, poolId: string): boolean {
  if (error) return true;
  if (!v) return false;
  if (v.holdAll) return true;
  return v.problems.some((p) => p.poolId === null || p.poolId === poolId);
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
