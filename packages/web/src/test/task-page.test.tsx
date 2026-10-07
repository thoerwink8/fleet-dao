// @vitest-environment happy-dom
// 任务页（#216）：三段的单按段、按模型显示耗时、token、花费，每一笔逐个列；读不到的写「没读到」和原因，不写 0。
// 老流程的单照旧是会话时间线加「时间与用量」。每条读不到的路径都故意造一次。
import { readSegmentRun, type SegmentRunFacts, summarizeUsage, TaskDetailResponse } from '@fleet-dao/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, test } from 'vitest';
import type { FleetApi } from '../api/client';
import { createMockApi } from '../api/mock/server';
import type { TaskDetail } from '../api/types';
import TaskPage from '../routes/task';
import { renderApp } from './harness';

afterEach(cleanup);

function open(route: string, api?: FleetApi) {
  return renderApp(
    <Routes>
      <Route path="/tasks/:taskId" element={<TaskPage />} />
    </Routes>,
    { route, ...(api ? { api } : {}) },
  );
}

const panel = async (title: string) => {
  const h = await screen.findByRole('heading', { name: title });
  const section = h.closest('section');
  if (!section) throw new Error(`没有「${title}」这一块`);
  return section;
};

const segmentRow = (box: HTMLElement, segment: string) => {
  const row = box.querySelector(`[data-segment="${segment}"]`);
  if (!(row instanceof HTMLElement)) throw new Error(`「三段」里没有 ${segment} 这一行`);
  return row;
};

const runRow = (box: HTMLElement, id: string) => {
  const row = box.querySelector(`[data-run="${id}"]`);
  if (!(row instanceof HTMLElement)) throw new Error(`「每一笔」里没有 ${id}`);
  return row;
};

describe('三段的单：按段、按模型，每一笔', () => {
  test('标题、四格合计；三段固定三行，动手按模型再分两行，派工档照记', async () => {
    open('/tasks/t-c9');
    const title = await screen.findByRole('heading', { level: 1, name: /README/ });
    expect(title.textContent).toBe('#9 README 的时间改成北京时间');
    expect(screen.getByText('总耗时')).toBeTruthy();
    expect(screen.getByText('干活合计')).toBeTruthy();
    const box = await panel('三段');
    const manual = segmentRow(box, 'manual');
    expect(within(manual).getByText('动手')).toBeTruthy();
    expect(within(manual).getByText('快档')).toBeTruthy();
    expect(within(manual).getByText('2 次')).toBeTruthy();
    expect([...manual.querySelectorAll('[data-model]')].map((m) => m.getAttribute('data-model'))).toEqual([
      'kimi-k3',
      'opus-5.5',
    ]);
    // 动手段两笔：一笔超时、没记缓存和花费——缓存那格写「不全」，不把没读到的当 0 加进去
    expect(within(manual).getAllByText(/另有 1 次没读到/).length).toBeGreaterThan(0);
    // Kimi 那一行的缓存一次都没读到：写「没读到」，不写 0
    const kimi = manual.querySelector('[data-model="kimi-k3"]') as HTMLElement;
    expect(within(kimi).getAllByText('没读到').length).toBeGreaterThan(0);
    const scope = segmentRow(box, 'scope');
    expect(within(scope).getByText('不分档')).toBeTruthy();
    // 对题只用了一个模型：模型名写在段名旁边，不再多一行同样的数
    expect([...scope.querySelectorAll('[data-model]')].map((m) => m.textContent)).toEqual(['Opus 5.5']);
    expect(scope.querySelector('ul')).toBeNull();
    expect(within(segmentRow(box, 'verify')).getByText('冷调用')).toBeTruthy();
  });

  test('每一笔：结局、起止和耗时、用量、PR；按单号对上的标「按单号兜底」；没读到的逐条写原因', async () => {
    open('/tasks/t-c9');
    const box = await panel('每一笔');
    expect(box.querySelectorAll('[data-run]')).toHaveLength(4);
    const timeout = runRow(box, 'seg-c9-2');
    expect(within(timeout).getByText('超时')).toBeTruthy();
    expect(within(timeout).getByText('为什么没成：30 分钟没交活，按超时收了')).toBeTruthy();
    // 起止 → 耗时：174 分钟前起、144 分钟前收，跑了 30 分钟
    expect(timeout.querySelector('.num.w-full')?.textContent).toMatch(/→ .* · 30 分钟$/);
    const notes = [...timeout.querySelectorAll('[data-unread-item]')].map((n) => n.textContent);
    expect(notes).toEqual(['token · 没记到：缓存读、缓存写', '花费 · 花费没记到']);
    const verify = runRow(box, 'seg-c9-4');
    expect(within(verify).getByText('按单号兜底')).toBeTruthy();
    expect(within(verify).getByText('PR #12')).toBeTruthy();
    expect(within(runRow(box, 'seg-c9-3')).getByText('套餐内折合 $1.42')).toBeTruthy();
  });
});

