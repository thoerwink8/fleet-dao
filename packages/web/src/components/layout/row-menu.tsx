// 行尾「⋯」菜单（规范第三节「行尾菜单」）：一行只留主信息、一个状态和一个开关，次要操作（挪位置、档位、移出……）收进这里。额度页的停用开关留在行里。
// - 鼠标设备上平时极淡地占着位置，悬停这一行、键盘焦点进到这一行或菜单开着时才变实（参照 Linear 列表行）；触屏没有悬停，一直实着。
// - 行要带 group/row（RowFrame 自带），露出才认得到「这一行」。
// - 菜单项在手机上至少 40 高（#1806），桌面按菜单常规高度（Arco `.pop-item` 32，样子在 ui/dropdown-menu.tsx）。
import { Ellipsis } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { type DataAttrs, pickData } from './data-attrs';

/** 悬停、焦点、菜单开着才露出：只在有精确指针（鼠标、触控板）的设备上藏，触屏一直显示。 */
export const revealOnRowHover =
  'pointer-fine:opacity-0 pointer-fine:group-hover/row:opacity-100 pointer-fine:group-focus-within/row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 transition-opacity duration-100';

/**
 * 「⋯」用的：平时也在原位、极淡（右边不空一块，看得出那里有东西），悬停这一行、焦点进来、菜单开着才变实（#1914 第 4 轮）。
 * 拖动柄浮在留白里，平时整个藏着（revealOnRowHover）。
 */
export const faintUntilRowHover =
  'pointer-fine:opacity-40 pointer-fine:group-hover/row:opacity-100 pointer-fine:group-focus-within/row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 transition-opacity duration-100';

export function RowMenu({
  label,
  title,
  reveal = true,
  open,
  onOpenChange,
  children,
  ...data
}: DataAttrs & {
  /** 受控：外面管开关（手机上长按一行打开）。不传＝自己管。 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** 按钮的无障碍名字，写清是哪一行的（「更多操作：Opus 5.5」）。 */
  label: string;
  /** 悬停提示：菜单里有什么。 */
  title?: string;
  /** 平时极淡、悬停这一行才变实（默认）。false = 一直实着。 */
  reveal?: boolean;
  children: ReactNode;
}) {
  return (
    <DropdownMenu {...(open !== undefined ? { open } : {})} {...(onOpenChange ? { onOpenChange } : {})}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          {...pickData(data)}
          data-row-menu
          className={cn('shrink-0 text-ink-3', reveal && faintUntilRowHover)}
          aria-label={label}
          title={title}
        >
          <Ellipsis aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const ITEM = 'max-md:min-h-10 max-md:px-3';

export function RowMenuItem({ className, ...props }: ComponentProps<typeof DropdownMenuItem>) {
  return <DropdownMenuItem className={cn(ITEM, className)} {...props} />;
}

export function RowMenuRadioGroup(props: ComponentProps<typeof DropdownMenuRadioGroup>) {
  return <DropdownMenuRadioGroup {...props} />;
}

/** 单选项左边留着选中圆点的位置（pl-8），手机上只加高、不动左内边距。 */
export function RowMenuRadioItem({ className, ...props }: ComponentProps<typeof DropdownMenuRadioItem>) {
  return <DropdownMenuRadioItem className={cn('max-md:min-h-10 max-md:pr-3', className)} {...props} />;
}

/** 菜单里一组的小标题（「档位」），可以带一行灰字说明。 */
export function RowMenuLabel({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <DropdownMenuLabel className="text-meta font-normal text-ink-3 max-md:px-3">
      {children}
      {hint ? <span className="mt-0.5 block max-w-64 font-normal whitespace-normal">{hint}</span> : null}
    </DropdownMenuLabel>
  );
}

export const RowMenuSeparator = DropdownMenuSeparator;
