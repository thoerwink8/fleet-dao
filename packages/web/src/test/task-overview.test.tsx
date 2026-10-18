// @vitest-environment happy-dom
// 任务页的概览和「过程」（#3140）：结论汇报、命令计数、PR 横条、改动文件折叠卡、段 → 步骤 → 调用三层；
// 老后端没给、会话内容读不到都写「没读到」和原因，不画 0。
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

const summary = async () => {
  const el = await waitFor(() => {
    const found = document.querySelector('[data-task-summary]');
    if (!found) throw new Error('概览还没出来');
    return found as HTMLElement;
  });
  return el;
};

describe('概览：汇报、命令计数、PR、改动文件', () => {
  test('t-c9：最新有记录那一笔的结论、命令计数（只有失败数标红）、PR 横条、改动卡', async () => {
    open('/tasks/t-c9');
    const box = await summary();
    // 最后一笔（验收）跑在记录之前，汇报往前取最近有记录的那笔（动手第 2 次）
    const report = await waitFor(() => {
      const r = box.querySelector('[data-task-report]');
      if (!r) throw new Error('汇报还没出来');
      return r as HTMLElement;
    });
    expect(report.textContent).toContain('已提交 4c1d2ab');
    expect(report.textContent).toContain('动手第 2 次');
    const line = box.querySelector('[data-progress-line]') as HTMLElement;
    expect(line.textContent).toContain('3 个命令已完成');
    expect(within(line).getByText('1 个失败').className).toContain('text-ink-fail');
    expect(line.textContent).toContain('读了 1 个文件');
    // PR 横条：号、仓、分支、状态
    const pr = box.querySelector('[data-pr="12"]') as HTMLElement;
    expect(pr.getAttribute('data-pr-state')).toBe('merged');
    expect(pr.textContent).toContain('#12');
    expect(pr.textContent).toContain('agent/9-readme-tz');
    expect(within(pr).getByText('已合并')).toBeTruthy();
    // 改动卡：总数、每个文件 +/-
    const card = box.querySelector('[data-changed-files]') as HTMLElement;
    expect(card.textContent).toContain('已编辑 3 个文件');
    expect(card.textContent).toContain('+31');
    expect(card.textContent).toContain('-3');
    expect(card.querySelectorAll('[data-file]')).toHaveLength(3);
    expect(card.querySelector('[data-file="scripts/stamp.ts"]')?.textContent).toContain('+6');
  });

  test('改动卡只露前 3 个，其余点「还有 N 个文件」才出来；点文件行展开说明', async () => {
    open('/tasks/t-c9');
    const box = await summary();
    const card = await waitFor(() => {
      const c = box.querySelector('[data-changed-files]');
      if (!c) throw new Error('改动卡还没出来');
      return c as HTMLElement;
    });
    // 3 个文件没有「还有」按钮
    expect(within(card).queryByText(/还有 \d+ 个文件/)).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: /stamp\.ts/ }));
    expect(card.querySelector('[data-file-detail]')?.textContent).toContain('会话里改了 1 次');
    expect(card.querySelector('[data-file-detail]')?.textContent).toContain('PR #12');
  });
});

