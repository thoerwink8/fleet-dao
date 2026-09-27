// 帅位租约和认领的判法（#299，specs/299-帅位只一个/方案.md 第二节）：时间都是库的 now()，读不到、认不出按不是帅位算。
import { describe, expect, it } from 'vitest';
import {
  applyBoardWrite,
  CLAIM_STATUS_MAX,
  claimExpired,
  describeClaim,
  emptySeatBoard,
  engineClaimEnd,
  heldByOtherText,
  type IssueClaim,
  isDrillScope,
  judgeClaimMatch,
  machineProblem,
  pullOfClaim,
  readSeatBoard,
  readSeatSettings,
  SEAT_DEFAULTS,
  type SeatLease,
  seatScopeProblem,
  seatVerdict,
  sessionProblem,
} from '../src/seat.ts';

const T0 = '2026-09-27T08:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

const lease: SeatLease = {
  scope: 'main',
  term: 3,
  holderMachine: '本机',
  holderSession: 's1',
  acquiredAt: at(-100),
  renewedAt: at(-10),
  previousMachine: '笔记本',
  previousSession: 's0',
  handoff: null,
  handoffAt: null,
};
const me = { machine: '本机', session: 's1', term: 3 };

describe('帅位栏（#199）', () => {
  const need = {
    kind: 'need' as const,
    id: 'n1',
    question: '先做哪件',
    options: ['接口', '页面'],
    recommended: '接口',
    repo: 'o/r',
    issue: 12,
  };

  it('状态写错：拒绝，板不动', () => {
    const added = applyBoardWrite(
      emptySeatBoard(),
      { kind: 'add', id: 's1', order: 1, title: '写', detail: '' },
      T0,
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const bad = applyBoardWrite(added.doc, { kind: 'step', id: 's1', status: 'nope' }, T0);
    expect(bad).toMatchObject({ ok: false, reason: 'bad' });
    expect(added.doc.steps[0]?.status).toBe('waiting');
  });

  it('选项不在列表里：拒绝，这一问还在', () => {
    const withNeed = applyBoardWrite(emptySeatBoard(), need, T0);
    expect(withNeed.ok).toBe(true);
    if (!withNeed.ok) return;
    const bad = applyBoardWrite(withNeed.doc, { kind: 'answer', id: 'n1', option: '别的', by: 'u' }, T0);
    expect(bad).toMatchObject({ ok: false, reason: 'bad' });
    expect(withNeed.doc.needs).toHaveLength(1);
    const ok = applyBoardWrite(withNeed.doc, { kind: 'answer', id: 'n1', option: '页面', by: 'u' }, T0);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.doc.needs).toHaveLength(0);
    expect(ok.doc.answers[0]).toMatchObject({ option: '页面', ackedAt: null });
    const again = applyBoardWrite(ok.doc, { kind: 'answer', id: 'n1', option: '接口', by: 'u' }, T0);
    expect(again).toMatchObject({ ok: false, reason: 'already' });
  });

  it('认不出的板不能当成空的', () => {
    expect(readSeatBoard({ headline: '', steps: 'x', log: [], needs: [], answers: [] }).ok).toBe(false);
  });
});

describe('租期、宽限期的配置（settings 表的 seat.leaseMinutes、seat.claimGraceMinutes）', () => {
  it('没写：用默认，写明用的是默认', () => {
    expect(readSeatSettings({})).toEqual({ ok: true, settings: SEAT_DEFAULTS, source: 'default' });
    expect(SEAT_DEFAULTS).toEqual({ leaseMinutes: 45, claimGraceMinutes: 120 });
  });

  it('写了一项：另一项用默认', () => {
    expect(readSeatSettings({ leaseMinutes: 30 })).toEqual({
      ok: true,
      settings: { leaseMinutes: 30, claimGraceMinutes: 120 },
      source: 'settings',
    });
  });

  it('【故意造出的失败】写了却认不出：明确失败、写明是哪一项，不拿默认顶', () => {
    for (const bad of [null, 'x', 0, 1.5, 7 * 24 * 60 + 1]) {
      const got = readSeatSettings({ claimGraceMinutes: bad });
      expect(got.ok, JSON.stringify(bad)).toBe(false);
      if (got.ok) throw new Error('认不出的设置不该当成能用');
      expect(got.why).toMatch(/^设置 seat.claimGraceMinutes 要是 1 到 10080 之间的整数/);
    }
  });
});

