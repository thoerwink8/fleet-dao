import { describe, expect, it } from 'vitest';
import { checkDone } from '../src/done-check.ts';
import type { PullRequestRecord, TestRunRecord } from '../src/ports.ts';

const pr = (over: Partial<PullRequestRecord> = {}): PullRequestRecord => ({
  repoId: 'repo-1',
  number: 31,
  state: 'open',
  headRef: 'fleet/12-a',
  headSha: 'abc',
  checks: 'pending',
  ...over,
});
const test = (passed: boolean, at = '2026-09-25T08:00:00Z'): TestRunRecord => ({
  at,
  passed,
  command: 'pnpm check',
});
const base = { stage: 'execute' as const, branch: 'fleet/12-a' };
const req = (over: Partial<{ summary: string; prNumber: number; testsPassed: boolean }> = {}) => ({
  summary: '做完了',
  prNumber: 31,
  testsPassed: true,
  ...over,
});

function reasonsOf(v: ReturnType<typeof checkDone>): string {
  return v.ok ? '' : v.reasons.join('\n');
}

describe('checkDone', () => {
  it('自己报测试没过：直接退回', () => {
    const v = checkDone({ ...base, request: req({ testsPassed: false }), pr: pr(), tests: [test(true)] });
    expect(v).toMatchObject({ ok: false, status: 422 });
    expect(reasonsOf(v)).toContain('测试没过');
  });

  it('写码的活不带 PR：退回；写需求文档这类活不带 PR：收下', () => {
    expect(
      checkDone({ ...base, request: { summary: 's', testsPassed: true }, pr: null, tests: [test(true)] }),
    ).toMatchObject({
      ok: false,
      status: 422,
    });
    expect(
      checkDone({
        stage: 'spec',
        branch: 'b',
        request: { summary: 's', testsPassed: true },
        pr: null,
        tests: [],
      }).ok,
    ).toBe(true);
  });

  it('带了 PR 但库里还没有：409（暂时核实不了），不是 422', () => {
    expect(checkDone({ ...base, request: req(), pr: null, tests: [test(true)] })).toMatchObject({
      ok: false,
      status: 409,
      code: 'not_verifiable_yet',
    });
  });

  it('PR 关了、分支不对：退回', () => {
    expect(
      reasonsOf(checkDone({ ...base, request: req(), pr: pr({ state: 'closed' }), tests: [test(true)] })),
    ).toContain('已经关了');
    expect(
      reasonsOf(checkDone({ ...base, request: req(), pr: pr({ headRef: 'x' }), tests: [test(true)] })),
    ).toContain('不是本会话的分支');
  });

  it('测试证据：CI 红一票否决；CI 绿就够；CI 没出结果看会话里最后一次测试', () => {
    expect(
      checkDone({ ...base, request: req(), pr: pr({ checks: 'failure' }), tests: [test(true)] }).ok,
    ).toBe(false);
    expect(checkDone({ ...base, request: req(), pr: pr({ checks: 'success' }), tests: [] }).ok).toBe(true);
    expect(checkDone({ ...base, request: req(), pr: pr(), tests: [] }).ok).toBe(false);
    const redThenGreen = [test(false, '2026-09-25T08:00:00Z'), test(true, '2026-09-25T08:05:00Z')];
    expect(checkDone({ ...base, request: req(), pr: pr(), tests: redThenGreen }).ok).toBe(true);
    const greenThenRed = [test(true, '2026-09-25T08:00:00Z'), test(false, '2026-09-25T08:05:00Z')];
    const v = checkDone({ ...base, request: req(), pr: pr(), tests: greenThenRed });
    expect(reasonsOf(v)).toContain('最后一次跑测试没过');
  });

  it('收下时带上核实用的证据', () => {
    const v = checkDone({ ...base, request: req(), pr: pr({ checks: 'success' }), tests: [test(true)] });
    expect(v).toMatchObject({ ok: true, evidence: { ci: 'success', lastSessionTest: { passed: true } } });
  });
});
