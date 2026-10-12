// @vitest-environment happy-dom
// 根字号倍数（#1937）：JS 里按像素算的尺寸乘它，才和 rem 写的 CSS 对得上。
import { afterEach, describe, expect, test } from 'vitest';
import { readRootScale, scaledPx } from './root-scale.ts';

describe('根字号倍数', () => {
  afterEach(() => {
    document.documentElement.style.fontSize = '';
  });

  test('读 <html> 实际字号 ÷ 16：桌面放大到 20px 时是 1.25', () => {
    document.documentElement.style.fontSize = '20px';
    expect(readRootScale()).toBe(1.25);
  });
  test('16px（手机、没放大）是 1', () => {
    document.documentElement.style.fontSize = '16px';
    expect(readRootScale()).toBe(1);
  });
  test('设计值换算后取整：48 → 60、440 → 550、44 → 55', () => {
    expect([48, 440, 44].map((n) => scaledPx(n, 1.25))).toEqual([60, 550, 55]);
    expect(scaledPx(56, 1)).toBe(56);
  });
});
