// @vitest-environment happy-dom
// 资源页「仓库」一节（#1993）整页：每仓一行（工作树几棵、磁盘），点开看每棵树的状态和原因；
// 「清理没用的工作树」点了记一条请求、写「排队中」；故意造出的失败：被拒（已有一次在做）把后端的话写出来，
// 清单还没出过写「还没有清单」，不画成 0 棵树；上次清理拒删的树（有没推的提交）原因写在结果里。
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { ApiError } from '../api/client';
import { createMockApi } from '../api/mock/server';
import ResourcesPage from '../routes/resources';
import { renderApp } from './harness';

afterEach(cleanup);

/** 点「清理没用的工作树」，在确认框里点确定（点按钮只开框，不发请求，#2017）。 */
async function confirmCleanup(button: HTMLElement) {
  fireEvent.click(button);
  const dialog = await screen.findByRole('alertdialog');
  const ok = within(dialog).getByRole<HTMLButtonElement>('button', { name: '清理' });
  fireEvent.click(ok);
  return ok;
}

const text = (sel: string) => document.querySelector(sel)?.textContent ?? '';

test('每仓一行；点开看每棵树的状态、原因；上次清理拒删有没推提交的树并写明原因', async () => {
  renderApp(<ResourcesPage />);
  await waitFor(() => expect(document.querySelector('[data-repo="acme/orbit"]')).toBeTruthy());
  expect(text('[data-repo="acme/orbit"]')).toContain('3 棵');
  expect(text('[data-resources-repos]')).toContain('拒删 3 棵');
  expect(text('[data-cleanup-refused]')).toContain('有没推的提交：2 个');
  fireEvent.click(screen.getByRole('button', { name: /acme\/orbit/ }));
  const leftover = document.querySelector('[data-tree="12-9f8e7d6c"]');
  expect(leftover?.getAttribute('data-tree-state')).toBe('leftover');
  expect(leftover?.textContent).toContain('有改动');
  expect(leftover?.textContent).toContain('有没推的提交：2 个');
});

test('点「清理没用的工作树」：记一条请求，写「排队中」，按钮转圈（忙时不拿原生 disabled）', async () => {
  const api = createMockApi({ live: false });
  let go: () => void = () => {};
  const slow = new Promise<void>((res) => {
    go = res;
  });
  const inner = api.worktreeCleanup.bind(api);
  api.worktreeCleanup = async (body) => {
    await slow;
    return inner(body);
  };
  renderApp(<ResourcesPage />, { api });
  const button = await waitFor(() => {
    const b = document.querySelector<HTMLButtonElement>('[data-cleanup-button]');
    if (!b || b.disabled) throw new Error('按钮还没好');
    return b;
  });
  const ok = await confirmCleanup(button);
  // 请求还没回来：确定键转圈、aria-busy + aria-disabled，原生 disabled 让位（#2009 的忙态约定），焦点留得住
  await waitFor(() => expect(ok.getAttribute('aria-busy')).toBe('true'));
  expect(ok.getAttribute('aria-disabled')).toBe('true');
  expect(ok.disabled).toBe(false);
  expect(ok.querySelector('[data-button-spinner]')).not.toBeNull();
  await act(async () => {
    go();
    await slow;
  });
  await waitFor(() => expect(text('[data-resources-repos]')).toContain('清理排队中'));
});

test('【故意造出的失败】被拒（已经有一次在做）：把后端的话写出来，不当成点成了', async () => {
  const api = createMockApi({ live: false });
  api.worktreeCleanup = async () => {
    throw new ApiError(409, 'cleanup_busy', '已经有一次清理在做（x），等它做完再点');
  };
  renderApp(<ResourcesPage />, { api });
  const button = await waitFor(() => {
    const b = document.querySelector<HTMLButtonElement>('[data-cleanup-button]');
    if (!b || b.disabled) throw new Error('按钮还没好');
    return b;
  });
  await confirmCleanup(button);
  // 被拒：确认框留着，原因写在框里的 alert 上（不当成点成了）
  await waitFor(() =>
    expect(within(screen.getByRole('alertdialog')).getByRole('alert').textContent).toContain('等它做完再点'),
  );
});

test('【故意造出的失败】引擎还没出过清单：写「还没有清单」，不画成 0 棵树', async () => {
  const api = createMockApi({ live: false });
  api.worktrees = async () => ({ inventory: null, cleanups: [], unreadable: 0 });
  renderApp(<ResourcesPage />, { api });
  await waitFor(() => expect(text('[data-resources-repos]')).toContain('还没有清单'));
  expect(text('[data-resources-repos]')).not.toContain('0 棵');
});

test('清理工作树：点按钮只开确认框、不发请求；点「先不」不发；确认后只发一次（#2017）', async () => {
  const api = createMockApi({ live: false });
  const calls: unknown[] = [];
  const inner = api.worktreeCleanup.bind(api);
  api.worktreeCleanup = async (body) => {
    calls.push(body);
    return inner(body);
  };
  renderApp(<ResourcesPage />, { api });
  const button = await waitFor(() => {
    const b = document.querySelector<HTMLButtonElement>('[data-cleanup-button]');
    if (!b || b.disabled) throw new Error('按钮还没好');
    return b;
  });
  fireEvent.click(button);
  const dialog = await screen.findByRole('alertdialog');
  expect(calls).toHaveLength(0);
  fireEvent.click(within(dialog).getByRole('button', { name: '先不' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(calls).toHaveLength(0);
  // 再开、连点两下确定
  fireEvent.click(button);
  const ok = within(await screen.findByRole('alertdialog')).getByRole('button', { name: '清理' });
  fireEvent.click(ok);
  fireEvent.click(ok);
  await waitFor(() => expect(text('[data-resources-repos]')).toContain('清理排队中'));
  expect(calls).toHaveLength(1);
});
