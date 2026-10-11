// 画布「全部收进视野」怎么算（单 #1899）。
//
// 以前用 React Flow 自带的 getViewportForBounds，四周各留 15%，再按「整张图都要装下」定缩放：
// 1366 宽屏上缩到约 0.8，卡内 11px 的字屏幕上只剩 9px，两边还各空 180px。
// 现在先定「读得出」的下限：卡内最小的字（--text-canvas，11px）乘缩放后不小于 12px，
// 再在上下限之间取能装下整张图的最大缩放；装不下、在下限上还能看到九成就停在下限，再多切就改成远档整张收进来。
// 两个方向都居中：切掉的是四周，中间的中心节点和三段总在视野里。

import { MIN_ZOOM } from './far-type.ts';

/** --text-canvas 的像素值（app.css 第一个 @theme）。fit-view.test.ts 会读 app.css 核对，令牌改了这里不改就红。 */
export const CANVAS_FONT_PX = 11;
/** 中文最小字号：卡内最小的字缩放后不能比这个小。 */
export const READABLE_PX = 12;
/** 读得出的最小缩放：向上取到两位小数，保证 11 × 它 ≥ 12。 */
export const MIN_READABLE_ZOOM = Math.ceil((READABLE_PX / CANVAS_FONT_PX) * 100) / 100;
/**
 * 自动收进视野时的最大缩放。要低于「近」档的起点（1.2，见 board-ui.tsx 的 levelOf），
 * 免得图很小时一收进视野就跳成近景。
 */
export const FIT_MAX_ZOOM = 1.15;

export interface FitBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 浮在画布上的东西占掉的四边（像素）。 */
export interface FitPad {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface FitViewport {
  x: number;
  y: number;
  zoom: number;
}

/** 图四周留的一点空（占可用宽高的比例），不让卡片贴着边；比 React Flow 自带的 15% 小得多。 */
const BREATH = 0.02;

/**
 * 「远」档里自动收进视野的最大缩放。要低于远档的上界（0.55，见 board-ui.tsx 的 levelOf）：
 * 远档的卡只画色块、标题和数字，标题缩放后也不小于 12px，所以整张图缩得很小也读得出。
 */
export const FAR_FIT_MAX_ZOOM = 0.54;
/** 装不下时，在下限缩放上能看到整张图的比例至少这么多才切（只切四周的边角）；再少会把卡片切成半张，就改成远档整张收进来。 */
export const MIN_VISIBLE_AT_FLOOR = 0.9;

/**
 * 由「刚好装下整张图」的缩放定实际缩放：
 * - 装得下读得出的下限：取装下的最大值（封顶 FIT_MAX_ZOOM）；
 * - 装不下，但在下限上还能看到九成以上：停在下限，只切四周的边角；
 * - 装不下、在下限上看不到九成：改成远档，整张图收进来（卡上只剩色块、标题和数字，字不小于 12px）。
 */
export function zoomFor(fit: number): number {
  if (fit >= MIN_READABLE_ZOOM) return Math.min(FIT_MAX_ZOOM, fit);
  if (fit / MIN_READABLE_ZOOM >= MIN_VISIBLE_AT_FLOOR) return MIN_READABLE_ZOOM;
  return Math.min(FAR_FIT_MAX_ZOOM, Math.max(MIN_ZOOM, fit));
}

/** 一种留边法下的视角。 */
export function fitOne(bounds: FitBounds, view: { width: number; height: number }, pad: FitPad): FitViewport {
  const w = Math.max(80, view.width - pad.left - pad.right);
  const h = Math.max(80, view.height - pad.top - pad.bottom);
  const bw = Math.max(1, bounds.width);
  const bh = Math.max(1, bounds.height);
  const fit = Math.min((w * (1 - BREATH * 2)) / bw, (h * (1 - BREATH * 2)) / bh);
  const zoom = zoomFor(fit);
  const gapX = w - bw * zoom;
  const gapY = h - bh * zoom;
  // 两个方向都居中：装得下，四边留一样的空；装不下，上下左右各切一样多，中间（中心节点、三段）总在视野里
  const x = pad.left + gapX / 2 - bounds.x * zoom;
  const y = pad.top + gapY / 2 - bounds.y * zoom;
  return { x, y, zoom };
}

/** 几种留边法里取缩放最大的（一样大取前面的）。 */
export function fitViewport(
  bounds: FitBounds,
  view: { width: number; height: number },
  pads: readonly FitPad[],
): FitViewport {
  const fits = pads.map((pad) => fitOne(bounds, view, pad));
  return fits.reduce((a, b) => (b.zoom > a.zoom ? b : a));
}
