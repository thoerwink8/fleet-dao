// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { Anchor } from './anchor';

afterEach(cleanup);

const items = [
  { id: 'general', label: '通用' },
  { id: 'notify', label: '通知' },
];

describe('Anchor', () => {
  test('每项是 #id 的链接；一开始第一项是当前', () => {
    render(<Anchor items={items} />);
    expect(screen.getByRole('link', { name: '通知' }).getAttribute('href')).toBe('#notify');
    expect(screen.getByRole('link', { name: '通用' }).getAttribute('aria-current')).toBe('location');
    expect(screen.getByRole('link', { name: '通用' }).className).toContain('text-brand-ink');
  });

  test('点哪项哪项变当前', () => {
    render(<Anchor items={items} />);
    fireEvent.click(screen.getByRole('link', { name: '通知' }));
    expect(screen.getByRole('link', { name: '通知' }).getAttribute('aria-current')).toBe('location');
    expect(screen.getByRole('link', { name: '通用' }).getAttribute('aria-current')).toBeNull();
  });
});
