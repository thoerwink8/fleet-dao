// #1773：20:46「收单」断链的公开旁证分类（GitHub 巡检仓 #83 / PR #84），钉住不是总开关/接活/白名单。
import { describe, expect, it } from 'vitest';
import { classifyCanaryIntakeBreak, ROUND_27_EVIDENCE } from '../src/jobs/canary-intake-forensics.ts';

describe('canary 收单断链旁证分类（#1773）', () => {
  it('第 27 轮：开单→恰好约 20 分钟判超时→:48 才开 PR→做完关单 → intake_slot_delay', () => {
    const got = classifyCanaryIntakeBreak(ROUND_27_EVIDENCE);
    expect(got.class).toBe('intake_slot_delay');
    expect(got.ruledOut).toEqual(
      expect.arrayContaining([
        'master_off',
        'dispatch_off',
        'untrusted_or_brief',
        'empty_source',
        'breaker_all_window',
      ]),
    );
    expect(got.why).toMatch(/空位|准入/);
  });

  it('【故意造出的失败】没有超时后起任务的旁证：不能归到 intake_slot_delay', () => {
    const got = classifyCanaryIntakeBreak({
      ...ROUND_27_EVIDENCE,
      firstEnginePrAt: ROUND_27_EVIDENCE.openedAt,
      closedCompletedAt: ROUND_27_EVIDENCE.openedAt,
    });
    expect(got.class).not.toBe('intake_slot_delay');
  });
});
