// 驾驶舱 e2e 的偶发统计（决定 0093，src/e2e-flaky.ts）：读 Playwright JSON 报告、数近 10 轮偶发（重试才过）、拼单子和汇总、开单限流（#2735）。
import { describe, expect, test } from 'vitest';
import {
  BROKEN_ROUND_TITLE,
  brokenRoundBody,
  capCreates,
  deadline,
  FLAKY_SUMMARY_TITLE,
  flakyTests,
  globalErrorCount,
  isBrokenRound,
  issueBody,
  issueTitle,
  MAX_NEW_ISSUES,
  type Outcomes,
  outcomesOf,
  parseQuarantine,
  planIssues,
  runFromArtifacts,
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

describe('flakyTests：近 10 轮偶发（重试才过）≥2 次', () => {
  const runs = (list: Record<string, string[]>[]) =>
    list.map((s, i) => ({ url: `https://ci/run/${i}`, outcomes: outcomes(s) }));

  test('只数偶发（flaky）；达 2 次的列出来、带那几轮的链接；1 次的不算；真红不算', () => {
    const got = flakyTests(
      runs([
        { 甲: ['flaky'], 乙: ['expected'] },
        { 甲: ['expected'], 乙: ['unexpected'] },
        { 甲: ['flaky'], 乙: ['expected'] },
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

  /**
   * 【故意造出的失败】#2735：原来真红（重试也红，failed）也算首跑红，真坏一次（连着两轮主线红）就按用例逐条开单，
   * 10-15 起机器人开了 253 张。真红红在主线 CI 上、由提交的人修，不是偶发。
   */
  test('【故意造出的失败】同一条用例连续两轮真红（failed）：不算偶发、不开偶发单', () => {
    const two = runs([
      { 甲: ['unexpected'], 乙: ['expected'], 丙: ['expected'] },
      { 甲: ['unexpected'], 乙: ['expected'], 丙: ['expected'] },
    ]);
    expect(flakyTests(two)).toEqual([]);
    expect(planIssues(two, [], [], '2026-10-22')).toEqual([]);
    // 一轮真红、一轮偶发：只有 1 次偶发，也不到阈值
    const mixed = runs([
      { 甲: ['unexpected'], 乙: ['expected'], 丙: ['expected'] },
      { 甲: ['flaky'], 乙: ['expected'], 丙: ['expected'] },
    ]);
    expect(flakyTests(mixed)).toEqual([]);
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

  test('最新一轮好、窗口里更早有整轮坏的轮：不开「整轮坏了」单', () => {
    const runs = [round(0, 'expected'), round(1, 'unexpected'), round(2, 'unexpected'), round(3, 'expected')];
    expect(planIssues(runs, [], noQuarantine, '2026-10-22')).toEqual([]);
  });

  test('最新两轮坏、更早的好：开单，正文只列这两轮；中间隔着好轮的更早坏轮不列', () => {
    const runs = [
      round(0, 'unexpected'),
      round(1, 'unexpected'),
      round(2, 'expected'),
      round(3, 'unexpected'),
    ];
    const [a] = planIssues(runs, [], noQuarantine, '2026-10-22');
    expect(a).toMatchObject({ kind: 'create', title: BROKEN_ROUND_TITLE });
    const body = a?.kind === 'create' ? a.body : '';
    expect(body).toContain('最近连着 2 轮主线 e2e 整轮坏了');
    expect(body).toContain('- https://ci/run/0\n- https://ci/run/1');
    expect(body).not.toContain('https://ci/run/3');
  });

  test('有开着的「整轮坏了」单、最新一轮好：留言关单；没有任何一轮时不动', () => {
    const open = [{ number: 7, title: BROKEN_ROUND_TITLE, body: '- https://ci/run/1' }];
    const runs = [round(0, 'expected'), round(1, 'unexpected')];
    const actions = planIssues(runs, open, noQuarantine, '2026-10-22');
    expect(actions).toEqual([
      {
        kind: 'close',
        number: 7,
        body: '最新一轮 https://ci/run/0 已正常，关单；再坏会重开',
        label: expect.stringContaining('#7'),
      },
    ]);
    expect(planIssues([], open, noQuarantine, '2026-10-22')).toEqual([]);
  });

  test('某条用例在两轮里各单独偶发一次、其余全绿：照旧开它的单', () => {
    const runs = [
      round(0, 'expected', { 甲: 'flaky' }),
      round(1, 'expected', { 甲: 'flaky' }),
      round(2, 'expected'),
    ];
    const actions = planIssues(runs, [], noQuarantine, '2026-10-22');
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: 'create', title: 'e2e 偶发：07c-nodes.e2e.ts › 甲' });
  });

  test('开的单（整轮坏了、偶发）都贴「缺陷」类别和 engine/bug 两轴', () => {
    const broken = [round(0, 'unexpected'), round(1, 'expected', {}, true)];
    const flaky = [round(0, 'expected', { 甲: 'flaky' }), round(1, 'expected', { 甲: 'flaky' })];
    for (const runs of [broken, flaky]) {
      const [a] = planIssues(runs, [], noQuarantine, '2026-10-22');
      expect(a).toMatchObject({ kind: 'create', labels: ['缺陷', '域:engine', '性质:bug'] });
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
    const runs = [round(0, 'expected', { 甲: 'flaky' }), round(1, 'expected', { 甲: 'flaky' })];
    const open = [{ number: 3, title: 'e2e 偶发：07c-nodes.e2e.ts › 甲', body: '' }];
    expect(planIssues(runs, open, noQuarantine, '2026-10-22').map((a) => a.kind)).toEqual(['exists']);
  });
});

describe('开单限流（#2735）：超过 5 条只开一张汇总单，一次扫描最多新开 3 张', () => {
  // 用例多到「6 条偶发不过半」：20 条用例，偶发的那几条之外全绿，不算整轮坏
  const many = Array.from({ length: 20 }, (_, i) => `例${String(i).padStart(2, '0')}`);
  const round = (i: number, flaky: readonly string[]) => ({
    url: `https://ci/run/${i}`,
    outcomes: outcomes(Object.fromEntries(many.map((n) => [n, [flaky.includes(n) ? 'flaky' : 'expected']]))),
  });
  const twice = (flaky: readonly string[]) => [round(0, flaky), round(1, flaky)];

  test('【故意造出的失败】一轮里 6 条用例达阈值：只开一张汇总单，正文列出这 6 条，不逐条开', () => {
    const six = many.slice(0, 6);
    const runs = twice(six);
    expect(runs.some(isBrokenRound)).toBe(false);
    expect(flakyTests(runs)).toHaveLength(6);
    const actions = planIssues(runs, [], [], '2026-10-22');
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: 'create',
      title: FLAKY_SUMMARY_TITLE,
      labels: ['缺陷', '域:engine', '性质:bug'],
    });
    const body = actions[0]?.kind === 'create' ? actions[0].body : '';
    for (const n of six) expect(body).toContain(`07c-nodes.e2e.ts › ${n}`);
    expect(checkIssueBody(body)).toMatchObject({ ok: true });
  });

  test('刚好 5 条：照旧逐条开，但一次最多新开 3 张，另 2 张这次不开（deferred）', () => {
    const actions = planIssues(twice(many.slice(0, 5)), [], [], '2026-10-22');
    expect(actions.map((a) => a.kind)).toEqual(['create', 'create', 'create', 'deferred', 'deferred']);
    expect(actions.filter((a) => a.kind === 'create').length).toBeLessThanOrEqual(MAX_NEW_ISSUES);
    expect(MAX_NEW_ISSUES).toBe(3);
  });

  test('已有开着的汇总单：只补没写过的用例，都写过了就不动；一张也不新开', () => {
    const six = many.slice(0, 6);
    const open = [
      {
        number: 9,
        title: FLAKY_SUMMARY_TITLE,
        body: six
          .slice(0, 5)
          .map((n) => `07c-nodes.e2e.ts › ${n}`)
          .join('\n'),
      },
    ];
    const actions = planIssues(twice(six), open, [], '2026-10-22');
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: 'comment', number: 9 });
    expect(actions[0]?.kind === 'comment' && actions[0].body).toContain(`07c-nodes.e2e.ts › ${six[5]}`);
    const all = [
      { number: 9, title: FLAKY_SUMMARY_TITLE, body: six.map((n) => `07c-nodes.e2e.ts › ${n}`).join('\n') },
    ];
    expect(planIssues(twice(six), all, [], '2026-10-22').map((a) => a.kind)).toEqual(['exists']);
  });

  test('capCreates：留言、关单、已有不受限，只数新开的；超出的写明下次再开', () => {
    const create = (t: string) => ({ kind: 'create' as const, title: t, body: '', labels: [], label: t });
    const got = capCreates(
      [
        create('a'),
        { kind: 'comment', number: 1, body: '', label: 'c' },
        create('b'),
        { kind: 'close', number: 2, body: '', label: 'x' },
        create('c'),
        create('d'),
        { kind: 'exists', label: 'e' },
      ],
      3,
    );
    expect(got.map((a) => a.kind)).toEqual([
      'create',
      'comment',
      'create',
      'close',
      'create',
      'deferred',
      'exists',
    ]);
    expect(got[5]).toMatchObject({ kind: 'deferred', title: 'd' });
    expect(got[5]?.label).toContain('下次');
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
    expect(body).toContain('偶发（首跑红、重试才过）3 次（跑了 10 次）');
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

describe('同一轮重跑（artifact 名带 run_attempt）：每一片取最后一次', () => {
  test('第一次偶发或真红、第二次才过：只算第二次，不把这一轮算成两次；没重跑的那一片仍算上', () => {
    const run = runFromArtifacts('https://ci/9', [
      {
        name: 'e2e-9-1-1/results.json',
        report: report([{ file: 'a.e2e.ts', title: '甲', statuses: ['flaky'] }]),
      },
      {
        name: 'e2e-9-1-2/results.json',
        report: report([{ file: 'b.e2e.ts', title: '乙', statuses: ['unexpected'] }]),
      },
      {
        name: 'e2e-9-2-1/results.json',
        report: report([{ file: 'a.e2e.ts', title: '甲', statuses: ['expected'] }]),
      },
      {
        name: 'e2e-9-2-2/results.json',
        report: report([{ file: 'b.e2e.ts', title: '乙', statuses: ['flaky'] }]),
      },
    ]);
    expect(run.outcomes.get('a.e2e.ts › 甲')?.outcome).toBe('passed');
    expect(run.outcomes.get('b.e2e.ts › 乙')?.outcome).toBe('flaky');
    // 阈值降到 1：乙只记 1 轮。若把第一次运行也算成一轮，乙会是 2。
    expect(flakyTests([run], 1)).toEqual([
      { key: { file: 'b.e2e.ts', title: '乙' }, bad: 1, ran: 1, urls: ['https://ci/9'] },
    ]);
    // 只重跑了失败的第 1 片：第 2 片没有第二次，仍用第一次，不漏
    const partial = runFromArtifacts('https://ci/8', [
      {
        name: 'e2e-8-1-1/results.json',
        report: report([{ file: 'a.e2e.ts', title: '甲', statuses: ['flaky'] }]),
      },
      {
        name: 'e2e-8-1-2/results.json',
        report: report([{ file: 'b.e2e.ts', title: '乙', statuses: ['expected'] }]),
      },
      {
        name: 'e2e-8-2-1/results.json',
        report: report([{ file: 'a.e2e.ts', title: '甲', statuses: ['expected'] }]),
      },
    ]);
    expect(partial.outcomes.get('a.e2e.ts › 甲')?.outcome).toBe('passed');
    expect(partial.outcomes.get('b.e2e.ts › 乙')?.outcome).toBe('passed');
    expect(flakyTests([partial], 1)).toEqual([]);
  });

  test('重跑前的全局错不算；最后一次没有全局错，这一轮不是整轮坏了', () => {
    const bad = report([{ file: 'a.e2e.ts', title: '甲', statuses: ['unexpected'] }]) as {
      errors?: unknown[];
    };
    bad.errors = [{}];
    const run = runFromArtifacts('https://ci/4', [
      { name: 'e2e-4-1-1/results.json', report: bad },
      {
        name: 'e2e-4-2-1/results.json',
        report: report([{ file: 'a.e2e.ts', title: '甲', statuses: ['expected'] }]),
      },
    ]);
    expect(run.globalError).toBeUndefined();
    expect(isBrokenRound(run)).toBe(false);
    expect(run.outcomes.get('a.e2e.ts › 甲')?.outcome).toBe('passed');
  });

  test('名字里没有第几次运行：平铺的分片都留下，不漏', () => {
    const run = runFromArtifacts('https://ci/3', [
      { name: 'results-1.json', report: report([{ file: 'a.e2e.ts', title: '甲', statuses: ['expected'] }]) },
      { name: 'results-2.json', report: report([{ file: 'b.e2e.ts', title: '乙', statuses: ['flaky'] }]) },
    ]);
    expect([...run.outcomes.keys()].sort()).toEqual(['a.e2e.ts › 甲', 'b.e2e.ts › 乙']);
  });
});
