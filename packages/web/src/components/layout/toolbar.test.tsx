// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { Toolbar } from './toolbar';

afterEach(cleanup);

describe('Toolbar', () => {
  test('筛选在左、搜索和下拉在右，都渲染；role=toolbar', () => {
    render(<Toolbar start={<span>筛选</span>} end={<span>搜索</span>} />);
    const bar = screen.getByRole('toolbar');
    expect(bar.textContent).toBe('筛选搜索');
    expect(bar.className).toContain('flex-wrap');
  });

  test('只有 start 时不画右边的空容器；sticky 标出来', () => {
    render(<Toolbar start={<span>筛选</span>} sticky />);
    const bar = screen.getByRole('toolbar');
    expect(bar.children).toHaveLength(1);
    expect(bar.dataset.sticky).toBe('true');
  });
});
