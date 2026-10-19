// @vitest-environment happy-dom
// 任务页「每一笔」的会话抽屉（#1802）：每笔只留一行摘要加「看会话」，点了网址带 ?run=<笔号> 并开右侧抽屉，抽屉里是那一笔的会话；
// 浏览器后退抽屉就关；直接打开带 ?run= 的链接也开。外加手机端：四张统计卡 2×2、三段每段一行摘要。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes, useLocation, useNavigate } from 'react-router';
import { afterEach, describe, expect, test } from 'vitest';
import TaskPage from '../routes/task';
import { renderApp } from './harness';

afterEach(cleanup);

/** 地址栏现在是什么，加一个「后退」按钮（等于浏览器后退）。 */
function Probe() {
  const loc = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="search">{loc.search}</output>
      <button type="button" onClick={() => void navigate(-1)}>
        浏览器后退
      </button>
    </>
  );
}

function open(route: string) {
  return renderApp(
    <>
      <Routes>
        <Route path="/tasks/:taskId" element={<TaskPage />} />
      </Routes>
      <Probe />
    </>,
    { route },
  );
}

const search = () => screen.getByTestId('search').textContent;
const drawer = () => document.querySelector('[data-run-drawer]');
// 「每一笔」「三段」在「用量和模型」里，默认收起（#3228）：收着也挂在页面上，等它出来就行，不改网址
const ready = () =>
  waitFor(() => {
    if (!document.querySelector('[data-view-transcript]')) throw new Error('每一笔还没出来');
  });

describe('「看会话」抽屉', () => {
  test('每一笔不再把会话铺在页面里：只有摘要和「看会话」按钮', async () => {
    open('/tasks/t-c9');
    await ready();
    expect(document.querySelectorAll('[data-view-transcript]')).toHaveLength(4);
    expect(document.querySelector('[data-transcript-body]')).toBeNull();
    expect(drawer()).toBeNull();
    expect(screen.queryByRole('button', { name: '会话内容' })).toBeNull();
  });

  test('点「看会话」：网址带 run=、右侧抽屉出现那一笔的会话；后退抽屉关闭', async () => {
    open('/tasks/t-c9');
    await ready();
    fireEvent.click(document.querySelector('[data-view-transcript="seg-c9-3"]') as HTMLElement);
    expect(search()).toBe('?run=seg-c9-3');
    expect(drawer()?.getAttribute('data-run-drawer')).toBe('seg-c9-3');
    // 那一笔的会话：结论在，出错的工具调用自动展开
    expect(await screen.findByText(/已提交 4c1d2ab/)).toBeTruthy();
    const dlg = screen.getByRole('dialog');
    expect(within(dlg).getByText('第 2 次')).toBeTruthy();
    expect(within(dlg).getByText(/FAIL scripts\/stamp.test.ts/)).toBeTruthy();
    // 后退：网址回到没有 run=，抽屉关
    fireEvent.click(screen.getByText('浏览器后退'));
    await waitFor(() => expect(drawer()).toBeNull());
    expect(search()).toBe('');
  });

  test('点抽屉的叉（关闭）：本页自己开的，等于后退', async () => {
    open('/tasks/t-c9?from=%2Ftasks');
    await ready();
    fireEvent.click(document.querySelector('[data-view-transcript="seg-c9-3"]') as HTMLElement);
    // 保留别的参数
    expect(search()).toBe('?from=%2Ftasks&run=seg-c9-3');
    await screen.findByText(/已提交 4c1d2ab/);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '关闭' }));
    await waitFor(() => expect(drawer()).toBeNull());
    expect(search()).toBe('?from=%2Ftasks');
  });

  test('直接打开带 ?run= 的链接：抽屉就开；关的时候只去掉参数', async () => {
    open('/tasks/t-c9?run=seg-c9-3');
    expect(await screen.findByText(/已提交 4c1d2ab/)).toBeTruthy();
    expect(drawer()?.getAttribute('data-run-drawer')).toBe('seg-c9-3');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '关闭' }));
    await waitFor(() => expect(drawer()).toBeNull());
    expect(search()).toBe('');
  });

  test('网址里的笔号对不上这张单的任何一笔：不开抽屉', async () => {
    open('/tasks/t-c9?run=nope');
    await ready();
    expect(drawer()).toBeNull();
  });
});

describe('手机端（#1802 点验补充）', () => {
  test('四张统计卡（#2859 去掉了折算 token）手机上两列，宽屏四列并排', async () => {
    open('/tasks/t-c9');
    await ready();
    const grid = document.querySelector('[data-segment-stats] > div') as HTMLElement;
    expect(grid.children.length).toBe(4);
    expect(grid.className).toContain('grid-cols-2');
    expect(grid.className).not.toContain('grid-cols-1');
    expect(grid.className).toContain('xl:grid-cols-4');
  });

  test('「三段」每段手机上一行摘要：段、模型、次数、耗时、token、花费；表格只在 md 以上', async () => {
    open('/tasks/t-c9');
    await ready();
    const manual = document.querySelector('[data-segment="manual"]') as HTMLElement;
    const line = manual.querySelector('[data-segment-summary]') as HTMLElement;
    expect(line.className).toContain('md:hidden');
    expect(line.textContent).toMatch(/^动手 · 2 个模型 · 2 次/);
    expect(line.textContent).toContain('token');
    const table = manual.firstElementChild as HTMLElement;
    expect(table.className).toContain('hidden');
    expect(table.className).toContain('md:grid');
    // 没读到的写没读到，不写 0
    expect(line.textContent).not.toMatch(/ 0 \/ 0 token/);
  });
});
