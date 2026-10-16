// 驾驶舱 e2e 的偶发统计（决定 0093，src/e2e-flaky.ts）：读 Playwright JSON 报告、数近 10 轮首跑红、拼单子和汇总。
import { describe, expect, test } from 'vitest';
import {
  BROKEN_ROUND_TITLE,
  brokenRoundBody,
  deadline,
  flakyTests,
  globalErrorCount,
  isBrokenRound,
  issueBody,
  issueTitle,
  type Outcomes,
  outcomesOf,
  parseQuarantine,
  planIssues,
  runSummary,
} from '../src/e2e-flaky.ts';
import { checkIssueBody } from '../src/issue-new.ts';

/** 造一份 Playwright JSON 报告：文件 → describe → 用例，每条用例两个视口的结局。 */
function report(specs: { file: string; title: string; statuses: string[] }[]) {
  return {
    config: {},
    suites: specs.map((s) => ({
      title: s.file,
      file: s.file,
      specs: [],
      suites: [
        {
          title: '某页',
          file: s.file,
          specs: [
            {
              title: s.title,
              file: s.file,
              tests: s.statuses.map((status, i) => ({
                projectName: i ? 'desktop-1920' : 'laptop-1366',
                status,
              })),
            },
          ],
        },
      ],
    })),
  };
}

const outcomes = (statuses: Record<string, string[]>): Outcomes =>
  outcomesOf(
    report(Object.entries(statuses).map(([title, s]) => ({ file: '07c-nodes.e2e.ts', title, statuses: s }))),
  );

describe('outcomesOf：读报告', () => {
  test('两个视口取最坏的：有红就红、否则有偶发就偶发；跳过的只在都跳过时算跳过', () => {
    const got = outcomes({
      甲: ['expected', 'flaky'],
      乙: ['flaky', 'unexpected'],
      丙: ['skipped', 'expected'],
      丁: ['skipped', 'skipped'],
    });
    expect(Object.fromEntries([...got].map(([k, v]) => [k, v.outcome]))).toEqual({
      '07c-nodes.e2e.ts › 甲': 'flaky',
      '07c-nodes.e2e.ts › 乙': 'failed',
      '07c-nodes.e2e.ts › 丙': 'passed',
      '07c-nodes.e2e.ts › 丁': 'skipped',
    });
  });

  test('【故意造出的失败】不是报告、用例缺字段、结局认不出：抛，不当成全过', () => {
    expect(() => outcomesOf({})).toThrow('没有 suites');
    expect(() => outcomesOf({ suites: [{ specs: [{ title: 'x' }] }] })).toThrow('缺标题、文件或结果');
    expect(() => outcomes({ 甲: ['timedOut'] })).toThrow('认不出');
  });

  test('Windows 上的路径分隔符统一成 /', () => {
    const got = outcomesOf(report([{ file: 'sub\\a.e2e.ts', title: 't', statuses: ['expected'] }]));
    expect([...got.keys()]).toEqual(['sub/a.e2e.ts › t']);
  });
});

describe('flakyTests：近 10 轮首跑红 ≥2 次', () => {
  const runs = (list: Record<string, string[]>[]) =>
    list.map((s, i) => ({ url: `https://ci/run/${i}`, outcomes: outcomes(s) }));

  test('偶发和真红都算首跑红；达 2 次的列出来、带那几轮的链接；1 次的不算', () => {
    const got = flakyTests(
      runs([
        { 甲: ['flaky'], 乙: ['expected'] },
        { 甲: ['expected'], 乙: ['unexpected'] },
        { 甲: ['unexpected'], 乙: ['expected'] },
      ]),
    );
    expect(got).toEqual([
      {
        key: { file: '07c-nodes.e2e.ts', title: '甲' },
        bad: 2,
        ran: 3,
        urls: ['https://ci/run/0', 'https://ci/run/2'],
      },
    ]);
  });

  test('跳过的不算跑过；一条都没有时回空', () => {
    expect(flakyTests(runs([{ 甲: ['skipped'] }, { 甲: ['skipped'] }]))).toEqual([]);
    expect(flakyTests([])).toEqual([]);
  });
});

