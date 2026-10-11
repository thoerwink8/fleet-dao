// @vitest-environment happy-dom
// 手机后退键关抽屉（#1820）：Sheet 打开时压一条历史记录，history.back() 只关最上面一层、留在本页。
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../components/ui/sheet';
import { SHEET_STATE_KEY } from '../lib/use-back-close';

afterEach(cleanup);
beforeEach(() => window.history.replaceState(null, '', '/page'));

function Demo({ name, historyEntry }: { name: string; historyEntry?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        开{name}
      </button>
      <Sheet open={open} onOpenChange={setOpen} {...(historyEntry === undefined ? {} : { historyEntry })}>
        <SheetContent>
          <SheetTitle>{name}</SheetTitle>
          <SheetDescription>说明</SheetDescription>
        </SheetContent>
      </Sheet>
    </>
  );
}

/** 甲抽屉里有个按钮再开乙抽屉。 */
function Nested() {
  const [a, setA] = useState(false);
  const [b, setB] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setA(true)}>
        开甲
      </button>
      <Sheet open={a} onOpenChange={setA}>
        <SheetContent>
          <SheetTitle>甲</SheetTitle>
          <SheetDescription>说明</SheetDescription>
          <button type="button" onClick={() => setB(true)}>
            开乙
          </button>
        </SheetContent>
      </Sheet>
      <Sheet open={b} onOpenChange={setB}>
        <SheetContent>
          <SheetTitle>乙</SheetTitle>
          <SheetDescription>说明</SheetDescription>
        </SheetContent>
      </Sheet>
    </>
  );
}

const pushedDepth = () => window.history.length;
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));

describe('抽屉与历史记录', () => {
  test('打开抽屉压一条历史记录，history.back() 关掉它且留在本页', async () => {
    render(<Demo name="甲" />);
    const before = pushedDepth();
    act(() => screen.getByRole('button', { name: '开甲' }).click());
    expect(screen.getByRole('dialog')).toBeTruthy();
    await waitFor(() => expect(window.history.state?.[SHEET_STATE_KEY]).toBeTruthy());
    expect(pushedDepth()).toBe(before + 1);

    act(() => window.history.back());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(window.location.pathname).toBe('/page');
    expect(window.history.state?.[SHEET_STATE_KEY]).toBeUndefined();
  });

  test('点叉关抽屉后，压的那条也弹掉，后退键不用多按一次', async () => {
    render(<Demo name="甲" />);
    act(() => screen.getByRole('button', { name: '开甲' }).click());
    await waitFor(() => expect(window.history.state?.[SHEET_STATE_KEY]).toBeTruthy());
    act(() => screen.getByRole('button', { name: '关闭' }).click());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(window.history.state?.[SHEET_STATE_KEY]).toBeUndefined());
    await settle();
    expect(window.location.pathname).toBe('/page');
  });

  test('historyEntry={false} 不压历史记录', async () => {
    render(<Demo name="甲" historyEntry={false} />);
    const before = pushedDepth();
    act(() => screen.getByRole('button', { name: '开甲' }).click());
    await settle();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(pushedDepth()).toBe(before);
    expect(window.history.state?.[SHEET_STATE_KEY]).toBeUndefined();
  });

  test('叠两层抽屉：后退一次只关最上面一层', async () => {
    render(<Nested />);
    act(() => screen.getByRole('button', { name: '开甲' }).click());
    await waitFor(() => expect(window.history.state?.[SHEET_STATE_KEY]).toBeTruthy());
    const first = window.history.state?.[SHEET_STATE_KEY];
    act(() => screen.getByRole('button', { name: '开乙' }).click());
    await waitFor(() => expect(screen.getAllByRole('dialog', { hidden: true })).toHaveLength(2));
    await waitFor(() => expect(window.history.state?.[SHEET_STATE_KEY]).not.toBe(first));

    act(() => window.history.back());
    await waitFor(() => expect(screen.getAllByRole('dialog', { hidden: true })).toHaveLength(1));
    expect(screen.getByRole('dialog').textContent).toContain('甲');
    act(() => window.history.back());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(window.location.pathname).toBe('/page');
  });
});
