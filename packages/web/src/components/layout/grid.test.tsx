// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { Grid } from './grid';

afterEach(cleanup);

describe('Grid', () => {
  test.each([1, 2, 3, 4] as const)('cols=%s 是 grid，窄屏叠起来', (cols) => {
    const { container } = render(
      <Grid cols={cols}>
        <i>a</i>
      </Grid>,
    );
    const el = container.firstElementChild as HTMLElement;
    expect(el.dataset.cols).toBe(String(cols));
    expect(el.className).toContain('grid');
    expect(el.className).toContain(
      cols === 1 ? 'grid-cols-1' : cols === 4 ? 'lg:grid-cols-4' : `lg:grid-cols-${cols}`,
    );
  });

  test('preset=main：主区在左撑满，侧栏在右定宽 360，各包一层', () => {
    const { container } = render(
      <Grid preset="main">
        <p>主</p>
        <p>侧</p>
      </Grid>,
    );
    const [a, b] = Array.from((container.firstElementChild as HTMLElement).children) as HTMLElement[];
    expect(a?.className).toContain('lg:flex-1');
    expect(b?.className).toContain('lg:w-90');
    expect(screen.getByText('主').parentElement).toBe(a);
    expect(screen.getByText('侧').parentElement).toBe(b);
  });

  test('preset=split：列表在左定宽 360，详情在右撑满', () => {
    const { container } = render(
      <Grid preset="split">
        <p>列表</p>
        <p>详情</p>
      </Grid>,
    );
    const [a, b] = Array.from((container.firstElementChild as HTMLElement).children) as HTMLElement[];
    expect(a?.className).toContain('lg:w-90');
    expect(b?.className).toContain('lg:flex-1');
  });
});
