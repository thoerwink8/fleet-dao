// verdict.ts 判定测试：happy path 给 ok；故意造红的每种都必须明确失败（kind: 'failed'），不许空当 ok。

import { describe, expect, it } from 'vitest';
import type { OneShotResult } from '../../src/runner/one-shot.ts';
import { judgeManual, judgeScope, judgeVerify } from '../../src/runner/verdict.ts';

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

describe('judgeScope', () => {
  it('done + stdout 非空 → ok', () => {
    expect(judgeScope(r({})).kind).toBe('ok');
  });
  it('done 但 stdout 空 → failed（**不拿空当跑完**）', () => {
    const v = judgeScope(r({ stdout: '   ' }));
    expect(v.kind).toBe('failed');
    expect(v.reason).toMatch(/空|不许/);
  });
  it('outcome 不是 done → failed', () => {
    const v = judgeScope(r({ outcome: 'timeout' }));
    expect(v.kind).toBe('failed');
  });
});

describe('judgeManual', () => {
  it('done + stdout + PR# + branch + headSha + changedFiles → ok', () => {
    const v = judgeManual(r({}), {
      prNumber: 999,
      branch: 'feat/x',
      headSha: 'a'.repeat(40),
      changedFiles: ['a.ts'],
    });
    expect(v.kind).toBe('ok');
  });
  it('没给 PR# → failed，写明原因', () => {
    const v = judgeManual(r({}), {
      branch: 'feat/x',
      headSha: 'a'.repeat(40),
      changedFiles: ['a.ts'],
    });
    expect(v.kind).toBe('failed');
    expect(v.reason).toMatch(/PR/);
  });
  it('没 branch → failed', () => {
    const v = judgeManual(r({}), {
      prNumber: 1,
      headSha: 'a'.repeat(40),
      changedFiles: ['a.ts'],
    });
    expect(v.kind).toBe('failed');
    expect(v.reason).toMatch(/branch/);
  });
  it('changedFiles 空 → failed（没改任何文件就是没干活）', () => {
    const v = judgeManual(r({}), {
      prNumber: 1,
      branch: 'feat/x',
      headSha: 'a'.repeat(40),
      changedFiles: [],
    });
    expect(v.kind).toBe('failed');
    expect(v.reason).toMatch(/changedFiles|没改/);
  });
  it('outcome != done → failed（不看 evidence）', () => {
    const v = judgeManual(r({ outcome: 'killed' }), {
      prNumber: 1,
      branch: 'feat/x',
      headSha: 'a'.repeat(40),
      changedFiles: ['a.ts'],
    });
    expect(v.kind).toBe('failed');
  });
});

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
