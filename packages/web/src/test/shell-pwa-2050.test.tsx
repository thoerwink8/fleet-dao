// @vitest-environment happy-dom
// 外壳里的 PWA 接线（#2050）：新提醒来了，窗口在前台不弹系统通知、不在前台弹、点一下回对应页；角标跟着待处理数走。
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createMockApi } from '../api/mock/server';
import type { Notification as Notice, Notifications } from '../api/types';
import Shell from '../routes/shell';
import { renderApp } from './harness';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface Made {
  title: string;
  options?: NotificationOptions | undefined;
  onclick: (() => void) | null;
  close: () => void;
}
let made: Made[];
let setAppBadge: ReturnType<typeof vi.fn>;
let clearAppBadge: ReturnType<typeof vi.fn>;

beforeEach(() => {
  made = [];
  setAppBadge = vi.fn(async () => {});
  clearAppBadge = vi.fn(async () => {});
  (navigator as unknown as Record<string, unknown>).setAppBadge = setAppBadge;
  (navigator as unknown as Record<string, unknown>).clearAppBadge = clearAppBadge;
  vi.stubGlobal(
    'Notification',
    class {
      static permission = 'granted';
      static requestPermission = vi.fn();
      onclick: (() => void) | null = null;
      close = vi.fn();
      title: string;
      options: NotificationOptions | undefined;
      constructor(title: string, options?: NotificationOptions) {
        this.title = title;
        this.options = options;
        made.push(this as unknown as Made);
      }
    },
  );
});

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function setup() {
  const api = createMockApi({ live: false });
  let extra: Notice[] = [];
  const read = api.notifications.bind(api);
  api.notifications = async (q) => {
    const base = await read(q);
    return {
      ...base,
      items: [...extra, ...base.items],
      counts: { ...base.counts, decision: base.counts.decision + extra.length },
    } satisfies Notifications;
  };
  const view = renderApp(
    <Routes>
      <Route element={<Shell />}>
        <Route path="*" element={<Where />} />
      </Route>
    </Routes>,
    { api, route: '/' },
  );
  const push = async (n: Notice) => {
    extra = [n, ...extra];
    await act(async () => {
      await view.qc.invalidateQueries({ queryKey: ['notifications'] });
    });
  };
  return { ...view, push };
}

const incoming = (id: string, link?: string): Notice =>
  ({
    id,
    level: 'decision',
    title: '要你拍：发版',
    body: '选一个',
    link,
    createdAt: new Date().toISOString(),
    deliveries: [],
  }) as unknown as Notice;

async function ready() {
  await waitFor(() => expect(screen.getByTestId('where')).toBeTruthy());
  await waitFor(() =>
    expect(setAppBadge.mock.calls.length + clearAppBadge.mock.calls.length).toBeGreaterThan(0),
  );
}

describe('外壳里的系统通知', () => {
  test('窗口在前台：新提醒不弹系统通知', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { push } = setup();
    await ready();
    await push(incoming('new-1', '/tasks/7'));
    await waitFor(() => expect(setAppBadge).toHaveBeenCalled());
    expect(made).toHaveLength(0);
  });

  test('窗口不在前台：新提醒弹一条，点一下回对应页；第一次读到的旧提醒不弹', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const { push } = setup();
    await ready();
    expect(made).toHaveLength(0);
    await push(incoming('new-2', '/tasks/7'));
    await waitFor(() => expect(made).toHaveLength(1));
    expect(made[0]?.title).toBe('要你拍：发版');
    await act(async () => {
      made[0]?.onclick?.();
    });
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/tasks/7'));
  });

  test('角标用待处理数：有件数写数字', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { push } = setup();
    await ready();
    const before = setAppBadge.mock.calls.length;
    await push(incoming('new-3'));
    await waitFor(() => expect(setAppBadge.mock.calls.length).toBeGreaterThan(before));
    const last = setAppBadge.mock.calls.at(-1)?.[0];
    expect(typeof last).toBe('number');
    expect(last).toBeGreaterThan(0);
  });
});
