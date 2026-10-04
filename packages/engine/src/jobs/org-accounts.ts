// 切之前先逐个查账号状态（#194，创始人 2026-10-04 约 22:30 原话，见 docs/PROGRESS.md「创始人引导」和方案对照表）：
// 「拼车切独享，需要考虑几个点，账号数量不固定；切之前检查每个账号状态，比如拼车被封了，或者独享被封了，账号池可用为 1 or 0
// 就不需要切了，如果为 0 渠道不可用」。纯判法，不碰库、不碰网。
//
// 改这里之前必须知道：
// - 账号数量不固定：账号清单是 reclaude 接口（GET /api/v1/orgs）里实际有几个组织就几个，没有「一个拼车 + 一个独享」的写死。
// - 读不到状态的账号是 unknown：不数进「可用」（方案第六节 B9：读不到不当成能用）。可用数只数明确读到 available 的。
// - 可用 ≥ 2 才有得选；切去的那一类里至少要有 1 个明确可用的。可用 1 个：没得选，不切（但会明说，不静默——要是当前挂着的
//   那个不可用、唯一可用的在另一边，这是「要人看」，不是「没事」）；可用 0 个：整个渠道不可用（要明确状态和告警，恢复了自动恢复）。
// - 清单里还有 unknown 时，没法确认到底是 0 个、1 个还是更多：判 unknown，不切、也不标渠道不可用（标了是误报，切了是拿猜的顶），
//   报「读不到账号状态」。
import type { OrgKind } from '@fleet-dao/shared';

export type AccountStatus = 'available' | 'banned' | 'unavailable' | 'unknown';

export interface PoolAccount {
  /** 清单里的稳定编号（接口给的组织编号不进库、不进提醒：编号只在内存里区分几个账号，对外一律用 label）。 */
  id: string;
  kind: OrgKind;
  status: AccountStatus;
  /** 给人看：这个账号为什么是这个状态。不带编号、邮箱。 */
  why: string;
}

/** 账号清单读没读成：没读成时 accounts 可能是按库里的池猜出的空壳（全是 unknown），why 说明原因。 */
export interface AccountRoster {
  accounts: readonly PoolAccount[];
  readOk: boolean;
  readWhy: string;
}

/**
 * ok：可用 ≥ 2；
 * single：可用正好 1 个（没得选）；
 * unavailable：清单读成了、一个都不可用（0 个）：整个渠道不可用；
 * unknown：读不到状态、又不足以确认可用数。
 */
export type ChannelState = 'ok' | 'single' | 'unavailable' | 'unknown';

export interface AccountsVerdict {
  channel: ChannelState;
  availableCount: number;
  /** 每一类各有几个、几个明确可用、几个读不到。 */
  byKind: Record<OrgKind, { total: number; available: number; unknown: number }>;
  /** 给人看的一句话：几个可用、哪些不可用以及为什么。 */
  summary: string;
}

const KINDS: readonly OrgKind[] = ['carpool', 'solo'];
const KIND_NAME: Record<OrgKind, string> = { carpool: '拼车', solo: '独享' };
const STATUS_NAME: Record<Exclude<AccountStatus, 'available'>, string> = {
  banned: '被封或没分到账号',
  unavailable: '不可用',
  unknown: '读不到状态',
};

export function judgeAccounts(roster: AccountRoster): AccountsVerdict {
  const byKind = Object.fromEntries(KINDS.map((k) => [k, { total: 0, available: 0, unknown: 0 }])) as Record<
    OrgKind,
    { total: number; available: number; unknown: number }
  >;
  let available = 0;
  let unknown = 0;
  for (const a of roster.accounts) {
    byKind[a.kind].total += 1;
    if (a.status === 'available') {
      available += 1;
      byKind[a.kind].available += 1;
    } else if (a.status === 'unknown') {
      unknown += 1;
      byKind[a.kind].unknown += 1;
    }
  }
  // 清单没读成又什么都没列出来：不是「0 个账号」，是不知道
  const unreadable = !roster.readOk && roster.accounts.length === 0;
  const lines = roster.accounts
    .filter((a) => a.status !== 'available')
    .map(
      (a) =>
        `${KIND_NAME[a.kind]}账号${STATUS_NAME[a.status as Exclude<AccountStatus, 'available'>]}（${a.why}）`,
    );
  const detail = lines.length > 0 ? `；${lines.join('；')}` : '';
  const readNote = roster.readOk ? '' : `；账号清单没读成：${roster.readWhy}`;
  const counted = `共 ${roster.accounts.length} 个账号，明确可用 ${available} 个`;
  const make = (channel: ChannelState, head: string): AccountsVerdict => ({
    channel,
    availableCount: available,
    byKind,
    summary: `${head}（${counted}${detail}${readNote}）`,
  });
  if (unreadable) return make('unknown', '读不到账号状态，不当成可用');
  if (available >= 2) return make('ok', '账号状态正常');
  if (unknown > 0) {
    return make(
      'unknown',
      `有 ${unknown} 个账号读不到状态，分不清可用数是 ${available} 还是更多，不当成可用`,
    );
  }
  if (available === 1) return make('single', '只剩 1 个可用账号，没得选');
  return make('unavailable', '没有一个可用账号，整个渠道不可用');
}

