// 文字（样子照 canvas/fd3.css 的 .t-meta .t-body .t-head .ink-2 .ink-3 .mono .clip）。替掉页面里 600 多处手写的灰字。
// 字号和行高、字重绑在一起（meta 12/20、body 14/22、heading 16/24 带 500），页面只选档位。
// 颜色只给异常：warning、danger 是橙、红的字（*-ink），不是填充色；正常的字只用 default、secondary、muted 三档灰阶。
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import type { DataAttrs } from './data-attrs';

const SIZE = { meta: 'text-meta', body: 'text-body', heading: 'text-heading' } as const;
const TONE = {
  default: 'text-ink',
  secondary: 'text-ink-2',
  muted: 'text-ink-3',
  warning: 'text-warn-ink',
  danger: 'text-fail-ink',
} as const;

export type TextSize = keyof typeof SIZE;
export type TextTone = keyof typeof TONE;

export function Text({
  size = 'body',
  tone = 'default',
  strong,
  mono,
  truncate,
  block,
  pre,
  lines,
  as: Tag = 'span',
  title,
  id,
  children,
  ...data
}: DataAttrs & {
  /** 给 aria-describedby 指过来的元素 id。 */
  id?: string;
  /** 最多露几行，多的省略（按块排）。 */
  lines?: 2 | 3;
  /** meta 12（时间戳、表头、计数）、body 14（默认）、heading 16（小标题）。 */
  size?: TextSize;
  /** default 正文黑、secondary 次要、muted 灰字说明；warning、danger 只给异常。 */
  tone?: TextTone;
  /** 字重 500。 */
  strong?: boolean;
  /** 编号、提交号、路径：等宽 13。 */
  mono?: boolean;
  /** 一行放不下用省略号（自动按块排）。 */
  truncate?: boolean;
  /** 独占一行。 */
  block?: boolean;
  /** 保留原文的换行，长词也折行（通知正文这类多行原文）。 */
  pre?: boolean;
  as?: 'span' | 'p' | 'div';
  /** 悬停给全文（truncate 时用）。 */
  title?: string;
  children?: ReactNode;
}) {
  return (
    <Tag
      {...(title !== undefined ? { title } : {})}
      {...(id !== undefined ? { id } : {})}
      {...data}
      className={cn(
        mono ? 'font-mono text-mono' : SIZE[size],
        TONE[tone],
        strong && 'font-medium',
        truncate ? 'block min-w-0 truncate' : block && 'block',
        Tag !== 'span' && !truncate && 'block',
        pre && 'block whitespace-pre-wrap break-words',
        lines === 2 && 'line-clamp-2 block',
        lines === 3 && 'line-clamp-3 block',
      )}
    >
      {children}
    </Tag>
  );
}
