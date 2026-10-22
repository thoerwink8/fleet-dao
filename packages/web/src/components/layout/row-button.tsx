// 行里的整块按钮和折叠箭头（路由页、思考档位的行）：一行里「点名字看详情」「点组头展开」的那块可点区域。
// 样子：透明底、4 圆角、键盘聚焦画品牌色圈；手机上至少 40 高。状态靠 aria-pressed、aria-expanded 传。不收 className 和 style。
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { focusRing } from '../ui/styles';

/** 折叠箭头：关着朝右（direction=right）或朝下偏右（down 关着转 -90），开着朝下。 */
export function DisclosureIcon({
  open,
  direction = 'right',
  muted = true,
}: {
  open: boolean;
  /** right：关着朝右、开着转 90 朝下（行展开）；down：开着朝下、关着转 -90（分组头）。 */
  direction?: 'right' | 'down';
  muted?: boolean;
}) {
  const tone = muted ? 'text-ink-3' : '';
  if (direction === 'down') {
    return (
      <ChevronDown
        aria-hidden
        data-disclosure={open ? 'open' : 'closed'}
        className={cn(
          'size-4 shrink-0 transition-transform duration-200 ease-arco',
          tone,
          !open && '-rotate-90',
        )}
      />
    );
  }
  return (
    <ChevronRight
      aria-hidden
      data-disclosure={open ? 'open' : 'closed'}
      className={cn('size-4 shrink-0 transition-transform duration-200 ease-arco', tone, open && 'rotate-90')}
    />
  );
}

const LAYOUT = {
  /** 一行横排，垂直居中。 */
  row: 'items-center gap-2',
  /** 横排，顶对齐（路由行：箭头、序号、名字多行）。 */
  top: 'items-start gap-2',
  /** 竖排：第一行名字加状态，第二行灰字（定高的两行行）。 */
  column: 'flex-col justify-center gap-0.5 self-stretch',
} as const;

export function RowButton({
  onClick,
  layout = 'row',
  pressed,
  expanded,
  controls,
  label,
  title,
  dim = false,
  children,
}: {
  onClick: () => void;
  /** 关着、被跳过的行：整块降对比度（opacity-60），不整行换灰底。 */
  dim?: boolean;
  layout?: keyof typeof LAYOUT;
  pressed?: boolean | undefined;
  expanded?: boolean | undefined;
  controls?: string | undefined;
  label?: string | undefined;
  title?: string | undefined;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-row-button
      data-dim={dim || undefined}
      {...(pressed !== undefined ? { 'aria-pressed': pressed } : {})}
      {...(expanded !== undefined ? { 'aria-expanded': expanded } : {})}
      {...(controls ? { 'aria-controls': controls } : {})}
      {...(label ? { 'aria-label': label } : {})}
      {...(title ? { title } : {})}
      className={cn(
        'flex min-w-0 flex-1 cursor-pointer rounded-md text-left text-ink max-md:min-h-10 md:min-h-0',
        focusRing,
        LAYOUT[layout],
        dim && 'opacity-60',
      )}
    >
      {children}
    </button>
  );
}

/**
 * 整行宽的折叠条（思考档位的「配不了」「未分类」折叠、家族组头）：箭头加一行字，点一下展开。
 * group：家族组头，小一号的灰字、下面一道线；默认是区块里的整条。
 */
export function FoldBar({
  open,
  onToggle,
  controls,
  size = 'default',
  children,
}: {
  open: boolean;
  onToggle: () => void;
  controls: string;
  size?: 'default' | 'group';
  children: ReactNode;
}) {
  const group = size === 'group';
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      data-fold-bar={size}
      className={cn(
        'flex w-full cursor-pointer items-center gap-1.5 text-left whitespace-nowrap transition-colors duration-100 max-md:min-h-11',
        focusRing,
        group
          ? 'border-b border-line px-section pt-3 pb-2 text-meta font-medium text-ink-3 hover:text-ink'
          : 'px-section py-3 text-body text-ink hover:bg-fill-1',
      )}
    >
      <DisclosureIcon open={open} direction="down" />
      {children}
    </button>
  );
}