describe('先判整轮（#2499）：整轮坏了不算每条用例偶发', () => {
  const names = ['甲', '乙', '丙', '丁', '戊', '己'];
  /** 一轮：names 里每条用例都是 status，extra 里的覆盖。 */
  const round = (i: number, status: string, extra: Record<string, string> = {}, globalError = false) => ({
    url: `https://ci/run/${i}`,
    outcomes: outcomes(Object.fromEntries(names.map((n) => [n, [extra[n] ?? status]]))),
    globalError,
  });
  const noQuarantine: never[] = [];

  test('两轮整轮全红 + 八轮全绿：不算任何用例偶发，只开一张「整轮坏了」，不开偶发单', () => {
    const runs = [
      round(0, 'unexpected'),
      round(1, 'unexpected'),
      ...[2, 3, 4, 5, 6, 7, 8, 9].map((i) => round(i, 'expected')),
    ];
    expect(flakyTests(runs)).toEqual([]);
    const actions = planIssues(runs, [], noQuarantine, '2026-10-22');
    expect(actions).toHaveLength(1);
    const a = actions[0];
    expect(a).toMatchObject({ kind: 'create', title: BROKEN_ROUND_TITLE });
    expect(BROKEN_ROUND_TITLE.startsWith('e2e 偶发')).toBe(false);
    expect(a?.kind === 'create' && a.body).toContain('- https://ci/run/0\n- https://ci/run/1');
  });

  test('某条用例在两轮里各单独红一次、其余全绿：照旧开它的单', () => {
    const runs = [
      round(0, 'expected', { 甲: 'unexpected' }),
      round(1, 'expected', { 甲: 'flaky' }),
      round(2, 'expected'),
    ];
    const actions = planIssues(runs, [], noQuarantine, '2026-10-22');
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: 'create', title: 'e2e 偶发：07c-nodes.e2e.ts › 甲' });
  });

  test('开的单（整轮坏了、偶发）都贴「缺陷」类别', () => {
    const broken = [round(0, 'unexpected'), round(1, 'expected', {}, true)];
    const flaky = [round(0, 'expected', { 甲: 'unexpected' }), round(1, 'expected', { 甲: 'flaky' })];
    for (const runs of [broken, flaky]) {
      const [a] = planIssues(runs, [], noQuarantine, '2026-10-22');
      expect(a).toMatchObject({ kind: 'create', labels: ['缺陷'] });
    }
  });

  test('首跑红刚好一半不算整轮坏，超过一半才算；跳过的不进分母', () => {
    expect(isBrokenRound(round(0, 'expected', { 甲: 'unexpected', 乙: 'unexpected', 丙: 'flaky' }))).toBe(
      false,
    );
    expect(
      isBrokenRound(round(0, 'expected', { 甲: 'unexpected', 乙: 'unexpected', 丙: 'flaky', 丁: 'flaky' })),
    ).toBe(true);
    expect(isBrokenRound(round(0, 'skipped', { 甲: 'unexpected' }))).toBe(true);
  });

  test('报告里有全局准备/备库的错：只红少数用例也算整轮坏了，且不计入偶发', () => {
    const runs = [
      round(0, 'expected', { 甲: 'unexpected' }, true),
      round(1, 'expected', { 甲: 'unexpected' }),
    ];
    expect(runs.map(isBrokenRound)).toEqual([true, false]);
    expect(flakyTests(runs)).toEqual([]);
  });

  test('globalErrorCount：读报告顶层 errors，认不出就抛', () => {
    expect(globalErrorCount({ suites: [] })).toBe(0);
    expect(globalErrorCount({ suites: [], errors: [{ message: '备库失败' }] })).toBe(1);
    expect(() => globalErrorCount({ errors: 'x' })).toThrow('不是数组');
  });

  test('已有开着的「整轮坏了」单：只补没写过的轮链接，都写过了就不动；永远只一张', () => {
    const runs = [round(0, 'unexpected'), round(1, 'unexpected')];
    const open = [{ number: 7, title: BROKEN_ROUND_TITLE, body: '- https://ci/run/1' }];
    const actions = planIssues(runs, open, noQuarantine, '2026-10-22');
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: 'comment', number: 7 });
    expect(actions[0]?.kind === 'comment' && actions[0].body).toBe('又有整轮坏了的轮：\n- https://ci/run/0');
    const done = [{ number: 7, title: BROKEN_ROUND_TITLE, body: 'https://ci/run/0 https://ci/run/1' }];
    expect(planIssues(runs, done, noQuarantine, '2026-10-22').map((a) => a.kind)).toEqual(['exists']);
  });

  test('同一用例已有开着的偶发单就不重开', () => {
    const runs = [round(0, 'expected', { 甲: 'unexpected' }), round(1, 'expected', { 甲: 'unexpected' })];
    const open = [{ number: 3, title: 'e2e 偶发：07c-nodes.e2e.ts › 甲', body: '' }];
    expect(planIssues(runs, open, noQuarantine, '2026-10-22').map((a) => a.kind)).toEqual(['exists']);
  });
});

