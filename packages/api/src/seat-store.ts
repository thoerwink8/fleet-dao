// 帅位租约和认领的 Store 两份实现（#299，ports.ts 的 SeatStore）：Postgres 版把 @fleet-dao/db 的几条语句串进一个事务、
// 记操作记录；内存版照同样的语义用 Store 的钟顶替库的 now()。两份过同一套契约测试（test/store-contract-seat.ts）。
// 改这里之前必须知道：受保护动作（帅位认领新单、帅位交单给引擎）在同一个事务里先锁座位（for share）、按库的 now 核任期，
// 再抢这一行；核不过、抢不到都什么也不改。引擎接活和本机认领抢的是同一行、同一句（takeClaimRow），只有一边拿到。
// 判法在 @fleet-dao/core 的 seat.ts。
import { randomUUID } from 'node:crypto';
import {
  claimExpired,
  holderText,
  type IssueClaim,
  isActiveClaim,
  isDrillScope,
  readSeatSettings,
  SEAT_DEFAULTS,
  type SeatLease,
  seatVerdict,
} from '@fleet-dao/core';
import {
  type Db,
  endClaimRow,
  type IssueClaimRow,
  listClaimRows,
  listStalePendingEngineClaimRows,
  type NewClaimRow,
  readClaim,
  readSeat as readSeatRow,
  readSeatSetting,
  renewSeatRow,
  type SeatLeaseRow,
  startEngineClaimRow,
  stepClaimRow,
  takeClaimRow,
  takeSeatRow,
  voidExpiredClaimRows,
  writeHandoffRow,
} from '@fleet-dao/db';
import type {
  Actor,
  ClaimTarget,
  EngineClaimResult,
  NewAuditEntry,
  SeatActor,
  SeatIdentity,
  SeatStore,
} from './ports.ts';

const iso = (d: Date) => d.toISOString();

export function toSeatLease(r: SeatLeaseRow): SeatLease {
  return {
    scope: r.scope,
    term: r.term,
    holderMachine: r.holderMachine,
    holderSession: r.holderSession,
    acquiredAt: iso(r.acquiredAt),
    renewedAt: iso(r.renewedAt),
    previousMachine: r.previousMachine,
    previousSession: r.previousSession,
    handoff: r.handoff,
    handoffAt: r.handoffAt && iso(r.handoffAt),
  };
}

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

/** 本机的帅位、工人记在「AI 帅位」这一类下（库里的 actor_kind 早有 ai，一直没用上），编号是 <机器名>/<会话或工人>。 */
export const seatActor = (id: SeatIdentity): Actor => ({ kind: 'ai', id: `${id.machine}/${id.session}` });
const claimActor = (c: IssueClaim): Actor =>
  c.ownerKind === 'engine'
    ? { kind: 'engine', id: 'fusion' }
    : { kind: 'ai', id: `${c.ownerMachine ?? '?'}/${c.ownerLabel ?? '?'}` };
/** 作废是引擎的定时任务做的。 */
export const CLAIMS_SWEEP: Actor = { kind: 'engine', id: 'claims-sweep' };

export const seatTarget = (scope: string) => `seat:${scope}`;
export const claimTarget = (t: ClaimTarget) => `claim:${t.repoId}#${t.issueNumber}`;

const claimSummary = (c: IssueClaim) => ({
  claimId: c.claimId,
  owner: c.ownerKind === 'engine' ? 'engine' : `${c.ownerMachine}/${c.ownerLabel}`,
  state: c.state,
});

type InsertAudit = (tx: Db, entry: NewAuditEntry) => Promise<string>;

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
  graceMinutes: SEAT_DEFAULTS.claimGraceMinutes,
  note: input.note ?? null,
});

/** 强制改派给引擎时作废本机认领写的原因。 */
const reassignReason = (founder: string) => `改派给引擎（创始人原话：${founder}）`;

