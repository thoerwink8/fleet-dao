// 一笔的会话内容（#1640、#1802、#3277、#3533 照 Arco 重排）：放在任务页右侧抽屉和弹出窗口里，像对话不像日志。只拼 components/layout 的件。
// - 按过程同一套步骤分段（shared 的 cutSteps）：每一步开头一条分隔线「序号 标题 · 起始时刻 · 用时」，在跑的蓝字。
// - 助手的话按 Markdown 排（layout/markdown.tsx）；提示词收成两行的卡，「看全文」展开。
// - 两句话之间连着的调用并成一行「已运行 2 个命令，已读取 2 个文件 · 1 个失败」，点开每个调用一行（components/call-row.tsx，
//   和过程同一份）；有失败的组自动展开，失败的调用自动展开输出。子代理收成一张能收起的卡。
// - 「全部 / 只看出错 N / 只看文字」加「在会话里找」（命中高亮，回车下一个，命中的组和卡自动展开）。
// - 在跑的每 3 秒往后追加、贴底跟随；人往上滚就停，底栏一直写「还在跑 · 每 3 秒读一次 · 上次 时:分:秒」，离开底部时带「跳到最新」。
// - 结束的最后一张结论卡，没成的标「没成」。条目多时只画最近 200 块（不加虚拟滚动依赖），更早的点「显示更早的」。
// - 读：从没读成画红条加重试；读成过、这次刷新没成，照旧画上一次的条目，顶上写「刷新没成，下面是 N 分钟前的」（lib/query-view.ts）。
import { cutSteps, type ProcessStep, processRowOf } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRunTranscript } from '../api/client';
import type { TranscriptEntry } from '../api/types';
import { formatClock, formatClockSeconds, formatDuration, formatUsd, TIME } from '../lib/format';
import { viewOf } from '../lib/query-view';
import { liveMs, type SegmentRunView, segmentLabel, UNKNOWN_SEGMENT } from '../lib/segments';
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
import { toStatus } from '../theme/status-dict';
import { CallRow, Clamped } from './call-row';
import { Button } from './layout/button';
import { Message, ROLE } from './layout/chat';
import { EmptyState } from './layout/empty-state';
import { FilterTabs } from './layout/filter-tabs';
import { LoadError, LoadingRows, LoadStale } from './layout/load-state';
import { Markdown } from './layout/markdown';
import { MetaLine } from './layout/meta-line';
import { Nest } from './layout/nest';
import { Notice } from './layout/notice';
import { SearchInput } from './layout/search-input';
import { Stack } from './layout/stack';
import { StatusBadge } from './layout/status-badge';
import { Tag } from './layout/tag';
import { Text } from './layout/text';
import {
  ClampedText,
  OutputBox,
  StepDivider,
  SubagentFrame,
  ToolToggle,
  TranscriptFooter,
  TranscriptItem,
  TranscriptList,
  TranscriptPane,
} from './layout/transcript';

/** 一次最多画多少块；更早的点「显示更早的」再放出这么多。 */
export const TRANSCRIPT_WINDOW = 200;
/** 提示词默认只露开头两行；超过这个行数或字数才给「看全文」。 */
const PROMPT_LINES = 2;
const PROMPT_CHARS = 120;
/** 离底部不到这么多像素算「贴底」。 */
const NEAR_BOTTOM_PX = 48;
/** 会话读不成功、停在旧内容上超过这么久，标「数据已过期」。 */
const TRANSCRIPT_STALE_AFTER_MS = 5 * TIME.MIN;
/** CSS 自定义高亮的名字（app.css 里配了颜色）：全部命中、当前这一个。 */
const FIND_ALL = 'transcript-find';
const FIND_NOW = 'transcript-find-now';

function Prompt({ entry, full }: { entry: TranscriptEntry; full: boolean }) {
  const [open, setOpen] = useState(false);
  const long = entry.text.split('\n').length > PROMPT_LINES || entry.text.length > PROMPT_CHARS;
  const shown = open || full;
  return (
    <Message role={ROLE.me} kind="prompt" meta="提示词">
      <ClampedText variant="body" {...(long && !shown ? { lines: 2 as const } : {})}>
        {entry.text}
      </ClampedText>
      {long && !full ? (
        <Button size="xs" variant="text" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? '收起' : '看全文'}
        </Button>
      ) : null}
    </Message>
  );
}

