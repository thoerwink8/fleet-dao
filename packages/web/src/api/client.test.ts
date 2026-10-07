import type { RealtimeTable } from '@fleet-dao/shared';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, test, vi } from 'vitest';
import { applyLiveEvents, createLiveBatcher, keys } from './client';
import type { LiveEvent } from './types';

/** 一条推送单独处理。 */
const applyOne = (qc: QueryClient, e: LiveEvent) => applyLiveEvents(qc, [e]);

function spy() {
  const qc = new QueryClient();
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  const called = () => invalidate.mock.calls.map(([f]) => (f?.queryKey ? f.queryKey.join('/') : '全部'));
  return { qc, called };
}

describe('推送到缓存：按表名决定重拉什么', () => {
  test('需求表变了：重拉看板、任务详情、主页', () => {
    const { qc, called } = spy();
    applyOne(qc, { type: 'change', table: 'tasks', id: 't-1' });
    expect(called()).toEqual(['board', 'task', keys.home.join('/')]);
  });

  test('主页读到的表一变就重拉主页（单子换段、通知来了、审批、三段流水、在跑的会话、额度和渠道），不等刷新页面', () => {
    const homeTables = [
      'tasks',
      'notifications',
      'approvals',
      'runs',
      'session_runs',
      'quota_windows',
      'channels',
    ] as const satisfies readonly RealtimeTable[];
    for (const table of homeTables) {
      const { qc, called } = spy();
      applyOne(qc, { type: 'change', table, id: 'x' });
      expect(called(), table).toContain(keys.home.join('/'));
      expect(called(), `${table} 不该全量重拉`).not.toContain('全部');
    }
  });

  test('三段流水 runs 变了：主页的流水线图和任务详情的流水跟着重拉', () => {
    const { qc, called } = spy();
    applyOne(qc, { type: 'change', table: 'runs', id: 'run-1' });
    expect(called()).toEqual([keys.home.join('/'), 'task']);
  });

  test('额度窗、渠道变了：路由两层的活不活跟着重拉（额度够不够、渠道开没开都在三件事里）', () => {
    const { qc, called } = spy();
    applyOne(qc, { type: 'change', table: 'quota_windows', id: 'pool-a' });
    applyOne(qc, { type: 'change', table: 'channels', id: 'ch-a' });
    expect(called()).toEqual([
      keys.pools.join('/'),
      keys.routingLayers.join('/'),
      keys.home.join('/'),
      keys.routing.join('/'),
      keys.pools.join('/'),
      keys.routingLayers.join('/'),
      keys.home.join('/'),
    ]);
  });

  test('认不出的表、断线重连：全部重拉——宁可多拉，不把漏收当没变化', () => {
    const { qc, called } = spy();
    // 后端比前端先上新表时（部署先后），表名会不在这份名单里。
    applyOne(qc, { type: 'change', table: 'some_new_table' as RealtimeTable, id: 'x' });
    applyOne(qc, { type: 'resync' });
    applyOne(qc, { type: 'ready' });
    expect(called()).toEqual(['全部', '全部', '全部']);
  });
});

describe('重拉不打断正在读的：打断了要从头再等一轮', () => {
  /** 一份查询的每次读取都挂着，由测试决定什么时候回；记下每次读取的 AbortSignal 看有没有被取消。 */
  function held(qc: QueryClient, queryKey: string[]) {
    const reads: { signal: AbortSignal; done: (v: string) => void }[] = [];
    const observer = new QueryObserver(qc, {
      queryKey,
      queryFn: ({ signal }) => new Promise<string>((done) => reads.push({ signal, done })),
    });
    const stop = observer.subscribe(() => {});
    return { reads, stop };
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));

  test('连上推送时的全量重拉：正在读的照常读完、不取消不重发，读完再补拉一次；没在读的当场重拉', async () => {
    const qc = new QueryClient();
    const board = held(qc, ['board', 'r1']);
    const me = held(qc, ['me']);
    me.reads[0]?.done('我');
    await vi.waitFor(() => expect(qc.getQueryData(['me'])).toBe('我'));

    applyOne(qc, { type: 'ready' });
    await settle();
    expect(board.reads).toHaveLength(1);
    expect(board.reads[0]?.signal.aborted).toBe(false);
    expect(me.reads).toHaveLength(2);

    board.reads[0]?.done('旧的');
    await vi.waitFor(() => expect(board.reads).toHaveLength(2));
    expect(qc.getQueryData(['board', 'r1'])).toBe('旧的');
    board.reads[1]?.done('新的');
    await vi.waitFor(() => expect(qc.getQueryData(['board', 'r1'])).toBe('新的'));
    board.stop();
    me.stop();
  });

  test('推送一条接一条：看板读着的时候来几批都不打断，读完只补拉一次', async () => {
    const qc = new QueryClient();
    const board = held(qc, ['board', 'r1']);
    for (const id of ['p1', 'p2', 'p3']) {
      applyOne(qc, { type: 'change', table: 'progress_events', id });
      await settle();
    }
    expect(board.reads).toHaveLength(1);
    expect(board.reads[0]?.signal.aborted).toBe(false);
    board.reads[0]?.done('第一次');
    await vi.waitFor(() => expect(board.reads).toHaveLength(2));
    await settle();
    expect(board.reads).toHaveLength(2);
    board.stop();
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
      expect(called()).toEqual(['board', 'task', 'notifications', 'home']);
      b.push({ type: 'change', table: 'tasks', id: 't1' });
      vi.advanceTimersByTime(400);
      expect(called().slice(4)).toEqual(['board', 'task', 'home']);
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
