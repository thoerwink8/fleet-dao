// 根字号倍数（#1937）：桌面（md，48rem 起）app.css 把根字号放大到 125%，rem 写的尺寸一起放大。
// JS 里按像素算的尺寸（窗口化列表的定高行、窗口高、画布节点、抽屉默认宽）是照 16px 根字号定的设计值，乘这个倍数才和 CSS 对得上。
// 读的是 <html> 实际算出来的字号 ÷ 16，不另记一份 1.25：app.css 改了倍数、用户在浏览器里调了默认字号，这里都跟着变。
import { useMediaQuery } from './hooks.ts';

/** 设计值按 16px 根字号定。 */
export const DESIGN_ROOT_PX = 16;

/** app.css 里根字号放大的那一档：md（48rem，按浏览器初始字号算是 768px）起。 */
export const ROOT_SCALE_MQ = '(min-width: 48rem)';

/** 现在 1rem 是设计值的几倍。量不到（测试环境没加载 CSS、没有 document）按 1。 */
export function readRootScale(): number {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return 1;
  const px = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(px) && px > 0 ? px / DESIGN_ROOT_PX : 1;
}

/** 跨过 md 断点时重画，返回当前倍数。 */
export function useRootScale(): number {
  useMediaQuery(ROOT_SCALE_MQ);
  return readRootScale();
}

/** 设计值（16px 根字号下的像素）换成现在的像素，取整免得定高行累积出小数缝。 */
export function scaledPx(designPx: number, scale: number): number {
  return Math.round(designPx * scale);
}
