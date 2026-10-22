// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Input, Label, Textarea } from './input';

afterEach(cleanup);

describe('Input / Textarea / Label', () => {
  test('Label 绑到输入框；输入把事件交给 onChange', () => {
    const onChange = vi.fn();
    render(
      <>
        <Label htmlFor="n">名字</Label>
        <Input id="n" value="" onChange={onChange} />
      </>,
    );
    expect(screen.getByLabelText('名字').id).toBe('n');
    fireEvent.change(screen.getByLabelText('名字'), { target: { value: 'x' } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test('手机 16px、高度不低于 40：沿用 ui/input 的档位；width 档位给定宽', () => {
    render(<Input aria-label="a" width="sm" />);
    const cls = screen.getByLabelText('a').className;
    expect(cls).toContain('text-heading');
    expect(cls).toContain('max-md:min-h-10');
    expect(cls).toContain('w-40');
  });

  test('suffix 画在输入框右边框内，输入框给它留出右边距', () => {
    render(<Input aria-label="p" suffix={<button type="button">眼</button>} />);
    expect(screen.getByLabelText('p').className).toContain('pr-10');
    expect(screen.getByRole('button', { name: '眼' })).toBeTruthy();
  });

  test('Textarea 最少 88 高，透传 aria-invalid、placeholder', () => {
    render(<Textarea aria-label="b" aria-invalid placeholder="写点" />);
    const el = screen.getByLabelText('b');
    expect(el.className).toContain('min-h-22');
    expect(el.getAttribute('aria-invalid')).toBe('true');
    expect(el.getAttribute('placeholder')).toBe('写点');
  });
});
