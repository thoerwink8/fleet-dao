// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { KeyValue } from './key-value';
import { LAYOUT_TONES } from './tone';

afterEach(cleanup);

describe('KeyValue', () => {
  test('每一项是 dt/dd 一对；mono 的值包成 code；hint 写在值下面', () => {
    const { container } = render(
      <KeyValue
        items={[
          { label: '周期', value: '每 15 分钟' },
          { label: '编号', value: 'job-1', mono: true },
          { label: '结果', value: '失败', hint: '连不上' },
        ]}
      />,
    );
    expect(container.querySelectorAll('dt')).toHaveLength(3);
    expect(container.querySelectorAll('dd')).toHaveLength(3);
    expect(screen.getByText('job-1').tagName).toBe('CODE');
    expect(screen.getByText('连不上')).toBeTruthy();
  });

  test.each(LAYOUT_TONES)('tone=%s 渲染在那一项的 data-tone 上', (tone) => {
    const { container } = render(<KeyValue items={[{ label: 'a', value: 'b', tone }]} />);
    expect(container.querySelector('[data-tone]')?.getAttribute('data-tone')).toBe(tone);
    cleanup();
  });

  test('layout=rows 与 grid 分开标注，grid 按 cols 排', () => {
    const rows = render(<KeyValue items={[{ label: 'a', value: 'b' }]} />);
    expect(rows.container.querySelector('dl')?.dataset.layout).toBe('rows');
    rows.unmount();
    const grid = render(<KeyValue layout="grid" cols={4} items={[{ label: 'a', value: 'b' }]} />);
    const dl = grid.container.querySelector('dl') as HTMLElement;
    expect(dl.dataset.layout).toBe('grid');
    expect(dl.className).toContain('md:grid-cols-4');
  });
});
