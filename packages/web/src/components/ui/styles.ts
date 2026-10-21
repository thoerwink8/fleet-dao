// 基础件共用的几段样子（#3509，照 Arco，样稿 canvas/fd3.css）：聚焦圈、浮层的底和进出动效、减少动效时停。
// 只给 components/ui/ 和 components/layout/ 用；页面不直接拼这些。

/** 聚焦圈：键盘聚焦时 2px 品牌色描边、往外让 1px（fd3 `:focus-visible`）。鼠标点不画。 */
export const focusRing =
  'outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-hover';

/** 减少动效：系统设置或设置页的开关（:root[data-motion=reduced]）任一个开着，进出动画都不播。 */
export const motionStop = 'motion-reduce:animate-none! [:root[data-motion=reduced]_&]:animate-none!';

/** 浮层的底：卡片底、4 圆角、浮层阴影，没有描边（下拉、气泡、提示、对话框同一套）。 */
export const popSurface = 'rounded-md bg-card text-body text-ink shadow-pop';

/** 浮层进出：进 200、出 100，淡入加 0.96→1 缩放，从触发点那边挪 4px 过来；缓动 ease-arco。 */
export const popMotion = [
  'ease-arco',
  'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-96 data-[state=open]:duration-200',
  'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-96 data-[state=closed]:duration-100',
  'data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1',
  motionStop,
].join(' ');

/** 遮罩：mask 令牌，淡入 200、淡出 100。 */
export const maskMotion = [
  'fixed inset-0 z-50 bg-mask ease-arco',
  'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-200',
  'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-100',
  motionStop,
].join(' ');

/** 菜单项（fd3 `.pop-item`）：32 高（字多折行时往下长）、左右 12、2 圆角；悬停和键盘高亮 fill-2；禁用灰字。 */
export const popItem =
  "relative flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-sm px-3 py-1 text-left text-body text-ink outline-none select-none transition-colors duration-100 data-[highlighted]:bg-fill-2 data-[disabled]:cursor-not-allowed data-[disabled]:bg-transparent data-[disabled]:text-ink-3 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-ink-3";

/** 输入类控件的外观（fd3 `.input`）：fill-2 底、无描边，悬停 fill-3，聚焦（含鼠标点进去）白底品牌色描边，出错红边。 */
export const fieldSurface =
  'rounded-sm border border-transparent bg-fill-2 text-ink transition-colors duration-100 outline-none placeholder:text-ink-3 hover:bg-fill-3 focus:border-brand focus:bg-card aria-invalid:border-fail disabled:cursor-not-allowed disabled:bg-fill-1 disabled:text-ink-3';
