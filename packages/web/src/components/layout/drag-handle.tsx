// 拖动柄（路由页可排序的行）：浮在行左边的留白里，鼠标设备上悬停这一行才露出，键盘聚焦时也露出；手机不画（用「⋯」菜单挪）。
// Alt+方向键、Alt+Home/End 的键盘快捷键挂在它上面（调用方传 onKeyDown）。不收 className 和 style。
import { GripVertical } from 'lucide-react';
import type { DragEvent, KeyboardEvent } from 'react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { revealOnRowHover } from './row-menu';

export function DragHandle({
  label,
  title,
  draggable,
  disabled,
  busy,
  onDragStart,
  onDragEnd,
  onKeyDown,
}: {
  /** 无障碍名字（「拖动 X」）。 */
  label: string;
  title: string;
  draggable: boolean;
  /** 整体不能拖（远程环境）：原生 disabled。 */
  disabled: boolean;
  /** 正在保存：只标 aria-disabled，不置灰，焦点不丢。 */
  busy: boolean;
  onDragStart: (e: DragEvent<HTMLButtonElement>) => void;
  onDragEnd: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className={cn(
        'absolute top-1/2 left-0 hidden -translate-y-1/2 cursor-grab text-ink-3 md:inline-flex',
        revealOnRowHover,
      )}
      draggable={draggable}
      disabled={disabled}
      aria-disabled={busy || undefined}
      title={title}
      aria-label={label}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onKeyDown={onKeyDown}
    >
      <GripVertical aria-hidden />
    </Button>
  );
}
