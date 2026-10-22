// @vitest-environment happy-dom
// 任务页右侧的会话抽屉（#3277，替掉 #1802 的看会话抽屉；#3533 过程挪进「过程」页签）：过程在页签里，`\` 切到过程页签；
// 抽屉只跟 ?run= 走：「看会话」压一条 ?run=，抽屉换成那一笔，「‹ 过程」和浏览器后退收起抽屉；K / J 换笔不压历史；
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
// 过程在「过程」页签里（?tab=process）；每一笔的「看会话」在笔行右边。前面收场的回合默认收着，点开再找
const inProcess = (route: string) => `${route}${route.includes('?') ? '&' : '?'}tab=process`;
const ready = () =>
  waitFor(() => {
    if (!document.querySelector('[data-task-process] [data-run-process]')) throw new Error('过程还没出来');
  });
const viewRun = (id: string) => {
  for (const b of document.querySelectorAll('[data-round-header] button[aria-expanded="false"]'))
    fireEvent.click(b);
  const btn = [...document.querySelectorAll(`[data-run-process="${id}"] button`)].find(
    (b) => b.textContent === '看会话',
  );
  fireEvent.click(btn as HTMLElement);
};

describe('开关', () => {
  test('默认关：过程在页签里，抽屉不开；点一笔的「看会话」从右边盖上抽屉，点叉关掉并去掉 ?run=', async () => {
    open(inProcess('/tasks/t-c9'));
    await ready();
    expect(panel()).toBeNull();
    expect(document.querySelector('[data-panel-toggle]')).toBeNull();
    expect(document.querySelector('[data-panel-launcher]')).toBeNull();
    viewRun('seg-c9-3');
    // 宽屏也是盖在右边的抽屉，不占正文的位置
    const dlg = await screen.findByRole('dialog');
    expect(dlg.getAttribute('data-task-panel')).toBe('sheet');
    expect(view()).toBe('run');
    fireEvent.click(within(dlg).getByRole('button', { name: '关掉面板（\\）' }));
    await waitFor(() => expect(panel()).toBeNull());
    expect(search()).toBe('?tab=process');
  });

  test('本地记着「面板开着」不再让抽屉自己打开：抽屉只跟 ?run= 走', async () => {
    localStorage.setItem(PANEL_OPEN_KEY, 'true');
    open(inProcess('/tasks/t-c9'));
    await ready();
    expect(panel()).toBeNull();
  });

  test('\\ 切到「过程」页签；输入框里按 \\ 照常打字', async () => {
    open('/tasks/t-c9');
    await screen.findByRole('tab', { name: '过程' });
    expect(search()).toBe('');
    const input = document.createElement('input');
    document.body.append(input);
    fireEvent.keyDown(input, { key: '\\' });
    expect(search()).toBe('');
    input.remove();
    fireEvent.keyDown(window, { key: '\\' });
    await ready();
    expect(search()).toBe('?tab=process');
    expect(screen.getByRole('tab', { name: '过程' }).getAttribute('aria-selected')).toBe('true');
    expect(panel()).toBeNull();
  });

  test('Esc 收起抽屉，?run= 一起去掉', async () => {
    open(inProcess('/tasks/t-c9'));
    await ready();
    viewRun('seg-c9-3');
    const dlg = await screen.findByRole('dialog');
    fireEvent.keyDown(dlg, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(search()).toBe('?tab=process');
  });
});

describe('看会话', () => {
  test('点「看会话」：网址带 run=、抽屉换成那一笔；「‹ 过程」等于后退，抽屉收起、页面留在过程页签', async () => {
    open(inProcess('/tasks/t-c9?from=%2Ftasks'));
    await ready();
    viewRun('seg-c9-3');
    expect(search()).toBe('?from=%2Ftasks&tab=process&run=seg-c9-3');
    expect(view()).toBe('run');
    expect(panel()?.querySelector('[data-panel-run-title]')?.textContent).toBe('第 3 笔 · 动手');
    expect(await screen.findByText(/已提交 4c1d2ab/)).toBeTruthy();
    expect(within(panel() as HTMLElement).getByText(/FAIL scripts\/stamp.test.ts/)).toBeTruthy();
    fireEvent.click(panel()?.querySelector('[data-panel-back]') as HTMLElement);
    await waitFor(() => expect(panel()).toBeNull());
    expect(search()).toBe('?from=%2Ftasks&tab=process');
    expect(document.querySelector('[data-task-process]')).toBeTruthy();
  });

  test('浏览器后退：抽屉收起，回到过程页签', async () => {
    open(inProcess('/tasks/t-c9'));
    await ready();
    viewRun('seg-c9-3');
    expect(view()).toBe('run');
    fireEvent.click(screen.getByText('浏览器后退'));
    await waitFor(() => expect(panel()).toBeNull());
    expect(search()).toBe('?tab=process');
  });

  test('直接打开带 ?run= 的链接：抽屉就开在那一笔；「‹ 过程」只去掉参数；关掉抽屉也去掉', async () => {
    open('/tasks/t-c9?run=seg-c9-3');
    expect(await screen.findByText(/已提交 4c1d2ab/)).toBeTruthy();
    expect(view()).toBe('run');
    fireEvent.click(panel()?.querySelector('[data-panel-back]') as HTMLElement);
    await waitFor(() => expect(panel()).toBeNull());
    expect(search()).toBe('');
    // 回到过程页签再点另一笔
    fireEvent.keyDown(window, { key: '\\' });
    await ready();
    viewRun('seg-c9-2');
    expect(search()).toBe('?tab=process&run=seg-c9-2');
    fireEvent.click(within(panel() as HTMLElement).getByRole('button', { name: '关掉面板（\\）' }));
    await waitFor(() => expect(panel()).toBeNull());
    expect(search()).toBe('?tab=process');
  });

  test('K / J 换上一笔、下一笔：替换地址不压历史，到头了按钮不能点', async () => {
    open(inProcess('/tasks/t-c9'));
    await ready();
    viewRun('seg-c9-3');
    fireEvent.keyDown(window, { key: 'j' });
    expect(search()).toBe('?tab=process&run=seg-c9-4');
    // 到头了：置灰（aria-disabled），悬停写原因
    const next = within(panel() as HTMLElement).getByRole('button', { name: '下一笔（J）' });
    expect(next.getAttribute('aria-disabled')).toBe('true');
    expect(next.getAttribute('title')).toBe('已经是最后一笔');
    fireEvent.keyDown(window, { key: 'k' });
    fireEvent.keyDown(window, { key: 'K' });
    expect(search()).toBe('?tab=process&run=seg-c9-2');
    // 换笔没压历史：后退一步抽屉就收起
    fireEvent.click(screen.getByText('浏览器后退'));
    await waitFor(() => expect(panel()).toBeNull());
  });

  test('网址里的笔号对不上这张单的任何一笔：面板不开', async () => {
    open(inProcess('/tasks/t-c9?run=nope'));
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
  test('四个指标（#2859 去掉了折算 token）一排摆着，手机上两个一行', async () => {
    open('/tasks/t-c9?tab=usage');
    await screen.findByText('输入当量');
    const grid = document.querySelector('[data-segment-stats] [data-cols]') as HTMLElement;
    expect(grid.children.length).toBe(4);
  });

  test('「三段」每段手机上一行摘要：段、模型、次数、耗时、token、花费；表格只在 md 以上', async () => {
    viewport(390);
    open('/tasks/t-c9?tab=usage');
    await screen.findByText('输入当量');
    const line = (await waitFor(() => {
      const el = document.querySelector('[data-segment="manual"][data-segment-summary]');
      if (!el) throw new Error('手机上没出每段一行摘要');
      return el;
    })) as HTMLElement;
    expect(line.textContent).toMatch(/^动手 · 2 个模型 · 2 次/);
    expect(line.textContent).toContain('token');
    // 手机上不画八列的表
    expect(document.querySelector('table[aria-label="三段用量"], tr[data-row-key="manual"]')).toBeNull();
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
