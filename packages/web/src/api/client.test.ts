import type { RealtimeTable } from '@fleet-dao/shared';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, test, vi } from 'vitest';
import { applyLiveEvent, applyLiveEvents, createLiveBatcher, keys } from './client';

function spy() {
  const qc = new QueryClient();
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  const called = () => invalidate.mock.calls.map(([f]) => (f?.queryKey ? f.queryKey.join('/') : '全部'));
  return { qc, called };
}

describe('推送到缓存：按表名决定重拉什么', () => {
  test('需求表变了：重拉看板、任务详情、时间线', () => {
    const { qc, called } = spy();
    applyLiveEvent(qc, { type: 'change', table: 'tasks', id: 't-1' });
    expect(called()).toEqual(['board', 'task', 'timeline']);
  });

  test('阶段策略变了：只重拉调度台', () => {
    const { qc, called } = spy();
    applyLiveEvent(qc, { type: 'change', table: 'stage_policies', id: 'execute' });
    expect(called()).toEqual([keys.routing.join('/')]);
  });

  test('认不出的表、断线重连：全部重拉——宁可多拉，不把漏收当没变化', () => {
    const { qc, called } = spy();
    // 后端比前端先上新表时（部署先后），表名会不在这份名单里。
    applyLiveEvent(qc, { type: 'change', table: 'some_new_table' as RealtimeTable, id: 'x' });
    applyLiveEvent(qc, { type: 'resync' });
    applyLiveEvent(qc, { type: 'ready' });
    expect(called()).toEqual(['全部', '全部', '全部']);
  });
});

describe('推送攒一小会儿再作废', () => {
  test('窗口内来的多条只作废一次，窗口一到就作废（不会漏）', () => {
    vi.useFakeTimers();
    try {
      const { qc, called } = spy();
      const b = createLiveBatcher(qc, 400);
      b.push({ type: 'change', table: 'progress_events', id: 'p1' });
      b.push({ type: 'change', table: 'progress_events', id: 'p2' });
      b.push({ type: 'change', table: 'notifications', id: 'n1' });
      expect(called()).toEqual([]);
      vi.advanceTimersByTime(400);
      expect(called()).toEqual(['board', 'task', 'timeline', 'run-steps', 'notifications']);
      b.push({ type: 'change', table: 'tasks', id: 't1' });
      vi.advanceTimersByTime(400);
      expect(called().slice(5)).toEqual(['board', 'task', 'timeline']);
    } finally {
      vi.useRealTimers();
    }
  });

  test('一批里有重连或认不出的表：全部作废一次', () => {
    const { qc, called } = spy();
    applyLiveEvents(qc, [{ type: 'change', table: 'tasks', id: 't1' }, { type: 'ready' }]);
    expect(called()).toEqual(['全部']);
  });

  test('停掉以后攒着的不再作废', () => {
    vi.useFakeTimers();
    try {
      const { qc, called } = spy();
      const b = createLiveBatcher(qc, 400);
      b.push({ type: 'resync' });
      b.stop();
      vi.advanceTimersByTime(1000);
      expect(called()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
