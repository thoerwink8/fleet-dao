// 折叠（样子照 Arco 的 Collapse）：标题一行带箭头，点开往下展开，高度加淡入 200，缓动 ease-arco。
// 低频的、高级的东西收在这里。跟着「减少动效」：开了就不动、直接切。不收 className 和 style。
import { ChevronRight } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { type ReactNode, useId, useState } from 'react';
import { cn } from '../../lib/utils';
import { DURATION_S, EASE_ARCO } from '../../theme/motion';

export function Collapse({
  title,
  defaultOpen = false,
  children,
}: {
  title: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const reduced = useReducedMotion();
  const id = useId();
  return (
    <div data-open={open}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-control items-center gap-2 rounded-sm text-body font-medium text-ink-2 transition-colors hover:text-ink"
      >
        <ChevronRight
          aria-hidden
          className={cn('size-4 transition-transform duration-200 ease-arco', open && 'rotate-90')}
        />
        {title}
      </button>
      <motion.div
        id={id}
        initial={false}
        animate={{ height: open ? 'auto' : 0, opacity: open ? 1 : 0 }}
        transition={reduced ? { type: false } : { duration: DURATION_S.base, ease: EASE_ARCO }}
        aria-hidden={!open}
        inert={!open}
        className="overflow-hidden"
      >
        <div className="pt-2 pb-1">{children}</div>
      </motion.div>
    </div>
  );
}
