// @vitest-environment happy-dom
// 渠道状态页噪声文案（#1903，评审 v8 第 17 条）：渠道头部只留一句中文结论，探针的原始报错收进可展开的提醒；
// 左列数字圈有「优先级」说明；底部脚注收进 ⓘ。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import RoutingStatus from '../routes/routing-status';
import { renderApp } from '../test/harness';

afterEach(cleanup);

describe('渠道状态页照路由页样板（#1922）', () => {
  test('详情顶上三行结论块：渠道名、一句结论加状态、灰字细节；三行都不折', async () => {
    renderApp(<RoutingStatus />, { route: '/routing/status?p=ch-claude' });
    const hero = await waitFor(() => {
      const el = document.querySelector('[data-channel-hero]');
      if (!(el instanceof HTMLElement)) throw new Error('结论块还没出来');
      return el;
    });
    expect(hero.querySelector('h2')?.textContent).toBe('Claude 订阅');
    const line = hero.querySelector('[data-hero-line]') as HTMLElement;
    // 假数据里 Claude 订阅有一条路连通但额度耗尽（#2939）：结论说清几条，不说成整个渠道不通
    expect(line.textContent).toMatch(/在用的 \d+ 条路里 1 条额度耗尽，其余可用/);
    expect(line.textContent).toContain('部分路额度耗尽');
    // 一行不折：整句放悬停（组件层负责截断）
    expect(line.getAttribute('title')).toBe(line.querySelector('[data-hero-text]')?.textContent);
    const notes = hero.querySelector('[data-hero-notes]') as HTMLElement;
    expect(notes.getAttribute('title')).toBe(notes.textContent);
    expect(notes.textContent).toMatch(/订阅 · \d+ 条路由/);
    // 「探这个渠道」在结论块第一行右边
    expect(hero.querySelector('button')?.textContent).toContain('探这个渠道');
  });

  test('路由行：名字加一个状态，小字一行不折（路由号、上次、下次）；展开后有立即探测、看最近一次（样稿：行尾不再放「⋯」）', async () => {
    renderApp(<RoutingStatus />, { route: '/routing/status?p=ch-relay' });
    const row = await waitFor(() => {
      const el = document.querySelector('[data-route="r-rl-kimi"]');
      if (!(el instanceof HTMLElement)) throw new Error('路由行还没出来');
      return el;
    });
    // 不再是一行一个圆角框
    expect(row.className).not.toContain('rounded-lg');
    const meta = row.querySelector('[data-route-meta]') as HTMLElement;
    expect(meta.textContent).toContain('r-rl-kimi');
    expect(meta.querySelector('[data-probe-last]')).toBeTruthy();
    expect(meta.getAttribute('title')).toContain('上次');
    // 行里没有「⋯」；两个操作在展开的明细里
    expect(row.querySelector('[data-row-menu]')).toBeNull();
    fireEvent.click(row.querySelector('button[aria-expanded]') as HTMLElement);
    expect(within(row).getByRole('button', { name: '立即探测' })).toBeTruthy();
    expect(within(row).getByRole('button', { name: '看最近一次' })).toBeTruthy();
  });
});

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
    // 顺位的说明和脚注一起收在「怎么看这些状态」里（样稿：左列不再单放一行列头）
    expect(screen.queryByText(/不拿旧绿灯掩盖中断/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '怎么看这些状态' }));
    expect(screen.getByText(/不拿旧绿灯掩盖中断/)).toBeTruthy();
    expect(screen.getByText(/顺位是优先级/)).toBeTruthy();
  });
});
