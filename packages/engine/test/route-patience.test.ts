// 有界耐心的纯判法（决定 0093，借 magpie gateway-routing 的 Patience）：歇多久、预算夹在 240 秒以内、读不到不当成 0；
// 歇掉的从会话时限里扣。
import { describe, expect, it } from 'vitest';
import {
  patienceStep,
  ROUTE_PATIENCE_MAX_SECONDS,
  ROUTE_PATIENCE_SECONDS,
  segmentMinutesAfterPatience,
} from '../src/workflows/task-support.ts';

describe('patienceStep', () => {
  it('默认预算 60 秒：歇 15、30 秒，再歇就超了，照旧停下并写明已等多久', () => {
    expect(ROUTE_PATIENCE_SECONDS).toBe(60);
    expect(patienceStep({ sinceSeconds: 0, round: 0 })).toEqual({ kind: 'pause', seconds: 15 });
    expect(patienceStep({ sinceSeconds: 15, round: 1 })).toEqual({ kind: 'pause', seconds: 30 });
    const out = patienceStep({ sinceSeconds: 45, round: 2 });
    expect(out.kind).toBe('out');
    expect(out.kind === 'out' && out.reason).toContain('已等 45 秒，预算 60 秒');
  });

  it('预算最多 240 秒；给多了按 240，认不出的按默认', () => {
    expect(ROUTE_PATIENCE_MAX_SECONDS).toBe(240);
    expect(patienceStep({ sinceSeconds: 200, round: 5, budgetSeconds: 999 })).toEqual({
      kind: 'pause',
      seconds: 30,
    });
    expect(patienceStep({ sinceSeconds: 220, round: 5, budgetSeconds: 999 }).kind).toBe('out');
    expect(patienceStep({ sinceSeconds: 50, round: 0, budgetSeconds: Number.NaN }).kind).toBe('out');
  });

  it('【故意造出的失败】已等多久算不出：不当成 0 接着歇，直接用完照旧停下', () => {
    const out = patienceStep({ sinceSeconds: Number.NaN, round: 0 });
    expect(out).toEqual({ kind: 'out', reason: '耐心等待算不出已等多久，照旧停下' });
  });
});

describe('segmentMinutesAfterPatience：歇掉的计入会话时限', () => {
  it('从时限里扣（不足一分钟按一分钟），至少留 1 分钟；没歇、读不到不扣', () => {
    expect(segmentMinutesAfterPatience(60, 45)).toBe(59);
    expect(segmentMinutesAfterPatience(60, 240)).toBe(56);
    expect(segmentMinutesAfterPatience(2, 600)).toBe(1);
    expect(segmentMinutesAfterPatience(60, 0)).toBe(60);
    expect(segmentMinutesAfterPatience(60, Number.NaN)).toBe(60);
  });
});
