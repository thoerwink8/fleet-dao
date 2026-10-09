// @vitest-environment happy-dom
// 数据页共用的刷新条：刷新中、刚更新、过期；从没读成过（dataUpdatedAt 为 0）放最后。
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { RefreshBar } from './refresh-bar';

afterEach(cleanup);

const MIN = 60_000;

test('刷新中：按钮禁用并转圈，点了也不再读', () => {
  const onRefresh = vi.fn();
  render(
    <RefreshBar
      onRefresh={onRefresh}
      isFetching
      dataUpdatedAt={Date.now() - 2 * MIN}
      staleAfterMs={10 * MIN}
    />,
  );
  const button = screen.getByRole('button', { name: '刷新' });
  expect(button.getAttribute('aria-disabled')).toBe('true');
  expect(button.hasAttribute('disabled')).toBe(false);
  expect(button.querySelector('.animate-spin')).toBeTruthy();
  fireEvent.click(button);
  expect(onRefresh).not.toHaveBeenCalled();
});

test('读取中用 aria-disabled 留住焦点，没在读时点击才刷新', () => {
  const onRefresh = vi.fn();
  const { rerender } = render(
    <RefreshBar
      onRefresh={onRefresh}
      isFetching
      dataUpdatedAt={Date.now() - 2 * MIN}
      staleAfterMs={10 * MIN}
    />,
  );
  const button = screen.getByRole('button', { name: '刷新' });
  expect(button.getAttribute('aria-disabled')).toBe('true');
  expect(button.hasAttribute('disabled')).toBe(false);
  button.focus();
  fireEvent.click(button);
  expect(onRefresh).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(button);

  rerender(
    <RefreshBar
      onRefresh={onRefresh}
      isFetching={false}
      dataUpdatedAt={Date.now() - 2 * MIN}
      staleAfterMs={10 * MIN}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  expect(onRefresh).toHaveBeenCalledTimes(1);
});

test('最后更新包在 status 里，读完能按这个角色找到', () => {
  render(
    <RefreshBar onRefresh={() => {}} isFetching={false} dataUpdatedAt={Date.now()} staleAfterMs={10 * MIN} />,
  );
  expect(screen.getByRole('status').textContent).toContain('最后更新');
});

test('刚更新：显示最后更新刚刚，没有过期标记，点击调用 onRefresh', () => {
  const onRefresh = vi.fn();
  render(
    <RefreshBar
      onRefresh={onRefresh}
      isFetching={false}
      dataUpdatedAt={Date.now()}
      staleAfterMs={10 * MIN}
    />,
  );
  expect(screen.getByText(/最后更新/).textContent).toContain('刚刚');
  expect(screen.queryByText('数据已过期')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  expect(onRefresh).toHaveBeenCalledTimes(1);
});

test('过期：显示最后更新多少分钟前，并出现数据已过期', () => {
  render(
    <RefreshBar
      onRefresh={() => {}}
      isFetching={false}
      dataUpdatedAt={Date.now() - 10 * MIN}
      staleAfterMs={5 * MIN}
    />,
  );
  expect(screen.getByText(/最后更新/).textContent).toContain('10 分钟前');
  expect(screen.getByText('数据已过期')).toBeTruthy();
});

test('读数时刻比页内时钟略新：仍显示刚刚，不写成秒后', () => {
  render(
    <RefreshBar
      onRefresh={() => {}}
      isFetching={false}
      dataUpdatedAt={Date.now() + 2000}
      staleAfterMs={10 * MIN}
    />,
  );
  expect(screen.getByText(/最后更新/).textContent).toContain('刚刚');
  expect(screen.queryByText(/秒后/)).toBeNull();
});

test('【故意造出的坏输入】dataUpdatedAt 为 0：显示还没读到过，不显示刚刚', () => {
  render(<RefreshBar onRefresh={() => {}} isFetching={false} dataUpdatedAt={0} staleAfterMs={5 * MIN} />);
  expect(screen.getByText('还没读到过')).toBeTruthy();
  expect(screen.queryByText('刚刚')).toBeNull();
  expect(screen.queryByText('数据已过期')).toBeNull();
});
