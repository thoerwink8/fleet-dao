// 带下拉的小按钮（模型芯片这类）：文字按钮后面一个小箭头，点开是菜单。菜单里的项用 row-menu 的 RowMenuItem、RowMenuRadioGroup 等。
// disabledReason 给了就置灰、悬停写原因。不收 className 和 style。
import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '../ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { type DataAttrs, pickData } from './data-attrs';

export function MenuButton({
  label,
  title,
  disabledReason,
  align = 'start',
  children,
  ...rest
}: {
  label: ReactNode;
  /** 悬停提示。 */
  title?: string;
  disabledReason?: string | undefined;
  align?: 'start' | 'end';
  children: ReactNode;
} & DataAttrs) {
  const blocked = disabledReason !== undefined;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={blocked}
          title={blocked ? disabledReason : title}
          {...pickData(rest)}
        >
          <span className="max-w-40 truncate">{label}</span>
          <ChevronDown aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="min-w-56">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
