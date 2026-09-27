// 帅位租约和认领的 Store 契约（#299，ports.ts 的 SeatStore）：内存版和 Postgres 版过同一套。时间是库的 now()：
// 内存版用 Store 的钟，Postgres 版用库的钟，所以「过了多久」一律靠把记下的时刻往前挪（backdate），不靠拨钟。
import { beforeEach, describe, expect, it } from 'vitest';
import { devFixtures, IDS } from '../src/dev-fixtures.ts';
import type { MemoryData } from '../src/memory-store.ts';
import type { SeatActor, Store } from '../src/ports.ts';

export const SEAT_T0 = new Date('2026-09-27T08:00:00.000Z');

export interface SeatStoreUnderTest {
  store: Store;
  /** 把座位上次续约的时刻往前挪 minutes 分钟（造「很久没续约」）。 */
  backdateSeat(scope: string, minutes: number): Promise<void>;
  /** 把一张单认领的心跳和最后一次改动往前挪 minutes 分钟（造「很久没心跳」「待起很久了」）。 */
  backdateClaim(repoId: string, issueNumber: number, minutes: number): Promise<void>;
}

export type MakeSeatStore = (data: Partial<MemoryData>, clock: { now: Date }) => Promise<SeatStoreUnderTest>;

const A = { machine: '本机', session: 'a1' };
const B = { machine: '笔记本', session: 'b1' };
const actor = (who: typeof A, term: number, scope = 'main'): SeatActor => ({ ...who, scope, term });

