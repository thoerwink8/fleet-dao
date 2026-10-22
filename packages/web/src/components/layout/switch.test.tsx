// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Switch } from './switch';

afterEach(cleanup);

describe('Switch', () => {
  test('是 role=switch，点一下把新值交给 onCheckedChange', () => {
    const onCheckedChange = vi.fn();
    render(<Switch checked={false} onCheckedChange={onCheckedChange} aria-label="开着" />);
    const el = screen.getByRole('switch', { name: '开着' });
    expect(el.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(el);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  test('disabled 点不动', () => {
    const onCheckedChange = vi.fn();
    render(<Switch checked disabled onCheckedChange={onCheckedChange} aria-label="x" />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});
