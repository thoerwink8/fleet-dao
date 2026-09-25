import { readFileSync } from 'node:fs';
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
  /** 栏目标题：行首的「**标题**：」。自己按文字认，不借 renderPrBody 的任何东西。 */
  const columns = (text: string) => [...text.matchAll(/^\*\*([^*\n]+)\*\*：/gm)].map((m) => m[1]);

  it('栏目和仓里的 .github/pull_request_template.md 一样、顺序也一样：引擎开的 PR 和人开的长一个样', () => {
    const template = readFileSync(
      new URL('../../../.github/pull_request_template.md', import.meta.url),
      'utf8',
    );
    const fromTemplate = columns(template);
    expect(fromTemplate).not.toEqual([]); // 模板里一栏都没认出来，下面那条就成了拿空的去比
    expect(fromTemplate).toEqual(expect.arrayContaining(['对应计划', 'specs'])); // CI 的 pr-fields 查的两栏
    const body = renderPrBody({
      requirement: 12,
      subtask: 'B 验证码',
      did: ['加了验证码输入框'],
      verified: ['pnpm check'],
      owed: ['过期提示放到子任务 C'],
      risks: ['旧的登录接口还在用'],
      plan: 'P1「工作流」',
      specs: 'specs/12-登录验证码/',
      changedFiles: ['docs/design.md'],
    });
    expect(columns(body)).toEqual(fromTemplate);
  });

  it('15 行以内：条目多了从最长的一栏砍，砍掉的写「另有 N 条」；风险并进「还欠什么」', () => {
    const body = renderPrBody({
      requirement: 12,
      subtask: 'B 验证码',
      did: Array.from({ length: 12 }, (_, i) => `改动 ${i}`),
      verified: ['pnpm check', 'CI 链接'],
      owed: ['过期提示放到子任务 C'],
      risks: ['旧的登录接口还在用'],
      plan: 'P1「工作流」',
      specs: 'specs/12-登录验证码/',
      changedFiles: ['packages/web/src/login.tsx'],
    });
    const lines = body.split('\n');
    expect(lines.length).toBeLessThanOrEqual(PR_BODY_MAX_LINES);
    expect(body).toContain('- ……另有');
    expect(body).toContain('**还欠什么**：\n- 过期提示放到子任务 C\n- 风险：旧的登录接口还在用');
    expect(lines.slice(-4)).toEqual([
      '**需求**：#12 · 子任务 B 验证码',
      '**对应计划**：P1「工作流」',
      '**specs**：specs/12-登录验证码/',
      '**文档**：不适用',
    ]);
  });

  it('「文档」按改到的文件写：只认仓根 README 和 docs 下的 design、ops、plan，顺序同模板；一份没改写「不适用」', () => {
    const docs = (changedFiles: string[]) =>
      renderPrBody({ did: ['a'], verified: ['b'], plan: 'P1「工作流」', specs: null, changedFiles })
        .split('\n')
        .at(-1);
    expect(docs(['docs/plan.md', 'packages/x.ts', 'README.md'])).toBe('**文档**：README、plan');
    expect(docs(['deploy/README.md', 'docs/reference/deploy.md', 'packages/x.ts'])).toBe('**文档**：不适用');
  });

  it('没有需求号写「无」，还欠的没有写「无」', () => {
    const body = renderPrBody({
      did: ['a'],
      verified: ['b'],
      plan: 'P1「工作流」',
      specs: null,
      changedFiles: [],
    });
    expect(body).toContain('**还欠什么**：无\n**需求**：无\n');
  });

  it('specs 给 null 写「不适用」；对应计划、specs 给空的写「（没写）」（CI 照样判红），不冒充填了', () => {
    const tail = (plan: string, specs: string | null) =>
      renderPrBody({ did: ['a'], verified: ['b'], plan, specs, changedFiles: [] })
        .split('\n')
        .slice(-3, -1);
    expect(tail('P0「仓骨架」', null)).toEqual(['**对应计划**：P0「仓骨架」', '**specs**：不适用']);
    expect(tail(' ', '')).toEqual(['**对应计划**：（没写）', '**specs**：（没写）']);
  });

  it('条目里的关单词也改掉', () => {
    expect(
      renderPrBody({
        did: ['fixes #3'],
        verified: ['ok'],
        plan: 'P1「工作流」',
        specs: null,
        changedFiles: [],
      }),
    ).toContain('- 关联 #3');
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
