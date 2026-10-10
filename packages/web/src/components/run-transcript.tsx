// 任务页每一笔（三段里跑的一次）下面的「会话内容」（#1640）：按对话的样子从上到下列提示词、助手的话、工具调用和结果、报错、结论。
// 数据来自后端按段记的 run_transcript（引擎写、接口按段增量读）。默认收起，点开才读；在跑的那一笔默认展开、每 3 秒往后追加。
// 工具调用默认折成一行（工具名加摘要），点开看紧跟着的那条结果；子代理里的条目缩进并标类型；被截断的原样写（末尾已带「…[已截断]」）。
import { errMessage } from '@fleet-dao/shared/util';
import { ChevronRight, LoaderCircle } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useRunTranscript } from '../api/client';
import type { TranscriptEntry } from '../api/types';
import { formatClock } from '../lib/format';
import { cn } from '../lib/utils';
import { Button } from './ui/button';

/** 一次最多画多少条；更早的点「显示更早的」再放出这么多。 */
export const TRANSCRIPT_WINDOW = 200;
/** 提示词默认只露开头几行；超过这个行数或字数才给「看全文」。 */
const PROMPT_LINES = 4;
const PROMPT_CHARS = 240;

/** 渲染用的一行：工具调用和紧跟着的工具结果并成一行。 */
type Item =
  | { kind: 'call'; call: TranscriptEntry; result: TranscriptEntry | undefined }
  | { kind: 'entry'; entry: TranscriptEntry };

const isSub = (e: TranscriptEntry) => e.meta?.subagent === true;

/**
 * 工具调用和它的结果（同一个工具、同一层）并起来：结果通常紧跟着；调用的是子代理时，结果在子代理那几条之后，往后找到同层、
 * 同工具的第一条结果为止，中间又出现同层同工具的调用就不再找。找不到结果的（还没回来、被截掉的）单画调用。
 */
export function groupEntries(entries: readonly TranscriptEntry[]): Item[] {
  const items: Item[] = [];
  const used = new Set<number>();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e || used.has(i)) continue;
    if (e.kind !== 'tool_call') {
      items.push({ kind: 'entry', entry: e });
      continue;
    }
    let result: TranscriptEntry | undefined;
    for (let j = i + 1; j < entries.length; j++) {
      const n = entries[j];
      if (!n || used.has(j) || isSub(n) !== isSub(e) || n.tool !== e.tool) continue;
      if (n.kind === 'tool_result') {
        result = n;
        used.add(j);
      }
      if (n.kind === 'tool_result' || n.kind === 'tool_call') break;
    }
    items.push({ kind: 'call', call: e, result });
  }
  return items;
}
const subType = (e: TranscriptEntry): string => {
  const t = e.meta?.subagentType;
  return typeof t === 'string' && t ? t : '';
};

function SubagentTag({ entry }: { entry: TranscriptEntry }) {
  return (
    <span
      className="mb-1 inline-flex h-5 items-center rounded border border-dashed px-1.5 text-caption text-muted-foreground"
      data-subagent-tag
    >
      子代理 {subType(entry)}
    </span>
  );
}

function Prompt({ entry }: { entry: TranscriptEntry }) {
  const [full, setFull] = useState(false);
  const long = entry.text.split('\n').length > PROMPT_LINES || entry.text.length > PROMPT_CHARS;
  return (
    <div className="rounded-lg border bg-muted/40 px-3 py-2" data-kind="prompt">
      <div className="text-caption font-medium text-muted-foreground">提示词</div>
      <p
        className={cn(
          'mt-1 min-w-0 text-sub break-words whitespace-pre-wrap',
          long && !full && 'line-clamp-4',
        )}
      >
        {entry.text}
      </p>
      {long ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="mt-1 -ml-1.5"
          aria-expanded={full}
          onClick={() => setFull((v) => !v)}
        >
          {full ? '收起' : '看全文'}
        </Button>
      ) : null}
    </div>
  );
}

