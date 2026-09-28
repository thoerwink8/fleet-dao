// 帅位和认领的 Store 契约（#446，ports.ts 的 SeatStore）：内存版和 Postgres 版过同一套。时间是库的 now()：
// 内存版用 Store 的钟，Postgres 版用库的钟，所以「过了多久」一律靠把记下的时刻往前挪（backdate），不靠拨钟。
// #446 起帅位不是锁：接班永远成功、认领不核「是不是现在的帅位」——只挡「这张单已经被别人活着拿着」这一种冲突，
// 除非带 force（改派）。lastActivityAt 只给人看，backdateSeat 用来证明没有东西拿它判断谁能写。
import { beforeEach, describe, expect, it } from 'vitest';
import { devFixtures, IDS } from '../src/dev-fixtures.ts';
import type { MemoryData } from '../src/memory-store.ts';
import type { SeatActor, Store } from '../src/ports.ts';

export const SEAT_T0 = new Date('2026-09-27T08:00:00.000Z');

export interface SeatStoreUnderTest {
  store: Store;
  /** 把座位「最后活动时间」往前挪 minutes 分钟（造「很久没有任何动静」，证明没有东西拿它判断谁能写）。 */
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

      it('读座位：没人是 null；带着库的 now；演练座位和真帅位互不影响', async () => {
        const empty = await store.readSeat('main');
        expect(empty.lease).toBeNull();
        expect(Number.isFinite(Date.parse(empty.now))).toBe(true);
        await store.takeSeat({ scope: 'drill:299', ...A });
        expect((await store.readSeat('main')).lease).toBeNull();
        expect((await store.readSeat('drill:299')).lease?.term).toBe(1);
      });

      it('#446：帅位不是锁，接班永远成功——不管座位上是谁、换没换人，后说的都直接接得上，没有「抢不到」这回事', async () => {
        await store.takeSeat({ scope: 'main', ...A });
        // 别人马上又接：不用先交、不用等，照样成
        const again = await store.takeSeat({ scope: 'main', ...B });
        expect(again.lease).toMatchObject({ term: 2, holderMachine: '笔记本' });
        // A 自己也还能再接一次（不因为已经换给了 B 就被拒绝）
        expect((await store.takeSeat({ scope: 'main', ...A })).lease).toMatchObject({ term: 3 });
      });

      it('很久没有任何活动（backdate 最后活动时间）不影响任何操作：没有续约这回事了，seat 不会因为「太久没动」失效', async () => {
        await store.takeSeat({ scope: 'main', ...A });
        await s.backdateSeat('main', 6 * 60); // 6 小时前的最后活动时间
        expect(await store.writeHandoff({ ...actor(A, 1), text: '好久没动过了，但照样能写' })).toMatchObject({
          ok: true,
        });
        expect(
          await store.takeClaim({
            repoId: IDS.repo,
            issueNumber: 40,
            seat: actor(A, 1),
            owner: { kind: 'worker', label: '工人甲' },
            note: '开工',
          }),
        ).toMatchObject({ ok: true });
      });

      it('交接说明：座位上有人就整份换掉，lastActivityAt 顶成现在，不核写的人是不是现任；座位上没人写不进', async () => {
        await store.takeSeat({ scope: 'main', ...A });
        expect(
          await store.writeHandoff({ ...actor(A, 1), text: '在做 #299；等创始人拍 App 权限' }),
        ).toMatchObject({
          ok: true,
          lease: { handoff: '在做 #299；等创始人拍 App 权限' },
        });
        await store.takeSeat({ scope: 'main', ...B });
        // #446 起旧帅位（A，第 1 任）照样写得进——不核是不是现任了
        const tail = await store.writeHandoff({ ...actor(A, 1), text: '创始人刚说：先演练再换真帅位' });
        expect(tail).toMatchObject({ ok: true, lease: { handoff: '创始人刚说：先演练再换真帅位' } });
        // 座位从没接过班：没什么可交接的
        const vacant = await store.writeHandoff({ ...actor(A, 1, 'drill:没人来过'), text: '交接' });
        expect(vacant).toMatchObject({ ok: false, lease: null });
      });

