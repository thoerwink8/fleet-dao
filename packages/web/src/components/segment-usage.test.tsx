// @vitest-environment happy-dom
// 任务页花费一格（#1496）：大字只给按量真花的钱，套餐内折合写在下面的灰字里。
// 三段表（#1533）：耗时格字不换行；表头、段行、模型行是同一张表里的行，列一定对得齐（原来是各自一个 grid，要靠共用列宽守）。
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, test } from 'vitest';
import { createMockApi } from '../api/mock/server';
import { SegmentBreakdown, SegmentRunList, SegmentStats } from './segment-usage';

afterEach(cleanup);

describe('花费一格', () => {
  test('大字只在按量那一格（标签写「按量花费」）；套餐内折合另写一行灰字，不跟大字并排', async () => {
    const d = await createMockApi({ live: false }).task('t-12');
    // t-12 的三段流水只走套餐内。按量那一笔原先在老流程会话里，那一路已经不进用量，这里补上一笔按量才看得到大字。
    d.usage.total.cost.metered = { runs: 1, usd: 0.08, missing: 0 };
    render(<SegmentStats d={d} now={Date.now()} />);
    const metered = document.querySelector('[data-metered]');
    expect(screen.getByText('按量花费')).toBeTruthy();
    expect(metered?.getAttribute('data-large')).toBe('true');
    expect(metered?.textContent).toBe('$0.08');
    const folded = document.querySelector('[data-figure-hint="套餐内折合"]');
    expect(folded?.textContent).toContain('套餐内折合：');
    expect(folded?.hasAttribute('data-large')).toBe(false);
  });

  test('四样 token 都没读到：写另有 N 段读不到用量', async () => {
    const d = await createMockApi({ live: false }).task('t-12');
    d.usage.total.unreadSegments = 3;
    render(<SegmentStats d={d} now={Date.now()} />);
    expect(screen.getByText('另有 3 段读不到用量')).toBeTruthy();
  });
});

describe('三段表', () => {
  test('动手段显示没续上会话的原因', async () => {
    const d = await createMockApi({ live: false }).task('t-12');
    const manual = d.segmentRuns.find((run) => run.segment === 'manual');
    if (!manual) throw new Error('t-12 没有动手段');
    manual.resumeReason = '上一段没记下会话号';
    render(
      <MemoryRouter>
        <SegmentRunList d={d} now={Date.now()} onViewTranscript={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.getByText('为什么没续上：上一段没记下会话号')).toBeTruthy();
  });

  test('「在跑 40 分钟」不换行；表头、段行、模型行在同一张表里，格子数一样（列对得齐）', async () => {
    const t = Date.parse('2026-10-10T12:00:00Z');
    const d = await createMockApi({ live: false, now: () => t }).task('t-12');
    const manual = d.usage.bySegment.find((s) => s.segment === 'manual');
    const first = manual?.byModel[0];
    if (!manual || !first) throw new Error('t-12 动手段没有模型行，造不出第二行');
    manual.byModel.push({ ...first, model: 'gpt-5.6-luna', modelName: 'GPT 5.6 Luna' });
    render(<SegmentBreakdown d={d} now={t} />);

    const notes = screen.getAllByText('在跑 40 分钟');
    expect(notes.length).toBeGreaterThan(0);
    const note = notes[0];
    if (!note) throw new Error('没有「在跑 40 分钟」');
    // 表格的格子默认不折行（whitespace-nowrap 在 Table 里一处写好），长句子不会从「分钟」中间断开
    const cell = note.closest('td');
    expect(cell, '耗时在表格的格子里').toBeTruthy();
    expect(cell?.className ?? '').toContain('whitespace-nowrap');

    const table = note.closest('table');
    const headCells = table?.querySelectorAll('thead th').length ?? 0;
    expect(headCells).toBeGreaterThan(0);
    for (const key of ['manual', 'manual/gpt-5.6-luna']) {
      const row = table?.querySelector(`tr[data-row-key="${key}"]`);
      expect(row, `三段表里有 ${key} 这一行`).toBeTruthy();
      expect(row?.querySelectorAll('td').length, `${key} 这一行的格子数要和表头一样`).toBe(headCells);
    }
  });
});
