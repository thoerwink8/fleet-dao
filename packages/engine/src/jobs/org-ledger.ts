// 切号账本（#194，方案 v2 4.4、4.6、第六节第 13 条）：落库（db 的 session_org_state.doc）的那一份，引擎重启后接着用。
// 纯数据和纯变换，不碰库：真读写在 real/org-ledger.ts。
//
// 改这里之前必须知道：
// - 读回来认不出（版本不对、字段缺、时间不是时间）一律抛 OrgLedgerError，调用方这一轮不切、推「要人看」；
//   不许把认不出的账本当成「空账本」继续切——那样白切记账、切回预算、恢复条件全丢，会来回抖。
// - 「从没存过」是正常的：real 层读到 null 才给 emptyLedger()，和「存了但认不出」分开。
// - 读数环只留最近 READS_KEPT 条（够判「连着两次新读数」和「被拒之后有没有新读数」），不无限长。
import { z } from 'zod';
import type { CarpoolApiRead, CarpoolOutage } from './carpool-outage.ts';
import type { ChannelState } from './org-accounts.ts';
import { NO_WHITES, type SwitchBack, type WhiteStreak } from './org-switch-guard.ts';

export const LEDGER_VERSION = 1;
export const READS_KEPT = 40;
/** 切回记录只留这么久（比切回预算的窗口长一点就够）。 */
export const BACKS_KEPT_MS = 6 * 60 * 60_000;

/** 人在驾驶舱点的「引擎暂不用独享」：开着时拼车用不了也不切独享（方案 4.8、第七节的 D），拼车一直等恢复或交给别家。 */
export interface SoloPause {
  since: Date;
  by: string;
  reason: string;
}

/** 上一次判出来的渠道状态（给驾驶舱看；渠道不可用的提醒按它的起点判多久了）。 */
export interface ChannelRecord {
  state: ChannelState;
  since: Date;
  why: string;
}

/** 切回的宽限已经开始（方案 4.5）：从 since 起新活不再往独享派，到 since + 宽限还有会话没完的再停。 */
export interface BackPending {
  since: Date;
  mode: 'confirmed' | 'trial';
  why: string;
}

export interface OrgLedger {
  v: typeof LEDGER_VERSION;
  /** 拼车恢复条件：哪一种用不了、几点恢复、从哪读来。切回拼车（或判明不用切了）后清空。 */
  outage: CarpoolOutage | null;
  /** 这一次挂到独享的时刻；挂着拼车为 null。 */
  onSoloSince: Date | null;
  /** 自动切回的记录（确认的、试探的都记）。 */
  backs: SwitchBack[];
  /** 最近一次切回拼车。 */
  lastBack: SwitchBack | null;
  whites: WhiteStreak;
  /** 帮手切号从最近一次成功之后连着失败的时刻。 */
  helperFailures: Date[];
  reads: CarpoolApiRead[];
  soloPause: SoloPause | null;
  channel: ChannelRecord | null;
  backPending: BackPending | null;
}

export class OrgLedgerError extends Error {
  constructor(why: string) {
    super(`切号账本认不出：${why}`);
    this.name = 'OrgLedgerError';
  }
}

export function emptyLedger(): OrgLedger {
  return {
    v: LEDGER_VERSION,
    outage: null,
    onSoloSince: null,
    backs: [],
    lastBack: null,
    whites: { ...NO_WHITES },
    helperFailures: [],
    reads: [],
    soloPause: null,
    channel: null,
    backPending: null,
  };
}

// —— 存取：时间一律 ISO 字符串 ——

const D = z.string().transform((s, ctx) => {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    ctx.addIssue({ code: 'custom', message: `不是时间：${s}` });
    return z.NEVER;
  }
  return d;
});

const Quota = z.object({
  usedUsd: z.number(),
  limitUsd: z.number(),
  resetsAt: D.nullable(),
  status: z.string().nullable(),
});

const ApiAccount = z.object({
  id: z.string(),
  kind: z.enum(['carpool', 'solo', 'other']),
  hasAssignedAccount: z.boolean().nullable(),
  expiresAt: D.nullable(),
});

const Read = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    requestedAt: D,
    serverDate: D.nullable(),
    ageSeconds: z.number().nullable(),
    quota: Quota.nullable(),
    org: z.enum(['ok', 'none', 'no-account', 'expired', 'unknown']),
    accounts: z.array(ApiAccount).optional(),
  }),
  z.object({
    ok: z.literal(false),
    requestedAt: D,
    code: z.enum(['network', 'http', 'auth', 'bad_response', 'throttled']),
    why: z.string(),
  }),
]);

const Outage = z.object({
  kind: z.enum(['E1', 'E2', 'E3']),
  since: D,
  resetsAt: D.nullable(),
  resetsFrom: z.enum(['api', 'text']).nullable(),
  evidence: z.string(),
  mismatch: z.string().optional(),
});

const Back = z.object({ at: D, trial: z.boolean() });

