// 会话用户切号的总判法（#194，方案 v2 第四～六节 + 创始人 2026-10-04 约 22:30 的账号状态要求）。纯函数：事实进、计划和新账本出，
// 不碰库、不碰网、不看钟（now 由调用方给）。真执行（停会话、帮手切号、写库、推提醒）在 real/org-switch.ts。
//
// 判的顺序（每一步不过都带白话原因，不静默）：
// 1. 挂的是哪个组织认不出 → 不切（和以前一样）；
// 2. 逐个账号看状态（jobs/org-accounts.ts）：渠道不可用 / 只剩 1 个可用 / 读不到状态 → 不切，同时给出渠道状态和要不要推提醒；
// 3. 挂着拼车：有「拼车用不了」的证据（被拒当场判出来的、接口说用不了的、库里额度窗口用满的）→ 切独享（当场、不提前、不给宽限）；
//    人点了「引擎暂不用独享」、独享整池暂停、独享也用满了 → 不切；
// 4. 挂着独享：有记着的恢复条件 → 只认「被拒之后的真新读数」判恢复（jobs/carpool-outage.ts），再过防抖（jobs/org-switch-guard.ts：
//    最小停留、白切退避、切回预算、读不到时试探），能切回了：手上没会话马上切；有会话先停派独享、开跑不到 5 分钟的当场停、
//    其余给宽限 G（方案 4.5，创始人 10-04「按你推荐」= 10 分钟），到点还没完的再停、再切；
//    没有恢复条件（人手动切到独享的、账本丢了）→ 照老判法（拼车没有用满的读数就切回），同样过账号关；
// 5. 帮手切号刚失败、还在退避里（2 → 10 → 30 分钟）→ 这一轮不切。
//
// 改这里之前必须知道：读不到、认不出、对不上，一律明确的「不切 + 原因」，不当成拼车能用、不当成到点了；每条分支在
// test/org-decision.test.ts 里有一条故意造出失败的测试。
import type { OrgKind } from '@fleet-dao/shared';
import {
  type CarpoolOutage,
  DEFAULT_RECOVERY_POLICY,
  judgeCarpoolRecovery,
  OUTAGE_NAMES,
  outageFromApi,
  type RecoveryPolicy,
  type RecoveryVerdict,
} from './carpool-outage.ts';
import { type AccountsVerdict, type ChannelState, gateSwitch } from './org-accounts.ts';
import { lastOkRead, type OrgLedger } from './org-ledger.ts';
import { type OrgSwitchFacts, planOrgSwitch } from './org-switch.ts';
import {
  DEFAULT_SWITCH_GUARD_POLICY,
  decideSwitchBack,
  helperRetryAt,
  recordRejectAfterSwitchBack,
  type SwitchGuardPolicy,
  settleWhiteStreak,
} from './org-switch-guard.ts';

export interface OrgDecisionPolicy {
  guard: SwitchGuardPolicy;
  recovery: RecoveryPolicy;
  /** 切回宽限 G（方案 4.5，创始人 2026-10-04「按你推荐」）：判恢复后给在跑的会话这么久收尾。 */
  graceMs: number;
  /** 开跑不到这么久的会话在宽限开始时当场停（进度少、重跑丢得少）。 */
  youngRunMs: number;
  /** 接口读数超过这么久不算「现在的」，不据此判拼车用不了。 */
  apiFreshMs: number;
  /** 账号状态读不到超过这么久，推「读不到账号状态」提醒（第六节第 1 条：连着没读成才报，不是一次抖动就报）。 */
  channelUnknownAlertMs: number;
}

const MIN = 60_000;

export const DEFAULT_ORG_DECISION_POLICY: Readonly<OrgDecisionPolicy> = Object.freeze({
  guard: DEFAULT_SWITCH_GUARD_POLICY,
  recovery: DEFAULT_RECOVERY_POLICY,
  graceMs: 10 * MIN,
  youngRunMs: 5 * MIN,
  apiFreshMs: 15 * MIN,
  channelUnknownAlertMs: 15 * MIN,
});

export interface OrgDecisionFacts extends OrgSwitchFacts {
  accounts: AccountsVerdict;
  ledger: OrgLedger;
  /** 刚发生的拼车被拒（会话、探针当场交来的，已判成「拼车用不了」）；探针那一轮、定时读接口那一轮不给。 */
  rejection?: CarpoolOutage;
}

