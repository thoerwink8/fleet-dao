// 看板上按状态上色要的两张表（初版在 lib/status.ts，随 #613 删掉；现在只有首页看板用）。
// 颜色只表达状态，七种状态色都出自主题的 --st-*，这里不另造颜色。
import type { Tone } from '../../../lib/status';

// Tailwind 只认完整类名，所以逐个写全，不拼接。
export const toneBorder: Record<Tone, string> = {
  run: 'border-st-run/45',
  wait: 'border-st-wait/35',
  human: 'border-st-human/50',
  stall: 'border-st-stall/55',
  fail: 'border-st-fail/55',
  done: 'border-st-done/40',
  stop: 'border-st-stop/40',
};

/** 画连线、小地图要的颜色值（CSS 变量）。 */
export const toneVar: Record<Tone, string> = {
  run: 'var(--st-run)',
  wait: 'var(--st-wait)',
  human: 'var(--st-human)',
  stall: 'var(--st-stall)',
  fail: 'var(--st-fail)',
  done: 'var(--st-done)',
  stop: 'var(--st-stop)',
};