describe('过程：段 → 步骤 → 单个调用', () => {
  test('有失败的步骤自动展开、其余收着；点开才读那一步的调用；调用一行动词开头，失败的标红', async () => {
    open('/tasks/t-c9');
    const run = await waitFor(() => {
      const r = document.querySelector('[data-run-process="seg-c9-3"]');
      if (!r) throw new Error('这一笔的过程还没出来');
      return r as HTMLElement;
    });
    const steps = run.querySelectorAll('[data-step]');
    expect(steps).toHaveLength(3);
    // 标题是 Agent 那句话；起止时刻、用时、小计
    const first = steps[0] as HTMLElement;
    expect(first.querySelector('[data-step-title]')?.textContent).toBe('先看 README 里这一行是怎么生成的。');
    expect(first.querySelector('[data-step-time]')?.textContent).toMatch(/^\d\d:\d\d:\d\d–\d\d:\d\d:\d\d$/);
    expect(first.querySelector('[data-step-duration]')?.textContent).toMatch(/^用时 /);
    expect(first.textContent).toContain('读 1 个文件');
    expect(first.getAttribute('data-failed')).toBeNull();
    expect(first.querySelector('[data-step-calls]')).toBeNull();
    // 第 2 步有失败的命令：自动展开，失败标红
    const second = steps[1] as HTMLElement;
    expect(second.getAttribute('data-failed')).toBe('');
    expect(second.querySelector('[data-step-failed-count]')?.textContent).toBe('1 个失败');
    await waitFor(() => expect(second.querySelector('[data-step-calls]')).toBeTruthy());
    const failed = await waitFor(() => {
      const c = second.querySelector('[data-call][data-failed]');
      if (!c) throw new Error('失败的调用还没出来');
      return c as HTMLElement;
    });
    expect(failed.textContent).toContain('运行失败');
    expect(failed.textContent).toContain('npx vitest run');
    expect(second.textContent).toContain('已编辑');
    expect(second.textContent).toContain('+6');
    // 点开第 1 步：读它的调用
    fireEvent.click(within(first).getAllByRole('button')[0] as HTMLElement);
    await waitFor(() => expect(first.querySelector('[data-step-calls]')).toBeTruthy());
    await waitFor(() => expect(first.textContent).toContain('已读取'));
  });

  test('时间条：每步一段，失败的那段单独标出；点一段展开那一步', async () => {
    open('/tasks/t-c9');
    const run = await waitFor(() => {
      const r = document.querySelector('[data-run-process="seg-c9-3"]');
      if (!r) throw new Error('还没出来');
      return r as HTMLElement;
    });
    const bar = run.querySelector('[data-time-bar]') as HTMLElement;
    expect(bar.querySelectorAll('[data-bar-step]')).toHaveLength(3);
    expect(bar.querySelector('[data-bar-step="1"]')?.className).toContain('bg-st-fail');
    const third = run.querySelector('[data-step="2"]') as HTMLElement;
    expect(third.querySelector('[data-step-calls]')).toBeNull();
    fireEvent.click(bar.querySelector('[data-bar-step="2"]') as HTMLElement);
    await waitFor(() => expect(third.querySelector('[data-step-calls]')).toBeTruthy());
  });

  test('跑在记录之前的那一笔：写「没有过程记录」，不画成 0 步', async () => {
    open('/tasks/t-c9');
    const run = await waitFor(() => {
      const r = document.querySelector('[data-run-process="seg-c9-4"]');
      if (!r) throw new Error('还没出来');
      return r as HTMLElement;
    });
    expect(run.querySelector('[data-no-record]')?.textContent).toContain('没有过程记录');
    expect(run.querySelectorAll('[data-step]')).toHaveLength(0);
  });

  test('在跑的那一笔：最后一步标「在跑」、默认展开；没结果的命令算「正在运行」', async () => {
    open('/tasks/t-12');
    const run = await waitFor(() => {
      const r = document.querySelector('[data-run-process="seg-t-12-manual-40"]');
      if (!r) throw new Error('还没出来');
      return r as HTMLElement;
    });
    const live = run.querySelector('[data-step][data-running]') as HTMLElement;
    expect(live).toBeTruthy();
    expect(within(live).getByText('在跑')).toBeTruthy();
    expect(live.querySelector('[data-step-duration]')?.textContent).toMatch(/^用时 /);
  });
});

describe('读不到：写原因，不画 0', () => {
  test('老后端没有 overview：概览和过程各写一句「这台后端还没有…」', async () => {
    open('/tasks/t-c9', '?mockOverview=old');
    const box = await summary();
    expect(box.textContent).toContain('这台后端还没有任务概览');
    expect(box.querySelector('[data-progress-line]')).toBeNull();
    const proc = document.querySelector('[data-task-process]') as HTMLElement;
    expect(proc.textContent).toContain('这台后端还没有「过程」这一项');
  });

  test('会话内容读不到：概览和过程都写原因；PR 条照样给（状态来自镜像）', async () => {
    open('/tasks/t-c9', '?mockOverview=unread');
    const box = await summary();
    expect(box.textContent).toContain('汇报、命令和改动文件没读到');
    expect(box.textContent).toContain('connection terminated');
    expect(box.querySelector('[data-progress-line]')).toBeNull();
    expect(box.querySelector('[data-changed-files]')).toBeNull();
    expect(box.querySelector('[data-pr="12"]')).toBeTruthy();
    const proc = document.querySelector('[data-task-process]') as HTMLElement;
    expect(proc.textContent).toContain('过程没读到');
  });
});
