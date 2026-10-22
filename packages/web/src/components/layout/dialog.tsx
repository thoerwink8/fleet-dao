// 对话框（包 ui/dialog，样子照 Arco 的 Modal）：标题、一句说明、中间放内容（选择器、表单）。
// 要「确定 / 先不」的确认走 ConfirmDialog；这个给需要自己放内容的弹窗。不收 className 和 style。
import type { ReactNode } from 'react';
import {
  Dialog as BaseDialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <BaseDialog open={open} onOpenChange={onOpenChange}>
      <DialogContent {...(description ? {} : { 'aria-describedby': undefined })}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children}
      </DialogContent>
    </BaseDialog>
  );
}
