// 画布让出被盖住的地方（单 #1819）：详情面板、浮着的「做完的」抽屉盖在画布右侧，选中的卡片落在被盖住的区域时，
// 平移画布把它放回可见区；没被盖住就不动。这里只放算的部分（纯函数，好测），量尺寸、调平移在 board-canvas.tsx。

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/** 画布四边被浮层盖住的宽度（像素，屏幕坐标）。 */
export interface Inset {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const NO_INSET: Inset = { top: 0, right: 0, bottom: 0, left: 0 };

/** 一个方向上要挪多少：已经在可见区里是 0；比可见区还宽就对齐起点。 */
function shiftOf(start: number, end: number, from: number, to: number): number {
  if (end - start > to - from) return from - start;
  if (start < from) return from - start;
  if (end > to) return to - end;
  return 0;
}

/**
 * 选中的卡片（画布坐标）在当前视角下有没有落到被盖住的地方或画布外：有就给出平移后的视角，没有给 null。
 * margin 是卡片离可见区边缘至少留的空。
 */
export function revealViewport(a: {
  node: Rect;
  viewport: Viewport;
  view: { width: number; height: number };
  inset: Inset;
  margin: number;
}): Viewport | null {
  const { node, viewport: vp, view, inset, margin } = a;
  const left = node.x * vp.zoom + vp.x;
  const top = node.y * vp.zoom + vp.y;
  const dx = shiftOf(
    left,
    left + node.width * vp.zoom,
    inset.left + margin,
    view.width - inset.right - margin,
  );
  const dy = shiftOf(
    top,
    top + node.height * vp.zoom,
    inset.top + margin,
    view.height - inset.bottom - margin,
  );
  if (dx === 0 && dy === 0) return null;
  return { x: vp.x + dx, y: vp.y + dy, zoom: vp.zoom };
}

/** 让选中的卡片落在可见区正中时的视角（点「此刻」里的一行、键盘移动时用）。 */
export function centerViewport(a: {
  node: Rect;
  zoom: number;
  view: { width: number; height: number };
  inset: Inset;
}): Viewport {
  const { node, zoom, view, inset } = a;
  const cx = (inset.left + view.width - inset.right) / 2;
  const cy = (inset.top + view.height - inset.bottom) / 2;
  return { x: cx - (node.x + node.width / 2) * zoom, y: cy - (node.y + node.height / 2) * zoom, zoom };
}

/** 盖在画布右侧的浮层：节点详情面板，和浮着（不是停靠）的右侧抽屉。 */
const OVERLAY_SELECTOR = '[data-board-detail], [data-home-drawer="floating"]';

/**
 * 右侧被盖住的宽度。用布局宽度加上贴右边的距离，不用 getBoundingClientRect：
 * 面板滑进来的动画（transform）还在走的时候，后者量到的是半路的位置。
 */
export function overlayRightInset(scope: Element): number {
  let width = 0;
  for (const el of scope.ownerDocument.querySelectorAll<HTMLElement>(OVERLAY_SELECTOR)) {
    const edge = Number.parseFloat(getComputedStyle(el).right) || 0;
    width = Math.max(width, el.offsetWidth + edge);
  }
  return width;
}
