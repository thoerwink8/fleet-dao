// 非状态的小标签：「卡住报警」「套餐内」、提交号。状态本身用 StatusBadge；两者外形同一套（tone.ts 的 badgeShape）。
// #3509 起照 Arco（样稿 canvas/fd3.css `.tag`）只剩三种外观：default 灰、warning 橙、error 红——颜色只给异常。
// 旧的 tone 参数先照收（默认 neutral）、映射到这三种：stall、doubt → 橙，fail → 红，neutral、brand、run、done、wait、human、stop → 灰。
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { badgeShape, type LayoutTone, type TagLook, tagLookClass, tagLookOf } from './tone';

export type TagTone = TagLook | 'neutral' | 'brand' | LayoutTone;

function lookOf(tone: TagTone): TagLook {
  if (tone === 'default' || tone === 'warning' || tone === 'error') return tone;
  if (tone === 'neutral' || tone === 'brand') return 'default';
  return tagLookOf(tone);
}

export function Tag({
  tone = 'neutral',
  mono,
  children,
  className,
}: {
  tone?: TagTone;
  /** 编号、提交号这类用等宽字。 */
  mono?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const look = lookOf(tone);
  return (
    <span
      data-tone={tone}
      data-look={look}
      className={cn(badgeShape, tagLookClass[look], mono && 'font-mono font-normal', className)}
    >
      {children}
    </span>
  );
}
