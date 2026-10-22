// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, test } from 'vitest';
import { TextLink } from './link';

afterEach(cleanup);

describe('TextLink', () => {
  test('站内走路由：href 是站内路径', () => {
    render(
      <MemoryRouter>
        <TextLink to="/intake">到「提需求」写一句</TextLink>
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: '到「提需求」写一句' }).getAttribute('href')).toBe('/intake');
  });

  test('站外开新窗口并带 noreferrer', () => {
    render(
      <MemoryRouter>
        <TextLink href="https://example.com/x">PR #1</TextLink>
      </MemoryRouter>,
    );
    const a = screen.getByRole('link', { name: 'PR #1' });
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noreferrer');
  });
});
