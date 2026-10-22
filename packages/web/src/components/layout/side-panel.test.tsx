// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { PanelResizer, SidePanel } from './side-panel';

afterEach(cleanup);

function panel(props: Partial<React.ComponentProps<typeof SidePanel>> = {}) {
  return (
    <SidePanel
      open
      onOpenChange={() => {}}
      title="过程"
      header={<span>头</span>}
      view="process"
      data-task-panel="sheet"
      {...props}
    >
      <p>正文</p>
    </SidePanel>
  );
}

describe('SidePanel', () => {
  test('是对话框：头、正文、视图名都在，data-* 落在抽屉本体', () => {
    render(panel());
    const dlg = screen.getByRole('dialog');
    expect(dlg.getAttribute('data-task-panel')).toBe('sheet');
    expect(dlg.querySelector('[data-panel-view="process"] header')?.textContent).toBe('头');
    expect(screen.getByText('正文')).toBeTruthy();
  });

  test('桌面宽度是像素变量；手机整屏且不画拉宽条', () => {
    const { rerender } = render(
      panel({
        widthPx: 600,
        resizer: <PanelResizer width={600} label="拉宽" onPointerDown={() => {}} onKeyDown={() => {}} />,
      }),
    );
    const dlg = screen.getByRole('dialog');
    expect(dlg.style.getPropertyValue('--side-panel-w')).toBe('600px');
    expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('600');
    rerender(
      panel({
        phone: true,
        resizer: <PanelResizer width={600} label="拉宽" onPointerDown={() => {}} onKeyDown={() => {}} />,
      }),
    );
    expect(screen.queryByRole('separator')).toBeNull();
  });

  test('有 subheader 才画那一行；scroll=false 时正文区不自己滚', () => {
    const { rerender } = render(panel({ subheader: <span>结局</span> }));
    expect(screen.getByText('结局')).toBeTruthy();
    expect(document.querySelector('[data-panel-body]')?.className).toContain('overflow-y-auto');
    rerender(panel({ scroll: false }));
    expect(screen.queryByText('结局')).toBeNull();
    expect(document.querySelector('[data-panel-body]')?.className).not.toContain('overflow-y-auto');
  });

  test('Esc 通知关闭', () => {
    const onOpenChange = vi.fn();
    render(panel({ onOpenChange }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
