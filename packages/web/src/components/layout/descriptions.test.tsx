// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { Descriptions } from './descriptions';

afterEach(cleanup);

describe('Descriptions', () => {
  test('每项是 dt/dd 一对；mono 等宽；hint 在值下面', () => {
    const { container } = render(
      <Descriptions
        items={[
          { label: '周期', value: '每 15 分钟' },
          { label: '编号', value: 'job-1', mono: true },
          { label: '结果', value: '失败', hint: '连不上' },
        ]}
      />,
    );
    expect(container.querySelectorAll('dt')).toHaveLength(3);
    expect(container.querySelectorAll('dd')).toHaveLength(3);
    expect(screen.getByText('job-1').className).toContain('font-mono');
    expect(screen.getByText('连不上')).toBeTruthy();
  });

  test.each([1, 2, 3] as const)('columns=%s', (n) => {
    const { container } = render(<Descriptions columns={n} items={[{ label: 'a', value: 'b' }]} />);
    expect((container.firstElementChild as HTMLElement).dataset.columns).toBe(String(n));
    cleanup();
  });

  test('值收 Read：读成了画值；没读到画灰字「没读到」并给原因，不画空白、0、undefined', () => {
    const { container } = render(
      <Descriptions
        items={[
          { label: '内存', value: { ok: true, value: '12 GB' } },
          { label: '磁盘', value: { ok: false, reason: '探针超时' }, mono: true },
        ]}
      />,
    );
    expect(screen.getByText('12 GB')).toBeTruthy();
    const unread = screen.getByText('没读到');
    expect(unread.getAttribute('title')).toBe('探针超时');
    expect(unread.className).toContain('text-ink-3');
    expect(container.textContent).not.toMatch(/undefined|null|\b0\b/);
  });
});
