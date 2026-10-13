// @vitest-environment happy-dom
// 顶层出错页（#2017）：主文案说人话，抛出来的原文只在「详情」里。
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, test } from 'vitest';
import { RouteErrorPage } from '../components/route-error';

const RAW = 'ZZRAW-cannot-read-foo';

afterEach(cleanup);

test('抛错：页面主文案不含原文，原文在详情里', () => {
  render(
    <MemoryRouter>
      <RouteErrorPage error={new Error(RAW)} />
    </MemoryRouter>,
  );
  const summary = document.querySelector('[data-error-summary]');
  expect(summary).toBeTruthy();
  expect(summary?.textContent ?? '').not.toContain(RAW);
  expect(summary?.textContent ?? '').toMatch(/刷新/);
  expect(screen.getByRole('link', { name: '回到看板' })).toBeTruthy();
  expect(document.querySelector('[data-error-raw]')?.textContent).toContain(RAW);
  const main = document.querySelector('main');
  const rawEl = document.querySelector('[data-error-raw]');
  const visible = (main?.textContent ?? '').replace(rawEl?.textContent ?? '', '');
  expect(visible).not.toContain(RAW);
});

test('路由状态错误：主文案只留状态码，状态原文在详情里', () => {
  const error = { status: 404, statusText: RAW, data: 'gone-ZZRAW' };
  render(
    <MemoryRouter>
      <RouteErrorPage error={error} />
    </MemoryRouter>,
  );
  const summary = document.querySelector('[data-error-summary]');
  expect(summary?.textContent ?? '').toContain('404');
  expect(summary?.textContent ?? '').not.toContain(RAW);
  expect(summary?.textContent ?? '').not.toContain('gone-ZZRAW');
  expect(document.querySelector('[data-error-raw]')?.textContent).toContain(RAW);
});
