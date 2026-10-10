// 远档卡片标题、编号的字号：按缩放倒数放大，屏幕上不小于 12px。
// 标题另有一条：用字号名（--text-strong / --text-caption），实际缩放下屏幕上不小于 11px。
// 「此刻」表「在做什么」列：单行省略 + title 悬停全文，列宽有下限（#1752）。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { farCardFontPx, farTitleFontSize, farTitleScreenPx, ZOOM_OF } from './board-ui';

describe('远档字号', () => {
  test('标题和编号的字号乘缩放的倒数，换算结果不小于 12', () => {
    const px = farCardFontPx(32, ZOOM_OF.far);
    expect(px).toBeGreaterThanOrEqual(12);
    expect(px * ZOOM_OF.far).toBeGreaterThanOrEqual(12);
    // 基准本身不到 12：仍要把字号抬到缩放之后屏幕上不小于 12
    expect(farCardFontPx(8, 0.25) * 0.25).toBeGreaterThanOrEqual(12);
  });

  test('远档标题用字号名，1366 收进视野的缩放和最小缩放下屏幕上都不小于 11', () => {
    const css = farTitleFontSize();
    expect(css).toContain('var(--text-strong)');
    expect(css).toContain('var(--text-caption)');
    expect(css).not.toMatch(/\d+px/);
    // 1366 宽实测收进视野约 0.176；画布最小缩放 0.15；远档预设 0.4
    expect(farTitleScreenPx(0.176)).toBeGreaterThanOrEqual(11);
    expect(farTitleScreenPx(0.15)).toBeGreaterThanOrEqual(11);
    expect(farTitleScreenPx(0.4)).toBeGreaterThanOrEqual(11);
    expect(farTitleScreenPx(ZOOM_OF.far)).toBe(15);
  });
});

describe('此刻「在做什么」列', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'board-canvas.tsx'), 'utf8');
  /** 只看 NowPanel，避开 fitAll 里的 inset('[data-board-now]')。 */
  const nowPanel = src.match(/function NowPanel\b[\s\S]*?\nfunction NowRow\b/)?.[0] ?? '';

  /** NowRow 里「状态 · 标题」那一格（紧挨 issueNumber 单元格之后）。 */
  function doingCell(): { className: string; attrs: string } {
    const m = src.match(/#\{item\.issueNumber\}<\/td>\s*<td ([^>]*)>/);
    expect(m, '找不到「在做什么」单元格').toBeTruthy();
    const attrs = m?.[1] ?? '';
    const cls = attrs.match(/className="([^"]*)"/)?.[1] ?? '';
    return { className: cls, attrs };
  }

  test('单行截断：超出用省略号，不用折行', () => {
    const { className } = doingCell();
    const tokens = className.split(/\s+/);
    // table-fixed 下靠 w-48 定宽；truncate = 单行 + 省略号
    expect(tokens).toContain('w-48');
    expect(tokens).toContain('truncate');
    expect(tokens).not.toContain('break-words');
    expect(tokens).not.toContain('whitespace-normal');
  });

  test('悬停全文：该格带 title={full}', () => {
    const { attrs } = doingCell();
    expect(attrs).toMatch(/\btitle=\{full\}/);
  });

  test('列有固定宽度，不被相邻列挤成窄条', () => {
    expect(nowPanel, '找不到 NowPanel').not.toBe('');
    // table-fixed 只认 w-*；只写 min-w-* 挡不住窄条，所以必须钉 w-48
    const colgroup = nowPanel.match(/<colgroup>([\s\S]*?)<\/colgroup>/)?.[1] ?? '';
    const cols = [...colgroup.matchAll(/<col\b([^>]*)\/>/g)].map((m) => m[1] ?? '');
    expect(cols).toHaveLength(4);
    expect(cols[2]).toMatch(/\bw-48\b/);
    expect(cols[2]).not.toMatch(/\bmin-w-/);
    // 面板本体：w-lg（container-lg = 32rem）给四列留宽，max-w-full 窄画布不溢出；勿用任意值 w-[32rem]（lint-arbitrary）
    const panelClass = nowPanel.match(/data-board-now[\s\S]*?className="([^"]*)"/)?.[1] ?? '';
    expect(panelClass.split(/\s+/)).toEqual(expect.arrayContaining(['w-lg', 'max-w-full']));
    // 四列定宽合计 30.5rem < 面板 32rem；1366/1920 画布远大于面板，max-w-full 再兜底，不会撑出画布
    const remOf = (attr: string) => {
      const m = attr.match(/\bw-(\d+)\b/);
      expect(m, `col 缺 w-*：${attr}`).toBeTruthy();
      return Number(m?.[1]) / 4; // Tailwind spacing：数字 ÷ 4 = rem
    };
    const colRems = cols.map(remOf);
    expect(colRems).toEqual([6, 3.5, 12, 9]);
    expect(colRems.reduce((a, b) => a + b, 0)).toBeLessThan(32);
    // 表头四列与 colgroup 同宽类，对齐不漂
    expect(nowPanel).toMatch(/<th[^>]*\bw-24\b[^>]*>\s*谁在做/);
    expect(nowPanel).toMatch(/<th[^>]*\bw-14\b[^>]*>\s*单/);
    expect(nowPanel).toMatch(/<th[^>]*\bw-48\b[^>]*>\s*在做什么/);
    expect(nowPanel).toMatch(/<th[^>]*\bw-36\b[^>]*>\s*分钟/);
  });
});
