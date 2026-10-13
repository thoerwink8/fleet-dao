// 需求整理（#2049）这一轮怎么记：跑成记 ok（扫了几条、删了归档了几条）；表里没有需求记 unscanned 写明；
// 库读不了记 failed 再抛，不记成功。整理本身（硬删、归档、操作记录）在 packages/db/test/requests.test.ts 里用真库测。
import type { RequestSweepResult, ScheduleResult } from '@fleet-dao/db';
import { describe, expect, it } from 'vitest';
import { REQUEST_SWEEP_JOB, RequestSweepFailedError, runRequestSweepJob } from '../src/jobs/request-sweep.ts';

const NOW = new Date('2026-10-13T10:00:00Z');

function deps(sweep: () => Promise<RequestSweepResult>) {
  const finished: { id: number; result: ScheduleResult }[] = [];
  const started: string[] = [];
  return {
    finished,
    started,
    deps: {
      sweep,
      runs: {
        start: async (job: string) => {
          started.push(job);
          return 7;
        },
        finish: async (id: number, result: ScheduleResult) => {
          finished.push({ id, result });
        },
      },
      now: () => NOW,
      log: () => {},
    },
  };
}

describe('runRequestSweepJob', () => {
  it('跑成：记 ok，扫了几条、删了加归档了几条', async () => {
    const d = deps(async () => ({ scanned: 5, purged: [1], archived: [2, 3] }));
    const r = await runRequestSweepJob(d.deps);
    expect(d.started).toEqual([REQUEST_SWEEP_JOB.id]);
    expect(r).toEqual({ outcome: 'ok', scanned: 5, found: 3, why: '硬删 1 条、自动归档 2 条' });
    expect(d.finished).toEqual([{ id: 7, result: r }]);
  });

  it('表里一条都没有：记 unscanned 写明，不冒充「查过、0 个」', async () => {
    const d = deps(async () => ({ scanned: 0, purged: [], archived: [] }));
    const r = await runRequestSweepJob(d.deps);
    expect(r).toEqual({ outcome: 'unscanned', why: '需求表里还没有需求，没有可整理的' });
  });

  it('【故意造出的失败】库读不了：记 failed 再抛，不记成功', async () => {
    const d = deps(async () => {
      throw new Error('connection refused');
    });
    await expect(runRequestSweepJob(d.deps)).rejects.toBeInstanceOf(RequestSweepFailedError);
    expect(d.finished[0]?.result).toEqual({ outcome: 'failed', why: '需求整理没跑成：connection refused' });
  });
});
