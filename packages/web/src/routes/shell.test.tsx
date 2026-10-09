// @vitest-environment happy-dom
// 外壳最前面的「跳到正文」：第一个 Tab 停在它上面；激活后焦点落到正文区，下一跳才进正文里的控件。
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, test } from 'vitest';
import { createMockApi } from '../api/mock/server';
import { renderApp } from '../test/harness';
import Shell from './shell';

afterEach(cleanup);

function Page() {
  return <button type="button">正文按钮</button>;
}

function renderShell() {
  return renderApp(
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Page />} />
      </Route>
    </Routes>,
    { api: createMockApi({ live: false }) },
  );
}

/** 文档顺序里 Tab 会停住的元素。tabindex 为负、藏起来的、关掉的浮层都不算。 */
function tabStops(): HTMLElement[] {
  const selector = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]',
  ].join(', ');
  return [...document.querySelectorAll<HTMLElement>(selector)].filter((el) => {
    if (el.tabIndex < 0) return false;
    if (el.hasAttribute('disabled')) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    if (el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    return true;
  });
}

/** `from` 之后的下一个 Tab 停点（含它里面的控件）。 */
function tabAfter(from: Element): HTMLElement | undefined {
  return tabStops().find((el) => (from.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
}

async function settled() {
  expect(await screen.findByRole('button', { name: '正文按钮' })).toBeTruthy();
  await waitFor(() => expect(screen.queryByText('正在确认登录…')).toBeNull());
}

describe('跳到正文', () => {
  test('第一个 Tab 停在跳到正文', async () => {
    renderShell();
    await settled();
    const link = screen.getByRole('link', { name: '跳到正文' });
    const main = screen.getByRole('main');
    expect(tabStops()[0]).toBe(link);
    expect((main.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_PRECEDING) !== 0).toBe(true);
    link.focus();
    expect(document.activeElement).toBe(link);
  });

  test('激活后焦点进正文区', async () => {
    renderShell();
    await settled();
    const link = screen.getByRole('link', { name: '跳到正文' });
    const main = screen.getByRole('main');
    expect(main.tabIndex).toBe(-1);
    fireEvent.click(link);
    expect(document.activeElement).toBe(main);
    expect(tabAfter(main)).toBe(screen.getByRole('button', { name: '正文按钮' }));
  });
});
