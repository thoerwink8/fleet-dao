// 任务页「每一笔」的「看会话」抽屉（#1640、#1802）：从右侧滑出，按对话的样子从上到下列提示词、助手的话、工具调用和结果、报错、结论。
// 数据来自后端按段记的 run_transcript（引擎写、接口按段增量读）。抽屉打开才读；在跑的那一笔每 3 秒往后追加、贴底跟随，
// 人往上滚就停止跟随并出现「跳到最新」。工具调用默认折成一行（工具名加摘要），出错的自动展开；超长的输出截断、点「显示全部」。
// 有「只看出错」「只看文字」两个过滤。条目多时只画最近 200 条（没有虚拟滚动库，不加依赖），更早的点「显示更早的」再放出 200 条。
import { errMessage } from '@fleet-dao/shared/util';
import { ChevronRight, LoaderCircle } from 'lucide-react';
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useRunTranscript } from '../api/client';
import type { TranscriptEntry } from '../api/types';
import { formatClock, formatDuration, formatUsd } from '../lib/format';
import {
  liveMs,
  type SegmentRunView,
  segmentLabel,
  segmentOutcomeLabel,
  segmentOutcomeTone,
  UNKNOWN_SEGMENT,
} from '../lib/segments';
import { cn } from '../lib/utils';
import { StatusChip } from './status';
import { Button } from './ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './ui/sheet';

/** 一次最多画多少条；更早的点「显示更早的」再放出这么多。 */
export const TRANSCRIPT_WINDOW = 200;
/** 提示词默认只露开头几行；超过这个行数或字数才给「看全文」。 */
const PROMPT_LINES = 4;
const PROMPT_CHARS = 240;
/** 助手的话、工具结果超过这个行数或字数就截断，点「显示全部」看全文。 */
export const CLAMP_LINES = 16;
export const CLAMP_CHARS = 1200;
/** 离底部不到这么多像素算「贴底」。 */
const NEAR_BOTTOM_PX = 48;
/** 抽屉宽度：默认 640，拉宽不超过 80vw，最窄 420。 */
const DRAWER_DEFAULT_PX = 640;
const DRAWER_MIN_PX = 420;
const DRAWER_STEP_PX = 40;

/** 渲染用的一行：工具调用和紧跟着的工具结果并成一行。 */
type Item =
  | { kind: 'call'; call: TranscriptEntry; result: TranscriptEntry | undefined }
  | { kind: 'entry'; entry: TranscriptEntry };

export type TranscriptFilter = 'all' | 'errors' | 'text';

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

/** 出错的条目：没成的工具调用、报错、没成的结论、对不上调用的没成的结果。 */
export function isFailedItem(item: Item): boolean {
  if (item.kind === 'call') return item.result?.ok === false;
  const e = item.entry;
  return e.kind === 'error' || ((e.kind === 'result' || e.kind === 'tool_result') && e.ok === false);
}

/** 文字类条目：提示词、助手的话、报错、结论、截断说明；工具调用和工具结果不算。 */
export function isTextItem(item: Item): boolean {
  if (item.kind === 'call') return false;
  return item.entry.kind !== 'tool_result';
}