describe('座位名、机器名、会话号', () => {
  it('座位只认 main 和 drill:<名字>', () => {
    expect(seatScopeProblem('main')).toBeNull();
    expect(seatScopeProblem('drill:299')).toBeNull();
    expect(isDrillScope('drill:演练')).toBe(true);
    expect(isDrillScope('main')).toBe(false);
    for (const bad of ['', 'Main', 'drill:', 'drill:a b', 'prod'])
      expect(seatScopeProblem(bad), bad).toContain('不行');
  });

  it('机器名照 doing.mjs 的写法；会话号多允许冒号', () => {
    expect(machineProblem('本机')).toBeNull();
    expect(machineProblem('a:b')).toContain('不行');
    expect(sessionProblem('agent:a9f1')).toBeNull();
    expect(sessionProblem('有 空格', '工人名')).toContain('工人名「有 空格」不行');
  });
});

describe('现查：还是不是帅位（dbNow 是库的 now()）', () => {
  it('任期、持有人对得上、没过期：是帅位，带上租约到几点', () => {
    expect(seatVerdict(lease, me, T0, 45)).toEqual({ ok: true, term: 3, expiresAt: at(35) });
  });

  it('【故意造出的失败】座位上没人：不是帅位', () => {
    expect(seatVerdict(null, me, T0, 45)).toMatchObject({ ok: false, reason: 'vacant' });
  });

  it('【故意造出的失败】帅位换了人（任期号更大、或持有人不同）：不是帅位，写明现在是谁、第几任', () => {
    const got = seatVerdict({ ...lease, term: 4, holderMachine: '笔记本', holderSession: 's9' }, me, T0, 45);
    expect(got).toMatchObject({ ok: false, reason: 'replaced' });
    if (got.ok) throw new Error('换了人还当自己是帅位');
    expect(got.why).toBe('帅位已经是 笔记本/s9（第 4 任），不是 本机/s1（第 3 任）');
    // 同一台机器、同一任期，会话不同也不算（两个窗口都被说了「你当帅位」，后说的那个接了班）
    expect(seatVerdict(lease, { ...me, session: 's2' }, T0, 45)).toMatchObject({ reason: 'replaced' });
    // 带旧任期号来的：拒
    expect(seatVerdict(lease, { ...me, term: 2 }, T0, 45)).toMatchObject({ reason: 'replaced' });
  });

  it('【故意造出的失败】过了租期没续上：不是帅位（fail closed），写明多久没续', () => {
    const got = seatVerdict(lease, me, at(35), 45);
    expect(got).toMatchObject({ ok: false, reason: 'expired' });
    if (got.ok) throw new Error('过期了还当自己是帅位');
    expect(got.why).toContain('上次续约是 45 分钟前（租期 45 分钟）');
  });

  it('【故意造出的失败】时刻认不出：没查成，按不是帅位算', () => {
    expect(seatVerdict({ ...lease, renewedAt: 'yesterday' }, me, T0, 45)).toMatchObject({
      ok: false,
      reason: 'unreadable',
    });
    expect(seatVerdict(lease, me, 'now', 45)).toMatchObject({ ok: false, reason: 'unreadable' });
  });
});

describe('认领过了宽限期没心跳：作废', () => {
  const claim: IssueClaim = {
    repoId: 'r1',
    issueNumber: 40,
    claimId: '0f0e0d0c-0000-4000-8000-000000000001',
    ownerKind: 'worker',
    ownerMachine: '本机',
    ownerLabel: '工人甲',
    seatScope: 'main',
    seatTerm: 3,
    state: 'pr_open',
    workflowId: null,
    prNumbers: [306],
    graceMinutes: 120,
    claimedAt: at(-300),
    heartbeatAt: at(-121),
    updatedAt: at(-121),
    endedAt: null,
    endReason: null,
    note: '在写测试',
  };

  it('本机的认领，最后一次心跳超过宽限期：作废；还在宽限期里：不作废', () => {
    expect(claimExpired(claim, T0)).toBe(true);
    expect(claimExpired({ ...claim, heartbeatAt: at(-119) }, T0)).toBe(false);
    expect(claimExpired({ ...claim, graceMinutes: 2, heartbeatAt: at(-3) }, T0)).toBe(true);
  });

  it('引擎的认领、已经结束的认领不按心跳作废；心跳时刻认不出也不作废（作废要撤自动合并，不拿认不出当过期）', () => {
    expect(claimExpired({ ...claim, ownerKind: 'engine', ownerMachine: null, ownerLabel: null }, T0)).toBe(
      false,
    );
    expect(claimExpired({ ...claim, state: 'released', endedAt: at(-10), endReason: '不做了' }, T0)).toBe(
      false,
    );
    expect(claimExpired({ ...claim, heartbeatAt: 'x' }, T0)).toBe(false);
  });

  it('给人看的一行：谁、状态、进度、认领号前 8 位、上次心跳、PR，过了宽限期的点出来', () => {
    expect(describeClaim(claim, T0)).toBe(
      '本机/工人甲 开了 PR：在写测试（认领 0f0e0d0c，上次心跳 2 小时 1 分钟前，PR #306，过了宽限期没心跳，下一轮作废）',
    );
    expect(
      describeClaim({ ...claim, state: 'voided', endReason: '两小时没心跳', endedAt: T0 }, T0),
    ).toContain('作废了（两小时没心跳）');
  });
});

