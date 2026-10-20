// @vitest-environment happy-dom
// 任务页（#216）：单子按段、按模型显示耗时、token、花费，每一笔逐个列；读不到的写「没读到」和原因，不写 0。
// 每条读不到的路径都故意造一次。
import {
  readSegmentRun,
  type SegmentRunFacts,
  summarizeUsage,
  TaskDetailResponse,
  USAGE_BOARD_UNREAD,
  USAGE_NOTE_MASTER_OFF,
  USAGE_SESSION_UNREAD,
} from '@fleet-dao/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, test } from 'vitest';
import type { FleetApi } from '../api/client';
import { createMockApi } from '../api/mock/server';
import type { TaskDetail } from '../api/types';
import TaskPage from '../routes/task';
import { renderApp } from './harness';

afterEach(cleanup);

// 这里测的是用量明细：「用量和模型」默认收起（#3228），地址带 ?usage=open 打开
function open(route: string, api?: FleetApi) {
  return renderApp(
    <Routes>
      <Route path="/tasks/:taskId" element={<TaskPage />} />
    </Routes>,
    { route: `${route}${route.includes('?') ? '&' : '?'}usage=open`, ...(api ? { api } : {}) },
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
    // Kimi 那一行的缓存一次都没读到：格子里留 —（不写 0、也不逐格写「没读到」），哪项读不到由「三段」顶上的 Notice 说
    const kimi = manual.querySelector('[data-model="kimi-k3"]') as HTMLElement;
    expect(kimi.querySelectorAll('[data-unread]').length).toBeGreaterThan(0);
    expect(within(kimi).queryByText('没读到')).toBeNull();
    expect(within(box).queryByText('没读到')).toBeNull();
    expect(box.querySelectorAll('[data-unread-notice]')).toHaveLength(1);
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

describe('页头：面包屑代替「回任务列表」按钮（#1903）', () => {
  test('从任务列表点进来：面包屑第一级是「任务列表」链接（带回筛选），页头没有「回任务列表」按钮', async () => {
    open(`/tasks/t-c9?from=${encodeURIComponent('/tasks?state=done')}`);
    await screen.findByRole('heading', { level: 1, name: /README/ });
    const crumbs = document.querySelector('[data-breadcrumb]') as HTMLElement;
    expect(within(crumbs).getByRole('link', { name: '回任务列表' }).getAttribute('href')).toBe(
      '/tasks?state=done',
    );
    expect(crumbs.querySelector('[aria-current="page"]')?.textContent).toBe('#9');
    expect(screen.queryByText('回任务列表')).toBeNull();
    // 页头右边只剩任务的动作和刷新，没有第三种按钮
    const actions = document.querySelector('[data-page-actions]') as HTMLElement;
    expect(within(actions).queryByRole('link')).toBeNull();
  });

  test('别处进来：第一级是「主页」', async () => {
    open('/tasks/t-c9');
    await screen.findByRole('heading', { level: 1, name: /README/ });
    const crumbs = document.querySelector('[data-breadcrumb]') as HTMLElement;
    expect(within(crumbs).getByRole('link', { name: '回主页' }).getAttribute('href')).toBe('/');
  });
});

describe('老流程的会话那一块已经不在', () => {
  test('t-12 只剩三段：页面上没有「老流程的会话」，也没有「时间与用量」「会话时间线」', async () => {
    open('/tasks/t-12');
    expect(await screen.findByRole('heading', { name: '三段' })).toBeTruthy();
    expect(screen.queryByText('老流程的会话')).toBeNull();
    expect(screen.queryByRole('heading', { name: '时间与用量' })).toBeNull();
    expect(screen.queryByRole('heading', { name: '会话时间线' })).toBeNull();
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
    segmentRuns,
    usage: summarizeUsage(segmentRuns),
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

describe('预算用量（#2859）：写在「输入当量」那一格的小字里，不另开一格', () => {
  const big = { ...base, inputTokens: 2_000_000 };

  test('统计卡四张：没有「折算 token」；输入当量的小字写预算用了百分之几和上限，不截断', async () => {
    open('/tasks/t-x', apiWith(detailWith([big])));
    const box = await panel('三段');
    expect(screen.queryByText('折算 token')).toBeNull();
    expect(document.querySelector('[data-segment-stats] .grid')?.children.length).toBe(4);
    const figure = screen.getByText('输入当量').closest('[data-figure]') as HTMLElement;
    // 2,000,000 + 500 × 5 + 2000 × 1.25 + 30000 × 0.1 = 2,008,000，占 700 万的 29%
    expect(figure.querySelector('.num')?.textContent).toBe('200.8 万');
    const hint = figure.querySelector('[data-figure-hint]') as HTMLElement;
    expect(hint.textContent).toContain('预算用了 29%（上限 700 万）');
    // 小字换行，不用省略号截断
    expect(hint.className).not.toContain('truncate');
    expect(hint.className).toContain('break-words');
    // 原始的两格还在
    expect(within(segmentRow(box, 'manual')).getByText('200.0 万 / 500')).toBeTruthy();
  });

  test('有一次没读到：「另有 N 次 token 没读到」那句照留，预算用量也写', async () => {
    const unread = { ...big, id: 'x-2', inputTokens: undefined, outputTokens: undefined };
    open('/tasks/t-x', apiWith(detailWith([big, unread])));
    await panel('三段');
    const figure = screen.getByText('输入当量').closest('[data-figure]') as HTMLElement;
    const hint = figure.querySelector('[data-figure-hint]')?.textContent ?? '';
    expect(hint).toContain('预算用了');
    expect(hint).toContain('另有 1 次 token 没读到，没算进来');
  });

  test('超了上限：照写超过 100% 的数，不封顶', async () => {
    open('/tasks/t-x', apiWith(detailWith([{ ...base, inputTokens: 9_000_000 }])));
    await panel('三段');
    const figure = screen.getByText('输入当量').closest('[data-figure]') as HTMLElement;
    expect(figure.querySelector('[data-figure-hint]')?.textContent).toContain('预算用了 129%（上限 700 万）');
  });

  test('四样没读全：输入当量收成一行灰字，不写 0，也不出预算用量', async () => {
    const blank = { ...base, cacheReadTokens: undefined, cacheWriteTokens: undefined };
    open('/tasks/t-x', apiWith(detailWith([blank])));
    await panel('三段');
    expect(screen.queryByText('折算 token')).toBeNull();
    expect(document.querySelector('[data-stats-unread]')?.textContent).toMatch(/输入当量没读到/);
    expect(document.body.textContent).not.toContain('预算用了');
  });
});

describe('【失败】读不到的都写明，不写 0', () => {
  test('段名认不出：单列一组「段名认不出」，那一笔写明原样', async () => {
    open('/tasks/t-x', apiWith(detailWith([base, { ...base, id: 'x-2', segment: 'fusion-execute' }])));
    const box = await panel('三段');
    expect(within(segmentRow(box, 'unknown')).getAllByText('段名认不出').length).toBeGreaterThan(0);
    const runs = await panel('每一笔');
    expect(within(runRow(runs, 'x-2')).getByText(/段名「fusion-execute」认不出/)).toBeTruthy();
    // 段标签用提醒色：断言 Tag 的 data-tone，不断言类名
    const tag = within(runRow(runs, 'x-2')).getByText('段名认不出');
    expect(tag.getAttribute('data-tone')).toBe('stall');
  });

  test('起止缺一头（单子结束了这一段还开着）：耗时写「没读到」，原因写在那一笔下面', async () => {
    const { endedAt: _e, outcome: _o, ...open_ } = base;
    open('/tasks/t-x', apiWith(detailWith([{ ...open_, id: 'x-3' }], 'done')));
    const runs = await panel('每一笔');
    const row = runRow(runs, 'x-3');
    expect(row.querySelector('[data-unread-item="time"]')).toBeTruthy();
    expect(within(row).getByText(/单子已经结束，这一段没记结束时刻/)).toBeTruthy();
    const box = await panel('三段');
    expect(segmentRow(box, 'manual').querySelectorAll('[data-unread]').length).toBeGreaterThan(0);
    expect(box.querySelector('[data-unread-notice]')?.textContent).toMatch(/没读到：耗时/);
  });

  test('会话号没拿到：这一笔写「读不到」，用量那一行不是空的', async () => {
    const blank = {
      ...base,
      id: 'x-unread',
      outcome: 'killed' as const,
      usageNote: USAGE_SESSION_UNREAD,
      failureReason: '引擎重启时这一段还没收场',
      inputTokens: undefined,
      outputTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
      costUsd: undefined,
    };
    open('/tasks/t-x', apiWith(detailWith([blank])));
    const row = runRow(await panel('每一笔'), 'x-unread');
    expect(row.querySelector('[data-usage-unread]')?.textContent).toBe(USAGE_BOARD_UNREAD);
    expect(within(row).getByText(USAGE_BOARD_UNREAD)).toBeTruthy();
    const notes = [...row.querySelectorAll('[data-unread-item]')].map((n) => n.textContent);
    expect(notes).toEqual([`token · ${USAGE_BOARD_UNREAD}`, `花费 · ${USAGE_BOARD_UNREAD}`]);
    expect(row.textContent).not.toContain('四样 token 都没记到');
  });

  test('确定没跑起来、记了 0：这一笔写 0，不写「读不到」、也不留空', async () => {
    const zero = {
      ...base,
      id: 'x-zero',
      outcome: 'org_switch' as const,
      usageNote: USAGE_NOTE_MASTER_OFF,
      failureReason: '引擎总开关：总开关关着；这一段没起会话（还没起会话）',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    };
    open('/tasks/t-x', apiWith(detailWith([zero])));
    const row = runRow(await panel('每一笔'), 'x-zero');
    expect(within(row).getByText('输入 0')).toBeTruthy();
    expect(within(row).getByText('输出 0')).toBeTruthy();
    expect(row.querySelector('[data-usage-unread]')).toBeNull();
    expect(row.querySelector('[data-unread-item="tokens"]')).toBeNull();
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
    // 一笔里没读到的几项并成一行，不是一项一行
    expect(runRow(runs, 'x-4').querySelectorAll('[data-unread-line]')).toHaveLength(1);
    const box = await panel('三段');
    const manual = segmentRow(box, 'manual');
    // token、缓存、当量、花费四格各写一次没读到（只有一个模型，不再多一行）；没有哪格写成 0
    // 花费那格另写为什么也估不了（token 没读全，按目录单价估不出来），不拿 0 顶
    // 格子里只留 —（原因在 title 和每一笔里），一个区块只出一条 Notice 说哪几项没读到
    expect([...manual.querySelectorAll('[data-unread]')].map((n) => n.textContent)).toEqual([
      '—',
      '—',
      '—',
      '—',
    ]);
    expect(within(box).queryByText('没读到')).toBeNull();
    const notice = box.querySelector('[data-unread-notice]');
    expect(notice?.textContent).toMatch(/没读到：token、缓存、当量、花费/);
    expect(box.querySelectorAll('[data-unread-notice]')).toHaveLength(1);
    expect(within(manual).queryByText('0 / 0')).toBeNull();
    expect(within(manual).queryByText('0')).toBeNull();
    // 合计顶格没读到的收成一行灰字，不再各占大格（#1751）
    const unread = document.querySelector('[data-stats-unread]');
    expect(unread?.textContent).toMatch(/输入当量没读到/);
    expect(unread?.textContent).toMatch(/花费/);
    expect(document.querySelector('[data-segment-stats] .text-display')?.textContent).not.toBe('没读到');
  });

  test('动手段下面写为什么派这个模型；没记的写「没记」，不留空白', async () => {
    open(
      '/tasks/t-x',
      apiWith(
        detailWith([
          { ...base, routeWhy: '主力档，强级在前；opus 难单一段过 2/4' },
          { ...base, id: 'x-2' },
          { ...base, id: 'x-3', segment: 'verify', tier: undefined },
        ]),
      ),
    );
    const runs = await panel('每一笔');
    expect(runRow(runs, 'x-1').querySelector('[data-route-why]')?.textContent).toBe(
      '为什么派它：主力档，强级在前；opus 难单一段过 2/4',
    );
    expect(runRow(runs, 'x-2').querySelector('[data-route-why]')?.textContent).toBe('为什么派它：没记');
    expect(runRow(runs, 'x-3').querySelector('[data-route-why]')).toBeNull();
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
    // 没有真读不到的项，就不出那条 Notice
    expect(document.querySelector('[data-unread-notice]')).toBeNull();
  });
});

describe('在跑任务详情首屏（#1751）', () => {
  test('在跑任务详情首屏先出现状态和 PR 号', async () => {
    const { endedAt: _e, outcome: _o, ...live } = base;
    open('/tasks/t-x', apiWith(detailWith([{ ...live, id: 'x-run', prNumber: 1730, costUsd: undefined }])));
    await waitFor(() => expect(document.querySelector('[data-now-banner]')).not.toBeNull());
    const nowBanner = document.querySelector('[data-now-banner]') as HTMLElement;
    expect(nowBanner.textContent).toContain('在干活');
    expect(nowBanner.textContent).toMatch(/已跑/);
    expect(nowBanner.textContent).toContain('PR #1730');
    const stats = document.querySelector('[data-segment-stats]');
    expect(stats).toBeTruthy();
    // 首屏：当前状态条在花费/当量合计之前
    expect(nowBanner.compareDocumentPosition(stats as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('首屏结论块（#1920，照路由页样板）', () => {
  test('一句结论加一个状态，下一行灰字写仓#单号、开单、PR；两行都不折，整句在悬停里；页头不再重复一行状态', async () => {
    open('/tasks/t-c9');
    await screen.findByRole('heading', { level: 1, name: /README/ });
    const hero = document.querySelector('[data-now-banner]') as HTMLElement;
    const line = hero.querySelector('[data-hero-line]') as HTMLElement;
    expect(line.className).toContain('whitespace-nowrap');
    expect(line.className).toContain('text-heading');
    expect(line.getAttribute('title')).toMatch(/^做完了/);
    expect(line.querySelectorAll('[data-tone][data-variant]')).toHaveLength(1);
    const notes = hero.querySelector('[data-hero-notes]') as HTMLElement;
    expect(notes.className).toContain('whitespace-nowrap');
    expect(notes.textContent).toContain('acme/orbit-canary#9');
    expect(notes.textContent).toMatch(/开单/);
    expect(notes.textContent).toContain('PR #12');
    // 「已完成」只在结论块里出现一次（原来页头说明和首屏状态条各一枚）
    expect(screen.getAllByText('已完成')).toHaveLength(1);
    // 各块的长说明收进页头 ⓘ
    expect(document.querySelector('[data-description-hint]')).not.toBeNull();
  });

  test('在跑的单：结论写哪一段、哪个模型、已跑多久', async () => {
    const { endedAt: _e, outcome: _o, ...live } = base;
    open('/tasks/t-x', apiWith(detailWith([{ ...live, id: 'x-run' }])));
    await waitFor(() => expect(document.querySelector('[data-hero-line]')).not.toBeNull());
    expect(document.querySelector('[data-hero-text]')?.textContent).toMatch(
      /^动手中：Opus 5\.5，已跑 30 分钟/,
    );
  });

  test('读成过、刷新没读成：上一次读到的照旧画着，顶上横幅写明并带重试', async () => {
    const api = createMockApi({ live: false });
    const real = api.task.bind(api);
    let fail = false;
    api.task = (id) => (fail ? Promise.reject(new Error('后端出错了')) : real(id));
    open('/tasks/t-c9', api);
    await screen.findByRole('heading', { name: '每一笔' });
    fail = true;
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    // 「三段」顶上本来就有一条没读到的提醒（也是 alert），按字找这一条
    const text = await screen.findByText(/这张单刷新没读成，下面是上一次读到的/, undefined, {
      timeout: 8000,
    });
    const alert = text.closest('[role="alert"]') as HTMLElement;
    expect(alert.textContent).toContain('后端出错了');
    expect(screen.getByRole('heading', { name: '每一笔' })).toBeTruthy();
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.queryByText(/刷新没读成/)).toBeNull());
  }, 15000);
});

describe('任务页上的暂停、继续、叫停（#820 片 3，#856 第 1 处）', () => {
  const actionBox = async () => {
    await screen.findByRole('heading', { level: 1 });
    return document.querySelector('[data-task-actions]') as HTMLElement | null;
  };

  test('在跑的单：只给暂停、叫停，不画继续；没有换模型', async () => {
    open('/tasks/t-12');
    await waitFor(async () => expect(await actionBox()).not.toBeNull());
    const box = (await actionBox()) as HTMLElement;
    expect([...box.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['暂停', '叫停']);
    expect(within(box).queryByRole('button', { name: '继续' })).toBeNull();
    expect(within(box).queryByText('换模型')).toBeNull();
  });

  test('点暂停、选「做完这一段再停」：页上写「已暂停」和原因（等待色，不是失败红），不再画「暂停」；点继续后恢复', async () => {
    const api = createMockApi({ live: false });
    open('/tasks/t-12', api);
    await waitFor(async () => expect(await actionBox()).not.toBeNull());
    fireEvent.click(within((await actionBox()) as HTMLElement).getByRole('button', { name: '暂停' }));
    fireEvent.click(await screen.findByRole('button', { name: '做完这一段再停' }));
    await waitFor(() => expect(document.querySelector('[data-paused-note]')).not.toBeNull());
    // 标题说明和首屏状态条各有一枚「已暂停」芯片（#1751）
    expect(screen.getAllByText('已暂停').length).toBeGreaterThanOrEqual(1);
    expect(document.querySelector('[data-paused-note]')?.textContent).toContain('已暂停：被人暂停');
    const box = (await actionBox()) as HTMLElement;
    expect([...box.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['继续', '叫停']);
    expect(within(box).queryByRole('button', { name: '暂停' })).toBeNull();
    fireEvent.click(within(box).getByRole('button', { name: '继续' }));
    await waitFor(() => expect(document.querySelector('[data-paused-note]')).toBeNull());
    const again = (await actionBox()) as HTMLElement;
    expect([...again.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['暂停', '叫停']);
    expect(within(again).queryByRole('button', { name: '继续' })).toBeNull();
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
      expect(box && [...box.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['暂停', '叫停']);
    });
  });
});
