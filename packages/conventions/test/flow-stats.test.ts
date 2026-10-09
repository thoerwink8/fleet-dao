// 量流程快慢（src/flow-stats.ts）：假的 GitHub 回包要和手算对得上；读不到、字段缺、列表为空抛「没查成」，不算成 0。
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type FlowStats, flowStats, formatFlowStats, parseDays } from '../src/flow-stats.ts';
import { runChild } from './child.ts';

const NOW = new Date('2026-10-08T15:00:00.000Z');
const DAYS = 5;
// 窗口起点 = now − 5 天 = 2026-10-03T15:00:00Z。UTC 日：10-03 … 10-08。

const OPTS = { repo: 'thoerwink8/fleet-dao', now: NOW, days: DAYS, pageSize: 50 };

interface Pull {
  number: number;
  created_at: string;
  merged_at: string | null;
  updated_at: string;
  head: { ref: string };
}

function pull(over: Partial<Pull> & Pick<Pull, 'number' | 'created_at' | 'merged_at' | 'head'>): Pull {
  return { updated_at: '2026-10-08T12:00:00Z', ...over };
}

interface Run {
  id: number;
  created_at: string;
  status: string;
  conclusion: string | null;
  run_attempt: number;
}

function run(over: Partial<Run> & Pick<Run, 'id' | 'created_at' | 'conclusion' | 'run_attempt'>): Run {
  return { status: 'completed', ...over };
}

// 手算（分钟 = merged_at − created_at；引擎分支只认 fleet/<单号>-t<8 位十六进制>）：
// 引擎 3 个：30、90、180。升序后中位取中间 = 90；90 分位最近秩 ceil(0.9×3)−1 = 2 → 180。
// 其他 5 个：10、20、40、60、80。中位取中间 = 40；ceil(0.9×5)−1 = 4 → 80。
// #5 的分支只有 7 位十六进制，不是引擎 PR。#7 的 +08:00 按时刻折成 UTC 日。
// #8 早于窗口 1 秒、#9 没合并：都不算。算进去的话 10-03 会变成 2，或其他档的 90 分位不再是 80。
// 每天（UTC）：10-03 边界上 1 个、10-04 和 10-05 是 0、10-06 两个、10-07 三个、10-08 两个。合计 8。
// CI：cancelled，或 run_attempt>1，一个轮次只计 1。窗口外的 #106 不计。合计 5（101、102、103、108、110）。
const PULLS: Pull[] = [
  pull({
    number: 1,
    created_at: '2026-10-06T00:00:00Z',
    merged_at: '2026-10-06T00:30:00Z',
    head: { ref: 'fleet/707-t01a12107' },
  }),
  pull({
    number: 2,
    created_at: '2026-10-06T02:00:00Z',
    merged_at: '2026-10-06T03:30:00Z',
    head: { ref: 'fleet/12-tabcdef01' },
  }),
  pull({
    number: 3,
    created_at: '2026-10-07T00:00:00Z',
    merged_at: '2026-10-07T03:00:00Z',
    head: { ref: 'fleet/3-t0000000a' },
  }),
  pull({
    number: 4,
    created_at: '2026-10-07T04:00:00Z',
    merged_at: '2026-10-07T04:10:00Z',
    head: { ref: 'feat/x' },
  }),
  pull({
    number: 5,
    created_at: '2026-10-07T05:00:00Z',
    merged_at: '2026-10-07T05:20:00Z',
    head: { ref: 'fleet/707-t01a1210' },
  }),
  pull({
    number: 6,
    created_at: '2026-10-08T00:00:00Z',
    merged_at: '2026-10-08T00:40:00Z',
    head: { ref: 'docs/y' },
  }),
  pull({
    number: 7,
    created_at: '2026-10-08T09:00:00+08:00',
    merged_at: '2026-10-08T10:20:00+08:00',
    head: { ref: 'chore/z' },
  }),
  pull({
    number: 8,
    created_at: '2026-10-03T12:00:00Z',
    merged_at: '2026-10-03T14:59:59Z',
    head: { ref: 'feat/old' },
  }),
  pull({
    number: 9,
    created_at: '2026-10-07T00:00:00Z',
    merged_at: null,
    head: { ref: 'feat/closed' },
  }),
  pull({
    number: 10,
    created_at: '2026-10-03T14:00:00Z',
    merged_at: '2026-10-03T15:00:00Z',
    head: { ref: 'feat/boundary' },
  }),
];

