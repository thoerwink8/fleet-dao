import { describe, expect, test } from 'vitest';
import { contrastRatio, parseColor } from './color-ratio';

describe('color-ratio', () => {
  test('黑白对比度 21，同色 1', () => {
    const black = parseColor('rgb(0, 0, 0)');
    const white = parseColor('#ffffff');
    if (!black || !white) throw new Error('颜色没解析出来');
    expect(contrastRatio(black, white)).toBeCloseTo(21, 5);
    expect(contrastRatio(white, white)).toBeCloseTo(1, 5);
  });

  test('认 color(srgb …) 和带透明度的写法', () => {
    expect(parseColor('color(srgb 1 0.5 0 / 0.5)')).toEqual({ r: 255, g: 127.5, b: 0, a: 0.5 });
    expect(parseColor('rgba(10, 20, 30, 50%)')?.a).toBe(0.5);
  });

  test('半透明前景先叠在底上再算：白字 50% 叠在黑底上比纯白低', () => {
    const black = parseColor('#000000');
    const half = parseColor('rgba(255, 255, 255, 0.5)');
    const full = parseColor('#ffffff');
    if (!black || !half || !full) throw new Error('颜色没解析出来');
    expect(contrastRatio(half, black)).toBeLessThan(contrastRatio(full, black));
  });

  test('认不出的写法返回 undefined，不冒充', () => {
    expect(parseColor('oklab(0.5 0.1 0.1)')).toBeUndefined();
    expect(parseColor('')).toBeUndefined();
  });
});
