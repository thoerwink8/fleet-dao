// 悬停说明（包 ui/tooltip）：一个小问号图标，鼠标放上去或键盘聚焦到它就显示一小段说明。
// 手机没有悬停：触屏点一下也会打开（Radix 的 Tooltip 在触屏上点按钮不开，所以这里手动开）。不收 className 和 style。
import { CircleHelp } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';

export function InfoTip({ content, label = '说明' }: { content: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const touched = useRef(false);
  return (
    <TooltipProvider delayDuration={100}>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label}
            onPointerDown={(e) => {
              touched.current = e.pointerType === 'touch';
            }}
            onClick={() => {
              if (touched.current) setOpen(true);
            }}
            className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors hover:text-ink-2"
          >
            <CircleHelp aria-hidden className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{content}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