const LedgerSchema = z.object({
  v: z.literal(LEDGER_VERSION),
  outage: Outage.nullable(),
  onSoloSince: D.nullable(),
  backs: z.array(Back),
  lastBack: Back.nullable(),
  whites: z.object({ count: z.number().int().min(0), lastAt: D.nullable(), lastTrial: z.boolean() }),
  helperFailures: z.array(D),
  reads: z.array(Read),
  soloPause: z.object({ since: D, by: z.string(), reason: z.string() }).nullable(),
  channel: z
    .object({ state: z.enum(['ok', 'single', 'unavailable', 'unknown']), since: D, why: z.string() })
    .nullable(),
  backPending: z.object({ since: D, mode: z.enum(['confirmed', 'trial']), why: z.string() }).nullable(),
});

/** 库里读回来的 doc → 账本。认不出抛 OrgLedgerError（带第一条原因）。 */
export function parseLedger(doc: unknown): OrgLedger {
  const parsed = LedgerSchema.safeParse(doc);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new OrgLedgerError(`${issue?.path.join('.') || '整份'}：${issue?.message ?? '格式不对'}`);
  }
  return parsed.data as OrgLedger;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** 账本 → 能存进 jsonb 的东西（parseLedger 的反过程）。 */
export function serializeLedger(l: OrgLedger): unknown {
  return {
    v: l.v,
    outage: l.outage
      ? {
          kind: l.outage.kind,
          since: l.outage.since.toISOString(),
          resetsAt: iso(l.outage.resetsAt),
          resetsFrom: l.outage.resetsFrom,
          evidence: l.outage.evidence,
          ...(l.outage.mismatch ? { mismatch: l.outage.mismatch } : {}),
        }
      : null,
    onSoloSince: iso(l.onSoloSince),
    backs: l.backs.map((b) => ({ at: b.at.toISOString(), trial: b.trial })),
    lastBack: l.lastBack ? { at: l.lastBack.at.toISOString(), trial: l.lastBack.trial } : null,
    whites: { count: l.whites.count, lastAt: iso(l.whites.lastAt), lastTrial: l.whites.lastTrial },
    helperFailures: l.helperFailures.map((d) => d.toISOString()),
    reads: l.reads.map((r) =>
      r.ok
        ? {
            ok: true,
            requestedAt: r.requestedAt.toISOString(),
            serverDate: iso(r.serverDate),
            ageSeconds: r.ageSeconds,
            quota: r.quota
              ? {
                  usedUsd: r.quota.usedUsd,
                  limitUsd: r.quota.limitUsd,
                  resetsAt: iso(r.quota.resetsAt),
                  status: r.quota.status,
                }
              : null,
            org: r.org,
            ...(r.accounts
              ? {
                  accounts: r.accounts.map((a) => ({
                    id: a.id,
                    kind: a.kind,
                    hasAssignedAccount: a.hasAssignedAccount,
                    expiresAt: iso(a.expiresAt),
                  })),
                }
              : {}),
          }
        : { ok: false, requestedAt: r.requestedAt.toISOString(), code: r.code, why: r.why },
    ),
    soloPause: l.soloPause
      ? { since: l.soloPause.since.toISOString(), by: l.soloPause.by, reason: l.soloPause.reason }
      : null,
    channel: l.channel
      ? { state: l.channel.state, since: l.channel.since.toISOString(), why: l.channel.why }
      : null,
    backPending: l.backPending
      ? { since: l.backPending.since.toISOString(), mode: l.backPending.mode, why: l.backPending.why }
      : null,
  };
}

// —— 变换（都返回新账本，不改入参） ——

/** 记一条接口读数：按发请求的时刻排好，只留最近 READS_KEPT 条。 */
export function withRead(l: OrgLedger, read: CarpoolApiRead): OrgLedger {
  const reads = [...l.reads, read]
    .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime())
    .slice(-READS_KEPT);
  return { ...l, reads };
}

/** 最近一次读成的那条；一条都没有为 null。 */
export function lastOkRead(l: OrgLedger): Extract<CarpoolApiRead, { ok: true }> | null {
  for (let i = l.reads.length - 1; i >= 0; i--) {
    const r = l.reads[i];
    if (r?.ok) return r;
  }
  return null;
}

/** 帮手切号成功后：挂到哪、记账怎么变。 */
export function ledgerAfterSwitch(
  l: OrgLedger,
  to: 'carpool' | 'solo',
  at: Date,
  mode: 'confirmed' | 'trial' | null,
): OrgLedger {
  if (to === 'solo') {
    return { ...l, onSoloSince: at, backPending: null, helperFailures: [] };
  }
  const back: SwitchBack = { at, trial: mode === 'trial' };
  return {
    ...l,
    outage: null,
    onSoloSince: null,
    backPending: null,
    helperFailures: [],
    lastBack: back,
    backs: [...l.backs, back].filter((b) => at.getTime() - b.at.getTime() < BACKS_KEPT_MS),
  };
}
