import type { LucideIcon } from 'lucide-react';
import {
  ArrowRightLeft,
  CircleCheck,
  CircleDot,
  FilePen,
  FlaskConical,
  Hand,
  ListChecks,
  MessageCircleQuestion,
  MessageSquare,
  OctagonAlert,
  Terminal,
} from 'lucide-react';
import { type UIEvent, useEffect, useRef, useState } from 'react';
import type { Run, TimelineItem } from '../api/types';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Switch } from './ui/switch';

const ICON: Record<string, LucideIcon> = {
  say: MessageSquare,
  plan: ListChecks,
  tool: Terminal,
  file: FilePen,
  test: FlaskConical,
  ask: MessageCircleQuestion,
  answer: MessageCircleQuestion,
  done: CircleCheck,
  done_rejected: OctagonAlert,
  blocked: OctagonAlert,
  state: ArrowRightLeft,
  pause: Hand,
  resume: Hand,
  stop: Hand,
  reroute: Hand,
};

/** 技术性的几类（命令、文件、测试）用等宽字。 */
const MONO = new Set(['tool', 'file', 'test']);

function time(iso: string) {
  const d = new Date(iso);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

function tone(item: TimelineItem): string | undefined {
  if (item.kind === 'done') return 'text-ink-done';
  if (item.kind === 'blocked' || item.kind === 'done_rejected') return 'text-ink-fail';
  if (item.kind === 'ask') return 'text-ink-human';
  if (item.kind === 'test' && /没过/.test(item.text)) return 'text-ink-fail';
  if (item.source === 'person') return 'text-foreground font-medium';
  if (item.source === 'engine') return 'text-muted-foreground';
  return undefined;
}

/**
 * 实时日志：助手每一步在干什么（时间线的正文由后端拼好）。按时间正序显示，新条目自动滚到底；
 * 往上翻时暂停跟随。更早的记录按需往前翻。
 */
export function LogStream({
  items,
  runs,
  live,
  hasMore,
  onMore,
  loadingMore,
  error,
  className,
}: {
  items: TimelineItem[];
  runs: Run[];
  live: boolean;
  hasMore?: boolean;
  onMore?: () => void;
  loadingMore?: boolean;
  /** 时间线没读成：空着不能说成「还没有记录」。 */
  error?: unknown;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const ordered = [...items].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  const multi = new Set(ordered.map((e) => e.runId).filter(Boolean)).size > 1;
  const last = ordered[ordered.length - 1]?.id;

  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在来了新条目时滚动。
  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [last, follow]);

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (!atBottom && follow) setFollow(false);
  };

  return (
    <div className={cn('overflow-hidden rounded-lg border bg-background', className)}>
      <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground">
        <span
          className={cn('size-1.5 rounded-full', live ? 'fd-dot-live bg-st-run text-ink-run' : 'bg-st-wait')}
        />
        {live ? '直播中' : '没有在跑的会话'}
        <span className="num">· {ordered.length} 条</span>
        <span className="ml-auto flex items-center gap-1.5">
          <span aria-hidden>跟随最新</span>
          <Switch checked={follow} onCheckedChange={setFollow} className="scale-75" aria-label="跟随最新" />
        </span>
      </div>
      <div
        ref={box}
        onScroll={onScroll}
        className="h-72 overflow-y-auto px-3 py-2 scrollbar-thin"
        aria-live="polite"
      >
        {error ? (
          <p role="alert" className="mb-2 rounded-md bg-st-fail/10 px-2 py-1.5 text-xs text-ink-fail">
            {ordered.length ? '更早的记录' : '日志'}没读成：
            {error instanceof Error ? error.message : String(error)}
          </p>
        ) : null}
        {hasMore && onMore ? (
          <div className="mb-2 text-center">
            <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={onMore} disabled={loadingMore}>
              {loadingMore ? '正在读更早的…' : '看更早的记录'}
            </Button>
          </div>
        ) : null}
        {ordered.length ? (
          <ol className="space-y-1">
            {ordered.map((e) => {
              const Icon = ICON[e.kind] ?? CircleDot;
              const model = multi ? runs.find((r) => r.id === e.runId)?.modelName : undefined;
              return (
                <li key={e.id} className="flex items-start gap-2 text-[13px] leading-5">
                  <span className="num w-[58px] shrink-0 text-[11px] leading-5 text-faint">{time(e.at)}</span>
                  <Icon className="mt-[3px] size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  {model ? (
                    <span className="num mt-px shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                      {model}
                    </span>
                  ) : null}
                  <span className={cn('min-w-0 break-words', MONO.has(e.kind) && 'num text-[12px]', tone(e))}>
                    {e.text}
                  </span>
                </li>
              );
            })}
          </ol>
        ) : error ? null : (
          <p className="py-8 text-center text-sm text-muted-foreground">还没有过程记录</p>
        )}
      </div>
    </div>
  );
}