describe('老流程的单', () => {
  test('没有三段的流水：照旧是会话时间线和「时间与用量」', async () => {
    // t-12 现在也带三段流水（主页流水线图的演示数据），老流程的样例换成 t-19（只有会话）
    open('/tasks/t-19');
    expect(await screen.findByRole('heading', { name: '时间与用量' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '会话时间线' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '三段' })).toBeNull();
  });
});

/** 照真后端的路子拼一份任务详情：每一笔过 readSegmentRun，用量过 summarizeUsage，整个过一遍接口约定。 */
function detailWith(facts: SegmentRunFacts[], state: TaskDetail['task']['state'] = 'running'): TaskDetail {
  const segmentRuns = facts.map((f) => readSegmentRun(f, { taskFinished: state === 'done' }));
  return TaskDetailResponse.parse({
    task: {
      id: 't-x',
      repoId: 'r-1',
      issueNumber: 40,
      title: '样例',
      rawRequest: '样例',
      requestedBy: 'u-1',
      state,
      priority: 1,
      createdAt: new Date(Date.now() - 90 * 60_000).toISOString(),
    },
    repo: { id: 'r-1', owner: 'acme', name: 'orbit', defaultBranch: 'main' },
    subtasks: [],
    runs: [],
    segmentRuns,
    usage: summarizeUsage([], segmentRuns),
    routePins: { pins: [] },
  });
}

function apiWith(d: TaskDetail): FleetApi {
  return { ...createMockApi({ live: false }), task: async () => d };
}

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const base: SegmentRunFacts = {
  id: 'x-1',
  segment: 'manual',
  model: 'opus-5.5',
  modelName: 'Opus 5.5',
  billing: 'subscription',
  tier: 'heavyweight',
  startedAt: ago(30),
  endedAt: ago(10),
  outcome: 'done',
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 30_000,
  cacheWriteTokens: 2000,
  costUsd: 0.25,
  matchedBy: 'task',
};

