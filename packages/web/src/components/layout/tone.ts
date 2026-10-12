// 版式组件共用的状态色映射。Tailwind 只认完整类名，所以逐个写全，不拼接（规范 6.1：实色、淡底、描边、墨色各有令牌）。
import { CircleHelp, type LucideIcon } from 'lucide-react';
import { type Tone, toneIcon } from '../../lib/status';

/** 八种状态：七种看板状态加「疑似换模型」（#1638）。 */
export type LayoutTone = Tone | 'doubt';

export const LAYOUT_TONES: readonly LayoutTone[] = [
  'run',
  'wait',
  'human',
  'stall',
  'fail',
  'done',
  'stop',
  'doubt',
];

/**
 * StatusBadge 和 Tag 共用的外形：同一个字高（h-5）、内边距（px-1.5）、字号字重、圆角（rounded-sm）。
 * 两者只在「管什么」上分工，不在形状上分（规范第六节「StatusBadge 与 Tag 的分工」）。
 */
export const badgeShape =
  'inline-flex h-5 shrink-0 items-center rounded-sm px-1.5 text-meta font-medium whitespace-nowrap';

/** 状态文字（≥4.5:1 的墨色）。 */
export const inkClass: Record<LayoutTone, string> = {
  run: 'text-ink-run',
  wait: 'text-ink-wait',
  human: 'text-ink-human',
  stall: 'text-ink-stall',
  fail: 'text-ink-fail',
  done: 'text-ink-done',
  stop: 'text-ink-stop',
  doubt: 'text-ink-doubt',
};
/** 状态实色：点、竖线、图标。 */
export const solidClass: Record<LayoutTone, string> = {
  run: 'bg-st-run',
  wait: 'bg-st-wait',
  human: 'bg-st-human',
  stall: 'bg-st-stall',
  fail: 'bg-st-fail',
  done: 'bg-st-done',
  stop: 'bg-st-stop',
  doubt: 'bg-st-doubt',
};
/** 状态淡底（12%）。 */
export const softClass: Record<LayoutTone, string> = {
  run: 'bg-st-run-soft',
  wait: 'bg-st-wait-soft',
  human: 'bg-st-human-soft',
  stall: 'bg-st-stall-soft',
  fail: 'bg-st-fail-soft',
  done: 'bg-st-done-soft',
  stop: 'bg-st-stop-soft',
  doubt: 'bg-st-doubt-soft',
};
/** 状态描边（40%）。 */
export const lineClass: Record<LayoutTone, string> = {
  run: 'border-st-run-line',
  wait: 'border-st-wait-line',
  human: 'border-st-human-line',
  stall: 'border-st-stall-line',
  fail: 'border-st-fail-line',
  done: 'border-st-done-line',
  stop: 'border-st-stop-line',
  doubt: 'border-st-doubt-line',
};

export function iconOf(tone: LayoutTone): LucideIcon {
  return tone === 'doubt' ? CircleHelp : toneIcon[tone];
}
