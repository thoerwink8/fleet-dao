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
  testsPassed: true,
  ...over,
});

function reasonsOf(v: ReturnType<typeof checkDone>): string {
  return v.ok ? '' : v.reasons.join('\n');
}

describe('checkDone', () => {
  it('会话只在本地提交、PR 由引擎在会话后开：写码的活不带 PR，测试证据是绿的就收下', () => {
    const v = checkDone({ ...base, request: req(), pr: null, tests: [test(true)] });
    expect(v).toEqual({ ok: true, evidence: { lastSessionTest: test(true), pr: undefined } });
  });

  it('自己报测试没过：直接退回', () => {
    const v = checkDone({ ...base, request: req({ testsPassed: false }), pr: null, tests: [test(true)] });
    expect(v).toMatchObject({ ok: false, status: 422, code: 'done_rejected' });
    expect(reasonsOf(v)).toContain('测试没过');
  });

  it('写码的活要有会话里跑测试的证据，而且以最后一次为准', () => {
    expect(reasonsOf(checkDone({ ...base, request: req(), pr: null, tests: [] }))).toContain(
      '没查到本次会话跑过测试',
    );
    const redThenGreen = [test(false, '2026-09-25T08:00:00Z'), test(true, '2026-09-25T08:05:00Z')];
    expect(checkDone({ ...base, request: req(), pr: null, tests: redThenGreen }).ok).toBe(true);
    const greenThenRed = [test(true, '2026-09-25T08:05:00Z'), test(false, '2026-09-25T08:09:00Z')];
    expect(reasonsOf(checkDone({ ...base, request: req(), pr: null, tests: greenThenRed }))).toContain(
      '最后一次跑测试没过',
    );
  });

  it('写需求文档、调研这类活不要求测试证据', () => {
    expect(checkDone({ stage: 'spec', branch: 'b', request: req(), pr: null, tests: [] }).ok).toBe(true);
  });

  it('带了 PR 编号：库里还没有就 409（过会儿再交），不是本会话的分支或已关掉就退回', () => {
    expect(
      checkDone({ ...base, request: req({ prNumber: 31 }), pr: null, tests: [test(true)] }),
    ).toMatchObject({ ok: false, status: 409, code: 'not_verifiable_yet' });
    expect(
      reasonsOf(
        checkDone({ ...base, request: req({ prNumber: 31 }), pr: pr({ headRef: 'x' }), tests: [test(true)] }),
      ),
    ).toContain('不是本会话的分支');
    expect(
      reasonsOf(
        checkDone({
          ...base,
          request: req({ prNumber: 31 }),
          pr: pr({ state: 'closed' }),
          tests: [test(true)],
        }),
      ),
    ).toContain('已经关了');
  });

  it('PR 上的 CI 是上一次推送的结果，不拿来判这次会话：CI 红但会话测试绿照样收下', () => {
    const v = checkDone({
      ...base,
      request: req({ prNumber: 31 }),
      pr: pr({ checks: 'failure' }),
      tests: [test(true)],
    });
    expect(v).toMatchObject({ ok: true, evidence: { pr: { number: 31, state: 'open' } } });
  });

  it('能判定的问题一次全列出来，不让 AI 一轮轮试', () => {
    const v = checkDone({
      ...base,
      request: req({ testsPassed: false, prNumber: 31 }),
      pr: pr({ headRef: 'x', state: 'closed' }),
      tests: [],
    });
    expect(v.ok ? [] : v.reasons).toHaveLength(4);
  });
});