describe('【失败】读不到的都写明，不写 0', () => {
  test('段名认不出：单列一组「段名认不出」，那一笔写明原样', async () => {
    open('/tasks/t-x', apiWith(detailWith([base, { ...base, id: 'x-2', segment: 'fusion-execute' }])));
    const box = await panel('三段');
    expect(within(segmentRow(box, 'unknown')).getAllByText('段名认不出').length).toBeGreaterThan(0);
    const runs = await panel('每一笔');
    expect(within(runRow(runs, 'x-2')).getByText(/段名「fusion-execute」认不出/)).toBeTruthy();
    // 段标签的字号和提醒色在同一个 cn() 里，两个都得留下（cn 认得自定义字号档位，#734）
    const tag = within(runRow(runs, 'x-2')).getByText('段名认不出');
    expect(tag.className.split(' ')).toEqual(expect.arrayContaining(['text-caption', 'text-ink-stall']));
  });

  test('起止缺一头（单子结束了这一段还开着）：耗时写「没读到」，原因写在那一笔下面', async () => {
    const { endedAt: _e, outcome: _o, ...open_ } = base;
    open('/tasks/t-x', apiWith(detailWith([{ ...open_, id: 'x-3' }], 'done')));
    const runs = await panel('每一笔');
    const row = runRow(runs, 'x-3');
    expect(within(row).getByText('耗时没读到')).toBeTruthy();
    expect(within(row).getByText(/单子已经结束，这一段没记结束时刻/)).toBeTruthy();
    const box = await panel('三段');
    expect(within(segmentRow(box, 'manual')).getAllByText('没读到').length).toBeGreaterThan(0);
  });

  test('token、花费一样都没记到：格子里写「没读到」，合计那格也写「没读到」，不写 0', async () => {
    const blank = {
      ...base,
      id: 'x-4',
      inputTokens: undefined,
      outputTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
      costUsd: undefined,
    };
    open('/tasks/t-x', apiWith(detailWith([blank])));
    const runs = await panel('每一笔');
    const notes = [...runRow(runs, 'x-4').querySelectorAll('[data-unread-item]')].map((n) => n.textContent);
    expect(notes).toEqual(['token · 四样 token 都没记到', '花费 · 花费没记到']);
    const box = await panel('三段');
    const manual = segmentRow(box, 'manual');
    // token、缓存、当量、花费四格各写一次没读到（只有一个模型，不再多一行）；没有哪格写成 0
    // 花费那格另写为什么也估不了（token 没读全，按目录单价估不出来），不拿 0 顶
    expect([...manual.querySelectorAll('[data-unread]')].map((n) => n.textContent)).toEqual([
      '没读到',
      '没读到',
      '没读到',
      '套餐内 · 花费没读到',
      '1 笔 token 没读全，估不了',
    ]);
    expect(within(manual).queryByText('0 / 0')).toBeNull();
    expect(within(manual).queryByText('0')).toBeNull();
    // 合计四格里的当量、花费写「没读到」
    expect(screen.getAllByText('没读到').length).toBeGreaterThanOrEqual(2);
  });

  test('动手段没记派工档：写「没记」，不猜成哪一档；没跑过的段写明没有记录', async () => {
    open('/tasks/t-x', apiWith(detailWith([{ ...base, tier: undefined }])));
    const box = await panel('三段');
    expect(within(segmentRow(box, 'manual')).getByText('没记')).toBeTruthy();
    expect(within(segmentRow(box, 'verify')).getByText('没有这一段的记录')).toBeTruthy();
    const runs = await panel('每一笔');
    expect(runRow(runs, 'x-1').querySelector('[data-unread-item="tier"]')?.textContent).toBe(
      '派工档 · 动手段没记派工档',
    );
  });

  test('对题没有行（#761：在对话里做的，引擎没起会话）：写「不计」和原因，不写「没有这一段的记录」；验收没有行照旧写没有记录', async () => {
    open('/tasks/t-x', apiWith(detailWith([base])));
    const box = await panel('三段');
    const scope = segmentRow(box, 'scope');
    expect(within(scope).getByText('在对话里做的，不计')).toBeTruthy();
    expect(within(scope).getByText(/不是没记，是不计/)).toBeTruthy();
    expect(within(scope).queryByText('没有这一段的记录')).toBeNull();
    const verify = segmentRow(box, 'verify');
    expect(within(verify).getByText('没有这一段的记录')).toBeTruthy();
    expect(within(verify).queryByText(/不计/)).toBeNull();
    expect(within(segmentRow(box, 'manual')).queryByText(/不计/)).toBeNull();
  });

  test('对题有引擎起的会话（以后的意图归纳、段记 scope）：照常显示那几笔，段名下写明只含这些、对话里的部分不计', async () => {
    open(
      '/tasks/t-x',
      apiWith(detailWith([base, { ...base, id: 'x-s', segment: 'scope', tier: undefined }])),
    );
    const box = await panel('三段');
    const scope = segmentRow(box, 'scope');
    expect(within(scope).getByText('1 次')).toBeTruthy();
    expect(within(scope).getByText('只含引擎起的会话；在对话里做的部分不计')).toBeTruthy();
    expect(within(scope).queryByText('在对话里做的，不计')).toBeNull();
    // 动手段不加这句
    expect(within(segmentRow(box, 'manual')).queryByText(/不计/)).toBeNull();
  });

  test('还在跑的一段：写在跑、已跑多久，用量跑完才有——不算没读到', async () => {
    const { endedAt: _e, outcome: _o, ...live } = base;
    open('/tasks/t-x', apiWith(detailWith([{ ...live, id: 'x-5', costUsd: undefined }])));
    const runs = await panel('每一笔');
    const row = runRow(runs, 'x-5');
    expect(within(row).getByText('在跑')).toBeTruthy();
    expect(within(row).getByText(/已跑 30 分钟/)).toBeTruthy();
    expect(row.querySelectorAll('[data-unread-item]')).toHaveLength(0);
  });
});

