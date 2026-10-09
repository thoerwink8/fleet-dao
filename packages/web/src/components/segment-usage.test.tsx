// @vitest-environment happy-dom
// 任务页花费一格（#1496）：按量、套餐内折合上下两行各带标签；大字只给按量真花的钱。
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { createMockApi } from '../api/mock/server';
import { SegmentBreakdown, SegmentStats } from './segment-usage';

afterEach(cleanup);

describe('花费一格两行', () => {
  test('按量和套餐内折合两个标签都在，上下排列，大字只在按量那一行', async () => {
    const d = await createMockApi({ live: false }).task('t-12');
    render(<SegmentStats d={d} now={Date.now()} />);
    const metered = screen.getByText('按量');
    const folded = screen.getByText('套餐内折合');
    const lines = document.querySelector('[data-cost]');
    expect(lines?.className).toContain('flex-col');
    expect(metered.nextElementSibling?.className).toContain('text-stat');
    expect(folded.parentElement?.className ?? '').not.toContain('text-stat');
  });
});

describe('三段表耗时列', () => {
  test('「在跑 40 分钟」整句不换行，列宽跟内容走', async () => {
    const t = Date.parse('2026-10-10T12:00:00Z');
    const d = await createMockApi({ live: false, now: () => t }).task('t-12');
    render(<SegmentBreakdown d={d} now={t} />);
    const note = screen.getByText('在跑 40 分钟');
    expect(note.closest('.whitespace-nowrap'), '耗时格要带 whitespace-nowrap').toBeTruthy();
    const row = note.closest('[data-segment="manual"]')?.firstElementChild;
    expect(row?.className).toContain('md:grid-cols-segments');
  });
});
