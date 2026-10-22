// @vitest-environment happy-dom
// 陈列页 /_design 的渲染回归：正文里不许露出字面的「null」（#3533：把 null 当文字渲染）。
import { cleanup } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import Design from '../routes/design';
import { renderApp } from './harness';

afterEach(cleanup);

describe('陈列页', () => {
  test('正文文字里没有独立的 null 词', () => {
    const { container } = renderApp(<Design />, { route: '/_design' });
    const text = container.textContent ?? '';
    expect(text.match(/\bnull\b/g)).toBeNull();
  });
});