describe('任务页上的暂停、继续、叫停（#820 片 3，#856 第 1 处）', () => {
  const actionBox = async () => {
    await screen.findByRole('heading', { level: 1 });
    return document.querySelector('[data-task-actions]') as HTMLElement | null;
  };

  test('在跑的单：页头有暂停、继续、叫停三个按钮；没有换模型', async () => {
    open('/tasks/t-12');
    await waitFor(async () => expect(await actionBox()).not.toBeNull());
    const box = (await actionBox()) as HTMLElement;
    expect([...box.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['暂停', '继续', '叫停']);
    expect(within(box).queryByText('换模型')).toBeNull();
  });

  test('点暂停、选「做完这一段再停」：页上写「已暂停」和原因（等待色，不是失败红），按钮不再有「暂停」；点继续后恢复', async () => {
    const api = createMockApi({ live: false });
    open('/tasks/t-12', api);
    await waitFor(async () => expect(await actionBox()).not.toBeNull());
    fireEvent.click(within((await actionBox()) as HTMLElement).getByRole('button', { name: '暂停' }));
    fireEvent.click(await screen.findByRole('button', { name: '做完这一段再停' }));
    await waitFor(() => expect(document.querySelector('[data-paused-note]')).not.toBeNull());
    expect(screen.getByText('已暂停')).toBeTruthy();
    expect(document.querySelector('[data-paused-note]')?.textContent).toContain('已暂停：被人暂停');
    const box = (await actionBox()) as HTMLElement;
    expect([...box.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['继续', '叫停']);
    fireEvent.click(within(box).getByRole('button', { name: '继续' }));
    await waitFor(() => expect(document.querySelector('[data-paused-note]')).toBeNull());
    expect(
      [...((await actionBox()) as HTMLElement).querySelectorAll('button')].map((b) => b.textContent),
    ).toEqual(['暂停', '继续', '叫停']);
  });

  test('【故意造出的失败】已结束的单：一个按钮都不画', async () => {
    open('/tasks/t-11');
    await screen.findByRole('heading', { level: 1 });
    expect(await actionBox()).toBeNull();
  });

  test('叫停之后可以重做：确认里写明旧工作树没推上去的东西会丢掉', async () => {
    const api = createMockApi({ live: false });
    open('/tasks/t-12', api);
    await waitFor(async () => expect(await actionBox()).not.toBeNull());
    fireEvent.click(within((await actionBox()) as HTMLElement).getByRole('button', { name: '叫停' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '叫停' }));
    await waitFor(async () => {
      const box = await actionBox();
      expect(box && [...box.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['重做']);
    });
    fireEvent.click(within((await actionBox()) as HTMLElement).getByRole('button', { name: '重做' }));
    expect(await screen.findByText(/没推上去/)).toBeTruthy();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '重做' }));
    await waitFor(async () => {
      const box = await actionBox();
      expect(box && [...box.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
        '暂停',
        '继续',
        '叫停',
      ]);
    });
  });
});