export function describeSeatStoreContract(name: string, make: MakeSeatStore): void {
  describe(`帅位和认领（SeatStore）契约：${name}`, () => {
    let s: SeatStoreUnderTest;
    let store: Store;

    beforeEach(async () => {
      s = await make(devFixtures(SEAT_T0), { now: new Date(SEAT_T0) });
      store = s.store;
    });

    const seatAudits = async (target: string) =>
      (await store.listAudit({ target, limit: 50 })).items.map((a) => [a.action, a.actor.id]).reverse();

    describe('帅位', () => {
      it('接班：没人时第 1 任；换人接班任期加一、记下上一任；后说的算，同一个会话再说一次也加一；各记一条操作记录', async () => {
        const first = await store.takeSeat({ scope: 'main', ...A });
        expect(first.lease).toMatchObject({
          term: 1,
          holderMachine: '本机',
          holderSession: 'a1',
          previousMachine: null,
        });
        const second = await store.takeSeat({ scope: 'main', ...B });
        expect(second.lease).toMatchObject({
          term: 2,
          holderMachine: '笔记本',
          previousMachine: '本机',
          previousSession: 'a1',
        });
        expect((await store.takeSeat({ scope: 'main', ...B })).lease.term).toBe(3);
        expect(await seatAudits('seat:main')).toEqual([
          ['seat.take', '本机/a1'],
          ['seat.take', '笔记本/b1'],
          ['seat.take', '笔记本/b1'],
        ]);
      });

      it('读座位：没人是 null；带着库的 now 和租期设置（没写用默认）；演练座位和真帅位互不影响', async () => {
        const empty = await store.readSeat('main');
        expect(empty.lease).toBeNull();
        expect(Number.isFinite(Date.parse(empty.now))).toBe(true);
        expect(empty.settings).toEqual({
          ok: true,
          settings: { leaseMinutes: 45, claimGraceMinutes: 120 },
          source: 'default',
        });
        await store.takeSeat({ scope: 'drill:299', ...A });
        expect((await store.readSeat('main')).lease).toBeNull();
        expect((await store.readSeat('drill:299')).lease?.term).toBe(1);
      });

      it('【故意造出的失败】续约：带旧任期号、别的会话来续都不续，交回座位此刻的样子；对得上的续上（过了期也续得上）', async () => {
        await store.takeSeat({ scope: 'main', ...A });
        await s.backdateSeat('main', 60);
        const late = await store.renewSeat(actor(A, 1));
        expect(late).toMatchObject({ ok: true, lease: { term: 1 } });
        await store.takeSeat({ scope: 'main', ...B });
        const stale = await store.renewSeat(actor(A, 1));
        expect(stale).toMatchObject({ ok: false, lease: { term: 2, holderMachine: '笔记本' } });
        expect(await store.renewSeat(actor(A, 2))).toMatchObject({ ok: false });
      });

      it('交接说明：现任整份换掉；刚被换下的上一任接在后面补一段；别人写不进', async () => {
        await store.takeSeat({ scope: 'main', ...A });
        expect(
          await store.writeHandoff({ ...actor(A, 1), text: '在做 #299；等创始人拍 App 权限' }),
        ).toMatchObject({
          ok: true,
          lease: { handoff: '在做 #299；等创始人拍 App 权限' },
        });
        await store.takeSeat({ scope: 'main', ...B });
        const tail = await store.writeHandoff({ ...actor(A, 1), text: '创始人刚说：先演练再换真帅位' });
        expect(tail).toMatchObject({ ok: true });
        if (!tail.ok) throw new Error('上一任补不上交接');
        expect(tail.lease.handoff).toBe(
          '在做 #299；等创始人拍 App 权限\n\n（第 1 任 本机/a1 退役时补的）\n创始人刚说：先演练再换真帅位',
        );
        expect(
          await store.writeHandoff({ ...actor({ machine: '手机', session: 'x' }, 2), text: '冒名' }),
        ).toMatchObject({
          ok: false,
        });
      });
    });

    describe('认领', () => {
      const target = (issueNumber: number) => ({ repoId: IDS.repo, issueNumber });
      const take = (issueNumber: number, seat: SeatActor, label = '工人甲', graceMinutes?: number) =>
        store.takeClaim({
          ...target(issueNumber),
          seat,
          owner: { kind: 'worker', label },
          graceMinutes,
          note: '开工',
        });

      it('帅位认领：拿到新认领号，归派的工人，宽限期默认两小时，记一条 claim.take', async () => {
        await store.takeSeat({ scope: 'main', ...A });
        const got = await take(40, actor(A, 1));
        expect(got).toMatchObject({
          ok: true,
          claim: {
            ownerKind: 'worker',
            ownerMachine: '本机',
            ownerLabel: '工人甲',
            seatScope: 'main',
            seatTerm: 1,
            state: 'claimed',
            graceMinutes: 120,
            prNumbers: [],
            note: '开工',
          },
        });
        expect(await seatAudits(`claim:${IDS.repo}#40`)).toEqual([['claim.take', '本机/a1']]);
      });

      it('【故意造出的失败】不是帅位的认领被拒、这张单一点没动：座位上没人、带旧任期号、过了租期', async () => {
        expect(await take(40, actor(A, 1))).toMatchObject({ ok: false, reason: 'not_seat' });
        await store.takeSeat({ scope: 'main', ...A });
        await store.takeSeat({ scope: 'main', ...B });
        const stale = await take(40, actor(A, 1));
        expect(stale).toMatchObject({ ok: false, reason: 'not_seat' });
        if (stale.ok || stale.reason !== 'not_seat') throw new Error('旧任期还认领得上');
        expect(stale.why).toContain('帅位已经是 笔记本/b1（第 2 任）');
        await s.backdateSeat('main', 46);
        expect(await take(40, actor(B, 2))).toMatchObject({ ok: false, reason: 'not_seat' });
        expect((await store.getClaim(IDS.repo, 40)).claim).toBeNull();
        // 续约成了再认领就行
        await store.renewSeat(actor(B, 2));
        expect(await take(40, actor(B, 2))).toMatchObject({ ok: true });
      });

      it('【故意造出的失败】别人拿着还没结束：抢不到，交回是谁拿着', async () => {
        await store.takeSeat({ scope: 'main', ...A });
        const first = await take(41, actor(A, 1));
        const second = await take(41, actor(A, 1), '工人乙');
        expect(second).toMatchObject({ ok: false, reason: 'held', claim: { ownerLabel: '工人甲' } });
        if (!first.ok || second.ok) throw new Error('该一个拿到一个拿不到');
        if (second.reason !== 'held') throw new Error('该是别人拿着');
        expect(second.claim.claimId).toBe(first.claim.claimId);
      });

      it('帅位自己占着的（开单时替帅位认领的）：现任帅位换给工人（新认领号，操作记录记下原来那份）；【故意造出的失败】演练座位的帅位换不了', async () => {
        await store.takeSeat({ scope: 'main', ...A });
        const reserved = await store.takeClaim({
          ...target(49),
          seat: actor(A, 1),
          owner: { kind: 'seat', label: '帅位' },
        });
        if (!reserved.ok) throw new Error('帅位没占上');
        // 换了帅位：新帅位照样能把帅位占着的换给工人
        await store.takeSeat({ scope: 'main', ...B });
        await store.takeSeat({ scope: 'drill:299', ...A });
        expect(
          await store.takeClaim({
            ...target(49),
            seat: actor(A, 1, 'drill:299'),
            owner: { kind: 'worker', label: 'w1' },
          }),
        ).toMatchObject({ ok: false, reason: 'held', claim: { claimId: reserved.claim.claimId } });
        const handed = await take(49, actor(B, 2), '工人乙');
        expect(handed).toMatchObject({
          ok: true,
          claim: { ownerKind: 'worker', ownerLabel: '工人乙', seatTerm: 2 },
        });
        if (!handed.ok) throw new Error('没换给工人');
        expect(handed.claim.claimId).not.toBe(reserved.claim.claimId);
        const audits = (await store.listAudit({ target: `claim:${IDS.repo}#49`, limit: 5 })).items;
        expect(audits[0]).toMatchObject({
          action: 'claim.take',
          before: { claimId: reserved.claim.claimId, owner: '本机/帅位' },
        });
        // 工人拿着的，帅位不能直接换人（那是改派）
        expect(await take(49, actor(B, 2), '工人丙')).toMatchObject({ ok: false, reason: 'held' });
      });

      it('【故意造出的失败】换帅位后，旧帅位派的工人认领照旧有效：照报进度、开 PR、做完', async () => {
        await store.takeSeat({ scope: 'main', ...A });
        const got = await take(42, actor(A, 1));
        if (!got.ok) throw new Error('没认领上');
        await store.takeSeat({ scope: 'main', ...B });
        const key = { ...target(42), claimId: got.claim.claimId };
        expect(await store.stepClaim({ ...key, note: '在写测试' })).toMatchObject({
          ok: true,
          claim: { state: 'doing', note: '在写测试' },
        });
        expect(await store.stepClaim({ ...key, pr: 306 })).toMatchObject({
          ok: true,
          claim: { state: 'pr_open', prNumbers: [306] },
        });
        expect(await store.endClaim({ ...key, state: 'done', reason: 'PR #306 合了' })).toMatchObject({
          ok: true,
          claim: { state: 'done', endReason: 'PR #306 合了' },
        });
        // 旧帅位（第 1 任）派不了新活：认领新单被拒
        expect(await take(43, actor(A, 1))).toMatchObject({ ok: false, reason: 'not_seat' });
        expect(await seatAudits(`claim:${IDS.repo}#42`)).toEqual([
          ['claim.take', '本机/a1'],
          ['claim.step', '本机/工人甲'],
          ['claim.pr', '本机/工人甲'],
          ['claim.done', '本机/工人甲'],
        ]);
      });

      it('【故意造出的失败】拿着别的认领号、结束了的认领：报进度、结束都不写，交回这张单此刻的样子', async () => {
        await store.takeSeat({ scope: 'main', ...A });
        const got = await take(44, actor(A, 1));
        if (!got.ok) throw new Error('没认领上');
        const wrong = await store.stepClaim({
          ...target(44),
          claimId: '00000000-0000-4000-8000-000000000000',
        });
        expect(wrong).toMatchObject({ ok: false, claim: { claimId: got.claim.claimId } });
        await store.endClaim({
          ...target(44),
          claimId: got.claim.claimId,
          state: 'released',
          reason: '不做了',
        });
        expect(
          await store.stepClaim({ ...target(44), claimId: got.claim.claimId, note: '我回来了' }),
        ).toMatchObject({
          ok: false,
          claim: { state: 'released' },
        });
        expect(await store.stepClaim({ ...target(45), claimId: got.claim.claimId })).toMatchObject({
          ok: false,
          claim: null,
        });
        // 放下了的单，下一次认领换成新的认领号
        const again = await take(44, actor(A, 1), '工人乙');
        expect(again).toMatchObject({ ok: true, claim: { ownerLabel: '工人乙', state: 'claimed' } });
        if (!again.ok) throw new Error('放下了的单认领不上');
        expect(again.claim.claimId).not.toBe(got.claim.claimId);
      });

      it('【故意造出的失败】工人过了宽限期没心跳：认领作废、写明原因、记在引擎名下；还在宽限期里的不动', async () => {
        await store.takeSeat({ scope: 'main', ...A });
        await take(46, actor(A, 1));
        await take(47, actor(A, 1), '工人乙', 2);
        await s.backdateClaim(IDS.repo, 46, 119);
        await s.backdateClaim(IDS.repo, 47, 3);
        const swept = await store.voidExpiredClaims({ limit: 50 });
        expect(swept.voided.map((c) => [c.issueNumber, c.state, c.endReason])).toEqual([
          [47, 'voided', '过了宽限期（2 分钟）没心跳'],
        ]);
        expect((await store.voidExpiredClaims({ limit: 50 })).voided).toEqual([]);
        expect(await seatAudits(`claim:${IDS.repo}#47`)).toEqual([
          ['claim.take', '本机/a1'],
          ['claim.void', 'claims-sweep'],
        ]);
        expect((await store.listClaims({ activeOnly: true })).claims.map((c) => c.issueNumber)).toEqual([46]);
        expect(
          (await store.listClaims({ activeOnly: false, repoId: IDS.repo })).claims.map((c) => c.issueNumber),
        ).toEqual([46, 47]);
      });

      it('租期、宽限期的设置认不出：认领不做，写明是哪一项', async () => {
        const bad = await make(
          { ...devFixtures(SEAT_T0), settings: [{ key: 'seat.claimGraceMinutes', value: 'x', version: 1 }] },
          { now: new Date(SEAT_T0) },
        );
        await bad.store.takeSeat({ scope: 'main', ...A });
        const got = await bad.store.takeClaim({
          ...target(48),
          seat: actor(A, 1),
          owner: { kind: 'worker', label: '工人甲' },
        });
        expect(got).toMatchObject({ ok: false, reason: 'settings' });
        if (got.ok || got.reason !== 'settings') throw new Error('认不出的设置不该往下做');
        expect(got.why).toContain('seat.claimGraceMinutes');
        expect((await bad.store.getClaim(IDS.repo, 48)).claim).toBeNull();
      });
    });

    describe('引擎的认领（接活、交单）', () => {
      const target = (issueNumber: number) => ({ repoId: IDS.repo, issueNumber });
      const INTAKE = { kind: 'engine', id: 'github-intake' } as const;
      const engine = (issueNumber: number, over: Record<string, unknown> = {}) =>
        store.claimForEngine({
          ...target(issueNumber),
          workflowId: `req:example/canary#${issueNumber}`,
          actor: INTAKE,
          note: '接活自动派',
          ...over,
        });
      const worker = (issueNumber: number, seat: SeatActor) =>
        store.takeClaim({ ...target(issueNumber), seat, owner: { kind: 'worker', label: '工人甲' } });

      it('没有认领时拿到（待起、带工作流编号，记 claim.take）；再来一次是引擎自己拿着（同一个认领号）；起成了改在做', async () => {
        const first = await engine(60);
        expect(first).toMatchObject({
          ok: true,
          fresh: true,
          voided: null,
          claim: {
            ownerKind: 'engine',
            state: 'pending_start',
            workflowId: 'req:example/canary#60',
            seatScope: null,
          },
        });
        if (!first.ok) throw new Error('没拿到');
        const again = await engine(60);
        expect(again).toMatchObject({ ok: true, fresh: false, claim: { claimId: first.claim.claimId } });
        expect(await store.startEngineClaim(target(60))).toMatchObject({
          changed: true,
          claim: { state: 'doing' },
        });
        expect(await store.startEngineClaim(target(60))).toMatchObject({
          changed: false,
          claim: { state: 'doing' },
        });
        expect(await seatAudits(`claim:${IDS.repo}#60`)).toEqual([['claim.take', 'github-intake']]);
      });

      it('【故意造出的失败】本机拿着：引擎抢不到（held），这张单一点没动；本机先到、引擎后到，或者反过来，都只一边拿到', async () => {
        await store.takeSeat({ scope: 'main', ...A });
        const local = await worker(61, actor(A, 1));
        if (!local.ok) throw new Error('本机没认领上');
        expect(await engine(61)).toMatchObject({
          ok: false,
          reason: 'held',
          claim: { claimId: local.claim.claimId },
        });
        expect((await store.getClaim(IDS.repo, 61)).claim).toMatchObject({
          ownerKind: 'worker',
          state: 'claimed',
        });

        expect(await engine(62)).toMatchObject({ ok: true, fresh: true });
        expect(await worker(62, actor(A, 1))).toMatchObject({
          ok: false,
          reason: 'held',
          claim: { ownerKind: 'engine' },
        });
      });

      it('带创始人原话：作废本机的认领（写明原话，记 claim.reassign）、给引擎；旧工人拿着旧认领号报进度写不进', async () => {
        await store.takeSeat({ scope: 'main', ...A });
        const local = await worker(63, actor(A, 1));
        if (!local.ok) throw new Error('本机没认领上');
        const got = await engine(63, { founder: '这张给引擎' });
        expect(got).toMatchObject({
          ok: true,
          fresh: true,
          claim: { ownerKind: 'engine', state: 'pending_start' },
          voided: {
            claimId: local.claim.claimId,
            state: 'voided',
            endReason: '改派给引擎（创始人原话：这张给引擎）',
          },
        });
        expect(
          await store.stepClaim({ ...target(63), claimId: local.claim.claimId, note: '旧工人回来了' }),
        ).toMatchObject({ ok: false, claim: { ownerKind: 'engine' } });
        expect(await seatAudits(`claim:${IDS.repo}#63`)).toEqual([
          ['claim.take', '本机/a1'],
          ['claim.reassign', 'github-intake'],
          ['claim.take', 'github-intake'],
        ]);
      });

      it('【故意造出的失败】带着帅位来（交单）：不是帅位（换了人、过了租期、座位上没人）什么都不做；设置认不出也不做', async () => {
        expect(await engine(64, { seat: actor(A, 1) })).toMatchObject({ ok: false, reason: 'not_seat' });
        await store.takeSeat({ scope: 'main', ...A });
        await store.takeSeat({ scope: 'main', ...B });
        const stale = await engine(64, { seat: actor(A, 1) });
        expect(stale).toMatchObject({ ok: false, reason: 'not_seat' });
        if (stale.ok || stale.reason !== 'not_seat') throw new Error('旧任期不该拿到');
        expect(stale.why).toContain('帅位已经是 笔记本/b1（第 2 任）');
        await s.backdateSeat('main', 60);
        expect(await engine(64, { seat: actor(B, 2) })).toMatchObject({ ok: false, reason: 'not_seat' });
        expect((await store.getClaim(IDS.repo, 64)).claim).toBeNull();
        await store.renewSeat(actor(B, 2));
        expect(await engine(64, { seat: actor(B, 2) })).toMatchObject({ ok: true, fresh: true });
        expect((await store.listAudit({ target: `claim:${IDS.repo}#64`, limit: 5 })).items[0]).toMatchObject({
          actor: { id: 'github-intake' },
          after: { seat: 'main#2' },
        });

        const bad = await make(
          { ...devFixtures(SEAT_T0), settings: [{ key: 'seat.leaseMinutes', value: 0, version: 1 }] },
          { now: new Date(SEAT_T0) },
        );
        await bad.store.takeSeat({ scope: 'main', ...A });
        const got = await bad.store.claimForEngine({
          ...target(64),
          workflowId: 'req:example/canary#64',
          actor: INTAKE,
          seat: actor(A, 1),
        });
        expect(got).toMatchObject({ ok: false, reason: 'settings' });
        expect((await bad.store.getClaim(IDS.repo, 64)).claim).toBeNull();
      });

      it('待起很久的：只列引擎待起超过几分钟的（在做的、本机的不列）；放下要认领号对得上，放下了本机能接着认领', async () => {
        await store.takeSeat({ scope: 'main', ...A });
        const pending = await engine(65);
        await engine(66);
        await store.startEngineClaim(target(66));
        await worker(67, actor(A, 1));
        await engine(68);
        await s.backdateClaim(IDS.repo, 65, 10);
        await s.backdateClaim(IDS.repo, 66, 10);
        await s.backdateClaim(IDS.repo, 67, 10);
        await s.backdateClaim(IDS.repo, 68, 2);
        const stale = await store.listStalePendingEngineClaims({ minutes: 5, limit: 10 });
        expect(stale.claims.map((c) => c.issueNumber)).toEqual([65]);
        if (!pending.ok) throw new Error('没拿到');

        const wrong = await store.releasePendingEngineClaim({
          ...target(65),
          claimId: '00000000-0000-4000-8000-000000000000',
          reason: '开关关了',
          actor: INTAKE,
        });
        expect(wrong).toBeNull();
        const released = await store.releasePendingEngineClaim({
          ...target(65),
          claimId: pending.claim.claimId,
          reason: '开关关了',
          actor: INTAKE,
        });
        expect(released).toMatchObject({ state: 'released', endReason: '开关关了' });
        expect(await worker(65, actor(A, 1))).toMatchObject({ ok: true });
        // 在做的不算待起：放下不动它
        const doing = (await store.getClaim(IDS.repo, 66)).claim;
        expect(
          await store.releasePendingEngineClaim({
            ...target(66),
            claimId: doing?.claimId ?? '',
            reason: 'x',
            actor: INTAKE,
          }),
        ).toBeNull();
      });
    });
  });
}
