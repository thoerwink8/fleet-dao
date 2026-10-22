// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { Select } from './select';

afterEach(cleanup);

describe('Select', () => {
  test('触发器是 combobox，带名字，显示选中项的字', () => {
    render(
      <Select
        value="high"
        onValueChange={() => {}}
        aria-label="思考档位"
        options={[
          { value: 'default', label: '默认' },
          { value: 'high', label: 'high', numeric: true },
        ]}
      />,
    );
    expect(screen.getByRole('combobox', { name: '思考档位' }).textContent).toBe('high');
  });

  test('disabled 时触发器置灰', () => {
    render(
      <Select
        value="a"
        onValueChange={() => {}}
        disabled
        aria-label="锁住"
        options={[{ value: 'a', label: 'A' }]}
      />,
    );
    expect((screen.getByRole('combobox', { name: '锁住' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
