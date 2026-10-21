// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { NativeSelect } from './native-select';

afterEach(cleanup);

describe('NativeSelect', () => {
  test('包一层原生 select：选项、onChange、aria-label 都照常', () => {
    const onChange = vi.fn();
    render(
      <NativeSelect aria-label="仓" onChange={onChange} defaultValue="a">
        <option value="a">甲</option>
        <option value="b">乙</option>
      </NativeSelect>,
    );
    const sel = screen.getByRole('combobox', { name: '仓' }) as HTMLSelectElement;
    expect(sel.tagName).toBe('SELECT');
    fireEvent.change(sel, { target: { value: 'b' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(sel.value).toBe('b');
  });

  test('样式和 ui/select 对齐：桌面 h-control（标准 32）、手机不低于 40 且 16px', () => {
    render(
      <NativeSelect aria-label="仓">
        <option>甲</option>
      </NativeSelect>,
    );
    const cls = screen.getByRole('combobox').className;
    expect(cls).toContain('h-control');
    expect(cls).toContain('rounded-sm');
    expect(cls).toContain('bg-fill-2');
    expect(cls).toContain('max-md:min-h-10');
    expect(cls).toContain('max-md:text-heading');
  });
});
