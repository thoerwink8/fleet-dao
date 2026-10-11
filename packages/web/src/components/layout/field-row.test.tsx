// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { FieldGroup, FieldRow } from './field-row';

afterEach(cleanup);

describe('FieldRow', () => {
  test('标签绑到控件；hint 在控件下面；error 带 role=alert', () => {
    render(
      <FieldGroup>
        <FieldRow label="名字" htmlFor="n" hint="显示在列表里" error="不能为空">
          <input id="n" />
        </FieldRow>
      </FieldGroup>,
    );
    expect(screen.getByLabelText('名字').id).toBe('n');
    expect(screen.getByText('显示在列表里')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('不能为空');
  });

  test('没给 onSubmit 是 div；给了就是 form，提交时调用', () => {
    const { container, rerender } = render(
      <FieldRow label="a">
        <span>x</span>
      </FieldRow>,
    );
    expect(container.querySelector('form')).toBeNull();
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    rerender(
      <FieldRow label="a" onSubmit={onSubmit} formLabel="保存名字">
        <button type="submit">保存</button>
      </FieldRow>,
    );
    fireEvent.submit(screen.getByRole('form', { name: '保存名字' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