describe('隔离集文件', () => {
  test('格式对才收', () => {
    const ok = { file: 'a.e2e.ts', title: 't', issue: 12, until: '2026-10-21' };
    expect(parseQuarantine(JSON.stringify({ tests: [ok] }))).toEqual([ok]);
    expect(parseQuarantine('{"tests":[]}')).toEqual([]);
  });

  test('【故意造出的失败】缺单号、限期写错、不是 e2e 文件、整个不是对象：抛', () => {
    expect(() => parseQuarantine('[]')).toThrow('{ "tests": [...] }');
    expect(() =>
      parseQuarantine(JSON.stringify({ tests: [{ file: 'a.e2e.ts', title: 't', until: '2026-10-21' }] })),
    ).toThrow('第 1 条');
    expect(() =>
      parseQuarantine(
        JSON.stringify({ tests: [{ file: 'a.e2e.ts', title: 't', issue: 1, until: '10/21' }] }),
      ),
    ).toThrow('第 1 条');
    expect(() =>
      parseQuarantine(
        JSON.stringify({ tests: [{ file: 'a.test.ts', title: 't', issue: 1, until: '2026-10-21' }] }),
      ),
    ).toThrow('第 1 条');
  });
});

describe('单子和汇总', () => {
  const finding = {
    key: { file: '07c-nodes.e2e.ts', title: '失联' },
    bad: 3,
    ran: 10,
    urls: ['https://ci/run/9', 'https://ci/run/4'],
  };

  test('标题固定（认单靠它）；正文写次数、限期、失败链接，没在隔离集里的给出要加的那一条', () => {
    expect(issueTitle(finding.key)).toBe('e2e 偶发：07c-nodes.e2e.ts › 失联');
    const body = issueBody(finding, '2026-10-21', false);
    expect(body).toContain('首跑红了 3 次（跑了 10 次）');
    expect(body).toContain('限期 2026-10-21');
    expect(body).toContain('- https://ci/run/9\n- https://ci/run/4');
    expect(body).toContain('"file":"07c-nodes.e2e.ts","title":"失联"');
    expect(issueBody(finding, '2026-10-21', true)).toContain('已经在隔离集');
  });

  test('自动开的两种单都过开单检查（四节齐，引擎能拉、对账不报缺）', () => {
    for (const body of [
      issueBody(finding, '2026-10-21', false),
      issueBody(finding, '2026-10-21', true),
      brokenRoundBody(['https://ci/run/1']),
    ]) {
      expect(checkIssueBody(body)).toMatchObject({ ok: true });
    }
  });

  test('限期：今天起 7 天', () => {
    expect(deadline(new Date('2026-10-14T23:30:00Z'))).toBe('2026-10-21');
  });

  test('汇总：列偶发的、隔离集里每条的结局，过了限期的点出来', () => {
    const got = outcomes({ 甲: ['flaky'], 乙: ['unexpected'], 丙: ['expected'] });
    const text = runSummary(
      got,
      [
        { file: '07c-nodes.e2e.ts', title: '乙', issue: 5, until: '2026-10-10' },
        { file: '07c-nodes.e2e.ts', title: '戊', issue: 6, until: '2026-10-30' },
      ],
      '2026-10-14',
    );
    expect(text).toContain('首跑红、重试过了（flaky）1 条：\n- 07c-nodes.e2e.ts › 甲');
    expect(text).toContain('- 07c-nodes.e2e.ts › 乙：failed（#5，限期 2026-10-10，**过了限期**）');
    expect(text).toContain('- 07c-nodes.e2e.ts › 戊：这一轮没跑（#6，限期 2026-10-30）');
    expect(runSummary(outcomes({ 丙: ['expected'] }), [], '2026-10-14')).toContain('没有偶发');
  });
});
