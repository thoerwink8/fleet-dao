// 会话用户切号的判法要的事实和判法本身（jobs/org-decision.ts 的 decideOrgSwitch）：切号（real/org-switch.ts：被拒当场、定时读
// 接口、路由探针每一轮）和选路（store-ports：不是挂着的那个组织的池、切回宽限中的池、渠道不可用时等不等得来）读同一份、用同一个
// 判法，口径一个（#335：选路写着「要等切过去才能派」，却不知道引擎切不切）。
//
// 事实：库里带组织类型的池的额度窗口、整池暂停、还没结束的 Claude 会话（db 的 sessionOrgFacts）；账本（落库的恢复条件、切回记录、
// 最近几次接口读数）；账号清单（最近一次接口读数里每个组织一个账号，太旧算读不到）；设置里「引擎暂不用独享」。

import { SESSION_USERS } from '@fleet-dao/adapters';
import {
  type Db,
  type OrgPoolWindow,
  readQuotaReserveSetting,
  readSoloPaused,
  sessionOrgFacts,
} from '@fleet-dao/db';
import { evaluateReserve, type OrgKind, resolvePoolReserve } from '@fleet-dao/shared';
import type { CarpoolApiRead, CarpoolOutage } from '../jobs/carpool-outage.ts';
import { type AccountRoster, buildRoster, judgeAccounts } from '../jobs/org-accounts.ts';
import { decideOrgSwitch, intentOf, type OrgDecision } from '../jobs/org-decision.ts';
import { type OrgLedger, OrgLedgerError, type SoloPause } from '../jobs/org-ledger.ts';
import type { OrgPool, OrgReserveFacts } from '../jobs/org-switch.ts';
import type { LiveOrgReading, OrgPlanView } from '../routing/index.ts';
import { loadLedger } from './org-ledger.ts';

/** 账号状态读数多旧算「读不到」：定时读接口平时 5 分钟一次、紧的时候 1 分钟，三倍的余量。 */
export const ACCOUNTS_FRESH_MS = 15 * 60_000;

export interface PoolInfo {
  poolId: string;
  kind: OrgKind;
  held: boolean;
}

export interface OrgSwitchFactsNow {
  /** 按组织类型合起来的池（拼车、独享）：窗口、整池暂停着没有。 */
  pools: Partial<Record<OrgKind, OrgPool>>;
  /** 库里带组织类型的池，一个一行（账号清单按它判「这一类整池暂停」）。 */
  poolList: PoolInfo[];
  /** 这些池上还没结束的会话数（Fusion 的会话、三段的一次性会话都算）。 */
  busy: number;
  /** 其中三段的一次性会话有几个：切号停不停得下它们，引擎那边判。 */
  busyOneShot: number;
  poolIds: Set<string>;
}

/**
 * 一个池的额度留量线判一遍（#194 方案 4.8）：设置库里没有（undefined，种子没装上）、认不出 → problem；认得出就按这个池的
 * 窗口读数判到线了没有，这个池没写线 = 不限。线只来自库里的设置，这里没有任何默认值。
 */
export function poolReserve(
  pool: { poolId: string; windows: readonly OrgPoolWindow[] },
  setting: unknown,
): OrgReserveFacts {
  const resolved = resolvePoolReserve(setting, pool);
  if (!resolved.ok) return { problem: resolved.why, hits: [], unknown: [] };
  const verdict = evaluateReserve(
    resolved.lines,
    pool.windows.map((w) => ({
      label: w.label,
      window: w.window,
      scope: w.scope,
      state: w.state,
      used: w.used,
      resetsAt: w.resetsAt ? w.resetsAt.toISOString() : null,
    })),
  );
  return { problem: null, hits: verdict.hits, unknown: verdict.unknown };
}

function mergeReserve(a: OrgReserveFacts | undefined, b: OrgReserveFacts): OrgReserveFacts {
  if (!a) return b;
  return {
    problem: a.problem ?? b.problem,
    hits: [...a.hits, ...b.hits],
    unknown: [...a.unknown, ...b.unknown],
  };
}

/** held：整池暂停着的池（pool-hold:<池> 那条要人拍还开着）。库读不了照抛。 */
export async function loadOrgSwitchFacts(
  db: Db,
  options: { now: Date; held: ReadonlySet<string> },
): Promise<OrgSwitchFactsNow> {
  const f = await sessionOrgFacts(db, { now: options.now });
  const reserveSetting = await readQuotaReserveSetting(db);
  const pools: Partial<Record<OrgKind, OrgPool>> = {};
  for (const p of f.pools) {
    const seen = pools[p.orgKind];
    pools[p.orgKind] = {
      windows: [...(seen?.windows ?? []), ...p.windows],
      held: (seen?.held ?? false) || options.held.has(p.poolId),
      reserve: mergeReserve(
        seen?.reserve,
        poolReserve(p, reserveSetting.set ? reserveSetting.value : undefined),
      ),
    };
  }
  return {
    pools,
    poolList: f.pools.map((p) => ({ poolId: p.poolId, kind: p.orgKind, held: options.held.has(p.poolId) })),
    busy: f.busy,
    busyOneShot: f.busyOneShot,
    poolIds: new Set(f.pools.map((p) => p.poolId)),
  };
}

