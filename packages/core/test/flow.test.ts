// 执行状态机的边界表：一行一条（当前状态 + 发生的事 → 下一步、要外壳做的事），含故意造出失败的行。
import { describe, expect, it } from 'vitest';
import { FLOW_LIMITS, type FlowEvent, type FlowState, nextFlow, startFlow } from '../src/flow.ts';

const base = startFlow('fusion', false);
const at = (patch: Partial<FlowState>): FlowState => ({ ...base, ...patch });
const planned = (p: Partial<Extract<FlowEvent, { kind: 'planned' }>> = {}): FlowEvent => ({
  kind: 'planned',
  blocks: 1,
  small: false,
  highRisk: false,
  matchesDiscussion: false,
  ...p,
});

type Row = [
  name: string,
  state: FlowState,
  event: FlowEvent,
  want: { step: FlowState['step']; action: string; patch?: Partial<FlowState> } | { error: RegExp },
];

const rows: Row[] = [
  ['讨论完 → 收单', at({ step: 'discuss' }), { kind: 'discussed' }, { step: 'intake', action: 'intake' }],
  ['收完 → 规划', at({ step: 'intake' }), { kind: 'intaken' }, { step: 'plan', action: 'plan' }],
  [
    '规划完、不小、和讨论不一致 → 方案评审',
    at({ step: 'plan' }),
    planned({ blocks: 2 }),
    { step: 'review', action: 'review-plan', patch: { blocks: 2, block: 0 } },
  ],
  ['小单跳过评审', at({ step: 'plan' }), planned({ small: true }), { step: 'execute', action: 'dispatch' }],
  [
    '和讨论结论一致跳过评审',
    at({ step: 'plan' }),
    planned({ matchesDiscussion: true }),
    { step: 'execute', action: 'dispatch' },
  ],
  [
    '单模型模式第 3 步关',
    at({ mode: 'single', step: 'plan' }),
    planned(),
    { step: 'execute', action: 'dispatch' },
  ],
  [
    '评审完 → 执行',
    at({ step: 'review', blocks: 1 }),
    { kind: 'reviewed' },
    { step: 'execute', action: 'dispatch' },
  ],
  [
    '收下 → 验证（Fusion 每张都验）',
    at({ step: 'execute', blocks: 1 }),
    { kind: 'accepted' },
    { step: 'verify', action: 'verify' },
  ],
  [
    '单模型不高风险：收下直接开 PR',
    at({ mode: 'single', step: 'execute', blocks: 1 }),
    { kind: 'accepted' },
    { step: 'pr', action: 'open-pr' },
  ],
  [
    '单模型高风险：照样验证',
    at({ mode: 'single', step: 'execute', blocks: 1, highRisk: true }),
    { kind: 'accepted' },
    { step: 'verify', action: 'verify' },
  ],
  [
    '第一次打回 → 再派',
    at({ step: 'execute', blocks: 1 }),
    { kind: 'rejected' },
    { step: 'execute', action: 'dispatch', patch: { reworks: 1 } },
  ],
  [
    `打回满 ${FLOW_LIMITS.reworks} 次 → Lead 接手`,
    at({ step: 'execute', blocks: 1, reworks: FLOW_LIMITS.reworks }),
    { kind: 'rejected' },
    { step: 'execute', action: 'lead-takeover', patch: { takeover: true } },
  ],
  [
    '验证过了 → 开 PR',
    at({ step: 'verify', blocks: 1 }),
    { kind: 'verified', verdict: 'pass' },
    { step: 'pr', action: 'open-pr' },
  ],
  [
    '验证第一轮没过 → 回执行',
    at({ step: 'verify', blocks: 1 }),
    { kind: 'verified', verdict: 'block' },
    { step: 'execute', action: 'dispatch', patch: { verifyRounds: 1 } },
  ],
  [
    'Lead 已接手时验证没过 → 还是 Lead 改',
    at({ step: 'verify', blocks: 1, takeover: true }),
    { kind: 'verified', verdict: 'block' },
    { step: 'execute', action: 'lead-takeover' },
  ],
  [
    '验证第二轮还没过 → 停下等人',
    at({ step: 'verify', blocks: 1, verifyRounds: 1 }),
    { kind: 'verified', verdict: 'block' },
    { step: 'parked', action: 'wait-human', patch: { resume: 'execute' } },
  ],
  [
    '验证只配了 1 轮：第一轮没过就停下等人',
    at({ step: 'verify', blocks: 1, verifyLimit: 1 }),
    { kind: 'verified', verdict: 'block' },
    { step: 'parked', action: 'wait-human', patch: { resume: 'execute', verifyRounds: 1 } },
  ],
  [
    'CI 绿 → Lead 最终审查',
    at({ step: 'pr', blocks: 1 }),
    { kind: 'ci', state: 'green' },
    { step: 'final-review', action: 'final-review' },
  ],
  [
    '单模型模式 CI 绿 → 也由 Lead 收尾、写结果（结果随 PR 进仓）',
    at({ mode: 'single', step: 'pr', blocks: 1 }),
    { kind: 'ci', state: 'green' },
    { step: 'final-review', action: 'final-review' },
  ],
  [
    '最终审查过了 → 合并',
    at({ step: 'final-review', blocks: 1 }),
    { kind: 'final-reviewed', verdict: 'pass' },
    { step: 'merge', action: 'merge' },
  ],
  [
    '最终审查要改 → 回第 6 步修一轮',
    at({ step: 'final-review', blocks: 1, ciRounds: 1 }),
    { kind: 'final-reviewed', verdict: 'fix' },
    { step: 'pr', action: 'fix-ci', patch: { ciRounds: 2 } },
  ],
  [
    `最终审查要改、已经修满 ${FLOW_LIMITS.ciRounds} 轮 → 停下等人，恢复后接着修`,
    at({ step: 'final-review', blocks: 1, ciRounds: FLOW_LIMITS.ciRounds }),
    { kind: 'final-reviewed', verdict: 'fix' },
    { step: 'parked', action: 'wait-human', patch: { resume: 'pr' } },
  ],
  [
    '合并前退回 → 回第 6 步修一轮',
    at({ step: 'merge', blocks: 1 }),
    { kind: 'merge-returned' },
    { step: 'pr', action: 'fix-ci', patch: { ciRounds: 1 } },
  ],
  [
    `合并前退回、已经修满 ${FLOW_LIMITS.ciRounds} 轮 → 停下等人`,
    at({ step: 'merge', blocks: 1, ciRounds: FLOW_LIMITS.ciRounds }),
    { kind: 'merge-returned' },
    { step: 'parked', action: 'wait-human', patch: { resume: 'pr' } },
  ],
  [
    'CI 没查成 → 再查，不算一轮',
    at({ step: 'pr', blocks: 1, ciRounds: 1 }),
    { kind: 'ci', state: 'unknown' },
    { step: 'pr', action: 'recheck-ci', patch: { ciRounds: 1 } },
  ],
  [
    'CI 红 → 修一轮',
    at({ step: 'pr', blocks: 1 }),
    { kind: 'ci', state: 'red' },
    { step: 'pr', action: 'fix-ci', patch: { ciRounds: 1 } },
  ],
  [
    `CI 修满 ${FLOW_LIMITS.ciRounds} 轮还红 → 停下等人`,
    at({ step: 'pr', blocks: 1, ciRounds: FLOW_LIMITS.ciRounds }),
    { kind: 'ci', state: 'red' },
    { step: 'parked', action: 'wait-human', patch: { resume: 'pr' } },
  ],
  [
    '还有块 → 下一块，计数清零',
    at({ step: 'merge', blocks: 3, block: 0, reworks: 2, takeover: true, verifyRounds: 1, ciRounds: 2 }),
    { kind: 'merged' },
    {
      step: 'execute',
      action: 'dispatch',
      patch: { block: 1, reworks: 0, takeover: false, verifyRounds: 0, ciRounds: 0 },
    },
  ],
  [
    '小单最后一块合了 → 关单',
    at({ step: 'merge', blocks: 1 }),
    { kind: 'merged' },
    { step: 'done', action: 'close' },
  ],
  [
    '母单最后一块合了 → 母单级验证',
    at({ step: 'merge', blocks: 2, block: 1, mother: true }),
    { kind: 'merged' },
    { step: 'mother-verify', action: 'verify-mother' },
  ],
  [
    '母单级验证过了 → 关单',
    at({ step: 'mother-verify', blocks: 2, block: 1, mother: true }),
    { kind: 'mother-verified', verdict: 'pass' },
    { step: 'done', action: 'close' },
  ],
  [
    '母单级验证没过 → 停下，恢复后重新规划',
    at({ step: 'mother-verify', blocks: 2, block: 1, mother: true }),
    { kind: 'mother-verified', verdict: 'block' },
    { step: 'parked', action: 'wait-human', patch: { resume: 'plan' } },
  ],
  [
    '哪一步都能停下等人',
    at({ step: 'execute', blocks: 1 }),
    { kind: 'needs-human', why: '方案说不清，要问创始人' },
    { step: 'parked', action: 'wait-human', patch: { resume: 'execute', why: '方案说不清，要问创始人' } },
  ],
  [
    '恢复 → 回到停下的那一步',
    at({ step: 'parked', blocks: 1, ciRounds: 2, resume: 'pr', why: 'x' }),
    { kind: 'resumed' },
    { step: 'pr', action: 'fix-ci' },
  ],
  // 故意造出的失败：认不出的组合明说，不猜着往下走
  ['【失败】关了的单再来事件', at({ step: 'done', blocks: 1 }), { kind: 'merged' }, { error: /已经关了/ }],
  ['【失败】规划没拆出块', at({ step: 'plan' }), planned({ blocks: 0 }), { error: /没拆出能做的块/ }],
  [
    '【失败】执行时收到 CI 结果',
    at({ step: 'execute', blocks: 1 }),
    { kind: 'ci', state: 'green' },
    { error: /不该收到/ },
  ],
  [
    '【失败】单模型模式打回',
    at({ mode: 'single', step: 'execute', blocks: 1 }),
    { kind: 'rejected' },
    { error: /单模型模式没有副手/ },
  ],
  [
    '【失败】Lead 接手后又打回',
    at({ step: 'execute', blocks: 1, takeover: true }),
    { kind: 'rejected' },
    { error: /Lead 已经自己接手/ },
  ],
  [
    '【失败】停下等人没写原因',
    at({ step: 'execute', blocks: 1 }),
    { kind: 'needs-human', why: '  ' },
    { error: /写明原因/ },
  ],
  [
    '【失败】已经在等人又叫一次',
    at({ step: 'parked', blocks: 1, resume: 'pr' }),
    { kind: 'needs-human', why: 'x' },
    { error: /已经在等人/ },
  ],
  ['【失败】没停下却收到恢复', at({ step: 'pr', blocks: 1 }), { kind: 'resumed' }, { error: /不该收到/ }],
  [
    '【失败】等人却没记回哪一步',
    at({ step: 'parked', blocks: 1 }),
    { kind: 'resumed' },
    { error: /没记恢复后回哪一步/ },
  ],
  [
    '【失败】块号越界',
    at({ step: 'merge', blocks: 2, block: 2 }),
    { kind: 'merged' },
    { error: /一共只有 2 块/ },
  ],
  [
    '【失败】计数是负的',
    at({ step: 'pr', blocks: 1, ciRounds: -1 }),
    { kind: 'ci', state: 'red' },
    { error: /ciRounds/ },
  ],
  [
    '【失败】验证轮数配成 3（上限 2）',
    at({ step: 'verify', blocks: 1, verifyLimit: 3 }),
    { kind: 'verified', verdict: 'block' },
    { error: /验证最多 3 轮/ },
  ],
  [
    '【失败】还没过 CI 就收到最终审查的结论',
    at({ step: 'pr', blocks: 1 }),
    { kind: 'final-reviewed', verdict: 'pass' },
    { error: /不该收到/ },
  ],
  [
    '【失败】执行时收到合并前退回',
    at({ step: 'execute', blocks: 1 }),
    { kind: 'merge-returned' },
    { error: /不该收到/ },
  ],
];

