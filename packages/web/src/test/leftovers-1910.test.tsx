// @vitest-environment happy-dom
// 驾驶舱观感片 7（#1910）：路由左卡按内容高度、设置运行设置单栏、仓库行按钮等宽、标签外形一套。
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { createMockApi } from '../api/mock/server';
import { StatusBadge } from '../components/layout/status-badge';
import { Tag } from '../components/layout/tag';
import { badgeShape } from '../components/layout/tone';
import RoutingPage from '../routes/routing';
import SettingsPage from '../routes/settings';
import { renderApp } from './harness';

afterEach(cleanup);

describe('#1910 片 7', () => {
  test('路由页左卡（模型先后）按内容高度：容器和栅格都没有固定高度类，左右不互相拉高', async () => {
    renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    const list = await screen.findByRole('list', { name: '模型' });
    const left = list.closest('section');
    expect(left?.getAttribute('aria-label')).toBe('模型先后');
    expect(left?.className).not.toMatch(/(^|\s)(xl:)?h-/);
    const grid = left?.parentElement;
    expect(grid?.className).toContain('items-start');
    expect(grid?.className).not.toMatch(/h-routing-desk|grid-rows-routing-desk|items-stretch/);
  });

  test('设置页运行设置不再分两栏（3 项分两栏会剩 1 项孤栏）', async () => {
    renderApp(<SettingsPage />, { api: createMockApi({ live: false }), route: '/settings' });
    await screen.findByTestId('dispatch-r-orbit');
    const run = document.getElementById('run');
    expect(run).toBeTruthy();
    expect(run?.innerHTML).not.toContain('2xl:grid-cols-2');
  });

  // #1917 起两个按钮在任何宽度都同一行（照路由页样板一行一个状态、按钮在行尾）：原来断言的「手机上各占一行、按钮靠右同列」
  // （max-md:w-full / justify-between / ml-auto）换成等价的「同宽、同在这一行的 RowFrame 里、相邻」
  test('仓库行：「关闭/开启」和「整理」按钮同宽，同一行、挨着放在行尾', async () => {
    renderApp(<SettingsPage />, { api: createMockApi({ live: false }), route: '/settings' });
    const dispatch = await screen.findByTestId('dispatch-r-orbit');
    const toggle = dispatch.querySelector('button');
    const panel = await screen.findByTestId('groom-r-orbit');
    const groom = panel.querySelector('button[aria-label^="让指挥官整理"]');
    expect(toggle?.className).toContain('min-w-16');
    expect(groom?.className).toContain('min-w-16');
    const frame = toggle?.closest('[data-row-frame]');
    expect(frame).toBeTruthy();
    expect(groom?.closest('[data-row-frame]')).toBe(frame);
    // 状态和开关按钮直接落在行里（外层 contents），和「整理」是兄弟，不另起一行
    expect(dispatch.className).toContain('contents');
    expect(toggle?.parentElement).toBe(dispatch);
    expect(dispatch.parentElement).toBe(groom?.parentElement);
  });

  test('带底色的 StatusBadge 和 Tag 用同一套外形（badgeShape：h-6、px-2、rounded-sm），不再全圆', () => {
    // #3509：颜色只给异常，只有 warning/error 画底色标签；正常状态画圆点加字，不是标签
    render(
      <>
        <StatusBadge tone="fail" label="状态" />
        <StatusBadge tone="done" label="完成" />
        <Tag>标签</Tag>
      </>,
    );
    for (const cls of badgeShape.split(' ')) {
      expect(screen.getByText('状态').className).toContain(cls);
      expect(screen.getByText('标签').className).toContain(cls);
    }
    expect(badgeShape).toContain('rounded-sm');
    expect(screen.getByText('状态').className).not.toContain('rounded-full');
    expect(screen.getByText('完成').className).not.toContain('rounded-full');
    expect(screen.getByText('完成').querySelector('[data-level="success"]')).toBeTruthy();
  });
});
