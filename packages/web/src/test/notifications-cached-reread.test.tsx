// @vitest-environment happy-dom
// 通知中心：外壳先读成，缓存还在 5 秒新鲜期内，这时后端断了再进这一页。
// 必须重读，写出「没读成」和重试；重试读成后提示消失。钉住 e2e 08 进页不重读的时序。
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { ApiError, useNotifications } from '../api/client';
import { createMockApi } from '../api/mock/server';
import type { Notification } from '../api/types';
import NotificationsPage from '../routes/notifications';
import { renderApp } from './harness';

afterEach(cleanup);

const STUCK: Notification = {
  id: 'n-stuck',
  level: 'alert',
  title: '任务 12 卡住了',
  body: '这一单停在原处。',
  createdAt: '2026-10-16T00:00:00.000Z',
  deliveries: [],
};

const OK = { items: [STUCK], counts: { decision: 0, alert: 1, daily: 0 } };

/** 外壳那份订阅一直挂着（侧栏、顶栏进页前就订了），页面另外再挂。 */
function Prefetch() {
  useNotifications('open');
  return null;
}

function Scenario({ onPage }: { onPage: boolean }) {
  return (
    <>
      <Prefetch />
      {onPage ? <NotificationsPage /> : null}
    </>
  );
}

describe('通知中心进页重读', () => {
  test('先有数据、缓存仍新鲜时再读失败：显示没读成和重试；重试成功后提示消失', async () => {
    // 新鲜期内不重读，或失败后不留重试，或重试成功后提示还在，这一条会红。
    const api = createMockApi({ live: false });
    let calls = 0;
    let down = false;
    api.notifications = () => {
      calls += 1;
      if (down) return Promise.reject(new ApiError(0, 'network', '连不上后端'));
      return Promise.resolve(OK);
    };

    let openPage = (_open: boolean) => {};
    function Harness() {
      const [onPage, setOnPage] = useState(false);
      useEffect(() => {
        openPage = setOnPage;
      }, []);
      return <Scenario onPage={onPage} />;
    }

    const { qc } = renderApp(<Harness />, { api, staleTime: 5_000 });
    expect(qc.getDefaultOptions().queries?.staleTime).toBe(5_000);

    await waitFor(() => expect(qc.getQueryData(['notifications', 'open'])).toBeTruthy());
    const updatedAt = qc.getQueryState(['notifications', 'open'])?.dataUpdatedAt ?? 0;
    expect(Date.now() - updatedAt).toBeLessThan(5_000);
    const before = calls;
    expect(before).toBeGreaterThan(0);

    down = true;
    act(() => openPage(true));

    const alert = await screen.findByRole('alert');
    expect(calls).toBeGreaterThan(before);
    expect(alert.textContent).toContain('提醒没读成');
    expect(alert.textContent).toContain('连不上后端');
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    // 旧列表还在：不是空白，也不拿「没有提醒」或 0 条冒充这次读成了。
    expect(screen.getByText('任务 12 卡住了')).toBeTruthy();
    expect(screen.queryByText('没有待处理的提醒')).toBeNull();

    down = false;
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByText('任务 12 卡住了')).toBeTruthy();
  });

  test('外壳那次读取还在飞时进页：不把进页前发出的成功当成读成了', async () => {
    // 只跟上在飞的那一次、不另开，或晚到的成功把失败盖掉，这一条会红。
    const api = createMockApi({ live: false });
    let calls = 0;
    let releaseFirst: () => void = () => {};
    api.notifications = () => {
      calls += 1;
      if (calls === 1) {
        return new Promise((resolve) => {
          releaseFirst = () => resolve(OK);
        });
      }
      return Promise.reject(new ApiError(0, 'network', '连不上后端'));
    };

    let openPage = (_open: boolean) => {};
    function Harness() {
      const [onPage, setOnPage] = useState(false);
      useEffect(() => {
        openPage = setOnPage;
      }, []);
      return <Scenario onPage={onPage} />;
    }

    renderApp(<Harness />, { api, staleTime: 5_000 });
    await waitFor(() => expect(calls).toBe(1));

    act(() => openPage(true));
    const alert = await screen.findByRole('alert');
    expect(calls).toBeGreaterThan(1);
    expect(alert.textContent).toContain('提醒没读成');
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();

    // 进页前那一次这时才成功：不能把「没读成」盖掉。
    releaseFirst();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole('alert').textContent).toContain('提醒没读成');
  });
});
