// 能拦不能放：Jev 的结论在类型上就表达不出放行、批准合并、动账号、删除。
import { describe, expect, expectTypeOf, it } from 'vitest';
import { BANK, type TRIAGE_GATE } from '../src/bank.ts';
import { EFFECTS, EFFECTS_CANNOT_RELEASE, type Effect } from '../src/effects.ts';
import { defineQuestion, type EffectOf } from '../src/questions.ts';
import type { NotJudged, Verdict } from '../src/verdict.ts';

describe('能拦不能放', () => {
  it('效果只有收紧的几种', () => {
    expect([...EFFECTS]).toEqual(['none', 'flag', 'reroute', 'send_back', 'stop']);
    expect(EFFECTS_CANNOT_RELEASE).toBe(true);
  });

  it('题库里每个选项挂的都是这几种之一', () => {
    for (const q of BANK) for (const o of q.options) expect(EFFECTS).toContain(o.effect);
  });

  it('类型上：选项挂不了放行一类的效果，调用方拿到的 act 也表达不出放行', () => {
    defineQuestion({
      id: 'bad',
      site: 'triage',
      title: '坏题',
      instructions: '？',
      options: [
        // @ts-expect-error 没有「批准合并」这种效果
        { id: 'ok', label: '行', criteria: '行', effect: 'approve', does: '合并' },
        { id: 'no', label: '不行', criteria: '不行', effect: 'none', does: '照常' },
      ],
      evidence: [{ key: 'x', label: 'x', required: true }],
      whenUnsure: '照常',
      confidenceLine: 0.7,
    });
    expectTypeOf<Verdict['act']>().toEqualTypeOf<Effect>();
    expectTypeOf<NotJudged['act']>().toEqualTypeOf<'none'>();
    expectTypeOf<Verdict<typeof TRIAGE_GATE>['act']>().toEqualTypeOf<'none' | 'stop'>();
    expectTypeOf<EffectOf<typeof TRIAGE_GATE>>().toEqualTypeOf<'none' | 'stop'>();
    // @ts-expect-error 分诊人闸这道题最多只能让流程停下，act 不会是「换路」
    expectTypeOf<Verdict<typeof TRIAGE_GATE>['act']>().toEqualTypeOf<Effect>();
  });
});