export type OrgPlan =
  /** 不用切。later：到那个时刻（拼车几点恢复）以后再看。 */
  | { action: 'stay'; why: string; later?: { to: OrgKind; at: Date } }
  /** 该切，手上还有停不下的 Claude 会话：等下一轮。 */
  | { action: 'wait'; to: OrgKind; why: string }
  /** 切。to 是 carpool 时 mode 说明是确认过的切回还是试探切回。 */
  | { action: 'switch'; to: OrgKind; why: string; mode?: 'confirmed' | 'trial' }
  /** 切回的宽限中：新活不再往独享派；stopYoungerThanMs 给了（宽限刚开始）就把开跑不到这么久的会话当场停。 */
  | { action: 'drain'; to: 'carpool'; why: string; until: Date; stopYoungerThanMs: number | null }
  /** 明确失败，要人看。 */
  | { action: 'stuck'; why: string };

/** 渠道（所有 Claude 账号合起来）的状态报告：给驾驶舱、提醒、操作记录用。 */
export interface ChannelReport {
  state: ChannelState;
  summary: string;
  /** 这个状态是从几点开始的（状态没变就沿用账本里的）。 */
  since: Date;
  /** 和账本里上一次记的比，状态变了。 */
  changed: boolean;
  /** 要推「要人看」提醒（title 给驾驶舱和飞书）；null = 不用推，该撤的由调用方撤。 */
  alert: { title: string; body: string } | null;
}

export interface OrgDecision {
  plan: OrgPlan;
  /** 新账本（调用方存）。执行成了以后还要经 ledgerAfterSwitch 记一笔。 */
  ledger: OrgLedger;
  channel: ChannelReport;
  /** 过了预计恢复时刻很久还挂在独享上：另推一条「在独享上待太久」。 */
  overdue?: string;
  /** 本轮顺手发生的、要进操作记录的事（例如「接口说本人有余额请求却被拒」）。 */
  notes: string[];
}

export const stamp = (d: Date) => `${d.toISOString().replace('T', ' ').slice(0, 16)}（UTC）`;

const KIND_NAME: Record<OrgKind, string> = { carpool: '拼车', solo: '独享' };

function reportChannel(f: OrgDecisionFacts, policy: OrgDecisionPolicy): ChannelReport {
  const prev = f.ledger.channel;
  const state = f.accounts.channel;
  const same = prev?.state === state;
  const since = same && prev ? prev.since : f.now;
  const liveKind = f.live.ok ? f.live.org : null;
  let alert: ChannelReport['alert'] = null;
  if (state === 'unavailable') {
    alert = {
      title: '渠道不可用：Claude 订阅一个可用账号都没有',
      body: `${f.accounts.summary}。从 ${stamp(since)} 起。引擎不切号、选路不往 Claude 池派；有账号恢复（被封的解封、到期的续上、整池暂停的人处理好）后自己恢复、自己撤这条。`,
    };
  } else if (state === 'single' && liveKind && f.accounts.byKind[liveKind].available === 0) {
    alert = {
      title: `只剩 1 个可用账号，而且不是现在挂着的${KIND_NAME[liveKind]}账号：要人看`,
      body: `${f.accounts.summary}。按「可用 1 个不切」引擎不自动切，Claude 的活在不可用的账号上会被拒；要人决定怎么处理。`,
    };
  } else if (state === 'unknown' && f.now.getTime() - since.getTime() >= policy.channelUnknownAlertMs) {
    alert = {
      title: '读不到 Claude 账号的状态，不切号',
      body: `${f.accounts.summary}。从 ${stamp(since)} 起一直读不到；读不到不当成可用、也不当成不可用，所以不切号。接口恢复读数后自己撤。`,
    };
  }
  return { state, summary: f.accounts.summary, since, changed: !same, alert };
}

function latestKnownReset(windows: ReadonlyArray<{ resetsAt: Date | null }>): Date | null {
  const known = windows.map((w) => w.resetsAt).filter((d): d is Date => d !== null);
  return known.length === windows.length && known.length > 0
    ? new Date(Math.max(...known.map((d) => d.getTime())))
    : null;
}

