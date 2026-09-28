// 帅位（#446，specs/446-帅位认领简化/需求.md）：帅位不再是锁，这里只剩给人看的判法；认领账留作记录，心跳、宽限期
// 不再拿来自动作废。时间都是库的 now()，读不到、认不出明说，不拿「刚刚」顶。
import { describe, expect, it } from 'vitest';
import {
  applyBoardWrite,
  DEFAULT_CLAIM_GRACE_MINUTES,
  describeClaim,
  emptySeatBoard,
  engineClaimEnd,
  heldByOtherText,
  holderText,
  type IssueClaim,
  isDrillScope,
  lastActivityText,
  machineProblem,
  readSeatBoard,
  type SeatLease,
  seatScopeProblem,
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
  lastActivityAt: at(-10),
  previousMachine: '笔记本',
  previousSession: 's0',
  handoff: null,
  handoffAt: null,
};

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

describe('holderText：给人看的「机器/会话」', () => {
  it('拼机器名和会话号', () => {
    expect(holderText(lease)).toBe('本机/s1');
  });
});

describe('lastActivityAt 只给人看（#446）：像 K8s Lease 的 renewTime，没人拿它判断谁能写', () => {
  it('算「最后活动 N 分钟/小时前」', () => {
    expect(lastActivityText(at(-10), T0)).toBe('最后活动 10 分钟前');
    expect(lastActivityText(at(-130), T0)).toBe('最后活动 2 小时 10 分钟前');
  });

  it('很久没活动（好几个小时）也照样算得出来：不当成过期，字面上也不拦任何东西', () => {
    expect(lastActivityText(at(-6 * 60), T0)).toBe('最后活动 6 小时 0 分钟前');
    expect(lastActivityText(at(-999), T0)).toBe('最后活动 16 小时 39 分钟前');
  });

  it('【故意造出的失败】时刻认不出：明说没读到，不拿「刚刚」顶', () => {
    expect(lastActivityText('yesterday', T0)).toBe('最后活动：没读到');
    expect(lastActivityText(at(-10), 'now')).toBe('最后活动：没读到');
  });
});

describe('认领：心跳、宽限期只留作记录（#446 起没有东西拿它们自动作废）', () => {
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

  it('给人看的一行：谁、状态、进度、认领号前 8 位、上次心跳、PR；心跳早过了宽限期也不说要作废', () => {
    expect(describeClaim(claim, T0)).toBe(
      '本机/工人甲 开了 PR：在写测试（认领 0f0e0d0c，上次心跳 2 小时 1 分钟前，PR #306）',
    );
    expect(
      describeClaim({ ...claim, state: 'voided', endReason: '两小时没心跳', endedAt: T0 }, T0),
    ).toContain('作废了（两小时没心跳）');
  });

  it('DEFAULT_CLAIM_GRACE_MINUTES 只是给新认领一个默认值，不是判过期的门槛', () => {
    expect(DEFAULT_CLAIM_GRACE_MINUTES).toBe(120);
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
