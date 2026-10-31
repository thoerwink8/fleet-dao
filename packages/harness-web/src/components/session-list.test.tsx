// @vitest-environment happy-dom
// 会话列表：「做完」组默认折叠、显示条数、点开展开、状态记进 localStorage；「卡住」个数用服务端给的（不自己数）。
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DONE_COLLAPSED_KEY } from '../lib/collapse';
import type { SessionSummary } from '../lib/types';

const mk = (id: string, lastEventId: number, tail: NonNullable<SessionSummary['tail']>): SessionSummary => ({
  id,
  eventCount: 2,
  lastEventId,
  lastAt: '2026-10-31T00:00:00Z',
  lastType: 'worker.settled',
  lastPayload: {},
  tail,
});

const completed = [{ type: 'handback.recorded', final: true, outcome: 'completed' }];
const stuckTail = [{ type: 'worker.settled', exitCode: 1 }];

let sessions: SessionSummary[];
let stuckCount: number | null;
vi.mock('../lib/hooks', () => ({
  useSessions: () => ({
    sessions,
    stuckCount,
    error: null,
    failures: 0,
    unauthorized: false,
    hasMore: false,
    loadingMore: false,
    loadMore: () => {},
  }),
}));

const { SessionList } = await import('./session-list');

const renderList = () =>
  render(
    <MemoryRouter>
      <SessionList />
    </MemoryRouter>,
  );

beforeEach(() => {
  localStorage.clear();
  sessions = [
    mk('done-a', 10, completed),
    mk('done-b', 9, completed),
    mk('done-c', 8, completed),
    mk('bad-1', 7, stuckTail),
  ];
  stuckCount = 41; // 服务端数的全库个数，和页面上已加载的（1 个）不一样，页面要显示服务端的
});
afterEach(cleanup);

describe('做完组折叠', () => {
  it('默认折叠：显示条数，不渲染会话行；其他组照常', () => {
    renderList();
    expect(screen.getByTestId('group-count-done').textContent).toBe('3');
    expect(screen.getByTestId('toggle-done').getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelectorAll('[data-group="done"] [data-session-id]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-group="stuck"] [data-session-id]')).toHaveLength(1);
  });

  it('点开展开，并把展开记进 localStorage；再点折叠也记', () => {
    renderList();
    fireEvent.click(screen.getByTestId('toggle-done'));
    expect(document.querySelectorAll('[data-group="done"] [data-session-id]')).toHaveLength(3);
    expect(localStorage.getItem(DONE_COLLAPSED_KEY)).toBe('0');
    fireEvent.click(screen.getByTestId('toggle-done'));
    expect(document.querySelectorAll('[data-group="done"] [data-session-id]')).toHaveLength(0);
    expect(localStorage.getItem(DONE_COLLAPSED_KEY)).toBe('1');
  });

  it('上次存的是展开，重新进来就是展开', () => {
    localStorage.setItem(DONE_COLLAPSED_KEY, '0');
    renderList();
    expect(screen.getByTestId('toggle-done').getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelectorAll('[data-group="done"] [data-session-id]')).toHaveLength(3);
  });

  it('localStorage 抛错：照样默认折叠、点开也能用', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    renderList();
    expect(document.querySelectorAll('[data-group="done"] [data-session-id]')).toHaveLength(0);
    fireEvent.click(screen.getByTestId('toggle-done'));
    expect(document.querySelectorAll('[data-group="done"] [data-session-id]')).toHaveLength(3);
    get.mockRestore();
    set.mockRestore();
  });
});

describe('卡住个数由服务端给', () => {
  it('显示服务端的数（41），不是已加载里自己数的（1）', () => {
    renderList();
    expect(screen.getByText('卡住 41')).toBeTruthy();
  });

  it('接口没给（旧接口）就不显示，不自己数', () => {
    stuckCount = null;
    renderList();
    expect(screen.queryByText(/^卡住 \d+$/)).toBeNull();
  });
});
