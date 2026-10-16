// @vitest-environment happy-dom
// 危险动作先确认（#2017）：清理没用的工作树、撤掉手工登记的模型。
// 不点确认不发请求；确认键走 onConfirm，点一次只发一次。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { createMockApi } from '../api/mock/server';
import ResourcesPage from '../routes/resources';
import RoutingPage from '../routes/routing';
import { renderApp } from './harness';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test('清理没用的工作树：不确认不发请求，确认后只发一次，确认键带着忙态', async () => {
  const api = createMockApi({ live: false });
  const cleanupTrees = vi.spyOn(api, 'worktreeCleanup').mockImplementation(() => new Promise(() => {}));
  renderApp(<ResourcesPage />, { api });
  const open = await waitFor(() => {
    const button = document.querySelector<HTMLButtonElement>('[data-cleanup-button]');
    if (!button || button.disabled) throw new Error('清理按钮还没好');
    return button;
  });
  fireEvent.click(open);
  await Promise.resolve();
  expect(cleanupTrees).not.toHaveBeenCalled();
  const dialog = await screen.findByRole('alertdialog');
  const confirm = within(dialog).getByRole('button', { name: '确认清理' });
  fireEvent.click(confirm);
  await waitFor(() => expect(cleanupTrees).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(confirm.getAttribute('data-loading')).toBe(''));
  expect(confirm.getAttribute('aria-busy')).toBe('true');
  fireEvent.click(confirm);
  await Promise.resolve();
  expect(cleanupTrees).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('alertdialog')).toBeTruthy();
});

test('撤掉手工登记的模型：不确认不发请求，确认后只发一次', async () => {
  const { api } = renderApp(<RoutingPage />, { route: '/routing?tab=channels' });
  const revoke = vi.spyOn(api, 'revokeChannelModel').mockImplementation(() => new Promise(() => {}));
  await screen.findByRole('list', { name: '渠道列表' });
  fireEvent.click(screen.getByRole('button', { name: '查看 Claude 订阅 的路由' }));
  const form = await screen.findByRole('form', { name: '手工登记模型串' });
  fireEvent.change(within(form).getByRole('textbox', { name: '模型串' }), {
    target: { value: 'claude-sonnet-x' },
  });
  fireEvent.click(within(form).getByRole('button', { name: '登记' }));
  const list = await screen.findByRole('list', { name: '已登记的模型串' });
  await waitFor(() => expect(list.textContent).toContain('claude-sonnet-x'));
  fireEvent.click(within(list).getByRole('button', { name: '撤掉 claude-sonnet-x' }));
  await Promise.resolve();
  expect(revoke).not.toHaveBeenCalled();
  const dialog = await screen.findByRole('alertdialog');
  const confirm = within(dialog).getByRole('button', { name: '撤掉' });
  fireEvent.click(confirm);
  await waitFor(() => expect(revoke).toHaveBeenCalledTimes(1));
  expect(revoke).toHaveBeenCalledWith('ch-claude', { modelKey: 'claude-sonnet-x' });
  await waitFor(() => expect(confirm.getAttribute('data-loading')).toBe(''));
  expect(confirm.getAttribute('aria-busy')).toBe('true');
  fireEvent.click(confirm);
  await Promise.resolve();
  expect(revoke).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('alertdialog')).toBeTruthy();
});
