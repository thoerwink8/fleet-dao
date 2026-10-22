// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DisclosureIcon, FoldBar, RowButton } from './row-button';

afterEach(cleanup);

describe('RowButton', () => {
  test('点一下触发 onClick；pressed、expanded、名字照传到 aria 上', () => {
    const onClick = vi.fn();
    render(
      <RowButton onClick={onClick} pressed expanded={false} controls="detail" label="查看 X 的路由">
        X
      </RowButton>,
    );
    const btn = screen.getByRole('button', { name: '查看 X 的路由' });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.getAttribute('aria-controls')).toBe('detail');
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test('dim：整块降对比度，标 data-dim', () => {
    render(
      <RowButton onClick={() => {}} dim>
        关着的
      </RowButton>,
    );
    expect(screen.getByRole('button').getAttribute('data-dim')).toBe('true');
    expect(screen.getByRole('button').className).toContain('opacity-60');
  });
});

describe('DisclosureIcon', () => {
  test('data-disclosure 跟着 open', () => {
    const { container, rerender } = render(<DisclosureIcon open={false} />);
    expect(container.querySelector('[data-disclosure]')?.getAttribute('data-disclosure')).toBe('closed');
    rerender(<DisclosureIcon open />);
    expect(container.querySelector('[data-disclosure]')?.getAttribute('data-disclosure')).toBe('open');
  });
});

describe('FoldBar', () => {
  test('折叠条：aria-expanded 跟着 open，点一下 onToggle', () => {
    const onToggle = vi.fn();
    render(
      <FoldBar open={false} onToggle={onToggle} controls="body">
        配不了 3 条
      </FoldBar>,
    );
    const bar = screen.getByRole('button', { name: /配不了 3 条/ });
    expect(bar.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(bar);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
