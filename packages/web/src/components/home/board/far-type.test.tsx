// @vitest-environment happy-dom
// 「远」档的字（单 #1819）：标题的字号类大于单号、标题最多两行；段节点按最长段名定宽，段名不带省略号。
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { farIdScreenPx, farTitleFontSize, farTitleScreenPx } from './board-ui';
import { FAR_ID_DESIGN_PX, FAR_TITLE_DESIGN_PX, farIdFontSize, segmentNodeWidth } from './far-type';
import { buildGraph, NODE_SIZE, segmentName } from './model';
import { FarSegment, FarTicket } from './nodes';

afterEach(cleanup);

describe('远档单子', () => {
  test('标题用 --text-strong、单号用 --text-sub：标题字号大于单号', () => {
    render(<FarTicket tone="run" id="#1742" title="数据库夜间备份超时" />);
    const title = document.querySelector<HTMLElement>('[data-far-title]');
    const id = document.querySelector<HTMLElement>('[data-far-id]');
    expect(title).toBeTruthy();
    expect(id).toBeTruthy();
    // 字号写在内联样式里（max(… var(--text-*) …) happy-dom 不收），这里对字号函数本身
    expect(farTitleFontSize()).toContain('var(--text-strong)');
    expect(farIdFontSize()).toContain('var(--text-sub)');
    expect(FAR_TITLE_DESIGN_PX).toBeGreaterThan(FAR_ID_DESIGN_PX);
    // 不管缩放到哪里，屏幕上标题都比单号大
    for (const zoom of [0.15, 0.176, 0.25, 0.4]) {
      expect(farTitleScreenPx(zoom)).toBeGreaterThan(farIdScreenPx(zoom));
    }
  });

  test('标题最多两行（line-clamp-2），不再是单行截断；悬停看全文', () => {
    render(<FarTicket tone="run" id="#1742" title="数据库夜间备份超时" />);
    const title = document.querySelector<HTMLElement>('[data-far-title]');
    expect(title?.className).toContain('line-clamp-2');
    expect(title?.className).not.toContain('truncate');
    expect(title?.getAttribute('title')).toBe('数据库夜间备份超时');
  });
});

describe('远档段节点', () => {
  test('「还没开始对题」整个写出来，一行、不带省略号', () => {
    render(<FarSegment tone="wait" name="还没开始对题" count="3 张" />);
    const name = screen.getByText('还没开始对题');
    expect(name.className).toContain('whitespace-nowrap');
    expect(name.className).not.toContain('truncate');
    expect(name.className).not.toContain('text-ellipsis');
    expect(name.textContent).not.toContain('…');
  });

  test('段节点宽度按最长段名算：两个字的段名保持默认宽，长段名撑宽到放得下', () => {
    expect(segmentNodeWidth(['对题', '动手', '验收'])).toBe(NODE_SIZE.segment.width);
    const wide = segmentNodeWidth(['对题', '还没开始对题']);
    expect(wide).toBeGreaterThan(NODE_SIZE.segment.width);
    // 6 个字、缩放到最小时每个字不小于 11px 屏幕字号 → 画布坐标 11 / 0.15
    expect(wide).toBeGreaterThanOrEqual(Math.ceil((6 * 11) / 0.15));
    expect(segmentNodeWidth(['还没开始对题'])).toBe(wide);
  });

  test('buildGraph：所有段节点同宽，宽度跟着当前最长的段名走', () => {
    const base = {
      repo: 'o/r',
      waitingReason: 'nothing' as const,
      link: '/x',
    };
    const g = buildGraph({
      running: [
        { ...base, issueNumber: 1, title: 'a', segment: 'doing' },
        { ...base, issueNumber: 2, title: 'b', segment: null },
      ],
      flow: [
        { segment: 'scope', inFlight: 0, samples: 0 },
        { segment: 'manual', inFlight: 1, samples: 0 },
        { segment: 'verify', inFlight: 0, samples: 0 },
      ],
      filter: { stuck: false, needsYou: false },
    });
    const widths = g.nodes.filter((n) => n.data.kind === 'segment').map((n) => n.width);
    expect(widths.length).toBeGreaterThanOrEqual(4);
    expect(new Set(widths).size).toBe(1);
    // 「还没分段」4 个字，比默认宽要宽
    expect(widths[0]).toBe(segmentNodeWidth([segmentName('none'), segmentName('manual')]));
    expect(widths[0]).toBeGreaterThan(NODE_SIZE.segment.width);
  });
});
