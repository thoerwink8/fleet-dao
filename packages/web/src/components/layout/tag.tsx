// 非状态的小标签：「卡住报警」「套餐内」、提交号。状态本身用 StatusBadge；两者外形同一套（tone.ts 的 badgeShape）。
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { badgeShape, inkClass, type LayoutTone, softClass } from './tone';

export type TagTone = 'neutral' | 'brand' | LayoutTone;

export function Tag({
  tone = 'neutral',
  mono,
  children,
  className,
}: {
  tone?: TagTone;
  /** 编号、提交号这类用等宽小块。 */
  mono?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      data-tone={tone}
      className={cn(
        badgeShape,
        tone === 'neutral' && 'bg-muted text-muted-foreground',
        tone === 'brand' && 'bg-brand text-brand-foreground',
        tone !== 'neutral' && tone !== 'brand' && cn(softClass[tone], inkClass[tone]),
        mono && 'font-mono',
        className,
      )}
    >
      {children}
    </span>
  );
}
