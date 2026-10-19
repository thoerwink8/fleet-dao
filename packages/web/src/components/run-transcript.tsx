// 一笔的会话内容（#1640、#1802、#3277）：放在任务页右侧抽屉和弹出窗口里，像对话不像日志。
// - 按过程同一套步骤分段（shared 的 cutSteps）：每一步开头一条分隔线「序号 标题 · 起始时刻 · 用时」，在跑的蓝字。
// - 助手的话按 Markdown 排（components/markdown.tsx）；提示词收成两行的卡，「看全文」展开。
// - 两句话之间连着的调用并成一行「已运行 2 个命令，已读取 2 个文件 · 1 个失败」，点开每个调用一行（components/call-row.tsx，
//   和过程同一份）；有失败的组自动展开，失败的调用自动展开输出。子代理收成一张能收起的卡。
// - 「全部 / 只看出错 N / 只看文字」加「在会话里找」（命中高亮，回车下一个，命中的组和卡自动展开）。
// - 在跑的每 3 秒往后追加、贴底跟随；人往上滚就停，底栏一直写「还在跑 · 每 3 秒读一次 · 上次 时:分:秒」，离开底部时带「跳到最新」。
// - 结束的最后一张结论卡，过了绿框、没过红框。条目多时只画最近 200 块（不加虚拟滚动依赖），更早的点「显示更早的」。
import { cutSteps, type ProcessStep, processRowOf } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import { Bot, ChevronRight, LoaderCircle } from 'lucide-react';
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRunTranscript } from '../api/client';
import type { TranscriptEntry } from '../api/types';
import { formatClock, formatClockSeconds, formatDuration, formatUsd } from '../lib/format';
import {
  liveMs,
  type SegmentRunView,
  segmentLabel,
  segmentOutcomeLabel,
  segmentOutcomeTone,
  UNKNOWN_SEGMENT,
} from '../lib/segments';
import { causeLabel, sessionLink, UNTITLED_STEP } from '../lib/task-process';
import {
  type Block,
  blockEntries,
  blockSeq,
  buildBlocks,
  filterItems,
  groupEntries,
  hasHit,
  headOf,
  type Item,
  isFailedItem,
  type SubagentCard,
  type ToolItem,
  type TranscriptFilter,
  toolsSummary,
} from '../lib/transcript-items';
import { cn } from '../lib/utils';
import { CallRow, Clamped } from './call-row';
import { Notice } from './layout/notice';
import { SearchInput } from './layout/search-input';
import { StatusBadge } from './layout/status-badge';
import { Markdown } from './markdown';
import { Button } from './ui/button';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';

/** 一次最多画多少块；更早的点「显示更早的」再放出这么多。 */
export const TRANSCRIPT_WINDOW = 200;
/** 提示词默认只露开头两行；超过这个行数或字数才给「看全文」。 */
const PROMPT_LINES = 2;
const PROMPT_CHARS = 120;
/** 离底部不到这么多像素算「贴底」。 */
const NEAR_BOTTOM_PX = 48;
/** CSS 自定义高亮的名字（app.css 里配了颜色）：全部命中、当前这一个。 */
const FIND_ALL = 'transcript-find';
const FIND_NOW = 'transcript-find-now';

function Prompt({ entry, full }: { entry: TranscriptEntry; full: boolean }) {
  const [open, setOpen] = useState(false);
  const long = entry.text.split('\n').length > PROMPT_LINES || entry.text.length > PROMPT_CHARS;
  const shown = open || full;
  return (
    <div className="rounded-lg border bg-muted px-3 py-2" data-kind="prompt">
      <div className="text-meta font-medium text-muted-foreground">提示词</div>
      <p
        className={cn(
          'mt-1 min-w-0 text-body break-words whitespace-pre-wrap',
          long && !shown && 'line-clamp-2',
        )}
      >
        {entry.text}
      </p>
      {long && !full ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="mt-1 -ml-1.5"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? '收起' : '看全文'}
        </Button>
      ) : null}
    </div>
  );
}

