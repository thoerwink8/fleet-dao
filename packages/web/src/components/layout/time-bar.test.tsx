// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TimeBar } from './time-bar';

afterEach(cleanup);

describe('TimeBar', () => {
  const items = [
    { id: 'a', weight: 5, label: '动手第 1 次，用时 5 分', state: 'fail' as const },
    { id: 'b', weight: 1, label: '验收第 1 次，用时 1 分' },
    { id: 'c', weight: 2, label: '动手第 2 次，用时 2 分', state: 'run' as const },
  ];

  test('一段一个按钮，名字是读屏的话，状态落在 data-state，宽度按权重', () => {
    render(<TimeBar items={items} label="每一笔各占多久" onPick={() => {}} />);
    expect(screen.getByRole('list', { name: '每一笔各占多久' })).toBeTruthy();
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('data-state'))).toEqual([
      'fail',
      'idle',
      'run',
    ]);
    const li = screen.getByRole('button', { name: '动手第 1 次，用时 5 分' }).closest('li') as HTMLElement;
    expect(li.style.flex).toMatch(/^5 1 0/);
  });

  test('点一段回调它的 id', () => {
    const onPick = vi.fn();
    render(<TimeBar items={items} label="x" onPick={onPick} />);
    fireEvent.click(screen.getByRole('button', { name: '验收第 1 次，用时 1 分' }));
    expect(onPick).toHaveBeenCalledWith('b');
  });
});
