import { ArrowDown, ChevronDown, ChevronRight, LoaderCircle, RefreshCw, WifiOff, Wrench } from 'lucide-react';
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../lib/cn';
import { CATEGORY_LABEL, type Category, categoryOf, taskIdOf } from '../lib/describe';
import { dayKey, formatDay } from '../lib/format';
import { useSessionFeed, useTranscriptFeed } from '../lib/hooks';
import {
  buildSteps,
  buildTimeline,
  runIdOfSession,
  type TimelineItem,
  workerSessionOf,
} from '../lib/transcript';
import type { FeedEvent, FeedState } from '../lib/types';
import { Chip } from './chip';
import { EventCard } from './event-card';
import { LoginPrompt } from './login-prompt';
import { DroppedRow, EndRow, SayRow, ToolRow, ToolRunRow } from './transcript-steps';

const CATS: Category[] = ['turn', 'dispatch', 'worker', 'process', 'handback', 'other'];

/** 一项的第一个时间（日期分隔线用）。 */
function itemStart(item: TimelineItem): string | undefined {
  switch (item.kind) {
    case 'event':
      return item.ev.createdAt;
    case 'mcp':
      return item.events[0]?.createdAt;
    case 'toolrun':
      return item.steps[0]?.at;
    default:
      return item.step.at;
  }
}

/** 连接状态条：正常时一个小点，断了说清楚「断了、已显示的还在、几秒后第几次重试」。 */
export function StatusPill({ state }: { state: FeedState }) {
  if (state.status === 'live') {
    return (
      <span className="inline-flex items-center gap-1.5 text-2xs text-ink-2">
        <span className="size-1.5 animate-pulse-dot rounded-full bg-brand" />
        实时
      </span>
    );
  }
  if (state.status === 'loading') {
    return (
      <span className="inline-flex items-center gap-1.5 text-2xs text-muted">
        <LoaderCircle className="size-3 animate-spin" />
        加载中
      </span>
    );
  }
  if (state.status === 'reconnecting') {
    return (
      <Chip tone="warning" className="gap-1">
        <WifiOff className="size-3" />
        已断开 · 重连中
      </Chip>
    );
  }
  return <Chip tone="danger">无法查看</Chip>;
}

function ReconnectBanner({ state }: { state: FeedState }) {
  if (state.status === 'failed') {
    if (state.errorStatus === 401) return <LoginPrompt className="border-b border-line bg-danger-soft" />;
    return (
      <div role="alert" className="border-b border-line bg-danger-soft px-4 py-2 text-xs text-danger md:px-6">
        {state.error ?? '读不到这个会话。'}
      </div>
    );
  }
  if (state.status !== 'reconnecting') return null;
  const secs = state.retryInMs !== null ? Math.max(1, Math.round(state.retryInMs / 1000)) : null;
  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-line bg-warning-soft px-4 py-2 text-xs text-warning md:px-6"
    >
      <WifiOff className="size-3.5 shrink-0" />
      <span>
        和服务器的连接断了，已显示的内容不会丢；{secs ? `约 ${secs} 秒后` : '马上'}第 {state.attempt}{' '}
        次重连，连上后自动补齐漏掉的事件。
      </span>
    </div>
  );
}

