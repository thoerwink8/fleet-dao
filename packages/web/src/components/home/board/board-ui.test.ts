// 远档卡片标题、编号的字号：按缩放倒数放大，屏幕上不小于 12px。
// 标题另有一条：用字号名（--text-strong / --text-caption），实际缩放下屏幕上不小于 11px。
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
