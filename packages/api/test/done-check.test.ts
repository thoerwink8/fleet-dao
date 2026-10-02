import { describe, expect, it } from 'vitest';
import { checkDone, testRunOf } from '../src/done-check.ts';
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
  command: 'pnpm test:changed',
});
const base = { stage: 'execute' as const, branch: 'fleet/12-a', testCommand: 'pnpm test:changed' };
const req = (over: Partial<{ summary: string; prNumber: number; testsPassed: boolean }> = {}) => ({
  summary: '做完了',
  testsPassed: true,
  ...over,
});

function reasonsOf(v: ReturnType<typeof checkDone>): string {
  return v.ok ? '' : v.reasons.join('\n');
}

describe('checkDone · 554-2 起的主判：带 PR 就看它的 CI', () => {
  it('带 PR + CI 全绿：收了（即便 tests 全空、会话里没跑过仓的测试命令）', () => {
    const v = checkDone({
      ...base,
      request: req({ prNumber: 31 }),
      pr: pr({ checks: 'success' }),
      tests: [],
    });
    expect(v).toEqual({ ok: true, evidence: { pr: { number: 31, state: 'open', headRef: 'fleet/12-a' } } });
  });

  it('带 PR + CI 红的：422，写明是这张 PR 的必过检查没过，不拿「会话里测试过了」顶', () => {
    const v = checkDone({
      ...base,
      request: req({ prNumber: 31 }),
      pr: pr({ checks: 'failure' }),
      tests: [test(true)],
    });
    expect(v).toMatchObject({ ok: false, status: 422, code: 'done_rejected' });
    expect(reasonsOf(v)).toContain('PR #31 的 CI 是红的');
  });

  it('带 PR + CI 还在跑（pending）：409 等它跑完再交', () => {
    const v = checkDone({
      ...base,
      request: req({ prNumber: 31 }),
      pr: pr({ checks: 'pending' }),
      tests: [test(true)],
    });
    expect(v).toMatchObject({ ok: false, status: 409, code: 'not_verifiable_yet' });
    expect(reasonsOf(v)).toContain('CI 还在跑');
  });

  it('带 PR + CI 还没起（none）：409 等它起出来再交', () => {
    const v = checkDone({
      ...base,
      request: req({ prNumber: 31 }),
      pr: pr({ checks: 'none' }),
      tests: [test(true)],
    });
    expect(v).toMatchObject({ ok: false, status: 409, code: 'not_verifiable_yet' });
    expect(reasonsOf(v)).toContain('还没起');
  });

  it('【故意造红】带 PR 编号但库里还没有：409，不当成收到，不能当成「绿」', () => {
    const v = checkDone({ ...base, request: req({ prNumber: 31 }), pr: null, tests: [test(true)] });
    expect(v).toMatchObject({ ok: false, status: 409, code: 'not_verifiable_yet' });
    expect(reasonsOf(v)).toContain('还没同步进库');
    // 哪怕 testsPassed 报了 true 也不行（测试不再认会话自报）
    expect(v.ok).toBe(false);
  });

  it('自己报 testsFailed：即使 CI 是绿的，也当场退回', () => {
    const v = checkDone({
      ...base,
      request: req({ prNumber: 31, testsPassed: false }),
      pr: pr({ checks: 'success' }),
      tests: [],
    });
    expect(v.ok).toBe(false);
    expect(reasonsOf(v)).toContain('测试没过');
  });

  it('带 PR 时仍然核「这张 PR 是不是本会话的分支、是不是已经关了」', () => {
    expect(
      reasonsOf(
        checkDone({
          ...base,
          request: req({ prNumber: 31 }),
          pr: pr({ checks: 'success', headRef: 'x' }),
          tests: [],
        }),
      ),
    ).toContain('不是本会话的分支');
    expect(
      reasonsOf(
        checkDone({
          ...base,
          request: req({ prNumber: 31 }),
          pr: pr({ checks: 'success', state: 'closed' }),
          tests: [],
        }),
      ),
    ).toContain('已经关了');
  });

  it('写需求文档、调研这类活不要求 CI 过：带 PR 也只是顺带核分支和是否已关', () => {
    const v = checkDone({
      stage: 'spec',
      branch: 'fleet/12-a',
      request: req({ prNumber: 31 }),
      pr: pr({ checks: 'pending' }),
      tests: [],
    });
    // 没挂 stage 到 CODE_STAGES：不看 CI，PR 状态也只看分支和是否已关
    expect(v).toEqual({ ok: true, evidence: { pr: { number: 31, state: 'open', headRef: 'fleet/12-a' } } });
  });
});

