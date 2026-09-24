import { QueryClient } from '@tanstack/react-query';
import { describe, expect, test, vi } from 'vitest';
import { applyLiveEvent, keys } from './client';

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
    applyLiveEvent(qc, { type: 'change', table: 'some_new_table', id: 'x' });
    applyLiveEvent(qc, { type: 'resync' });
    applyLiveEvent(qc, { type: 'ready' });
    expect(called()).toEqual(['全部', '全部', '全部']);
  });
});