/** 报错、结论、截断、对不上调用的结果、提示词：单独一条。 */
function EntryView({ entry, query }: { entry: TranscriptEntry; query: string }) {
  const hit = hasHit(entry.text, query);
  switch (entry.kind) {
    case 'prompt':
      return <Prompt entry={entry} full={hit} />;
    case 'assistant':
      return <Markdown text={entry.text} data-kind="assistant" />;
    case 'error':
      return (
        <div
          role="alert"
          className="rounded-lg border border-st-fail-line bg-st-fail-soft px-3 py-2 text-body text-ink-fail"
          data-kind="error"
        >
          <span className="font-medium">报错</span>
          <p className="mt-0.5 min-w-0 break-words whitespace-pre-wrap">{entry.text}</p>
        </div>
      );
    case 'result': {
      const bad = entry.ok === false;
      return (
        <div
          className={cn(
            'rounded-lg border px-3 py-2.5 text-body',
            bad ? 'border-st-fail-line bg-st-fail-soft' : 'border-st-done-line bg-st-done-soft',
          )}
          data-kind="result"
        >
          <div className={cn('text-meta font-semibold', bad ? 'text-ink-fail' : 'text-ink-done')}>
            {bad ? '结论 · 没成' : '结论'}
          </div>
          <Markdown text={entry.text} className="mt-1 font-medium" />
        </div>
      );
    }
    case 'truncated':
      return (
        <p className="min-w-0 text-meta break-words text-muted-foreground" data-kind="truncated">
          {entry.text}
        </p>
      );
    case 'tool_result':
      // 前面没有对上的调用（窗口切在中间、调用被丢了）：单画结果
      return (
        <div
          className={cn(
            'num min-w-0 text-meta break-words whitespace-pre-wrap',
            entry.ok === false ? 'text-ink-fail' : 'text-muted-foreground',
          )}
          data-kind="tool_result"
        >
          {entry.tool ? `${entry.tool} 的结果：` : '工具结果：'}
          <Clamped text={entry.text} full={hit} className="inline" />
        </div>
      );
    default:
      return <p className="min-w-0 text-body break-words whitespace-pre-wrap">{entry.text}</p>;
  }
}

/** 一行调用或一条对不上调用的结果。 */
function ToolLine({ item, live, query }: { item: ToolItem; live: boolean; query: string }) {
  if (item.kind === 'call') {
    const hit = hasHit(item.call.text, query) || hasHit(item.result?.text ?? '', query);
    return <CallRow call={item.call} result={item.result} live={live} forceOpen={hit} />;
  }
  return <EntryView entry={item.entry} query={query} />;
}

