// @vitest-environment happy-dom
// 出错提示说人话（#2017）：主文案写发生了什么、能做什么；原始报错收在「详情」里，不摊在主文案上。
import { cleanup } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { createHttpApi } from '../api/http';
import { LoadError } from '../components/layout/load-state';
import { renderApp } from './harness';

const RAW = 'ZZRAW-cannot-read-foo';

afterEach(cleanup);

test('断网：页面主文案不含原始报错，原文在详情里', async () => {
  const fetch = async () => {
    throw new Error(RAW);
  };
  const api = createHttpApi({ fetch });
  const err = await api.repos().catch((e: unknown) => e);
  renderApp(<LoadError error={err} what="仓库列表" />);
  const summary = document.querySelector('[data-error-summary]');
  expect(summary).toBeTruthy();
  expect(summary?.textContent ?? '').not.toContain(RAW);
  expect(summary?.textContent ?? '').toContain('它所在的机器可能在重启或关机');
  expect(document.querySelector('summary')?.textContent).toContain('详情');
  expect(document.querySelector('[data-error-raw]')?.textContent).toContain(RAW);
});

test('返回对不上这一页：主文案不写内部口径，字段原文在详情里', async () => {
  const fetch = async () => new Response(JSON.stringify({ repos: [{ id: 'r' }] }), { status: 200 });
  const api = createHttpApi({ fetch });
  const err = await api.repos().catch((e: unknown) => e);
  renderApp(<LoadError error={err} what="仓库列表" />);
  const summary = document.querySelector('[data-error-summary]');
  expect(summary?.textContent ?? '').not.toContain('shared/web-api.ts');
  expect(summary?.textContent ?? '').not.toContain(RAW);
  expect(summary?.textContent ?? '').toMatch(/刷新/);
  const raw = document.querySelector('[data-error-raw]')?.textContent ?? '';
  expect(raw.length).toBeGreaterThan(0);
  expect(summary?.textContent ?? '').not.toContain(raw);
});