describe('checkDone · fallback 旧路径：不带 PR 的写码会话仍走会话测试证据', () => {
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
    const redThenGreen = [test(false, '2026-09-25T08:00:00Z'), test(true, '2026-09-25T08:05:00Z')];
    expect(checkDone({ ...base, request: req(), pr: null, tests: redThenGreen }).ok).toBe(true);
    const greenThenRed = [test(true, '2026-09-25T08:05:00Z'), test(false, '2026-09-25T08:09:00Z')];
    expect(reasonsOf(checkDone({ ...base, request: req(), pr: null, tests: greenThenRed }))).toContain(
      '最后一次跑测试没过（pnpm test:changed，2026-09-25T08:09:00Z）',
    );
  });

  it('没跑过仓的测试命令（跑的是 pnpm check、vitest 单跑几个包，插头都不记）：退回，写明要原样跑哪一条', () => {
    const v = checkDone({ ...base, request: req(), pr: null, tests: [] });
    expect(v).toMatchObject({ ok: false, status: 422, code: 'done_rejected' });
    expect(reasonsOf(v)).toBe(
      '没查到本次会话跑过 `pnpm test:changed` 的记录：先原样跑它再交（别的测试命令不算）',
    );
  });

  it('最后一次结果认不出（接了管道、放了后台）：退回，写明原因；前面一次「通过」顶不上', () => {
    const unknown: TestRunRecord = {
      at: '2026-09-25T08:09:00Z',
      passed: null,
      command: 'pnpm test:changed | tail',
      unknownBecause: '带管道又没开 pipefail，退出码是管道最后一段的',
    };
    const v = checkDone({
      ...base,
      request: req(),
      pr: null,
      tests: [test(true, '2026-09-25T08:05:00Z'), unknown],
    });
    expect(v).toMatchObject({ ok: false, status: 422 });
    expect(reasonsOf(v)).toContain('结果认不出：带管道又没开 pipefail');
    expect(reasonsOf(v)).toContain('原样跑 `pnpm test:changed`（别接管道、别放后台）再交');
    // 认不出之后又原样跑过一次、过了：收下
    const again = [test(true, '2026-09-25T08:05:00Z'), unknown, test(true, '2026-09-25T08:12:00Z')];
    expect(checkDone({ ...base, request: req(), pr: null, tests: again }).ok).toBe(true);
  });

  it('测试记录的载荷：插头写的两种形状都认；坏了的算认不出，不丢', () => {
    expect(testRunOf('t', { command: 'pnpm test:changed', passed: true })).toEqual({
      at: 't',
      passed: true,
      command: 'pnpm test:changed',
    });
    expect(testRunOf('t', { command: 'x | tail', unknownBecause: '带管道' })).toEqual({
      at: 't',
      passed: null,
      command: 'x | tail',
      unknownBecause: '带管道',
    });
    for (const bad of [null, 'x', { passed: 'yes' }, { unknownBecause: '  ' }]) {
      expect(testRunOf('t', bad)).toMatchObject({ passed: null, unknownBecause: '记录里没有结果' });
    }
  });

  it('【失败】写码会话开工时没记下测试命令（加这一列之前开的会话）：退回，不拿仓此刻的命令顶；测试是绿的也不收', () => {
    const { testCommand: _none, ...noCommand } = base;
    const v = checkDone({ ...noCommand, request: req(), pr: null, tests: [test(true)] });
    expect(v).toMatchObject({ ok: false, status: 422, code: 'done_rejected' });
    expect(reasonsOf(v)).toBe(
      '这次会话开工时没记下要跑的测试命令（加这一列之前开的会话），核对不了测试：别再交，用 fleet blocked 说明，由引擎重开一轮',
    );
    // 不写码的阶段没有测试命令照常收
    expect(checkDone({ ...noCommand, stage: 'spec', request: req(), pr: null, tests: [] }).ok).toBe(true);
  });

  it('写需求文档、调研这类活不要求测试证据', () => {
    expect(
      checkDone({
        stage: 'spec',
        branch: 'b',
        testCommand: 'pnpm test:changed',
        request: req(),
        pr: null,
        tests: [],
      }).ok,
    ).toBe(true);
  });

  it('能判定的问题一次全列出来，不让 AI 一轮轮试', () => {
    const v = checkDone({
      ...base,
      request: req({ testsPassed: false }),
      pr: null,
      tests: [],
    });
    expect(v.ok ? [] : v.reasons).toHaveLength(2);
  });
});
