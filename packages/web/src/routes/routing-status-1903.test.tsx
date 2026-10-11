// @vitest-environment happy-dom
// 渠道状态页噪声文案（#1903，评审 v8 第 17 条）：渠道头部只留一句中文结论，探针的原始报错收进可展开的提醒；
// 左列数字圈有「优先级」说明；底部脚注收进 ⓘ。
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import RoutingStatus from '../routes/routing-status';
import { renderApp } from '../test/harness';

afterEach(cleanup);

describe('渠道状态页：报错进可展开的提醒', () => {
  test('故障渠道：头部是中文结论，探针原文在默认收着的提醒里，头部不直接露原文', async () => {
    renderApp(<RoutingStatus />, { route: '/routing/status' });
    const list = await screen.findByRole('list', { name: '渠道状态' });
    const cursor = list.querySelector('[data-channel="ch-cursor"]') as HTMLElement;
    fireEvent.click(cursor.querySelector('button') as HTMLElement);
    const raw = await waitFor(() => {
      const el = document.querySelector('[data-raw-reason]');
      if (!(el instanceof HTMLElement)) throw new Error('原文提醒还没出来');
      return el;
    });
    const details = raw.querySelector('details');
    expect(details).toBeTruthy();
    expect(details?.hasAttribute('open')).toBe(false);
    expect(details?.textContent).toContain('连探两次都没通');
    // 头部（区块页头）：有中文结论，没有原文
    const header = raw.closest('section')?.querySelector('header');
    expect(header?.textContent).toMatch(/路都不通/);
    expect(header?.textContent).not.toContain('连探两次都没通');
  });

  test('左列有「优先级」说明；脚注收在 ⓘ 里，点开才出现', async () => {
    renderApp(<RoutingStatus />, { route: '/routing/status' });
    await screen.findByRole('list', { name: '渠道状态' });
    expect(document.querySelector('[data-rank-header]')?.textContent).toContain('优先级');
    expect(screen.queryByText(/不拿旧绿灯掩盖中断/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '怎么看这些状态' }));
    expect(screen.getByText(/不拿旧绿灯掩盖中断/)).toBeTruthy();
  });
});