describe('引擎的认领', () => {
  it('任务结束了跟着结束：做完记做完，叫停、没做成记放下（本机能接着认领）；没结束的是 null（待起改在做）', () => {
    expect(engineClaimEnd('done')).toEqual({ state: 'done', reason: 'Fusion 做完了' });
    expect(engineClaimEnd('stopped')).toEqual({ state: 'released', reason: '任务叫停了' });
    expect(engineClaimEnd('failed')).toEqual({ state: 'released', reason: 'Fusion 没做成（任务 failed）' });
    for (const state of [
      'queued',
      'triaging',
      'asking',
      'planning',
      'running',
      'merging',
      'stalled',
    ] as const)
      expect(engineClaimEnd(state), state).toBeNull();
  });

  it('别人拿着时给人看的一句：本机的写明是哪个座位第几任认领的', () => {
    const c: IssueClaim = {
      repoId: 'r',
      issueNumber: 40,
      claimId: '0f0e0d0c-0000-4000-8000-000000000000',
      ownerKind: 'worker',
      ownerMachine: '本机',
      ownerLabel: 'w1',
      seatScope: 'main',
      seatTerm: 2,
      state: 'doing',
      workflowId: null,
      prNumbers: [],
      graceMinutes: 120,
      claimedAt: at(-30),
      heartbeatAt: at(-5),
      updatedAt: at(-5),
      endedAt: null,
      endReason: null,
      note: null,
    };
    expect(heldByOtherText(c, T0)).toBe(
      '这张单本机认领着（main 第 2 任帅位认领的）：本机/w1 在做（认领 0f0e0d0c，上次心跳 5 分钟前）',
    );
  });
});

