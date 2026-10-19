// 一笔会话为什么起、冷验收结论怎么算（#3140）。
import { describe, expect, it } from 'vitest';
import {
  clipCauseSummary,
  criterionNumbersOf,
  RUN_CAUSE_LABELS,
  RUN_CAUSE_SUMMARY_MAX,
  RUN_CAUSES,
  RunVerdictSchema,
  verdictOf,
} from '../src/index.ts';

describe('起因名单', () => {
  it('每个起因都有给人看的说法，名单没有重复', () => {
    expect(Object.keys(RUN_CAUSE_LABELS).sort()).toEqual([...RUN_CAUSES].sort());
    expect(new Set(RUN_CAUSES).size).toBe(RUN_CAUSES.length);
  });
});

describe('clipCauseSummary', () => {
  it('空白折成一个空格；不超长原样；超长截到上限、末尾省略号、总长不超', () => {
    expect(clipCauseSummary('  a\n\n b  ')).toBe('a b');
    expect(clipCauseSummary('x'.repeat(RUN_CAUSE_SUMMARY_MAX))).toHaveLength(RUN_CAUSE_SUMMARY_MAX);
    const cut = clipCauseSummary('x'.repeat(900));
    expect(cut).toHaveLength(RUN_CAUSE_SUMMARY_MAX);
    expect(cut.endsWith('…')).toBe(true);
    expect(clipCauseSummary('abcdef', 4)).toBe('abc…');
  });
});

describe('验收结论', () => {
  it('从问题里认第几条没过：「第 N 条」，同一个号只留一次，按出现先后', () => {
    expect(criterionNumbersOf(['第 3 条没做到', '第3条和第 1 条都不对', '别的问题'])).toEqual([3, 1]);
    expect(criterionNumbersOf([])).toEqual([]);
  });

  it('没过：带问题原话和认出的条；过了：问题和条都清空；转给人的两种情况都带', () => {
    expect(verdictOf({ pass: false, problems: ['第 2 条没做到'], outOfScope: ['截图要人看'] })).toEqual({
      pass: false,
      problems: ['第 2 条没做到'],
      failedCriteria: [2],
      handedOver: ['截图要人看'],
    });
    expect(verdictOf({ pass: true, problems: ['不该带'], outOfScope: undefined })).toEqual({
      pass: true,
      problems: [],
      failedCriteria: [],
      handedOver: [],
    });
  });

  it('每条问题截 300 字、最多 20 条；写进库前的形状校验认它', () => {
    const v = verdictOf({ pass: false, problems: Array.from({ length: 30 }, () => '长'.repeat(500)) });
    expect(v.problems).toHaveLength(20);
    expect(v.problems[0]).toHaveLength(300);
    expect(RunVerdictSchema.safeParse(v).success).toBe(true);
    expect(RunVerdictSchema.safeParse({ pass: 'yes' }).success).toBe(false);
    expect(RunVerdictSchema.safeParse({ ...v, failedCriteria: [0] }).success).toBe(false);
  });
});
