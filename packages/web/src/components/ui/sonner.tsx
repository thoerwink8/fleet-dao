import { CircleCheckIcon, InfoIcon, Loader2Icon, OctagonXIcon, TriangleAlertIcon } from 'lucide-react';
import type * as React from 'react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';
import { useTheme } from '../theme-provider';

// shadcn 原版依赖 next-themes，这里改成跟驾驶舱自己的主题走。
const Toaster = (props: ToasterProps) => {
  const { resolvedMode } = useTheme();
  return (
    <Sonner
      theme={resolvedMode}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4 text-ink-done" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4 text-ink-stall" />,
        error: <OctagonXIcon className="size-4 text-ink-fail" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius)',
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
