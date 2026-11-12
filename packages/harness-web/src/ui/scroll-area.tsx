import { Root, Scrollbar, Thumb, Viewport } from '@radix-ui/react-scroll-area';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export function ScrollArea({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <Root className={cn('min-h-0 overflow-hidden', className)}>
      <Viewport className="h-full w-full">{children}</Viewport>
      <Scrollbar orientation="vertical" className="flex w-2 touch-none p-0.5">
        <Thumb className="relative flex-1 rounded-full bg-line-strong" />
      </Scrollbar>
    </Root>
  );
}
