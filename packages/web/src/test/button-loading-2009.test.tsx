// @vitest-environment happy-dom
// 会发写请求的按钮要有忙态（#2009，创始人 2026-10-13「现在驾驶舱缺少确定按钮 loading，所有页面都判断下」）。
// 做法照 Primer 按钮无障碍规范：忙时不拿掉也不用原生 disabled（会丢键盘焦点），改 aria-disabled + aria-busy；
// 一个页面加载时就在的 aria-live 播报区，忙时才放字；点击在处理函数里再挡一道（同一帧的第二下不靠状态挡）。
// 确认框：忙时 Esc、「先不」都关不掉；成功才关；失败留在原处，框里一行 role=alert 的错误、焦点送过去，按钮恢复能再点。
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SaveButton } from '../components/layout/save-button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog';
import { Button } from '../components/ui/button';

afterEach(cleanup);

/** 按钮旁边的播报区：aria-live=polite（不写 role=status，免得和页面自己的结果提示抢）。 */
function liveRegion(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-button-status]');
  if (!el) throw new Error('按钮旁边没有播报区');
  expect(el.getAttribute('aria-live')).toBe('polite');
  return el;
}

describe('Button loading', () => {
  test('loading：aria-busy、aria-disabled，不用原生 disabled，画转圈；aria-live 播报区一直在、忙时才有字', () => {
    const { rerender } = render(<Button loading={false}>确认发布</Button>);
    const status = liveRegion();
    expect(status.textContent).toBe('');
    expect(screen.getByRole('button', { name: '确认发布' }).getAttribute('aria-busy')).toBeNull();

    rerender(<Button loading>确认发布</Button>);
    const btn = screen.getByRole('button', { name: '确认发布' });
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    expect(btn.querySelector('[data-button-spinner]')).not.toBeNull();
    // 同一个播报区（不是忙时才插进来的新节点），字是「正在确认发布…」
    expect(liveRegion()).toBe(status);
    expect(status.textContent).toBe('正在确认发布…');
  });

  test('loading 时原生 disabled 让位给 aria-disabled：焦点留得住', () => {
    render(
      <Button loading disabled>
        保存
      </Button>,
    );
    const btn = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    btn.focus();
    expect(document.activeElement).toBe(btn);
  });

  test('loadingLabel 定播报的字；loadingText 换掉按钮上的字', () => {
    render(
      <Button loading loadingLabel="正在提交发布请求" loadingText="正在提交…">
        发布
      </Button>,
    );
    expect(liveRegion().textContent).toBe('正在提交发布请求');
    expect(screen.getByRole('button').textContent).toContain('正在提交…');
  });

  test('loading 时点击被拦：onClick 不触发', () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        叫停
      </Button>,
    );
    fireEvent.click(screen.getByRole('button', { name: '叫停' }));
    expect(onClick).not.toHaveBeenCalled();
  });

  test('同一帧里连点两下（loading 还没来得及变）：只触发一次', () => {
    const onClick = vi.fn();
    render(
      <Button loading={false} onClick={onClick}>
        确认发布
      </Button>,
    );
    const btn = screen.getByRole('button', { name: '确认发布' });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test('onClick 返回的 Promise 没落地前再点也挡住，落地后能再点', async () => {
    let resolve = () => {};
    const onClick = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    render(
      <Button loading={false} onClick={onClick}>
        保存
      </Button>,
    );
    const btn = screen.getByRole('button', { name: '保存' });
    fireEvent.click(btn);
    await new Promise((r) => setTimeout(r, 40));
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
    await act(async () => resolve());
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  test('没传 loading 的普通按钮：不加播报区，连点照常', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>展开</Button>);
    expect(document.querySelector('[data-button-status]')).toBeNull();
    const btn = screen.getByRole('button', { name: '展开' });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(2);
  });
});

