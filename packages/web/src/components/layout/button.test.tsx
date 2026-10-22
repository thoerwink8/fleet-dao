// @vitest-environment happy-dom
// 按钮：五种样子、链接、置灰说明原因、写请求的忙态。
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, test, vi } from 'vitest';
import { Button } from './button';

afterEach(cleanup);

test('默认是灰底次按钮；primary、text 照传', () => {
  render(
    <>
      <Button>默认</Button>
      <Button variant="primary">主</Button>
      <Button variant="text" size="xs">
        文字
      </Button>
    </>,
  );
  expect(screen.getByRole('button', { name: '默认' }).getAttribute('data-variant')).toBe('secondary');
  expect(screen.getByRole('button', { name: '主' }).getAttribute('data-variant')).toBe('primary');
  expect(screen.getByRole('button', { name: '文字' }).getAttribute('data-size')).toBe('xs');
});

test('点一下调 onClick', () => {
  const onClick = vi.fn();
  render(<Button onClick={onClick}>去</Button>);
  fireEvent.click(screen.getByRole('button', { name: '去' }));
  expect(onClick).toHaveBeenCalledTimes(1);
});

test('给 href 是站内链接，external 开新窗口', () => {
  render(
    <MemoryRouter>
      <Button href="/tasks">全部任务</Button>
      <Button href="https://example.com/pr/1" external>
        去看
      </Button>
    </MemoryRouter>,
  );
  expect(screen.getByRole('link', { name: '全部任务' }).getAttribute('href')).toBe('/tasks');
  const out = screen.getByRole('link', { name: '去看' });
  expect(out.getAttribute('target')).toBe('_blank');
  expect(out.getAttribute('rel')).toContain('noreferrer');
});

test('disabledReason：置灰、悬停写原因、点了不触发；链接也不再是链接', () => {
  const onClick = vi.fn();
  render(
    <MemoryRouter>
      <Button disabledReason="要去备用环境那台上答" onClick={onClick}>
        去答
      </Button>
      <Button href="/x" disabledReason="只读">
        去看
      </Button>
    </MemoryRouter>,
  );
  const button = screen.getByRole('button', { name: '去答' });
  expect(button.getAttribute('aria-disabled')).toBe('true');
  expect(button.getAttribute('title')).toBe('要去备用环境那台上答');
  fireEvent.click(button);
  expect(onClick).not.toHaveBeenCalled();
  expect(screen.queryByRole('link', { name: '去看' })).toBeNull();
  expect(screen.getByRole('button', { name: '去看' }).getAttribute('aria-disabled')).toBe('true');
});

test('native：后端地址用普通链接本窗口打开；block 撑满一行', () => {
  render(
    <MemoryRouter>
      <Button href="/api/auth/feishu/login?next=%2F" native block>
        用飞书登录
      </Button>
    </MemoryRouter>,
  );
  const link = screen.getByRole('link', { name: '用飞书登录' });
  expect(link.getAttribute('href')).toBe('/api/auth/feishu/login?next=%2F');
  expect(link.getAttribute('target')).toBeNull();
  expect(link.className).toContain('w-full');
});

test('loading：忙时转圈并拦点击', () => {
  const onClick = vi.fn();
  render(
    <Button loading onClick={onClick}>
      发布
    </Button>,
  );
  const button = screen.getByRole('button', { name: '发布' });
  expect(button.getAttribute('aria-busy')).toBe('true');
  fireEvent.click(button);
  expect(onClick).not.toHaveBeenCalled();
});
