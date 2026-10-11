// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SearchInput } from './search-input';

afterEach(cleanup);

describe('SearchInput', () => {
  test('带放大镜图标；打字把字符串交给 onChange；名字默认取占位字', () => {
    const onChange = vi.fn();
    const { container } = render(<SearchInput value="" onChange={onChange} placeholder="搜任务" />);
    expect(container.querySelector('svg')).not.toBeNull();
    const input = screen.getByRole('searchbox', { name: '搜任务' });
    fireEvent.change(input, { target: { value: 'abc' } });
    expect(onChange).toHaveBeenCalledWith('abc');
  });

  test('手机 16px：输入框字号走 ui/input 的 max-md 档（防 iOS 放大），手机高度不低于 40', () => {
    render(<SearchInput value="" onChange={() => {}} placeholder="搜" />);
    const cls = screen.getByRole('searchbox').className;
    expect(cls).toContain('text-heading');
    expect(cls).toContain('md:text-body');
    expect(cls).toContain('max-md:min-h-10');
  });
});
