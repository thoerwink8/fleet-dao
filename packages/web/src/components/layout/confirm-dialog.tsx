// 确认框（包 ui/alert-dialog，参数名照 antd 的 Modal.confirm）。
// 点确定后等 onConfirm 的结果：等的时候确定键转圈，Esc、「先不」、点遮罩都关不掉；成功才关；
// 失败留在原处，页脚上面一行红字写原因（读屏会读，焦点送过去），确定键恢复能再点。
// danger＝删除、叫停这类收不回的操作，确定键是红的。不收 className 和 style。
import type { ReactElement, ReactNode } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../ui/alert-dialog';

export function ConfirmDialog({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  danger,
  confirmText = '确定',
  cancelText = '先不',
  onConfirm,
  confirmDisabled,
  children,
  secondary,
}: {
  /** 确定键现在不能点（原因必填但还没填）。 */
  confirmDisabled?: boolean;
  /** 说明下面的内容：原因输入框这类。 */
  children?: ReactNode;
  /**
   * 另一个能点的确定键（暂停框的「立刻停下」：和主确定键是同一件事的两种做法），排在主确定键左边、灰底次按钮。
   * 和主确定键共用忙态：一个在等的时候另一个点不动。
   */
  secondary?: { text: ReactNode; onConfirm: () => unknown };
  /** 受控：外面管开关。不传＝自己管（配 trigger 用）。 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** 点它打开确认框（一个按钮元素）。 */
  trigger?: ReactElement;
  title: ReactNode;
  description?: ReactNode;
  danger?: boolean;
  confirmText?: ReactNode;
  cancelText?: ReactNode;
  /** 点确定时调用。返回的 Promise 成功＝关，抛错＝留着写原因。 */
  onConfirm: () => unknown;
}) {
  return (
    <AlertDialog {...(open !== undefined ? { open } : {})} {...(onOpenChange ? { onOpenChange } : {})}>
      {trigger ? <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger> : null}
      <AlertDialogContent {...(description ? {} : { 'aria-describedby': undefined })}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? <AlertDialogDescription>{description}</AlertDialogDescription> : null}
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelText}</AlertDialogCancel>
          {secondary ? (
            <AlertDialogAction
              variant="secondary"
              onConfirm={async () => {
                await secondary.onConfirm();
              }}
            >
              {secondary.text}
            </AlertDialogAction>
          ) : null}
          <AlertDialogAction
            variant={danger ? 'danger' : 'primary'}
            {...(confirmDisabled ? { disabled: true } : {})}
            onConfirm={async () => {
              await onConfirm();
            }}
          >
            {confirmText}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
