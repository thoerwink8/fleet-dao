// 行首小图标（#3533）：一行字前面的 16（meta 行 12）图标，高度取那一行字的行高，图标在行内垂直居中，
// 所以多行字时图标对齐第一行。颜色跟 Text 的 tone 一档，只有异常才橙、红。不收 className 和 style。
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { DataAttrs } from './data-attrs';
import type { TextTone } from './text';

const TONE = {
  default: 'text-ink',
  secondary: 'text-ink-2',
  muted: 'text-ink-3',
  warning: 'text-warn-ink',
  danger: 'text-fail-ink',
} as const satisfies Record<TextTone, string>;

export function Glyph({
  icon: Icon,
  size = 'body',
  tone = 'secondary',
  ...data
}: DataAttrs & {
  icon: LucideIcon;
  /** body：16 图标配 14/22 的字；meta：12 图标配 12/20 的字。 */
  size?: 'body' | 'meta';
  tone?: TextTone;
}) {
  return (
    <span
      aria-hidden
      {...data}
      className={cn('inline-flex shrink-0 items-center', size === 'meta' ? 'h-5' : 'h-5.5', TONE[tone])}
    >
      <Icon className={size === 'meta' ? 'size-3' : 'size-4'} />
    </span>
  );
}
