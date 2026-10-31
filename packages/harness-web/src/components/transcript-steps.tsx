// 工人会话页里「工人做了什么」的几种行：助手的话（正文）、一次工具调用（一行，可展开看参数和结果）、运行结束、丢弃提示。
// 展开的长输出沿用 #3836 的预览：默认前 200 字或 12 行，可展开（OutputBlock）。
import {
  Bot,
  ChevronDown,
  ChevronRight,
  FilePen,
  FileText,
  Globe,
  LoaderCircle,
  type LucideIcon,
  Search,
  SquareTerminal,
  Wrench,
} from 'lucide-react';
import { useState } from 'react';
import { cn } from '../lib/cn';
import { formatClock, formatDuration } from '../lib/format';
import type { DroppedStep, EndStep, SayStep, ToolStep } from '../lib/transcript';
import { Chip } from './chip';
import { ClampedText, OutputBlock } from './clamped';

const ICON: Record<string, LucideIcon> = {
  Bash: SquareTerminal,
  PowerShell: SquareTerminal,
  Read: FileText,
  Write: FilePen,
  Edit: FilePen,
  MultiEdit: FilePen,
  NotebookEdit: FilePen,
  Grep: Search,
  Glob: Search,
  ToolSearch: Search,
  WebFetch: Globe,
  WebSearch: Globe,
  Agent: Bot,
  Task: Bot,
};

export const toolIcon = (name: string): LucideIcon => ICON[name] ?? Wrench;

/** 参数 JSON 好看一点：能解析就缩进，被截断的（解析不了）原样给。 */
function prettyInput(input: string, truncated: boolean): string {
  if (truncated || input === '') return input;
  try {
    return JSON.stringify(JSON.parse(input), null, 2);
  } catch {
    return input;
  }
}

/** 助手的话：正文样式（不套卡片），和旁边的工具行区分开。 */
export function SayRow({ step }: { step: SayStep }) {
  return (
    <li data-step-id={step.id} data-step-kind="say" className="animate-fade-in pb-3 pl-9">
      <p
        className="whitespace-pre-wrap break-words text-sm text-ink"
        title={`${formatClock(step.at)} · #${step.id}`}
      >
        {step.text}
      </p>
      {step.truncated ? (
        <p className="mt-1 text-2xs text-muted">这段话太长，库里只存了前一部分（原文约 {step.chars} 字）。</p>
      ) : null}
    </li>
  );
}

/** 一次工具调用：一行（图标、工具名、参数摘要、状态、时间），点开看参数和结果。 */
export function ToolRow({ step }: { step: ToolStep }) {
  const [open, setOpen] = useState(false);
  const Icon = toolIcon(step.name);
  const input = prettyInput(step.input, step.inputTruncated);
  return (
    <li
      data-step-id={step.id}
      data-step-kind="tool"
      data-tool-status={step.status}
      data-open={open}
      className="animate-fade-in pb-2 pl-9"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-9 w-full cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-left text-xs text-ink-2 hover:bg-subtle"
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted" />
        )}
        <Icon className="size-3.5 shrink-0 text-muted" />
        <span className="shrink-0 font-medium text-ink">{step.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-muted">{step.summary}</span>
        {step.status === 'error' ? <Chip tone="danger">出错</Chip> : null}
        {step.status === 'running' ? (
          <Chip tone="brand" className="gap-1">
            <LoaderCircle className="size-3 animate-spin" />
            运行中
          </Chip>
        ) : null}
        {step.status === 'noresult' ? <Chip>无结果</Chip> : null}
        <span className="num hidden shrink-0 text-2xs text-muted sm:inline">{formatClock(step.at)}</span>
      </button>
      {open ? (
        <div className="mt-1 rounded-lg border border-line bg-surface px-3 py-2" data-testid="tool-detail">
          {input ? (
            <OutputBlock label={step.inputTruncated ? '参数（已截断）' : '参数'} text={input} />
          ) : null}
          {step.result ? (
            <>
              <OutputBlock
                label={step.result.isError ? '结果（出错）' : '结果'}
                text={step.result.text || '（空）'}
              />
              {step.result.truncated ? (
                <p className="mt-1 text-2xs text-muted">
                  输出太长，库里只存了前 4KB（原文约 {step.result.chars} 字）。
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-2xs text-muted">
              {step.status === 'running' ? '还在跑，结果出来后自动出现。' : '这次调用没有留下结果。'}
            </p>
          )}
        </div>
      ) : null}
    </li>
  );
}

export function EndRow({ step }: { step: EndStep }) {
  return (
    <li data-step-id={step.id} data-step-kind="end" className="animate-fade-in pb-3 pl-9">
      <div className="rounded-lg border border-line bg-subtle px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-2xs font-medium text-muted">运行结束</span>
          <Chip tone={step.isError ? 'danger' : 'neutral'}>{step.isError ? '出错' : '正常'}</Chip>
          {step.numTurns !== null ? <Chip>{step.numTurns} 轮</Chip> : null}
          {step.durationMs !== null ? <Chip>{formatDuration(step.durationMs)}</Chip> : null}
          <span className="num ml-auto text-2xs text-muted">
            #{step.id} · {formatClock(step.at)}
          </span>
        </div>
        {step.text ? (
          <div className="mt-1 whitespace-pre-wrap break-words text-sm text-ink">
            <ClampedText text={step.text} />
          </div>
        ) : null}
      </div>
    </li>
  );
}

export function DroppedRow({ step }: { step: DroppedStep }) {
  return (
    <li data-step-id={step.id} data-step-kind="dropped" className="pb-3 pl-9 text-2xs text-warning">
      这次运行的过程太长，超过上限，后面还有 {step.count} 步没有存。
    </li>
  );
}

/** 折叠的一串工具调用：一行摘要，点开摊开每一步（收起时仍在页面里，hidden）。 */
export function ToolRunRow({
  steps,
  summary,
  failed,
  open,
  onToggle,
}: {
  steps: ToolStep[];
  summary: string;
  failed: number;
  open: boolean;
  onToggle: () => void;
}) {
  const first = steps[0];
  return (
    <li data-step-run={first?.id} data-open={open} data-failed={failed} className="pb-2 pl-9">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className={cn(
          'flex min-h-9 w-full cursor-pointer items-center gap-2 rounded-lg border bg-surface px-3 py-1.5 text-left text-xs text-ink-2 hover:bg-subtle',
          failed > 0 ? 'border-danger/40' : 'border-line',
        )}
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0" />
        )}
        <Wrench className="size-3.5 shrink-0 text-muted" />
        <span className="min-w-0 flex-1 break-words">{summary}</span>
        <span className="num shrink-0 text-2xs text-muted">
          #{first?.id}–{steps.at(-1)?.id}
        </span>
      </button>
      <ol hidden={!open} className="-ml-9 mt-2">
        {steps.map((st) => (
          <ToolRow key={st.id} step={st} />
        ))}
      </ol>
    </li>
  );
}
