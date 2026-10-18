// @vitest-environment happy-dom
// 任务页的概览和「过程」（#3140）：结论汇报、命令计数、PR 横条、改动文件折叠卡；回合 → 笔 → 步骤 → 调用四层。
// 老后端没给、哪一块读不到都写「没读到」和原因，不画 0。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, test } from 'vitest';
import TaskPage from '../routes/task';
import { renderApp } from './harness';

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
});

function open(route: string, search = '') {
  window.history.replaceState({}, '', `/${search}`);
  return renderApp(
    <Routes>
      <Route path="/tasks/:taskId" element={<TaskPage />} />
    </Routes>,
    { route },
  );
}

const found = async <T extends Element = HTMLElement>(selector: string, root: ParentNode = document) =>
  waitFor(() => {
    const el = root.querySelector(selector);
    if (!el) throw new Error(`${selector} 还没出来`);
    return el as unknown as T;
  });

describe('概览：汇报、命令计数、PR、改动文件', () => {
  test('t-c9：最新汇报（最近一笔动手的最后一句话）、命令计数（只有失败数标红）、PR 横条、改动卡', async () => {
    open('/tasks/t-c9');
    const box = await found('[data-task-summary]');
    const report = await found('[data-task-report]', box);
    expect(report.textContent).toContain('测试里写死了旧标签');
    expect(report.textContent).toContain('来自动手第 2 次');
    const line = await found('[data-progress-line]', box);
    expect(line.textContent).toContain('个命令已完成');
    expect(within(line).getByText('1 个失败').className).toContain('text-ink-fail');
    expect(line.textContent).toContain('读了 1 次文件');
    // PR 横条：号、仓、分支、状态
    const pr = await found('[data-pr="12"]', box);
    expect(pr.getAttribute('data-pr-state')).toBe('merged');
    expect(pr.textContent).toContain('#12');
    expect(pr.textContent).toContain('agent/9-readme-tz');
    expect(within(pr).getByText('已合并')).toBeTruthy();
    expect(pr.className).toContain('bg-st-human-soft');
  });

  test('改动卡：数字来自按头记的 numstat；只露前 3 个，其余点「还有 N 个文件」；二进制不写 +/-', async () => {
    open('/tasks/t-c9');
    const card = await found('[data-changed-files]');
    expect(card.textContent).toContain('已编辑 5 个文件');
    // 32 行增、4 行删（二进制不计）
    expect(card.textContent).toContain('+32');
    expect(card.textContent).toContain('-4');
    expect(card.textContent).toContain('PR #12');
    expect(card.querySelectorAll('[data-file]')).toHaveLength(3);
    expect(card.querySelector('[data-file="scripts/stamp.ts"]')?.textContent).toContain('+6');
    // 记的头就是 PR 现在的头：不标「不是最新的头」
    expect(card.querySelector('[data-files-stale]')).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: '还有 2 个文件' }));
    expect(card.querySelectorAll('[data-file]')).toHaveLength(5);
    expect(card.querySelector('[data-file="assets/stamp-preview.png"]')?.textContent).toContain('二进制');
    expect(card.querySelector('[data-file="assets/stamp-preview.png"] [data-diff-stat]')).toBeNull();
    // 点文件行：说明这里不存 diff 正文，完整 diff 在 PR 页
    fireEvent.click(card.querySelector('[data-file="scripts/stamp.ts"] button') as HTMLElement);
    expect(card.querySelector('[data-file-detail]')?.textContent).toContain('不存 diff 正文');
  });

  test('没记过改动文件的 PR：写原因，不画 0 个文件', async () => {
    open('/tasks/t-12');
    // t-12 没有 PR，不画改动卡也不画「0 个文件」
    await found('[data-task-summary]');
    expect(document.querySelector('[data-changed-files]')).toBeNull();
    expect(document.querySelector('[data-task-summary]')?.textContent).not.toContain('已编辑 0 个文件');
  });
});