/**
 * 账号清单：账本里最近一次接口读数。没读过、读失败、读成了但组织接口没读成、读数太旧，一律是「清单读不到」（带原因），
 * 由 buildRoster 把库里的池变成读不到状态的空壳账号——不拿「没有读数」当「账号都可用」。
 */
export function rosterFromLedger(ledger: OrgLedger, pools: readonly PoolInfo[], now: Date): AccountRoster {
  const latest: CarpoolApiRead | undefined = ledger.reads.at(-1);
  const stale = (r: CarpoolApiRead) => now.getTime() - r.requestedAt.getTime() > ACCOUNTS_FRESH_MS;
  let api: Parameters<typeof buildRoster>[0]['api'];
  if (!latest) {
    api = { ok: false, why: '还没读过 reclaude 接口' };
  } else if (!latest.ok) {
    api = { ok: false, why: `最近一次读接口没成：${latest.why}` };
  } else if (!latest.accounts) {
    api = { ok: false, why: '最近一次读到了额度，但组织接口没读成，账号清单没有' };
  } else if (stale(latest)) {
    api = {
      ok: false,
      why: `最近一次读到账号状态是 ${Math.round((now.getTime() - latest.requestedAt.getTime()) / 60_000)} 分钟前，太旧`,
    };
  } else {
    api = { ok: true, accounts: latest.accounts };
  }
  return buildRoster({ api, pools, now });
}

/** 设置里「引擎暂不用独享」→ 账本里的暂停记录。值认不出按暂停办（保守，不动创始人的独享），problem 带原因给调用方报错。 */
export async function soloPauseOf(db: Db): Promise<{ pause: SoloPause | null; problem?: string }> {
  const r = await readSoloPaused(db);
  if (r.state === 'off') return { pause: null };
  const by = r.by ?? '（没记谁）';
  if (r.state === 'on') {
    return { pause: { since: r.since, by, reason: '驾驶舱设置里开着「引擎暂不用独享」' } };
  }
  return {
    pause: { since: r.since, by, reason: `${r.why}，认不出，按暂停办` },
    problem: r.why,
  };
}

export interface DecideInput {
  live: LiveOrgReading;
  facts: OrgSwitchFactsNow;
  ledger: OrgLedger;
  now: Date;
  canStopRunning?: boolean;
  rejection?: CarpoolOutage;
  pause: SoloPause | null;
}

/** 一次判：切号和选路都走这里（同一份事实、同一个判法）。 */
export function decideFrom(i: DecideInput): OrgDecision {
  const ledger: OrgLedger = { ...i.ledger, soloPause: i.pause };
  return decideOrgSwitch({
    live: i.live,
    pools: i.facts.pools,
    busy: i.facts.busy,
    ...(i.canStopRunning ? { canStopRunning: true } : {}),
    now: i.now,
    accounts: judgeAccounts(rosterFromLedger(ledger, i.facts.poolList, i.now)),
    ledger,
    ...(i.rejection ? { rejection: i.rejection } : {}),
  });
}

/**
 * 选路要的引擎切号打算：和切号同一份事实、同一个判法。canStopRunning 照真装配（#59 接上了会话端口，有会话在跑也照切）：它只
 * 定「切」还是「等」，不定切到哪个。库读不了照抛（选路照常报没查成，不当成不打算切）；账本认不出（OrgLedgerError）不拖累派活：
 * 回「不打算切」并写明，选路照老样子判。
 */
export async function orgPlanView(
  db: Db,
  options: { live: OrgKind; held: ReadonlySet<string>; now: Date },
): Promise<OrgPlanView> {
  const facts = await loadOrgSwitchFacts(db, options);
  const [user] = SESSION_USERS;
  let ledger: OrgLedger;
  try {
    ledger = await loadLedger(db, user);
  } catch (err) {
    if (err instanceof OrgLedgerError) {
      return { to: null, at: null, why: `${err.message}，引擎不切号（要人看）` };
    }
    throw err;
  }
  const { pause } = await soloPauseOf(db);
  const decision = decideFrom({
    live: { ok: true, org: options.live },
    facts,
    ledger,
    now: options.now,
    canStopRunning: true,
    pause,
  });
  const intent = intentOf(decision, options.live);
  return {
    to: intent.to,
    at: intent.at ? intent.at.toISOString() : null,
    why: intent.why,
    drain: intent.drain,
    channelDown: intent.channelDown,
  };
}
