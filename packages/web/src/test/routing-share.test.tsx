// @vitest-environment happy-dom
// 驾驶舱上把同一个模型的两条路由收进同一档，页面写出比例。没有浏览器，用 happy-dom 点菜单。
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { createMockApi } from '../api/mock/server';
import RoutingPage from '../routes/routing';
import { renderApp } from './harness';

afterEach(cleanup);

const open = (trigger: HTMLElement) => {
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
};

describe('路由页同一档', () => {
  test('和上一条同一档之后，能看见比例和还看不出均不均', async () => {
    renderApp(<RoutingPage />, { api: createMockApi({ live: false }), route: '/routing' });
    const links = within(await screen.findByRole('navigation', { name: '用途' })).getAllByRole('button');
    fireEvent.click(links[0] as HTMLElement);
    fireEvent.click(await screen.findByRole('button', { name: '查看 Opus 5.5 的路由' }));
    const row = document.querySelector('[data-route="r-cb-opus"]');
    if (!(row instanceof HTMLElement)) throw new Error('页面上没有 r-cb-opus');
    open(within(row).getByRole('button', { name: /更多操作/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: '和上一条同一档' }));
    const line = await screen.findByText(/同一档：/);
    expect(line.hasAttribute('data-route-share')).toBe(true);
    expect(line.textContent).toContain('50%');
    expect(line.textContent).toContain('权重 1');
    expect(line.textContent).toContain('还看不出均不均');
    expect(line.textContent).toContain('Claude 订阅 · claude-a');
    expect(line.textContent).toContain('Claude 订阅 · claude-b');
  });
});