/** 报错、结论、截断、对不上调用的结果、提示词：单独一条。 */
function EntryView({ entry, query }: { entry: TranscriptEntry; query: string }) {
  const hit = hasHit(entry.text, query);
  switch (entry.kind) {
    case 'prompt':
      return <Prompt entry={entry} full={hit} />;
    case 'assistant':
      return (
        <Message role={ROLE.other}>
          <Markdown text={entry.text} data-kind="assistant" />
        </Message>
      );
    case 'error':
      return (
        <div data-kind="error">
          <Notice tone="fail">
            <ClampedText variant="body">
              <Text strong>报错</Text>　{entry.text}
            </ClampedText>
          </Notice>
        </div>
      );
    case 'result': {
      const bad = entry.ok === false;
      return (
        <Message
          role={ROLE.other}
          kind="result"
          meta={
            <>
              结论
              {bad ? (
                <>
                  {' '}
                  <Tag tone="error">没成</Tag>
                </>
              ) : null}
            </>
          }
        >
          <Markdown text={entry.text} strong />
        </Message>
      );
    }
    case 'truncated':
      return (
        <div data-kind="truncated">
          <Text as="p" size="meta" tone="muted">
            {entry.text}
          </Text>
        </div>
      );
    case 'tool_result':
      // 前面没有对上的调用（窗口切在中间、调用被丢了）：单画结果
      return (
        <div data-kind="tool_result">
          <Text size="meta" tone={entry.ok === false ? 'danger' : 'muted'}>
            {entry.tool ? `${entry.tool} 的结果：` : '工具结果：'}
          </Text>
          <Clamped text={entry.text} full={hit} />
        </div>
      );
    default:
      return <ClampedText variant="body">{entry.text}</ClampedText>;
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
    <ToolToggle
      data-tool-group={items.length}
      open={open}
      onToggle={() => setPicked(!open)}
      label={text}
      quiet
      trailing={
        <>
          {failed ? <Tag tone="error">{failed} 个失败</Tag> : null}
          {pending ? <StatusBadge status="tone:run" /> : null}
        </>
      }
    >
      <Nest>
        {items.map((i) => (
          <ToolLine key={headOf(i).seq} item={i} live={live} query={query} />
        ))}
      </Nest>
    </ToolToggle>
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
    <SubagentFrame
      data-subagent-card
      open={open}
      onToggle={() => setPicked(!open)}
      head={head.join(' · ')}
      trailing={
        <>
          {failed ? <Tag tone="error">{failed} 个失败</Tag> : null}
          {running ? <StatusBadge status="tone:run" /> : null}
        </>
      }
    >
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
          <Markdown key={i.entry.seq} text={i.entry.text} tone="secondary" />
        ) : (
          <EntryView key={i.entry.seq} entry={i.entry} query={query} />
        ),
      )}
      {card.result ? (
        <OutputBox data-subagent-reply label="它回的话" indent={false}>
          <Clamped
            text={card.result.text || '（没有回话）'}
            full={hasHit(card.result.text, query)}
            variant="body"
          />
        </OutputBox>
      ) : !card.items.length ? (
        <Text size="meta" tone="muted" as="p">
          {running ? '还没有动静' : '没记下它做了什么'}
        </Text>
      ) : null}
    </SubagentFrame>
  );
}

/**
 * 步骤开头的分隔线：序号、标题、起始时刻、用时；在跑的蓝字，有失败的红字加「有失败」。标题取自 Agent 那句话的，那句话紧跟在下面，
 * 分隔线只写「第 N 步」不重复；先调工具的步骤才写「动词 对象」。
 */
function StepMark({ step }: { step: ProcessStep }) {
  const title = step.titleFromCall ? (step.title ?? UNTITLED_STEP) : `第 ${step.index + 1} 步`;
  const tail = [
    formatClockSeconds(step.startedAt),
    step.durationMs !== undefined ? formatDuration(step.durationMs) : step.running ? '在跑' : undefined,
  ].filter(Boolean);
  return (
    <StepDivider
      index={step.index}
      title={title}
      tail={tail.join(' · ')}
      tone={step.running ? 'processing' : step.failed ? 'error' : 'default'}
      flag={step.failed ? <Tag tone="error">有失败</Tag> : undefined}
    />
  );
}

