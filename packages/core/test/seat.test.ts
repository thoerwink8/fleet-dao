// 认领账和「认领对得上」的判法（#299，specs/299-帅位只一个/方案.md）：时间都是库的 now()，读不到、认不出算没查成。
import { describe, expect, it } from 'vitest';
import {
  CLAIM_STATUS_MAX,
  claimExpired,
  describeClaim,
  engineClaimEnd,
  heldByOtherText,
  type IssueClaim,
  isDrillScope,
  judgeClaimMatch,
  machineProblem,
  pullOfClaim,
  seatScopeProblem,
  sessionProblem,
} from '../src/seat.ts';

const T0 = '2026-09-27T08:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

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