export function filterItems(items: Item[], filter: TranscriptFilter): Item[] {
  if (filter === 'errors') return items.filter(isFailedItem);
  if (filter === 'text') return items.filter(isTextItem);
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

/** 超长文字：只露开头，点「显示全部」看全文。短的原样画，不带按钮。 */
function Clamped({ text, className, dataKind }: { text: string; className: string; dataKind?: string }) {
  const [all, setAll] = useState(false);
  const lines = text.split('\n');
  const long = lines.length > CLAMP_LINES || text.length > CLAMP_CHARS;
  const shown = long && !all ? `${lines.slice(0, CLAMP_LINES).join('\n').slice(0, CLAMP_CHARS)}…` : text;
  return (
    <>
      <p className={className} data-kind={dataKind}>
        {shown}
      </p>
      {long ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="mt-1 -ml-1.5"
          aria-expanded={all}
          onClick={() => setAll((v) => !v)}
        >
          {all ? '收起' : '显示全部'}
        </Button>
      ) : null}
    </>
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

/** 工具调用：默认折成一行；没成的自动展开（人点过一次就听人的）。 */
function ToolCall({ call, result }: { call: TranscriptEntry; result: TranscriptEntry | undefined }) {
  const failed = result?.ok === false;
  const [picked, setPicked] = useState<boolean | undefined>(undefined);
  const open = picked ?? failed;
  return (
    <div className="min-w-0 text-sub" data-kind="tool_call" data-failed={failed ? '' : undefined}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setPicked(!open)}
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
              <Clamped
                text={result.text}
                className="num mt-0.5 min-w-0 text-caption break-words whitespace-pre-wrap"
              />
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
        <Clamped
          text={entry.text}
          dataKind="assistant"
          className="min-w-0 text-sub break-words whitespace-pre-wrap"
        />
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

const EMPTY_FILTERED: Record<Exclude<TranscriptFilter, 'all'>, string> = {
  errors: '这一笔没有出错的条目。',
  text: '这一笔没有文字条目。',
};

/** 条目列表：先按过滤留下要看的，再只画最近 visible 条，更早的收在「显示更早的」后面；子代理里的缩进、标类型。 */
export function TranscriptEntries({
  entries,
  filter = 'all',
}: {
  entries: readonly TranscriptEntry[];
  filter?: TranscriptFilter;
}) {
  const [visible, setVisible] = useState(TRANSCRIPT_WINDOW);
  const all = filterItems(groupEntries(entries), filter);
  const hidden = Math.max(0, all.length - visible);
  const items = hidden ? all.slice(hidden) : all;
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
      {rows.length ? (
        <ol className="space-y-2" aria-label="会话内容">
          {rows}
        </ol>
      ) : filter !== 'all' ? (
        <p className="text-sub text-muted-foreground" data-filter-empty>
          {EMPTY_FILTERED[filter]}
        </p>
      ) : null}
    </div>
  );
}

/** 「没读成：」开头的不重复写一遍。 */
function reasonOf(error: unknown): string {
  return errMessage(error).replace(/^没读成[：:]\s*/, '');
}

/** 过滤条：全部 / 只看出错 / 只看文字，再点一次已选的回到全部。 */
function FilterBar({
  filter,
  onChange,
  failedCount,
}: {
  filter: TranscriptFilter;
  onChange: (f: TranscriptFilter) => void;
  failedCount: number;
}) {
  const toggle = (f: Exclude<TranscriptFilter, 'all'>) => onChange(filter === f ? 'all' : f);
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-4 py-2" data-transcript-filters>
      <Button
        type="button"
        size="xs"
        variant={filter === 'errors' ? 'secondary' : 'outline'}
        aria-pressed={filter === 'errors'}
        onClick={() => toggle('errors')}
      >
        只看出错{failedCount ? `（${failedCount}）` : ''}
      </Button>
      <Button
        type="button"
        size="xs"
        variant={filter === 'text' ? 'secondary' : 'outline'}
        aria-pressed={filter === 'text'}
        onClick={() => toggle('text')}
      >
        只看文字
      </Button>
    </div>
  );
}

function TranscriptBody({ taskId, runId, running }: { taskId: string; runId: string; running: boolean }) {
  const q = useRunTranscript(taskId, runId, true);
  const data = q.data;
  const [filter, setFilter] = useState<TranscriptFilter>('all');
  const scroller = useRef<HTMLDivElement>(null);
  // 在跑的默认贴底跟随；人往上滚就记成不跟随，滚回底部再接上
  const follow = useRef(running);
  const [away, setAway] = useState(false);
  const count = data?.entries.length ?? 0;

  const measure = () => {
    const el = scroller.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    follow.current = gap <= NEAR_BOTTOM_PX;
    setAway(gap > NEAR_BOTTOM_PX);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: 条目数、过滤变了才重新贴底或量一次
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (follow.current) el.scrollTop = el.scrollHeight;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAway(gap > NEAR_BOTTOM_PX);
  }, [count, filter]);
  const jump = () => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    follow.current = true;
    setAway(false);
  };

  const failedCount = data ? groupEntries(data.entries).filter(isFailedItem).length : 0;
  return (
    <>
      <FilterBar filter={filter} onChange={setFilter} failedCount={failedCount} />
      <div className="relative min-h-0 flex-1">
        <div
          ref={scroller}
          onScroll={measure}
          className="h-full space-y-2 overflow-y-auto overscroll-contain px-4 py-3"
          data-transcript-body
        >
          {q.isPending && !data ? (
            <p className="flex items-center gap-1.5 text-sub text-muted-foreground" role="status">
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
              正在读会话内容…
            </p>
          ) : null}
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
          {data?.entries.length ? <TranscriptEntries entries={data.entries} filter={filter} /> : null}
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
        {away ? (
          <Button
            type="button"
            size="sm"
            className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-lg"
            onClick={jump}
          >
            跳到最新
          </Button>
        ) : null}
      </div>
    </>
  );
}

