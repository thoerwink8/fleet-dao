// 认领账的 Store 两份实现（#299，ports.ts 的 SeatStore；帅位座位 2026-10-01 起整张删掉，见 #531）：
// Postgres 版把 @fleet-dao/db 的几条语句串进一个事务、记操作记录；内存版照同样的语义用 Store 的钟顶替库的 now()。
// 两份过同一套契约测试（test/store-contract-seat.ts）。
// 改这里之前必须知道：引擎接活和本机认领抢的是同一行、同一句（takeClaimRow），只有一边拿到。
// 判法在 @fleet-dao/core 的 seat.ts。
import { randomUUID } from 'node:crypto';
import { claimExpired, type IssueClaim, isActiveClaim, isDrillScope } from '@fleet-dao/core';
import {
  type Db,
  endClaimRow,
  type IssueClaimRow,
  listClaimRows,
  listStalePendingEngineClaimRows,
  type NewClaimRow,
  readClaim,
  startEngineClaimRow,
  takeClaimRow,
  voidExpiredClaimRows,
} from '@fleet-dao/db';
import type { Actor, ClaimTarget, EngineClaimResult, NewAuditEntry, SeatStore } from './ports.ts';

const iso = (d: Date) => d.toISOString();

export function toIssueClaim(r: IssueClaimRow): IssueClaim {
  return {
    repoId: r.repoId,
    issueNumber: r.issueNumber,
    claimId: r.claimId,
    ownerKind: r.ownerKind,
    ownerMachine: r.ownerMachine,
    ownerLabel: r.ownerLabel,
    seatScope: r.seatScope,
    seatTerm: r.seatTerm,
    state: r.state,
    workflowId: r.workflowId,
    prNumbers: [...r.prNumbers],
    graceMinutes: r.graceMinutes,
    claimedAt: iso(r.claimedAt),
    heartbeatAt: iso(r.heartbeatAt),
    updatedAt: iso(r.updatedAt),
    endedAt: r.endedAt && iso(r.endedAt),
    endReason: r.endReason,
    note: r.note,
  };
}

/** 作废是引擎的定时任务做的。 */
export const CLAIMS_SWEEP: Actor = { kind: 'engine', id: 'claims-sweep' };

export const claimTarget = (t: ClaimTarget) => `claim:${t.repoId}#${t.issueNumber}`;

const claimSummary = (c: IssueClaim) => ({
  claimId: c.claimId,
  owner: c.ownerKind === 'engine' ? 'engine' : `${c.ownerMachine}/${c.ownerLabel}`,
  state: c.state,
});

type InsertAudit = (tx: Db, entry: NewAuditEntry) => Promise<string>;

/** 本机（帅位、工人）认领的默认宽限期：engine 那一份用不上，填的是同一个常数（core 的默认值）：120 分钟。 */
const DEFAULT_GRACE_MINUTES = 120;

/**
 * 引擎的新认领：待起、带工作流编号，不属于哪个座位。宽限期这一格引擎用不上（引擎的认领不按心跳作废，死活归工作流和停滞检测管），
 * 填默认值，不去读设置：设置写坏了不该连接活一起拦住。
 */
const engineClaimRow = (
  input: ClaimTarget & { workflowId: string; note?: string | undefined; drill?: string | undefined },
  claimId: string,
): NewClaimRow => ({
  repoId: input.repoId,
  issueNumber: input.issueNumber,
  claimId,
  ownerKind: 'engine',
  ownerMachine: null,
  ownerLabel: null,
  // 演练座位下引擎那一边：记在演练座位名下（第 0 任），待起补起、作废都不碰它
  seatScope: input.drill ?? null,
  seatTerm: input.drill === undefined ? null : 0,
  state: 'pending_start',
  workflowId: input.workflowId,
  graceMinutes: DEFAULT_GRACE_MINUTES,
  note: input.note ?? null,
});

/** 强制改派（给引擎）时作废原来那份写的原因。 */
const reassignReason = (to: string, founder: string) => `改派给${to}（创始人原话：${founder}）`;