describe('Fusion 执行状态机', () => {
  it.each(rows)('%s', (_name, state, event, want) => {
    const got = nextFlow(state, event);
    if ('error' in want) {
      expect(got.ok).toBe(false);
      if (!got.ok) expect(got.why).toMatch(want.error);
      return;
    }
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.state.step).toBe(want.step);
    expect(got.action).toBe(want.action);
    for (const [k, v] of Object.entries(want.patch ?? {})) {
      expect(got.state[k as keyof FlowState], k).toEqual(v);
    }
  });

  it('离开「等人」后不留旧的原因', () => {
    const got = nextFlow(at({ step: 'parked', blocks: 1, resume: 'verify', why: '等额度' }), {
      kind: 'resumed',
    });
    expect(got.ok && got.state.why).toBe(undefined);
    expect(got.ok && got.state.resume).toBe(undefined);
  });

  it('一张两块的母单从开单走到关单', () => {
    let state = startFlow('fusion', true);
    const events: FlowEvent[] = [
      { kind: 'discussed' },
      { kind: 'intaken' },
      planned({ blocks: 2 }),
      { kind: 'reviewed' },
      { kind: 'rejected' },
      { kind: 'accepted' },
      { kind: 'verified', verdict: 'pass' },
      { kind: 'ci', state: 'red' },
      { kind: 'ci', state: 'green' },
      { kind: 'final-reviewed', verdict: 'fix' },
      { kind: 'ci', state: 'green' },
      { kind: 'final-reviewed', verdict: 'pass' },
      { kind: 'merge-returned' },
      { kind: 'ci', state: 'green' },
      { kind: 'final-reviewed', verdict: 'pass' },
      { kind: 'merged' },
      { kind: 'accepted' },
      { kind: 'verified', verdict: 'pass' },
      { kind: 'ci', state: 'green' },
      { kind: 'final-reviewed', verdict: 'pass' },
      { kind: 'merged' },
      { kind: 'mother-verified', verdict: 'pass' },
    ];
    for (const e of events) {
      const got = nextFlow(state, e);
      if (!got.ok) throw new Error(`${e.kind}：${got.why}`);
      state = got.state;
    }
    expect(state.step).toBe('done');
  });
});
