// 「远」档卡片上的字（单 #1819）：标题（和段名）比单号大、最多两行，段节点按最长段名定宽。
// 远档整张卡按画布缩放缩小，字号乘缩放的倒数才能在屏幕上读得出：
// 屏幕字号 = max(设计字号 × 当前缩放 / 预设缩放, 下限)。设计字号、下限都用字号名（--text-*），不写死像素。

/** 画布能缩到的最小倍数（ReactFlow 的 minZoom）。 */
export const MIN_ZOOM = 0.15;

/** 远档标题在预设缩放 0.4 下的设计字号，对齐 --text-strong（15px）；屏幕上的下限对齐 --text-caption（11px）。 */
export const FAR_TITLE_DESIGN_PX = 15;
export const FAR_TITLE_FLOOR_PX = 11;

/**
 * 远档单号的设计字号，对齐 --text-sub（13px），下限对齐 --text-micro（10px）。
 * 设计字号和下限都比标题小一档：缩放到哪里，标题都比单号大。
 */
export const FAR_ID_DESIGN_PX = 13;
export const FAR_ID_FLOOR_PX = 10;

/** 远档单号的 CSS 字号，写法同标题（见 board-ui.tsx 的 farTitleFontSize）。 */
export function farIdFontSize(): string {
  return 'max(calc(var(--text-sub) / var(--fd-zoom-far, 0.4)), calc(var(--text-micro) / var(--fd-board-zoom, 0.4)))';
}

/** 段节点左边那条状态色条加左右内边距占的宽（画布坐标）。 */
const SEGMENT_CARD_PADDING = 28;
/** 段节点默认宽。 */
export const SEGMENT_NODE_WIDTH = 256;

/**
 * 段节点的宽：按最长段名定，所有段节点同宽，远档下段名一行写完、不带省略号。
 * 一个字按最坏情况算：缩放到最小（MIN_ZOOM）时字号撑到屏幕下限，换回画布坐标是 下限 / MIN_ZOOM。
 * 段名多半是两个字（对题、动手、验收），用不着加宽，保持默认宽。
 */
export function segmentNodeWidth(names: readonly string[]): number {
  const longest = names.reduce((n, name) => Math.max(n, [...name].length), 0);
  const fit = Math.ceil((longest * FAR_TITLE_FLOOR_PX) / MIN_ZOOM) + SEGMENT_CARD_PADDING;
  return Math.max(SEGMENT_NODE_WIDTH, fit);
}
