// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Form, FormItem } from './form';

afterEach(cleanup);

describe('Form / FormItem', () => {
  test('提交时 preventDefault 并调 onSubmit', () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <Form onSubmit={onSubmit} aria-label="设置">
        <button type="submit">存</button>
      </Form>,
    );
    const ev = new Event('submit', { bubbles: true, cancelable: true });
    container.querySelector('form')?.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test('标签点一下聚焦控件（htmlFor）；必填前面有红星（读屏不读）', () => {
    render(
      <FormItem label="名字" required htmlFor="n">
        <input id="n" />
      </FormItem>,
    );
    expect(screen.getByLabelText(/名字/)).toBe(document.getElementById('n'));
    const star = screen.getByText('*');
    expect(star.getAttribute('aria-hidden')).toBe('true');
    expect(star.className).toContain('text-fail-ink');
  });

  test('help 是灰字；有 error 就换成红字 role=alert，不再显示 help', () => {
    const { rerender } = render(
      <FormItem label="x" help="显示在列表里">
        <input />
      </FormItem>,
    );
    expect(screen.getByText('显示在列表里').className).toContain('text-ink-3');
    rerender(
      <FormItem label="x" help="显示在列表里" error="不能为空">
        <input />
      </FormItem>,
    );
    expect(screen.getByRole('alert').textContent).toBe('不能为空');
    expect(screen.queryByText('显示在列表里')).toBeNull();
  });

  test('layout：horizontal 窄屏以上标签在左占 160；vertical 标签永远在上', () => {
    const { container, rerender } = render(
      <FormItem label="x">
        <input />
      </FormItem>,
    );
    const root = () => container.firstElementChild as HTMLElement;
    expect(root().dataset.layout).toBe('horizontal');
    expect(root().className).toContain('md:flex-row');
    expect(container.querySelector('label')?.className).toContain('md:w-40');
    rerender(
      <FormItem label="x" layout="vertical">
        <input />
      </FormItem>,
    );
    expect(root().className).not.toContain('md:flex-row');
    expect(container.querySelector('label')?.className).not.toContain('md:w-40');
  });
});
