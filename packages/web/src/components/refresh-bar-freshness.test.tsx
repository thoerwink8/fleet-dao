// @vitest-environment happy-dom
// 刷新条的新鲜度（单 #1819，验收修正后全站只有一种样子）：灰字「最后更新」+ 灰色图标按钮；
// 只有异常才多一个「数据已过期」标签（超过页面自己的门槛，或推送断开）；悬停写具体时间。
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { RefreshBar } from './refresh-bar';

afterEach(cleanup);

const MIN = 60_000;

function bar(updatedAgo: number, push?: 'open' | 'down' | 'connecting', staleAfterMs = 5 * MIN) {
  render(
    <RefreshBar
      onRefresh={() => {}}
      isFetching={false}
      dataUpdatedAt={Date.now() - updatedAgo}
      staleAfterMs={staleAfterMs}
      {...(push ? { push } : {})}
    />,
  );
  return document.querySelector('[data-freshness]');
}

test('新鲜度：30 秒前 fresh、3 分钟前 aging、10 分钟前 stale', () => {
  expect(bar(30_000, 'open')?.getAttribute('data-freshness')).toBe('fresh');
  cleanup();
  expect(bar(3 * MIN, 'open')?.getAttribute('data-freshness')).toBe('aging');
  cleanup();
  expect(bar(10 * MIN, 'open')?.getAttribute('data-freshness')).toBe('stale');
});

test('推送断开：直接标数据已过期，哪怕数据刚读到；悬停写推送断开和具体时间', () => {
  const el = bar(10_000, 'down');
  expect(el?.getAttribute('data-freshness')).toBe('stale');
  expect(el?.getAttribute('title')).toContain('推送断开');
  expect(el?.getAttribute('title')).toMatch(/最后更新 \d{2}:\d{2}:\d{2}/);
  expect(screen.getByText('数据已过期')).toBeTruthy();
});

test('颜色只给异常：新鲜或只是有点旧时没有标签，只有灰字；过期才出标签', () => {
  bar(30_000, 'open');
  expect(screen.queryByText('数据已过期')).toBeNull();
  expect(screen.getByText(/最后更新/)).toBeTruthy();
  cleanup();
  bar(3 * MIN, 'open');
  expect(screen.queryByText('数据已过期')).toBeNull();
  cleanup();
  bar(10 * MIN, 'open');
  expect(screen.getByText('数据已过期').closest('[data-status]')?.getAttribute('data-status')).toBe(
    'machine:refresh:stale',
  );
});

test('全站同一种：灰色图标按钮（没有文字、有提示），不分页面', () => {
  const onRefresh = vi.fn();
  render(
    <RefreshBar onRefresh={onRefresh} isFetching={false} dataUpdatedAt={Date.now()} staleAfterMs={5 * MIN} />,
  );
  const button = screen.getByRole('button', { name: '刷新' });
  expect(button.textContent).toBe('');
  expect(button.getAttribute('title')).toBe('刷新');
  fireEvent.click(button);
  expect(onRefresh).toHaveBeenCalledTimes(1);
});

test('从没读到过：写还没读到过，不写刚刚，也不装成新鲜', () => {
  render(<RefreshBar onRefresh={() => {}} isFetching={false} dataUpdatedAt={0} staleAfterMs={5 * MIN} />);
  expect(document.querySelector('[data-freshness]')?.getAttribute('data-freshness')).toBe('stale');
  expect(screen.queryByText('刚刚')).toBeNull();
  expect(screen.getByText('还没读到过')).toBeTruthy();
});
