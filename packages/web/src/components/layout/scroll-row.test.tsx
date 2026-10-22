// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { ScrollRow } from './scroll-row';

afterEach(cleanup);

describe('ScrollRow', () => {
  test('一行不折、放不下横滑；孩子都画出来', () => {
    const { container } = render(
      <ScrollRow>
        <button type="button">甲</button>
        <button type="button">乙</button>
      </ScrollRow>,
    );
    const row = container.querySelector('[data-scroll-row]') as HTMLElement;
    expect(row.className).toContain('overflow-x-auto');
    expect(row.className).toContain('whitespace-nowrap');
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });
});
