// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TextArea } from './text-area';

afterEach(cleanup);

describe('TextArea', () => {
  test('受控：打字把字符串交给 onChange；占位字和名字照给', () => {
    const onChange = vi.fn();
    render(<TextArea value="" onChange={onChange} placeholder="写一句为什么改" aria-label="原因" />);
    const box = screen.getByRole('textbox', { name: '原因' });
    expect(box.getAttribute('placeholder')).toBe('写一句为什么改');
    fireEvent.change(box, { target: { value: '试一下' } });
    expect(onChange).toHaveBeenCalledWith('试一下');
  });

  test('默认三行，可限长', () => {
    render(<TextArea value="" onChange={() => {}} maxLength={500} aria-label="原因" />);
    const box = screen.getByRole('textbox', { name: '原因' }) as HTMLTextAreaElement;
    expect(box.getAttribute('rows')).toBe('3');
    expect(box.maxLength).toBe(500);
  });
});