/** 抽屉顶上固定的一行：段、第几次、模型、成败、时长、花费。 */
function DrawerSummary({ run, nth, now }: { run: SegmentRunView; nth: number; now: number }) {
  const live = liveMs(run, now);
  const duration =
    run.durationMs !== undefined
      ? formatDuration(run.durationMs)
      : live !== undefined
        ? formatDuration(live)
        : '耗时没读到';
  const cost = run.costUsd !== undefined ? formatUsd(run.costUsd) : '花费没读到';
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1" data-drawer-summary>
      <span className="text-sm font-medium">{run.segment ? segmentLabel[run.segment] : UNKNOWN_SEGMENT}</span>
      <span className="num text-caption text-muted-foreground">第 {nth} 次</span>
      <span className="num text-sub">{run.modelName}</span>
      {run.running ? (
        <StatusChip tone="run" label="在跑" />
      ) : run.outcome ? (
        <StatusChip tone={segmentOutcomeTone[run.outcome]} label={segmentOutcomeLabel[run.outcome]} />
      ) : (
        <StatusChip tone="stall" label="结局没读到" />
      )}
      <span className="num text-caption text-muted-foreground">{duration}</span>
      <span className="num text-caption text-muted-foreground">{cost}</span>
    </div>
  );
}

/**
 * 「看会话」抽屉：桌面从右侧滑出，默认 640px，左边沿可拖或用左右键拉宽（最多 80vw）；手机全屏。
 * 关不关由上面（网址的 ?run=）管：onClose 在点遮罩、按 Esc、点叉时调用。
 */
export function RunTranscriptDrawer({
  taskId,
  run,
  nth,
  now,
  onClose,
}: {
  taskId: string;
  run: SegmentRunView;
  nth: number;
  now: number;
  onClose: () => void;
}) {
  const [width, setWidth] = useState(DRAWER_DEFAULT_PX);
  const maxWidth = () => Math.max(DRAWER_MIN_PX, Math.floor(window.innerWidth * 0.8));
  const clamp = (w: number) => Math.min(maxWidth(), Math.max(DRAWER_MIN_PX, w));
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const move = (ev: PointerEvent) => setWidth(clamp(window.innerWidth - ev.clientX));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') setWidth((w) => clamp(w + DRAWER_STEP_PX));
    else if (e.key === 'ArrowRight') setWidth((w) => clamp(w - DRAWER_STEP_PX));
    else return;
    e.preventDefault();
  };
  return (
    <Sheet
      open
      // 打开这个抽屉时地址已经压了一条 ?run=（routes/task.tsx），后退本来就关它；再压一条会多按一次后退（#1820）
      historyEntry={false}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <SheetContent
        side="right"
        className="w-full gap-0 sm:w-[min(var(--drawer-w),80vw)] sm:max-w-none"
        style={{ '--drawer-w': `${width}px` } as CSSProperties}
        data-run-drawer={run.id}
      >
        {/* biome-ignore lint/a11y/useSemanticElements: 可聚焦、可拖动的分隔条（window splitter），<hr> 不能带键盘和拖动 */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="拉宽抽屉"
          aria-valuenow={width}
          tabIndex={0}
          onPointerDown={onDown}
          onKeyDown={onKey}
          className="absolute inset-y-0 left-0 z-10 hidden w-1.5 cursor-col-resize hover:bg-border-strong focus-visible:bg-ring focus-visible:outline-none sm:block"
        />
        <SheetHeader className="shrink-0 gap-1 border-b py-3 pr-12">
          <SheetTitle className="text-sm">会话内容</SheetTitle>
          <SheetDescription className="sr-only">这一笔的提示词、助手的话、工具调用和结论</SheetDescription>
          <DrawerSummary run={run} nth={nth} now={now} />
        </SheetHeader>
        <TranscriptBody taskId={taskId} runId={run.id} running={run.running} />
      </SheetContent>
    </Sheet>
  );
}