export function pgSeatStore(db: Db, insertAudit: InsertAudit): SeatStore {
  return {
    async voidExpiredClaims(input) {
      return db.transaction(async (tx) => {
        const r = await voidExpiredClaimRows(tx, input);
        const voided = r.value.map(toIssueClaim);
        for (const claim of voided) {
          await insertAudit(tx, {
            actor: CLAIMS_SWEEP,
            action: 'claim.void',
            target: claimTarget(claim),
            before: { ...claimSummary(claim), heartbeatAt: claim.heartbeatAt },
            after: { state: 'voided' },
            reason: claim.endReason ?? undefined,
            via: 'engine',
            ok: true,
          });
        }
        return { voided, now: iso(r.now) };
      });
    },

    async claimForEngine(input) {
      return db.transaction(async (tx): Promise<EngineClaimResult> => {
        const taken = async (claimId: string) => {
          const got = await takeClaimRow(tx, engineClaimRow(input, claimId));
          if (!got) return null;
          const claim = toIssueClaim(got.value);
          await insertAudit(tx, {
            actor: input.actor,
            action: 'claim.take',
            target: claimTarget(input),
            after: {
              ...claimSummary(claim),
              workflowId: claim.workflowId,
            },
            reason: input.note,
            via: 'engine',
            ok: true,
          });
          return { claim, now: iso(got.now) };
        };
        const fresh = await taken(randomUUID());
        if (fresh) return { ok: true, claim: fresh.claim, fresh: true, voided: null, now: fresh.now };
        // 没抢到：锁住这一行再看是谁拿着（引擎自己拿着的是重投、重放）
        const cur = await readClaim(tx, input.repoId, input.issueNumber, true);
        if (!cur.value) throw new Error(`抢 ${claimTarget(input)} 没抢到，读回来却没有认领`);
        const claim = toIssueClaim(cur.value);
        const now = iso(cur.now);
        if (claim.ownerKind === 'engine') return { ok: true, claim, fresh: false, voided: null, now };
        if (!input.founder) return { ok: false, reason: 'held', claim, now };
        const ended = await endClaimRow(tx, {
          repoId: input.repoId,
          issueNumber: input.issueNumber,
          claimId: claim.claimId,
          state: 'voided',
          reason: reassignReason('引擎', input.founder),
        });
        if (!ended) throw new Error(`锁住了 ${claimTarget(input)} 的认领，作废时它却变了`);
        const voided = toIssueClaim(ended.value);
        await insertAudit(tx, {
          actor: input.actor,
          action: 'claim.reassign',
          target: claimTarget(input),
          before: claimSummary(claim),
          after: { state: 'voided', to: 'engine' },
          reason: reassignReason('引擎', input.founder),
          via: 'engine',
          ok: true,
        });
        const again = await taken(randomUUID());
        if (!again) throw new Error(`作废了 ${claimTarget(input)} 本机的认领，引擎却没抢到`);
        return { ok: true, claim: again.claim, fresh: true, voided, now: again.now };
      });
    },

    async startEngineClaim(input) {
      const r = await startEngineClaimRow(db, input);
      if (r) return { changed: true, claim: toIssueClaim(r.value), now: iso(r.now) };
      const cur = await readClaim(db, input.repoId, input.issueNumber);
      return { changed: false, claim: cur.value && toIssueClaim(cur.value), now: iso(cur.now) };
    },

    async listStalePendingEngineClaims(input) {
      const r = await listStalePendingEngineClaimRows(db, input);
      return { claims: r.value.map(toIssueClaim), now: iso(r.now) };
    },

    async releasePendingEngineClaim(input) {
      return db.transaction(async (tx) => {
        const cur = await readClaim(tx, input.repoId, input.issueNumber, true);
        const c = cur.value;
        if (!c || c.claimId !== input.claimId || c.ownerKind !== 'engine' || c.state !== 'pending_start')
          return null;
        const ended = await endClaimRow(tx, { ...input, state: 'released' });
        if (!ended) throw new Error(`锁住了 ${claimTarget(input)} 的认领，放下时它却变了`);
        const claim = toIssueClaim(ended.value);
        await insertAudit(tx, {
          actor: input.actor,
          action: 'claim.release',
          target: claimTarget(input),
          after: claimSummary(claim),
          reason: input.reason,
          via: 'engine',
          ok: true,
        });
        return claim;
      });
    },

    async getClaim(repoId, issueNumber) {
      const r = await readClaim(db, repoId, issueNumber);
      return { claim: r.value && toIssueClaim(r.value), now: iso(r.now) };
    },

    async listClaims(input) {
      const r = await listClaimRows(db, input);
      return { claims: r.value.map(toIssueClaim), now: iso(r.now) };
    },
  };
}

// —— 内存版 ——

export interface SeatMemoryData {
  claims: IssueClaim[];
}

