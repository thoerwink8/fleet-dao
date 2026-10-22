// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { ListFooter } from './list-footer';

afterEach(cleanup);

describe('ListFooter', () => {
  test('包住底栏内容，带 data-list-footer', () => {
    render(
      <ListFooter>
        <span>已经到底，共 3 张</span>
      </ListFooter>,
    );
    const footer = screen.getByText('已经到底，共 3 张').parentElement;
    expect(footer?.hasAttribute('data-list-footer')).toBe(true);
  });
});
