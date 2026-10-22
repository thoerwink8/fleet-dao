// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Drawer } from './drawer';

afterEach(cleanup);

describe('Drawer', () => {
  test('打开时有标题、说明、内容、底部操作', () => {
    render(
      <Drawer open title="任务详情" description="只读" footer={<span>底部操作</span>}>
        <p>里面的内容</p>
      </Drawer>,
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('任务详情')).toBeTruthy();
    expect(screen.getByText('只读')).toBeTruthy();
    expect(screen.getByText('里面的内容')).toBeTruthy();
    expect(screen.getByText('底部操作')).toBeTruthy();
  });

  test('关着的时候什么都不画', () => {
    render(
      <Drawer open={false} title="任务详情">
        x
      </Drawer>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test.each([
    ['sm', 'sm:w-90'],
    ['md', 'sm:w-120'],
    ['lg', 'sm:w-160'],
  ] as const)('width=%s 对 %s，窄屏铺满', (width, cls) => {
    render(
      <Drawer open title="t" width={width}>
        x
      </Drawer>,
    );
    const el = screen.getByRole('dialog');
    expect(el.dataset.width).toBe(width);
    expect(el.className).toContain(cls);
    expect(el.className).toContain('w-full');
    cleanup();
  });

  test('关闭键调 onOpenChange(false)', () => {
    const onOpenChange = vi.fn();
    render(
      <Drawer open onOpenChange={onOpenChange} title="t">
        x
      </Drawer>,
    );
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('side="bottom" 从底部上来，data 标记写在抽屉本体上（手机看详情）', () => {
    render(
      <Drawer open side="bottom" data={{ 'data-channel-drawer': '' }} title="t">
        x
      </Drawer>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.hasAttribute('data-channel-drawer')).toBe(true);
    expect(dialog.className).toContain('inset-x-0');
  });

  test('trigger 打开', async () => {
    render(
      <Drawer trigger={<button type="button">看详情</button>} title="详情">
        内容
      </Drawer>,
    );
    fireEvent.click(screen.getByRole('button', { name: '看详情' }));
    expect(await screen.findByText('内容')).toBeTruthy();
  });
});
