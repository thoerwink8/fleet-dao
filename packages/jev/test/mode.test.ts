// 只记不拦 ↔ 真拦的判定（纯函数）。
import { describe, expect, it } from 'vitest';
import {
  decideMode,
  type ExamOutcome,
  type ExamTally,
  examOutcome,
  type ModeInput,
  shadowStalled,
} from '../src/mode.ts';
import { DEFAULT_POLICY, mergePolicy } from '../src/policy.ts';
import { DAY } from './helpers.ts';

const P = DEFAULT_POLICY;
const pass: ExamOutcome = { state: 'pass', accuracy: 1, why: '考题准确率 100%' };
const fail: ExamOutcome = { state: 'fail', accuracy: 0.8, why: '考题准确率 80%，低于线 90%' };
const voided: ExamOutcome = { state: 'void', accuracy: null, why: '只答出 1/10 道' };
const input = (over: Partial<ModeInput>): ModeInput => ({
  mode: 'shadow',
  production: { samples: P.minSamples, correct: P.minSamples },
  exam: pass,
  drift: 0,
  ...over,
});

describe('只记不拦 → 真拦', () => {
  it('攒满样本、准确率过线、考题及格、没漂：转真拦', () => {
    const d = decideMode(input({ production: { samples: 50, correct: 45 } }), P);
    expect(d).toMatchObject({ mode: 'enforce', changed: true });
    expect(d.why).toContain('90%');
  });

  it('样本不够、准确率不到线、没考过、考试没考成或不及格、攒样本期间漂过：都不转', () => {
    const cases: [string, Partial<ModeInput>][] = [
      ['样本不够', { production: { samples: 49, correct: 49 } }],
      ['准确率不到线', { production: { samples: 50, correct: 44 } }],
      ['没考过', { exam: undefined }],
      ['考试没考成', { exam: voided }],
      ['考试不及格', { exam: fail }],
      ['攒样本期间漂过', { drift: 1 }],
    ];
    for (const [what, over] of cases) {
      expect(decideMode(input(over), P), what).toMatchObject({ mode: 'shadow', changed: false });
    }
  });

  it('线从配置读：准确率线调到 0.8，44/50 就够了', () => {
    const { policy } = mergePolicy(P, { 'judge.accuracyLine': 0.8 });
    expect(decideMode(input({ production: { samples: 50, correct: 44 } }), policy).mode).toBe('enforce');
  });
});

describe('真拦 → 退回只记不拦', () => {
  it('巡检考题不及格：退回', () => {
    expect(decideMode(input({ mode: 'enforce', exam: fail }), P)).toMatchObject({
      mode: 'shadow',
      changed: true,
    });
  });

  it('答了题面外的选项或回话模型不对：退回', () => {
    expect(decideMode(input({ mode: 'enforce', drift: 2 }), P).mode).toBe('shadow');
  });

  it('生产判定（人改判、结局回填）准确率掉到线下：退回', () => {
    expect(decideMode(input({ mode: 'enforce', production: { samples: 50, correct: 40 } }), P).mode).toBe(
      'shadow',
    );
  });

  it('考试没考成不算掉线：照旧真拦（没考成 ≠ 考砸）', () => {
    expect(decideMode(input({ mode: 'enforce', exam: voided }), P)).toMatchObject({
      mode: 'enforce',
      changed: false,
    });
  });

  it('人停的（off）谁也不动', () => {
    expect(decideMode(input({ mode: 'off' }), P)).toMatchObject({ mode: 'off', changed: false });
    expect(decideMode(input({ mode: 'off', exam: fail, drift: 3 }), P).mode).toBe('off');
  });
});

describe('考试怎么算', () => {
  const tally = (over: Partial<ExamTally>): ExamTally => ({
    runId: 'r',
    at: new Date(0),
    asked: 10,
    answered: 10,
    sure: 10,
    correct: 10,
    badOption: 0,
    ...over,
  });

  it('准确率 = 把握够且答对的 / 答在题面里的；到线就及格', () => {
    expect(examOutcome(tally({ correct: 9 }), P)).toMatchObject({ state: 'pass', accuracy: 0.9 });
    expect(examOutcome(tally({ correct: 8 }), P)).toMatchObject({ state: 'fail', accuracy: 0.8 });
  });

  it('把握不够的考题算没答对（考题都是标准答案清楚的题）', () => {
    expect(examOutcome(tally({ sure: 7, correct: 7 }), P).state).toBe('fail');
  });

  it('答出的不够八成、或少于最少道数：没考成，不当成考砸', () => {
    expect(examOutcome(tally({ answered: 7, sure: 7, correct: 7 }), P).state).toBe('void');
    expect(examOutcome(tally({ asked: 2, answered: 2, sure: 2, correct: 2 }), P).state).toBe('void');
  });

  it('答了题面外的选项：直接不及格', () => {
    expect(examOutcome(tally({ badOption: 1 }), P).state).toBe('fail');
  });
});

describe('影子停滞', () => {
  const now = new Date('2026-10-10T00:00:00Z');
  it('只记不拦挂满天数还没攒够样本：报停滞', () => {
    const first = new Date(now.getTime() - P.shadowStallDays * DAY);
    expect(shadowStalled({ mode: 'shadow', samples: 3, firstAskedAt: first, now }, P)).toBe(true);
  });

  it('没满天数、已经攒够、不在只记不拦、一次都没问过：都不报', () => {
    const recent = new Date(now.getTime() - (P.shadowStallDays - 1) * DAY);
    const old = new Date(now.getTime() - 30 * DAY);
    expect(shadowStalled({ mode: 'shadow', samples: 3, firstAskedAt: recent, now }, P)).toBe(false);
    expect(shadowStalled({ mode: 'shadow', samples: 50, firstAskedAt: old, now }, P)).toBe(false);
    expect(shadowStalled({ mode: 'enforce', samples: 3, firstAskedAt: old, now }, P)).toBe(false);
    expect(shadowStalled({ mode: 'shadow', samples: 0, now }, P)).toBe(false);
  });
});

describe('设置覆盖默认值', () => {
  it('合法的值用上，不合法的照默认并报出来', () => {
    const { policy, problems } = mergePolicy(P, {
      'judge.dailyCallLimit': 30,
      'judge.accuracyLine': 1.5,
      'judge.minSamples': 0,
    });
    expect(policy).toMatchObject({
      dailyCallLimit: 30,
      accuracyLine: P.accuracyLine,
      minSamples: P.minSamples,
    });
    expect(problems).toHaveLength(2);
  });

  it('考试的每日次数单独一项：合法的用上，认不出的报出来', () => {
    expect(mergePolicy(P, { 'judge.examDailyCallLimit': 900 }).policy.examDailyCallLimit).toBe(900);
    const { policy, problems } = mergePolicy(P, { 'judge.examDailyCallLimit': 2.5 });
    expect(policy.examDailyCallLimit).toBe(P.examDailyCallLimit);
    expect(problems.join('')).toContain('judge.examDailyCallLimit');
  });
});
