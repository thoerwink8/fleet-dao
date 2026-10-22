// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, test } from 'vitest';
import { BlockLink } from './block-link';

afterEach(cleanup);

describe('BlockLink', () => {
  test('to：站内链接', () => {
    render(
      <MemoryRouter>
        <BlockLink to="/tasks/t-1" title="标题">
          内容
        </BlockLink>
      </MemoryRouter>,
    );
    const a = screen.getByRole('link');
    expect(a.getAttribute('href')).toBe('/tasks/t-1');
    expect(a.getAttribute('title')).toBe('标题');
  });

  test('href：新窗口，带 noreferrer；aria-label 照传', () => {
    render(
      <BlockLink href="https://example.com/x" label="看单">
        内容
      </BlockLink>,
    );
    const a = screen.getByRole('link', { name: '看单' });
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toContain('noreferrer');
  });

  test('都没给：不是链接', () => {
    render(<BlockLink>内容</BlockLink>);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('内容')).toBeTruthy();
  });
});
