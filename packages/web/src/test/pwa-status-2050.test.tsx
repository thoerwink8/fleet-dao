// @vitest-environment happy-dom
// 设置页的 APP 状态（#2050）：安装、通知权限、角标三样都显示；读不到写「读不到」；权限只在点按钮时才请求。
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { PwaStatus } from '../components/pwa-status';
import { resetInstallForTest } from '../lib/pwa/install';

const requestPermission = vi.fn(async () => 'granted');
let permission = 'default';

function stubBrowser(opts: { notification?: boolean; badge?: boolean; serviceWorker?: boolean }) {
  if (opts.notification !== false) {
    vi.stubGlobal('Notification', {
      get permission() {
        return permission;
      },
      requestPermission: async () => {
        permission = 'granted';
        return requestPermission();
      },
    });
  } else {
    vi.stubGlobal('Notification', undefined);
  }
  const nav = navigator as unknown as Record<string, unknown>;
  if (opts.badge) nav.setAppBadge = async () => {};
  else nav.setAppBadge = undefined;
  if (opts.serviceWorker === false) delete nav.serviceWorker;
  else nav.serviceWorker = {};
}

function row(label: string): HTMLElement {
  const cell = screen.getByText(label, { selector: 'div' });
  const el = cell.parentElement;
  if (!el) throw new Error(`没找到「${label}」那一行`);
  return el;
}

beforeEach(() => {
  permission = 'default';
  requestPermission.mockClear();
  resetInstallForTest();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PwaStatus', () => {
  test('三样都显示：能不能装、通知权限、角标', () => {
    stubBrowser({ badge: true });
    render(<PwaStatus />);
    expect(within(row('安装')).getByText('现在不能安装')).toBeTruthy();
    expect(within(row('系统通知')).getByText('还没打开')).toBeTruthy();
    expect(within(row('图标角标')).getByText('支持')).toBeTruthy();
  });

  test('页面加载时不请求通知权限；点「打开系统通知」才请求，之后显示已允许', async () => {
    stubBrowser({ badge: false });
    render(<PwaStatus />);
    expect(requestPermission).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '打开系统通知' }));
    await waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(within(row('系统通知')).getByText('已允许')).toBeTruthy());
    expect(screen.queryByRole('button', { name: '打开系统通知' })).toBeNull();
    expect(within(row('图标角标')).getByText('不支持')).toBeTruthy();
  });

  test('读不到的写「读不到」：没有通知功能、没有 service worker', () => {
    stubBrowser({ notification: false, serviceWorker: false });
    render(<PwaStatus />);
    expect(within(row('安装')).getByText('读不到')).toBeTruthy();
    expect(within(row('系统通知')).getByText('读不到')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '打开系统通知' })).toBeNull();
  });

  test('权限已被拒绝：写明原因，没有按钮', () => {
    permission = 'denied';
    stubBrowser({});
    render(<PwaStatus />);
    expect(within(row('系统通知')).getByText('已被拒绝')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '打开系统通知' })).toBeNull();
  });

  test('浏览器给出可安装信号后出现「安装」按钮，点了弹安装框', async () => {
    stubBrowser({});
    const { listenForInstall } = await import('../lib/pwa/install');
    const stop = listenForInstall();
    render(<PwaStatus />);
    const prompt = vi.fn(async () => {});
    const ev = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      prompt,
      userChoice: Promise.resolve({ outcome: 'accepted' as const }),
    });
    window.dispatchEvent(ev);
    const button = await screen.findByRole('button', { name: '安装' });
    expect(within(row('安装')).getByText('可以安装')).toBeTruthy();
    fireEvent.click(button);
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    stop();
  });
});
