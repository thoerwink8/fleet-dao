import { describe, expect, it } from 'vitest';
import { type CheckRun, evaluateChecks } from '../src/checks.ts';
import { hasCloseKeywords, neutralizeCloseKeywords, PR_BODY_MAX_LINES, renderPrBody } from '../src/text.ts';

describe('C13：GitHub 关单词', () => {
  it('认得出 GitHub 认的所有写法', () => {
    for (const s of [
      'Closes #12',
      'closed: #3',
      'FIX #1',
      'fixes acme/w#9',
      'Resolved GH-4',
      'resolve https://github.com/a/b/issues/7',
    ]) {
      expect(hasCloseKeywords(s), s).toBe(true);
    }
    for (const s of ['属于需求 #12', 'closest #12', 'prefix #12', 'fixture #3', 'fix the bug in #3-ish']) {
      expect(hasCloseKeywords(s), s).toBe(false);
    }
  });

  it('改成「关联」，引用留着', () => {
    expect(neutralizeCloseKeywords('Fixes #12 and closes acme/w#3.')).toBe('关联 #12 and 关联 acme/w#3.');
  });
});

describe('PR 正文模板', () => {
  it('15 行以内：条目多了从最长的一节砍，砍掉的写「另有 N 条」', () => {
    const body = renderPrBody({
      requirement: 12,
      subtask: 'B 验证码',
      did: Array.from({ length: 12 }, (_, i) => `改动 ${i}`),
      verified: ['pnpm check', 'CI 链接'],
      owed: ['过期提示放到子任务 C'],
      risks: ['旧的登录接口还在用'],
    });
    const lines = body.split('\n');
    expect(lines.length).toBeLessThanOrEqual(PR_BODY_MAX_LINES);
    expect(lines[0]).toBe('属于需求 #12 · 子任务：B 验证码');
    expect(body).toContain('- ……另有');
    expect(body).toContain('**还欠什么**\n- 过期提示放到子任务 C');
    expect(body).toContain('**风险**\n- 旧的登录接口还在用');
  });

  it('条目里的关单词也改掉', () => {
    expect(renderPrBody({ did: ['fixes #3'], verified: ['ok'] })).toContain('- 关联 #3');
  });
});

describe('CI 结论', () => {
  const run = (over: Partial<CheckRun>): CheckRun => ({
    id: 1,
    name: 'check',
    head_sha: 'a'.repeat(40),
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-09-25T12:00:00Z',
    completed_at: '2026-09-25T12:01:00Z',
    ...over,
  });

  it('零条必过检查不当绿', () => {
    expect(evaluateChecks([], [], []).overall).toBe('none');
    expect(evaluateChecks(['check'], [], []).overall).toBe('none');
  });

  it('必过的全绿才绿；缺一条就还在等', () => {
    expect(evaluateChecks(['check', 'lint'], [run({})], []).overall).toBe('pending');
    expect(
      evaluateChecks(['check', 'lint'], [run({}), run({ id: 2, name: 'lint', conclusion: 'skipped' })], [])
        .overall,
    ).toBe('green');
  });

  it('同名取最新；超时、取消、要人操作都算红；stale 算还没结论', () => {
    const older = run({ id: 1, conclusion: 'success', started_at: '2026-09-25T12:00:00Z' });
    const newer = run({ id: 2, conclusion: 'timed_out', started_at: '2026-09-25T12:05:00Z' });
    expect(evaluateChecks(['check'], [newer, older], []).overall).toBe('red');
    for (const c of ['cancelled', 'action_required', 'startup_failure']) {
      expect(evaluateChecks(['check'], [run({ conclusion: c })], []).overall).toBe('red');
    }
    expect(evaluateChecks(['check'], [run({ conclusion: 'stale' })], []).overall).toBe('pending');
  });

  it('老式的提交状态也认', () => {
    expect(evaluateChecks(['ci/legacy'], [], [{ context: 'ci/legacy', state: 'success' }]).overall).toBe(
      'green',
    );
    expect(evaluateChecks(['ci/legacy'], [], [{ context: 'ci/legacy', state: 'error' }]).overall).toBe('red');
  });
});
