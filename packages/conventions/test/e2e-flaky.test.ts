// 驾驶舱 e2e 的偶发统计（决定 0093，src/e2e-flaky.ts）：读 Playwright JSON 报告、数近 10 轮首跑红、拼单子和汇总。
import { describe, expect, test } from 'vitest';
import {
  deadline,
  flakyTests,
  issueBody,
  issueTitle,
  type Outcomes,
  outcomesOf,
  parseQuarantine,
  runSummary,
} from '../src/e2e-flaky.ts';

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
