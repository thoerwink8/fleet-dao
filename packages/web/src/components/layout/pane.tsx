// 工作区和窗格（提需求页：左边需求列表，右边对话，样稿 `.split` 两张卡）。
// Workspace：桌面（md 起）定高、窗格并排、间距 16，窗格里面自己滚；手机上不定高，窗格一个接一个。
// Pane：一张白卡，可带顶栏（head）、底栏（foot），中间（body）自己滚。size：
//   list 列表那一列（桌面 320 宽）、rail 收起后的窄条（64）、fill 吃满剩下的、screen 手机上盖住整屏（聊天画面）。
// column：body 里的内容居中一列（对话最宽 608，宽屏两边留白是为了可读）。不收 className 和 style。
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { type DataAttrs, pickData } from './data-attrs';

export function Workspace({ children, ...rest }: { children: ReactNode } & DataAttrs) {
  return (
    <div
      {...pickData(rest)}
      className="flex min-h-0 min-w-0 flex-col gap-section-gap md:h-intake-desk md:flex-row"
    >
      {children}
    </div>
  );
}

const SIZE = {
  list: 'w-full md:w-80 md:shrink-0',
  rail: 'w-full md:w-16 md:shrink-0',
  fill: 'w-full min-w-0 md:flex-1',
  screen: 'fixed inset-0 z-40 rounded-none',
} as const;

export function Pane({
  label,
  as: Tag = 'section',
  size = 'fill',
  head,
  foot,
  column,
  children,
  ...rest
}: {
  /** 无障碍名字（aria-label）。 */
  label: string;
  as?: 'section' | 'nav' | 'aside';
  size?: keyof typeof SIZE;
  head?: ReactNode;
  foot?: ReactNode;
  column?: boolean;
  children?: ReactNode;
} & DataAttrs) {
  return (
    <Tag
      aria-label={label}
      {...pickData(rest)}
      className={cn('flex min-h-0 flex-col overflow-hidden rounded-md bg-card text-ink', SIZE[size])}
    >
      {head ? <div className="shrink-0 border-b border-line px-4 py-3">{head}</div> : null}
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {column ? (
          <div className="mx-auto flex max-w-chat flex-col gap-3 px-4 py-4">{children}</div>
        ) : (
          children
        )}
      </div>
      {foot ? <div className="shrink-0 border-t border-line px-4 py-3">{foot}</div> : null}
    </Tag>
  );
}
