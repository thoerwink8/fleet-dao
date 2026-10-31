import { ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';
import { clampText } from '../lib/clamp';
import { cn } from '../lib/cn';

function ExpandButton({
  open,
  onClick,
  total,
}: {
  open: boolean;
  onClick: () => void;
  total: { chars: number; lines: number };
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onClick}
      className="mt-1 inline-flex h-6 cursor-pointer items-center gap-1 rounded-sm text-2xs text-brand-strong hover:underline"
    >
      {open ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
      {open ? '收起' : `展开全部（${total.chars} 字、${total.lines} 行）`}
    </button>
  );
}

/** 普通文字的长文本：默认前 200 字或 12 行，可展开。 */
export function ClampedText({ text, className }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const c = clampText(text);
  if (!c.truncated) return <span className={className}>{text}</span>;
  return (
    <span className={cn('block', className)} data-clamped={open ? 'open' : 'closed'}>
      {open ? text : `${c.preview}…`}
      <ExpandButton
        open={open}
        onClick={() => setOpen((v) => !v)}
        total={{ chars: c.totalChars, lines: c.totalLines }}
      />
    </span>
  );
}

/** 工具输出（证据、错误输出末尾）：等宽小块，默认只显示前 200 字或 12 行，可展开。 */
export function OutputBlock({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false);
  const c = clampText(text);
  return (
    <div
      className="mt-1.5"
      data-testid="tool-output"
      data-clamped={c.truncated ? (open ? 'open' : 'closed') : 'short'}
    >
      <div className="text-2xs text-muted">{label}</div>
      <pre
        className={cn(
          'mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-subtle p-3 font-mono text-2xs leading-5 text-ink-2',
          open && 'max-h-96 overflow-y-auto',
        )}
      >
        {open || !c.truncated ? text : `${c.preview}…`}
      </pre>
      {c.truncated ? (
        <ExpandButton
          open={open}
          onClick={() => setOpen((v) => !v)}
          total={{ chars: c.totalChars, lines: c.totalLines }}
        />
      ) : null}
    </div>
  );
}
