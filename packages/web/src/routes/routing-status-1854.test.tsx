// @vitest-environment happy-dom
// 渠道状态页迁到新版式后的读屏和手机行为（#1854）：选中的渠道行带 aria-current；手机上探针色条只做展示。
import { cleanup, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createMockApi } from '../api/mock/server';
import RoutingStatus from '../routes/routing-status';
import { renderApp } from '../test/harness';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const realMatchMedia = window.matchMedia.bind(window);

function mockPhone() {
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => {
    if (query === '(max-width: 767px)') {
      return {
        matches: true,
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent() {
          return false;
        },
      } as MediaQueryList;
    }
    return realMatchMedia(query);
  });
}

describe('渠道状态页（#1854）', () => {
  test('选中的渠道行：按钮带 aria-current 和完整的 aria-label，别的行没有', async () => {
    renderApp(<RoutingStatus />, {
      route: '/routing/status?p=ch-relay',
      api: createMockApi({ live: false }),
    });
    const list = await waitFor(() => {
      const el = document.querySelector('ul[aria-label="渠道状态"]');
      if (!(el instanceof HTMLElement)) throw new Error('还没有渠道列表');
      return el;
    });
    const buttons = within(list).getAllByRole('button');
    const current = buttons.filter((b) => b.getAttribute('aria-current') === 'true');
    expect(current).toHaveLength(1);
    expect(current[0]?.closest('[data-channel]')?.getAttribute('data-channel')).toBe('ch-relay');
    expect(current[0]?.getAttribute('aria-label')).toMatch(/^.+：.+，.+/);
    expect(buttons.every((b) => b.getAttribute('aria-label'))).toBe(true);
  });

  test('桌面：探针色条每格是按钮，可点', async () => {
    renderApp(<RoutingStatus />, {
      route: '/routing/status?p=ch-relay',
      api: createMockApi({ live: false }),
    });
    const strip = await waitFor(() => {
      const el = document.querySelector('[data-history="strip"]');
      if (!(el instanceof HTMLElement)) throw new Error('还没有色条');
      return el;
    });
    expect(strip.querySelectorAll('button[data-cell]').length).toBeGreaterThan(0);
    expect(strip.querySelector('[data-strip-display]')).toBeNull();
  });

  test('手机：探针色条整条只做展示，一个汇总 aria-label，格子不是按钮', async () => {
    mockPhone();
    renderApp(<RoutingStatus />, {
      route: '/routing/status?p=ch-relay',
      api: createMockApi({ live: false }),
    });
    const strip = await waitFor(() => {
      const el = document.querySelector('[data-history="strip"]');
      if (!(el instanceof HTMLElement)) throw new Error('还没有色条');
      return el;
    });
    const display = strip.querySelector('[data-strip-display]');
    expect(display?.getAttribute('role')).toBe('img');
    expect(display?.getAttribute('aria-label')).toMatch(
      /^近 \d+ 次真探：通过 \d+、不通 \d+、疑似换模型 \d+$/,
    );
    expect(strip.querySelectorAll('[data-cell]').length).toBeGreaterThan(0);
    expect(strip.querySelector('button[data-cell]')).toBeNull();
  });
});