function ToolCall({ call, result }: { call: TranscriptEntry; result: TranscriptEntry | undefined }) {
  const [open, setOpen] = useState(false);
  const failed = result?.ok === false;
  return (
    <div className="min-w-0 text-sub" data-kind="tool_call">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-baseline gap-1.5 rounded-md px-1 py-0.5 text-left hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <ChevronRight
          className={cn('size-3.5 shrink-0 translate-y-0.5 text-muted-foreground', open && 'rotate-90')}
          aria-hidden
        />
        <span className="num shrink-0 font-medium">{call.tool ?? '工具'}</span>
        <span className={cn('num min-w-0 text-muted-foreground', open ? 'break-words' : 'truncate')}>
          {call.text}
        </span>
        {failed ? <span className="shrink-0 text-caption font-medium text-ink-fail">没成</span> : null}
      </button>
      {open ? (
        <div
          className={cn(
            'mt-1 ml-5 rounded-md border px-2.5 py-1.5',
            failed ? 'border-st-fail/40 bg-st-fail/10' : 'bg-muted/40',
          )}
          data-kind="tool_result"
        >
          {result ? (
            <>
              <div className={cn('text-caption font-medium', failed ? 'text-ink-fail' : 'text-ink-done')}>
                {result.ok === false ? '没成' : result.ok === true ? '成了' : '结果'}
              </div>
              <p className="num mt-0.5 min-w-0 text-caption break-words whitespace-pre-wrap">{result.text}</p>
            </>
          ) : (
            <span className="text-caption text-muted-foreground">还没有结果</span>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Entry({ entry }: { entry: TranscriptEntry }) {
  switch (entry.kind) {
    case 'prompt':
      return <Prompt entry={entry} />;
    case 'assistant':
      return (
        <p className="min-w-0 text-sub break-words whitespace-pre-wrap" data-kind="assistant">
          {entry.text}
        </p>
      );
    case 'error':
      return (
        <div
          role="alert"
          className="rounded-lg border border-st-fail/40 bg-st-fail/10 px-3 py-2 text-sub text-ink-fail"
          data-kind="error"
        >
          <span className="font-medium">报错</span>
          <p className="mt-0.5 min-w-0 break-words whitespace-pre-wrap">{entry.text}</p>
        </div>
      );
    case 'result':
      return (
        <div
          className={cn(
            'rounded-lg border-2 px-3 py-2 text-sub',
            entry.ok === false ? 'border-st-fail/60 bg-st-fail/10' : 'border-st-done/60 bg-st-done/10',
          )}
          data-kind="result"
        >
          <div
            className={cn(
              'text-caption font-semibold',
              entry.ok === false ? 'text-ink-fail' : 'text-ink-done',
            )}
          >
            结论
          </div>
          <p className="mt-0.5 min-w-0 font-medium break-words whitespace-pre-wrap">{entry.text}</p>
        </div>
      );
    case 'truncated':
      return (
        <p className="min-w-0 text-caption break-words text-muted-foreground" data-kind="truncated">
          {entry.text}
        </p>
      );
    case 'tool_result':
      // 前面没有对上的调用（窗口切在中间、调用被丢了）：单画结果
      return (
        <p
          className="num min-w-0 text-caption break-words whitespace-pre-wrap text-muted-foreground"
          data-kind="tool_result"
        >
          {entry.tool ? `${entry.tool} 的结果：` : '工具结果：'}
          {entry.text}
        </p>
      );
    default:
      return <p className="min-w-0 text-sub break-words whitespace-pre-wrap">{entry.text}</p>;
  }
}

/** 条目列表：只画最近 visible 条，更早的收在「显示更早的」后面；子代理里的缩进、标类型。 */
export function TranscriptEntries({ entries }: { entries: readonly TranscriptEntry[] }) {
  const [visible, setVisible] = useState(TRANSCRIPT_WINDOW);
  const hidden = Math.max(0, entries.length - visible);
  const shown = hidden ? entries.slice(hidden) : entries;
  const items = groupEntries(shown);
  const rows: ReactNode[] = [];
  let prevSub: string | undefined;
  for (const item of items) {
    const head = item.kind === 'call' ? item.call : item.entry;
    const sub = isSub(head);
    const key = `${head.seq}`;
    const tag = sub && prevSub !== subType(head) ? <SubagentTag entry={head} /> : null;
    prevSub = sub ? subType(head) : undefined;
    rows.push(
      <li
        key={key}
        data-seq={head.seq}
        data-subagent={sub ? '' : undefined}
        className={cn('min-w-0', sub && 'ml-4 border-l-2 pl-3')}
      >
        {tag}
        {item.kind === 'call' ? (
          <ToolCall call={item.call} result={item.result} />
        ) : (
          <Entry entry={item.entry} />
        )}
      </li>,
    );
  }
  return (
    <div>
      {hidden ? (
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="mb-2"
          onClick={() => setVisible((v) => v + TRANSCRIPT_WINDOW)}
        >
          显示更早的（还有 {hidden} 条）
        </Button>
      ) : null}
      <ol className="space-y-2" aria-label="会话内容">
        {rows}
      </ol>
    </div>
  );
}

/** 「没读成：」开头的不重复写一遍。 */
function reasonOf(error: unknown): string {
  return errMessage(error).replace(/^没读成[：:]\s*/, '');
}

function TranscriptBody({ taskId, runId }: { taskId: string; runId: string }) {
  const q = useRunTranscript(taskId, runId, true);
  const data = q.data;
  if (q.isPending && !data) {
    return (
      <p className="flex items-center gap-1.5 text-sub text-muted-foreground" role="status">
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
        正在读会话内容…
      </p>
    );
  }
  return (
    <div className="space-y-2" data-transcript-body>
      {q.isError ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-st-fail/40 bg-st-fail/10 px-3 py-2 text-sub text-ink-fail"
        >
          <span className="min-w-0 break-words">没读成：{reasonOf(q.error)}</span>
          <Button type="button" size="xs" variant="outline" onClick={() => void q.refetch()}>
            重试
          </Button>
        </div>
      ) : null}
      {data?.noRecord ? (
        <p className="text-sub text-muted-foreground" data-no-record>
          这一段跑在记录会话内容之前，没有记录
        </p>
      ) : null}
      {data && !data.noRecord && !data.entries.length && !q.isError ? (
        <p className="text-sub text-muted-foreground">还没有内容，会话刚起来。</p>
      ) : null}
      {data?.entries.length ? <TranscriptEntries entries={data.entries} /> : null}
      {data && !data.done && !q.isError && !data.noRecord ? (
        <p className="flex items-center gap-1.5 text-caption text-ink-run" data-live>
          <span className="size-1.5 animate-pulse rounded-full bg-st-run" aria-hidden />
          还在跑，每 3 秒读一次新的
          {q.dataUpdatedAt ? (
            <span className="num text-muted-foreground">
              （上次 {formatClock(new Date(q.dataUpdatedAt).toISOString())}）
            </span>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

/** 一笔下面的「会话内容」：默认收起、点开才读；在跑的那一笔默认展开。 */
export function RunTranscript({
  taskId,
  runId,
  running,
}: {
  taskId: string;
  runId: string;
  running: boolean;
}) {
  const [open, setOpen] = useState(running);
  return (
    <div className="mt-2" data-transcript={runId}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-md px-1 py-0.5 text-sub font-medium hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <ChevronRight className={cn('size-3.5 text-muted-foreground', open && 'rotate-90')} aria-hidden />
        会话内容
      </button>
      {open ? (
        <div className="mt-1.5">
          <TranscriptBody taskId={taskId} runId={runId} />
        </div>
      ) : null}
    </div>
  );
}
