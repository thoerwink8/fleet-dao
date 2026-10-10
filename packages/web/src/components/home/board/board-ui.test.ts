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

  /** NowRow 里「状态 · 标题」那一格（紧挨 issueNumber 单元格之后）。 */
  function doingCell(): string {
    const m = src.match(/#\{item\.issueNumber\}<\/td>\s*<td className="([^"]*)"[^>]*title=\{full\}/);
    expect(m, '找不到「在做什么」单元格').toBeTruthy();
    return m?.[1] ?? '';
  }

  test('单行截断：超出用省略号，不用折行', () => {
    const cls = doingCell();
    expect(cls.split(/\s+/)).toContain('truncate');
    expect(cls).not.toMatch(/\bbreak-words\b/);
    expect(cls).not.toMatch(/\bwhitespace-normal\b/);
  });

  test('悬停全文：该格带 title={full}', () => {
    expect(src).toMatch(/#\{item\.issueNumber\}<\/td>\s*<td className="[^"]*"[^>]*title=\{full\}/);
  });

  test('列有最小宽度，不被相邻列挤成窄条', () => {
    // colgroup 第三列（在做什么）要带够用的宽度类；面板加宽给它留空间
    const colgroup = src.match(/data-board-now[\s\S]*?<colgroup>([\s\S]*?)<\/colgroup>/)?.[1] ?? '';
    const cols = [...colgroup.matchAll(/<col\b([^>]*)\/>/g)].map((m) => m[1] ?? '');
    expect(cols).toHaveLength(4);
    expect(cols[2]).toMatch(/className="[^"]*\b(?:min-w-48|w-48)\b/);
    // 属性写在同一 div 上（中间可有注释），别误匹配前面 inset('[data-board-now]')
    expect(src).toMatch(/data-board-now\s+(?:\/\/[^\n]*\s+)*className="[^"]*w-\[32rem\][^"]*"/);
  });
});