describe('SaveButton', () => {
  test('pending：转圈 + aria-busy，不能再点；没改动时照旧灰着禁用', () => {
    const { rerender } = render(<SaveButton canSave pending />);
    const btn = screen.getByRole('button', { name: '保存' });
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.querySelector('[data-button-spinner]')).not.toBeNull();
    expect(liveRegion().textContent).toBe('正在保存…');

    rerender(<SaveButton canSave={false} />);
    const idle = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement;
    expect(idle.disabled).toBe(true);
    expect(idle.getAttribute('aria-busy')).toBeNull();
    expect(idle.dataset.state).toBe('disabled');

    rerender(<SaveButton canSave />);
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).dataset.state).toBe('ready');
  });
});

/** 一个受控的确认框：onConfirm 由测试给。 */
function Confirm({ onConfirm }: { onConfirm: () => Promise<unknown> }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <span data-testid="open">{open ? 'open' : 'closed'}</span>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>叫停 #12？</AlertDialogTitle>
            <AlertDialogDescription>不能恢复。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>先不</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onConfirm={onConfirm}>
              叫停
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function deferred() {
  let resolve: () => void = () => {};
  let reject: (e: unknown) => void = () => {};
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('确认框忙态（AlertDialogAction onConfirm）', () => {
  test('忙时：确定键转圈、只调一次；Esc 和「先不」都关不掉，「先不」也标 aria-disabled', async () => {
    const d = deferred();
    const onConfirm = vi.fn(() => d.promise);
    render(<Confirm onConfirm={onConfirm} />);
    const dialog = screen.getByRole('alertdialog');
    const ok = within(dialog).getByRole('button', { name: '叫停' });
    fireEvent.click(ok);
    fireEvent.click(ok);
    await waitFor(() => expect(ok.getAttribute('aria-busy')).toBe('true'));
    fireEvent.click(ok);
    expect(onConfirm).toHaveBeenCalledTimes(1);

    const cancel = within(dialog).getByRole('button', { name: '先不' });
    expect(cancel.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(cancel);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByTestId('open').textContent).toBe('open');
    expect(screen.queryByRole('alertdialog')).not.toBeNull();

    await act(async () => d.resolve());
  });

  test('成功：框关上', async () => {
    const d = deferred();
    render(<Confirm onConfirm={() => d.promise} />);
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '叫停' }));
    expect(screen.getByTestId('open').textContent).toBe('open');
    await act(async () => d.resolve());
    await waitFor(() => expect(screen.getByTestId('open').textContent).toBe('closed'));
  });

  test('【故意造出的失败】后端拒了：框留着，role=alert 写原因、焦点在它上面，按钮恢复能再点', async () => {
    let call = 0;
    const onConfirm = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error('任务已经结束（done），不能再叫停');
    });
    render(<Confirm onConfirm={onConfirm} />);
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '叫停' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('任务已经结束（done），不能再叫停');
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(screen.getByTestId('open').textContent).toBe('open');
    const ok = within(dialog).getByRole('button', { name: '叫停' });
    expect(ok.getAttribute('aria-busy')).toBeNull();
    expect(within(dialog).getByRole('button', { name: '先不' }).getAttribute('aria-disabled')).toBeNull();

    // 再点一次：这回成功，框关上
    await new Promise((r) => setTimeout(r, 40));
    fireEvent.click(ok);
    await waitFor(() => expect(screen.getByTestId('open').textContent).toBe('closed'));
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  test('没传 onConfirm 的老写法：点了照旧直接关', async () => {
    const onClick = vi.fn();
    function Plain() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <span data-testid="open">{open ? 'open' : 'closed'}</span>
          <AlertDialog open={open} onOpenChange={setOpen}>
            <AlertDialogContent>
              <AlertDialogTitle>确定？</AlertDialogTitle>
              <AlertDialogDescription>说明</AlertDialogDescription>
              <AlertDialogFooter>
                <AlertDialogCancel>先不</AlertDialogCancel>
                <AlertDialogAction onClick={onClick}>好</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      );
    }
    render(<Plain />);
    fireEvent.click(screen.getByRole('button', { name: '好' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByTestId('open').textContent).toBe('closed'));
  });
});
