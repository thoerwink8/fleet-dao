// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { RowItem, WindowBox, WindowList } from './windowed';

afterEach(cleanup);

describe('WindowBox / WindowList / RowItem', () => {
  test('定高容器：高度、data-windowed；滚动把 scrollTop 交出来', () => {
    const onScrollTop = vi.fn();
    const { container } = render(
      <WindowBox height={120} windowed onScrollTop={onScrollTop}>
        <WindowList ariaLabel="模型" total={480}>
          <RowItem top={48} height={48} posinset={2} setsize={10} attrs={{ 'data-model': 'm1' }}>
            行
          </RowItem>
        </WindowList>
      </WindowBox>,
    );
    const box = container.firstElementChild as HTMLElement;
    expect(box.style.height).toBe('120px');
    expect(box.getAttribute('data-windowed')).toBe('true');
    fireEvent.scroll(box, { target: { scrollTop: 96 } });
    expect(onScrollTop).toHaveBeenCalledWith(96);
    expect(screen.getByRole('list', { name: '模型' }).style.height).toBe('480px');
    const row = screen.getByRole('listitem');
    expect(row.style.top).toBe('48px');
    expect(row.style.height).toBe('48px');
    expect(row.getAttribute('data-model')).toBe('m1');
    expect(row.getAttribute('aria-posinset')).toBe('2');
  });

  test('flow：不设内部滚动，也没有 inline 高度', () => {
    const { container } = render(
      <WindowBox flow>
        <WindowList ariaLabel="目录">
          <RowItem height={56}>行</RowItem>
        </WindowList>
      </WindowBox>,
    );
    expect((container.firstElementChild as HTMLElement).style.height).toBe('');
    expect(screen.getByRole('listitem').style.height).toBe('56px');
  });

  test('选中行标 data-selected；拖动落点标 data-drop', () => {
    render(
      <WindowList ariaLabel="x">
        <RowItem selected edge="before">
          a
        </RowItem>
        <RowItem>b</RowItem>
      </WindowList>,
    );
    const [a, b] = screen.getAllByRole('listitem');
    expect(a?.getAttribute('data-selected')).toBe('true');
    expect(a?.getAttribute('data-drop')).toBe('before');
    expect(b?.getAttribute('data-selected')).toBeNull();
  });

  test('pending 标在列表上', () => {
    render(
      <WindowList ariaLabel="x" as="ol" pending>
        <RowItem>a</RowItem>
      </WindowList>,
    );
    expect(screen.getByRole('list').getAttribute('data-pending')).toBe('true');
  });
});
