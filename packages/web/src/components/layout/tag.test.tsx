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

  test('mono 用等宽字体', () => {
    render(<Tag mono>a1b2c3d</Tag>);
    expect(screen.getByText('a1b2c3d').className).toContain('font-mono');
  });
});
