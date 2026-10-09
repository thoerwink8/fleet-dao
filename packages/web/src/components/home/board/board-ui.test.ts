// 远档卡片标题、编号的字号：按缩放倒数放大，屏幕上不小于 12px。
import { describe, expect, test } from 'vitest';
import { farCardFontPx, ZOOM_OF } from './board-ui';

describe('远档字号', () => {
  test('标题和编号的字号乘缩放的倒数，换算结果不小于 12', () => {
    const px = farCardFontPx(32, ZOOM_OF.far);
    expect(px).toBeGreaterThanOrEqual(12);
    expect(px * ZOOM_OF.far).toBeGreaterThanOrEqual(12);
    // 基准本身不到 12：仍要把字号抬到缩放之后屏幕上不小于 12
    expect(farCardFontPx(8, 0.25) * 0.25).toBeGreaterThanOrEqual(12);
  });
});