export function decideOrgSwitch(
  f: OrgDecisionFacts,
  policy: OrgDecisionPolicy = DEFAULT_ORG_DECISION_POLICY,
): OrgDecision {
  const channel = reportChannel(f, policy);
  const base: OrgLedger = {
    ...f.ledger,
    channel: { state: channel.state, since: channel.since, why: channel.summary },
  };
  const notes: string[] = [];
  const out = (plan: OrgPlan, ledger: OrgLedger = base, overdue?: string): OrgDecision => {
    const gated = helperGate(plan, f, policy);
    return {
      plan: gated,
      ledger: gated === plan ? ledger : { ...ledger, backPending: null },
      channel,
      ...(overdue ? { overdue } : {}),
      notes,
    };
  };
  if (!f.live.ok) {
    return out({
      action: 'stay',
      why: f.live.pending
        ? `会话用户挂的组织这会儿定不下来（${f.live.why}），这一轮不切`
        : `会话用户挂的组织认不出（${f.live.why}），不切`,
    });
  }
  const carpool = f.pools.carpool;
  const solo = f.pools.solo;
  if (!carpool || !solo) return out({ action: 'stay', why: '库里拼车、独享两个池不全，没得切' });
  if (f.live.org === 'carpool') return onCarpool(f, policy, base, carpool, solo, notes, out);
  return onSolo(f, policy, base, carpool, out);
}

type Pool = NonNullable<OrgSwitchFacts['pools']['carpool']>;
type Out = (plan: OrgPlan, ledger?: OrgLedger, overdue?: string) => OrgDecision;

/** 帮手切号刚失败、还在退避里：这一轮不切（只拦 switch；wait、drain 本来就没动手）。 */
function helperGate(plan: OrgPlan, f: OrgDecisionFacts, policy: OrgDecisionPolicy): OrgPlan {
  if (plan.action !== 'switch') return plan;
  const retryAt = helperRetryAt(f.ledger.helperFailures, policy.guard);
  if (retryAt && retryAt.getTime() > f.now.getTime()) {
    return {
      action: 'stay',
      why: `帮手切号刚失败了 ${f.ledger.helperFailures.length} 次，退避到 ${stamp(retryAt)} 再试（不每分钟砸一次）；原本要：${plan.why}`,
    };
  }
  return plan;
}

function onCarpool(
  f: OrgDecisionFacts,
  policy: OrgDecisionPolicy,
  base: OrgLedger,
  carpool: Pool,
  solo: Pool,
  notes: string[],
  out: Out,
): OrgDecision {
  const now = f.now;
  let ledger: OrgLedger = {
    ...base,
    whites: settleWhiteStreak(base.whites, base.lastBack, now, policy.guard),
  };
  let outage = ledger.outage;
  let fresh = false;
  if (outage) {
    // 记着一个用不了、可还挂着拼车（没切成、被拦下）：之后的新读数说恢复了就撤掉，不拿过期的条件去切
    const back = judgeCarpoolRecovery(outage, ledger.reads, policy.recovery);
    if (back.state === 'recovered') {
      notes.push(`记着的「${OUTAGE_NAMES[outage.kind]}」已经恢复（${back.why}），撤掉，没切`);
      outage = null;
      ledger = { ...ledger, outage: null, backPending: null };
    }
  }
  if (!outage && f.rejection) {
    outage = f.rejection;
    fresh = true;
  }
  if (!outage) {
    const api = lastOkRead(ledger);
    const afterBack = !ledger.lastBack || (api && api.requestedAt.getTime() > ledger.lastBack.at.getTime());
    if (api && afterBack && now.getTime() - api.requestedAt.getTime() <= policy.apiFreshMs) {
      const o = outageFromApi(api);
      if (o) {
        outage = o;
        fresh = true;
      }
    }
  }
  if (!outage) {
    // 老证据：库里拼车的额度窗口用满（被拒那一帧、探针记的读数）
    const full = carpool.windows.filter((w) => w.state === 'exhausted');
    if (full.length > 0) {
      const resetsAt = latestKnownReset(full);
      outage = {
        kind: 'E1',
        since: now,
        resetsAt,
        resetsFrom: resetsAt ? 'text' : null,
        evidence: `库里拼车额度窗口用满（${full.map((w) => w.label).join('、')}）`,
      };
      fresh = true;
    }
  }
  if (!outage) return out({ action: 'stay', why: '挂着拼车，没有拼车用不了的证据' }, ledger);
  if (fresh) {
    if (outage.mismatch) notes.push(outage.mismatch);
    // 切回拼车不久又被拒：记一次白切（超过 15 分钟才被拒的不算，记账清零）
    if (ledger.lastBack) {
      ledger = {
        ...ledger,
        whites: recordRejectAfterSwitchBack(ledger.whites, ledger.lastBack, outage.since, policy.guard),
      };
    }
  }
  ledger = { ...ledger, outage };
  const resetNote = outage.resetsAt ? `${stamp(outage.resetsAt)} 恢复` : '恢复时刻不知道';
  const head = `${OUTAGE_NAMES[outage.kind]}（${outage.evidence}；${resetNote}）`;
  const gate = gateSwitch(f.accounts, 'carpool', 'solo');
  if (!gate.ok) return out({ action: 'stay', why: `${head}，${gate.why}` }, ledger);
  if (ledger.soloPause) {
    return out(
      {
        action: 'stay',
        why: `${head}，可人在驾驶舱点了「引擎暂不用独享」（${ledger.soloPause.by}，${stamp(ledger.soloPause.since)}：${ledger.soloPause.reason}），不切，等拼车恢复或交给别家模型`,
      },
      ledger,
    );
  }
  if (solo.held) {
    return out({ action: 'stay', why: `${head}，可独享池整池暂停着（等人处理），切过去也派不了` }, ledger);
  }
  if (solo.windows.some((w) => w.state === 'exhausted')) {
    return out({ action: 'stay', why: `${head}，独享的额度也用满了，切过去也派不了，等清零` }, ledger);
  }
  const why = `${head}，切到独享接着干`;
  if (f.busy > 0 && f.canStopRunning) {
    return out(
      { action: 'switch', to: 'solo', why: `${why}；手上 ${f.busy} 个 Claude 会话先停下，切完接着干` },
      ledger,
    );
  }
  if (f.busy > 0) {
    return out(
      {
        action: 'wait',
        to: 'solo',
        why: `${why}；手上还有 ${f.busy} 个 Claude 会话没结束，等跑完再切到独享`,
      },
      ledger,
    );
  }
  return out({ action: 'switch', to: 'solo', why }, ledger);
}

