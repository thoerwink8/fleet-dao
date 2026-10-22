// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Disclosure, DisclosureRow } from './disclosure';

afterEach(cleanup);

function Demo({ start = false }: { start?: boolean }) {
  const [open, setOpen] = useState(start);
  return (
    <Disclosure open={open} onToggle={() => setOpen(!open)} header="第 1 回合" trailing="超时">
      里面的内容
    </Disclosure>
  );
}

describe('Disclosure', () => {
  test('按钮 aria-expanded 跟着 open；收着不画内容，点一下画出来', () => {
    render(<Demo />);
    const btn = screen.getByRole('button', { name: /第 1 回合/ });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('里面的内容')).toBeNull();
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('里面的内容')).toBeTruthy();
    expect(document.getElementById(btn.getAttribute('aria-controls') as string)).not.toBeNull();
  });

  test('开没开由页面管：onToggle 只通知，不自己改', () => {
    const onToggle = vi.fn();
    render(<DisclosureRow open={false} onToggle={onToggle} header="一行" />);
    fireEvent.click(screen.getByRole('button'));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false');
  });

  test('actions 在按钮外面：点它不触发展开，也不会把按钮套进按钮', () => {
    const onToggle = vi.fn();
    const onAction = vi.fn();
    render(
      <DisclosureRow
        open={false}
        onToggle={onToggle}
        header="第 3 笔"
        actions={
          <button type="button" onClick={onAction}>
            看会话
          </button>
        }
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '看会话' }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '看会话' }).closest('button[aria-expanded]')).toBeNull();
  });

  test('data-* 落在最外层', () => {
    render(<DisclosureRow open={false} onToggle={() => {}} header="x" data-round-header="1" />);
    expect(document.querySelector('[data-round-header="1"]')?.getAttribute('data-open')).toBe('false');
  });
});
