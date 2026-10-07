// 每周刷新 CI 测试耗时表（#921 第 1 条）：注入假的 GitHub 客户端，不连 GitHub。
// 三条：表变了就开 PR；表里没缺文件、重写结果和现表相同就不开；日志读不到或没有可用的全量运行记没查成（故意造出的失败）。
import { mergeTimings, renderTimings } from '@fleet-dao/conventions';
import type { ScheduleResult } from '@fleet-dao/db';
import { describe, expect, it } from 'vitest';
import {
  CI_TIMINGS_EVERY_MINUTES,
  CI_TIMINGS_OFFSET_MINUTES,
  type CiTimingsGitHub,
  type OpenTimingsPrInput,
  runCiTimingsJob,
  timingsSource,
} from '../src/jobs/ci-timings.ts';
import { latestSlot } from '../src/jobs/timers.ts';

const NOW = new Date('2026-10-07T01:00:00Z');
const A = 'packages/engine/test/a.test.ts';
const B = 'packages/api/test/b.test.ts';
const FILES = [A, B];

function logOf(ms: Record<string, number>): string {
  return Object.entries(ms)
    .map(
      ([file, value], i) =>
        `test (${i + 1}/6)\tstep\t2026-10-07T00:00:00.0000000Z ✓ ${file} (1 test) ${value}ms`,
    )
    .join('\n');
}

function world(o: {
  logs: Record<string, string | Error>;
  boxes?: number | Error;
  timingsText: string | null;
  testFiles?: string[];
  runs?: { id: string }[] | Error;
}) {
  const opened: OpenTimingsPrInput[] = [];
  const finished: ScheduleResult[] = [];
  const github: CiTimingsGitHub = {
    listSuccessfulRuns: async () => {
      if (o.runs instanceof Error) throw o.runs;
      return o.runs ?? [{ id: '101' }, { id: '102' }];
    },
    successfulTestBoxes: async () => {
      if (o.boxes instanceof Error) throw o.boxes;
      return o.boxes ?? 6;
    },
    runLog: async (id) => {
      const log = o.logs[id];
      if (log === undefined) throw new Error(`没有 ${id} 的日志`);
      if (log instanceof Error) throw log;
      return log;
    },
    readHead: async () => ({
      commit: 'a'.repeat(40),
      timingsText: o.timingsText,
      testFiles: o.testFiles ?? FILES,
    }),
    openPr: async (input) => {
      opened.push(input);
      return { number: 321, url: 'https://github.com/thoerwink8/fleet-dao/pull/321' };
    },
  };
  const deps = {
    github,
    runs: {
      start: async () => 7,
      finish: async (_id: number, result: ScheduleResult) => {
        finished.push(result);
      },
    },
    now: () => NOW,
    log: () => undefined,
  };
  return { deps, opened, finished };
}

function table(files: Record<string, number>, source: string): string {
  return renderTimings(mergeTimings(undefined, new Map(Object.entries(files)), FILES, source).timings);
}

const SAME = { [A]: 100, [B]: 20 };
const SAME_SOURCE = timingsSource(['ci.yml run 101', 'ci.yml run 102'], NOW);

describe('每周刷新耗时表', () => {
  it('每周一 06:00（北京时间）一格', () => {
    const job = { everyMinutes: CI_TIMINGS_EVERY_MINUTES, offsetMinutes: CI_TIMINGS_OFFSET_MINUTES };
    const monday = Date.parse('2026-10-05T06:00:00+08:00');
    expect(latestSlot(job, monday)).toBe(monday);
    expect(latestSlot(job, monday - 1)).toBe(monday - 7 * 24 * 60 * 60 * 1000);
  });

  it('重写结果和现表不同：开一个 PR，正文不写 Closes', async () => {
    const w = world({
      logs: { '101': logOf({ [A]: 500, [B]: 20 }), '102': logOf({ [A]: 500, [B]: 20 }) },
      timingsText: table(SAME, '旧的'),
    });
    const run = await runCiTimingsJob(w.deps);
    expect(run.outcome).toBe('ok');
    expect(w.opened).toHaveLength(1);
    expect(w.opened[0]?.content).toContain('"packages/engine/test/a.test.ts": 500');
    expect(w.opened[0]?.content).not.toContain(': 100');
    expect(w.opened[0]?.body).not.toMatch(/Closes\s+#/i);
    expect(w.opened[0]?.body).toContain('无：');
    expect(w.opened[0]?.baseCommit).toBe('a'.repeat(40));
    expect(w.finished[0]).toMatchObject({ outcome: 'ok', found: 1 });
  });

  it('表里没缺文件、重写结果和现表相同：不开 PR', async () => {
    const w = world({
      logs: { '101': logOf(SAME), '102': logOf(SAME) },
      timingsText: table(SAME, SAME_SOURCE),
    });
    const run = await runCiTimingsJob(w.deps);
    expect(run.outcome).toBe('ok');
    expect(w.opened).toEqual([]);
    expect(w.finished[0]).toMatchObject({ outcome: 'ok', found: 0 });
  });

  it('【故意造出的失败】取日志读不到、没有可用的全量运行：记没查成，不开 PR，不写成功', async () => {
    const unread = world({
      logs: { '101': new Error('日志下载 500'), '102': logOf(SAME) },
      timingsText: table(SAME, SAME_SOURCE),
    });
    await expect(runCiTimingsJob(unread.deps)).rejects.toThrow(/没查成/);
    expect(unread.opened).toEqual([]);
    expect(unread.finished[0]).toMatchObject({ outcome: 'failed' });
    expect(unread.finished[0]?.outcome === 'failed' ? unread.finished[0].why : '').toContain('没查成');

    const none = world({
      logs: {},
      boxes: 1,
      timingsText: table(SAME, SAME_SOURCE),
      runs: [{ id: '201' }, { id: '202' }],
    });
    await expect(runCiTimingsJob(none.deps)).rejects.toThrow(/没查成/);
    expect(none.opened).toEqual([]);
    expect(none.finished[0]).toMatchObject({ outcome: 'failed' });
    expect(none.finished[0]?.outcome === 'failed' ? none.finished[0].why : '').toContain('没查成');
  });
});