/** 带着帅位来的受保护动作：按库的 now 核任期没换、没过期（判法在 core 的 seatVerdict）。核过是 null。 */
function seatProblem(
  lease: SeatLease | null,
  seat: SeatActor,
  now: string,
  settings: ReturnType<typeof readSeatSettings>,
): { reason: 'settings' | 'not_seat'; why: string } | null {
  if (!settings.ok) return { reason: 'settings', why: settings.why };
  const verdict = seatVerdict(lease, seat, now, settings.settings.leaseMinutes);
  return verdict.ok ? null : { reason: 'not_seat', why: verdict.why };
}

/** 交接说明：现任整份换掉；刚被换下的上一任接在后面补一段。 */
function handoffText(
  lease: SeatLease,
  input: { term: number; machine: string; session: string; text: string },
) {
  const current =
    lease.term === input.term &&
    lease.holderMachine === input.machine &&
    lease.holderSession === input.session;
  if (current) return input.text;
  const previous =
    lease.term === input.term + 1 &&
    lease.previousMachine === input.machine &&
    lease.previousSession === input.session;
  if (!previous) return null;
  const note = `（第 ${input.term} 任 ${input.machine}/${input.session} 退役时补的）\n${input.text}`;
  return lease.handoff ? `${lease.handoff}\n\n${note}` : note;
}