function BlockView({ block, live, query }: { block: Block; live: boolean; query: string }) {
  switch (block.kind) {
    case 'divider':
      return <StepMark step={block.step} />;
    case 'say':
      return (
        <Message role={ROLE.other}>
          <Markdown text={block.entry.text} data-kind="assistant" />
        </Message>
      );
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
        <TranscriptItem key={key} block={b.kind} seq={b.kind === 'divider' ? undefined : blockSeq(b)}>
          <BlockView block={b} live={live} query={query} />
        </TranscriptItem>,
      );
    }
  } else {
    const all = filterItems(groupEntries(entries), filter);
    hidden = Math.max(0, all.length - visible);
    for (const item of hidden ? all.slice(hidden) : all) {
      const seq = headOf(item).seq;
      rows.push(
        <TranscriptItem key={seq} seq={seq}>
          <FlatItem item={item} live={live} query={query} />
        </TranscriptItem>,
      );
    }
  }
  return (
    <Stack gap="md">
      {hidden ? (
        <div>
          <Button size="sm" variant="secondary" onClick={() => setVisible((v) => v + TRANSCRIPT_WINDOW)}>
            显示更早的（还有 {hidden} 条）
          </Button>
        </div>
      ) : null}
      {rows.length ? (
        <TranscriptList label="会话内容">{rows}</TranscriptList>
      ) : filter !== 'all' ? (
        <EmptyState size="inline" title={EMPTY_FILTERED[filter]} />
      ) : null}
    </Stack>
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

/** 过滤：「全部 / 只看出错 N / 只看文字」。 */
function FilterBar({
  filter,
  onChange,
  failedCount,
}: {
  filter: TranscriptFilter;
  onChange: (f: TranscriptFilter) => void;
  failedCount: number;
}) {
  return (
    <FilterTabs<TranscriptFilter>
      mode="toggle"
      variant="segmented"
      aria-label="看哪些条目"
      value={filter}
      onChange={onChange}
      items={[
        { id: 'all', label: '全部' },
        { id: 'errors', label: '只看出错', ...(failedCount ? { count: failedCount } : {}) },
        { id: 'text', label: '只看文字' },
      ]}
    />
  );
}

/** 在会话里找：回车下一个，Shift+回车上一个，Esc 清空；右边写第几个 / 共几个，没有写「没找到」。 */
function FindBox({
  query,
  onQuery,
  hits,
  current,
  onStep,
}: {
  query: string;
  onQuery: (q: string) => void;
  hits: number;
  current: number;
  onStep: (delta: 1 | -1) => void;
}) {
  return (
    <>
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
      />
      {query.trim() ? (
        <span aria-live="polite" data-find-count>
          <Text size="meta" tone="muted">
            {hits ? `${(((current % hits) + hits) % hits) + 1} / ${hits}` : '没找到'}
          </Text>
        </span>
      ) : null}
    </>
  );
}

function TranscriptBody({ taskId, run }: { taskId: string; run: SegmentRunView }) {
  const q = useRunTranscript(taskId, run.id, true);
  // 读成过、这次刷新没成 = stale（照旧画旧条目）；从没读成才是 error
  const view = viewOf(q);
  const data = view.status === 'data' ? view.data : undefined;
  const stale = view.status === 'data' ? view.stale : undefined;
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
    <TranscriptPane
      scrollRef={scroller}
      onScroll={measure}
      filters={<FilterBar filter={filter} onChange={setFilter} failedCount={failedCount} />}
      search={
        <FindBox
          query={query}
          onQuery={(v) => {
            setQuery(v);
            setCurrent(0);
          }}
          hits={hits}
          current={current}
          onStep={(d) => setCurrent((c) => c + d)}
        />
      }
      footer={
        live ? (
          <TranscriptFooter
            action={
              away ? (
                <Button size="xs" variant="outline" onClick={jump}>
                  跳到最新
                </Button>
              ) : undefined
            }
          >
            还在跑 · 每 3 秒读一次
            {q.dataUpdatedAt ? ` · 上次 ${formatClockSeconds(new Date(q.dataUpdatedAt).toISOString())}` : ''}
          </TranscriptFooter>
        ) : undefined
      }
    >
      {view.status === 'loading' ? <LoadingRows rows={3} /> : null}
      {view.status === 'error' ? (
        <LoadError text={`没读成：${reasonOf(view.error)}`} error={view.error} onRetry={view.retry} />
      ) : null}
      {stale ? <LoadStale stale={stale} staleAfterMs={TRANSCRIPT_STALE_AFTER_MS} /> : null}
      {data?.noRecord ? <EmptyState title="没有记录" hint="这一段跑在记录会话内容之前，没有记录" /> : null}
      {data && !data.noRecord && !data.entries.length && !stale ? (
        <Text as="p" tone="muted">
          还没有内容，会话刚起来。
        </Text>
      ) : null}
      <div ref={list}>
        {entries?.length ? (
          <TranscriptEntries entries={entries} steps={steps} filter={filter} live={live} query={query} />
        ) : null}
      </div>
    </TranscriptPane>
  );
}

/** 这一笔的结局：在跑、过没过、没读到。会话头和弹出窗口左边的列表共用。状态词全走字典。 */
export function runStatus(run: SegmentRunView) {
  if (run.running) return 'tone:run' as const;
  if (run.outcome) return toStatus('task', `segment:${run.outcome}`);
  return 'task:segment:unread' as const;
}

export function RunOutcomeBadge({ run }: { run: SegmentRunView }) {
  return <StatusBadge status={runStatus(run)} />;
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
  return <MetaLine items={parts} />;
}

/**
 * 一笔的会话内容（#3277）：任务页右侧抽屉和弹出窗口共用。读、分段、过滤、找、在跑的贴底跟随都在这里；外面只管放在哪、多宽，
 * 放它的容器要是竖排的 flex 并给定高度（它自己 flex-1 撑满、里面滚）。
 */
export function RunTranscript({ taskId, run }: { taskId: string; run: SegmentRunView }) {
  return <TranscriptBody key={run.id} taskId={taskId} run={run} />;
}
