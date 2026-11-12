import { Content, Item, Portal, Root, Trigger } from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export const Menu = Root;
export const MenuTrigger = Trigger;

export function MenuContent({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Portal>
      <Content
        sideOffset={6}
        align="start"
        className={cn(
          'z-50 max-h-72 min-w-36 overflow-y-auto rounded-md border border-edge bg-menu p-1 shadow-md',
          className,
        )}
      >
        {children}
      </Content>
    </Portal>
  );
}

export function MenuItem({
  children,
  onSelect,
  disabled,
}: {
  children: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
}) {
  return (
    <Item
      disabled={disabled}
      onSelect={() => onSelect?.()}
      className="flex cursor-pointer items-center rounded-sm px-2 py-1.5 text-xs text-ink outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-subtle"
    >
      {children}
    </Item>
  );
}
