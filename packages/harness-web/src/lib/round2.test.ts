import { describe, expect, it } from 'vitest';
import { clampText } from './clamp';
import { DEADLINE_GRACE_MS, deriveWorkerState, groupByState, type TailEvent } from './session-state';
import { groupToolRuns, summarizeTools } from './tool-runs';
import type { FeedEvent } from './types';

const fe = (id: number, type: string): FeedEvent => ({
  id,
  seq: id,
  type,
  payload: {},
  createdAt: '2026-10-31T00:00:00Z',
});

describe('clampText：200 字或 12 行，先到为准', () => {
  it('短文本原样', () => {
    expect(clampText('a\nb')).toMatchObject({
      preview: 'a\nb',
      truncated: false,
      totalLines: 2,
      totalChars: 3,
    });
  });
  it('字数先到', () => {
    const c = clampText('x'.repeat(500));
    expect(c.preview).toHaveLength(200);
    expect(c.truncated).toBe(true);
    expect(c.totalChars).toBe(500);
  });
  it('行数先到', () => {
    const text = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n');
    const c = clampText(text);
    expect(c.preview.split('\n')).toHaveLength(12);
    expect(c.truncated).toBe(true);
    expect(c.totalLines).toBe(30);
  });
  it('刚好 200 字、12 行不算截', () => {
    expect(clampText('x'.repeat(200)).truncated).toBe(false);
    expect(clampText(Array(12).fill('y').join('\n')).truncated).toBe(false);
  });
  it('13 行算截', () => {
    expect(clampText(Array(13).fill('y').join('\n')).truncated).toBe(true);
  });
});

describe('工具调用折叠', () => {
  const T = ['worker.progress.reported', 'worker.progress.reported', 'worker.result.submitted'];
  it('不到 3 条不折叠', () => {
    const items = groupToolRuns([fe(1, T[0] as string), fe(2, T[1] as string)]);
    expect(items.map((i) => i.kind)).toEqual(['event', 'event']);
  });
  it('3 条起折叠，摘要按工具计数、按首次出现排', () => {
    const items = groupToolRuns(T.map((t, i) => fe(i + 1, t)));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'tools',
      key: 1,
      summary: '调了 3 次工具：report_progress×2、submit_result×1',
    });
  });
  it('非工具事件把串断开；key 取串首', () => {
    const evs = [
      fe(1, 'session.turn.started'),
      ...T.map((t, i) => fe(i + 2, t)),
      fe(5, 'worker.settled'),
      fe(6, 'worker.stop.requested'),
    ];
    const items = groupToolRuns(evs);
    expect(items.map((i) => i.kind)).toEqual(['event', 'tools', 'event', 'event']);
    expect(items[1]).toMatchObject({ key: 2 });
    expect(items[1]?.kind === 'tools' && items[1].events.map((e) => e.id)).toEqual([2, 3, 4]);
  });
  it('摘要认不出的类型用类型名', () => {
    expect(summarizeTools([fe(1, 'x.y')])).toBe('调了 1 次工具：x.y×1');
  });
});

describe('deriveWorkerState', () => {
  const now = Date.parse('2026-10-31T12:00:00Z');
  const st = (...tail: TailEvent[]) => deriveWorkerState(tail, now);
  it('终局交回 delivered = 做完；轮次结束不改变', () => {
    expect(st({ type: 'handback.recorded', final: true, outcome: 'delivered' })).toBe('done');
    expect(
      st({ type: 'handback.recorded', final: true, outcome: 'delivered' }, { type: 'session.turn.settled' }),
    ).toBe('done');
  });
  it('终局交回没交付 = 卡住', () => {
    expect(st({ type: 'handback.recorded', final: true, outcome: 'dead' })).toBe('stuck');
    expect(st({ type: 'handback.recorded', final: true, outcome: 'blocked' })).toBe('stuck');
  });
  it('中间交回 = 等待，哪怕 outcome 是 blocked', () => {
    expect(st({ type: 'handback.recorded', final: false, outcome: 'blocked' })).toBe('waiting');
  });
  it('已启动、有进度 = 在跑', () => {
    const spawned = { type: 'worker.spawned', deadline: '2026-10-31T12:20:00Z' };
    expect(st(spawned)).toBe('running');
    expect(st(spawned, { type: 'worker.progress.reported' })).toBe('running');
    expect(st({ type: 'session.turn.started' })).toBe('running');
  });
  it('超过截止加宽限还在跑 = 卡住；宽限内还算在跑', () => {
    const dl = now - DEADLINE_GRACE_MS;
    expect(st({ type: 'worker.spawned', deadline: new Date(dl - 1).toISOString() })).toBe('stuck');
    expect(st({ type: 'worker.spawned', deadline: new Date(dl).toISOString() })).toBe('running');
    expect(
      st(
        { type: 'worker.spawned', deadline: new Date(dl - 1000).toISOString() },
        { type: 'worker.progress.reported' },
      ),
    ).toBe('stuck');
  });
  it('上一次的截止时间不影响新一轮', () => {
    const old = { type: 'worker.spawned', deadline: '2026-10-31T01:00:00Z' };
    expect(st(old, { type: 'worker.settled', exitCode: 0 }, { type: 'worker.progress.reported' })).toBe(
      'running',
    );
  });
  it('异常结束 = 卡住，正常退出 = 等交回', () => {
    expect(st({ type: 'worker.settled', exitCode: 143, killed: 'stop-requested' })).toBe('stuck');
    expect(st({ type: 'worker.settled', exitCode: 1 })).toBe('stuck');
    expect(st({ type: 'worker.settled', exitCode: null, spawnError: 'ENOENT' })).toBe('stuck');
    expect(st({ type: 'worker.settled', exitCode: 0, killed: null })).toBe('waiting');
  });
  it('交结果 failed / blocked = 卡住，done = 等核验', () => {
    expect(st({ type: 'worker.result.submitted', status: 'failed' })).toBe('stuck');
    expect(st({ type: 'worker.result.submitted', status: 'blocked' })).toBe('stuck');
    expect(st({ type: 'worker.result.submitted', status: 'done' })).toBe('waiting');
  });
  it('交回之后又派新活 = 以最新为准', () => {
    expect(
      st({ type: 'handback.recorded', final: true, outcome: 'dead' }, { type: 'worker.spawn.requested' }),
    ).toBe('waiting');
    expect(
      st({ type: 'handback.recorded', final: true, outcome: 'delivered' }, { type: 'session.turn.started' }),
    ).toBe('running');
  });
  it('没有事件、全是不认识的类型 = 等待', () => {
    expect(st()).toBe('waiting');
    expect(st({ type: 'future.thing' }, { type: 'worker.cleaned' })).toBe('waiting');
  });
});

describe('groupByState：卡住 > 在跑 > 等待 > 做完，组内最后事件号倒序', () => {
  it('排序和空组不出', () => {
    const items = [
      { id: 'a', lastEventId: 5, s: 'done' as const },
      { id: 'b', lastEventId: 9, s: 'running' as const },
      { id: 'c', lastEventId: 2, s: 'stuck' as const },
      { id: 'd', lastEventId: 7, s: 'stuck' as const },
      { id: 'e', lastEventId: 8, s: 'done' as const },
    ];
    const g = groupByState(items, (i) => i.s);
    expect(g.map((x) => x.state)).toEqual(['stuck', 'running', 'done']);
    expect(g.map((x) => x.items.map((i) => i.id))).toEqual([['d', 'c'], ['b'], ['e', 'a']]);
  });
});
