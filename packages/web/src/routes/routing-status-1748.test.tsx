// @vitest-environment happy-dom
// 路由出事了页面要说（#1748、#1798）：疑似换模型、Grok 令牌过期，渠道状态页怎么写。
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { createMockApi } from '../api/mock/server';
import RoutingStatus from '../routes/routing-status';
import { renderApp } from '../test/harness';

afterEach(cleanup);

const byAttr = (attr: string, value: string) => {
  const el = document.querySelector(`[${attr}="${value}"]`);
  if (!(el instanceof HTMLElement)) throw new Error(`页面上没有 ${attr}=${value}`);
  return el;
};

const open = (channelId: string) =>
  renderApp(<RoutingStatus />, {
    route: `/routing/status?p=${channelId}`,
    api: createMockApi({ live: false }),
  });

describe('渠道状态页（#1748）', () => {
  test('身份题说出旧答案的路由：写「疑似换模型·已按不在线处理」，不画红', async () => {
    open('ch-cursor');
    await waitFor(() => byAttr('data-route', 'r-cursor-hi'));
    const row = byAttr('data-route', 'r-cursor-hi');
    expect(row.getAttribute('data-kind')).toBe('degraded');
    expect(row.textContent).toContain('疑似换模型·已按不在线处理');
    expect(byAttr('data-channel', 'ch-cursor').textContent).toContain('1 疑似换模型');
  });

  test('Grok 令牌过期：渠道卡、渠道详情、路由行都写原因和要人做什么', async () => {
    open('ch-grok');
    await waitFor(() => byAttr('data-route', 'r-grok'));
    expect(byAttr('data-channel', 'ch-grok').textContent).toContain('额度读不到，等 grok 下次运行自己续');
    const box = document.querySelector('[data-pool-problems]');
    expect(box?.textContent).toContain('登录令牌已过期');
    expect(box?.textContent).toContain('先等 grok 下次运行自己续');
    expect(box?.textContent).not.toContain('不会自己好');
    expect(
      byAttr('data-route', 'r-grok').querySelector('[data-pool-problem="unreadable"]')?.textContent,
    ).toContain('grok login');
  });

  test('Cursor 的色条只按真探算：一次不通、一次通过、一次说中旧答案', async () => {
    open('ch-cursor');
    const strip = await waitFor(() => byAttr('data-history', 'strip'));
    expect(strip.querySelectorAll('[data-cell]')).toHaveLength(3);
    expect(strip.querySelector('[data-result="doubt"]')).toBeTruthy();
    expect(strip.querySelector('[data-result="not_probed"]')).toBeNull();
    expect(strip.textContent).toContain('可用率 33.3%（1/3）');
  });

  test('中转站有没真探的记录：色条上不画，折起来，点开才看', async () => {
    open('ch-relay');
    const strip = await waitFor(() => byAttr('data-history', 'strip'));
    expect(strip.querySelector('[data-result="not_probed"]')).toBeNull();
    const fold = byAttr('data-probe-log', 'skipped');
    expect(fold.textContent).toMatch(/条没真探的记录/);
    expect(document.querySelector('[aria-label="没真探的记录"]')).toBeNull();
    fireEvent.click(within(fold).getByRole('button'));
    expect(document.querySelector('[aria-label="没真探的记录"]')).toBeTruthy();
  });
});