const RUNS: Run[] = [
  run({ id: 101, created_at: '2026-10-06T00:00:00Z', conclusion: 'cancelled', run_attempt: 1 }),
  run({ id: 102, created_at: '2026-10-06T01:00:00Z', conclusion: 'success', run_attempt: 2 }),
  run({ id: 103, created_at: '2026-10-07T00:00:00Z', conclusion: 'cancelled', run_attempt: 4 }),
  run({ id: 104, created_at: '2026-10-07T01:00:00Z', conclusion: 'success', run_attempt: 1 }),
  run({ id: 105, created_at: '2026-10-07T02:00:00Z', conclusion: 'failure', run_attempt: 1 }),
  run({ id: 106, created_at: '2026-10-03T14:00:00Z', conclusion: 'cancelled', run_attempt: 1 }),
  run({
    id: 107,
    created_at: '2026-10-08T03:00:00Z',
    status: 'in_progress',
    conclusion: null,
    run_attempt: 1,
  }),
  run({
    id: 108,
    created_at: '2026-10-08T04:00:00Z',
    status: 'in_progress',
    conclusion: null,
    run_attempt: 2,
  }),
  run({ id: 110, created_at: '2026-10-03T15:00:00Z', conclusion: 'cancelled', run_attempt: 1 }),
];

function ghOf(pulls: unknown, runs: unknown): (path: string) => unknown {
  return (path) => {
    if (path.includes('/pulls?')) return pulls;
    if (path.includes('/actions/workflows/ci.yml/runs?')) return runs;
    throw new Error(`没想到的路径 ${path}`);
  };
}

function statsOf(pulls: unknown, runs: unknown): FlowStats {
  return flowStats(ghOf(pulls, runs), OPTS);
}

