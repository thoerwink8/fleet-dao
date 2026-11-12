// 工人状态的共用规则（#3781 收尾）：前端分组和接口层数「卡住」用的是同一个函数；这里钉住数个数的口径。
import { describe, expect, it } from 'vitest';
import { countStuck, DEADLINE_GRACE_MS, deriveWorkerState, type TailEvent } from '../src/worker-state.ts';

describe('ADE 轮次结束', () => {
  const now = Date.parse('2026-11-12T00:00:00Z');
  it('带 outcome 的 settled：lost 卡住，其余空闲；没有 outcome 的不盖掉前面的做完', () => {
    expect(
      deriveWorkerState(
        [{ type: 'session.turn.started' }, { type: 'session.turn.settled', outcome: 'completed' }],
        now,
      ),
    ).toBe('waiting');
    expect(
      deriveWorkerState(
        [{ type: 'session.turn.started' }, { type: 'session.turn.settled', outcome: 'stopped' }],
        now,
      ),
    ).toBe('waiting');
    expect(
      deriveWorkerState(
        [{ type: 'session.turn.started' }, { type: 'session.turn.settled', outcome: 'lost' }],
        now,
      ),
    ).toBe('stuck');
    expect(
      deriveWorkerState(
        [{ type: 'handback.recorded', final: true, outcome: 'completed' }, { type: 'session.turn.settled' }],
        now,
      ),
    ).toBe('done');
  });
});

const NOW = Date.parse('2026-10-31T12:00:00Z');

describe('countStuck', () => {
  it('按 deriveWorkerState 的卡住数个数；空列表是 0', () => {
    const tails: TailEvent[][] = [
      [{ type: 'worker.settled', exitCode: 1 }],
      [{ type: 'worker.settled', exitCode: 0 }],
      [{ type: 'handback.recorded', final: true, outcome: 'completed', verdict: 'unverified' }],
      [{ type: 'handback.recorded', final: true, outcome: 'completed', verdict: 'failed' }],
      [{ type: 'worker.result.submitted', status: 'blocked' }],
      [],
    ];
    expect(countStuck(tails, NOW)).toBe(3);
    expect(countStuck([], NOW)).toBe(0);
  });

  it('过了截止时间加宽限算卡住，用传进来的 now', () => {
    const run: TailEvent[] = [{ type: 'worker.spawned', deadline: '2026-10-31T11:00:00Z' }];
    expect(deriveWorkerState(run, NOW)).toBe('stuck');
    expect(countStuck([run], NOW)).toBe(1);
    expect(countStuck([run], Date.parse('2026-10-31T11:00:00Z') + DEADLINE_GRACE_MS)).toBe(0);
  });

  it('收任何可迭代（Map.values()）', () => {
    const m = new Map<string, TailEvent[]>([['a', [{ type: 'worker.settled', killed: 'x' }]]]);
    expect(countStuck(m.values(), NOW)).toBe(1);
  });
});
