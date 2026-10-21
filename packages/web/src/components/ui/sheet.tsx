'use client';

import { XIcon } from 'lucide-react';
import { Dialog as SheetPrimitive } from 'radix-ui';
import type * as React from 'react';
import { useBackClose } from '../../lib/use-back-close';
import { cn } from '../../lib/utils';
import { focusRing, maskMotion, motionStop } from './styles';

/**
 * 抽屉（#3509，照 Arco，样稿 canvas/fd3.css `.drawer`）：卡片底、靠边一道 line、抽屉阴影（pop-side）；mask 遮罩；
 * 滑入 300、滑出 200，ease-arco；头、脚各一道 line 分开，左右 20。
 * 打开时压一条历史记录，手机后退键只关这一层、留在本页（lib/use-back-close.ts，#1820）。
 * historyEntry={false}：这个抽屉的打开本身已经压了历史（地址参数 ?run=），不再重复压。
 */
function Sheet({
  historyEntry = true,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Root> & { historyEntry?: boolean }) {
  const { open, onOpenChange } = props;
  useBackClose(historyEntry && open === true, () => onOpenChange?.(false));
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger({ ...props }: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose({ ...props }: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetPortal({ ...props }: React.ComponentProps<typeof SheetPrimitive.Portal>) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

function SheetOverlay({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay data-slot="sheet-overlay" className={cn(maskMotion, className)} {...props} />
  );
}

function SheetContent({
  className,
  children,
  side = 'right',
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  side?: 'top' | 'right' | 'bottom' | 'left';
  showCloseButton?: boolean;
}) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          'fixed z-50 flex flex-col gap-4 bg-card text-ink ease-arco data-[state=closed]:animate-out data-[state=closed]:duration-200 data-[state=open]:animate-in data-[state=open]:duration-300',
          motionStop,
          side === 'right' &&
            'inset-y-0 right-0 h-full w-3/4 border-l border-line shadow-pop-side data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm',
          side === 'left' &&
            'inset-y-0 left-0 h-full w-3/4 border-r border-line shadow-pop data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm',
          side === 'top' &&
            'inset-x-0 top-0 h-auto border-b border-line shadow-pop data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top',
          side === 'bottom' &&
            'inset-x-0 bottom-0 h-auto border-t border-line shadow-pop data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom',
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close
            className={cn(
              'absolute top-2 right-2 grid size-11 cursor-pointer place-items-center rounded-sm text-ink-3 transition-colors duration-100 hover:bg-fill-2 hover:text-ink md:top-4 md:right-4 md:size-7',
              focusRing,
            )}
          >
            <XIcon className="size-4" />
            <span className="sr-only">关闭</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Content>
    </SheetPortal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-header"
      className={cn('flex flex-col gap-1 border-b border-line px-5 py-4 pr-12', className)}
      {...props}
    />
  );
}

function SheetFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn('mt-auto flex flex-col gap-2 border-t border-line px-5 py-3', className)}
      {...props}
    />
  );
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn('text-heading text-ink', className)}
      {...props}
    />
  );
}

function SheetDescription({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn('text-body text-ink-3', className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
};
