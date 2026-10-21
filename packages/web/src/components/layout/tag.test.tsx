// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { Tag } from './tag';
import { LAYOUT_TONES } from './tone';

afterEach(cleanup);

describe('Tag', () => {
  test('默认中性，渲染 data-tone=neutral', () => {
    render(<Tag>套餐内</Tag>);
    expect(screen.getByText('套餐内').dataset.tone).toBe('neutral');
  });

  test.each(['brand', ...LAYOUT_TONES] as const)('tone=%s 渲染 data-tone', (tone) => {
    render(<Tag tone={tone}>标签</Tag>);
    expect(screen.getByText('标签').dataset.tone).toBe(tone);
  });

  test('颜色只给异常（#3509）：只有灰、橙、红三种外观，蓝绿和别的状态一律回灰', () => {
    const looks = {
      neutral: 'default',
      brand: 'default',
      run: 'default',
      done: 'default',
      wait: 'default',
      human: 'default',
      stop: 'default',
      stall: 'warning',
      doubt: 'warning',
      fail: 'error',
      default: 'default',
      warning: 'warning',
      error: 'error',
    } as const;
    for (const [tone, look] of Object.entries(looks)) {
      render(<Tag tone={tone as keyof typeof looks}>{tone}</Tag>);
      const el = screen.getByText(tone);
      expect(el.dataset.look).toBe(look);
      const bg = { default: 'bg-fill-2', warning: 'bg-warn-1', error: 'bg-fail-1' }[look];
      expect(el.className).toContain(bg);
      cleanup();
    }
  });

  test('mono 用等宽字体', () => {
    render(<Tag mono>a1b2c3d</Tag>);
    expect(screen.getByText('a1b2c3d').className).toContain('font-mono');
  });
});
