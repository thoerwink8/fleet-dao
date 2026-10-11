// 画布初始缩放（单 #1899）：1366×768 下卡内最小字换算后不小于 12px，内容居中、不留大边。
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { levelOf } from './board-ui.tsx';
import {
  CANVAS_FONT_PX,
  FAR_FIT_MAX_ZOOM,
  FIT_MAX_ZOOM,
  fitOne,
  fitViewport,
  MIN_READABLE_ZOOM,
  READABLE_PX,
} from './fit-view.ts';

/** 1366×768 的桌面：侧栏展开 232，顶栏 52，画布区剩下的。 */
const VIEW_1366 = { width: 1366 - 232, height: 768 - 52 };
const NO_PAD = { top: 16, right: 16, bottom: 16, left: 16 };

test('下限常数和 app.css 里的 --text-canvas 对得上（令牌改了这里要跟着改）', () => {
  const css = readFileSync(new URL('../../../app.css', import.meta.url), 'utf8');
  const m = css.match(/--text-canvas:\s*([\d.]+)rem/);
  expect(m).not.toBeNull();
  expect(Number(m?.[1]) * 16).toBe(CANVAS_FONT_PX);
});

test('读得出的最小缩放：卡内最小字乘它不小于 12px', () => {
  expect(CANVAS_FONT_PX * MIN_READABLE_ZOOM).toBeGreaterThanOrEqual(READABLE_PX);
  // 再小一点就读不出了：它是够用的最小值，不是留了一大截余量
  expect(CANVAS_FONT_PX * (MIN_READABLE_ZOOM - 0.01)).toBeLessThan(READABLE_PX);
  // 自动收进视野不会跳进「近」档（1.2 起）
  expect(FIT_MAX_ZOOM).toBeLessThan(1.2);
});

test('1366×768：图装得下时，初始缩放 ≥ 下限，卡内最小字 ≥ 12px，图在可用区里居中', () => {
  // 约四张单、三段、中心节点的一张图
  const bounds = { x: 0, y: 0, width: 900, height: 560 };
  const vp = fitOne(bounds, VIEW_1366, NO_PAD);
  expect(vp.zoom).toBeGreaterThanOrEqual(MIN_READABLE_ZOOM);
  expect(CANVAS_FONT_PX * vp.zoom).toBeGreaterThanOrEqual(READABLE_PX);
  const left = vp.x;
  const right = VIEW_1366.width - (vp.x + bounds.width * vp.zoom);
  expect(Math.abs(left - right)).toBeLessThan(1);
  const top = vp.y;
  const bottom = VIEW_1366.height - (vp.y + bounds.height * vp.zoom);
  expect(Math.abs(top - bottom)).toBeLessThan(1);
});

test('1366×768：初始缩放的具体值（高度是卡死的那一向：716 × 0.96 / 560）', () => {
  const vp = fitOne({ x: 0, y: 0, width: 900, height: 560 }, VIEW_1366, { top: 0, right: 0, bottom: 0, left: 0 });
  // 宽 1134 × 0.96 / 900 = 1.2096，高 716 × 0.96 / 560 = 1.2274：取小，再被 1.15 封顶
  expect(vp.zoom).toBe(FIT_MAX_ZOOM);
  const tall = fitOne({ x: 0, y: 0, width: 900, height: 640 }, VIEW_1366, { top: 0, right: 0, bottom: 0, left: 0 });
  // 高 716 × 0.96 / 640 = 1.074：低于下限，停在下限
  expect(tall.zoom).toBe(MIN_READABLE_ZOOM);
});

const midOf = (vp: { x: number; y: number; zoom: number }, b: { x: number; y: number; width: number; height: number }) => ({
  x: vp.x + (b.x + b.width / 2) * vp.zoom,
  y: vp.y + (b.y + b.height / 2) * vp.zoom,
});
const MID_OF_VIEW = {
  x: NO_PAD.left + (VIEW_1366.width - NO_PAD.left - NO_PAD.right) / 2,
  y: NO_PAD.top + (VIEW_1366.height - NO_PAD.top - NO_PAD.bottom) / 2,
};

test('线上那张四张单的图（从 v8 的 1366 截图量出约 975×583，单 #1899 的场景）：初始缩放在中景档、字 ≥12px', () => {
  const vp = fitOne({ x: -400, y: -290, width: 975, height: 583 }, VIEW_1366, NO_PAD);
  expect(vp.zoom).toBeGreaterThanOrEqual(MIN_READABLE_ZOOM);
  expect(vp.zoom).toBeLessThanOrEqual(FIT_MAX_ZOOM);
  expect(CANVAS_FONT_PX * vp.zoom).toBeGreaterThanOrEqual(READABLE_PX);
});

test('图略大于视野（在下限上还能看到九成以上）：停在下限，上下左右各切同样多，图的中心在视野正中', () => {
  const bounds = { x: 100, y: -320, width: 1060, height: 640 };
  const vp = fitOne(bounds, VIEW_1366, NO_PAD);
  expect(vp.zoom).toBe(MIN_READABLE_ZOOM);
  expect(CANVAS_FONT_PX * vp.zoom).toBeGreaterThanOrEqual(READABLE_PX);
  expect(midOf(vp, bounds).x).toBeCloseTo(MID_OF_VIEW.x, 5);
  expect(midOf(vp, bounds).y).toBeCloseTo(MID_OF_VIEW.y, 5);
});

test('图大到在下限上要切掉一成以上：改成远档整张收进来（缩放低于 0.55，仍是远档），居中', () => {
  const bounds = { x: 100, y: -1200, width: 3000, height: 2400 };
  const vp = fitOne(bounds, VIEW_1366, NO_PAD);
  expect(vp.zoom).toBeLessThan(MIN_READABLE_ZOOM);
  expect(vp.zoom).toBeLessThanOrEqual(FAR_FIT_MAX_ZOOM);
  expect(levelOf(vp.zoom)).toBe('far');
  // 整张图都在视野里
  expect(bounds.width * vp.zoom).toBeLessThanOrEqual(VIEW_1366.width);
  expect(bounds.height * vp.zoom).toBeLessThanOrEqual(VIEW_1366.height);
  expect(midOf(vp, bounds).x).toBeCloseTo(MID_OF_VIEW.x, 5);
  expect(midOf(vp, bounds).y).toBeCloseTo(MID_OF_VIEW.y, 5);
});

test('远档上限低于远档的上界，读得出的下限落在中景档', () => {
  expect(levelOf(FAR_FIT_MAX_ZOOM)).toBe('far');
  expect(levelOf(MIN_READABLE_ZOOM)).toBe('mid');
  expect(levelOf(FIT_MAX_ZOOM)).toBe('mid');
});

test('图很小：缩放封在上限，不放成巨大的卡', () => {
  const vp = fitOne({ x: 0, y: 0, width: 300, height: 200 }, VIEW_1366, NO_PAD);
  expect(vp.zoom).toBe(FIT_MAX_ZOOM);
});

test('几种留边法里取缩放最大的', () => {
  const bounds = { x: 0, y: 0, width: 1000, height: 560 };
  const tight = { top: 16, right: 16, bottom: 16, left: 16 };
  const roomy = { top: 16, right: 16, bottom: 300, left: 300 };
  const vp = fitViewport(bounds, VIEW_1366, [roomy, tight]);
  expect(vp.zoom).toBe(fitOne(bounds, VIEW_1366, tight).zoom);
});
