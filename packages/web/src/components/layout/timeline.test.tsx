// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { Timeline } from './timeline';

afterEach(cleanup);

describe('Timeline', () => {
  test('一项一个点，点按 status 上色；标题、时间、说明都在', () => {
    const { container } = render(
      <Timeline
        items={[
          { title: '已合并', time: '10:42', description: '#3504', status: 'success' },
          { title: '验收中', time: '10:30', status: 'processing' },
          { title: '开单', time: '09:58' },
        ]}
      />,
    );
    expect(Array.from(container.querySelectorAll('li')).map((li) => li.dataset.status)).toEqual([
      'success',
      'processing',
      'default',
    ]);
    expect(container.querySelectorAll('[data-level]')).toHaveLength(3);
    expect(screen.getByText('已合并')).toBeTruthy();
    expect(screen.getByText('10:42')).toBeTruthy();
    expect(screen.getByText('#3504')).toBeTruthy();
  });

  test('连线只在项之间：最后一项下面没有线', () => {
    const { container } = render(<Timeline items={[{ title: 'a' }, { title: 'b' }, { title: 'c' }]} />);
    expect(container.querySelectorAll('li > span:first-child > span.bg-line')).toHaveLength(2);
  });
});
