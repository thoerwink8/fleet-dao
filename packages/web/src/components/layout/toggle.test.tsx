// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Toggle } from './toggle';

afterEach(cleanup);

describe('Toggle', () => {
  test('aria-pressed 跟着 pressed；点一下交出相反的值', () => {
    const onChange = vi.fn();
    render(
      <Toggle pressed={false} onPressedChange={onChange}>
        只看已开启
      </Toggle>,
    );
    const btn = screen.getByRole('button', { name: '只看已开启' });
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(btn);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
