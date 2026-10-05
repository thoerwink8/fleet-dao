// verdict.ts 判定测试：happy path 给 ok；故意造红的每种都必须明确失败（kind: 'failed'），不许空当 ok。

import { describe, expect, it } from 'vitest';
import type { OneShotResult } from '../../src/runner/one-shot.ts';
import { judgeVerify } from '../../src/runner/verdict.ts';

function r(over: Partial<OneShotResult>): OneShotResult {
  return {
    runId: 'r-1',
    outcome: 'done',
    exitCode: 0,
    stdout: '做了',
    stderrTail: '',
    startedAt: '2026-10-02T00:00:00Z',
    endedAt: '2026-10-02T00:01:00Z',
    runsNotWired: false,
    ...over,
  };
}

describe('judgeVerify', () => {
  it('结论行带 pass → ok', () => {
    const v = judgeVerify(r({}), { verdictLine: 'verdict: pass（没发现挡的）' });
    expect(v.kind).toBe('ok');
  });
  it('结论行带 fail → ok（fail 是合法结论，不是「没跑成」）', () => {
    const v = judgeVerify(r({}), { verdictLine: 'verdict: fail（验收条 3 没过）' });
    expect(v.kind).toBe('ok');
  });
  it('结论行又 pass 又 fail → failed（一句话说不清）', () => {
    const v = judgeVerify(r({}), { verdictLine: 'pass 一半，fail 一半' });
    expect(v.kind).toBe('failed');
  });
  it('结论行没写 → failed（不许含糊）', () => {
    const v = judgeVerify(r({}), { verdictLine: '我看过了，还行' });
    expect(v.kind).toBe('failed');
  });
  it('没给 verdictLine → failed', () => {
    const v = judgeVerify(r({}), {});
    expect(v.kind).toBe('failed');
  });
});
