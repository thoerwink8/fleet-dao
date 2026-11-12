import { Close, Content, Description, Overlay, Portal, Root, Title, Trigger } from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export const Dialog = Root;
export const DialogTrigger = Trigger;
export const DialogClose = Close;

export function DialogContent({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Portal>
      <Overlay className="fixed inset-0 z-50 bg-overlay" />
      <Content
        className={cn(
          'fixed top-1/2 left-1/2 z-50 w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-edge bg-modal p-4 shadow-md',
          className,
        )}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <Title className="text-sm font-medium text-ink">{title}</Title>
          <Close
            className="grid size-7 place-items-center rounded-md text-muted hover:bg-neutral-soft"
            aria-label="关闭"
          >
            <X className="size-4" />
          </Close>
        </div>
        {description ? <Description className="mb-3 text-2xs text-muted">{description}</Description> : null}
        {children}
      </Content>
    </Portal>
  );
}
