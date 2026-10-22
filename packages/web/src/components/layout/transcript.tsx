// 一笔会话内容的几件（#3533，task-run 弹出窗口、任务页的会话抽屉共用，业务组件 run-transcript.tsx、call-row.tsx 只拼它们）。
// 像对话不像日志：助手的话、提示词、结论用 Message（chat.tsx）；这里补会话独有的几样——
// - TranscriptPane：竖排三段（筛选条、自己滚的正文、底栏），正文贴底跟随靠页面拿 scrollRef；
// - TranscriptList、TranscriptItem：条目列表（ol/li），一条一个 li，data-block 记它是哪种块；
// - StepDivider：步骤开头的分隔线（序号、标题、起始时刻、用时）；
// - ToolToggle：一行调用或一组调用的展开行（箭头、灰色动词、对象、行尾标记），开合由页面管；
// - OutputBox、SubagentFrame：展开后的输出框、子代理那张能收起的卡；
// - ClampedText：超长文字（工具输出、提示词）。
// 不收 className 和 style；data-* 落在最外层。
import { Bot, ChevronRight } from 'lucide-react';
import type { ComponentProps, ReactNode, Ref, UIEvent } from 'react';
import { cn } from '../../lib/utils';

type DataAttrs = { [K in `data-${string}`]?: string | number | boolean | undefined };
type Plain = Omit<ComponentProps<'div'>, 'className' | 'style' | 'children' | 'onToggle' | 'title'>;
type PlainP = Omit<ComponentProps<'p'>, 'className' | 'style' | 'children'>;

/** 会话的外框：筛选条在上、正文自己滚、底栏在下。放它的容器要是竖排 flex 并给定高度，它自己撑满。 */
export function TranscriptPane({
  filters,
  search,
  footer,
  scrollRef,
  onScroll,
  children,
}: {
  /** 筛选条（全部 / 只看出错 / 只看文字）。 */
  filters?: ReactNode;
  /** 右边的「在会话里找」（搜索框加命中计数）；窄屏换到下一行。 */
  search?: ReactNode;
  footer?: ReactNode;
  /** 正文那块滚动区：页面据此量离底多远、贴底跟随、跳到最新。 */
  scrollRef?: Ref<HTMLDivElement>;
  onScroll?: (e: UIEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {filters || search ? (
        <div
          data-transcript-filters
          className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-4 py-2"
        >
          <div className="min-w-0 max-w-full">{filters}</div>
          <div className="flex min-w-0 items-center gap-2 max-md:w-full md:flex-1 md:justify-end">
            {search}
          </div>
        </div>
      ) : null}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        data-transcript-body
        className="scrollbar-thin flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-4 py-3"
      >
        {children}
      </div>
      {footer}
    </div>
  );
}

/** 底栏一行（在跑的「还在跑 · 每 3 秒读一次」，离开底部时右边带「跳到最新」）。 */
export function TranscriptFooter({ action, children }: { action?: ReactNode; children: ReactNode }) {
  return (
    <div
      data-live
      className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-1.5 text-meta text-ink-3"
    >
      <span className="num min-w-0 truncate">{children}</span>
      {action ? <span className="ml-auto shrink-0">{action}</span> : null}
    </div>
  );
}

export function TranscriptList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ol aria-label={label} className="flex min-w-0 flex-col gap-3">
      {children}
    </ol>
  );
}

/** 列表里的一条。block：它是哪种块（divider、say、tools、subagent、entry）；seq：条目序号。 */
export function TranscriptItem({
  block,
  seq,
  children,
}: {
  block?: string | undefined;
  seq?: number | undefined;
  children: ReactNode;
}) {
  return (
    <li
      className="flex min-w-0 flex-col"
      {...(block !== undefined ? { 'data-block': block } : {})}
      {...(seq !== undefined ? { 'data-seq': seq } : {})}
    >
      {children}
    </li>
  );
}

export type DividerTone = 'default' | 'processing' | 'error';

/**
 * 步骤开头的分隔线：圆圈序号、标题、起始时刻、用时，右边一条横线。
 * 在跑的是品牌色字（tone=processing），有失败的是红字（tone=error）；flag 放标题后面的小标签（「有失败」）。
 */
export function StepDivider({
  index,
  title,
  tail,
  tone = 'default',
  flag,
}: {
  /** 步骤序号，从 0 数起，圆圈里写 index + 1。 */
  index: number;
  title: ReactNode;
  /** 起始时刻、用时、「在跑」，用 · 连起来。 */
  tail?: string;
  tone?: DividerTone;
  flag?: ReactNode;
}) {
  return (
    <div
      data-step-divider={index}
      data-tone={tone}
      className={cn(
        'flex min-w-0 items-center gap-2 pt-2 text-meta',
        tone === 'processing' ? 'text-brand-ink' : tone === 'error' ? 'text-fail-ink' : 'text-ink-3',
      )}
    >
      <span className="num inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-line-2">
        {index + 1}
      </span>
      <span className="min-w-0 truncate font-medium">{title}</span>
      {tail ? <span className="num shrink-0">· {tail}</span> : null}
      {flag ? <span className="shrink-0">{flag}</span> : null}
      <span className="h-px min-w-4 flex-1 bg-line" aria-hidden />
    </div>
  );
}

