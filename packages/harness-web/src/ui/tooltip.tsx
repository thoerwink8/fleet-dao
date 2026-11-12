import { Content, Provider, Root, Trigger } from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <Provider delayDuration={400}>{children}</Provider>;
}

export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Root>
      <Trigger asChild>{children}</Trigger>
      <Content
        sideOffset={6}
        className={cn('z-50 rounded-md bg-fg-1 px-2 py-1 text-2xs text-raised shadow-md')}
      >
        {label}
      </Content>
    </Root>
  );
}