describe('过程：回合 → 笔 → 步骤 → 调用', () => {
  test('t-c9：两个回合，第 2 回合是返工，顶上写为什么返工；超时的第 1 回合标红', async () => {
    open('/tasks/t-c9');
    const proc = await found('[data-task-process]');
    const r1 = await found('[data-round-header="1"]', proc);
    const r2 = await found('[data-round-header="2"]', proc);
    expect(r1.textContent).toContain('第 1 回合');
    expect(r1.textContent).toContain('超时');
    expect(r2.textContent).toContain('第 2 回合');
    expect(r2.textContent).toContain('返工');
    expect(r2.textContent).toContain('做成了');
    expect(r2.querySelector('[data-rework-why]')?.textContent).toContain('上一回合超时');
    expect(r2.querySelector('[data-rework-why]')?.textContent).toContain('30 分钟没交活');
    // 第 1 回合没有「为什么返工」
    expect(r1.querySelector('[data-rework-why]')).toBeNull();
  });

  test('每一笔：为什么起、新会话还是接上一笔、结局、用时；摘要在第二行', async () => {
    open('/tasks/t-c9');
    const a = await found('[data-run-process="seg-c9-2"]');
    expect(a.querySelector('[data-run-cause]')?.textContent).toBe('主写');
    expect(a.querySelector('[data-run-link]')?.textContent).toBe('新会话');
    expect(a.textContent).toContain('超时');
    expect(a.querySelector('[data-run-cause-summary]')?.textContent).toContain('北京时间');
    const b = await found('[data-run-process="seg-c9-3"]');
    expect(b.querySelector('[data-run-cause]')?.textContent).toBe('换路由重派');
    expect(b.querySelector('[data-run-link]')?.textContent).toBe('新会话');
    // 验收那一笔不写起因（本来就没有），也不写成「老记录没记」；验收通过写在里面
    const v = await found('[data-run-process="seg-c9-4"]');
    expect(v.querySelector('[data-run-cause]')).toBeNull();
    expect(v.querySelector('[data-verdict]')?.textContent).toContain('验收通过');
    // 对题那一笔也不写起因
    const s = await found('[data-run-process="seg-c9-1"]');
    expect(s.querySelector('[data-run-cause]')).toBeNull();
  });

  test('笔之间引擎做的事：自测、推分支、开 PR、等 CI、验收、合并；连着的等待折成一行', async () => {
    open('/tasks/t-c9');
    const proc = await found('[data-task-process]');
    await found('[data-engine="selfCheck"]', proc);
    for (const a of ['pushBranch', 'openPr', 'waitCi', 'coldVerify', 'armAutoMerge', 'waitMerged']) {
      expect(proc.querySelector(`[data-engine="${a}"]`), a).toBeTruthy();
    }
    expect(proc.querySelector('[data-engine="selfCheck"]')?.textContent).toContain('引擎：自测');
    const waits = proc.querySelectorAll('[data-waits="memory"]');
    expect(waits).toHaveLength(1);
    expect(waits[0]?.textContent).toMatch(/等内存 3 次，共 /);
    // 等内存是在等着开第 2 回合的笔：归第 2 回合，不归第 1 回合
    const r2 = proc.querySelector('[data-round-header="2"]')?.parentElement as HTMLElement;
    expect(r2.querySelector('[data-waits="memory"]')).toBeTruthy();
  });

  test('有失败的笔自动展开，步骤里有失败的自动展开、标红；点开才读那一步的调用', async () => {
    open('/tasks/t-c9');
    const run = await found('[data-run-process="seg-c9-3"]');
    await waitFor(() => expect(run.querySelectorAll('[data-step]').length).toBe(3));
    const steps = run.querySelectorAll('[data-step]');
    const first = steps[0] as HTMLElement;
    expect(first.querySelector('[data-step-title]')?.textContent).toBe('先看 README 里这一行是怎么生成的。');
    expect(first.querySelector('[data-step-time]')?.textContent).toMatch(/^\d\d:\d\d:\d\d–\d\d:\d\d:\d\d$/);
    expect(first.querySelector('[data-step-duration]')?.textContent).toMatch(/^用时 /);
    expect(first.getAttribute('data-failed')).toBeNull();
    expect(first.querySelector('[data-step-calls]')).toBeNull();
    const second = steps[1] as HTMLElement;
    expect(second.getAttribute('data-failed')).toBe('');
    expect(second.querySelector('[data-step-failed-count]')?.textContent).toBe('1 个失败');
    const failed = await found('[data-call][data-failed]', second);
    expect(failed.textContent).toContain('运行失败');
    expect(failed.textContent).toContain('npx vitest run');
    expect(second.textContent).toContain('已编辑');
    // 点开第 1 步才读它的调用
    fireEvent.click(within(first).getAllByRole('button')[0] as HTMLElement);
    await waitFor(() => expect(first.querySelector('[data-step-calls]')).toBeTruthy());
    await waitFor(() => expect(first.textContent).toContain('已读取'));
  });

  test('时间条：每一笔一段，超时的那段标红；点一段跳到那一笔', async () => {
    open('/tasks/t-c9');
    const bar = await found('[data-run-bar]');
    expect(bar.querySelectorAll('[data-bar-run]').length).toBeGreaterThanOrEqual(2);
    expect(bar.querySelector('[data-bar-run="seg-c9-2"]')?.className).toContain('bg-st-fail');
    expect(bar.querySelector('[data-bar-run="seg-c9-3"]')?.className).toContain('bg-border-strong');
  });

  test('跑在记录之前的那一笔：写「没有过程记录」，不画成 0 步', async () => {
    open('/tasks/t-c9');
    const run = await found('[data-run-process="seg-c9-4"]');
    expect((await found('[data-no-record]', run)).textContent).toContain('没有过程记录');
    expect(run.querySelectorAll('[data-step]')).toHaveLength(0);
  });

  test('在跑的那一笔（t-12 第 2 回合，接上一笔的会话）：最后一步标「在跑」、默认展开；第 1 回合 CI 红', async () => {
    open('/tasks/t-12');
    const run = await found('[data-run-process="seg-t-12-manual-40"]');
    expect(run.querySelector('[data-run-link]')?.textContent).toBe('接上一笔的会话');
    expect(run.querySelector('[data-run-cause]')?.textContent).toBe('CI 红了返工');
    const live = await found('[data-step][data-running]', run);
    expect(within(live).getByText('在跑')).toBeTruthy();
    expect(live.querySelector('[data-step-duration]')?.textContent).toMatch(/^用时 /);
    const r1 = await found('[data-round-header="1"]');
    expect(r1.textContent).toContain('CI 红了');
    // 第 2 回合还没收场：写「进行中」，不编结局
    const r2 = await found('[data-round-header="2"]');
    expect(r2.textContent).toContain('进行中');
    expect(r2.querySelector('[data-rework-why]')?.textContent).toContain('字段名对不上');
  });

  test('没记回合的老记录（t-14）：单列「更早的几笔」，写老记录没记回合；动手的笔写「老记录没记起因」', async () => {
    open('/tasks/t-14');
    const head = await found('[data-round-header="old"]');
    expect(head.textContent).toContain('更早的几笔');
    expect(head.textContent).toContain('老记录没记回合');
    const manual = document.querySelector('[data-run-process="seg-t-14-manual-170"]') as HTMLElement;
    expect(manual.querySelector('[data-run-cause]')?.textContent).toBe('老记录没记起因');
    expect(manual.querySelector('[data-run-link]')).toBeNull();
  });
});