function onSolo(
  f: OrgDecisionFacts,
  policy: OrgDecisionPolicy,
  base: OrgLedger,
  carpool: Pool,
  out: Out,
): OrgDecision {
  const now = f.now;
  const outage = base.outage;
  if (!outage) return onSoloWithoutRecord(f, base, out);
  const ledger0: OrgLedger = {
    ...base,
    onSoloSince: base.onSoloSince ?? now,
    whites: settleWhiteStreak(base.whites, base.lastBack, now, policy.guard),
  };
  const refreshed = refreshOutage(outage, ledger0);
  const ledger: OrgLedger = { ...ledger0, outage: refreshed };
  const recovery: RecoveryVerdict = judgeCarpoolRecovery(refreshed, ledger.reads, policy.recovery);
  const lastOk = lastOkRead(ledger);
  const d = decideSwitchBack(
    {
      outage: refreshed,
      recovery,
      onSoloSince: ledger.onSoloSince ?? now,
      recentBacks: ledger.backs,
      whites: ledger.whites,
      lastApiOkAt: lastOk ? lastOk.requestedAt : null,
      now,
    },
    policy.guard,
  );
  const overdue = d.overdue;
  if (d.action === 'stuck') {
    return out({ action: 'stuck', why: d.why }, { ...ledger, backPending: null }, overdue);
  }
  if (d.action === 'hold') {
    const later = d.until ? { to: 'carpool' as const, at: d.until } : undefined;
    return out(
      { action: 'stay', why: `挂着独享；${d.why}`, ...(later ? { later } : {}) },
      { ...ledger, backPending: null },
      overdue,
    );
  }
  // go：证据够了、防抖也放行；账号关、整池暂停还要过
  const gate = gateSwitch(f.accounts, 'solo', 'carpool');
  if (!gate.ok) {
    return out(
      { action: 'stay', why: `挂着独享；拼车该切回了（${d.why}），${gate.why}` },
      { ...ledger, backPending: null },
      overdue,
    );
  }
  if (carpool.held) {
    return out(
      { action: 'stay', why: `挂着独享；拼车该切回了（${d.why}），可拼车池还整池暂停着（等人处理）` },
      { ...ledger, backPending: null },
      overdue,
    );
  }
  const why = `${d.mode === 'trial' ? '试探切回' : '切回'}拼车：${d.why}`;
  if (f.busy === 0) return out({ action: 'switch', to: 'carpool', why, mode: d.mode }, ledger, overdue);
  if (!f.canStopRunning) {
    return out(
      {
        action: 'wait',
        to: 'carpool',
        why: `${why}；手上还有 ${f.busy} 个 Claude 会话停不下来，等跑完再切回拼车`,
      },
      ledger,
      overdue,
    );
  }
  const pending = ledger.backPending;
  if (!pending) {
    const until = new Date(now.getTime() + policy.graceMs);
    return out(
      {
        action: 'drain',
        to: 'carpool',
        why: `${why}；新活先不往独享派，开跑不到 ${Math.round(policy.youngRunMs / MIN)} 分钟的会话当场停，其余 ${f.busy} 个给 ${Math.round(policy.graceMs / MIN)} 分钟收尾`,
        until,
        stopYoungerThanMs: policy.youngRunMs,
      },
      { ...ledger, backPending: { since: now, mode: d.mode, why: d.why } },
      overdue,
    );
  }
  const until = new Date(pending.since.getTime() + policy.graceMs);
  if (now.getTime() >= until.getTime()) {
    return out(
      {
        action: 'switch',
        to: 'carpool',
        why: `${why}；收尾宽限到了，还没完的 ${f.busy} 个会话先停下，切完在拼车上接着干`,
        mode: d.mode,
      },
      ledger,
      overdue,
    );
  }
  return out(
    {
      action: 'drain',
      to: 'carpool',
      why: `${why}；收尾宽限中，到 ${stamp(until)}`,
      until,
      stopYoungerThanMs: null,
    },
    ledger,
    overdue,
  );
}

