// 面板盖住选中卡片时画布怎么平移（单 #1819）：被盖住或在画布外就给出新视角，没被盖住不动。
import { describe, expect, test } from 'vitest';
import { centerViewport, NO_INSET, revealViewport } from './reveal';

const view = { width: 1000, height: 700 };
const vp = { x: 0, y: 0, zoom: 1 };
const card = { width: 300, height: 180 };
/** 右边 404 宽的详情面板（392 宽 + 贴右 12）盖住了画布右侧。 */
const inset = { ...NO_INSET, right: 404, top: 56 };

describe('revealViewport', () => {
  test('选中的卡片整张在可见区里：不平移', () => {
    expect(
      revealViewport({ node: { x: 100, y: 100, ...card }, viewport: vp, view, inset, margin: 16 }),
    ).toBeNull();
  });

  test('选中的卡片被右边的面板盖住：向左平移到面板左边留出边距', () => {
    const out = revealViewport({
      node: { x: 700, y: 100, ...card },
      viewport: vp,
      view,
      inset,
      margin: 16,
    });
    // 可见区右边界 = 1000 - 404 - 16 = 580；卡片右边 1000 → 向左挪 420
    expect(out).toEqual({ x: -420, y: 0, zoom: 1 });
  });

  test('卡片跟着当前缩放和平移算：放大后同一张卡落进面板底下也要挪', () => {
    const out = revealViewport({
      node: { x: 200, y: 100, width: 250, height: 100 },
      viewport: { x: 50, y: 0, zoom: 2 },
      view,
      inset,
      margin: 16,
    });
    // 屏幕上 left = 450，right = 950 > 580 → 挪 -370
    expect(out?.x).toBe(50 - 370);
    expect(out?.zoom).toBe(2);
  });

  test('卡片在画布左边或顶上的工具条底下：向右 / 向下挪回来', () => {
    const left = revealViewport({
      node: { x: -200, y: 100, ...card },
      viewport: vp,
      view,
      inset,
      margin: 16,
    });
    expect(left?.x).toBe(216);
    const top = revealViewport({ node: { x: 100, y: 10, ...card }, viewport: vp, view, inset, margin: 16 });
    // 可见区上沿 = 56 + 16 = 72
    expect(top?.y).toBe(62);
  });

  test('卡片比可见区还宽：对齐左边，不来回抖', () => {
    const out = revealViewport({
      node: { x: 100, y: 100, width: 900, height: 100 },
      viewport: vp,
      view,
      inset,
      margin: 16,
    });
    expect(out?.x).toBe(-84);
  });
});

describe('centerViewport', () => {
  test('居中在可见区正中，不是整块画布正中', () => {
    const out = centerViewport({ node: { x: 0, y: 0, ...card }, zoom: 1, view, inset });
    // 可见区横向 0..596 → 中点 298；卡片中点 150 → x = 148
    expect(out.x).toBe(148);
    // 纵向 56..700 → 中点 378；卡片中点 90 → y = 288
    expect(out.y).toBe(288);
  });
});
