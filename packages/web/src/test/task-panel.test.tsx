// @vitest-environment happy-dom
// 任务页右侧的「过程」面板（#3277，替掉 #1802 的看会话抽屉）：页头「过程」和 \ 开关、开没开记在本地；
// 「看会话」压一条 ?run= 在面板里换成那一笔，「‹ 过程」和浏览器后退回到过程；K / J 换笔不压历史；
// 所有宽度都是盖在右边的抽屉、不占正文，手机从底下整屏；左边沿左右键拉宽；弹出窗口不带外壳，左边按回合列笔。
// 外加手机端：四张统计卡 2×2、三段每段一行摘要。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes, useLocation, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { PANEL_OPEN_KEY, PANEL_WIDTH_KEY } from '../components/task-panel';
import TaskPage from '../routes/task';
import TaskRunPage from '../routes/task-run';
import { renderApp } from './harness';

/** happy-dom 不认我们的断点：按宽度手算 min-width / max-width。 */
function viewport(width: number) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: [...query.matchAll(/\((min|max)-width:\s*(\d+)px\)/g)].every(([, kind, px]) =>
          kind === 'min' ? width >= Number(px) : width <= Number(px),
        ),
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

beforeEach(() => {
  localStorage.clear();
  viewport(1440);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** 地址栏现在是什么，加一个「后退」按钮（等于浏览器后退）。 */
function Probe() {
  const loc = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="path">{loc.pathname}</output>
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
        <Route path="/tasks/:taskId/runs/:runId" element={<TaskRunPage />} />
      </Routes>
      <Probe />
    </>,
    { route },
  );
}

const search = () => screen.getByTestId('search').textContent;
const panel = () => document.querySelector<HTMLElement>('[data-task-panel]');
const view = () => panel()?.querySelector('[data-panel-view]')?.getAttribute('data-panel-view');
// 「每一笔」在「用量和模型」里，默认收起（#3228）：收着也挂在页面上，等它出来就行
const ready = () =>
  waitFor(() => {
    if (!document.querySelector('[data-view-transcript]')) throw new Error('每一笔还没出来');
  });
const viewRun = (id: string) =>
  fireEvent.click(document.querySelector(`[data-usage-fold] [data-view-transcript="${id}"]`) as HTMLElement);

describe('开关', () => {
  test('默认关：正文末尾一行「过程」摘要；点页头「过程」从右边盖上抽屉、记在本地，点叉关掉', async () => {
    open('/tasks/t-c9');
    await ready();
    expect(panel()).toBeNull();
    const launcher = document.querySelector('[data-panel-launcher]') as HTMLElement;
    expect(launcher.textContent).toMatch(/^过程.*回合/);
    const toggle = document.querySelector('[data-panel-toggle]') as HTMLElement;
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    // 宽屏也是盖在右边的抽屉，不占正文的位置
    const dlg = await screen.findByRole('dialog');
    expect(dlg.getAttribute('data-task-panel')).toBe('sheet');
    expect(view()).toBe('process');
    expect(dlg.querySelector('[data-task-process]')).toBeTruthy();
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[data-panel-launcher]')).toBeNull();
    expect(localStorage.getItem(PANEL_OPEN_KEY)).toBe('true');
    fireEvent.click(within(dlg).getByRole('button', { name: '关掉面板（\\）' }));
    await waitFor(() => expect(panel()).toBeNull());
    expect(localStorage.getItem(PANEL_OPEN_KEY)).toBe('false');
  });

  test('上次开着的，再进来还开着；点正文末尾的摘要也能打开', async () => {
    localStorage.setItem(PANEL_OPEN_KEY, 'true');
    const first = open('/tasks/t-c9');
    await ready();
    expect(view()).toBe('process');
    first.unmount();
    localStorage.setItem(PANEL_OPEN_KEY, 'false');
    open('/tasks/t-c9');
    await ready();
    fireEvent.click(document.querySelector('[data-panel-launcher]') as HTMLElement);
    expect(view()).toBe('process');
  });

  test('\\ 开关面板；输入框里按 \\ 照常打字', async () => {
    open('/tasks/t-c9');
    await ready();
    fireEvent.keyDown(window, { key: '\\' });
    await waitFor(() => expect(view()).toBe('process'));
    fireEvent.keyDown(window, { key: '\\' });
    await waitFor(() => expect(panel()).toBeNull());
    const input = document.createElement('input');
    document.body.append(input);
    fireEvent.keyDown(input, { key: '\\' });
    expect(panel()).toBeNull();
    input.remove();
  });

  test('Esc 收起抽屉', async () => {
    open('/tasks/t-c9');
    await ready();
    fireEvent.click(document.querySelector('[data-panel-toggle]') as HTMLElement);
    const dlg = await screen.findByRole('dialog');
    fireEvent.keyDown(dlg, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(localStorage.getItem(PANEL_OPEN_KEY)).toBe('false');
  });
});

describe('看会话', () => {
  test('点「看会话」：网址带 run=、面板换成那一笔；「‹ 过程」等于后退，面板留着看过程', async () => {
    open('/tasks/t-c9?from=%2Ftasks');
    await ready();
    viewRun('seg-c9-3');
    expect(search()).toBe('?from=%2Ftasks&run=seg-c9-3');
    expect(view()).toBe('run');
    expect(panel()?.querySelector('[data-panel-run-title]')?.textContent).toBe('第 3 笔 · 动手');
    expect(await screen.findByText(/已提交 4c1d2ab/)).toBeTruthy();
    expect(within(panel() as HTMLElement).getByText(/FAIL scripts\/stamp.test.ts/)).toBeTruthy();
    fireEvent.click(panel()?.querySelector('[data-panel-back]') as HTMLElement);
    await waitFor(() => expect(view()).toBe('process'));
    expect(search()).toBe('?from=%2Ftasks');
  });

  test('浏览器后退：回到过程，面板不关', async () => {
    open('/tasks/t-c9');
    await ready();
    viewRun('seg-c9-3');
    expect(view()).toBe('run');
    fireEvent.click(screen.getByText('浏览器后退'));
    await waitFor(() => expect(view()).toBe('process'));
    expect(search()).toBe('');
  });

  test('直接打开带 ?run= 的链接：面板就开在那一笔；「‹ 过程」只去掉参数；关掉面板也去掉', async () => {
    open('/tasks/t-c9?run=seg-c9-3');
    expect(await screen.findByText(/已提交 4c1d2ab/)).toBeTruthy();
    expect(view()).toBe('run');
    fireEvent.click(panel()?.querySelector('[data-panel-back]') as HTMLElement);
    await waitFor(() => expect(view()).toBe('process'));
    expect(search()).toBe('');
    viewRun('seg-c9-2');
    expect(search()).toBe('?run=seg-c9-2');
    fireEvent.click(within(panel() as HTMLElement).getByRole('button', { name: '关掉面板（\\）' }));
    await waitFor(() => expect(panel()).toBeNull());
    expect(search()).toBe('');
  });

  test('K / J 换上一笔、下一笔：替换地址不压历史，到头了按钮不能点', async () => {
    open('/tasks/t-c9');
    await ready();
    viewRun('seg-c9-3');
    fireEvent.keyDown(window, { key: 'j' });
    expect(search()).toBe('?run=seg-c9-4');
    expect(within(panel() as HTMLElement).getByRole('button', { name: '下一笔（J）' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.keyDown(window, { key: 'k' });
    fireEvent.keyDown(window, { key: 'K' });
    expect(search()).toBe('?run=seg-c9-2');
    // 换笔没压历史：后退一步就回到过程
    fireEvent.click(screen.getByText('浏览器后退'));
    await waitFor(() => expect(view()).toBe('process'));
  });

  test('网址里的笔号对不上这张单的任何一笔：面板不开', async () => {
    open('/tasks/t-c9?run=nope');
    await ready();
    expect(panel()).toBeNull();
  });

  test('左边沿左右键拉宽、记在本地，不超过屏宽六成', async () => {
    open('/tasks/t-c9?run=seg-c9-3');
    await screen.findByText(/已提交 4c1d2ab/);
    const bar = screen.getByRole('separator');
    const before = Number(bar.getAttribute('aria-valuenow'));
    fireEvent.keyDown(bar, { key: 'ArrowLeft' });
    expect(Number(bar.getAttribute('aria-valuenow'))).toBeGreaterThan(before);
    expect(Number(localStorage.getItem(PANEL_WIDTH_KEY))).toBeGreaterThan(before);
    for (let i = 0; i < 60; i++) fireEvent.keyDown(bar, { key: 'ArrowLeft' });
    expect(Number(bar.getAttribute('aria-valuenow'))).toBeLessThanOrEqual(
      Math.round(window.innerWidth * 0.6),
    );
  });

  test('「弹出到新窗口」开那一笔的弹出页，同一笔复用同一个窗口', async () => {
    const pop = vi.spyOn(window, 'open').mockReturnValue(null);
    open('/tasks/t-c9?run=seg-c9-3');
    await screen.findByText(/已提交 4c1d2ab/);
    fireEvent.click(within(panel() as HTMLElement).getByRole('button', { name: '弹出到新窗口' }));
    expect(pop).toHaveBeenCalledWith('/tasks/t-c9/runs/seg-c9-3', expect.stringContaining('run-seg-c9-3'));
  });
});

describe('弹出窗口', () => {
  test('左边按回合列整张单的笔、标着当前这一笔；右边是那一笔的会话；点别的笔换过去', async () => {
    open('/tasks/t-c9/runs/seg-c9-3');
    expect(await screen.findByText(/已提交 4c1d2ab/)).toBeTruthy();
    expect(document.querySelector('[data-popout-title]')?.textContent).toBe('第 3 笔 · 动手');
    const list = document.querySelector('[data-popout-runs]') as HTMLElement;
    expect([...list.querySelectorAll('p')].map((p) => p.textContent)).toEqual([
      '不在回合里',
      '第 1 回合',
      '第 2 回合',
    ]);
    expect(list.querySelectorAll('a')).toHaveLength(4);
    expect(list.querySelector('[aria-current="page"]')?.textContent).toContain('第 3 笔');
    fireEvent.click(within(list).getByText('第 4 笔 · 验收'));
    await waitFor(() => expect(screen.getByTestId('path').textContent).toBe('/tasks/t-c9/runs/seg-c9-4'));
    expect(document.querySelector('[data-popout-title]')?.textContent).toBe('第 4 笔 · 验收');
    expect(document.querySelector('[data-popout-back]')?.getAttribute('href')).toBe('/tasks/t-c9');
  });

  test('笔号对不上：写明没有这一笔，左边照样列着', async () => {
    open('/tasks/t-c9/runs/nope');
    expect(await screen.findByText('没有这一笔')).toBeTruthy();
    expect(document.querySelectorAll('[data-popout-runs] a')).toHaveLength(4);
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

  test('手机上面板从底下整屏盖上来，没有拉宽条和弹出', async () => {
    viewport(390);
    open('/tasks/t-c9?run=seg-c9-3');
    const dlg = await screen.findByRole('dialog');
    expect(dlg.getAttribute('data-task-panel')).toBe('sheet');
    await within(dlg).findByText(/已提交 4c1d2ab/);
    expect(within(dlg).queryByRole('separator')).toBeNull();
    expect(within(dlg).queryByRole('button', { name: '弹出到新窗口' })).toBeNull();
  });
});