describe('「认领对得上」（#348）：挂了单的 PR 要是现在这份认领的', () => {
  const ID = '0f0e0d0c-0000-4000-8000-00000000000a';
  const OLD = '0a0b0c0d-0000-4000-8000-00000000000b';
  const worker: IssueClaim = {
    repoId: 'r',
    issueNumber: 40,
    claimId: ID,
    ownerKind: 'worker',
    ownerMachine: '本机',
    ownerLabel: 'w1',
    seatScope: 'main',
    seatTerm: 2,
    state: 'doing',
    workflowId: null,
    prNumbers: [],
    graceMinutes: 120,
    claimedAt: at(-30),
    heartbeatAt: at(-5),
    updatedAt: at(-5),
    endedAt: null,
    endReason: null,
    note: null,
  };
  const engine: IssueClaim = {
    ...worker,
    ownerKind: 'engine',
    ownerMachine: null,
    ownerLabel: null,
    seatScope: null,
    seatTerm: null,
    workflowId: 'req:o/r#40',
  };
  const pr = { issueNumber: 40, byAgentBot: false, prNumber: 7, prClaimId: undefined as string | undefined };

  it('没挂单、这张单没有认领记录：过（认领上线前开的、创始人自己开的 PR 不被挡）', () => {
    expect(judgeClaimMatch({ ...pr, issueNumber: undefined, claim: worker })).toEqual({
      state: 'success',
      description: '没挂单，不查认领',
    });
    expect(judgeClaimMatch({ ...pr, claim: null })).toEqual({
      state: 'success',
      description: '#40 没有认领记录，不查认领',
    });
  });

  it('本机的认领还活着：正文「认领」栏写的是现在的认领号，或者这个 PR 用它登记过，就过', () => {
    expect(judgeClaimMatch({ ...pr, claim: worker, prClaimId: ID })).toEqual({
      state: 'success',
      description: '#40 归 本机/w1，认领号对得上（0f0e0d0c）',
    });
    expect(judgeClaimMatch({ ...pr, claim: { ...worker, prNumbers: [7] } }).state).toBe('success');
  });

  it('【故意造出的失败】旧认领号、没写认领号、登记的是别的 PR：红，写清现在归谁、PR 上写的是哪个', () => {
    expect(judgeClaimMatch({ ...pr, claim: worker, prClaimId: OLD })).toEqual({
      state: 'failure',
      description: '#40 现在归 本机/w1（认领 0f0e0d0c），PR 上写的是 0a0b0c0d；不是这份认领的 PR 合不进去',
    });
    expect(judgeClaimMatch({ ...pr, claim: { ...worker, prNumbers: [8] } })).toEqual({
      state: 'failure',
      description:
        '#40 现在归 本机/w1（认领 0f0e0d0c），PR 正文「认领」栏没写认领号；不是这份认领的 PR 合不进去',
    });
    // 「干活的」机器人开的也不算：本机的认领只认认领号
    expect(judgeClaimMatch({ ...pr, claim: worker, byAgentBot: true }).state).toBe('failure');
  });

  it('引擎的认领：只有「干活的」机器人开的 PR 过；待起的也一样', () => {
    expect(judgeClaimMatch({ ...pr, claim: engine, byAgentBot: true })).toEqual({
      state: 'success',
      description: '#40 归引擎，PR 是引擎开的',
    });
    expect(
      judgeClaimMatch({ ...pr, claim: { ...engine, state: 'pending_start' }, byAgentBot: true }).state,
    ).toBe('success');
    expect(judgeClaimMatch({ ...pr, claim: engine, prClaimId: ID })).toEqual({
      state: 'failure',
      description: '#40 归引擎在做（认领 0f0e0d0c），这个 PR 不是引擎开的；要改派得创始人说',
    });
  });

  it('【故意造出的失败】认领结束了（做完、放下、作废）：一律红，写认领号就对得上也不行；原因不写进状态（改派原因带创始人原话）', () => {
    for (const state of ['done', 'released', 'voided'] as const) {
      const ended = { ...worker, state, endedAt: at(-1), endReason: '改派给引擎（创始人原话：不做了）' };
      const got = judgeClaimMatch({ ...pr, claim: ended, prClaimId: ID });
      expect(got.state, state).toBe('failure');
      expect(got.description).toContain('#40 的认领（本机/w1，0f0e0d0c）');
      expect(got.description).toContain('没人拿着；要接着做先找帅位重新认领');
      expect(got.description).not.toContain('创始人原话');
    }
    const engineDone = { ...engine, state: 'done' as const, endedAt: at(-1), endReason: 'Fusion 做完了' };
    expect(judgeClaimMatch({ ...pr, claim: engineDone, byAgentBot: true }).state).toBe('failure');
  });

  it('状态说明不超过 GitHub 的 140 个字符（名字再长也截断，不让 GitHub 拒收）', () => {
    const long = { ...worker, ownerLabel: '很长的工人名'.repeat(30) };
    const got = judgeClaimMatch({ ...pr, claim: long, prClaimId: OLD });
    expect([...got.description].length).toBeLessThanOrEqual(CLAIM_STATUS_MAX);
    expect(got.description.endsWith('…')).toBe(true);
  });

  it('哪些 PR 算这份认领开的（作废、改派时只动这些）：正文写着它的认领号、用它登记过、引擎的认领下「干活的」机器人开的', () => {
    const pull = { number: 7, prClaimId: undefined as string | undefined, byAgentBot: false };
    expect(pullOfClaim(worker, { ...pull, prClaimId: ID })).toBe(true);
    expect(pullOfClaim({ ...worker, prNumbers: [7] }, pull)).toBe(true);
    expect(pullOfClaim(worker, { ...pull, prClaimId: OLD })).toBe(false);
    expect(pullOfClaim(worker, { ...pull, byAgentBot: true })).toBe(false);
    expect(pullOfClaim(engine, { ...pull, byAgentBot: true })).toBe(true);
    expect(pullOfClaim(engine, pull)).toBe(false);
  });
});
