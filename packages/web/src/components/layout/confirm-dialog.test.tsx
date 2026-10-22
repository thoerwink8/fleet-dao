// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ConfirmDialog } from './confirm-dialog';

afterEach(cleanup);

describe('ConfirmDialog', () => {
  test('打开时有标题、说明、确定和先不', () => {
    render(<ConfirmDialog open title="发布到法国？" description="发布后不能撤回" onConfirm={() => {}} />);
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(screen.getByText('发布到法国？')).toBeTruthy();
    expect(screen.getByText('发布后不能撤回')).toBeTruthy();
    expect(screen.getByRole('button', { name: '确定' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '先不' })).toBeTruthy();
  });

  test('成功：调 onConfirm，等它完，再通知关', async () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn(async () => {});
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="t"
        confirmText="确认发布"
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '确认发布' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  test('忙态：等的时候确定键 aria-busy，「先不」点了不关', async () => {
    let done: () => void = () => {};
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="t"
        onConfirm={() => new Promise<void>((r) => (done = r))}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '确定' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '确定' }).getAttribute('aria-busy')).toBe('true'),
    );
    fireEvent.click(screen.getByRole('button', { name: '先不' }));
    expect(onOpenChange).not.toHaveBeenCalled();
    done();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  test('失败：不关，页脚上面红字写原因，确定键恢复能再点', async () => {
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="t"
        onConfirm={async () => {
          throw new Error('主线头已经变了');
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '确定' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('主线头已经变了');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole('button', { name: '确定' }).getAttribute('aria-busy')).toBeNull();
  });

  test('同步的 onConfirm 也行', async () => {
    const onOpenChange = vi.fn();
    render(<ConfirmDialog open onOpenChange={onOpenChange} title="t" onConfirm={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '确定' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  test('trigger：点它才打开', async () => {
    render(
      <ConfirmDialog trigger={<button type="button">删除</button>} title="删掉它？" onConfirm={() => {}} />,
    );
    expect(screen.queryByText('删掉它？')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(await screen.findByText('删掉它？')).toBeTruthy();
  });

  test('children 摆在说明下面（原因输入框这类）；confirmDisabled 时确定键点不了', () => {
    const onConfirm = vi.fn(async () => {});
    render(
      <ConfirmDialog open title="改成全程？" confirmDisabled onConfirm={onConfirm}>
        <input aria-label="原因" />
      </ConfirmDialog>,
    );
    expect(screen.getByLabelText('原因')).toBeTruthy();
    const ok = screen.getByRole('button', { name: '确定' }) as HTMLButtonElement;
    expect(ok.disabled).toBe(true);
    fireEvent.click(ok);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