      it('写交接说明会把 lastActivityAt 顶成现在（只给人看，像 K8s Lease 的 renewTime）', async () => {
        const { lease: taken } = await store.takeSeat({ scope: 'main', ...A });
        await s.backdateSeat('main', 120);
        const before = (await store.readSeat('main')).lease?.lastActivityAt;
        expect(Date.parse(before ?? '')).toBeLessThan(Date.parse(taken.lastActivityAt));
        const r = await store.writeHandoff({ ...actor(A, 1), text: '刚写了一句' });
        if (!r.ok) throw new Error('没写进交接');
        expect(Date.parse(r.lease.lastActivityAt)).toBeGreaterThan(Date.parse(before ?? ''));
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

      it('#446：认领不核是不是帅位——没接过班、带旧任期号、很久没动静，都照样认领得上；term 也可以不给', async () => {
        // 座位从没人接过班：照样认领得上（不再是「按不是帅位算」）
        expect(await take(40, actor(A, 1))).toMatchObject({ ok: true });
        await store.takeSeat({ scope: 'main', ...A });
        await store.takeSeat({ scope: 'main', ...B });
        // A 带着旧任期号（第 1 任，其实已经是第 2 任 B 了）：照样认领得上
        expect(await take(41, actor(A, 1))).toMatchObject({ ok: true });
        await s.backdateSeat('main', 6 * 60);
        expect(await take(42, actor(B, 2))).toMatchObject({ ok: true });
        // term 不给也行（纯记录，没人拿它核对）：写成 0（issue_claims_seat_shape 要求 scope 非空时 term 也非空）
        const noTerm: SeatActor = { machine: '手机', session: 'x1', scope: 'main' };
        expect(await take(43, noTerm)).toMatchObject({ ok: true, claim: { seatTerm: 0 } });
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
        // 工人拿着的，帅位不能直接换人（那是改派，要 force）
        expect(await take(49, actor(B, 2), '工人丙')).toMatchObject({ ok: false, reason: 'held' });
      });

      it('换帅位后，旧帅位派的工人认领照旧有效：照报进度、开 PR、做完；旧帅位自己也还能接着派新活（#446 不核身份）', async () => {
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
        // 旧帅位（第 1 任）没被拦：照样能派新活（真要换人接管靠人手工交接，不是系统挡着）
        expect(await take(43, actor(A, 1))).toMatchObject({ ok: true });
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

      it('【故意造出的失败】过了宽限期没心跳：#446 起没有 voidExpiredClaims 了，不再自动作废、一直显示在活跃认领里', async () => {
        await store.takeSeat({ scope: 'main', ...A });
        await take(46, actor(A, 1));
        await take(47, actor(A, 1), '工人乙', 2);
        await s.backdateClaim(IDS.repo, 46, 119);
        await s.backdateClaim(IDS.repo, 47, 3); // 过了它自己 2 分钟的宽限期，#446 之前这里会被作废
        expect(
          (await store.listClaims({ activeOnly: true })).claims.map((c) => c.issueNumber).sort(),
        ).toEqual([46, 47]);
        expect((await store.getClaim(IDS.repo, 47)).claim).toMatchObject({
          state: 'claimed',
          endReason: null,
        });
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

      it('force: true 才作废本机的认领、给引擎（founder 只是记进原因，不是触发条件）；旧工人拿着旧认领号报进度写不进', async () => {
        await store.takeSeat({ scope: 'main', ...A });
        const local = await worker(63, actor(A, 1));
        if (!local.ok) throw new Error('本机没认领上');
        // 只带 founder、不带 force：不触发强制改派，照样 held（#446 起触发条件是 force，不是 founder）
        expect(await engine(63, { founder: '这张给引擎' })).toMatchObject({ ok: false, reason: 'held' });
        const got = await engine(63, { founder: '这张给引擎', force: true });
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

      it('帅位改派给本机（#348）：force: true 作废引擎的、别的工人的（记 claim.reassign，写明给谁、原话），交回作废的那份；【故意造出的失败】不带 force 就是 held，这张没动', async () => {
        await store.takeSeat({ scope: 'main', ...A });
        const eng = await engine(65);
        if (!eng.ok) throw new Error('引擎没拿到');
        const reassign = (
          issueNumber: number,
          label: string,
          opts: { force?: boolean; founder?: string } = {},
        ) =>
          store.takeClaim({
            ...target(issueNumber),
            seat: actor(A, 1),
            owner: { kind: 'worker', label },
            ...opts,
          });
        expect(await reassign(65, '工人乙')).toMatchObject({
          ok: false,
          reason: 'held',
          claim: { ownerKind: 'engine' },
        });
        expect((await store.getClaim(IDS.repo, 65)).claim).toMatchObject({ claimId: eng.claim.claimId });
        const got = await reassign(65, '工人乙', { force: true, founder: '65 本机做' });
        expect(got).toMatchObject({
          ok: true,
          claim: { ownerKind: 'worker', ownerLabel: '工人乙', state: 'claimed' },
          voided: {
            claimId: eng.claim.claimId,
            state: 'voided',
            endReason: '改派给本机/工人乙（创始人原话：65 本机做）',
          },
          previous: { claimId: eng.claim.claimId, state: 'voided' },
        });
        // 工人拿着的也能强制改派给另一个工人
        const again = await reassign(65, '工人丙', { force: true, founder: '换丙做' });
        if (!got.ok || !again.ok) throw new Error('改派没成');
        expect(again.voided).toMatchObject({ claimId: got.claim.claimId, ownerLabel: '工人乙' });
        expect(await seatAudits(`claim:${IDS.repo}#65`)).toEqual([
          ['claim.take', 'github-intake'],
          ['claim.reassign', '本机/a1'],
          ['claim.take', '本机/a1'],
          ['claim.reassign', '本机/a1'],
          ['claim.take', '本机/a1'],
        ]);
        // 原来的已经结束了的：不用 force 也能认领，previous 交回原来那份（不是 voided，是 released）
        await store.endClaim({
          ...target(65),
          claimId: again.claim.claimId,
          state: 'released',
          reason: '放下',
        });
        const after = await reassign(65, '工人丁');
        expect(after).toMatchObject({
          ok: true,
          voided: null,
          previous: { claimId: again.claim.claimId, state: 'released' },
        });
      });

      it('#446：带不带帅位、帅位新不新（没接过班、旧任期、很久没动静）都不影响引擎能不能拿到——seat 只是记进操作记录', async () => {
        expect(await engine(64, { seat: actor(A, 1) })).toMatchObject({ ok: true });
        await store.takeSeat({ scope: 'main', ...A });
        await store.takeSeat({ scope: 'main', ...B });
        await s.backdateSeat('main', 6 * 60);
        expect(await engine(70, { seat: actor(A, 1) })).toMatchObject({ ok: true });
        expect((await store.listAudit({ target: `claim:${IDS.repo}#70`, limit: 5 })).items[0]).toMatchObject({
          actor: { id: 'github-intake' },
          after: { seat: 'main#1' },
        });
        // 不带 seat 也一样能拿到（接活自动派本来就不带帅位）
        expect(await engine(71)).toMatchObject({ ok: true });
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
