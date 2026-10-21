// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { PickList } from './pick-list';

afterEach(cleanup);

const items = [
  { key: 'a', title: '渠道 A', meta: '近 24 次', status: 'route:live' },
  { key: 'b', title: '渠道 B', status: 'route:fault' },
] as const;

describe('PickList', () => {
  test('标题、说明、状态（字典里的中文）', () => {
    render(<PickList items={items} />);
    expect(screen.getByText('渠道 A')).toBeTruthy();
    expect(screen.getByText('近 24 次')).toBeTruthy();
    expect(screen.getByText('在线')).toBeTruthy();
    expect(screen.getByText('故障')).toBeTruthy();
  });

  test('value 标选中（aria-current + brand-1 底）；点哪行 onChange 哪个 key', () => {
    const onChange = vi.fn();
    render(<PickList items={items} value="b" onChange={onChange} />);
    const b = screen.getByRole('button', { name: /渠道 B/ });
    expect(b.getAttribute('aria-current')).toBe('true');
    expect(b.className).toContain('bg-brand-1');
    expect(screen.getByRole('button', { name: /渠道 A/ }).getAttribute('aria-current')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /渠道 A/ }));
    expect(onChange).toHaveBeenCalledWith('a');
  });
});