/** 内存版：语义照 Postgres 版，库的 now() 用 Store 的钟顶替；每个方法同步做完，天然是原子的。 */
export function memorySeatStore(
  data: SeatMemoryData,
  now: () => Date,
  audit: (entry: NewAuditEntry) => string,
): SeatStore {
  const nowIso = () => now().toISOString();
  const claimOf = (t: ClaimTarget) =>
    data.claims.find((c) => c.repoId === t.repoId && c.issueNumber === t.issueNumber) ?? null;
  const copyClaim = (c: IssueClaim): IssueClaim => ({ ...c, prNumbers: [...c.prNumbers] });

  return {
    async voidExpiredClaims(input) {
      const at = nowIso();
      const due = data.claims.filter((c) => claimExpired(c, at)).slice(0, input.limit);
      for (const c of due) {
        const before = { ...claimSummary(c), heartbeatAt: c.heartbeatAt };
        c.state = 'voided';
        c.endedAt = at;
        c.updatedAt = at;
        c.endReason = `过了宽限期（${c.graceMinutes} 分钟）没心跳`;
        audit({
          actor: CLAIMS_SWEEP,
          action: 'claim.void',
          target: claimTarget(c),
          before,
          after: { state: 'voided' },
          reason: c.endReason,
          via: 'engine',
          ok: true,
        });
      }
      return { voided: due.map(copyClaim), now: at };
    },

    async claimForEngine(input) {
      const at = nowIso();
      const take = (): IssueClaim => {
        const row = engineClaimRow(input, randomUUID());
        const claim: IssueClaim = {
          ...row,
          prNumbers: [],
          claimedAt: at,
          heartbeatAt: at,
          updatedAt: at,
          endedAt: null,
          endReason: null,
        };
        data.claims = [
          ...data.claims.filter((c) => !(c.repoId === input.repoId && c.issueNumber === input.issueNumber)),
          claim,
        ];
        audit({
          actor: input.actor,
          action: 'claim.take',
          target: claimTarget(input),
          after: {
            ...claimSummary(claim),
            workflowId: claim.workflowId,
          },
          reason: input.note,
          via: 'engine',
          ok: true,
        });
        return copyClaim(claim);
      };
      const cur = claimOf(input);
      if (!cur || !isActiveClaim(cur.state))
        return { ok: true, claim: take(), fresh: true, voided: null, now: at };
      if (cur.ownerKind === 'engine')
        return { ok: true, claim: copyClaim(cur), fresh: false, voided: null, now: at };
      if (!input.founder) return { ok: false, reason: 'held', claim: copyClaim(cur), now: at };
      const before = claimSummary(cur);
      cur.state = 'voided';
      cur.endedAt = at;
      cur.updatedAt = at;
      cur.endReason = reassignReason('引擎', input.founder);
      const voided = copyClaim(cur);
      audit({
        actor: input.actor,
        action: 'claim.reassign',
        target: claimTarget(input),
        before,
        after: { state: 'voided', to: 'engine' },
        reason: cur.endReason,
        via: 'engine',
        ok: true,
      });
      return { ok: true, claim: take(), fresh: true, voided, now: at };
    },

    async startEngineClaim(input) {
      const at = nowIso();
      const cur = claimOf(input);
      if (cur?.ownerKind !== 'engine' || cur.state !== 'pending_start')
        return { changed: false, claim: cur && copyClaim(cur), now: at };
      cur.state = 'doing';
      cur.heartbeatAt = at;
      cur.updatedAt = at;
      return { changed: true, claim: copyClaim(cur), now: at };
    },

    async listStalePendingEngineClaims(input) {
      const at = nowIso();
      const cutoff = Date.parse(at) - input.minutes * 60_000;
      const claims = data.claims
        .filter(
          (c) =>
            c.ownerKind === 'engine' &&
            c.state === 'pending_start' &&
            Date.parse(c.updatedAt) < cutoff &&
            !isDrillScope(c.seatScope),
        )
        .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt))
        .slice(0, input.limit)
        .map(copyClaim);
      return { claims, now: at };
    },

    async releasePendingEngineClaim(input) {
      const at = nowIso();
      const cur = claimOf(input);
      if (
        !cur ||
        cur.claimId !== input.claimId ||
        cur.ownerKind !== 'engine' ||
        cur.state !== 'pending_start'
      )
        return null;
      cur.state = 'released';
      cur.endedAt = at;
      cur.updatedAt = at;
      cur.endReason = input.reason;
      audit({
        actor: input.actor,
        action: 'claim.release',
        target: claimTarget(input),
        after: claimSummary(cur),
        reason: input.reason,
        via: 'engine',
        ok: true,
      });
      return copyClaim(cur);
    },

    async getClaim(repoId, issueNumber) {
      const c = claimOf({ repoId, issueNumber });
      return { claim: c && copyClaim(c), now: nowIso() };
    },

    async listClaims(input) {
      const claims = data.claims
        .filter(
          (c) =>
            (input.repoId === undefined || c.repoId === input.repoId) &&
            (!input.activeOnly || isActiveClaim(c.state)),
        )
        .sort((a, b) => (a.repoId < b.repoId ? -1 : a.repoId > b.repoId ? 1 : a.issueNumber - b.issueNumber))
        .map(copyClaim);
      return { claims, now: nowIso() };
    },
  };
}
