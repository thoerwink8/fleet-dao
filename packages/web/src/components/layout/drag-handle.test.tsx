// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DragHandle } from './drag-handle';

afterEach(cleanup);

const props = {
  label: '拖动 X',
  title: '拖到新位置',
  draggable: true,
  disabled: false,
  busy: false,
  onDragStart: () => {},
  onDragEnd: () => {},
  onKeyDown: () => {},
};

describe('DragHandle', () => {
  test('平时藏着、悬停这一行才露出；可拖；键盘事件交给调用方', () => {
    const onKeyDown = vi.fn();
    render(<DragHandle {...props} onKeyDown={onKeyDown} />);
    const grip = screen.getByRole('button', { name: '拖动 X' });
    expect(grip.getAttribute('draggable')).toBe('true');
    expect(grip.className).toContain('pointer-fine:opacity-0');
    expect(grip.className).toContain('pointer-fine:group-hover/row:opacity-100');
    fireEvent.keyDown(grip, { key: 'ArrowUp', altKey: true });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });

  test('busy 只标 aria-disabled，不置灰；disabled 才置灰', () => {
    const { rerender } = render(<DragHandle {...props} busy />);
    const grip = screen.getByRole('button', { name: '拖动 X' }) as HTMLButtonElement;
    expect(grip.getAttribute('aria-disabled')).toBe('true');
    expect(grip.disabled).toBe(false);
    rerender(<DragHandle {...props} disabled draggable={false} />);
    expect((screen.getByRole('button', { name: '拖动 X' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