/**
 * 挂着独享、账本里没有恢复条件（人手动切到独享的、账本没了）：没有「被拒」可对照，照老判法（拼车额度窗口都没用满就切回），
 * 但同样过账号关。
 */
function onSoloWithoutRecord(f: OrgDecisionFacts, base: OrgLedger, out: Out): OrgDecision {
  const legacy = planOrgSwitch(f);
  if (legacy.action === 'switch' || legacy.action === 'wait') {
    const gate = gateSwitch(f.accounts, 'solo', 'carpool');
    if (!gate.ok) return out({ action: 'stay', why: `${legacy.why}；但${gate.why}` }, base);
    return out(legacy.action === 'switch' ? { ...legacy, mode: 'confirmed' } : legacy, base);
  }
  return out(legacy, base);
}

/**
 * 选路要的引擎打算（和切号同一份事实、同一个判法）：switch、wait 是这就切（at 为空）；stay 带 later 是到那个时刻以后；
 * drain 是切回的宽限中：to 是要切回的拼车，同时 drain 写着「现在挂着的那类池新活先不派」；渠道不可用时 channelDown 写原因。
 */
export interface OrgIntentV2 {
  to: OrgKind | null;
  at: Date | null;
  why: string;
  drain: OrgKind | null;
  channelDown: string | null;
}

export function intentOf(d: OrgDecision, live: OrgKind | null): OrgIntentV2 {
  const channelDown = d.channel.state === 'unavailable' ? d.channel.summary : null;
  const p = d.plan;
  if (p.action === 'switch' || p.action === 'wait') {
    return { to: p.to, at: null, why: p.why, drain: null, channelDown };
  }
  if (p.action === 'drain') return { to: p.to, at: null, why: p.why, drain: live, channelDown };
  if (p.action === 'stay' && p.later) {
    return { to: p.later.to, at: p.later.at, why: p.why, drain: null, channelDown };
  }
  return { to: null, at: null, why: p.why, drain: null, channelDown };
}

/** 每读到新读数就更新恢复时刻（文档说窗口是「滚动」的，恢复时刻可能前后挪，方案 4.4）：只对 E1、接口说着到顶的那条读数。 */
function refreshOutage(outage: CarpoolOutage, ledger: OrgLedger): CarpoolOutage {
  if (outage.kind !== 'E1') return outage;
  const latest = lastOkRead(ledger);
  if (!latest || latest.requestedAt.getTime() <= outage.since.getTime() || !latest.quota?.resetsAt)
    return outage;
  const q = latest.quota;
  if (!(q.usedUsd >= q.limitUsd)) return outage;
  return { ...outage, resetsAt: q.resetsAt, resetsFrom: 'api' };
}