export function SessionStream({ sessionId }: { sessionId: string }) {
  const { feed, state } = useSessionFeed(sessionId);
  // 工人会话（worker-<runId>）：把这次运行 stream-json 的每一步（transcript:<runId> 流）和会话里的进度、交结果按事件号串在一起
  const runId = runIdOfSession(sessionId);
  const { feed: tFeed, state: tState } = useTranscriptFeed(runId);
  const [off, setOff] = useState<Set<Category>>(new Set());
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [unseen, setUnseen] = useState(0);
  const lastCount = useRef(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const total = state.events.length + tState.events.length;

  const counts = useMemo(() => {
    const c: Record<Category, number> = {
      turn: 0,
      dispatch: 0,
      worker: 0,
      process: 0,
      handback: 0,
      other: 0,
    };
    for (const e of state.events) c[categoryOf(e.type)]++;
    for (const e of tState.events) c[categoryOf(e.type)]++;
    return c;
  }, [state.events, tState.events]);

  const shown = useMemo(() => state.events.filter((e) => !off.has(categoryOf(e.type))), [state.events, off]);
  const steps = useMemo(() => buildSteps(tState.events), [tState.events]);
  const shownSteps = useMemo(() => (off.has('process') ? [] : steps), [steps, off]);

  const items = useMemo(() => buildTimeline(shown, shownSteps), [shown, shownSteps]);
  const [openRuns, setOpenRuns] = useState<ReadonlySet<number>>(new Set());
  const toggleRun = (key: number) =>
    setOpenRuns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const scrollToEnd = useCallback((smooth = false) => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  // 换会话：回到「贴底」状态
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在会话号变时重置
  useEffect(() => {
    stick.current = true;
    lastCount.current = 0;
    setUnseen(0);
    setOff(new Set());
    setOpenRuns(new Set());
  }, [sessionId]);

  // 新事件来了：贴底就跟到底，不贴底只提示条数，不抢用户正在看的位置
  useLayoutEffect(() => {
    const added = total - lastCount.current;
    lastCount.current = total;
    if (added <= 0) return;
    if (stick.current) scrollToEnd();
    else if (lastCount.current > 0) setUnseen((u) => u + added);
  }, [total, scrollToEnd]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    stick.current = atEnd;
    if (atEnd) setUnseen(0);
  };

  const older = async () => {
    const el = scroller.current;
    const before = el?.scrollHeight ?? 0;
    setLoadingOlder(true);
    stick.current = false;
    try {
      await Promise.all([feed.loadOlder(), tFeed?.loadOlder()]);
    } finally {
      setLoadingOlder(false);
      requestAnimationFrame(() => {
        if (el) el.scrollTop += el.scrollHeight - before;
      });
    }
  };

  const toggle = (c: Category) =>
    setOff((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });

  let lastDay = '';
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="session-stream"
      data-feed-status={state.status}
      data-resyncs={state.resyncs}
      data-attempt={state.attempt}
    >
      <ReconnectBanner state={state} />
      <div className="scrollbar-none flex shrink-0 items-center gap-2 overflow-x-auto border-b border-line bg-surface px-4 py-2 md:px-6">
        <span className="shrink-0 pr-1">
          <StatusPill state={state} />
        </span>
        {CATS.filter((c) => counts[c] > 0).map((c) => {
          const on = !off.has(c);
          return (
            <button
              key={c}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(c)}
              className={cn(
                'inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-2xs transition-colors',
                on
                  ? 'border-brand/30 bg-brand-soft text-brand-strong'
                  : 'border-line bg-surface text-muted hover:text-ink',
              )}
            >
              {CATEGORY_LABEL[c]}
              <span className="num">{counts[c]}</span>
            </button>
          );
        })}
        <span className="num ml-auto shrink-0 pl-2 text-2xs text-muted">共 {total} 条</span>
      </div>
      <div className="relative min-h-0 flex-1">
        <div
          ref={scroller}
          onScroll={onScroll}
          className="h-full overflow-y-auto px-4 py-4 md:px-6"
          data-testid="stream"
        >
          {state.hasOlder || tState.hasOlder ? (
            <div className="mb-3 flex justify-center">
              <button
                type="button"
                onClick={() => void older()}
                disabled={loadingOlder}
                className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-line bg-surface px-3 text-xs text-ink-2 hover:text-ink disabled:opacity-60"
              >
                {loadingOlder ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
                加载更早的事件
              </button>
            </div>
          ) : null}
          {state.status === 'loading' && total === 0 ? (
            <p className="py-10 text-center text-sm text-muted">正在加载这个会话的事件…</p>
          ) : total === 0 && state.status !== 'failed' ? (
            <div className="py-12 text-center">
              <p className="text-sm font-medium text-ink-2">这个会话还没有事件</p>
              <p className="mt-1 text-2xs text-muted">有新事件时会直接出现在这里，不用刷新。</p>
            </div>
          ) : items.length === 0 && total > 0 ? (
            <p className="py-10 text-center text-sm text-muted">筛选把事件全藏起来了，点上面的类别条恢复。</p>
          ) : (
            <ol className="mx-auto max-w-3xl" data-testid="events">
              {items.map((item) => {
                const startedAt = itemStart(item);
                if (!startedAt) return null;
                const day = dayKey(startedAt);
                const showDay = day !== lastDay;
                lastDay = day;
                const dayRow = showDay ? (
                  <li className="mb-3 flex items-center gap-3 text-2xs text-muted" aria-hidden>
                    <span className="h-px flex-1 bg-line" />
                    {formatDay(startedAt)}
                    <span className="h-px flex-1 bg-line" />
                  </li>
                ) : null;
                if (item.kind === 'event') {
                  return (
                    <Fragment key={item.ev.id}>
                      {dayRow}
                      <EventCard
                        ev={item.ev}
                        taskLabel={taskIdOf(item.ev)}
                        workerSession={workerSessionOf(item.ev)}
                      />
                    </Fragment>
                  );
                }
                if (
                  item.kind === 'say' ||
                  item.kind === 'tool' ||
                  item.kind === 'end' ||
                  item.kind === 'dropped'
                ) {
                  const st = item.step;
                  return (
                    <Fragment key={`step-${st.id}`}>
                      {dayRow}
                      {item.kind === 'say' ? (
                        <SayRow step={item.step} />
                      ) : item.kind === 'tool' ? (
                        <ToolRow step={item.step} />
                      ) : item.kind === 'end' ? (
                        <EndRow step={item.step} />
                      ) : (
                        <DroppedRow step={item.step} />
                      )}
                    </Fragment>
                  );
                }
                const open = openRuns.has(item.key);
                if (item.kind === 'toolrun') {
                  return (
                    <Fragment key={`steprun-${item.key}`}>
                      {dayRow}
                      <ToolRunRow
                        steps={item.steps}
                        summary={item.summary}
                        failed={item.failed}
                        open={open}
                        onToggle={() => toggleRun(item.key)}
                      />
                    </Fragment>
                  );
                }
                const first: FeedEvent | undefined = item.events[0];
                if (!first) return null;
                return (
                  <Fragment key={`run-${item.key}`}>
                    {dayRow}
                    <li data-tool-run={item.key} data-open={open} className="pb-3">
                      <button
                        type="button"
                        aria-expanded={open}
                        onClick={() => toggleRun(item.key)}
                        className="flex min-h-9 w-full cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-left text-xs text-ink-2 hover:bg-subtle"
                      >
                        {open ? (
                          <ChevronDown className="size-3.5 shrink-0" />
                        ) : (
                          <ChevronRight className="size-3.5 shrink-0" />
                        )}
                        <Wrench className="size-3.5 shrink-0 text-muted" />
                        <span className="min-w-0 flex-1 break-words">{item.summary}</span>
                        <span className="num shrink-0 text-2xs text-muted">
                          #{first.id}–{item.events.at(-1)?.id}
                        </span>
                      </button>
                      {/* 收起时卡片仍在页面里（hidden），事件号对账和展开都不用重新取 */}
                      <ol hidden={!open} className="mt-3">
                        {item.events.map((ev) => (
                          <EventCard key={ev.id} ev={ev} taskLabel={taskIdOf(ev)} />
                        ))}
                      </ol>
                    </li>
                  </Fragment>
                );
              })}
            </ol>
          )}
        </div>
        {unseen > 0 ? (
          <button
            type="button"
            onClick={() => {
              stick.current = true;
              setUnseen(0);
              scrollToEnd(true);
            }}
            className="absolute bottom-4 left-1/2 inline-flex h-8 -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-full bg-brand px-3.5 text-xs text-white shadow-md hover:bg-brand-hover"
          >
            <ArrowDown className="size-3.5" />
            {unseen} 条新事件
          </button>
        ) : null}
      </div>
    </div>
  );
}