/** 两句话之间连着的调用：一个就直接一行；多个并成一行摘要，点开每个一行。有失败的默认展开，人点过就听人的。 */
function ToolGroup({ items, live, query }: { items: ToolItem[]; live: boolean; query: string }) {
  const { text, failed } = toolsSummary(items);
  const hit = items.some((i) =>
    blockEntries({ kind: 'tools', items: [i] }).some((e) => hasHit(e.text, query)),
  );
  const [picked, setPicked] = useState<boolean | undefined>(undefined);
  if (items.length === 1) {
    return (
      <div data-tool-group="1">
        <ToolLine item={items[0] as ToolItem} live={live} query={query} />
      </div>
    );
  }
  const open = hit || (picked ?? failed > 0);
  const pending = live && items.some((i) => i.kind === 'call' && !i.result);
  return (
    <div className="min-w-0" data-tool-group={items.length}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setPicked(!open)}
        className="flex min-h-8 w-full min-w-0 items-baseline gap-1.5 rounded-md px-1 py-0.5 text-left text-body hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none max-md:min-h-10 max-md:items-center"
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 translate-y-0.5 text-muted-foreground max-md:translate-y-0',
            open && 'rotate-90',
          )}
          aria-hidden
        />
        <span className="min-w-0 truncate text-muted-foreground" data-tool-summary>
          {text}
        </span>
        {failed ? <span className="shrink-0 font-medium text-ink-fail">· {failed} 个失败</span> : null}
        {pending ? <StatusBadge tone="run" label="在跑" /> : null}
      </button>
      {open ? (
        <div className="ml-5 border-l pl-2">
          {items.map((i) => (
            <ToolLine key={headOf(i).seq} item={i} live={live} query={query} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 子代理一张卡：头写类型、它在干什么、几次调用、用时；默认收起，点开是它的调用和它回的话。 */
function SubagentView({ card, live, query }: { card: SubagentCard; live: boolean; query: string }) {
  const [picked, setPicked] = useState(false);
  const hit = blockEntries({ kind: 'subagent', card }).some((e) => hasHit(e.text, query));
  const open = hit || picked;
  const calls = card.items.filter((i) => i.kind === 'call').length;
  const failed = card.items.filter(isFailedItem).length + (card.result?.ok === false ? 1 : 0);
  const running = live && card.call !== undefined && card.result === undefined;
  const ms =
    card.call && card.result ? Math.max(0, Date.parse(card.result.at) - Date.parse(card.call.at)) : undefined;
  const head = [
    `子代理${card.type ? ` ${card.type}` : ''}`,
    card.call?.text,
    `${calls} 次调用`,
    ms !== undefined ? formatDuration(ms) : undefined,
  ].filter((p): p is string => Boolean(p));
  return (
    <div className="min-w-0 rounded-lg border" data-subagent-card>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setPicked(!open)}
        className="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-body hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <ChevronRight
          className={cn('size-3.5 shrink-0 text-muted-foreground', open && 'rotate-90')}
          aria-hidden
        />
        <Bot className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate" data-subagent-head>
          {head.join(' · ')}
        </span>
        {failed ? (
          <span className="shrink-0 text-meta font-medium text-ink-fail">{failed} 个失败</span>
        ) : null}
        {running ? <StatusBadge tone="run" label="在跑" /> : null}
      </button>
      {open ? (
        <div className="space-y-1.5 border-t px-3 py-2">
          {card.items.map((i) =>
            i.kind === 'call' ? (
              <CallRow
                key={i.call.seq}
                call={i.call}
                result={i.result}
                live={live}
                forceOpen={hasHit(i.call.text, query) || hasHit(i.result?.text ?? '', query)}
              />
            ) : i.entry.kind === 'assistant' ? (
              <Markdown key={i.entry.seq} text={i.entry.text} className="text-muted-foreground" />
            ) : (
              <EntryView key={i.entry.seq} entry={i.entry} query={query} />
            ),
          )}
          {card.result ? (
            <div className="rounded-md bg-muted px-2.5 py-1.5" data-subagent-reply>
              <div className="text-meta font-medium text-muted-foreground">它回的话</div>
              <Clamped
                text={card.result.text || '（没有回话）'}
                full={hasHit(card.result.text, query)}
                className="mt-0.5 min-w-0 text-body break-words whitespace-pre-wrap"
              />
            </div>
          ) : !card.items.length ? (
            <p className="text-meta text-muted-foreground">{running ? '还没有动静' : '没记下它做了什么'}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 步骤开头的分隔线：序号、标题、起始时刻、用时；在跑的蓝字，有失败的红字。标题取自 Agent 那句话的，那句话紧跟在下面，
 * 分隔线只写「第 N 步」不重复；先调工具的步骤才写「动词 对象」。
 */
function StepDivider({ step }: { step: ProcessStep }) {
  const title = step.titleFromCall ? (step.title ?? UNTITLED_STEP) : `第 ${step.index + 1} 步`;
  const tail = [
    formatClockSeconds(step.startedAt),
    step.durationMs !== undefined ? formatDuration(step.durationMs) : step.running ? '在跑' : undefined,
  ].filter(Boolean);
  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-2 pt-2 text-meta',
        step.running ? 'text-ink-run' : step.failed ? 'text-ink-fail' : 'text-muted-foreground',
      )}
      data-step-divider={step.index}
    >
      <span className="num inline-flex size-5 shrink-0 items-center justify-center rounded-full border">
        {step.index + 1}
      </span>
      <span className="min-w-0 truncate font-medium">{title}</span>
      <span className="num shrink-0">· {tail.join(' · ')}</span>
      <span className="h-px min-w-4 flex-1 bg-border" aria-hidden />
    </div>
  );
}

function BlockView({ block, live, query }: { block: Block; live: boolean; query: string }) {
  switch (block.kind) {
    case 'divider':
      return <StepDivider step={block.step} />;
    case 'say':
      return <Markdown text={block.entry.text} data-kind="assistant" />;
    case 'tools':
      return <ToolGroup items={block.items} live={live} query={query} />;
    case 'subagent':
      return <SubagentView card={block.card} live={live} query={query} />;
    default:
      return <EntryView entry={block.entry} query={query} />;
  }
}

const EMPTY_FILTERED: Record<Exclude<TranscriptFilter, 'all'>, string> = {
  errors: '这一笔没有出错的条目。',
  text: '这一笔没有文字条目。',
};

/** 只看出错 / 只看文字：一条一行，不分段不并组（要的就是挑出来看）。 */
function FlatItem({ item, live, query }: { item: Item; live: boolean; query: string }) {
  if (item.kind === 'call') {
    return (
      <CallRow
        call={item.call}
        result={item.result}
        live={live}
        forceOpen={hasHit(item.call.text, query) || hasHit(item.result?.text ?? '', query)}
      />
    );
  }
  return <EntryView entry={item.entry} query={query} />;
}

/** 只留最近 n 块（分隔线不算数，留下的第一块前面那条分隔线一起留）。 */
function windowBlocks(blocks: readonly Block[], n: number): { shown: Block[]; hidden: number } {
  const content = blocks.filter((b) => b.kind !== 'divider').length;
  const hidden = Math.max(0, content - n);
  if (!hidden) return { shown: [...blocks], hidden: 0 };
  let seen = 0;
  let at = 0;
  for (; at < blocks.length; at++) {
    if ((blocks[at] as Block).kind === 'divider') continue;
    if (seen === hidden) break;
    seen++;
  }
  if (at > 0 && blocks[at - 1]?.kind === 'divider') at--;
  return { shown: blocks.slice(at), hidden };
}

/** 条目列表：「全部」分段、并组、收卡；两个过滤一条一行。只画最近 visible 块，更早的收在「显示更早的」后面。 */
export function TranscriptEntries({
  entries,
  steps = [],
  filter = 'all',
  live = false,
  query = '',
}: {
  entries: readonly TranscriptEntry[];
  steps?: readonly ProcessStep[];
  filter?: TranscriptFilter;
  live?: boolean;
  query?: string;
}) {
  const [visible, setVisible] = useState(TRANSCRIPT_WINDOW);
  const rows: ReactNode[] = [];
  let hidden = 0;
  if (filter === 'all') {
    const w = windowBlocks(buildBlocksMemo(entries, steps), visible);
    hidden = w.hidden;
    for (const b of w.shown) {
      const key = b.kind === 'divider' ? `step-${b.step.index}` : `${b.kind}-${blockSeq(b)}`;
      rows.push(
        <li
          key={key}
          className="min-w-0"
          data-block={b.kind}
          data-seq={b.kind === 'divider' ? undefined : blockSeq(b)}
        >
          <BlockView block={b} live={live} query={query} />
        </li>,
      );
    }
  } else {
    const all = filterItems(groupEntries(entries), filter);
    hidden = Math.max(0, all.length - visible);
    for (const item of hidden ? all.slice(hidden) : all) {
      const seq = headOf(item).seq;
      rows.push(
        <li key={seq} className="min-w-0" data-seq={seq}>
          <FlatItem item={item} live={live} query={query} />
        </li>,
      );
    }
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
        <p className="text-body text-muted-foreground" data-filter-empty>
          {EMPTY_FILTERED[filter]}
        </p>
      ) : null}
    </div>
  );
}

// 分块按条目数组记一份：同一批条目（推送没带新的）不重算
const blockCache = new WeakMap<
  readonly TranscriptEntry[],
  { steps: readonly ProcessStep[]; blocks: Block[] }
>();
function buildBlocksMemo(entries: readonly TranscriptEntry[], steps: readonly ProcessStep[]): Block[] {
  const hit = blockCache.get(entries);
  if (hit && hit.steps === steps) return hit.blocks;
  const blocks = buildBlocks(entries, steps);
  blockCache.set(entries, { steps, blocks });
  return blocks;
}

/** 「没读成：」开头的不重复写一遍。 */
function reasonOf(error: unknown): string {
  return errMessage(error).replace(/^没读成[：:]\s*/, '');
}

interface CssHighlights {
  set(name: string, h: unknown): void;
  delete(name: string): void;
}

/** 浏览器支持自定义高亮（CSS.highlights）时用它标出命中；不支持的照样数命中、滚到当前这一个，只是不上色。 */
function highlightsApi(): { reg: CssHighlights; make: (ranges: Range[]) => unknown } | undefined {
  const reg = (globalThis.CSS as unknown as { highlights?: CssHighlights } | undefined)?.highlights;
  const Ctor = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (!reg || !Ctor) return undefined;
  return { reg, make: (ranges) => new Ctor(...ranges) };
}

/** 在 root 里找 query（不分大小写）：数命中、标高亮、把第 current 个滚到中间。返回命中数。 */
function useFind(
  root: React.RefObject<HTMLElement | null>,
  query: string,
  current: number,
  renderKey: unknown,
): number {
  const [count, setCount] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: renderKey 变了（新条目、换过滤、展开）就重找一遍
  useLayoutEffect(() => {
    const api = highlightsApi();
    const q = query.trim().toLowerCase();
    const el = root.current;
    if (!el || !q) {
      api?.reg.delete(FIND_ALL);
      api?.reg.delete(FIND_NOW);
      setCount(0);
      return;
    }
    const hits: { node: Text; at: number }[] = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = (n.nodeValue ?? '').toLowerCase();
      for (let i = text.indexOf(q); i !== -1; i = text.indexOf(q, i + q.length))
        hits.push({ node: n as Text, at: i });
    }
    setCount(hits.length);
    const now = hits.length ? hits[((current % hits.length) + hits.length) % hits.length] : undefined;
    now?.node.parentElement?.scrollIntoView?.({ block: 'center' });
    if (!api) return;
    const range = (h: { node: Text; at: number }) => {
      const r = document.createRange();
      r.setStart(h.node, h.at);
      r.setEnd(h.node, h.at + q.length);
      return r;
    };
    api.reg.set(FIND_ALL, api.make(hits.map(range)));
    if (now) api.reg.set(FIND_NOW, api.make([range(now)]));
    else api.reg.delete(FIND_NOW);
  }, [query, current, renderKey]);
  useEffect(
    () => () => {
      const api = highlightsApi();
      api?.reg.delete(FIND_ALL);
      api?.reg.delete(FIND_NOW);
    },
    [],
  );
  return count;
}

/** 过滤和找：「全部 / 只看出错 N / 只看文字」，加「在会话里找」（回车下一个，Shift+回车上一个，Esc 清空）。 */
function FilterBar({
  filter,
  onChange,
  failedCount,
  query,
  onQuery,
  hits,
  current,
  onStep,
}: {
  filter: TranscriptFilter;
  onChange: (f: TranscriptFilter) => void;
  failedCount: number;
  query: string;
  onQuery: (q: string) => void;
  hits: number;
  current: number;
  onStep: (delta: 1 | -1) => void;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2" data-transcript-filters>
      <ToggleGroup
        type="single"
        size="sm"
        variant="outline"
        value={filter}
        onValueChange={(v) => onChange((v || 'all') as TranscriptFilter)}
        aria-label="看哪些条目"
      >
        <ToggleGroupItem value="all">全部</ToggleGroupItem>
        <ToggleGroupItem value="errors">只看出错{failedCount ? ` ${failedCount}` : ''}</ToggleGroupItem>
        <ToggleGroupItem value="text">只看文字</ToggleGroupItem>
      </ToggleGroup>
      {/* 手机上自己占一行，别和分段钮挤在一起把提示字切掉 */}
      <div className="flex min-w-0 basis-full items-center sm:ml-auto sm:max-w-xs sm:flex-1 sm:basis-auto">
        <SearchInput
          value={query}
          onChange={onQuery}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onStep(e.shiftKey ? -1 : 1);
            } else if (e.key === 'Escape' && query) {
              e.preventDefault();
              e.stopPropagation();
              onQuery('');
            }
          }}
          placeholder="在会话里找"
          aria-label="在会话里找"
          className="min-w-0 flex-1"
        />
        {query.trim() ? (
          <span
            className="num ml-2 shrink-0 text-meta text-muted-foreground"
            aria-live="polite"
            data-find-count
          >
            {hits ? `${(((current % hits) + hits) % hits) + 1} / ${hits}` : '没找到'}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function TranscriptBody({ taskId, run }: { taskId: string; run: SegmentRunView }) {
  const q = useRunTranscript(taskId, run.id, true);
  const data = q.data;
  const [filter, setFilter] = useState<TranscriptFilter>('all');
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // 在跑的默认贴底跟随；人往上滚就记成不跟随，滚回底部再接上
  const follow = useRef(run.running);
  const [away, setAway] = useState(false);
  const entries = data?.entries;
  const count = entries?.length ?? 0;
  const live = Boolean(data && !data.done && !q.isError && !data.noRecord);
  // 分段和过程同一套切法；条目没变就不重切
  const steps = useMemo(
    () =>
      entries?.length
        ? cutSteps(entries.map(processRowOf), { running: live, endedAt: run.endedAt }).steps
        : [],
    [entries, live, run.endedAt],
  );
  const hits = useFind(list, query, current, `${count}|${filter}|${steps.length}`);

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
    if (follow.current && !query.trim()) el.scrollTop = el.scrollHeight;
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

  const failedCount = entries ? groupEntries(entries).filter(isFailedItem).length : 0;
  return (
    <>
      <FilterBar
        filter={filter}
        onChange={setFilter}
        failedCount={failedCount}
        query={query}
        onQuery={(v) => {
          setQuery(v);
          setCurrent(0);
        }}
        hits={hits}
        current={current}
        onStep={(d) => setCurrent((c) => c + d)}
      />
      <div
        ref={scroller}
        onScroll={measure}
        className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain px-4 py-3"
        data-transcript-body
      >
        {q.isPending && !data ? (
          <p className="flex items-center gap-1.5 text-body text-muted-foreground" role="status">
            <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
            正在读会话内容…
          </p>
        ) : null}
        {q.isError ? (
          <Notice
            tone="fail"
            action={
              <Button type="button" size="xs" variant="outline" onClick={() => void q.refetch()}>
                重试
              </Button>
            }
          >
            <span className="break-words">没读成：{reasonOf(q.error)}</span>
          </Notice>
        ) : null}
        {data?.noRecord ? (
          <p className="text-body text-muted-foreground" data-no-record>
            这一段跑在记录会话内容之前，没有记录
          </p>
        ) : null}
        {data && !data.noRecord && !data.entries.length && !q.isError ? (
          <p className="text-body text-muted-foreground">还没有内容，会话刚起来。</p>
        ) : null}
        <div ref={list}>
          {entries?.length ? (
            <TranscriptEntries entries={entries} steps={steps} filter={filter} live={live} query={query} />
          ) : null}
        </div>
      </div>
      {live ? (
        <div
          className="flex shrink-0 items-center gap-2 border-t px-4 py-1.5 text-meta text-ink-run"
          data-live
        >
          <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-st-run" aria-hidden />
          <span className="min-w-0 truncate">
            还在跑 · 每 3 秒读一次
            {q.dataUpdatedAt ? (
              <span className="num text-muted-foreground">
                {' '}
                · 上次 {formatClockSeconds(new Date(q.dataUpdatedAt).toISOString())}
              </span>
            ) : null}
          </span>
          {away ? (
            <Button type="button" size="xs" className="ml-auto shrink-0" onClick={jump}>
              跳到最新
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** 这一笔的结局：在跑、过没过、没读到。会话头和弹出窗口左边的列表共用。 */
export function RunOutcomeBadge({ run }: { run: SegmentRunView }) {
  if (run.running) return <StatusBadge tone="run" label="在跑" />;
  if (run.outcome)
    return <StatusBadge tone={segmentOutcomeTone[run.outcome]} label={segmentOutcomeLabel[run.outcome]} />;
  return <StatusBadge tone="stall" label="结局没读到" />;
}

/** 「第 N 笔 · 段」：N 是整张单按起跑先后的序号（runOrder），和过程、汇报、进度条同一个数（#3277）。 */
export function runTitle(run: SegmentRunView, nth: number): string {
  return `第 ${nth} 笔 · ${run.segment ? segmentLabel[run.segment] : UNKNOWN_SEGMENT}`;
}

/**
 * 会话头下面一行（#3277）：为什么起、新会话还是接上一笔的、模型、起始时刻、用时、花费。没读到的写明没读到，不写 0；
 * 起因、会话接续只有动手段记，别的段不写这两项。
 */
export function RunMeta({ run, now }: { run: SegmentRunView; now: number }) {
  const live = liveMs(run, now);
  const duration =
    run.durationMs !== undefined
      ? formatDuration(run.durationMs)
      : live !== undefined
        ? formatDuration(live)
        : '耗时没读到';
  const parts = [
    causeLabel(run)?.text,
    sessionLink(run),
    run.modelName,
    run.startedAt ? `${formatClock(run.startedAt)} 起` : '起始时刻没读到',
    duration,
    run.costUsd !== undefined ? formatUsd(run.costUsd) : '花费没读到',
  ].filter((p): p is string => p !== undefined && p !== '');
  return (
    <p className="num min-w-0 break-words text-meta text-muted-foreground" data-run-meta>
      {parts.join(' · ')}
    </p>
  );
}

/**
 * 一笔的会话内容（#3277）：任务页右侧抽屉和弹出窗口共用。读、分段、过滤、找、在跑的贴底跟随都在这里；外面只管放在哪、多宽，
 * 放它的容器要是竖排的 flex 并给定高度（它自己 flex-1 撑满、里面滚）。
 */
export function RunTranscript({ taskId, run }: { taskId: string; run: SegmentRunView }) {
  return <TranscriptBody key={run.id} taskId={taskId} run={run} />;
}
