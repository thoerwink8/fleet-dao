import { CircleCheckIcon, InfoIcon, Loader2Icon, OctagonXIcon, TriangleAlertIcon } from 'lucide-react';
import type * as React from 'react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';
import { useTheme } from '../theme-provider';

// shadcn 原版依赖 next-themes，这里改成跟驾驶舱自己的亮暗走（跟随系统）。
// 样子照 Arco 的全局提示（#3509）：卡片底、line 描边、浮层阴影、4 圆角；图标用填充色（成功绿、提醒橙、出错红、说明蓝）。
const Toaster = (props: ToasterProps) => {
  const { resolvedMode } = useTheme();
  return (
    <Sonner
      theme={resolvedMode}
      className="toaster group"
      toastOptions={{ classNames: { toast: 'shadow-pop! text-body!' } }}
      icons={{
        success: <CircleCheckIcon className="size-4 text-success" />,
        info: <InfoIcon className="size-4 text-brand" />,
        warning: <TriangleAlertIcon className="size-4 text-warn" />,
        error: <OctagonXIcon className="size-4 text-fail" />,
        loading: <Loader2Icon className="size-4 animate-spin text-brand" />,
      }}
      style={
        {
          '--normal-bg': 'var(--card)',
          '--normal-text': 'var(--ink)',
          '--normal-border': 'var(--line)',
          '--border-radius': 'var(--radius-md)',
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