/**
 * 一行调用或一组调用的展开行：箭头、灰色动词（lead）、对象（label）、行尾标记（trailing）。
 * 开没开由页面管（有失败的自动展开、人点过就听人的）；展开的内容放 children，开着才画。
 * failed：动词和对象标红。wrap：展开时对象换行写全，不截成一行。quiet：对象灰一档（一组调用的摘要）。mono：对象用等宽（命令、路径）。
 */
export function ToolToggle({
  open,
  onToggle,
  lead,
  label,
  title,
  failed,
  wrap,
  quiet,
  mono,
  trailing,
  children,
  ...rest
}: {
  open: boolean;
  onToggle: () => void;
  lead?: ReactNode;
  label: ReactNode;
  /** 对象的悬停全文（被截断时看）。 */
  title?: string;
  failed?: boolean;
  wrap?: boolean;
  quiet?: boolean;
  mono?: boolean;
  trailing?: ReactNode;
  children?: ReactNode;
} & DataAttrs &
  Plain) {
  return (
    <div className="min-w-0 text-body" {...rest}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex min-h-8 w-full min-w-0 items-baseline gap-1.5 rounded-sm px-1 py-0.5 text-left text-ink outline-none hover:bg-fill-2 focus-visible:ring-2 focus-visible:ring-brand-hover max-md:min-h-10 max-md:items-center"
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 translate-y-0.5 text-ink-3 max-md:translate-y-0',
            open && 'rotate-90',
          )}
          aria-hidden
        />
        {lead ? (
          <span className={cn('shrink-0', failed ? 'font-medium text-fail-ink' : 'text-ink-3')}>{lead}</span>
        ) : null}
        <span
          {...(title !== undefined ? { title } : {})}
          className={cn(
            'min-w-0',
            mono && 'num',
            open && wrap ? 'break-words' : 'truncate',
            failed ? 'text-fail-ink' : quiet && 'text-ink-3',
          )}
        >
          {label}
        </span>
        {trailing}
      </button>
      {open ? children : null}
    </div>
  );
}

/** 展开后的输出框：灰底（failed 是淡红底），可选一行小标题。 */
export function OutputBox({
  failed,
  label,
  indent = true,
  children,
  ...rest
}: {
  failed?: boolean;
  label?: string;
  /** 缩进到和上面一行的对象对齐（调用的输出）；放在卡里（子代理回的话）时不缩。 */
  indent?: boolean;
  children: ReactNode;
} & DataAttrs &
  Plain) {
  return (
    <div
      data-tone={failed ? 'danger' : 'muted'}
      className={cn(
        'my-1 min-w-0 rounded-sm px-2.5 py-1.5',
        indent && 'ml-5',
        failed ? 'bg-fail-1' : 'bg-fill-1',
      )}
      {...rest}
    >
      {label ? <div className="text-meta font-medium text-ink-3">{label}</div> : null}
      {children}
    </div>
  );
}

/** 子代理那张卡：头一行（箭头、机器人图标、一句话、行尾标记），点开是它的调用和它回的话。 */
export function SubagentFrame({
  open,
  onToggle,
  head,
  trailing,
  children,
  ...rest
}: {
  open: boolean;
  onToggle: () => void;
  /** 头上那句话：「子代理 类型 · 它在干什么 · N 次调用 · 用时」。 */
  head: string;
  trailing?: ReactNode;
  children?: ReactNode;
} & DataAttrs &
  Plain) {
  return (
    <div className="min-w-0 rounded-md border border-line" {...rest}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-body text-ink outline-none hover:bg-fill-2 focus-visible:ring-2 focus-visible:ring-brand-hover"
      >
        <ChevronRight className={cn('size-3.5 shrink-0 text-ink-3', open && 'rotate-90')} aria-hidden />
        <Bot className="size-4 shrink-0 text-ink-3" aria-hidden />
        <span data-subagent-head className="min-w-0 truncate">
          {head}
        </span>
        {trailing}
      </button>
      {open ? <div className="flex flex-col gap-1.5 border-t border-line px-3 py-2">{children}</div> : null}
    </div>
  );
}

/**
 * 超长文字。variant：output 工具输出（12 号、保留换行）；body 正文（14 号、保留换行）。
 * lines：只露前几行（line-clamp），点开才全文（提示词用）。
 */
export function ClampedText({
  variant = 'output',
  lines,
  tone,
  children,
  ...rest
}: {
  variant?: 'output' | 'body';
  /** 只露前几行；不给就整段写出。 */
  lines?: 2 | 4;
  tone?: 'default' | 'danger';
  children: ReactNode;
} & DataAttrs &
  PlainP) {
  return (
    <p
      {...(lines ? { 'data-clamped': lines } : {})}
      className={cn(
        'min-w-0 break-words whitespace-pre-wrap',
        variant === 'output' ? 'num text-meta' : 'text-body',
        tone === 'danger' ? 'text-fail-ink' : variant === 'output' ? 'text-ink-2' : 'text-ink',
        lines === 2 && 'line-clamp-2',
        lines === 4 && 'line-clamp-4',
      )}
      {...rest}
    >
      {children}
    </p>
  );
}