describe('假的 GitHub 回包', () => {
  it('每天合并、开到合的中位和 90 分位、被取消或重跑的轮数，和手算一致', () => {
    const paths: string[] = [];
    const stats = flowStats((path) => {
      paths.push(path);
      return ghOf(PULLS, { total_count: RUNS.length, workflow_runs: RUNS })(path);
    }, OPTS);

    expect(stats.daily).toEqual([
      { day: '2026-10-03', count: 1 },
      { day: '2026-10-04', count: 0 },
      { day: '2026-10-05', count: 0 },
      { day: '2026-10-06', count: 2 },
      { day: '2026-10-07', count: 3 },
      { day: '2026-10-08', count: 2 },
    ]);
    expect(stats.engine).toEqual({ count: 3, medianMin: 90, p90Min: 180 });
    expect(stats.other).toEqual({ count: 5, medianMin: 40, p90Min: 80 });
    expect(stats.wastedCi).toBe(5);
    expect(formatFlowStats(stats)).toBe(
      [
        '最近 5 天（2026-10-03T15:00:00.000Z 到 2026-10-08T15:00:00.000Z，UTC）',
        '每天合并',
        '2026-10-03  1',
        '2026-10-04  0',
        '2026-10-05  0',
        '2026-10-06  2',
        '2026-10-07  3',
        '2026-10-08  2',
        '开到合（分钟）',
        '引擎 PR（3 个）中位 90，90 分位 180',
        '其他（5 个）中位 40，90 分位 80',
        '被取消或重跑的 CI 轮数 5',
        '',
      ].join('\n'),
    );
    // 日期过滤按窗口起点的 UTC 日，不把更早的历史全拉下来
    expect(
      paths.some((p) => p.includes('/pulls?') && p.includes('state=closed') && p.includes('sort=updated')),
    ).toBe(true);
    expect(
      paths.some(
        (p) => p.includes('/actions/workflows/ci.yml/runs?') && p.includes('created=%3E%3D2026-10-03'),
      ),
    ).toBe(true);
  });

  it('翻到 updated_at 已早于窗口就停，不把后面的页算进来', () => {
    const paths: string[] = [];
    const page = (items: Pull[]) => items;
    const pages = [
      page([
        pull({
          number: 1,
          created_at: '2026-10-07T00:00:00Z',
          merged_at: '2026-10-07T00:10:00Z',
          updated_at: '2026-10-07T00:10:00Z',
          head: { ref: 'feat/a' },
        }),
        pull({
          number: 2,
          created_at: '2026-10-07T01:00:00Z',
          merged_at: '2026-10-07T01:30:00Z',
          updated_at: '2026-10-07T01:30:00Z',
          head: { ref: 'feat/b' },
        }),
      ]),
      page([
        pull({
          number: 3,
          created_at: '2026-10-06T00:00:00Z',
          merged_at: '2026-10-06T00:50:00Z',
          updated_at: '2026-10-06T00:50:00Z',
          head: { ref: 'fleet/1-taaaaaaaa' },
        }),
        pull({
          number: 4,
          created_at: '2026-10-01T00:00:00Z',
          merged_at: '2026-10-01T01:00:00Z',
          updated_at: '2026-10-05T00:00:00Z',
          head: { ref: 'feat/old' },
        }),
      ]),
    ];
    const stats = flowStats(
      (path) => {
        paths.push(path);
        if (path.includes('/pulls?')) {
          const pageNo = Number(new URLSearchParams(path.split('?')[1]).get('page'));
          return pages[pageNo - 1] ?? [];
        }
        return {
          total_count: 1,
          workflow_runs: [
            run({ id: 1, created_at: '2026-10-07T00:00:00Z', conclusion: 'success', run_attempt: 1 }),
          ],
        };
      },
      { ...OPTS, now: new Date('2026-10-08T00:00:00.000Z'), days: 2, pageSize: 2 },
    );
    expect(paths.filter((p) => p.includes('/pulls?'))).toHaveLength(2);
    // 其他 10 与 30：中位 (10+30)/2 = 20；90 分位 ceil(0.9×2)−1 = 1 → 30。引擎只有 50。
    expect(stats.other).toEqual({ count: 2, medianMin: 20, p90Min: 30 });
    expect(stats.engine).toEqual({ count: 1, medianMin: 50, p90Min: 50 });
    expect(stats.daily).toEqual([
      { day: '2026-10-06', count: 1 },
      { day: '2026-10-07', count: 2 },
      { day: '2026-10-08', count: 0 },
    ]);
    expect(stats.wastedCi).toBe(0);
    expect(formatFlowStats(stats)).toContain('被取消或重跑的 CI 轮数 0');
  });

  it('这一档一个都没有：写「这一档没有」，不打中位 0', () => {
    const only = [
      pull({
        number: 1,
        created_at: '2026-10-07T00:00:00Z',
        merged_at: '2026-10-07T01:00:00Z',
        head: { ref: 'fleet/9-t01234567' },
      }),
    ];
    const stats = statsOf(only, {
      total_count: 1,
      workflow_runs: [
        run({ id: 1, created_at: '2026-10-07T00:00:00Z', conclusion: 'success', run_attempt: 1 }),
      ],
    });
    expect(stats.engine).toEqual({ count: 1, medianMin: 60, p90Min: 60 });
    expect(stats.other).toBeNull();
    const text = formatFlowStats(stats);
    expect(text).toContain('其他：这一档没有');
    expect(text).not.toContain('其他（0');
  });
});

