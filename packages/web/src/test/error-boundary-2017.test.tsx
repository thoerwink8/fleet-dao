// @vitest-environment happy-dom
// 顶层出错页（#2017）：主文案说人话、说能做什么；原始报错只在折叠的「详情」里。
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, expect, test } from 'vitest';
import { ErrorBoundary } from '../root';

afterEach(cleanup);

function renderWithError(error: unknown) {
  const router = createMemoryRouter([
    {
      path: '/',
      loader: () => {
        throw error;
      },
      element: <div />,
      ErrorBoundary,
    },
  ]);
  render(<RouterProvider router={router} />);
}

test('【故意造出的失败】页面抛了原始错误：主文案不含原始错误文本，详情里才有', async () => {
  const raw = "TypeError: Cannot read properties of undefined (reading 'foo')";
  renderWithError(new TypeError(raw));
  const hint = await screen.findByText(/没能画出来/);
  expect(hint.textContent).not.toContain('Cannot read');
  const main = document.querySelector('main') as HTMLElement;
  const detail = main.querySelector('[data-error-detail]') as HTMLDetailsElement;
  expect(detail).not.toBeNull();
  expect(detail.open).toBe(false);
  expect(detail.textContent).toContain(raw);
  // 详情以外的整页文字里没有原始报错
  const outside = [...(main.childNodes[0]?.childNodes ?? [])]
    .filter((n) => n !== detail)
    .map((n) => n.textContent)
    .join('');
  expect(outside).not.toContain('Cannot read');
  expect(screen.getByRole('link', { name: '回到看板' })).toBeTruthy();
});

test('404：写「没有这个页面」，不把 404 Not Found 当标题', async () => {
  renderWithError(new Response('nope', { status: 404, statusText: 'Not Found' }));
  expect(await screen.findByRole('heading', { name: '没有这个页面' })).toBeTruthy();
});
