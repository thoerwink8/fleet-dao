// 量 CI 的纯计算（src/ci-stats.ts）：读不出的时间要抛，不能当 0 秒冒充「很快」。
import { describe, expect, it } from 'vitest';
import { type JobInput, type RunInput, rowOf, summarize } from '../src/ci-stats.ts';

const run = (over: Partial<RunInput> = {}): RunInput => ({
  id: 1,
  event: 'push',
  head_sha: 'a'.repeat(40),
  conclusion: 'success',
  created_at: '2026-10-05T00:00:00Z',
  run_started_at: '2026-10-05T00:00:00Z',
  updated_at: '2026-10-05T00:01:30Z',
  ...over,
});
const job = (name: string, start: string, end: string, conclusion = 'success'): JobInput => ({
  name,
  conclusion,
  started_at: start,
  completed_at: end,
});

describe('rowOf', () => {
  it('墙钟、排队、机器秒数、job 数；被跳过的 job 不算', () => {
    const r = rowOf(run(), [
      job('lint', '2026-10-05T00:00:03Z', '2026-10-05T00:00:43Z'),
      job('test', '2026-10-05T00:00:10Z', '2026-10-05T00:01:10Z'),
      {
        name: 'deploy',
        conclusion: 'skipped',
        started_at: '2026-10-05T00:00:10Z',
        completed_at: '2026-10-05T00:00:10Z',
      },
    ]);
    expect(r).toMatchObject({ wallSec: 90, queueSec: 3, machineSec: 100, jobs: 2, sha: 'aaaaaaaa' });
    expect(r.perJob).toEqual({ lint: 40, test: 60 });
  });

  it('【故意造出的失败】时间缺了、不是时间、一个 job 都没有、还没跑完：抛错，不当 0 秒', () => {
    const ok = job('lint', '2026-10-05T00:00:03Z', '2026-10-05T00:00:43Z');
    expect(() => rowOf(run(), [{ ...ok, completed_at: null }])).toThrow('completed_at');
    expect(() => rowOf(run(), [{ ...ok, started_at: '昨天' }])).toThrow('started_at');
    expect(() => rowOf(run({ updated_at: '' }), [ok])).toThrow('updated_at');
    expect(() => rowOf(run(), [])).toThrow('一个 job 都没跑');
    expect(() => rowOf(run(), [{ ...ok, conclusion: 'skipped' }])).toThrow('一个 job 都没跑');
    expect(() => rowOf(run({ conclusion: null }), [ok])).toThrow('还没跑完');
  });
});

describe('summarize', () => {
  it('按事件各一行：中位数、最大、合计；没有的事件不出行', () => {
    const mk = (event: string, wall: number, machine: number) => ({
      id: 1,
      event,
      sha: 'x',
      conclusion: 'success',
      wallSec: wall,
      queueSec: 2,
      machineSec: machine,
      jobs: 3,
      perJob: {},
    });
    const s = summarize([
      mk('push', 60, 120),
      mk('push', 100, 240),
      mk('push', 80, 60),
      mk('pull_request', 50, 60),
    ]);
    expect(s.map((x) => x.event)).toEqual(['pull_request', 'push']);
    expect(s[1]).toMatchObject({ runs: 3, wallMedian: 80, wallMax: 100, machineMinTotal: 7 });
    expect(summarize([])).toEqual([]);
    // 偶数个：中位数是中间两个的平均
    const even = summarize([mk('push', 60, 60), mk('push', 100, 60)]);
    expect(even[0]?.wallMedian).toBe(80);
  });
});
