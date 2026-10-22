// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TextInput } from './text-input';

afterEach(cleanup);

describe('TextInput', () => {
  test('打字把字符串交给 onChange；占位字、名字照传', () => {
    const onChange = vi.fn();
    render(<TextInput value="" onChange={onChange} placeholder="例如 x" aria-label="模型串" />);
    const input = screen.getByRole('textbox', { name: '模型串' });
    expect(input.getAttribute('placeholder')).toBe('例如 x');
    fireEvent.change(input, { target: { value: 'abc' } });
    expect(onChange).toHaveBeenCalledWith('abc');
  });

  test('disabled 时输入框置灰', () => {
    render(<TextInput value="" onChange={() => {}} disabled aria-label="锁住" />);
    expect((screen.getByRole('textbox', { name: '锁住' }) as HTMLInputElement).disabled).toBe(true);
  });
});
