// @vitest-environment happy-dom
// 路由出事了页面要说（#1748）：疑似降智、Grok 令牌过期、Cursor 全是没探，渠道状态页怎么写。
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
  test('被判疑似降智的路由：写「疑似降智·已按不在线处理」，不写成按需探测，也不画红', async () => {
    open('ch-cursor');
    await waitFor(() => byAttr('data-route', 'r-cursor-hi'));
    const row = byAttr('data-route', 'r-cursor-hi');
    expect(row.getAttribute('data-kind')).toBe('degraded');
    expect(row.textContent).toContain('疑似降智·已按不在线处理');
    expect(row.textContent).not.toContain('按需探测');
    expect(byAttr('data-channel', 'ch-cursor').textContent).toContain('1 疑似降智');
  });

  test('Grok 令牌过期：渠道卡、渠道详情、路由行都写原因和要人做什么', async () => {
    open('ch-grok');
    await waitFor(() => byAttr('data-route', 'r-grok'));
    expect(byAttr('data-channel', 'ch-grok').textContent).toContain('额度读不到，要人处理');
    const box = document.querySelector('[data-pool-problems]');
    expect(box?.textContent).toContain('登录令牌已过期');
    expect(box?.textContent).toContain('要人做：在引擎所在的机器（法国）以会话用户重新 grok login');
    expect(
      byAttr('data-route', 'r-grok').querySelector('[data-pool-problem="unreadable"]')?.textContent,
    ).toContain('grok login');
  });

  test('Cursor 最近全是没探：色条和可用率只按真探算，没探的折起来', async () => {
    open('ch-cursor');
    const strip = await waitFor(() => byAttr('data-history', 'strip'));
    // 两次真探（r-cursor 不通、r-cursor-hi 降智），其余十几条没探都不在色条上
    expect(strip.querySelectorAll('[data-cell]')).toHaveLength(2);
    expect(strip.querySelector('[data-result="doubt"]')).toBeTruthy();
    expect(strip.querySelector('[data-result="not_probed"]')).toBeNull();
    expect(strip.querySelector('[data-result="on_demand"]')).toBeNull();
    expect(strip.textContent).toContain('可用率 0%（0/2）');
    const fold = byAttr('data-probe-log', 'skipped');
    expect(fold.textContent).toMatch(/条没真探的记录/);
    expect(document.querySelector('[aria-label="没真探的记录"]')).toBeNull();
    fireEvent.click(within(fold).getByRole('button'));
    expect(document.querySelector('[aria-label="没真探的记录"]')).toBeTruthy();
  });
});
