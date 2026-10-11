// @vitest-environment happy-dom
// 主页顶栏的新鲜度点（单 #1819）：按数据年龄和推送状态换绿 / 黄 / 红，悬停写具体时间；刷新是图标按钮。
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { RefreshBar } from './refresh-bar';

afterEach(cleanup);

const MIN = 60_000;

function dot(updatedAgo: number, push?: 'open' | 'down' | 'connecting') {
  render(
    <RefreshBar
      variant="dot"
      onRefresh={() => {}}
      isFetching={false}
      dataUpdatedAt={Date.now() - updatedAgo}
      staleAfterMs={5 * MIN}
      {...(push ? { push } : {})}
    />,
  );
  return document.querySelector('[data-freshness]');
}

test('新鲜度点：30 秒前绿、3 分钟前黄、10 分钟前红', () => {
  expect(dot(30_000, 'open')?.getAttribute('data-freshness')).toBe('fresh');
  cleanup();
  expect(dot(3 * MIN, 'open')?.getAttribute('data-freshness')).toBe('aging');
  cleanup();
  expect(dot(10 * MIN, 'open')?.getAttribute('data-freshness')).toBe('stale');
});

test('新鲜度点：推送断开直接红，哪怕数据刚读到；悬停写具体时间', () => {
  const el = dot(10_000, 'down');
  expect(el?.getAttribute('data-freshness')).toBe('stale');
  expect(el?.getAttribute('title')).toContain('推送断开');
  expect(el?.getAttribute('title')).toMatch(/最后更新 \d{2}:\d{2}:\d{2}/);
});

test('新鲜度点：颜色类对应绿、黄、红，不再写「最后更新 刚刚」那行小字', () => {
  const el = dot(30_000, 'open');
  expect(el?.querySelector('.bg-st-done')).toBeTruthy();
  expect(screen.queryByText(/最后更新/)).toBeNull();
  cleanup();
  expect(dot(3 * MIN, 'open')?.querySelector('.bg-st-stall')).toBeTruthy();
  cleanup();
  expect(dot(10 * MIN, 'open')?.querySelector('.bg-st-fail')).toBeTruthy();
});

test('新鲜度点：刷新是图标按钮（没有文字），点了调用 onRefresh；从没读到过是红点', () => {
  const onRefresh = vi.fn();
  render(
    <RefreshBar
      variant="dot"
      onRefresh={onRefresh}
      isFetching={false}
      dataUpdatedAt={0}
      staleAfterMs={5 * MIN}
    />,
  );
  expect(document.querySelector('[data-freshness]')?.getAttribute('data-freshness')).toBe('stale');
  const button = screen.getByRole('button', { name: '刷新' });
  expect(button.textContent).toBe('');
  fireEvent.click(button);
  expect(onRefresh).toHaveBeenCalledTimes(1);
});
