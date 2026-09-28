// @vitest-environment happy-dom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createMockApi } from '../api/mock/server';
import BoardPage from '../routes/board';
import { renderApp } from '../test/harness';
import { SeatBar } from './seat-bar';

vi.mock('./board-canvas', () => ({ BoardCanvas: () => null }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function width(mobile: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (q: string) =>
      ({
        matches: mobile && q.includes('max-width'),
        media: q,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList,
  );
}

describe('首页帅位栏', () => {
  test('点一个选项后这一问从栏里消失', async () => {
    const api = createMockApi({ live: false });
    renderApp(<SeatBar />, { api });
    expect(await screen.findByText(/先做哪一件/)).toBeTruthy();
    expect(screen.getByText('在做的')).toBeTruthy();
    expect(screen.getByText('最近动态')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '先做页面' }));
    expect(await screen.findByText('没有要你定的')).toBeTruthy();
    expect(screen.queryByText(/先做哪一件/)).toBeNull();
  });

  // #446：帅位不再是锁，栏里只显示「谁、最后活动多久前」，没有租约、任期核对这类拦人的逻辑
  test('显示帅位是谁、最后活动多久前（只给人看，不拦任何东西）', async () => {
    const api = createMockApi({ live: false });
    renderApp(<SeatBar />, { api });
    expect(await screen.findByText(/帅位：第 3 任 本机\/s1，最后活动/)).toBeTruthy();
  });

  test('电脑宽和 375 宽都渲染这三块', async () => {
    for (const mobile of [false, true]) {
      cleanup();
      width(mobile);
      renderApp(<BoardPage />, { api: createMockApi({ live: false }) });
      expect(await screen.findByText('要你定的')).toBeTruthy();
      expect(screen.getByText('在做的')).toBeTruthy();
      expect(screen.getByText('最近动态')).toBeTruthy();
    }
  });
});
