// 对话里的内嵌卡片和分隔线（样稿 `.inset`）：
// Inset 是 fill-1 底的一小块，竖着排、间距 8，放方案卡、建议卡、拍板卡、原话这类；dashed 画虚线框（建议改，还没生效）。
// RuleLabel 是「—— 文字 ——」一行，放结案分隔线、「以下是新消息」、换模型；accent 用品牌色（要人注意的新消息）。
// 不收 className 和 style。
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { type DataAttrs, pickData } from './data-attrs';

export function Inset({
  look = 'solid',
  children,
  ...rest
}: {
  look?: 'solid' | 'dashed';
  children: ReactNode;
} & DataAttrs) {
  return (
    <div
      data-look={look}
      {...pickData(rest)}
      className={cn(
        'flex min-w-0 flex-col gap-2 rounded-sm px-3 py-2 text-body text-ink',
        look === 'dashed' ? 'border border-dashed border-line-2' : 'bg-fill-1',
      )}
    >
      {children}
    </div>
  );
}

export function RuleLabel({
  accent,
  children,
  ...rest
}: {
  accent?: boolean;
  children: ReactNode;
} & DataAttrs) {
  const line = cn('h-px flex-1', accent ? 'bg-brand' : 'bg-line');
  return (
    <div
      {...pickData(rest)}
      className={cn('flex items-center gap-3 text-meta', accent ? 'text-brand-ink' : 'text-ink-3')}
    >
      <span aria-hidden className={line} />
      <span className="min-w-0 text-center">{children}</span>
      <span aria-hidden className={line} />
    </div>
  );
}