export function pgSeatStore(db: Db, insertAudit: InsertAudit): SeatStore {
  return {
    async readSeat(scope) {
      // 一条一条读：并发的两条里一条连不上时另一条会挂着，关连接要等它（postgres.js 的 end 等在途的查询）
      const seat = await readSeatRow(db, scope);
      const raw = await readSeatSetting(db);
      return {
        lease: seat.value && toSeatLease(seat.value),
        now: iso(seat.now),
        settings: readSeatSettings(raw),
      };
    },

    async takeSeat(input) {
      return db.transaction(async (tx) => {
        const r = await takeSeatRow(tx, input);
        const lease = toSeatLease(r.value);
        await insertAudit(tx, {
          actor: seatActor(input),
          action: 'seat.take',
          target: seatTarget(input.scope),
          before:
            lease.previousMachine === null
              ? undefined
              : { term: lease.term - 1, holder: `${lease.previousMachine}/${lease.previousSession}` },
          after: { term: lease.term, holder: holderText(lease) },
          via: 'engine',
          ok: true,
        });
        return { lease, now: iso(r.now) };
      });
    },

    async renewSeat(input) {
      const r = await renewSeatRow(db, input);
      if (r) return { ok: true, lease: toSeatLease(r.value), now: iso(r.now) };
      const cur = await readSeatRow(db, input.scope);
      return { ok: false, lease: cur.value && toSeatLease(cur.value), now: iso(cur.now) };
    },

    async writeHandoff(input) {
      return db.transaction(async (tx) => {
        const cur = await readSeatRow(tx, input.scope, true);
        const lease = cur.value && toSeatLease(cur.value);
        const text = lease && handoffText(lease, input);
        if (!lease || text === null) return { ok: false as const, lease, now: iso(cur.now) };
        const row = await writeHandoffRow(tx, { scope: input.scope, text });
        await insertAudit(tx, {
          actor: seatActor(input),
          action: 'seat.handoff',
          target: seatTarget(input.scope),
          after: { term: input.term, chars: input.text.length },
          via: 'engine',
          ok: true,
        });
        return { ok: true as const, lease: toSeatLease(row) };
      });
    },

    async takeClaim(input) {
      return db.transaction(async (tx) => {
        const settings = readSeatSettings(await readSeatSetting(tx));
        const seat = await readSeatRow(tx, input.seat.scope, true);
        const now = iso(seat.now);
        if (!settings.ok) return { ok: false as const, reason: 'settings' as const, why: settings.why, now };
        const verdict = seatVerdict(
          seat.value && toSeatLease(seat.value),
          input.seat,
          now,
          settings.settings.leaseMinutes,
        );
        if (!verdict.ok) return { ok: false as const, reason: 'not_seat' as const, why: verdict.why, now };
        // 这个座位的帅位自己占着的（开单时替帅位认领的）由现任帅位换给工人：换之前记下原来那份
        const prev = await readClaim(tx, input.repoId, input.issueNumber, true);
        const got = await takeClaimRow(
          tx,
          {
            repoId: input.repoId,
            issueNumber: input.issueNumber,
            claimId: randomUUID(),
            ownerKind: input.owner.kind,
            ownerMachine: input.seat.machine,
            ownerLabel: input.owner.label,
            seatScope: input.seat.scope,
            seatTerm: input.seat.term,
            state: 'claimed',
            workflowId: null,
            graceMinutes: input.graceMinutes ?? settings.settings.claimGraceMinutes,
            note: input.note ?? null,
          },
          { seatReservationOf: input.seat.scope },
        );
        if (!got) {
          const cur = await readClaim(tx, input.repoId, input.issueNumber);
          if (!cur.value) throw new Error(`抢 ${claimTarget(input)} 没抢到，读回来却没有认领`);
          return {
            ok: false as const,
            reason: 'held' as const,
            claim: toIssueClaim(cur.value),
            now: iso(cur.now),
          };
        }
        const claim = toIssueClaim(got.value);
        const replaced = prev.value && isActiveClaim(prev.value.state) ? toIssueClaim(prev.value) : null;
        await insertAudit(tx, {
          actor: seatActor(input.seat),
          action: 'claim.take',
          target: claimTarget(input),
          ...(replaced ? { before: claimSummary(replaced) } : {}),
          after: {
            ...claimSummary(claim),
            seat: `${input.seat.scope}#${input.seat.term}`,
            grace: claim.graceMinutes,
          },
          reason: input.note,
          via: 'engine',
          ok: true,
        });
        return { ok: true as const, claim, now: iso(got.now) };
      });
    },

    async stepClaim(input) {
      return db.transaction(async (tx) => {
        const r = await stepClaimRow(tx, input);
        if (!r) {
          const cur = await readClaim(tx, input.repoId, input.issueNumber);
          return { ok: false as const, claim: cur.value && toIssueClaim(cur.value), now: iso(cur.now) };
        }
        const claim = toIssueClaim(r.value);
        if (input.note !== undefined || input.pr !== undefined) {
          await insertAudit(tx, {
            actor: claimActor(claim),
            action: input.pr === undefined ? 'claim.step' : 'claim.pr',
            target: claimTarget(input),
            after: { claimId: claim.claimId, state: claim.state, pr: input.pr },
            reason: input.note,
            via: 'engine',
            ok: true,
          });
        }
        return { ok: true as const, claim, now: iso(r.now) };
      });
    },

    async endClaim(input) {
      return db.transaction(async (tx) => {
        const r = await endClaimRow(tx, input);
        if (!r) {
          const cur = await readClaim(tx, input.repoId, input.issueNumber);
          return { ok: false as const, claim: cur.value && toIssueClaim(cur.value), now: iso(cur.now) };
        }
        const claim = toIssueClaim(r.value);
        await insertAudit(tx, {
          actor: claimActor(claim),
          action: input.state === 'done' ? 'claim.done' : 'claim.release',
          target: claimTarget(input),
          after: claimSummary(claim),
          reason: input.reason,
          via: 'engine',
          ok: true,
        });
        return { ok: true as const, claim, now: iso(r.now) };
      });
    },

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
        if (input.seat) {
          const settings = readSeatSettings(await readSeatSetting(tx));
          const seat = await readSeatRow(tx, input.seat.scope, true);
          const now = iso(seat.now);
          const problem = seatProblem(seat.value && toSeatLease(seat.value), input.seat, now, settings);
          if (problem) return { ok: false, ...problem, now };
        }
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
              ...(input.seat ? { seat: `${input.seat.scope}#${input.seat.term}` } : {}),
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
          reason: reassignReason(input.founder),
        });
        if (!ended) throw new Error(`锁住了 ${claimTarget(input)} 的认领，作废时它却变了`);
        const voided = toIssueClaim(ended.value);
        await insertAudit(tx, {
          actor: input.actor,
          action: 'claim.reassign',
          target: claimTarget(input),
          before: claimSummary(claim),
          after: { state: 'voided', to: 'engine' },
          reason: reassignReason(input.founder),
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
  seatLeases: SeatLease[];
  claims: IssueClaim[];
  /** settings 表那两项（键是 seat.leaseMinutes、seat.claimGraceMinutes）。 */
  settings: { key: string; value: unknown }[];
}

/** 内存版：语义照 Postgres 版，库的 now() 用 Store 的钟顶替；每个方法同步做完，天然是原子的。 */
export function memorySeatStore(
  data: SeatMemoryData,
  now: () => Date,
  audit: (entry: NewAuditEntry) => string,
): SeatStore {
  const nowIso = () => now().toISOString();
  const rawSettings = () => ({
    leaseMinutes: data.settings.find((s) => s.key === 'seat.leaseMinutes')?.value,
    claimGraceMinutes: data.settings.find((s) => s.key === 'seat.claimGraceMinutes')?.value,
  });
  const seatOf = (scope: string) => data.seatLeases.find((l) => l.scope === scope) ?? null;
  const claimOf = (t: ClaimTarget) =>
    data.claims.find((c) => c.repoId === t.repoId && c.issueNumber === t.issueNumber) ?? null;
  const copyLease = (l: SeatLease): SeatLease => ({ ...l });
  const copyClaim = (c: IssueClaim): IssueClaim => ({ ...c, prNumbers: [...c.prNumbers] });
  const same = (c: IssueClaim, input: ClaimTarget & { claimId: string }) =>
    c.claimId === input.claimId && isActiveClaim(c.state) && c.state !== 'pending_start';

  return {
    async readSeat(scope) {
      const lease = seatOf(scope);
      return { lease: lease && copyLease(lease), now: nowIso(), settings: readSeatSettings(rawSettings()) };
    },

    async takeSeat(input) {
      if (!/^(main|drill:.+)$/.test(input.scope))
        throw new Error(`seat_leases_scope_known：座位「${input.scope}」不行`);
      const at = nowIso();
      const old = seatOf(input.scope);
      const lease: SeatLease = {
        scope: input.scope,
        term: old ? old.term + 1 : 1,
        holderMachine: input.machine,
        holderSession: input.session,
        acquiredAt: at,
        renewedAt: at,
        previousMachine: old ? old.holderMachine : null,
        previousSession: old ? old.holderSession : null,
        handoff: old ? old.handoff : null,
        handoffAt: old ? old.handoffAt : null,
      };
      data.seatLeases = [...data.seatLeases.filter((l) => l.scope !== input.scope), lease];
      audit({
        actor: seatActor(input),
        action: 'seat.take',
        target: seatTarget(input.scope),
        before: old ? { term: old.term, holder: holderText(old) } : undefined,
        after: { term: lease.term, holder: holderText(lease) },
        via: 'engine',
        ok: true,
      });
      return { lease: copyLease(lease), now: at };
    },

    async renewSeat(input) {
      const lease = seatOf(input.scope);
      if (
        lease &&
        lease.term === input.term &&
        lease.holderMachine === input.machine &&
        lease.holderSession === input.session
      ) {
        lease.renewedAt = nowIso();
        return { ok: true, lease: copyLease(lease), now: lease.renewedAt };
      }
      return { ok: false, lease: lease && copyLease(lease), now: nowIso() };
    },

    async writeHandoff(input) {
      const lease = seatOf(input.scope);
      const text = lease && handoffText(lease, input);
      if (!lease || text === null) return { ok: false, lease: lease && copyLease(lease), now: nowIso() };
      lease.handoff = text;
      lease.handoffAt = nowIso();
      audit({
        actor: seatActor(input),
        action: 'seat.handoff',
        target: seatTarget(input.scope),
        after: { term: input.term, chars: input.text.length },
        via: 'engine',
        ok: true,
      });
      return { ok: true, lease: copyLease(lease) };
    },

    async takeClaim(input) {
      const at = nowIso();
      const settings = readSeatSettings(rawSettings());
      if (!settings.ok) return { ok: false, reason: 'settings', why: settings.why, now: at };
      const verdict = seatVerdict(seatOf(input.seat.scope), input.seat, at, settings.settings.leaseMinutes);
      if (!verdict.ok) return { ok: false, reason: 'not_seat', why: verdict.why, now: at };
      const cur = claimOf(input);
      // 这个座位的帅位自己占着的（开单时替帅位认领的）由现任帅位换给工人，和 Postgres 版的 seatReservationOf 一样
      const reserved = cur?.ownerKind === 'seat' && cur.seatScope === input.seat.scope;
      if (cur && isActiveClaim(cur.state) && !reserved)
        return { ok: false, reason: 'held', claim: copyClaim(cur), now: at };
      const replaced = cur && isActiveClaim(cur.state) ? copyClaim(cur) : null;
      const claim: IssueClaim = {
        repoId: input.repoId,
        issueNumber: input.issueNumber,
        claimId: randomUUID(),
        ownerKind: input.owner.kind,
        ownerMachine: input.seat.machine,
        ownerLabel: input.owner.label,
        seatScope: input.seat.scope,
        seatTerm: input.seat.term,
        state: 'claimed',
        workflowId: null,
        prNumbers: [],
        graceMinutes: input.graceMinutes ?? settings.settings.claimGraceMinutes,
        claimedAt: at,
        heartbeatAt: at,
        updatedAt: at,
        endedAt: null,
        endReason: null,
        note: input.note ?? null,
      };
      data.claims = [...data.claims.filter((c) => c !== cur), claim];
      audit({
        actor: seatActor(input.seat),
        action: 'claim.take',
        target: claimTarget(input),
        ...(replaced ? { before: claimSummary(replaced) } : {}),
        after: {
          ...claimSummary(claim),
          seat: `${input.seat.scope}#${input.seat.term}`,
          grace: claim.graceMinutes,
        },
        reason: input.note,
        via: 'engine',
        ok: true,
      });
      return { ok: true, claim: copyClaim(claim), now: at };
    },

    async stepClaim(input) {
      const at = nowIso();
      const cur = claimOf(input);
      if (!cur || !same(cur, input)) return { ok: false, claim: cur && copyClaim(cur), now: at };
      cur.heartbeatAt = at;
      cur.updatedAt = at;
      if (input.note !== undefined) cur.note = input.note;
      if (input.pr !== undefined) {
        if (!cur.prNumbers.includes(input.pr)) cur.prNumbers = [...cur.prNumbers, input.pr];
        cur.state = 'pr_open';
      } else if (cur.state === 'claimed') {
        cur.state = 'doing';
      }
      if (input.note !== undefined || input.pr !== undefined) {
        audit({
          actor: claimActor(cur),
          action: input.pr === undefined ? 'claim.step' : 'claim.pr',
          target: claimTarget(input),
          after: { claimId: cur.claimId, state: cur.state, pr: input.pr },
          reason: input.note,
          via: 'engine',
          ok: true,
        });
      }
      return { ok: true, claim: copyClaim(cur), now: at };
    },

    async endClaim(input) {
      const at = nowIso();
      const cur = claimOf(input);
      if (!cur || cur.claimId !== input.claimId || !isActiveClaim(cur.state))
        return { ok: false, claim: cur && copyClaim(cur), now: at };
      if (!input.reason) throw new Error('issue_claims_end_reason：放下、作废要写原因');
      cur.state = input.state;
      cur.endedAt = at;
      cur.updatedAt = at;
      cur.endReason = input.reason;
      audit({
        actor: claimActor(cur),
        action: input.state === 'done' ? 'claim.done' : 'claim.release',
        target: claimTarget(input),
        after: claimSummary(cur),
        reason: input.reason,
        via: 'engine',
        ok: true,
      });
      return { ok: true, claim: copyClaim(cur), now: at };
    },

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
      if (input.seat) {
        const problem = seatProblem(
          seatOf(input.seat.scope),
          input.seat,
          at,
          readSeatSettings(rawSettings()),
        );
        if (problem) return { ok: false, ...problem, now: at };
      }
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
            ...(input.seat ? { seat: `${input.seat.scope}#${input.seat.term}` } : {}),
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
      cur.endReason = reassignReason(input.founder);
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
