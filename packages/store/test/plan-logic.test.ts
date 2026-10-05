// 会话报的 plan 进度 → 计划步骤（两套 Store 的 getPlans 共用）：会话写的东西不可信，认不出的步骤跳过、不抛。
import { describe, expect, it } from 'vitest';
import { planSteps } from '../src/plan-logic.ts';

describe('planSteps', () => {
  it('按顺序给步骤，index 从 0 编', () => {
    expect(
      planSteps({
        steps: [
          { title: '读代码', state: 'done' },
          { title: '改', state: 'doing' },
        ],
      }),
    ).toEqual([
      { index: 0, title: '读代码', state: 'done' },
      { index: 1, title: '改', state: 'doing' },
    ]);
  });

  it('【故意造出的失败】payload 是 null、不是对象、没有 steps、steps 不是数组：空，不抛', () => {
    for (const payload of [null, undefined, 'x', 3, {}, { steps: 'x' }, { steps: null }]) {
      expect(planSteps(payload), JSON.stringify(payload)).toEqual([]);
    }
  });

  it('【故意造出的失败】缺 title 或 state 的步骤跳过，留下的重新编号', () => {
    expect(
      planSteps({
        steps: [null, { title: 1, state: 'done' }, { title: '写测试' }, { title: '跑', state: 'todo' }, 'x'],
      }),
    ).toEqual([{ index: 0, title: '跑', state: 'todo' }]);
  });
});