export type SwitchGate = { ok: true } | { ok: false; why: string; kind: ChannelState | 'no-target' };

/**
 * 从一类切到另一类之前过这一关：渠道得是 ok（可用 ≥ 2），而且要切去的那一类里至少有 1 个明确可用的。
 * 不过关一律带白话原因，由调用方写进「不切」的理由和提醒，不静默。
 */
export function gateSwitch(verdict: AccountsVerdict, from: OrgKind, to: OrgKind): SwitchGate {
  if (verdict.channel === 'unavailable') {
    return { ok: false, kind: 'unavailable', why: `渠道不可用：${verdict.summary}` };
  }
  if (verdict.channel === 'unknown') {
    return { ok: false, kind: 'unknown', why: `不切：${verdict.summary}` };
  }
  if (verdict.channel === 'single') {
    const only = KINDS.find((k) => verdict.byKind[k].available > 0);
    const where =
      only === from
        ? `唯一可用的就是现在挂着的${KIND_NAME[from]}账号，没有可切的`
        : `唯一可用的在${only ? KIND_NAME[only] : '别处'}，不自动切（要人看：当前挂的${KIND_NAME[from]}账号不可用时，这是要人动手的事）`;
    return { ok: false, kind: 'single', why: `不切：只剩 1 个可用账号，${where}。${verdict.summary}` };
  }
  if (verdict.byKind[to].available === 0) {
    return {
      ok: false,
      kind: 'no-target',
      why: `不切：${KIND_NAME[to]}那边没有明确可用的账号（${KIND_NAME[to]} ${verdict.byKind[to].total} 个，读不到状态 ${verdict.byKind[to].unknown} 个）。${verdict.summary}`,
    };
  }
  return { ok: true };
}

/** 接口里一个组织的原始事实（adapters 读出来的，已去掉编号、邮箱）。 */
export interface ApiOrgAccount {
  id: string;
  kind: OrgKind | 'other';
  /** null = 回包里没给、认不出。 */
  hasAssignedAccount: boolean | null;
  /** null = 没给到期日。 */
  expiresAt: Date | null;
}

/**
 * 接口的组织清单 + 库里整池暂停着的池 → 账号清单。
 * - 没分到账号（false）= banned；认不出（null）= unknown；已到期 = unavailable；类型认不出（other）的不数，也不当成可用；
 * - 这一类的池在库里全部整池暂停着（登录失效、封号，等人处理）→ 这一类的账号都是 unavailable；
 * - 接口没读成：按库里有的池给空壳账号（unknown），一个池都没有就是空清单；readOk=false 由调用方带原因。
 */
export function buildRoster(input: {
  api: { ok: true; accounts: readonly ApiOrgAccount[] } | { ok: false; why: string };
  /** 库里带组织类型的池：id、哪一类、整池暂停着没有。 */
  pools: ReadonlyArray<{ poolId: string; kind: OrgKind; held: boolean }>;
  now: Date;
}): AccountRoster {
  const heldKind = (k: OrgKind): boolean => {
    const ofKind = input.pools.filter((p) => p.kind === k);
    return ofKind.length > 0 && ofKind.every((p) => p.held);
  };
  if (!input.api.ok) {
    return {
      readOk: false,
      readWhy: input.api.why,
      accounts: input.pools.map((p, i) => ({
        id: `pool-${i}`,
        kind: p.kind,
        status: 'unknown' as const,
        why: `账号清单读不到，库里有这个池（${p.poolId}）但不知道账号状态`,
      })),
    };
  }
  const accounts: PoolAccount[] = [];
  for (const a of input.api.accounts) {
    if (a.kind === 'other') continue;
    if (heldKind(a.kind)) {
      accounts.push({
        id: a.id,
        kind: a.kind,
        status: 'unavailable',
        why: '这一类的池整池暂停着（登录失效、封号等，等人处理）',
      });
    } else if (a.hasAssignedAccount === false) {
      accounts.push({
        id: a.id,
        kind: a.kind,
        status: 'banned',
        why: '接口说没分到 Claude 账号（被封或被收回，reclaude 还没换上新号）',
      });
    } else if (a.hasAssignedAccount === null) {
      accounts.push({ id: a.id, kind: a.kind, status: 'unknown', why: '接口回包里没说分没分到账号' });
    } else if (a.expiresAt && a.expiresAt.getTime() <= input.now.getTime()) {
      accounts.push({ id: a.id, kind: a.kind, status: 'unavailable', why: '订阅已到期' });
    } else {
      accounts.push({ id: a.id, kind: a.kind, status: 'available', why: '接口说分到了账号、没到期' });
    }
  }
  return { accounts, readOk: true, readWhy: '' };
}