describe('【故意造出的失败】', () => {
  const runsBody = {
    total_count: 1,
    workflow_runs: [
      run({ id: 1, created_at: '2026-10-07T00:00:00Z', conclusion: 'success', run_attempt: 1 }),
    ],
  };
  const basePull = pull({
    number: 12,
    created_at: '2026-10-07T00:00:00Z',
    merged_at: '2026-10-07T01:00:00Z',
    head: { ref: 'feat/x' },
  });
  const onePull = [basePull];

  it('回包缺字段：没查成', () => {
    const cases: [unknown, unknown, RegExp][] = [
      [[{ ...basePull, created_at: undefined }], runsBody, /没查成：PR 12 缺 created_at/],
      [[{ ...basePull, merged_at: undefined }], runsBody, /没查成：PR 12 缺 merged_at/],
      [[{ ...basePull, merged_at: '昨天' }], runsBody, /没查成：PR 12 的 merged_at 不是时间/],
      [[{ ...basePull, head: {} }], runsBody, /没查成：PR 12 缺分支名/],
      [[{ ...basePull, updated_at: undefined }], runsBody, /没查成：PR 12 的 updated_at 不是时间/],
      [
        [
          pull({
            number: 12,
            created_at: '2026-10-07T02:00:00Z',
            merged_at: '2026-10-07T01:00:00Z',
            head: { ref: 'feat/x' },
          }),
        ],
        runsBody,
        /没查成：PR 12 开到合的时间是负的/,
      ],
      [
        onePull,
        {
          total_count: 1,
          workflow_runs: [
            { id: 9, created_at: '2026-10-07T00:00:00Z', status: 'completed', conclusion: 'success' },
          ],
        },
        /没查成：CI 轮次 9 的 run_attempt/,
      ],
      [
        onePull,
        {
          total_count: 1,
          workflow_runs: [
            {
              id: 9,
              created_at: '2026-10-07T00:00:00Z',
              status: 'completed',
              conclusion: null,
              run_attempt: 1,
            },
          ],
        },
        /没查成：CI 轮次 9 已结束却没有 conclusion/,
      ],
      [onePull, { workflow_runs: RUNS }, /没查成：CI 轮次的 total_count/],
      [{ message: 'nope' }, runsBody, /没查成：PR 列表认不出/],
    ];
    for (const [pulls, runs, pattern] of cases) {
      expect(() => statsOf(pulls, runs)).toThrow(pattern);
    }
  });

  it('列表为空：没查成，不打 0', () => {
    expect(() => statsOf([], runsBody)).toThrow(/没查成：PR 列表是空的/);
    expect(() =>
      statsOf(
        [
          pull({
            number: 1,
            created_at: '2026-10-01T00:00:00Z',
            merged_at: '2026-10-01T01:00:00Z',
            updated_at: '2026-10-02T00:00:00Z',
            head: { ref: 'feat/old' },
          }),
        ],
        runsBody,
      ),
    ).toThrow(/没查成：窗口里没有合并的 PR/);
    expect(() =>
      statsOf(
        [
          pull({
            number: 1,
            created_at: '2026-10-07T00:00:00Z',
            merged_at: null,
            head: { ref: 'feat/closed' },
          }),
        ],
        runsBody,
      ),
    ).toThrow(/没查成：窗口里没有合并的 PR/);
    expect(() => statsOf(onePull, { total_count: 0, workflow_runs: [] })).toThrow(
      /没查成：CI 轮次列表是空的/,
    );
    expect(() =>
      statsOf(onePull, {
        total_count: 1,
        workflow_runs: [
          run({ id: 1, created_at: '2026-10-01T00:00:00Z', conclusion: 'cancelled', run_attempt: 1 }),
        ],
      }),
    ).toThrow(/没查成：窗口里没有 ci\.yml 轮次/);
  });

  it('翻页到上限还没翻完：没查成', () => {
    const pulls: string[] = [];
    expect(() =>
      flowStats(
        (path) => {
          if (path.includes('/pulls?')) {
            pulls.push(path);
            return [
              pull({
                number: 1,
                created_at: '2026-10-07T00:00:00Z',
                merged_at: '2026-10-07T01:00:00Z',
                updated_at: '2026-10-07T01:00:00Z',
                head: { ref: 'feat/x' },
              }),
            ];
          }
          return runsBody;
        },
        { ...OPTS, pageSize: 1, maxPages: 1 },
      ),
    ).toThrow(/没查成：PR 没翻完/);
    expect(pulls).toHaveLength(1);

    expect(() =>
      flowStats(
        (path) => {
          if (path.includes('/pulls?')) return onePull;
          return {
            total_count: 3,
            workflow_runs: [
              run({ id: 1, created_at: '2026-10-07T00:00:00Z', conclusion: 'success', run_attempt: 1 }),
              run({ id: 2, created_at: '2026-10-07T01:00:00Z', conclusion: 'success', run_attempt: 1 }),
            ],
          };
        },
        { ...OPTS, pageSize: 2, maxPages: 1 },
      ),
    ).toThrow(/没查成：CI 轮次没列全/);
  });
});

describe('参数', { timeout: 0 }, () => {
  it('--days 缺省 7；不是 1 到 90 的整数就没查成', () => {
    expect(parseDays(undefined)).toBe(7);
    expect(parseDays('7')).toBe(7);
    expect(parseDays('90')).toBe(90);
    expect(() => parseDays('0')).toThrow(/没查成：--days/);
    expect(() => parseDays('91')).toThrow(/没查成：--days/);
    expect(() => parseDays('昨天')).toThrow(/没查成：--days/);
    expect(() => flowStats(ghOf([], {}), { ...OPTS, repo: 'not a repo' })).toThrow(/没查成：--repo/);
  });

  it('【故意造出的失败】入口收到无效的 --days：退出 2，还没去读 GitHub', () => {
    const bin = fileURLToPath(new URL('../src/bin/flow-stats.ts', import.meta.url));
    const r = runChild(process.execPath, [bin, '--days', '昨天']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('没查成');
    expect(r.stdout).toBe('');
  });
});