describe('读不到：写原因，不画 0', () => {
  test('老后端没有 overview：概览写「这台后端还没有任务概览」，过程写没有回合这些项', async () => {
    open('/tasks/t-c9', '?mockOverview=old');
    const box = await found('[data-task-summary]');
    expect(box.textContent).toContain('这台后端还没有任务概览');
    expect(box.querySelector('[data-progress-line]')).toBeNull();
    const proc = await found('[data-task-process]');
    expect(proc.textContent).toContain('这台后端还没有「回合」「引擎做的事」这些项');
    // 笔还在，只是不分回合
    expect(proc.querySelector('[data-run-process="seg-c9-3"]')).toBeTruthy();
  });

  test('会话内容读不到：汇报、命令计数、回合、引擎做的事各写各的原因；PR 条照样给', async () => {
    open('/tasks/t-c9', '?mockOverview=unread');
    const box = await found('[data-task-summary]');
    await waitFor(() => expect(box.textContent).toContain('最新汇报没读到'));
    expect(box.textContent).toContain('命令计数没读到');
    expect(box.textContent).toContain('connection terminated');
    expect(box.querySelector('[data-progress-line]')).toBeNull();
    expect(box.querySelector('[data-changed-files]')).toBeNull();
    expect(box.querySelector('[data-pr="12"]')).toBeTruthy();
    // 改动文件读不到：写在该 PR 下面
    expect(box.querySelector('[data-changed-unread="12"]')?.textContent).toContain('没读到');
    const proc = await found('[data-task-process]');
    expect(proc.textContent).toContain('回合没读到');
    expect(proc.textContent).toContain('引擎做的事没读到');
    // 回合表读不到：笔上自己记着回合号就照它归，但不替回合编结局、不写「进行中」
    const r2 = await found('[data-round-header="2"]', proc);
    expect(r2.textContent).not.toContain('进行中');
    expect(r2.textContent).not.toContain('做成了');
  });

  test('这个 PR 没记过改了哪些文件（在记这个账之前推的）：写原因，不画「0 个文件」', async () => {
    open('/tasks/t-14');
    await found('[data-task-summary]');
    const box = document.querySelector('[data-task-summary]') as HTMLElement;
    expect(box.textContent).not.toContain('已编辑 0 个文件');
    expect(screen.queryByText(/已编辑 0/)).toBeNull();
  });
});
