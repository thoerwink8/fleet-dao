// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { Inbox } from 'lucide-react';
import { afterEach, describe, expect, test } from 'vitest';
import { EmptyState } from './empty-state';

afterEach(cleanup);

describe('EmptyState', () => {
  test('section：图标、标题、提示、操作都在', () => {
    const { container } = render(
      <EmptyState
        icon={Inbox}
        title="没有提醒"
        hint="有事会出现在这里"
        action={<button type="button">去看</button>}
      />,
    );
    expect(container.querySelector('svg')).not.toBeNull();
    expect(screen.getByText('没有提醒')).toBeTruthy();
    expect(screen.getByText('有事会出现在这里')).toBeTruthy();
    expect(screen.getByRole('button', { name: '去看' })).toBeTruthy();
    expect((container.firstElementChild as HTMLElement).dataset.size).toBe('section');
  });

  test('inline：一行字，标 data-size=inline；没传图标就没有图标', () => {
    const { container } = render(<EmptyState size="inline" title="还没有任务" />);
    expect((container.firstElementChild as HTMLElement).dataset.size).toBe('inline');
    expect(container.querySelector('svg')).toBeNull();
    expect(screen.getByText('还没有任务')).toBeTruthy();
  });
});
