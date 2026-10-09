// @vitest-environment happy-dom
// 任务页花费一格（#1496）：按量、套餐内折合上下两行各带标签；大字只给按量真花的钱。
// 三段表耗时列（#1533）：字不换行；列宽是各行共用的固定长度，不用 max-content。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { createMockApi } from '../api/mock/server';
import { SegmentBreakdown, SegmentStats } from './segment-usage';

/** grid-cols-segments 写在 app.css 里的那一行列宽（空白折成一行）。读不到就失败，不当成没有这条规则。 */
function segmentColumns(): string {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../app.css'), 'utf8');
  const start = css.indexOf('@utility grid-cols-segments');
  if (start < 0) throw new Error('app.css 里没有 grid-cols-segments');
  const next = css.indexOf('@utility', start + 1);
  const block = css.slice(start, next === -1 ? undefined : next);
  const found = block.match(/grid-template-columns:\s*([\s\S]*?);/);
  if (!found?.[1]) throw new Error('grid-cols-segments 没有写出列宽');
  return found[1].replace(/\s+/g, ' ').trim();
}

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
  test('「在跑 40 分钟」不换行；表头、段行、模型行共用固定耗时列，不用 max-content', async () => {
    const t = Date.parse('2026-10-10T12:00:00Z');
    const d = await createMockApi({ live: false, now: () => t }).task('t-12');
    const manual = d.usage.bySegment.find((s) => s.segment === 'manual');
    const first = manual?.byModel[0];
    if (!manual || !first) throw new Error('t-12 动手段没有模型行，造不出第二行');
    manual.byModel.push({ ...first, model: 'gpt-5.6-luna', modelName: 'GPT 5.6 Luna' });
    render(<SegmentBreakdown d={d} now={t} />);

    const notes = screen.getAllByText('在跑 40 分钟');
    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes) {
      const line = note.closest('.whitespace-nowrap');
      expect(line, '耗时格要带 whitespace-nowrap').toBeTruthy();
      // 电脑上 min-w-0：长句子不能把这一行的固定耗时列撑得比表头宽，否则后面的列错位。
      expect(line?.parentElement?.className ?? '').toContain('md:min-w-0');
    }
    const note = notes[0];
    if (!note) throw new Error('没有「在跑 40 分钟」');

    const header = screen.getByText('段 / 模型').parentElement;
    const segmentRow = note.closest('[data-segment="manual"]')?.firstElementChild;
    const modelRow = document.querySelector('li[data-model]');
    for (const row of [header, segmentRow, modelRow]) {
      expect(row?.className ?? '', '表头、段行、模型行要同一套列宽').toContain('md:grid-cols-segments');
    }
    // 表头格子也要能缩到列宽以下，否则「token（输入 / 输出）」的最小内容会把表头的列撑得比数据行宽。
    expect(header?.className ?? '').toContain('[&>span]:min-w-0');

    // 耗时是第 4 列，固定长度。max-content 会按本行内容各算各的，表头和数据行对不齐。
    const columns = segmentColumns();
    expect(columns).toBe(
      'minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr) 8.5rem minmax(0, 2fr) minmax(0, 2fr) minmax(0, 1fr) minmax(0, 2fr)',
    );
    expect(columns).not.toContain('max-content');
  });
});
